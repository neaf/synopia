// Sessions (plan section 6): the open list in state.json, new sessions, sending, and the ids
// the page holds. A new session is a placeholder (`new-…`) until system/init gives its real id;
// a conversation_reset moves a session to a new id. Both swaps keep an alias, so a late `send`
// or `view` with an old id reaches the session. A session without a running process resumes
// on its next message. Statuses come from status.ts and are stored with their age.
// The Open list comes from the SDK's listSessions(); opening a past session adds it to the open
// list, and it resumes on its first message.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { listSessions as sdkListSessions } from '@anthropic-ai/claude-agent-sdk';
import type { ListSessionsOptions, SDKSessionInfo, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { SessionProcess } from './driver.ts';
import type { Content, InterruptResult, QueryFn, StartOptions } from './driver.ts';
import { SessionStatus, restored } from './status.ts';
import type { StatusEntry } from './status.ts';
import { NeedsYou } from './pending.ts';
import type { CardAnswer } from './answers.ts';
import type { Views } from './views.ts';
import type { Store, Layout } from './store.ts';
import type { Log } from './log.ts';
import { nullLog } from './log.ts';

export const IDLE_MS = 30 * 60 * 1000;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_TYPES = ['image/png', 'image/jpeg'];
const STREAM_MS = 50; // at most one stream preview per this many ms and session
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const RECENT = 50;
export type ListFn = (opts?: ListSessionsOptions) => Promise<SDKSessionInfo[]>;
export type Recent = { id: string; title: string; cwd: string; lastModified: number };
export type Image = { mediaType: string; data: string };
export type SendResult = { ok: true; sid: string } | { ok: false; error: string };

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

type Active = {
  id: string;
  cwd: string; // absolute
  placeholder: boolean;
  proc: SessionProcess | null;
  status: SessionStatus;
  needs: NeedsYou; // slice 3: parked canUseTool requests and the messages held behind them
  stream: StreamPreview;
  streamTimer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
  choice: ModelChoice | null; // slice 5: a placeholder's model and effort, stored once it has its id
};

// Slice 5: the model and effort you chose for a session (state.json `models`). `default` is the
// CLI's default model; an effort of null or missing is the model's default effort.
export type ModelChoice = { model: string; effort?: string | null };

export type SessionsOptions = {
  store: Store;
  views: Views;
  log?: Log;
  queryFn?: QueryFn; // tests inject a fake; the default is the SDK's query
  listFn?: ListFn; // the same for listSessions
  home?: string;
  now?: () => number;
  idleMs?: number;
  // Slice 6 (the writer): a session's turn ended, and a stored session was opened.
  onTurnEnded?: (sid: string) => void;
  onOpened?: (sid: string) => void;
  // Slice 5: a running process pushed a new command list (commands_changed).
  onCommands?: (sid: string, commands: SlashCommand[]) => void;
};

export class Sessions {
  private store: Store;
  private views: Views;
  private log: Log;
  private opts: SessionsOptions;
  private home: string;
  private now: () => number;
  private live = new Map<string, Active>();
  private aliases = new Map<string, string>();
  private recent = new Map<string, Recent>(); // the last Open list, for openSession's folder

  constructor(opts: SessionsOptions) {
    this.opts = opts;
    this.store = opts.store;
    this.views = opts.views;
    this.log = opts.log ?? nullLog;
    this.home = opts.home ?? os.homedir();
    this.now = opts.now ?? Date.now;
  }

  // Opens every session of the open list that isn't closed. None has a process yet.
  start(): void {
    for (const e of this.store.state.open) {
      if (e.closedAt !== null || this.live.has(e.id)) continue;
      this.add(e.id, e.cwd, false, restored(this.store.state.status[e.id]));
    }
  }

  // The current id for an id the page may still hold.
  resolve(id: string): string {
    let cur = id;
    for (let i = 0; i < 16 && this.aliases.has(cur); i++) cur = this.aliases.get(cur) as string;
    return cur;
  }

  has(id: string): boolean {
    return this.live.has(this.resolve(id));
  }

  // The sessions with a running turn, for the quit check.
  running(): string[] {
    return [...this.live.values()].filter((a) => a.proc && a.status.working).map((a) => a.id);
  }

  // An empty session in settings.newSessionCwd. It isn't stored until system/init gives its id.
  newSession(): string {
    const id = `new-${randomUUID()}`;
    this.add(id, this.expand(this.store.state.settings.newSessionCwd), true, null);
    this.log('sessions.new', { sid: id });
    return id;
  }

  // The Open list: past sessions from listSessions(), newest first, without the open ones,
  // matching the filter on title or folder, at most RECENT. A session without a folder can't
  // resume, so it isn't listed.
  async listRecent(filter = ''): Promise<Recent[]> {
    const q = filter.trim().toLowerCase();
    const all = await (this.opts.listFn ?? sdkListSessions)();
    const out: Recent[] = [];
    for (const s of [...all].sort((x, y) => y.lastModified - x.lastModified)) {
      if (!s.cwd || this.has(s.sessionId)) continue;
      // A session Synopia closed keeps the title Claude wrote for it (section 10's order), so the
      // Open list names it as the sidebar did.
      const written = this.store.state.written[s.sessionId]?.title;
      const title = (!s.customTitle?.trim() && written?.trim()) || titleOf(s);
      if (q && !title.toLowerCase().includes(q) && !s.cwd.toLowerCase().includes(q)) continue;
      out.push({ id: s.sessionId, title, cwd: s.cwd, lastModified: s.lastModified });
      if (out.length === RECENT) break;
    }
    for (const r of out) this.recent.set(r.id, r);
    return out.map((r) => ({ ...r, cwd: this.tilde(r.cwd) }));
  }

  // Adds a past session to the open list (or reopens a closed one, which keeps its place in the
  // layout). Its transcript shows at once; it resumes on its first message.
  async openSession(id: string): Promise<SendResult> {
    if (this.has(id)) return { ok: true, sid: this.resolve(id) };
    if (!UUID.test(id)) return { ok: false, error: "That isn't a session id." };
    if (!this.recent.has(id)) await this.listRecent();
    const r = this.recent.get(id);
    if (!r) return { ok: false, error: 'That session is no longer in the Open list.' };
    if (this.has(id)) return { ok: true, sid: this.resolve(id) };
    const st = this.store.state;
    const e = st.open.find((x) => x.id === id);
    if (e) {
      e.closedAt = null;
      e.cwd = r.cwd;
    } else {
      st.open.push({ id, cwd: r.cwd, openedAt: this.now(), closedAt: null });
    }
    st.layout = renameInLayout(st.layout, id, id, true);
    this.store.changed();
    this.add(id, r.cwd, false, restored(st.status[id]) ?? { status: 'idle', at: r.lastModified });
    this.log('sessions.open', { sid: id, reopened: Boolean(e) });
    return { ok: true, sid: id };
  }

  send(sid: string, text: string, images: Image[] = [], uuid?: string): SendResult {
    const a = this.live.get(this.resolve(sid));
    if (!a) return { ok: false, error: "That session isn't open any more." };
    for (const im of images) {
      if (!IMAGE_TYPES.includes(im.mediaType)) return { ok: false, error: 'Only PNG and JPEG images can be sent.' };
      if (Buffer.byteLength(im.data, 'base64') > MAX_IMAGE_BYTES) return { ok: false, error: 'An image is over 5 MB. Send a smaller one.' };
    }
    if (!text.trim() && !images.length) return { ok: false, error: 'Nothing to send.' };
    if (!a.proc && !this.startProcess(a)) return { ok: false, error: `Folder ${this.tilde(a.cwd)} no longer exists` };
    const content: Content = images.length
      ? [
        ...images.map((im) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: im.mediaType as 'image/png', data: im.data } })),
        ...(text.trim() ? [{ type: 'text' as const, text }] : []),
      ]
      : text;
    const id = uuid && UUID.test(uuid) ? uuid : randomUUID();
    if (a.needs.size) { // queued behind the card (plan section 6), pushed once it is answered
      a.needs.hold({ content, uuid: id, text });
      this.log('sessions.held', { sid: a.id, images: images.length });
      return { ok: true, sid: a.id };
    }
    (a.proc as SessionProcess).push(content, id);
    this.clearIdle(a);
    a.status.turnStarted();
    this.log('sessions.send', { sid: a.id, images: images.length });
    return { ok: true, sid: a.id };
  }

  // Close (R3.6): marks it closed and ends its process now, background work included (the page
  // asked first when something ran). It stays in its layout group, hidden; the Open list lists it
  // again, and reopening it puts it back there. A placeholder is simply dropped.
  close(sid: string): SendResult {
    const id = this.resolve(sid);
    const a = this.live.get(id);
    if (!a) return { ok: false, error: "That session isn't open any more." };
    this.clearIdle(a);
    if (a.streamTimer) clearTimeout(a.streamTimer);
    const proc = a.proc;
    a.proc = null; // its exit is no failure
    a.needs.abortAll();
    proc?.close();
    if (proc) this.ended(a);
    this.live.delete(id);
    const e = this.store.state.open.find((x) => x.id === id);
    if (e) {
      e.closedAt = this.now();
      this.store.changed();
    }
    this.views.close(id);
    this.log('sessions.close', { sid: id, running: Boolean(proc && !proc.done) });
    return { ok: true, sid: id };
  }

  // For the shell's quit check: the sessions with a running turn and the background work
  // (subagents, shells, monitors) that lives in a running process.
  quitCheck(): { running: string[]; background: { sid: string; kind: string }[] } {
    const background: { sid: string; kind: string }[] = [];
    for (const a of this.live.values()) {
      if (!a.proc) continue;
      for (const kind of this.views.facts(a.id)?.runningWork ?? []) background.push({ sid: a.id, kind });
    }
    return { running: this.running(), background };
  }

  // Esc, Esc: stops the foreground turn; background work keeps running (perTaskStopAffordance).
  // Messages the interrupt cancelled go back to the message box through `restore`. A CLI
  // without the cancel capability runs them afterwards, and the toast says so.
  async interrupt(sid: string): Promise<void> {
    const a = this.live.get(this.resolve(sid));
    if (!a?.proc || !a.status.working) return;
    a.status.interrupted();
    let r: InterruptResult;
    try {
      r = await a.proc.interrupt();
    } catch (e) {
      this.log('driver.interruptFailed', { sid: a.id });
      this.views.toast(`Synopia couldn't interrupt Claude: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      return;
    }
    this.log('driver.interrupt', { sid: a.id, cancelQueued: r.cancelQueued, restored: r.restored.length, stillQueued: r.stillQueued });
    this.endNeeds(a);
    if (r.restored.length) this.views.restore(a.id, r.restored);
    if (r.stillQueued) {
      const n = r.stillQueued;
      this.views.toast(`Interrupted. ${n === 1 ? 'Your queued message' : `${n} queued messages`} will still run: this Claude Code can't cancel ${n === 1 ? 'it' : 'them'}.`);
    }
  }

  // Slice 5: the folder (absolute) and the running process's menu, for menu.ts.
  cwdOf(sid: string): string | undefined {
    return this.live.get(this.resolve(sid))?.cwd;
  }

  menuSource(sid: string): ReturnType<SessionProcess['menuSource']> {
    return this.live.get(this.resolve(sid))?.proc?.menuSource() ?? null;
  }

  // The model and effort chosen for a session, or undefined when you never chose one.
  choiceOf(sid: string): ModelChoice | undefined {
    const id = this.resolve(sid);
    return this.store.state.models[id] ?? this.live.get(id)?.choice ?? undefined;
  }

  // Slice 5: the model picker. Stored per session and passed at the next start; a running
  // process gets setModel (when the model changed) and applyFlagSettings for the effort.
  async setModel(sid: string, model: string, effort: string | null): Promise<SendResult> {
    const a = this.live.get(this.resolve(sid));
    if (!a) return { ok: false, error: "That session isn't open any more." };
    if (!model) return { ok: false, error: 'No model was chosen.' };
    const before = this.choiceOf(a.id);
    const was = before ? before.model : this.views.facts(a.id)?.model ?? null;
    const wasEffort = before ? before.effort ?? null : this.views.facts(a.id)?.effort ?? null;
    const choice: ModelChoice = { model, effort: effort || null };
    if (a.placeholder) a.choice = choice;
    else {
      this.store.state.models[a.id] = choice;
      this.store.changed();
    }
    this.views.refresh(a.id);
    this.log('sessions.setModel', { sid: a.id, model, effort: choice.effort ?? null, running: Boolean(a.proc) });
    const proc = a.proc;
    if (!proc || proc.done) return { ok: true, sid: a.id };
    try {
      if (model !== was) await proc.setModel(model === 'default' ? undefined : model);
      if ((choice.effort ?? null) !== wasEffort || model !== was) await proc.setEffort(choice.effort ?? null);
    } catch (e) {
      this.log('driver.setModelFailed', { sid: a.id });
      return { ok: false, error: `Synopia stored the model, but Claude didn't take it now: ${String((e as Error)?.message ?? e).slice(0, 200)}. It applies when the session starts again.` };
    }
    return { ok: true, sid: a.id };
  }

  // Slice 4: the Stop row. Background work lives inside the session's process, so with no
  // process there is nothing left to stop.
  async stopTask(sid: string, taskId: string): Promise<SendResult> {
    const a = this.live.get(this.resolve(sid));
    if (!a) return { ok: false, error: "That session isn't open any more." };
    if (!a.proc) return { ok: false, error: 'Nothing to stop: it ended with its session’s process.' };
    try {
      await a.proc.stopTask(taskId);
    } catch {
      return { ok: false, error: 'Synopia could not stop it. It may have finished already.' };
    }
    this.log('sessions.stopTask', { sid: a.id, taskId });
    return { ok: true, sid: a.id };
  }

  // Slice 3: a card's answer settles its canUseTool request. Session rules from "Always allow"
  // are stored and passed back as allowedTools on resume; the labels the JSONL won't show
  // ("Allow once", "Denied: …") are kept per tool-use id for the transcript. Messages held
  // behind the last card go out after it.
  answer(sid: string, requestId: string, answer: CardAnswer): SendResult {
    const a = this.live.get(this.resolve(sid));
    if (!a) return { ok: false, error: "That session isn't open any more." };
    const r = a.needs.answer(requestId, answer);
    if ('error' in r) return { ok: false, error: r.error };
    const st = this.store.state;
    if (r.rules.length) st.rules[a.id] = [...new Set([...(st.rules[a.id] ?? []), ...r.rules])];
    if (r.label) st.answers[r.toolUseId] = r.label;
    if (r.plan) st.plans[r.toolUseId] = r.plan; // the plan you answered, as the card showed it
    if (r.rules.length || r.label || r.plan) this.store.changed();
    this.log('sessions.answer', { sid: a.id, behavior: r.result.behavior, rules: r.rules.length });
    if (!a.needs.size && a.proc) for (const h of a.needs.takeHeld()) a.proc.push(h.content as Content, h.uuid);
    return { ok: true, sid: a.id };
  }

  // The turn ended with requests or held messages left (an interrupt, the process ending): the
  // requests end and the held messages go back to the message box.
  private endNeeds(a: Active): void {
    a.needs.abortAll();
    const texts = a.needs.takeHeld().map((h) => h.text).filter((t) => t.trim());
    if (texts.length) this.views.restore(a.id, texts);
  }

  // Quit: every process ends now.
  stop(): void {
    for (const a of this.live.values()) {
      this.clearIdle(a);
      if (a.streamTimer) clearTimeout(a.streamTimer);
      if (a.proc) {
        a.proc.close();
        this.ended(a);
      }
    }
    this.store.flush();
  }

  // From the transcripts service: an assistant record of a main conversation landed.
  landed(sid: string, messageId: string, types: string[]): void {
    const a = this.live.get(sid);
    if (a && a.stream.land(messageId, types)) this.pushStream(a, true);
  }

  private add(id: string, cwd: string, placeholder: boolean, init: StatusEntry | null): Active {
    const a: Active = {
      id, cwd, placeholder, proc: null, stream: new StreamPreview(), streamTimer: null, idleTimer: null, choice: null,
      status: new SessionStatus(init, (e) => this.statusChanged(a, e), this.now),
      needs: new NeedsYou({
        show: (r) => this.views.setPending(a.id, r),
        clear: (rid) => this.views.clearPending(a.id, rid),
        count: (n) => a.status.setPending(n),
        held: (texts) => this.views.setHeld(a.id, texts),
        context: () => ({ cwd: this.tilde(a.cwd), modeBefore: this.views.facts(a.id)?.modeBeforePlan || 'auto' }),
        now: this.now,
      }),
    };
    this.live.set(id, a);
    this.views.open(id, { cwd });
    this.views.setStatus(id, a.status.status, a.status.at);
    const ended = this.store.state.ended[id];
    if (ended) this.views.processEnded(id, ended, this.store.state.endedFailed[id] === true);
    if (!placeholder) this.opts.onOpened?.(id);
    return a;
  }

  // Slice 5: the process ended (close, idle end, quit, failure): what ran inside it stopped. Stored,
  // so the transcript reads the same after a restart or a reopen. `failed`: the process failed, so
  // a tool it left without a result reads as failed, not stopped.
  private ended(a: Active, failed = false): void {
    const at = this.now();
    if (!a.placeholder) {
      const st = this.store.state;
      st.ended[a.id] = at;
      if (failed) st.endedFailed[a.id] = true;
      else delete st.endedFailed[a.id];
      this.store.changed();
    }
    this.views.processEnded(a.id, at, failed);
  }

  private statusChanged(a: Active, e: StatusEntry): void {
    this.views.setStatus(a.id, e.status, e.at);
    if (!a.placeholder) {
      this.store.state.status[a.id] = { status: e.status, at: e.at };
      this.store.changed();
    }
    if (e.status === 'busy' || e.status === 'waiting') this.clearIdle(a);
    else this.armIdle(a);
  }

  private startOptions(a: Active): StartOptions {
    const st = this.store.state;
    const facts = this.views.facts(a.id);
    // Your choice wins whole (`default` is the CLI's default model); else what the session last used.
    const chosen = st.models[a.id] ?? a.choice;
    return {
      cwd: a.cwd,
      resume: a.placeholder ? undefined : a.id,
      model: chosen ? (chosen.model === 'default' ? undefined : chosen.model) : facts?.model || st.settings.model || undefined,
      effort: chosen ? chosen.effort || undefined : facts?.effort || undefined,
      plan: facts?.permissionMode === 'plan',
      allowedTools: st.rules[a.id],
    };
  }

  private startProcess(a: Active): boolean {
    if (!isDir(a.cwd)) {
      a.status.failed();
      this.log('driver.noFolder', { sid: a.id });
      return false;
    }
    const start = this.startOptions(a);
    const proc: SessionProcess = new SessionProcess(start, {
      onMessage: (m) => { if (a.proc === proc) this.onMessage(a, m as Msg); },
      onExit: (error, ended) => this.onExit(a, proc, error, ended),
      canUseTool: (name, input, o) => {
        this.log('driver.ask', { sid: a.id, tool: name, agent: Boolean(o.agentID) });
        return a.needs.park(name, input, o);
      },
    }, this.opts.queryFn);
    a.proc = proc;
    this.log('driver.start', { sid: a.id, resume: Boolean(start.resume), model: start.model ?? null, plan: Boolean(start.plan) });
    return true;
  }

  private onExit(a: Active, proc: SessionProcess, error: Error | null, ended: boolean): void {
    if (a.proc !== proc) return;
    a.proc = null;
    this.clearIdle(a);
    this.setStreamClear(a);
    const failed = !ended;
    this.log('driver.exit', { sid: a.id, ended, error: Boolean(error) });
    this.ended(a, failed);
    this.endNeeds(a);
    a.status.processEnded(failed);
    if (failed) {
      const tail = proc.stderrTail();
      const why = tail.length ? tail[tail.length - 1] : error?.message || 'it exited';
      this.views.toast(`Claude stopped unexpectedly: ${why.slice(0, 300)}`);
    }
  }

  private onMessage(a: Active, m: Msg): void {
    if (m.type === 'system' && m.subtype === 'init') {
      if (typeof m.session_id === 'string' && m.session_id && m.session_id !== a.id) this.swap(a, m.session_id, a.placeholder ? 'init' : 'moved');
      a.status.turnStarted();
    } else if (m.type === 'system' && m.subtype === 'session_state_changed') {
      a.status.stateChanged(String(m.state));
    } else if (m.type === 'system' && m.subtype === 'status' && typeof m.permissionMode === 'string') {
      this.log('driver.mode', { sid: a.id, mode: m.permissionMode }); // after a plan approval (S3-1: back to auto), or a model switch
    } else if (m.type === 'system' && m.subtype === 'task_notification' && typeof m.tool_use_id === 'string') {
      // A task ended (stopTask emits one with status `stopped`). The CLI writes its notification to
      // the JSONL only when a turn runs, so between turns this is the only sign that it ended.
      this.log('driver.task', { sid: a.id, status: String(m.status) });
      this.views.taskEnded(a.id, m.tool_use_id, String(m.status), typeof m.summary === 'string' ? m.summary : '');
    } else if (m.type === 'system' && m.subtype === 'commands_changed' && Array.isArray(m.commands)) {
      this.opts.onCommands?.(a.id, m.commands as SlashCommand[]);
    } else if (m.type === 'conversation_reset' && typeof m.new_conversation_id === 'string') {
      this.setStreamClear(a);
      this.swap(a, m.new_conversation_id, 'reset');
    } else if (m.type === 'stream_event') {
      if (a.stream.event(m as { event: unknown; parent_tool_use_id: string | null })) this.pushStream(a, false);
    } else if (m.type === 'result') {
      this.setStreamClear(a);
      a.status.result({ subtype: String(m.subtype), is_error: m.is_error === true, terminal_reason: typeof m.terminal_reason === 'string' ? m.terminal_reason : undefined });
      this.opts.onTurnEnded?.(a.id);
    }
  }

  // The session's id changed: the open list, the layout, the models, the rules and the status
  // move with it; a reset also drops the written title and Now line.
  private swap(a: Active, newId: string, why: 'init' | 'reset' | 'moved'): void {
    const old = a.id;
    if (this.live.has(newId)) return;
    const st = this.store.state;
    this.aliases.set(old, newId);
    this.live.delete(old);
    a.id = newId;
    this.live.set(newId, a);
    if (a.placeholder) {
      a.placeholder = false;
      st.open.push({ id: newId, cwd: a.cwd, openedAt: this.now(), closedAt: null });
      if (a.choice) st.models[newId] = a.choice;
      a.choice = null;
      st.layout = renameInLayout(st.layout, old, newId, true);
    } else {
      for (const e of st.open) if (e.id === old) e.id = newId;
      st.layout = renameInLayout(st.layout, old, newId, false);
      for (const k of ['models', 'rules', 'status', 'ended', 'endedFailed'] as const) {
        const rec = st[k] as Record<string, unknown>;
        if (old in rec) { rec[newId] = rec[old]; delete rec[old]; }
      }
      if (why === 'reset') delete st.written[old];
      else if (old in st.written) { st.written[newId] = st.written[old]; delete st.written[old]; }
    }
    st.status[newId] = { status: a.status.status, at: a.status.at };
    this.store.changed();
    this.views.rekey(old, newId);
    this.log('sessions.swap', { from: old, to: newId, why });
  }

  private pushStream(a: Active, now: boolean): void {
    if (now) {
      if (a.streamTimer) clearTimeout(a.streamTimer);
      a.streamTimer = null;
      this.views.setStream(a.id, a.stream.text());
      return;
    }
    if (a.streamTimer) return;
    a.streamTimer = setTimeout(() => {
      a.streamTimer = null;
      this.views.setStream(a.id, a.stream.text());
    }, STREAM_MS);
  }

  private setStreamClear(a: Active): void {
    if (a.stream.clear() || a.streamTimer) this.pushStream(a, true);
  }

  // A process ends after 30 min idle with no subagent or background work running.
  private armIdle(a: Active): void {
    this.clearIdle(a);
    if (!a.proc) return;
    a.idleTimer = setTimeout(() => {
      a.idleTimer = null;
      if (!a.proc || a.status.working) return;
      if (this.views.facts(a.id)?.working) { this.armIdle(a); return; }
      this.log('driver.idleEnd', { sid: a.id });
      a.proc.end();
    }, this.opts.idleMs ?? IDLE_MS);
    a.idleTimer.unref?.();
  }

  private clearIdle(a: Active): void {
    if (a.idleTimer) clearTimeout(a.idleTimer);
    a.idleTimer = null;
  }

  private expand(p: string): string {
    if (p === '~') return this.home;
    if (p.startsWith('~/')) return path.join(this.home, p.slice(2));
    return path.resolve(p);
  }

  private tilde(p: string): string {
    return p.startsWith(this.home + '/') ? '~' + p.slice(this.home.length) : p;
  }
}

type Msg = { type: string; subtype?: string; [k: string]: unknown };

// The Open list's title (plan section 6): the custom title, else the summary, else the first prompt.
export function titleOf(s: SDKSessionInfo): string {
  const t = [s.customTitle, s.summary, s.firstPrompt].find((x) => typeof x === 'string' && x.trim()) ?? '';
  return t.trim().split('\n')[0].slice(0, 120) || 'Untitled session';
}

// Replaces an id in the layout; `add` puts a new id under "Not in a group" when it wasn't there.
export function renameInLayout(layout: Layout, old: string, id: string, add: boolean): Layout {
  const swap = (ids: string[]) => ids.map((x) => (x === old ? id : x));
  const out: Layout = { groups: layout.groups.map((g) => ({ ...g, ids: swap(g.ids) })), others: swap(layout.others) };
  const placed = out.others.includes(id) || out.groups.some((g) => g.ids.includes(id));
  if (add && !placed) out.others.push(id);
  return out;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
