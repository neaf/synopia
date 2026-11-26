// The scripted SDK (dev and page checks only, Q5): `query()` and `listSessions()` as sdk.ts uses them,
// played from a script instead of a Claude Code CLI, so the real Sessions, status, writer and menu
// code run over a fixture tree with no model call. main.ts loads it only with --sdk-script <file>.
// - A session's query plays its script's steps (SDK messages, canUseTool calls, records appended to
//   the transcript, messages you send) and answers the control calls: the menu, setModel,
//   applyFlagSettings, backgroundTasks and interrupt (queued messages not yet in the transcript are
//   cancelled, the turn ends stopped). A message that starts a turn, and bash mode's context, are
//   appended to the transcript as the CLI writes them. For f, f (docs/Agent SDK.md, "Sending queued
//   messages now"): backgroundTasks takes the queued messages into the running turn, a plain
//   interrupt (no cancelQueued) runs them next as one turn, and a `priority: 'now'` message is
//   taken in at once.
// - The writer's one-shot call gets the script's `writer` reply, else a failed result. The idle
//   menu probe answers from the script's `menu`.
// - MCP (docs/Agent SDK.md, "MCP servers: status, sign-in"): every query answers mcpServerStatus,
//   reconnectMcpServer and toggleMcpServer from the script's `mcp.servers` (a session's own
//   mcpServers too, as source `sdk`), and `mcpRunner` is a pretend `claude mcp login|logout`: a
//   sign-in takes `mcp.loginMs` and lets the next reconnect connect; a sign-out undoes it.
// - listSessions() lists the fixture tree's transcripts.
// - A clock for `ago`: while a step plays, Sessions' clock reads that much earlier, so a status or a
//   card starts in the past; timers armed then count on the same clock. Steps play one at a time.
// - The terminals' probe: every pid file under <claude-dir>/sessions/ is a live CLI that isn't
//   Synopia's, and a take-over's signal only logs (the pretend CLI exits). No real process is asked
//   or signalled.
// - A fresh state folder is seeded: state.json's open list holds every fixture session, with the
//   status, the age and the process end the script gives.
// The script format is described in docs/Page checks.md ("The scripted SDK").
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CanUseTool, McpServerStatus, ModelInfo, Options, SDKMessage, SDKSessionInfo, SDKUserMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { CANCEL_QUEUED } from '../src/sdk.ts';
import { callServed } from '../src/agent-tools.ts';
import type { ListFn, QueryFn, QueryLike, Sdk } from '../src/sdk.ts';
import type { McpRunner } from '../src/mcp.ts';
import type { Probe, EndDeps } from '../src/cli-terminals.ts';
import type { Timer } from '../src/status.ts';
import type { Log } from '../src/log.ts';
import { nullLog } from '../src/log.ts';

export const SCRIPT_FILE = 'sdk-script.json';

export type Step = {
  after?: number; // ms after the previous step (default 0)
  ago?: number; // the clock reads this many ms earlier while the step plays
  message?: Record<string, unknown>; // an SDK message the query yields; session_id and uuid filled in
  // a canUseTool call; the next step waits for its answer
  ask?: { tool: string; input: Record<string, unknown>; id?: string; toolUseId?: string; agentId?: string; suggestions?: unknown[]; [k: string]: unknown };
  append?: Record<string, unknown>[]; // transcript records, as the CLI writes them (timestamp, sessionId, cwd filled in)
  send?: string; // a message you send, as the page's `send` does (it reaches Sessions.send)
  // a call of one of Synopia's own tools (agent-tools.ts), as the CLI makes it: the tool_use record,
  // canUseTool (the next step waits for the answer), the tool from the session's mcpServers, its
  // tool_result record (docs/Agent SDK.md, "Synopia's tools for agents")
  call?: { tool: string; input: Record<string, unknown>; toolUseId?: string };
  // a request the CLI retries, as it reports one: the `system/api_error` record with its sentence in the
  // transcript, then the `system/api_retry` message (docs/Agent SDK.md, "Retried requests")
  retry?: { attempt: number; max: number; delayMs: number; status: number | null; error: string; text: string; credential?: boolean };
};
export type SessionScript = {
  // seeded into a fresh state folder: the status and its age, the open entry's folder, and how long
  // ago Synopia's last process for it ended (a tool or ask it left reads as stopped)
  state?: { status?: string; ago?: number; cwd?: string; endedAgo?: number };
  start?: boolean; // a process runs from the start (Sessions.startIdle), as a resumed session
  steps?: Step[]; // played once, when its first process starts
  onSend?: Step[]; // played on each message that starts a turn
};
export type Script = {
  about?: string;
  home?: string; // `~` for paths
  menu?: { commands: SlashCommand[]; models: ModelInfo[] };
  writer?: { title: string; now: string }; // the writer's reply; without it every call fails
  onSend?: Step[]; // for sessions with no onSend of their own
  sessions: Record<string, SessionScript>;
  // MCP servers every query reports (status: connected, needs-auth, failed, pending, disabled; kind:
  // http (default), sse, stdio, claudeai-proxy); a pending one connects after pendingMs. A sign-in
  // takes loginMs (default 1500); one of a server in failLogin fails with the CLI's stderr line.
  mcp?: { servers: McpScript[]; loginMs?: number; pendingMs?: number; failLogin?: string[] };
};
export type McpScript = { name: string; status: McpServerStatus['status']; kind?: string; scope?: string };

export function loadScript(file: string | null): Script {
  if (!file || !fs.existsSync(file)) return { sessions: {} };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Script>;
  return { ...raw, sessions: raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {} };
}

// Every `projects/*/<id>.jsonl`, sorted by id.
export function fixtureSessions(claudeDir: string): { id: string; path: string }[] {
  const projects = path.join(claudeDir, 'projects');
  const out: { id: string; path: string }[] = [];
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(projects).sort();
  } catch {
    return out;
  }
  for (const d of dirs) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(path.join(projects, d));
    } catch {
      continue;
    }
    for (const n of names) {
      const m = /^(.+)\.jsonl$/.exec(n);
      if (m && !out.some((s) => s.id === m[1])) out.push({ id: m[1], path: path.join(projects, d, n) });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function records(file: string): Record<string, unknown>[] {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* a partial line */ }
  }
  return out;
}

const textOf = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((b) => (b && b.type === 'text' ? String(b.text ?? '') : '')).filter(Boolean).join('\n') : '';

// ---------- the state folder ----------

// A state folder whose state.json has no open list gets one: every fixture session, in id order,
// with the script's status (else your turn since its last record) and process end. Other fields
// already there (a check's written titles) stay.
export function seedState(stateDir: string, claudeDir: string, script: Script, now = Date.now()): boolean {
  const file = path.join(stateDir, 'state.json');
  let st: Record<string, unknown> = {};
  try {
    st = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* none yet */ }
  if (Array.isArray(st.open)) return false;
  const open: { id: string; cwd: string; openedAt: number; closedAt: null }[] = [];
  const status: Record<string, { status: string; at: number }> = { ...(st.status as object ?? {}) };
  const ended: Record<string, number> = { ...(st.ended as object ?? {}) };
  for (const s of fixtureSessions(claudeDir)) {
    const recs = records(s.path);
    const want = script.sessions[s.id]?.state ?? {};
    const cwd = want.cwd ?? (recs.find((r) => typeof r.cwd === 'string')?.cwd as string | undefined) ?? '';
    open.push({ id: s.id, cwd, openedAt: 0, closedAt: null });
    const last = Math.max(0, ...recs.map((r) => Date.parse(String(r.timestamp ?? ''))).filter((n) => Number.isFinite(n)));
    status[s.id] = { status: want.status ?? 'idle', at: want.ago !== undefined ? now - want.ago : last || fs.statSync(s.path).mtimeMs };
    if (want.endedAgo !== undefined) ended[s.id] = now - want.endedAgo;
  }
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ version: 1, ...st, open, status, ended }));
  return true;
}

// ---------- the clock ----------

export class ScriptClock {
  offset = 0; // ms, negative while a step with `ago` plays
  now = (): number => Date.now() + this.offset;
  // A timer on this clock: armed in the past, it is due that much sooner.
  timer: Timer = (fn, ms) => {
    const due = this.now() + ms;
    const t = setTimeout(fn, Math.max(0, due - Date.now()));
    t.unref?.();
    return () => clearTimeout(t);
  };
}

// ---------- a session's query ----------

type Out = { msg: SDKMessage; consumed: () => void };

// The messages a query yields. The consumer (sdk.ts SessionProcess) handles each one before it asks
// for the next, so `deliver` resolves once the message was handled: the clock is still moved then.
class Channel implements AsyncIterable<SDKMessage> {
  private buf: Out[] = [];
  private wake: (() => void) | null = null;
  private handed: Out | null = null;
  closed = false;

  deliver(msg: SDKMessage): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((consumed) => {
      this.buf.push({ msg, consumed });
      this.wake?.();
      this.wake = null;
    });
  }

  close(): void {
    this.closed = true;
    for (const o of this.buf.splice(0)) o.consumed();
    this.handed?.consumed();
    this.handed = null;
    this.wake?.();
    this.wake = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: async () => {
        this.handed?.consumed(); // asked for the next one: the last one was handled
        this.handed = null;
        while (!this.buf.length && !this.closed) await new Promise<void>((r) => (this.wake = r));
        const o = this.buf.shift();
        if (!o) return { value: undefined, done: true };
        this.handed = o;
        return { value: o.msg, done: false };
      },
    };
  }
}

type Turn = { cancelled: boolean; asks: AbortController[]; wake: (() => void) | null };

class ScriptedSession implements QueryLike {
  private env: Scripted;
  private sid: string;
  private cwd: string;
  private out = new Channel();
  private canUseTool: CanUseTool;
  private running = false; // a turn runs
  private queued: { uuid: string; text: string }[] = []; // sent during the turn
  private seqs = new Set<Turn>();
  private moved = new Set<string>(); // task ids backgroundTasks moved (background_tasks_changed's live set)
  private writing: { id: string; text: string } | null = null; // the reply the stream_event steps are writing
  private inited = false; // its system/init went out
  private held: { uuid: string; text: string }[] = []; // shouldQuery:false messages not yet in the transcript
  private mcpServers: Record<string, unknown> | undefined; // Synopia's tools for agents, for `call`
  private title: string; // a new session's Options.title: its custom-title record with the first prompt
  private tasks = new Map<string, string>(); // task id -> tool use id, from the task_started messages it played

  constructor(env: Scripted, options: Options, prompt: AsyncIterable<SDKUserMessage>) {
    this.env = env;
    this.sid = options.resume ?? randomUUID();
    this.cwd = options.cwd ?? '';
    this.canUseTool = options.canUseTool as CanUseTool;
    this.mcpServers = options.mcpServers as Record<string, unknown> | undefined;
    this.title = !options.resume && typeof options.title === 'string' ? options.title : '';
    // a fork (docs/Agent SDK.md, "Resume and fork in another folder"): a new id, the whole history copied
    // into a new file under the new cwd's project folder
    if (options.resume && options.forkSession) {
      this.sid = randomUUID();
      env.fork(options.resume, this.sid, this.cwd);
    }
    const script = env.script.sessions[this.sid];
    if (options.resume && !options.forkSession && script?.steps?.length && !env.played.has(this.sid)) {
      env.played.add(this.sid);
      void this.play([{ message: this.init() }, ...script.steps], true);
    }
    void this.read(prompt);
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return this.out[Symbol.asyncIterator]();
  }

  close(): void {
    for (const t of this.seqs) this.cancel(t);
    this.out.close();
  }

  async interrupt(req?: { cancelQueued?: boolean }) {
    const waiting = this.queued.filter((q) => !this.landed(q));
    const cancelled = req?.cancelQueued ? waiting.map((q) => q.uuid) : [];
    const still = req?.cancelQueued ? [] : waiting.map((q) => q.uuid);
    this.queued = [];
    if (this.running) {
      for (const t of this.seqs) this.cancel(t);
      // the plain interrupt keeps the queue: its messages run next, as one turn (live run PR-1)
      const next: Step[] = !req?.cancelQueued && waiting.length ? [
        { append: waiting.map((q) => ({ type: 'user', uuid: q.uuid, message: { role: 'user', content: q.text } })) },
        { message: this.init() }, { message: { type: 'system', subtype: 'session_state_changed', state: 'running' } },
        ...(this.env.script.sessions[this.sid]?.onSend ?? this.env.script.onSend ?? []),
      ] : [];
      // a reply being written stops at once: its partial assistant message lands (live run PR-2)
      const w = this.writing;
      this.writing = null;
      void this.play([
        ...(w && w.text ? [{ append: [{ type: 'assistant', uuid: randomUUID(), message: { role: 'assistant', id: w.id, content: [{ type: 'text', text: w.text }] } }] }] : []),
        { message: { type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' } },
        { message: { type: 'system', subtype: 'session_state_changed', state: 'idle' } },
        ...next,
      ], false);
    }
    return { subtype: 'success', cancelled, still_queued: still } as unknown as Awaited<ReturnType<NonNullable<QueryLike['interrupt']>>>;
  }

  async supportedCommands(): Promise<SlashCommand[]> { return [...(this.env.script.menu?.commands ?? [])]; }
  async supportedModels(): Promise<ModelInfo[]> { return [...(this.env.script.menu?.models ?? [])]; }
  async mcpServerStatus(): Promise<McpServerStatus[]> { return this.env.mcpStatus(Object.keys(this.mcpServers ?? {})); }
  async reconnectMcpServer(name: string): Promise<void> { this.env.mcpReconnect(name, Object.keys(this.mcpServers ?? {})); }
  async toggleMcpServer(name: string, enabled: boolean): Promise<void> { this.env.mcpToggle(name, enabled, Object.keys(this.mcpServers ?? {})); }
  async setModel(): Promise<void> {}
  async applyFlagSettings(): Promise<void> {}
  // stopTask: its task_notification `stopped` at once, also between turns (docs/Agent SDK.md, CON-SDK-12).
  async stopTask(taskId: string): Promise<void> {
    const tid = this.tasks.get(taskId);
    if (!tid) throw new Error(`no task ${taskId}`);
    await this.out.deliver({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: tid, status: 'stopped', summary: '', output_file: '', uuid: randomUUID(), session_id: this.sid } as unknown as SDKMessage);
  }
  // The queued messages fold into the running turn at once, in order (live runs PR-1 and PR-2).
  // f, f's call, with a step's tool use id: that step goes first, background_tasks_changed with the moved
  // tasks. b, b's call (no id) moves nothing here, so background.mjs keeps its steps in the foreground.
  async backgroundTasks(toolUseId?: string): Promise<boolean> {
    const add = toolUseId ? [...this.tasks].filter(([, tid]) => tid === toolUseId).map(([task]) => task) : [];
    if (add.length) {
      for (const task of add) this.moved.add(task);
      await this.out.deliver({ type: 'system', subtype: 'background_tasks_changed', tasks: [...this.moved].map((task_id) => ({ task_id })), uuid: randomUUID(), session_id: this.sid } as unknown as SDKMessage);
    }
    this.takeIn(this.queued.filter((q) => !this.landed(q)));
    this.queued = [];
    return true;
  }

  // Messages a running turn takes in: one queued_command attachment each, as the CLI writes them.
  private takeIn(list: { uuid: string; text: string }[]): void {
    if (list.length) this.env.append(this.sid, this.cwd, list.map((h) => ({ type: 'attachment', uuid: h.uuid, attachment: { type: 'queued_command', prompt: h.text, commandMode: 'prompt', source_uuid: h.uuid } })));
  }

  private init(): Record<string, unknown> {
    return { type: 'system', subtype: 'init', session_id: this.sid, cwd: this.cwd, capabilities: [CANCEL_QUEUED], tools: [], model: 'fixture-large' };
  }

  // Your messages: bash mode's context joins the transcript; one sent during a turn is queued; any
  // other starts a turn (its prompt record, then the script's onSend).
  private async read(prompt: AsyncIterable<SDKUserMessage>): Promise<void> {
    for await (const m of prompt) {
      if (this.out.closed) break;
      const uuid = typeof m.uuid === 'string' ? m.uuid : randomUUID();
      const text = textOf(m.message.content);
      if (m.shouldQuery === false) {
        // as the CLI does: the ones that come together go in one record, joined with a newline
        // (docs/Claude Code transcripts.md, "Bash mode records")
        if (!this.held.length) setTimeout(() => this.flushHeld(), 0);
        this.held.push({ uuid, text });
        // a process that so far took only context still says system/init, with no turn (docs/Agent SDK.md)
        if (!this.inited) { this.inited = true; await this.out.deliver({ uuid: randomUUID(), ...this.init() } as unknown as SDKMessage); }
        continue;
      }
      this.flushHeld();
      if (this.running && m.priority === 'now') { this.takeIn([{ uuid, text }]); continue; } // read in the same turn
      if (this.running) {
        this.queued.push({ uuid, text });
        continue;
      }
      this.running = true;
      this.env.append(this.sid, this.cwd, [{ type: 'user', uuid, message: { role: 'user', content: m.message.content } }]);
      if (this.title) this.env.append(this.sid, this.cwd, [{ type: 'custom-title', customTitle: this.title }]);
      this.title = '';
      const on = this.env.script.sessions[this.sid]?.onSend ?? this.env.script.onSend ?? [];
      void this.play([{ message: this.init() }, { message: { type: 'system', subtype: 'session_state_changed', state: 'running' } }, ...on], false);
    }
    this.out.close();
  }

  private flushHeld(): void {
    const held = this.held.splice(0);
    if (!held.length || this.out.closed) return;
    // taken in by a running turn: one queued_command attachment each, as the CLI writes them
    if (this.running) { this.takeIn(held); return; }
    this.env.append(this.sid, this.cwd, [{ type: 'user', uuid: held[0].uuid, queueTranscriptOnly: true, mergedSendUuids: held.slice(1).map((h) => h.uuid), promptSource: 'sdk',
      message: { role: 'user', content: held.map((h) => h.text).join('\n') } }]);
  }

  // A queued message is in the transcript: the CLI took it in, so an interrupt can't cancel it.
  private landed(q: { uuid: string; text: string }): boolean {
    return records(this.env.fileOf(this.sid, this.cwd)).some((r) => r.uuid === q.uuid
      || (r.type === 'attachment' && (r.attachment as { type?: string; prompt?: unknown })?.type === 'queued_command' && (r.attachment as { prompt?: unknown }).prompt === q.text));
  }

  private cancel(t: Turn): void {
    t.cancelled = true;
    for (const ac of t.asks) ac.abort();
    t.wake?.();
  }

  private async play(steps: Step[], atLoad: boolean): Promise<void> {
    const t: Turn = { cancelled: false, asks: [], wake: null };
    this.seqs.add(t);
    if (atLoad) this.env.busy++;
    try {
      for (const step of steps) {
        if (step.after) await new Promise<void>((r) => { const h = setTimeout(r, step.after); t.wake = () => { clearTimeout(h); r(); }; });
        t.wake = null;
        if (t.cancelled || this.out.closed) return;
        const { answer } = await this.env.atomically(step.ago ?? 0, () => this.step(step, t));
        if (answer) {
          if (atLoad) this.env.idleOne();
          await answer;
          if (atLoad) this.env.busy++;
        }
      }
    } finally {
      this.seqs.delete(t);
      if (atLoad) this.env.idleOne();
    }
  }

  // One step, with the clock moved: returns the answer to wait for, for an ask.
  private async step(step: Step, t: Turn): Promise<{ answer: Promise<unknown> | null }> {
    if (t.cancelled || this.out.closed) return { answer: null };
    if (step.append) this.env.append(this.sid, this.cwd, step.append);
    if (step.send !== undefined) this.env.send(this.sid, step.send);
    if (step.retry) {
      const r = step.retry;
      this.env.append(this.sid, this.cwd, [{
        type: 'system', subtype: 'api_error', level: 'error', source: 'request_retry', isSidechain: false, uuid: randomUUID(),
        error: { message: r.text, formatted: r.text, ...(r.status === null ? {} : { status: r.status }), ...(r.credential ? { isCloudCredentialError: true } : {}) },
        retryInMs: r.delayMs, retryAttempt: r.attempt, maxRetries: r.max,
      }]);
      await this.out.deliver({ type: 'system', subtype: 'api_retry', attempt: r.attempt, max_retries: r.max, retry_delay_ms: r.delayMs, error_status: r.status, error: r.error, uuid: randomUUID(), session_id: this.sid } as unknown as SDKMessage);
    }
    if (step.message) {
      const m = { uuid: randomUUID(), session_id: this.sid, ...step.message };
      if (m.type === 'system' && m.subtype === 'init') this.inited = true;
      if (m.type === 'system' && m.subtype === 'session_state_changed') this.running = m.state !== 'idle';
      if (m.type === 'stream_event') this.wrote(m.event as { type?: string; message?: { id?: string }; delta?: { type?: string; text?: string } });
      if (m.type === 'result') this.writing = null;
      if (m.type === 'result') this.queued = this.queued.filter((q) => !this.landed(q));
      if (m.type === 'system' && m.subtype === 'task_started' && typeof m.task_id === 'string' && typeof m.tool_use_id === 'string') this.tasks.set(m.task_id, m.tool_use_id);
      await this.out.deliver(m as unknown as SDKMessage);
    }
    if (step.ask) {
      const { tool, input, id, toolUseId, agentId, suggestions, ...rest } = step.ask;
      const ac = new AbortController();
      t.asks.push(ac);
      const tu = toolUseId ?? `toolu_${randomUUID().slice(0, 8)}`;
      return { answer: this.canUseTool(tool, input, {
        ...rest, signal: ac.signal, toolUseID: tu, requestId: id ?? tu, agentID: agentId, suggestions: (suggestions ?? []) as never,
      } as Parameters<CanUseTool>[2]).catch(() => null) };
    }
    if (step.call) return { answer: this.call(step.call, t) };
    return { answer: null };
  }

  // What a stream_event step writes: the message's id and its text so far.
  private wrote(ev: { type?: string; message?: { id?: string }; delta?: { type?: string; text?: string } }): void {
    if (ev.type === 'message_start') this.writing = { id: ev.message?.id ?? '', text: '' };
    else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && this.writing) this.writing.text += ev.delta.text ?? '';
  }

  // A tool call of Synopia's own as the CLI makes it (live run TL-1): always asks; on allow the tool
  // runs and its result is a text block, a refusal or a denial is a string with is_error.
  private async call(c: NonNullable<Step['call']>, t: Turn): Promise<void> {
    const tu = c.toolUseId ?? `toolu_${randomUUID().slice(0, 8)}`;
    this.env.append(this.sid, this.cwd, [{ type: 'assistant', message: { role: 'assistant', id: `msg_${randomUUID().slice(0, 8)}`, content: [{ type: 'tool_use', id: tu, name: c.tool, input: c.input }] } }]);
    const ac = new AbortController();
    t.asks.push(ac);
    const r = await this.canUseTool(c.tool, c.input, { signal: ac.signal, toolUseID: tu, requestId: tu, suggestions: [] } as unknown as Parameters<CanUseTool>[2]).catch(() => null);
    let content: unknown;
    let isError = false;
    if (!r || r.behavior !== 'allow') { content = r?.message || 'Interrupted by the user'; isError = true; }
    else {
      const res = await (callServed(this.mcpServers, c.tool, (r.updatedInput ?? c.input) as Record<string, unknown>) ?? Promise.resolve({ content: [{ type: 'text' as const, text: `No such tool: ${c.tool}` }], isError: true }));
      isError = res.isError === true;
      content = isError ? res.content.map((b) => b.text).join('\n') : res.content;
    }
    if (t.cancelled || this.out.closed) return;
    this.env.append(this.sid, this.cwd, [{ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu, content, ...(isError ? { is_error: true } : {}) }] }, toolUseResult: content }]);
  }
}

// The menu probe's query: no messages until its prompt ends, the menu calls from the script.
function probe(env: Scripted, prompt: AsyncIterable<SDKUserMessage>): QueryLike {
  return {
    async *[Symbol.asyncIterator]() { for await (const _ of prompt) { /* never yields */ } },
    supportedCommands: async () => [...(env.script.menu?.commands ?? [])],
    supportedModels: async () => [...(env.script.menu?.models ?? [])],
    mcpServerStatus: async () => env.mcpStatus([]),
    reconnectMcpServer: async (name: string) => env.mcpReconnect(name, []),
    toggleMcpServer: async (name: string, enabled: boolean) => env.mcpToggle(name, enabled, []),
  };
}

// The writer's one-shot call: the script's reply, else a failed result.
function writer(env: Scripted): QueryLike {
  const w = env.script.writer;
  return {
    async *[Symbol.asyncIterator]() {
      yield (w
        ? { type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(w), session_id: '', uuid: randomUUID() }
        : { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: '', uuid: randomUUID() }) as unknown as SDKMessage;
    },
  };
}

// ---------- the whole ----------

// What the scripted sessions need from Sessions (main.ts passes it once Sessions has started): an
// open session by id, to start its process or to send it a message.
export type ScriptTarget = { get(sid: string): { startIdle(): boolean; send(text: string): unknown } | undefined };

export class Scripted {
  readonly script: Script;
  readonly clock = new ScriptClock();
  readonly sdk: Sdk;
  readonly probe: Probe;
  readonly end: EndDeps;
  readonly played = new Set<string>(); // sessions whose steps have started
  busy = 0; // load-time sequences still playing (not waiting on an answer)
  private claudeDir: string;
  private log: Log;
  private target: ScriptTarget | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private gone = new Set<number>(); // pretend CLIs a take-over ended
  private settled: (() => void)[] = [];
  private files = new Map<string, string>();
  private mcp = new Map<string, { status: McpServerStatus['status']; at: number }>(); // by name, across queries
  private mcpAuth = new Map<string, boolean>(); // signed in: a reconnect connects
  private mcpOff = new Set<string>();

  constructor(opts: { file: string | null; claudeDir: string; log?: Log }) {
    this.script = loadScript(opts.file);
    this.claudeDir = opts.claudeDir;
    this.log = opts.log ?? nullLog;
    const query: QueryFn = (params) => {
      const o = params.options ?? {};
      if (o.persistSession === false) return writer(this);
      if (!o.canUseTool) return probe(this, params.prompt);
      return new ScriptedSession(this, o, params.prompt);
    };
    const listSessions: ListFn = async () => fixtureSessions(this.claudeDir).map((s) => sessionInfo(s.id, s.path));
    this.sdk = { query, listSessions };
    const pidFile = (pid: number) => path.join(this.claudeDir, 'sessions', `${pid}.json`);
    this.probe = {
      alive: (pid) => !this.gone.has(pid) && fs.existsSync(pidFile(pid)),
      startOf: async (pid) => {
        if (this.gone.has(pid)) return '';
        try { return String(JSON.parse(fs.readFileSync(pidFile(pid), 'utf8')).procStart ?? ''); } catch { return ''; }
      },
      parentOf: async () => 1,
    };
    this.end = {
      kill: (pid, signal) => { this.log('scripted.kill', { pid, signal }); this.gone.add(pid); },
      alive: (pid) => this.probe.alive(pid),
      ttyOf: async () => '??',
      write: () => {},
      stat: (file) => { try { const s = fs.statSync(file); return `${s.size}:${s.mtimeMs}`; } catch { return ''; } },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: Date.now,
    };
  }

  // ---------- MCP ----------

  private mcpScript(name: string): McpScript | undefined {
    return this.script.mcp?.servers.find((x) => x.name === name);
  }

  private mcpNow(m: McpScript): McpServerStatus['status'] {
    if (!this.mcp.has(m.name)) {
      // a disabled server is what it would be once enabled, behind the switch
      const under = m.status !== 'disabled' ? m.status : (m.kind ?? 'http') === 'stdio' ? 'connected' : 'needs-auth';
      this.mcp.set(m.name, { status: under, at: Date.now() });
      this.mcpAuth.set(m.name, under === 'connected');
      if (m.status === 'disabled') this.mcpOff.add(m.name);
    }
    const st = this.mcp.get(m.name)!;
    if (st.status === 'pending' && Date.now() - st.at >= (this.script.mcp?.pendingMs ?? 1200)) st.status = 'connected';
    return this.mcpOff.has(m.name) ? 'disabled' : st.status;
  }

  mcpStatus(own: string[]): McpServerStatus[] {
    const out: McpServerStatus[] = (this.script.mcp?.servers ?? []).map((m) => {
      const kind = m.kind ?? 'http';
      const config = kind === 'stdio' ? { command: '/usr/bin/true' } : { type: kind, url: `https://${m.name}.example.test/mcp` };
      return { name: m.name, status: this.mcpNow(m), scope: m.scope ?? 'user', source: m.scope ?? 'user', config } as McpServerStatus;
    });
    for (const name of own) out.push({ name, status: this.mcpOff.has(name) ? 'disabled' : 'connected', scope: 'dynamic', source: 'sdk' } as McpServerStatus);
    return out;
  }

  mcpReconnect(name: string, own: string[]): void {
    const m = this.mcpScript(name);
    if (!m && !own.includes(name)) throw new Error(`Server not found: ${name}`);
    if (!m) throw new Error('SDK servers should be handled in print.ts');
    if (this.mcpOff.has(name)) throw new Error(`MCP server ${name} is disabled — enable it (mcp_toggle) before reconnecting`);
    this.mcpNow(m);
    const remote = (m.kind ?? 'http') !== 'stdio';
    this.mcp.set(name, { status: !remote || this.mcpAuth.get(name) ? 'connected' : 'needs-auth', at: Date.now() });
  }

  mcpToggle(name: string, enabled: boolean, own: string[]): void {
    const m = this.mcpScript(name);
    if (!m && !own.includes(name)) throw new Error(`Server not found: ${name}`);
    if (m) this.mcpNow(m);
    if (enabled) this.mcpOff.delete(name); else this.mcpOff.add(name);
  }

  // A pretend `claude mcp login|logout <name>`: no CLI, no browser. A login asked with no pty fails as
  // the CLI's does (MC-2); Cancel (the abort) ends it with no code.
  readonly mcpRunner: McpRunner = async (args, o) => {
    const [, verb, name] = args;
    if (verb === 'login' && !o.pty) return { code: 1, stdout: '', stderr: `Couldn't complete authentication for "${name}": this isn't an interactive terminal.\n` };
    const m = this.mcpScript(name);
    this.log('scripted.mcp', { verb });
    if (!m) return { code: 1, stdout: '', stderr: `No MCP server named "${name}". Run \`claude mcp add\` to add one.\n` };
    if (verb === 'login') {
      const ms = this.script.mcp?.loginMs ?? 1500;
      const ended = await new Promise<boolean>((r) => { const t = setTimeout(() => r(true), Math.min(ms, o.timeoutMs)); o.signal.addEventListener('abort', () => { clearTimeout(t); r(false); }, { once: true }); });
      if (!ended) return { code: null, stdout: '', stderr: '' };
      if (ms > o.timeoutMs) return { code: null, stdout: '', stderr: '', timedOut: true };
      if (this.script.mcp?.failLogin?.includes(name)) return { code: 1, stdout: '', stderr: 'Authentication failed: the authorization server refused the request.\n' };
      this.mcpNow(m);
      this.mcpAuth.set(name, true);
      return { code: 0, stdout: `Authentication successful. Connected to ${name}.\n`, stderr: '' };
    }
    if (verb === 'logout') { this.mcpNow(m); this.mcpAuth.set(name, false); return { code: 0, stdout: `Cleared OAuth credentials for ${name}.\n`, stderr: '' }; }
    return { code: 1, stdout: '', stderr: 'unknown command\n' };
  };

  // The script's home is made up (/Users/fixture): its folders count as there, as its terminals are
  // pretend, so a fixture session isn't "Folder gone" (R3.11). Real folders elsewhere are checked.
  readonly pretendFolder = (abs: string): boolean => {
    const h = this.script.home;
    return Boolean(h) && (abs === h || abs.startsWith(`${h}/`));
  };

  get home(): string | undefined {
    return this.script.home;
  }

  // Sessions has started: the scripted sessions' processes start.
  attach(target: ScriptTarget): void {
    this.target = target;
    let n = 0;
    for (const [sid, s] of Object.entries(this.script.sessions)) if (s.start && target.get(sid)?.startIdle()) n++;
    this.log('scripted.start', { sessions: Object.keys(this.script.sessions).length, started: n });
  }

  // Resolves once the steps playing since attach have run, or wait on an answer.
  whenPlayed(): Promise<void> {
    if (this.busy === 0) return Promise.resolve();
    return new Promise((r) => this.settled.push(r));
  }

  idleOne(): void {
    if (--this.busy > 0) return;
    for (const r of this.settled.splice(0)) r();
  }

  // One step at a time, across sessions, with the clock moved for it.
  atomically<T>(ago: number, fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(async () => {
      this.clock.offset = -ago;
      try {
        return await fn();
      } finally {
        this.clock.offset = 0;
      }
    });
    this.lock = run.catch(() => {});
    return run;
  }

  send(sid: string, text: string): void {
    this.target?.get(sid)?.send(text);
  }

  // The session's transcript: the fixture's, or a new one in the CLI's folder for its cwd.
  fileOf(sid: string, cwd: string): string {
    const known = this.files.get(sid) ?? fixtureSessions(this.claudeDir).find((s) => s.id === sid)?.path;
    if (known) { this.files.set(sid, known); return known; }
    const f = path.join(this.claudeDir, 'projects', (cwd || '/tmp').replace(/[^A-Za-z0-9]/g, '-'), `${sid}.jsonl`);
    this.files.set(sid, f);
    return f;
  }

  // A fork's file: every record of the old session, with the new id and folder.
  fork(from: string, to: string, cwd: string): void {
    const recs = records(this.fileOf(from, '')).map((r) => ({ ...r, sessionId: to, ...('cwd' in r ? { cwd } : {}) }));
    const file = this.fileOf(to, cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, recs.map((r) => JSON.stringify(r) + '\n').join(''));
  }

  append(sid: string, cwd: string, recs: Record<string, unknown>[]): void {
    const file = this.fileOf(sid, cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const at = new Date(this.clock.now()).toISOString();
    fs.appendFileSync(file, recs.map((r) => JSON.stringify({ timestamp: at, sessionId: sid, ...(cwd ? { cwd } : {}), uuid: randomUUID(), ...r }) + '\n').join(''));
  }
}

// What listSessions() says of a transcript.
function sessionInfo(id: string, file: string): SDKSessionInfo {
  const recs = records(file);
  const first = recs.find((r) => r.type === 'user' && !r.isMeta && !r.isSidechain && textOf((r.message as { content?: unknown })?.content).trim());
  const custom = recs.filter((r) => r.type === 'custom-title').pop()?.customTitle;
  const ai = recs.filter((r) => r.type === 'ai-title').pop()?.aiTitle;
  const st = fs.statSync(file);
  return {
    sessionId: id,
    summary: typeof ai === 'string' ? ai : '',
    lastModified: st.mtimeMs,
    fileSize: st.size,
    ...(typeof custom === 'string' ? { customTitle: custom } : {}),
    ...(first ? { firstPrompt: textOf((first.message as { content?: unknown }).content) } : {}),
    ...(typeof recs.find((r) => typeof r.cwd === 'string')?.cwd === 'string' ? { cwd: recs.find((r) => typeof r.cwd === 'string')!.cwd as string } : {}),
  };
}

// main.ts's entry: the script for this run, with a fresh state folder seeded.
export function openScripted(opts: { file: string | null; claudeDir: string; stateDir: string; log?: Log }): Scripted {
  const s = new Scripted(opts);
  if (seedState(opts.stateDir, opts.claudeDir, s.script)) opts.log?.('scripted.seeded', {});
  return s;
}
