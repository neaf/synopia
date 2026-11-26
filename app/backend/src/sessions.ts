// The set of open sessions (FR-SES-01..04): the open list in state.json, new and past sessions,
// close, and the ids the page holds. A new session is a placeholder (`new-…`) until system/init
// gives its real id; a conversation_reset moves a session to a new id. Both swaps keep an alias, so
// a late `send` or `view` with an old id reaches the session, and `rekey` moves the whole record.
// One session's process, cards, bash mode and take-over are session.ts; the router reaches it through
// `get(id)`, which follows the aliases.
// The Open list comes from the SDK's listSessions(), searched whole with the page's matcher
// (app/web/js/fuzzy.js); opening a past session adds it to the open list, and it resumes on its first
// message. The folder list (R3.3) is the known folders (folders.ts); a session whose folder is gone
// continues in another folder as a fork (R3.11).
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SDKSessionInfo, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { realSdk } from './sdk.ts';
import type { Sdk } from './sdk.ts';
import { restored } from './status.ts';
import type { Running, StatusEntry, Timer } from './status.ts';
import { IDLE_MS, Session, UUID } from './session.ts';
import type { SendResult, TerminalSource } from './session.ts';
import type { Transcripts } from './transcripts.ts';
import type { Publisher } from './publisher.ts';
import type { Store, OpenEntry } from './store.ts';
import { Folders, knownFolders } from './folders.ts';
import type { Known } from './folders.ts';
import { rank } from '../../web/js/fuzzy.js';
import { Layouts } from './layout.ts';
import { toolServer } from './agent-tools.ts';
import { seedTitle } from './writer.ts';
import type { Host as ToolHost } from './agent-tools.ts';
import type { Log } from './log.ts';
import { nullLog } from './log.ts';
import { displayPath, isDir } from './paths.ts';
import { pruneUi, pruneUiTo, rekeyUi } from './ui-state.ts';

export const RECENT = 50;
export type Recent = { id: string; title: string; cwd: string; lastModified: number; terminal?: number };
// The Open list's reply: the rows, and the totals its header and last line give (R3.2).
export type RecentPage = { rows: Recent[]; total: number; folders: number; matched: number };
export type { TerminalSource } from './session.ts';

export type SessionsOptions = {
  store: Store;
  transcripts: Transcripts;
  publisher: Publisher;
  log?: Log;
  sdk?: Sdk; // tests inject a fake query and listSessions; the default is the SDK
  home?: string;
  now?: () => number;
  timer?: Timer; // the status's stale timer, on the same clock as `now` (the scripted SDK moves both)
  idleMs?: number;
  // The writer: a session's turn ended, and a stored session was opened.
  onTurnEnded?: (sid: string) => void;
  onOpened?: (sid: string) => void;
  // A card waiting on you appeared or ended (ours, or one another process asks): the Now line follows.
  onWaiting?: (sid: string) => void;
  // A running process pushed a new command list (commands_changed).
  onCommands?: (sid: string, commands: SlashCommand[]) => void;
  // A session's model sign-in expired, or works again (creds.ts); a session closed or took another id.
  onSignedOut?: (sid: string, cwd: string, signedOut: boolean) => void;
  onGone?: (sid: string) => void;
  // The terminals that hold sessions (cli-terminals.ts); none without it.
  terminals?: TerminalSource;
  folders?: Folders; // the disk side of the folder list (tests count its reads); else the real one
  // Folders taken as there without a stat: the scripted SDK's made-up home (dev and checks only).
  pretendFolder?: (abs: string) => boolean;
};

const gone: SendResult = { ok: false, error: "That session isn't open any more." };

export class Sessions {
  private store: Store;
  private transcripts: Transcripts;
  private publisher: Publisher;
  private log: Log;
  private opts: SessionsOptions;
  private home: string;
  private now: () => number;
  private live = new Map<string, Session>();
  private aliases = new Map<string, string>();
  private recent = new Map<string, Recent>(); // the last Open list, for openSession's folder
  private idWaits = new Map<string, ((id: string) => void)[]>(); // a new session's id, awaited by start_session
  // The sidebar's layout (layout.ts): the open list gives it its ids.
  readonly layout: Layouts;
  readonly folders: Folders;

  constructor(opts: SessionsOptions) {
    this.opts = opts;
    this.store = opts.store;
    this.transcripts = opts.transcripts;
    this.publisher = opts.publisher;
    this.log = opts.log ?? nullLog;
    this.home = opts.home ?? os.homedir();
    this.now = opts.now ?? Date.now;
    this.folders = opts.folders ?? new Folders(this.home, undefined, opts.pretendFolder);
    this.layout = new Layouts({ store: this.store, entries: () => this.layoutEntries(), publish: (l) => this.publisher.layout(l) });
  }

  // Opens every session of the open list that isn't closed. None has a process yet. The page's UI
  // state of any other session (closed while state.json was edited, a new session that never got its
  // id) goes, with its draft images.
  start(): void {
    this.opts.terminals?.onChange(() => this.terminalsChanged());
    for (const e of this.store.state.open) {
      if (e.closedAt !== null || this.live.has(e.id)) continue;
      this.add(e.id, e.cwd, false, restored(this.store.state.status[e.id]));
    }
    pruneUiTo(this.store, (sid) => this.live.has(sid));
    this.layout.sync();
  }

  // The current id for an id the page may still hold.
  resolve(id: string): string {
    let cur = id;
    for (let i = 0; i < 16 && this.aliases.has(cur); i++) cur = this.aliases.get(cur) as string;
    return cur;
  }

  // The open session an id names, through its aliases.
  get(id: string): Session | undefined {
    return this.live.get(this.resolve(id));
  }

  // The ids a stored layout may hold: the open list and the new sessions not stored yet, so a
  // placeholder dragged into a group keeps its place until init renames it there.
  layoutEntries(): OpenEntry[] {
    const placeholders = [...this.live.values()].filter((s) => s.placeholder)
      .map((s) => ({ id: s.id, cwd: s.cwd, openedAt: 0, closedAt: null }));
    return [...this.store.state.open, ...placeholders];
  }

  // The sessions with a running turn, for the quit check.
  running(): string[] {
    return [...this.live.values()].filter((s) => s.working).map((s) => s.id);
  }

  // For the shell's quit check: the sessions with a running turn and the background work
  // (subagents, shells, monitors) that lives in a running process.
  quitCheck(): { running: string[]; background: { sid: string; kind: string }[] } {
    const background: { sid: string; kind: string }[] = [];
    for (const s of this.live.values()) {
      if (!s.hasProcess) continue;
      for (const kind of this.transcripts.facts(s.id)?.runningWork ?? []) background.push({ sid: s.id, kind });
    }
    return { running: this.running(), background };
  }

  // An empty session in `cwd` (absolute, or `~`-relative). It isn't stored until system/init gives its id.
  // `title`: its first title (a session that start_session started, R3.15), stored as written text
  // the writer replaces after a turn; never a custom-title record.
  newSession(cwd: string, title = ''): string {
    const id = `new-${randomUUID()}`;
    if (title) seedTitle(this.store, id, title, this.now());
    this.add(id, this.expand(cwd), true, null);
    this.layout.sync(); // last under Not in a group
    this.log('sessions.new', { sid: id });
    return id;
  }

  // A new session in a folder the page names (R3.3): made first with `create` (mkdir -p, folders.ts), and
  // refused when it isn't there.
  async newSessionIn(folder: string, create = false): Promise<SendResult> {
    const r = await this.folders.ready(folder, create);
    if ('error' in r) return { ok: false, error: r.error };
    if (create) this.log('folders.created', {});
    return { ok: true, sid: this.newSession(r.abs) };
  }

  // The folder list (R3.3): every folder a known session ran in, Synopia's and listSessions()'s, newest
  // first. No folder is read for it (R3.13).
  async listFolders(): Promise<Known[]> {
    const listed = await (this.opts.sdk ?? realSdk).listSessions();
    return knownFolders(this.store.state.open, listed, this.home);
  }

  // The Open list: past sessions from listSessions(), without the open ones. No filter: the newest
  // RECENT. A filter: every past session ranked by the matcher on "title folder", a tie to the one with
  // more of the match in its title, then the newer; at most RECENT. With the totals (R3.2). A session
  // without a folder can't resume, so it isn't listed.
  async searchRecent(filter = ''): Promise<RecentPage> {
    const all = await (this.opts.sdk ?? realSdk).listSessions();
    const past: Recent[] = [];
    const folders = new Set<string>();
    for (const s of [...all].sort((x, y) => y.lastModified - x.lastModified)) {
      // Only an id that is open itself: after a /clear the old id is an alias of the new one, but
      // its conversation is a past session of its own (R3.2).
      if (!s.cwd || this.live.has(s.sessionId)) continue;
      // A session Synopia closed keeps the title Claude wrote for it (section 10's order), so the
      // Open list names it as the sidebar did.
      const written = this.store.state.written[s.sessionId]?.title;
      const title = (!s.customTitle?.trim() && written?.trim()) || titleOf(s);
      past.push({ id: s.sessionId, title, cwd: s.cwd, lastModified: s.lastModified });
      folders.add(s.cwd);
    }
    const hits = rank(past, filter, (r) => `${r.title} ${this.tilde(r.cwd)}`, (r) => [...r.title].length);
    const out = hits.slice(0, RECENT).map((h) => {
      const term = this.opts.terminals?.holder(h.row.id);
      return { ...h.row, ...(term ? { terminal: term.pid } : {}) };
    });
    for (const r of out) this.recent.set(r.id, r);
    return { rows: out.map((r) => ({ ...r, cwd: this.tilde(r.cwd) })), total: past.length, folders: folders.size, matched: hits.length };
  }

  async listRecent(filter = ''): Promise<Recent[]> {
    return (await this.searchRecent(filter)).rows;
  }

  // R3.11: a session whose folder is gone goes on in another folder, as a fork with a new id; the old id
  // stays a past session. The folder is made first with `create`.
  async continueSession(sid: string, folder: string, create = false): Promise<SendResult> {
    const s = this.get(sid);
    if (!s) return gone;
    if (!s.checkFolder()) return { ok: false, error: 'This session\'s folder is still there.' };
    const r = await this.folders.ready(folder, create);
    if ('error' in r) return { ok: false, error: r.error };
    if (this.get(sid) !== s) return gone; // closed meanwhile
    const res = s.continueIn(r.abs);
    this.log('sessions.continue', { sid: s.id, ok: res.ok, created: create });
    return res;
  }

  // Adds a past session to the open list (or reopens a closed one, which keeps its place in the
  // layout). Its transcript shows at once; it resumes on its first message.
  async openSession(id: string): Promise<SendResult> {
    if (this.live.has(id)) return { ok: true, sid: id };
    if (!UUID.test(id)) return { ok: false, error: "That isn't a session id." };
    if (!this.recent.has(id)) await this.listRecent();
    const r = this.recent.get(id);
    if (!r) return { ok: false, error: 'That session is no longer in the Open list.' };
    if (this.live.has(id)) return { ok: true, sid: id };
    // The id names this conversation again, not the one a reset moved it to: page messages with it
    // reach it, and older ids that led through it keep leading where they did.
    if (this.aliases.has(id)) {
      const to = this.resolve(id);
      for (const [k, v] of this.aliases) if (v === id) this.aliases.set(k, to);
      this.aliases.delete(id);
    }
    const st = this.store.state;
    const e = st.open.find((x) => x.id === id);
    if (e) { // reopened: the most recently opened again, for the new-session folder (R3.3)
      e.closedAt = null;
      e.cwd = r.cwd;
      e.openedAt = this.now();
    } else {
      st.open.push({ id, cwd: r.cwd, openedAt: this.now(), closedAt: null });
    }
    this.store.changed();
    const s = this.add(id, r.cwd, false, restored(st.status[id]) ?? { status: 'idle', at: r.lastModified });
    s.checkFolder(); // the row you chose: gone or not (R3.11)
    this.layout.sync(); // a reopened one is back in its place
    this.log('sessions.open', { sid: id, reopened: Boolean(e) });
    return { ok: true, sid: id };
  }

  // Close (R3.6): marks it closed and ends its process now, background work included (the page
  // asked first when something ran). It stays in its layout group, hidden; the Open list lists it
  // again, and reopening it puts it back there. A placeholder is simply dropped.
  close(sid: string): SendResult {
    const id = this.resolve(sid);
    const s = this.live.get(id);
    if (!s) return gone;
    const running = s.close();
    this.live.delete(id);
    if (s.placeholder && id in this.store.state.written) { delete this.store.state.written[id]; this.store.changed(); }
    const e = this.store.state.open.find((x) => x.id === id);
    if (e) {
      e.closedAt = this.now();
      this.store.changed();
    }
    pruneUi(this.store, id); // its scroll, draft and the rest of the page's state for it (R3.9)
    this.layout.sync(); // a placeholder's id goes; a stored one keeps its place, hidden
    this.transcripts.close(id); // the pages get `removed` (publisher.ts)
    this.opts.onGone?.(id);
    this.log('sessions.close', { sid: id, running });
    return { ok: true, sid: id };
  }

  // Quit: every process ends now.
  stop(): void {
    for (const s of this.live.values()) s.stop();
    this.store.flush();
  }

  // From the transcripts: what runs by the transcript changed, and an assistant record landed.
  // The folder's credential refresh runs, or no longer, or succeeded (creds.ts).
  refreshing(sids: string[], on: boolean): void {
    for (const sid of sids) this.live.get(sid)?.status.setRefreshing(on);
  }

  refreshed(sids: string[]): void {
    for (const sid of sids) this.live.get(sid)?.status.credentialsRefreshed();
  }

  runningChanged(sid: string, r: Running): void {
    this.live.get(sid)?.runningChanged(r);
  }

  landed(sid: string, messageId: string, types: string[]): void {
    this.live.get(sid)?.landed(messageId, types);
  }

  // ---------- Synopia's tools for agents (agent-tools.ts) ----------

  // What the tools reach: the calling session, a new session with its first message, its place
  // under the caller (layout.ts), the pages, and the new session's id once its init gives it.
  readonly toolHost: ToolHost = {
    caller: (id) => {
      const s = this.get(id);
      if (!s || s.placeholder || !s.hasProcess) return null;
      return { id: s.id, cwd: s.cwd, title: this.publisher.meta(s.id)?.title || 'New session', gone: () => s.checkFolder() };
    },
    newSession: (cwd, prompt, title) => {
      const id = this.newSession(cwd, title);
      const r = this.live.get(id)?.send(prompt) ?? gone;
      if (!r.ok) { this.close(id); return r; }
      this.log('tools.startSession', { sid: id });
      return { ok: true, sid: id };
    },
    placeUnder: (sid, caller, group) => this.layout.placeUnder(this.resolve(sid), this.resolve(caller), group),
    started: (sid, caller) => this.publisher.started(this.resolve(sid), this.resolve(caller)),
    idOf: (sid, ms) => {
      if (this.resolve(sid) !== sid) return Promise.resolve(this.resolve(sid));
      return new Promise((done) => {
        const t = setTimeout(() => finish(), ms);
        t.unref?.();
        const finish = () => { clearTimeout(t); done(this.resolve(sid)); };
        this.idWaits.set(sid, [...(this.idWaits.get(sid) ?? []), finish]);
      });
    },
    tilde: (p) => this.tilde(p),
  };

  // ---------- the set ----------

  private terminalsChanged(): void {
    const reg = this.opts.terminals;
    if (!reg) return;
    for (const s of [...this.live.values()]) s.terminalChanged(reg.holder(s.id));
  }

  private add(id: string, cwd: string, placeholder: boolean, init: StatusEntry | null): Session {
    const s = new Session(id, cwd, placeholder, init, {
      store: this.store, transcripts: this.transcripts, publisher: this.publisher, log: this.log, sdk: this.opts.sdk ?? realSdk, terminals: this.opts.terminals ?? null,
      now: this.now, timer: this.opts.timer, idleMs: this.opts.idleMs ?? IDLE_MS, tilde: (p) => this.tilde(p),
      isDir: (p) => Boolean(this.opts.pretendFolder?.(p)) || isDir(p),
      onTurnEnded: this.opts.onTurnEnded, onWaiting: this.opts.onWaiting, onCommands: this.opts.onCommands,
      onSignedOut: (x, on) => this.opts.onSignedOut?.(x.id, x.cwd, on),
      rekey: (x, newId, why) => this.rekey(x, newId, why),
      tools: (caller) => toolServer(this.toolHost, caller),
    });
    this.live.set(id, s);
    s.open();
    if (!placeholder) this.opts.onOpened?.(id);
    return s;
  }

  // The session's id changed: the whole record moves (the session, its view, its UI state, and its
  // entries in the open list, layout, models, rules, status and end times); a reset also drops the
  // written title and Now line. An id another open session holds is refused, logged and toasted:
  // the CLI writes to that id now, so the transcript shown is no longer this session's.
  private rekey(s: Session, newId: string, why: 'init' | 'reset' | 'moved'): void {
    const old = s.id;
    if (this.live.has(newId)) {
      this.log('sessions.swapRefused', { from: old, to: newId, why });
      this.publisher.toast(`Claude moved a session to an id another open session has (${newId.slice(0, 8)}). Close one of them and open it again.`);
      return;
    }
    const st = this.store.state;
    this.opts.onGone?.(old);
    this.aliases.set(old, newId);
    this.live.delete(old);
    s.id = newId;
    this.live.set(newId, s);
    if (s.placeholder) {
      s.placeholder = false;
      st.open.push({ id: newId, cwd: s.cwd, openedAt: this.now(), closedAt: null });
      if (s.choice) st.models[newId] = s.choice;
      s.choice = null;
      if (old in st.written) { st.written[newId] = st.written[old]; delete st.written[old]; } // its first title (R3.15)
    } else {
      for (const e of st.open) if (e.id === old) { e.id = newId; e.cwd = s.cwd; } // a fork into another folder moves it (R3.11)
      for (const k of ['models', 'rules', 'status', 'ended', 'endedFailed'] as const) {
        const rec = st[k] as Record<string, unknown>;
        if (old in rec) { rec[newId] = rec[old]; delete rec[old]; }
      }
      if (why === 'reset') delete st.written[old];
      else if (old in st.written) { st.written[newId] = st.written[old]; delete st.written[old]; }
    }
    this.layout.rename(old, newId); // before the `session` frame with `replaces`, which carries it
    st.status[newId] = { status: s.status.status, at: s.status.at };
    rekeyUi(this.store, old, newId); // the page's state for it moves too (R3.9)
    this.store.changed();
    this.transcripts.rekey(old, newId); // the reading starts again; the pages follow (publisher.ts)
    this.log('sessions.swap', { from: old, to: newId, why });
    const waits = this.idWaits.get(old);
    this.idWaits.delete(old);
    for (const w of waits ?? []) w(newId);
  }

  private expand(p: string): string {
    if (p === '~') return this.home;
    if (p.startsWith('~/')) return path.join(this.home, p.slice(2));
    return path.resolve(p);
  }

  private tilde(p: string): string {
    return displayPath(p, this.home);
  }
}

// The Open list's title: the custom title, else the summary, else the first prompt.
export function titleOf(s: SDKSessionInfo): string {
  const t = [s.customTitle, s.summary, s.firstPrompt].find((x) => typeof x === 'string' && x.trim()) ?? '';
  return t.trim().split('\n')[0].slice(0, 120) || 'Untitled session';
}
