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
import type { ListSessionsOptions, SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { SessionProcess } from './driver.ts';
import type { Content, InterruptResult, QueryFn, StartOptions } from './driver.ts';
import { SessionStatus, restored } from './status.ts';
import type { StatusEntry } from './status.ts';
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
  stream: StreamPreview;
  streamTimer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
};

export type SessionsOptions = {
  store: Store;
  views: Views;
  log?: Log;
  queryFn?: QueryFn; // tests inject a fake; the default is the SDK's query
  listFn?: ListFn; // the same for listSessions
  home?: string;
  now?: () => number;
  idleMs?: number;
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
      const title = titleOf(s);
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
    (a.proc as SessionProcess).push(content, uuid && UUID.test(uuid) ? uuid : randomUUID());
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
    proc?.close();
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
    if (r.restored.length) this.views.restore(a.id, r.restored);
    if (r.stillQueued) {
      const n = r.stillQueued;
      this.views.toast(`Interrupted. ${n === 1 ? 'Your queued message' : `${n} queued messages`} will still run: this Claude Code can't cancel ${n === 1 ? 'it' : 'them'}.`);
    }
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

  // Quit: every process ends now.
  stop(): void {
    for (const a of this.live.values()) {
      this.clearIdle(a);
      if (a.streamTimer) clearTimeout(a.streamTimer);
      a.proc?.close();
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
      id, cwd, placeholder, proc: null, stream: new StreamPreview(), streamTimer: null, idleTimer: null,
      status: new SessionStatus(init, (e) => this.statusChanged(a, e), this.now),
    };
    this.live.set(id, a);
    this.views.open(id, { cwd });
    this.views.setStatus(id, a.status.status, a.status.at);
    return a;
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
    const stored = st.models[a.id];
    return {
      cwd: a.cwd,
      resume: a.placeholder ? undefined : a.id,
      model: stored?.model || facts?.model || st.settings.model || undefined,
      effort: stored?.effort || facts?.effort || undefined,
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
      onDenied: (name) => {
        this.log('driver.denied', { sid: a.id, tool: name });
        this.views.toast(`Claude asked to use ${name}. Synopia can't answer this yet, so Claude was told to ask in plain text.`);
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
    } else if (m.type === 'conversation_reset' && typeof m.new_conversation_id === 'string') {
      this.setStreamClear(a);
      this.swap(a, m.new_conversation_id, 'reset');
    } else if (m.type === 'stream_event') {
      if (a.stream.event(m as { event: unknown; parent_tool_use_id: string | null })) this.pushStream(a, false);
    } else if (m.type === 'result') {
      this.setStreamClear(a);
      a.status.result({ subtype: String(m.subtype), is_error: m.is_error === true, terminal_reason: typeof m.terminal_reason === 'string' ? m.terminal_reason : undefined });
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
      st.layout = renameInLayout(st.layout, old, newId, true);
    } else {
      for (const e of st.open) if (e.id === old) e.id = newId;
      st.layout = renameInLayout(st.layout, old, newId, false);
      for (const k of ['models', 'rules', 'status'] as const) {
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
