// One open session (FR-SES-09..14, FR-BOX-03, FR-KEY-04/05): a state machine over at most one SDK
// process (sdk.ts SessionProcess).
//   idle        no process; the next message starts one (resumed by id)
//   starting    the last terminal check runs (cli-terminals.ts `confirm`); messages wait in the queue
//   running     the process takes messages
//   ending      the idle end closed its input; messages wait for the next process
//   yielded     a terminal's Claude Code holds it (one writer): read-only, a message waits to take it back
//   takingOver  that terminal's CLI is being ended, then your message goes
// Every message to the process goes through `input`. Messages sent while a card waits are held
// behind it (cards.ts) and go once the last card is answered, or back to the box when the turn ends.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { SessionProcess, imageError, userContent } from './sdk.ts';
import type { Content, Image, InterruptResult, MenuSource, Sdk, StartOptions } from './sdk.ts';
import { SessionStatus } from './status.ts';
import type { Running, StatusEntry, Timer } from './status.ts';
import type { Terminal } from './cli-terminals.ts';
import { takeoverNote } from './cli-terminals.ts';
import { Cards } from './cards.ts';
import type { CardAnswer } from './cards.ts';
import type { Views } from './views.ts';
import type { Store } from './store.ts';
import type { Log } from './log.ts';
import { Bang, bashInput, bashOutput } from './bang.ts';
import type { BangRun } from './bang.ts';

export const IDLE_MS = 30 * 60 * 1000;
const STREAM_MS = 50; // at most one stream preview per this many ms and session
const YIELD_INTERRUPT_MS = 3000; // a yield waits this long for the interrupt before it ends the process
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SessionState = 'idle' | 'starting' | 'running' | 'ending' | 'yielded' | 'takingOver';
export type SendResult = { ok: true; sid: string } | { ok: false; error: string };

// A message for the process: your prompt (a turn), or bash mode's context (`shouldQuery: false`, no
// turn). `inBox`: the page still holds the prompt (a take-over), so a refusal leaves it there.
type Prompt = { kind: 'prompt'; content: Content; uuid: string; text: string; inBox?: boolean };
type Context = { kind: 'context'; text: string; uuid: string };
type Input = Prompt | Context;

// The model and effort you chose (state.json `models`). `default` is the CLI's default model; an
// effort of null or missing is the model's default effort.
export type ModelChoice = { model: string; effort?: string | null };

// The one model resolver, for the header (views.ts) and the process (startOptions): your choice
// wins whole; else what the transcript last asked for; else settings.model.
export function resolveModel(choice: ModelChoice | null | undefined, transcript: { model: string | null; effort: string | null }, fallback?: string): { model: string | null; effort: string | null } {
  if (choice) return { model: choice.model, effort: choice.effort || null };
  return { model: transcript.model || fallback || null, effort: transcript.effort || null };
}

// What a session needs from cli-terminals.ts (tests pass a fake).
export type TerminalSource = {
  holder(sid: string): Terminal | null;
  recheck(sid: string): Terminal | null; // the files again, right before acting
  confirm?(sid: string): Promise<Terminal | null>; // the start check: every live pid verified afresh
  onChange(fn: () => void): void;
  end(t: Terminal, note: string, sid: string): Promise<boolean>; // the CLI ended and its transcript settled
};

export type SessionDeps = {
  store: Store;
  views: Views;
  log: Log;
  sdk: Sdk;
  terminals: TerminalSource | null;
  now: () => number;
  timer?: Timer;
  idleMs: number;
  tilde: (p: string) => string;
  onTurnEnded?: (sid: string) => void;
  onWaiting?: (sid: string) => void;
  onCommands?: (sid: string, commands: SlashCommand[]) => void;
  // The process reports another id (init of a new session, a reset): sessions.ts moves the record.
  rekey: (s: Session, newId: string, why: 'init' | 'reset' | 'moved') => void;
};

export class Session {
  id: string;
  readonly cwd: string; // absolute
  placeholder: boolean;
  choice: ModelChoice | null = null; // a placeholder's model and effort, stored once it has its id
  readonly status: SessionStatus;
  readonly cards: Cards;
  private d: SessionDeps;
  private state: SessionState = 'idle';
  private proc: SessionProcess | null = null;
  private queue: Input[] = []; // sent while it starts or ends: the next process takes them, in order
  private held: Prompt[] = []; // sent while a card waits
  private takeover: Prompt | null = null; // your message that takes it back from a terminal
  private terminal: Terminal | null = null; // the terminal's CLI that holds it (read-only while set)
  private stream = new StreamPreview();
  private streamTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private interrupting = false; // an interrupt is on its way: held messages go back to the box
  private contextOnly = false; // the process took only bash mode's context: its init starts no turn
  private bang: Bang | null = null; // the `!` command that runs or ran last: one at a time
  private ownEnd = 0; // when a process of ours last ended (0: none yet), for feedRunning
  private askId = ''; // the tool use id of the question or plan another process asks (R6.8)
  private closed = false;

  constructor(id: string, cwd: string, placeholder: boolean, init: StatusEntry | null, d: SessionDeps) {
    this.id = id;
    this.cwd = cwd;
    this.placeholder = placeholder;
    this.d = d;
    this.status = new SessionStatus(init, (e) => this.statusChanged(e), d.now, { timer: d.timer });
    this.cards = new Cards({
      store: d.store,
      sid: () => this.id,
      show: (r) => { d.views.setPending(this.id, r); d.onWaiting?.(this.id); },
      clear: (rid) => { d.views.clearPending(this.id, rid); d.onWaiting?.(this.id); },
      count: (n) => this.status.setPending(n),
      drained: () => this.releaseHeld(),
      context: () => ({ cwd: d.tilde(this.cwd), modeBefore: d.views.facts(this.id)?.modeBeforePlan || 'auto' }),
      now: d.now,
    });
  }

  get phase(): SessionState {
    return this.state;
  }

  // Shown: its transcript tails, and its status, terminal, choice and process end are set.
  open(): void {
    const { views, store } = this.d;
    views.open(this.id, { cwd: this.cwd });
    this.terminal = this.placeholder ? null : this.d.terminals?.holder(this.id) ?? null;
    if (this.terminal) {
      this.state = 'yielded';
      this.status.setTerminal(this.terminal.pid); // read-only from the start (R3.2)
    }
    views.setStatus(this.id, this.status.status, this.status.at, this.status.detail);
    views.setChoice(this.id, this.choiceOf() ?? null);
    this.feedRunning(); // working while its subagents or forks, or a turn of another process, run
    this.askId = views.running(this.id).ask?.toolUseId ?? ''; // an ask already there at open is no change
    const ended = store.state.ended[this.id];
    if (ended) views.processEnded(this.id, ended, store.state.endedFailed[this.id] === true);
  }

  get working(): boolean {
    return Boolean(this.proc) && this.status.working;
  }

  get hasProcess(): boolean {
    return Boolean(this.proc);
  }

  // A terminal holds it, or a message of yours waits to take it back: a send stays in the box.
  get terminalHolds(): boolean {
    return Boolean(this.terminal || this.takeover);
  }

  choiceOf(): ModelChoice | undefined {
    return this.d.store.state.models[this.id] ?? this.choice ?? undefined;
  }

  menuSource(): MenuSource | null {
    return this.proc?.menuSource() ?? null;
  }

  // ---------- sending ----------

  // `uuid`: the page's id for the message; the page shows it at once (queued while a turn runs).
  send(text: string, images: Image[] = [], uuid?: string): SendResult {
    const bad = imageError(images);
    if (bad) return { ok: false, error: bad };
    const content: Content = userContent(text, images); // the text, then the images whose tags it holds
    if (typeof content === 'string' && !text.trim()) return { ok: false, error: 'Nothing to send.' };
    const m: Prompt = { kind: 'prompt', content, uuid: uuid && UUID.test(uuid) ? uuid : randomUUID(), text };
    if (this.terminal) return this.queueTakeover(m);
    const queues = this.d.views.queues(this.id); // a turn runs: it shows queued until it lands (R5.5)
    const r = this.deliver(m);
    if (r.ok && uuid && !this.terminalHolds) this.d.views.sent(this.id, uuid, text, images.length, queues);
    return r;
  }

  // The message goes to Claude: into the running process, behind a card, or a new process.
  private deliver(m: Prompt): SendResult {
    if (this.state === 'idle') {
      const why = this.start();
      if (why === 'terminal' && m.inBox) return this.queueTakeover(m); // another CLI at the last check: wait for it
      if (why === 'terminal') return this.refusedText([m]);
      if (why) return { ok: false, error: why };
    }
    if (this.cards.size) { // queued behind the card (plan section 6), pushed once it is answered
      this.held.push(m);
      this.d.views.setHeld(this.id, this.held.map((h) => h.text));
      this.d.log('sessions.held', { sid: this.id });
      return { ok: true, sid: this.id };
    }
    this.input([m]);
    return { ok: true, sid: this.id };
  }

  // The one way into the process. Starting or ending: kept for the next process, in order.
  private input(list: Input[]): void {
    if (!list.length) return;
    const prompt = list.some((m) => m.kind === 'prompt');
    if (this.state === 'starting' || this.state === 'ending') {
      this.queue.push(...list);
      if (prompt && this.state === 'ending') { this.clearIdle(); this.status.turnStarted(); } // shown working meanwhile
      this.d.log('sessions.queued', { sid: this.id, state: this.state, n: list.length });
      return;
    }
    const proc = this.proc;
    if (!proc) return;
    for (const m of list) {
      if (m.kind === 'prompt') proc.push(m.content, m.uuid);
      else proc.pushQuiet(m.text, m.uuid);
    }
    if (prompt) {
      this.contextOnly = false;
      this.clearIdle();
      this.status.turnStarted();
    }
    this.d.log('sessions.send', { sid: this.id, n: list.length, prompt });
  }

  // No card waits any more, or the turn ended: the messages held behind the cards go to Claude.
  private releaseHeld(): void {
    if (this.cards.size || this.interrupting || !this.proc || this.proc.done || this.state !== 'running' || !this.held.length) return;
    const held = this.held.splice(0);
    this.d.views.setHeld(this.id, []);
    this.input(held);
    this.d.log('sessions.released', { sid: this.id, n: held.length });
  }

  // The turn ended with requests or held messages left (an interrupt, the process ending): the
  // requests end and the held messages go back to the message box.
  private endCards(): void {
    this.cards.abortAll();
    const texts = this.held.splice(0).map((h) => h.text).filter((t) => t.trim());
    if (texts.length) {
      this.d.views.setHeld(this.id, []);
      this.d.views.restore(this.id, texts);
    }
  }

  // Prompts that can't go because a terminal holds the session: back to the box (a take-over's
  // stays there, waiting), with the reason.
  private refusedText(list: Input[]): SendResult {
    const texts: string[] = [];
    for (const m of list) {
      if (m.kind !== 'prompt') continue;
      if (m.inBox) this.queueTakeover(m);
      else if (m.text.trim()) texts.push(m.text);
    }
    if (texts.length) this.d.views.restore(this.id, texts);
    return { ok: false, error: `A terminal holds this session (pid ${this.terminal?.pid ?? '?'}). Send again to bring it back.` };
  }

  // ---------- bash mode (R5.13): `!` runs a shell command in the session's folder ----------
  // The output streams to the page (views.setBang) and, once the command ends, the command and its
  // output go to the session as context that starts no turn (bang.ts). Not in a session a terminal
  // holds (one writer), and one command at a time.
  runBang(cmd: string, uuid?: string): SendResult {
    if (!cmd.trim()) return { ok: false, error: 'Type a shell command after the !.' };
    if (this.terminalHolds) return { ok: false, error: `A terminal holds this session (pid ${this.terminal?.pid ?? '?'}). Run the command there.` };
    if (this.bang?.run.running) return { ok: false, error: 'A shell command is still running in this session. Wait for it, or Esc, Esc to end it.' };
    if (!isDir(this.cwd)) return { ok: false, error: `Folder ${this.d.tilde(this.cwd)} no longer exists` };
    const id = uuid && UUID.test(uuid) ? uuid : randomUUID();
    const bang = new Bang({
      id, cmd, cwd: this.cwd, now: this.d.now,
      onUpdate: (run) => { if (this.bang === bang) this.d.views.setBang(this.id, run); },
      onDone: (run) => {
        if (this.bang !== bang) return; // closed meanwhile
        this.d.log('bang.done', { sid: this.id, exit: run.exit, interrupted: run.interrupted, cut: run.cut, chars: run.out.length + run.err.length, failed: Boolean(run.error) });
        if (run.error) this.d.views.toast(run.error); // it couldn't start
        else this.shareBang(run, bang.cap);
        this.d.views.setBang(this.id, run);
      },
    });
    this.bang = bang;
    this.d.log('bang.start', { sid: this.id });
    this.d.views.setBang(this.id, bang.run);
    return { ok: true, sid: this.id };
  }

  // The command and its output go to Claude in the CLI's format, as two user messages that start
  // no turn: into the running process, after the ending one, or a process started for them.
  private shareBang(run: BangRun, cap: number): void {
    if (this.terminalHolds) { run.error = 'Not shared with Claude: a terminal took the session meanwhile.'; return; }
    const fresh = this.state === 'idle';
    if (fresh) {
      const why = this.start();
      if (why) { run.error = `Not shared with Claude: ${why === 'terminal' ? 'a terminal holds this session' : why}.`; return; }
    }
    this.input([{ kind: 'context', text: bashInput(run.cmd), uuid: run.id }, { kind: 'context', text: bashOutput(run, cap), uuid: randomUUID() }]);
    this.d.log('bang.shared', { sid: this.id, newProcess: fresh });
  }

  // ---------- the process ----------

  // Test-only (the scripted SDK, app/backend/dev/scripted-sdk.ts): the process starts now with no
  // message, as a resumed session waiting for input, and the script plays its messages. Its init
  // starts no turn. No folder check: no CLI runs. False when a process runs or a terminal holds it.
  startIdle(): boolean {
    if (this.state !== 'idle') return false;
    return this.start(true) === '';
  }

  // Starts the process, or says why not: '' (starting), 'terminal' (a live terminal holds it at the
  // last check; one writer), else the error for the toast. `anyFolder`: startIdle's.
  private start(anyFolder = false): string {
    if (!anyFolder && !isDir(this.cwd)) {
      this.status.failed();
      this.d.log('driver.noFolder', { sid: this.id });
      return `Folder ${this.d.tilde(this.cwd)} no longer exists`;
    }
    const terminals = this.placeholder ? null : this.d.terminals;
    const held = terminals?.recheck(this.id) ?? null;
    if (held) {
      this.yieldTo(held);
      this.d.log('driver.refused', { sid: this.id, pid: held.pid });
      return 'terminal';
    }
    this.state = 'starting';
    const confirm = terminals?.confirm?.(this.id);
    if (!confirm) this.launch();
    else void confirm.then((t) => this.confirmed(t));
    return '';
  }

  // The start check's answer. A terminal took the session at the last moment: what waited goes back.
  private confirmed(t: Terminal | null): void {
    if (this.closed || this.state !== 'starting') return; // closed, or yielded meanwhile
    if (!t) { this.launch(); return; }
    this.d.log('driver.refused', { sid: this.id, pid: t.pid, late: true });
    const waiting = this.queue.splice(0);
    this.state = 'idle';
    this.yieldTo(t);
    const r = this.refusedText(waiting);
    if (!r.ok && waiting.some((m) => m.kind === 'prompt' && !m.inBox)) this.d.views.toast(r.error);
  }

  private launch(): void {
    const start = this.startOptions();
    const proc: SessionProcess = new SessionProcess(start, {
      onMessage: (m) => {
        if (this.proc !== proc) return;
        this.status.observe(m); // signed out, no updates, rate limited, compacting, queued (status.ts)
        this.onMessage(m as Msg);
      },
      onPush: (uuid) => this.status.pushed(uuid),
      onExit: (error, ended) => this.onExit(proc, error, ended),
      canUseTool: (name, input, o) => {
        this.d.log('driver.ask', { sid: this.id, tool: name, agent: Boolean(o.agentID) });
        return this.cards.park(name, input, o);
      },
    }, this.d.sdk.query);
    this.proc = proc;
    this.state = 'running';
    this.contextOnly = true; // until a prompt goes in
    this.feedRunning(); // our process drives it now: the transcript's open turn is ours
    this.d.log('driver.start', { sid: this.id, resume: Boolean(start.resume), model: start.model ?? null, plan: Boolean(start.plan) });
    this.armIdle(); // a prompt clears it; context alone starts no turn that would
    this.input(this.queue.splice(0));
  }

  private startOptions(): StartOptions {
    const st = this.d.store.state;
    const facts = this.d.views.facts(this.id);
    const m = resolveModel(this.choiceOf(), { model: facts?.model ?? null, effort: facts?.effort ?? null }, st.settings.model);
    return {
      cwd: this.cwd,
      resume: this.placeholder ? undefined : this.id,
      model: m.model && m.model !== 'default' ? m.model : undefined,
      effort: m.effort || undefined,
      plan: facts?.permissionMode === 'plan',
      allowedTools: this.cards.rules(),
    };
  }

  private onExit(proc: SessionProcess, error: Error | null, ended: boolean): void {
    if (this.proc !== proc) return; // closed, yielded or quit: no failure
    this.proc = null;
    this.state = 'idle';
    this.ownEnd = this.d.now();
    this.clearIdle();
    this.clearStream();
    const failed = !ended;
    this.d.log('driver.exit', { sid: this.id, ended, error: Boolean(error) });
    this.ended(failed);
    this.endCards();
    this.status.processEnded(failed);
    if (failed) {
      const tail = proc.stderrTail();
      const why = tail.length ? tail[tail.length - 1] : error?.message || 'it exited';
      this.d.views.toast(`Claude stopped unexpectedly: ${why.slice(0, 300)}`);
    }
    // Messages sent while it was ending start the next process (resumed), in order.
    const next = this.queue.splice(0);
    if (!next.length || this.closed) return;
    const why = this.start();
    if (why) {
      const texts = next.filter((m): m is Prompt => m.kind === 'prompt').map((m) => m.text).filter((t) => t.trim());
      if (texts.length) this.d.views.restore(this.id, texts);
      return;
    }
    this.input(next);
  }

  private onMessage(m: Msg): void {
    const { views, log } = this.d;
    if (m.type === 'system' && m.subtype === 'init') {
      if (typeof m.session_id === 'string' && m.session_id && m.session_id !== this.id) this.d.rekey(this, m.session_id, this.placeholder ? 'init' : 'moved');
      if (!this.contextOnly) this.status.turnStarted(); // a process started only for bash mode's context runs no turn
    } else if (m.type === 'system' && m.subtype === 'session_state_changed') {
      this.status.stateChanged(String(m.state));
    } else if (m.type === 'system' && m.subtype === 'status' && typeof m.permissionMode === 'string') {
      log('driver.mode', { sid: this.id, mode: m.permissionMode }); // after a plan approval (back to auto), or a model switch
    } else if (m.type === 'system' && m.subtype === 'task_notification' && typeof m.tool_use_id === 'string') {
      // A task ended. The CLI writes its notification to the JSONL only when a turn runs, so
      // between turns this is the only sign that it ended (docs/Agent SDK.md, "Task notifications").
      log('driver.task', { sid: this.id, status: String(m.status) });
      views.taskEnded(this.id, m.tool_use_id, String(m.status), typeof m.summary === 'string' ? m.summary : '');
    } else if (m.type === 'system' && m.subtype === 'task_started' && typeof m.tool_use_id === 'string' && typeof m.task_id === 'string') {
      // A subagent's shell or monitor: its file has no task id when the SDK drives the CLI (docs/Agent SDK.md).
      views.taskStarted(this.id, m.tool_use_id, m.task_id);
    } else if (m.type === 'system' && m.subtype === 'background_tasks_changed' && Array.isArray(m.tasks)) {
      // The whole live set (b, b moves steps into it): running or ended at once. Ambient tasks aren't work.
      const ids = (m.tasks as { task_id?: unknown; ambient?: unknown }[]).filter((t) => t && typeof t.task_id === 'string' && t.ambient !== true).map((t) => t.task_id as string);
      log('driver.bgTasks', { sid: this.id, n: ids.length });
      views.backgroundTasks(this.id, ids);
    } else if (m.type === 'tool_progress' && typeof m.tool_use_id === 'string' && typeof m.elapsed_time_seconds === 'number') {
      // A running tool's elapsed time, no output (sdk.d.ts SDKToolProgressMessage): its expanded step's timer (R5.6).
      views.toolProgress(this.id, m.tool_use_id, m.elapsed_time_seconds);
    } else if (m.type === 'system' && m.subtype === 'commands_changed' && Array.isArray(m.commands)) {
      this.d.onCommands?.(this.id, m.commands as SlashCommand[]);
    } else if (m.type === 'conversation_reset' && typeof m.new_conversation_id === 'string') {
      this.clearStream();
      this.d.rekey(this, m.new_conversation_id, 'reset');
    } else if (m.type === 'stream_event') {
      if (this.stream.event(m as { event: unknown; parent_tool_use_id: string | null })) this.pushStream(false);
    } else if (m.type === 'result') {
      this.clearStream();
      this.status.result({ subtype: String(m.subtype), is_error: m.is_error === true, terminal_reason: typeof m.terminal_reason === 'string' ? m.terminal_reason : undefined });
      this.d.onTurnEnded?.(this.id);
      this.releaseHeld(); // held behind a card that is gone: they are the next turn
    }
  }

  // The process ended (close, idle end, quit, failure, yield): what ran inside it stopped. Stored,
  // so the transcript reads the same after a restart or a reopen. `failed`: a tool it left without a
  // result reads as failed, not stopped.
  private ended(failed = false): void {
    const at = this.d.now();
    if (!this.placeholder) {
      const st = this.d.store.state;
      st.ended[this.id] = at;
      if (failed) st.endedFailed[this.id] = true;
      else delete st.endedFailed[this.id];
      this.d.store.changed();
    }
    this.d.views.processEnded(this.id, at, failed);
  }

  private statusChanged(e: StatusEntry): void {
    const { views, store } = this.d;
    views.setStatus(this.id, e.status, e.at, e.detail);
    const kept = store.state.status[this.id];
    if (!this.placeholder && (kept?.status !== e.status || kept?.at !== e.at)) {
      store.state.status[this.id] = { status: e.status, at: e.at };
      store.changed();
    }
    if (this.status.working || e.status === 'waiting') this.clearIdle();
    else this.armIdle();
  }

  // A process ends after the idle time with no turn, card, subagent or background work running.
  private armIdle(): void {
    this.clearIdle();
    if (!this.proc) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.proc || this.state !== 'running' || this.status.working) return;
      if (this.d.views.facts(this.id)?.working) { this.armIdle(); return; }
      this.d.log('driver.idleEnd', { sid: this.id });
      this.state = 'ending';
      this.proc.end();
    }, this.d.idleMs);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  // ---------- controls ----------

  // Esc, Esc: ends a running `!` command first; else stops the foreground turn, background work
  // keeps running (perTaskStopAffordance). Messages the interrupt cancelled go back to the box. A
  // CLI without the cancel capability runs them afterwards, and the toast says so.
  async interrupt(): Promise<void> {
    if (this.bang?.run.running) {
      this.d.log('bang.interrupt', { sid: this.id });
      this.bang.kill();
      return;
    }
    const proc = this.proc;
    if (!proc || !this.status.working) return;
    this.status.interrupted();
    this.interrupting = true;
    let r: InterruptResult;
    try {
      r = await proc.interrupt();
    } catch (e) {
      this.interrupting = false;
      this.status.interruptFailed(); // the next turn's result is its own, not "stopped"
      this.d.log('driver.interruptFailed', { sid: this.id });
      this.d.views.toast(`Synopia couldn't interrupt Claude: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      return;
    }
    this.interrupting = false;
    this.d.log('driver.interrupt', { sid: this.id, cancelQueued: r.cancelQueued, restored: r.restored.length, stillQueued: r.stillQueued });
    this.endCards();
    if (r.restored.length) this.d.views.restore(this.id, r.restored);
    if (r.stillQueued) {
      const n = r.stillQueued;
      this.d.views.toast(`Interrupted. ${n === 1 ? 'Your queued message' : `${n} queued messages`} will still run: this Claude Code can't cancel ${n === 1 ? 'it' : 'them'}.`);
    }
  }

  // The model picker. Stored per session and passed at the next start; a running process gets
  // setModel (when the model changed) and applyFlagSettings for the effort.
  async setModel(model: string, effort: string | null): Promise<SendResult> {
    if (!model) return { ok: false, error: 'No model was chosen.' };
    const facts = this.d.views.facts(this.id);
    const was = resolveModel(this.choiceOf(), { model: facts?.model ?? null, effort: facts?.effort ?? null });
    const choice: ModelChoice = { model, effort: effort || null };
    if (this.placeholder) this.choice = choice;
    else {
      this.d.store.state.models[this.id] = choice;
      this.d.store.changed();
    }
    this.d.views.setChoice(this.id, choice);
    this.d.log('sessions.setModel', { sid: this.id, model, effort: choice.effort ?? null, running: Boolean(this.proc) });
    const proc = this.proc;
    if (!proc || proc.done) return { ok: true, sid: this.id };
    try {
      if (model !== was.model) await proc.setModel(model === 'default' ? undefined : model);
      if ((choice.effort ?? null) !== was.effort || model !== was.model) await proc.setEffort(choice.effort ?? null);
    } catch (e) {
      this.d.log('driver.setModelFailed', { sid: this.id });
      return { ok: false, error: `Synopia stored the model, but Claude didn't take it now: ${String((e as Error)?.message ?? e).slice(0, 200)}. It applies when the session starts again.` };
    }
    return { ok: true, sid: this.id };
  }

  // b, b (R9): the session's foreground Bash commands and subagents go to the background
  // (Query.backgroundTasks). The panel shows them from background_tasks_changed and the transcript;
  // only a failure has something to say.
  async background(): Promise<SendResult> {
    const proc = this.proc;
    if (!proc || proc.done) return { ok: false, error: 'Nothing could go to the background.' };
    let moved: boolean;
    try {
      moved = await proc.backgroundTasks();
    } catch {
      this.d.log('sessions.backgroundFailed', { sid: this.id });
      return { ok: false, error: 'Nothing could go to the background: background tasks are turned off for this session (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).' };
    }
    this.d.log('sessions.background', { sid: this.id, moved });
    return moved ? { ok: true, sid: this.id } : { ok: false, error: 'Nothing could go to the background.' };
  }

  // A card's answer settles its canUseTool request (cards.ts); held messages go after the last card.
  answer(requestId: string, answer: CardAnswer): SendResult {
    const r = this.cards.answer(requestId, answer);
    if ('error' in r) return { ok: false, error: r.error };
    this.d.log('sessions.answer', { sid: this.id, behavior: r.result.behavior, rules: r.rules.length });
    return { ok: true, sid: this.id };
  }

  // ---------- a terminal holds the session (R3.2) ----------

  // Your message stays in the box (the page keeps it) until the take-over is done. A newer one
  // replaces it while it waits.
  private queueTakeover(m: Prompt): SendResult {
    if (this.state === 'takingOver') return { ok: false, error: 'Synopia is already taking it back from the terminal.' };
    this.takeover = { ...m, inBox: true };
    this.status.setTakeover('waiting');
    this.d.log('takeover.queued', { sid: this.id, pid: this.terminal?.pid ?? null });
    this.tryTakeover();
    return { ok: true, sid: this.id };
  }

  // Esc or an edit in the box: the message no longer waits for the terminal.
  cancelTakeover(): SendResult {
    if (!this.takeover || this.state === 'takingOver') return { ok: true, sid: this.id };
    this.takeover = null;
    this.status.setTakeover(null);
    this.d.log('takeover.cancelled', { sid: this.id });
    return { ok: true, sid: this.id };
  }

  // The CLI runs nothing: idle by its pid file, and no turn, card, subagent or background work in the transcript.
  private terminalIdle(t: Terminal): boolean {
    const r = this.d.views.running(this.id);
    return t.status === 'idle' && !r.turn && !r.ask && r.agents === 0 && !this.d.views.facts(this.id)?.working;
  }

  private tryTakeover(): void {
    if (!this.takeover || this.state === 'takingOver') return;
    const t = this.terminal;
    if (!t) { this.finishTakeover(); return; } // it exited by itself
    if (!this.terminalIdle(t)) return; // waits for it
    this.state = 'takingOver';
    this.status.setTakeover('taking');
    void this.runTakeover(t);
  }

  private async runTakeover(seen: Terminal): Promise<void> {
    const terminals = this.d.terminals;
    const fresh = terminals ? terminals.recheck(this.id) : null;
    if (fresh && (fresh.pid !== seen.pid || !this.terminalIdle(fresh))) {
      // the race: it became busy (or another CLI took it) at the last check
      this.terminal = fresh;
      this.state = 'yielded';
      this.status.setTerminal(fresh.pid);
      this.status.setTakeover('waiting');
      this.d.log('takeover.raced', { sid: this.id, pid: fresh.pid });
      return;
    }
    if (fresh && terminals) {
      this.d.log('takeover.end', { sid: this.id, pid: fresh.pid });
      const ok = await terminals.end(fresh, takeoverNote(this.id, new Date(this.d.now())), this.id);
      if (this.closed) return;
      if (!ok) {
        this.takeover = null;
        this.state = 'yielded';
        this.status.setTakeover(null);
        this.d.log('takeover.noExit', { sid: this.id, pid: fresh.pid });
        this.d.views.toast(`The terminal's Claude Code (pid ${fresh.pid}) didn't exit, so Synopia left it running. Your message is still in the box.`);
        return;
      }
    }
    this.terminal = null;
    this.state = 'idle';
    this.status.setTerminal(0);
    this.finishTakeover();
  }

  // The terminal is gone: the message goes, as any other. The take-over mark clears after the send,
  // so the page sees the turn start and the mark go together (and then clears the box).
  private finishTakeover(): void {
    const m = this.takeover;
    if (!m) return;
    this.takeover = null;
    const r = this.deliver(m);
    if (this.takeover) return; // back to waiting: another terminal took it at the last check
    this.status.setTakeover(null);
    this.d.log('takeover.done', { sid: this.id, ok: r.ok });
    if (!r.ok) this.d.views.toast(r.error);
  }

  // The terminals changed (sessions.ts passes this session's holder): a terminal appeared (yield),
  // its status changed (a waiting take-over may go now), or it exited (Synopia's again, quietly).
  terminalChanged(t: Terminal | null): void {
    if (this.placeholder || this.state === 'takingOver') return;
    if (t && !this.terminal) this.yieldTo(t);
    else if (t && this.terminal) {
      this.terminal = t;
      this.status.setTerminal(t.pid);
      this.tryTakeover();
    } else if (!t && this.terminal) {
      this.terminal = null;
      this.state = 'idle';
      this.status.setTerminal(0);
      this.d.log('terminal.gone', { sid: this.id });
      this.feedRunning();
      this.tryTakeover();
    }
  }

  // A terminal took the session: its turn (if one runs) is interrupted, then its process ends.
  // Messages held behind a card or waiting for the process go back to the box.
  private yieldTo(t: Terminal): void {
    const had = this.terminal;
    this.terminal = t;
    this.status.setTerminal(t.pid);
    const proc = this.proc;
    const waiting = this.queue.splice(0);
    this.state = 'yielded';
    if (had) return;
    this.d.log('terminal.took', { sid: this.id, pid: t.pid, running: Boolean(proc) });
    const texts = waiting.filter((m): m is Prompt => m.kind === 'prompt').map((m) => m.text).filter((x) => x.trim());
    if (texts.length) this.d.views.restore(this.id, texts);
    if (!proc) return;
    const working = this.status.working;
    this.proc = null; // its exit is no failure
    this.ownEnd = this.d.now();
    this.clearIdle();
    this.clearStream();
    this.endCards();
    this.ended();
    this.status.processEnded(false);
    this.feedRunning();
    void (async () => {
      if (working && !proc.done) {
        try {
          await Promise.race([proc.interrupt(), new Promise((r) => setTimeout(r, YIELD_INTERRUPT_MS))]);
        } catch { /* it ends below either way */ }
      }
      proc.close();
    })();
  }

  // ---------- from the transcripts ----------

  // What runs by the transcript changed (R8.2): subagents and forks make it working, and so does a
  // main turn another process runs.
  runningChanged(r: Running): void {
    this.feedRunning(r);
    const ask = r.ask?.toolUseId ?? '';
    if (ask !== this.askId) { this.askId = ask; this.d.onWaiting?.(this.id); }
    this.tryTakeover(); // the terminal's turn may have ended in its transcript
  }

  // The transcript's main turn counts only with no process of ours, and only for records written
  // after ours ended (an open turn our own process left behind is not someone else's).
  private feedRunning(r: Running = this.d.views.running(this.id)): void {
    this.status.setRunning(r, !this.proc && r.lastAt > this.ownEnd);
  }

  // An assistant record of the main conversation landed: its preview block goes.
  landed(messageId: string, types: string[]): void {
    if (this.stream.land(messageId, types)) this.pushStream(true);
  }

  private pushStream(now: boolean): void {
    if (now) {
      if (this.streamTimer) clearTimeout(this.streamTimer);
      this.streamTimer = null;
      this.d.views.setStream(this.id, this.stream.text());
      return;
    }
    if (this.streamTimer) return;
    this.streamTimer = setTimeout(() => {
      this.streamTimer = null;
      this.d.views.setStream(this.id, this.stream.text());
    }, STREAM_MS);
  }

  private clearStream(): void {
    if (this.stream.clear() || this.streamTimer) this.pushStream(true);
  }

  // ---------- the end ----------

  // Close (R3.6): its process ends now, background work included, and its `!` command, cards and
  // "Always allow" rules go. Returns whether a process ran.
  close(): boolean {
    this.closed = true;
    this.clearIdle();
    if (this.streamTimer) clearTimeout(this.streamTimer);
    const proc = this.proc;
    this.proc = null; // its exit is no failure
    this.state = 'idle';
    this.queue = [];
    this.held = [];
    this.bang?.kill();
    this.bang = null;
    this.cards.close();
    proc?.close();
    if (proc) this.ended();
    return Boolean(proc && !proc.done);
  }

  // Quit: the process ends now; its exit runs nothing (no toast, no next process).
  stop(): void {
    this.closed = true;
    this.clearIdle();
    if (this.streamTimer) clearTimeout(this.streamTimer);
    this.bang?.kill();
    const proc = this.proc;
    this.proc = null;
    this.state = 'idle';
    if (proc) {
      proc.close();
      this.ended();
    }
  }
}

type Msg = { type: string; subtype?: string; [k: string]: unknown };

// The streaming preview (plan section 7): text deltas of the main conversation, per message id
// and block index, until that block's record lands in the JSONL.
export class StreamPreview {
  private blocks: { msg: string; index: number; type: string; text: string }[] = [];
  private msg = '';

  // Returns true when the preview text changed.
  event(m: { event: unknown; parent_tool_use_id: string | null }): boolean {
    if (m.parent_tool_use_id) return false; // a subagent's
    const ev = m.event as { type?: string; index?: number; message?: { id?: string }; content_block?: { type?: string; text?: string }; delta?: { type?: string; text?: string } };
    if (ev.type === 'message_start') {
      this.msg = ev.message?.id ?? '';
      return false;
    }
    if (ev.type === 'content_block_start' && typeof ev.index === 'number') {
      const type = ev.content_block?.type ?? '';
      this.blocks.push({ msg: this.msg, index: ev.index, type, text: type === 'text' ? ev.content_block?.text ?? '' : '' });
      return Boolean(ev.content_block?.text);
    }
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.index === 'number') {
      const b = this.blocks.find((x) => x.msg === this.msg && x.index === ev.index);
      if (!b) return false;
      b.text += ev.delta.text ?? '';
      return true;
    }
    return false;
  }

  // An assistant record landed: the CLI writes one per finished block, with the message's id.
  // It takes the oldest preview block of that message with the same block type.
  land(msg: string, types: string[]): boolean {
    let changed = false;
    for (const type of types) {
      const i = this.blocks.findIndex((b) => b.msg === msg && b.type === type);
      if (i === -1) continue;
      changed ||= Boolean(this.blocks[i].text);
      this.blocks.splice(i, 1);
    }
    return changed;
  }

  clear(): boolean {
    const had = this.text() !== null;
    this.blocks = [];
    return had;
  }

  text(): string | null {
    const t = this.blocks.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n\n');
    return t || null;
  }
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
