// Server to page (FR-VIEW-01, -04, -05, -13, -14, -17): the only module that sends frames. It sends
// `session` meta (with `state` from status.ts), `agents`, `background`, `pending` and `removed` to
// every page, and `items` and the `stream` preview only to the pages viewing that conversation: a reset with the
// last WINDOW items (or from the page's `from`) on `view`, then upserts of changed ids, and the WINDOW
// items before the oldest shown on `earlier`. `restore` and an action's `toast` go to the page that
// acted, when it is still connected.
// One flush per change batch, guarded: a change made while a flush runs (status.ts hears what runs
// and sets the status) marks the session dirty and flushes again after, so the frames of one flush
// always go in this order: `session`, `agents`, `background`, `items`.
import os from 'node:os';
import { transcriptStatus, sessionState, badgeOf, commandOf, backgroundOf, lastWordsMs } from './status.ts';
import type { BadgeCounter, Command, Running, SessionState, Needs, Status, StatusDetail, Thread } from './status.ts';
import type { Agent, Item, PendingAsk, Transcript } from './transcript.ts';
import { Transcripts, WINDOW, effortOf } from './transcripts.ts';
import type { ReadChanges } from './transcripts.ts';
import type { Client } from './server.ts';
import { displayPath } from './paths.ts';
import { resolveModel } from './session.ts';
import type { BangMeta, ModelChoice, QueuedMessage, ShownBang } from './session.ts';
import type { PendingRequest } from './cards.ts';
import type { Returned } from './sdk.ts';
import { VERSION } from '../../web/js/protocol.js';
import { outputTail, outputBefore, outputSize, readOutput, eventTail, eventsFrom, eventsBefore } from './task-output.ts';
import type { OutputPart } from './task-output.ts';
import { FIND_READ } from './find.ts';
import type { FindSource } from './find.ts';
import type { Terms, TermPart } from './terms.ts';

export { WINDOW } from './transcripts.ts';
export const RECHECK_MS = 60_000;

export type SessionMeta = {
  id: string; title: string; name: string; now: string; cwd: string; prs: unknown[];
  state: SessionState; model: unknown; effort: unknown;
  ask: PendingAsk | null; outbox: QueuedMessage[]; bang: ShownBang | null; bangs: BangMeta[];
  gone: boolean; // its folder was checked and isn't there (R3.11)
};

// What a session shows that it owns itself (session.ts): its queued messages and its `!` run, and
// what it makes of the prompt and bash items that just landed (before the meta is built).
export type Shown = {
  outbox(): QueuedMessage[];
  bang(): ShownBang | null;
  bangs(): BangMeta[]; // its `!` runs for the background panel
  bangOutput(id: string): { cmd: string; out: string; err: string; running: boolean } | null; // one run's, for its shell view
  landed(items: Item[]): void;
};

export type PublisherOptions = {
  transcripts: Transcripts;
  clients: () => Set<Client>;
  home?: string; // for `~` in paths; the fixtures use their own
  // A turn running by the transcript alone ends after QUIET_MS without a change: every session is
  // flushed this often to notice. 0 turns it off (tests).
  recheckMs?: number;
  // How often a shown shell's output file is looked at for more (R7.2); 0 turns it off (tests).
  outputMs?: number;
  // The title and Now line Claude wrote for a session (state.json `written`).
  written?: (sid: string) => { title?: string; now?: string } | undefined;
  // settings.model: what a session with no choice and no model in its transcript starts with.
  defaultModel?: () => string | undefined;
  // Whether a subagent's deliverable was marked reviewed (state.json `reviewed`).
  reviewed?: (agentId: string) => boolean;
  // The Dock badge's count: each session's share is set whenever its state is worked out.
  badge?: BadgeCounter;
  // What runs by the transcript changed: subagents and forks, the main turn and its ask.
  onRunning?: (sid: string, r: Running) => void;
  // A background shell, monitor or subagent of the session stopped running.
  onWorkEnded?: (sid: string) => void;
  // The sidebar's layout (layout.ts), for the `session` frame of an id that changed.
  layout?: () => unknown;
  // The terminals of the runs Synopia holds a pty for (terms.ts): a page that shows one gets `term` frames.
  terms?: Terms;
};

// What `hello` carries besides the sessions and their cards (main.ts gathers it).
export type Hello = { code: string; layout: unknown; menu: unknown; ui: unknown; update: boolean };

// A page's view: a conversation (`agent` null for the main one), or a background shell or monitor
// (`bg`, its tool use id) with what the page has of its output (`out`).
type Sub = {
  sid: string; agent: string | null; from: number;
  bg?: string | null; out?: { file: string | null; from: number; to: number } | null;
  own?: string; // a `!` run of the session (session.ts bangOutput): the signature of the output last sent
  term?: boolean; // a run with a terminal (terms.ts): its raw stream goes as `term` frames
  chain?: Promise<void>; more?: boolean; // its output reads, one after the other; a look for more queued
};
type Pub = {
  id: string;
  status: Status | null; statusAt: number; statusDetail: StatusDetail; // set by session.ts; null: from the transcript
  choice: ModelChoice | null; pending: PendingRequest[]; held: string[]; stream: string | null;
  sent: string; // the last `session` meta sent
  ran: string; // the last Running given to onRunning
  working: Set<string>; // background work and subagents seen running, to tell when one ends
  since: Map<string, number>; // tool use id -> when a running tool started, from the SDK's tool_progress (R5.6)
  cmdTimer: NodeJS.Timeout | null; cmdDue: number; // a flush when the step the main turn waits on has run COMMAND_MS
  shown: Shown | null;
  queued: boolean;
  gone: boolean;
};

export class Publisher {
  private opts: PublisherOptions;
  private transcripts: Transcripts;
  private home: string;
  private pubs = new Map<string, Pub>();
  private subs = new Map<Client, Sub>();
  private flushing = false;
  private dirty = new Set<string>();
  private recheck: NodeJS.Timeout | null = null;
  private outTimer: NodeJS.Timeout | null = null;

  constructor(opts: PublisherOptions) {
    this.opts = opts;
    this.transcripts = opts.transcripts;
    this.home = opts.home ?? os.homedir();
    this.transcripts.listen({
      changed: (sid) => this.changed(sid),
      closed: (sid) => this.closed(sid),
      rekeyed: (from, to) => this.rekeyed(from, to),
    });
    opts.terms?.onPart((p) => this.termPart(p));
    const every = opts.recheckMs ?? RECHECK_MS;
    if (every > 0) {
      this.recheck = setInterval(() => { for (const id of this.transcripts.ids()) this.changed(id); }, every);
      this.recheck.unref?.();
    }
  }

  stop(): void {
    if (this.recheck) clearInterval(this.recheck);
    this.recheck = null;
    if (this.outTimer) clearInterval(this.outTimer);
    this.outTimer = null;
    for (const p of this.pubs.values()) this.armCommand(p, null);
  }

  // ---------- sending ----------

  // To every page.
  broadcast(msg: object): void {
    for (const c of this.opts.clients()) c.send(msg);
  }

  // A reply to the page that asked (`recent`, `preview`, `menu`, an action's `ack`, ...).
  reply(client: Client, msg: object): void {
    client.send(msg);
  }

  // The first frame a page gets once its token is taken (server.ts): everything it shows, with the
  // protocol version (a page of another version reloads) and the daemon's code hash.
  hello(client: Client, rest: Hello): void {
    client.send({ t: 'hello', v: VERSION, code: rest.code, sessions: this.sessions(), pending: this.pending(), layout: rest.layout, menu: rest.menu, ui: rest.ui, update: rest.update });
  }

  // A session started `sid` (agent-tools.ts start_session): a page viewing `from` switches to it.
  started(sid: string, from: string): void {
    this.broadcast({ t: 'started', sid, from });
  }

  // The sidebar's layout, whole, after it changed (layout.ts).
  layout(layout: unknown): void {
    this.broadcast({ t: 'layout', layout });
  }

  // A toast to the page that acted, or to every page when none did or it is gone.
  toast(text: string, to?: Client | null): void {
    this.toActing({ t: 'toast', text }, to);
  }

  // Messages that didn't go, back to the message box of the page that sent them:
  // their texts, and `images` (each `{mediaType, data, n?}`) when they carried pasted ones.
  restore(sid: string, back: Returned[], to?: Client | null): void {
    if (!back.length) return;
    const texts = back.map((b) => b.text).filter((t) => t.trim());
    const images = back.flatMap((b) => b.images).map((im) => ({ mediaType: im.mediaType, data: im.data, ...(im.n !== undefined ? { n: im.n } : {}) }));
    this.toActing({ t: 'restore', sid, texts, ...(images.length ? { images } : {}) }, to);
  }

  private toActing(msg: object, to?: Client | null): void {
    if (to && this.opts.clients().has(to)) to.send(msg);
    else this.broadcast(msg);
  }

  // ---------- what sessions set ----------

  // The session's own state (session.ts) joins its meta.
  attach(sid: string, shown: Shown): void {
    const p = this.pub(sid);
    if (p) p.shown = shown;
  }

  // detail: the queued count and the retry of status.ts, for the page's words.
  setStatus(sid: string, status: Status, at = Date.now(), detail: StatusDetail = {}): void {
    const p = this.pub(sid);
    if (!p) return;
    p.status = status;
    p.statusAt = at;
    p.statusDetail = detail;
    this.changed(sid);
  }

  // Its folder is gone, or back (session.ts checkFolder).
  setGone(sid: string, gone: boolean): void {
    const p = this.pub(sid);
    if (!p) return;
    p.gone = gone;
    this.changed(sid);
  }

  // The model and effort you chose (session.ts), shown over the transcript's.
  setChoice(sid: string, choice: ModelChoice | null): void {
    const p = this.pub(sid);
    if (!p) return;
    p.choice = choice;
    this.changed(sid);
  }

  setPending(sid: string, request: PendingRequest): void {
    const p = this.pub(sid);
    if (!p) return;
    p.pending = [...p.pending.filter((r) => r.id !== request.id), request];
    this.broadcast({ t: 'pending', sid, request });
    this.queue(sid); // needs you, and on what: after the card count reaches the status (cards.ts)
  }

  clearPending(sid: string, id: string): void {
    const p = this.pub(sid);
    if (!p || !p.pending.some((r) => r.id === id)) return;
    p.pending = p.pending.filter((r) => r.id !== id);
    this.broadcast({ t: 'pending', sid, cleared: id });
    this.queue(sid);
  }

  // The streaming preview (FR-VIEW-17): its text goes to the pages viewing the main conversation,
  // which get the current text when they start viewing it; its clear goes to every page, so none
  // keeps an old preview (hello carries each session's).
  setStream(sid: string, text: string | null): void {
    const p = this.pub(sid);
    if (!p) return;
    p.stream = text;
    if (text === null) { this.broadcast({ t: 'stream', sid, clear: true }); return; }
    for (const [client, sub] of this.liveSubs()) if (sub.sid === sid && sub.agent === null && !sub.bg) client.send({ t: 'stream', sid, text });
  }

  // The messages sent while a card waits, held behind it ("Queued until you answer the card above").
  setHeld(sid: string, texts: string[]): void {
    const p = this.pub(sid);
    if (!p) return;
    p.held = texts;
    this.broadcast({ t: 'session', id: sid, held: texts });
  }

  // The SDK's tool_progress for a running tool of a Synopia-driven session (main or subagent). It
  // carries only the elapsed seconds (sdk.d.ts SDKToolProgressMessage, no output), so the tool's
  // start is now minus those. Kept once per tool, until the tool ends: the page's timer counts from
  // it, so later ones change nothing. The tool's item goes again to the pages that show it, with
  // `since` (ISO). The session's state goes again too: a running command's time counts from it (R8.2, 2026-11-27).
  toolProgress(sid: string, toolUseId: string, elapsedSeconds: number, now = Date.now()): void {
    const p = this.pub(sid);
    if (!p || p.since.has(toolUseId) || !Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) return;
    p.since.set(toolUseId, now - Math.round(elapsedSeconds * 1000));
    for (const [client, sub] of this.liveSubs()) {
      if (sub.sid !== sid || sub.bg) continue;
      const t = this.transcripts.get(sid, sub.agent);
      if (t) this.sendUpserts(client, sub, t, [toolUseId]);
    }
    this.changed(sid); // a command's time counts from here (status.ts commandOf)
  }

  // "Mark reviewed" (the caller stores it): the subagent's line and its session's count change.
  reviewed(agentId: string): void {
    for (const sid of this.transcripts.ids()) {
      const a = this.transcripts.get(sid)?.getAgent(agentId);
      if (!a) continue;
      this.broadcast({ t: 'agents', sid, upsert: this.agentsOut([a]) });
      this.changed(sid);
    }
  }

  // ---------- what pages ask ----------

  // `view` from a page: it now watches this conversation, and gets it from the start. `from` is the
  // oldest item the page had loaded for it (its earlier items, ui.js): one reset from that item to
  // the end, so the page renders once. Without it, or when it is gone or within the last WINDOW,
  // the last WINDOW items.
  view(client: Client, sid: string, agent: string | null, from?: string | null, bg?: string | null): Promise<void> | void {
    if (bg) return this.viewOutput(client, sid, bg, from);
    const sub: Sub = { sid, agent: agent || null, from: 0 };
    this.subs.set(client, sub);
    this.outTimers();
    this.sendReset(client, sub, from);
    const text = this.pubs.get(sid)?.stream ?? null;
    if (sub.agent === null && text !== null) client.send({ t: 'stream', sid, text });
  }

  // `earlier` from a page: the WINDOW items before `before` (the oldest item it shows), sent with
  // `prepend`. The page's window grows to them, so later upserts of those items reach it too.
  // A reply only for the conversation the page views, and only while `before` is still in it
  // (after a rewrite the page gets a reset instead). Returns how many items went out.
  earlier(client: Client, sid: string, agent: string | null, before: string): number {
    const sub = this.subs.get(client);
    if (!sub || sub.bg || sub.sid !== sid || sub.agent !== (agent || null)) return 0;
    const t = this.transcripts.get(sub.sid, sub.agent);
    if (!t) return 0;
    const end = t.items.findIndex((i) => i.id === before);
    if (end < 0) return 0;
    const start = Math.max(0, end - WINDOW);
    sub.from = Math.min(sub.from, start);
    const upsert = this.dress(sid, t.items.slice(start, end));
    client.send({ t: 'items', sid: sub.sid, agent: sub.agent, upsert, total: t.total, reset: false, prepend: true });
    return upsert.length;
  }

  // `toolOutput` from a page: the full result of one tool (transcripts.ts reads it again). A toast
  // when the file is gone or was rewritten.
  async toolOutput(client: Client, sid: string, agent: string | null, toolUseId: string): Promise<boolean> {
    const text = await this.transcripts.resultText(sid, agent, toolUseId);
    if (text === null) {
      client.send({ t: 'toast', text: "Synopia couldn't read that result again: the transcript file is gone or was rewritten." });
      return false;
    }
    client.send({ t: 'toolOutput', sid, agent: agent || null, toolUseId, text });
    return true;
  }

  // What `find` searches in a view (find.ts, R5.12e): a conversation's items (`view` a subagent's id, null for the
  // main one), else a `!` run's output, a monitor's events, or a shell's output file's last FIND_READ bytes.
  async findSource(sid: string, view: string | null): Promise<FindSource | null> {
    const t = this.transcripts.get(sid, view);
    if (t) return { items: t.items };
    if (view === null) return null;
    const own = this.pubs.get(sid)?.shown?.bangOutput(view);
    if (own) return { id: view, text: own.err ? `${own.out}\n${own.err}` : own.out };
    const o = this.transcripts.outputOf(sid, view);
    if (!o) return null;
    if (o.kind === 'monitor') return { id: view, text: o.events.map((e) => e.text).join('\n') };
    if (!o.file) return { id: view, text: '' };
    const size = await outputSize(o.file);
    const part = size < 0 ? null : await readOutput(o.file, Math.max(0, size - FIND_READ), size, true);
    return { id: view, text: part ? part.text : '' };
  }

  // `view` with `bg` (R7.2): the page shows a background shell's or monitor's output, the last part of
  // it (task-output.ts) or from `from` (where its loaded output began, before a reload), as one
  // `output` reset. Then what the shell or monitor adds, as `output` appends: on each flush of the
  // session (a monitor's events, a shell's file named) and each outputMs (a shell's file growing).
  // `lost`: "unnamed" when the transcript names no output file, "gone" when it can't be read.
  // Returns when the reset went (tests).
  // A `!` run of yours (R5.13, 2026-11-26) has its output in the session, not a file: each frame is a reset
  // with all of it, stdout as `text` and stderr as `err`, sent again when it changed.
  // A run Synopia holds a pty for (terms.ts, 2026-11-27) is a terminal: one `term` reset with the raw stream
  // kept, then each part as it comes (termPart).
  viewOutput(client: Client, sid: string, bg: string, from?: string | null): Promise<void> {
    const sub: Sub = { sid, agent: null, from: 0, bg, out: null };
    this.subs.set(client, sub);
    const term = this.opts.terms?.get(bg);
    if (term) {
      sub.term = true;
      return this.outRun(client, sub, async () => ({ t: 'term', sid, bg, ...termFields(term.snapshot()), reset: true }));
    }
    if (this.pubs.get(sid)?.shown?.bangOutput(bg)) {
      sub.own = '';
      return this.outRun(client, sub, async () => this.ownFrame(sub));
    }
    this.outTimers();
    const at = from && /^\d+$/.test(from) ? Number(from) : null;
    return this.outRun(client, sub, () => this.outReset(sub, at));
  }

  // `earlierOutput` from a page: the part before `before` of the output it shows, as a prepend.
  earlierOutput(client: Client, sid: string, bg: string, before: number): Promise<void> {
    const sub = this.subs.get(client);
    if (!sub || sub.sid !== sid || sub.bg !== bg || !sub.out) return Promise.resolve();
    return this.outRun(client, sub, async () => {
      const o = this.transcripts.outputOf(sid, bg), out = sub.out;
      if (!o || !out) return null;
      const part = o.kind === 'monitor' ? eventsBefore(o.events, before) : out.file ? await outputBefore(out.file, before) : null;
      if (!part || part.to > out.from) return null;
      out.from = part.from;
      return this.outFrame(sub, part, { prepend: true });
    });
  }

  // what a terminal's pty wrote, to each page that shows it
  private termPart(p: TermPart): void {
    for (const [client, sub] of this.liveSubs()) {
      if (sub.term && sub.bg === p.id) void this.outRun(client, sub, async () => ({ t: 'term', sid: sub.sid, bg: p.id, ...termFields(p) }));
    }
  }

  private ownFrame(sub: Sub): object | null {
    const o = this.pubs.get(sub.sid)?.shown?.bangOutput(sub.bg as string);
    if (!o) return null;
    const sig = `${o.running}|${o.out.length}|${o.err.length}|${o.out.slice(-64)}|${o.err.slice(-64)}`;
    if (sig === sub.own) return null;
    sub.own = sig;
    return { t: 'output', sid: sub.sid, bg: sub.bg, text: o.out, err: o.err, from: 0, to: o.out.length, total: o.out.length, reset: true };
  }

  // A look for more output of each shown shell or monitor of the session (all sessions: the timer's).
  private outMore(sid: string | null): void {
    for (const [client, sub] of this.liveSubs()) {
      if (sub.term) continue;
      if (sub.bg && sub.own !== undefined) {
        if (sid === null || sub.sid === sid) void this.outRun(client, sub, async () => this.ownFrame(sub));
        continue;
      }
      if (!sub.bg || (sid !== null && sub.sid !== sid) || sub.more) continue;
      sub.more = true;
      void this.outRun(client, sub, async () => {
        sub.more = false;
        const o = this.transcripts.outputOf(sub.sid, sub.bg as string), out = sub.out;
        if (!o && out) return null; // none (a foreground step's view, until it moves): its reset said so once
        if (!o || !out) return this.outReset(sub, null);
        if (o.kind === 'monitor') {
          const part = eventsFrom(o.events, out.to);
          if (part.total < out.to) return this.outReset(sub, null); // the transcript was read again
          if (!part.text && part.to === out.to) return null;
          out.to = part.to;
          return this.outFrame(sub, part, {});
        }
        if (o.file !== out.file) return this.outReset(sub, out.from);
        if (!out.file) return null;
        const size = await outputSize(out.file);
        if (size < 0 || size < out.to) return this.outReset(sub, null); // gone, or written again from the start
        if (size === out.to) return null;
        const part = await readOutput(out.file, out.to, size);
        if (!part || part.to === out.to) return null;
        out.to = part.to;
        return this.outFrame(sub, part, {});
      });
    }
  }

  private async outReset(sub: Sub, from: number | null): Promise<object> {
    const o = this.transcripts.outputOf(sub.sid, sub.bg as string);
    const empty: OutputPart = { text: '', from: 0, to: 0, total: 0 };
    if (!o) { sub.out = { file: null, from: 0, to: 0 }; return this.outFrame(sub, empty, { reset: true, lost: 'gone' }); }
    if (o.kind === 'monitor') {
      const part = eventTail(o.events, from);
      sub.out = { file: null, from: part.from, to: part.to };
      return this.outFrame(sub, part, { reset: true });
    }
    sub.out = { file: o.file, from: 0, to: 0 };
    if (!o.file) return this.outFrame(sub, empty, { reset: true, lost: 'unnamed' });
    const part = await outputTail(o.file, from);
    if (!part) return this.outFrame(sub, empty, { reset: true, lost: 'gone' });
    sub.out = { file: o.file, from: part.from, to: part.to };
    return this.outFrame(sub, part, { reset: true });
  }

  private outFrame(sub: Sub, part: OutputPart, how: { reset?: boolean; prepend?: boolean; lost?: string }): object {
    return { t: 'output', sid: sub.sid, bg: sub.bg, text: part.text, from: part.from, to: part.to, total: part.total, ...how };
  }

  // One output read of a page's view at a time, in order; its frame goes while the page still shows it.
  private outRun(client: Client, sub: Sub, job: () => Promise<object | null>): Promise<void> {
    sub.chain = (sub.chain ?? Promise.resolve()).then(job).then(
      (m) => { if (m && this.subs.get(client) === sub) client.send(m); },
      () => {},
    );
    return sub.chain;
  }

  // The look at shown shells' files runs only while a page shows one.
  private outTimers(): void {
    const every = this.opts.outputMs ?? 1000;
    const want = every > 0 && [...this.subs.values()].some((s) => s.bg);
    if (want && !this.outTimer) {
      this.outTimer = setInterval(() => { this.outMore(null); this.outTimers(); }, every);
      this.outTimer.unref?.();
    } else if (!want && this.outTimer) {
      clearInterval(this.outTimer);
      this.outTimer = null;
    }
  }

  // ---------- what others read ----------

  meta(id: string): SessionMeta | undefined {
    const p = this.pub(id);
    return p && this.metaOf(p);
  }

  // The sessions part of `hello`: meta, status, subagents, background work and the stream preview.
  sessions(): object[] {
    return this.transcripts.ids().map((id) => {
      const p = this.pub(id) as Pub;
      const t = this.transcripts.get(id) as Transcript;
      return { ...this.metaOf(p), agents: this.agentsOut(t.agents()), background: t.background(), stream: p.stream, held: p.held };
    });
  }

  pending(): { sid: string; request: PendingRequest }[] {
    return this.transcripts.ids().flatMap((sid) => (this.pubs.get(sid)?.pending ?? []).map((request) => ({ sid, request })));
  }

  // For the writer: the transcript's work lines (transcripts.ts), then the cards waiting on you, ours
  // or the one another process asks (R6.8), so the Now line says so. Undefined when it isn't open.
  work(id: string): string[] | undefined {
    const out = this.transcripts.work(id);
    const p = this.pub(id);
    if (!out || !p) return undefined;
    const cut = (v: unknown) => String(v ?? '').split('\n')[0].slice(0, 80);
    for (const r of p.pending) {
      const input = (r.input && typeof r.input === 'object' ? r.input : {}) as Record<string, unknown>;
      const qs = Array.isArray(input.questions) ? input.questions as { question?: unknown }[] : [];
      out.push(r.kind === 'question' ? `card waiting for you: question “${cut(qs[0]?.question)}”${qs.length > 1 ? ` and ${qs.length - 1} more` : ''}`
        : r.kind === 'plan' ? 'card waiting for you: approve the plan or ask for changes'
          : `card waiting for you: allow ${cut(r.toolName)} “${cut(input.description || input.command || input.file_path || r.title)}”`);
    }
    const ask = p.pending.length ? null : this.metaOf(p).ask;
    if (ask) {
      out.push(ask.kind === 'plan' ? 'card waiting for you: approve the plan or ask for changes'
        : `card waiting for you: question “${cut(ask.qs?.[0]?.q)}”${(ask.qs?.length ?? 0) > 1 ? ` and ${ask.qs!.length - 1} more` : ''}`);
    }
    return out;
  }

  // ---------- the flush ----------

  // Something a session shows changed: its frames go now, or right after the flush that runs.
  changed(sid: string): void {
    this.dirty.add(sid);
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.dirty.size) {
        const [next] = this.dirty;
        this.dirty.delete(next);
        this.flush(next);
      }
    } finally {
      this.flushing = false;
    }
  }

  // A flush after the current task (a card's count reaches the status first).
  private queue(sid: string): void {
    const p = this.pubs.get(sid);
    if (!p || p.queued) return;
    p.queued = true;
    queueMicrotask(() => {
      p.queued = false;
      this.changed(p.id);
    });
  }

  private flush(sid: string): void {
    const p = this.pub(sid);
    const t = this.transcripts.get(sid);
    const ch = this.transcripts.takeChanges(sid);
    if (!p || !t || !ch) return;
    // What landed: the session settles its queued messages and its `!` run against the new items.
    const ids = new Set(ch.items);
    p.shown?.landed(ids.size ? t.items.slice(-ids.size - 8).filter((i) => ids.has(i.id)) : []);
    this.trimSince(p, t, ch);
    // What runs by the transcript first: the status it sets is in this flush's meta.
    const ran = this.transcripts.running(sid);
    const ranKey = `${ran.agents}:${ran.turn}:${ran.ask?.toolUseId ?? ''}:${ran.apiError?.text ?? ''}`;
    if (ranKey !== p.ran) {
      p.ran = ranKey;
      this.opts.onRunning?.(sid, ran);
    }
    if (this.pubs.get(sid) !== p) return; // closed or moved meanwhile
    const meta = this.metaOf(p);
    this.opts.badge?.set(sid, badgeOf(meta.state));
    const key = JSON.stringify(meta);
    if (key !== p.sent) {
      p.sent = key;
      this.broadcast({ t: 'session', ...meta });
    }
    if (ch.agents.length) {
      this.broadcast({ t: 'agents', sid, upsert: this.agentsOut(ch.agents.map((id) => t.getAgent(id)).filter((a): a is Agent => Boolean(a))) });
    }
    if (ch.background.length) {
      this.broadcast({ t: 'background', sid, upsert: ch.background.map((id) => t.getBackground(id)).filter(Boolean) });
    }
    this.sendItems(sid, t, ch);
    this.outMore(sid);
    // A shell, monitor or subagent that was running ended (often between turns): the writer
    // looks again, as after a turn, so the Now line doesn't keep saying it runs.
    let ended = false;
    const track = (key: string, running: boolean) => {
      if (running) p.working.add(key);
      else if (p.working.delete(key)) ended = true;
    };
    for (const id of ch.background) { const b = t.getBackground(id); if (b) track(`b:${id}`, b.status === 'running'); }
    for (const id of ch.agents) { const a = t.getAgent(id); if (a) track(`a:${id}`, a.running); }
    if (ended) this.opts.onWorkEnded?.(sid);
  }

  private sendItems(sid: string, t: Transcript, ch: ReadChanges): void {
    for (const [client, sub] of this.liveSubs()) {
      // the shell view of Claude's foreground Bash (R7.2, 2026-11-26): its step is a main item, sent as it changes
      if (sub.sid === sid && sub.bg && !ch.reset && ch.items.includes(sub.bg)) this.sendUpserts(client, { ...sub, from: 0 }, t, [sub.bg]);
      if (sub.sid !== sid || sub.bg) continue;
      if (sub.agent === null) {
        if (ch.reset) this.sendReset(client, sub);
        else this.sendUpserts(client, sub, t, ch.items);
        continue;
      }
      const child = this.transcripts.get(sid, sub.agent), c = ch.children.get(sub.agent);
      if (!child || !c) continue;
      if (c.reset) this.sendReset(client, sub);
      else this.sendUpserts(client, sub, child, c.items);
    }
  }

  // A tool's start goes when it stops running.
  private trimSince(p: Pub, t: Transcript, ch: ReadChanges): void {
    if (!p.since.size) return;
    const check = (tr: Transcript | null, ids: string[]) => {
      for (const id of ids) {
        if (!p.since.has(id)) continue;
        const i = tr?.get(id);
        if (i && (i.k !== 'tool' || i.state !== 'running')) p.since.delete(id);
      }
    };
    check(t, ch.items);
    for (const [aid, c] of ch.children) check(this.transcripts.get(p.id, aid), c.items);
  }

  // ---------- the reading set's events ----------

  private closed(id: string): void {
    const p = this.pubs.get(id);
    if (p) this.armCommand(p, null);
    this.pubs.delete(id);
    this.dirty.delete(id);
    this.opts.badge?.drop(id);
    for (const [c, sub] of this.subs) if (sub.sid === id) this.subs.delete(c);
    this.broadcast({ t: 'removed', id });
  }

  // The whole record moves (status, cards, held messages, the stream preview, the choice, the work
  // seen running, the session's own state); the reading started again (transcripts.ts). The pages
  // viewing it move, and `session` goes with `replaces` once, with the layout that has the new id
  // (layout.ts), so the sidebar keeps the row in its place.
  private rekeyed(from: string, to: string): void {
    const p = this.pubs.get(from);
    this.pubs.delete(from);
    this.dirty.delete(from);
    this.opts.badge?.drop(from);
    const next = p ?? this.pub(to);
    if (!next) return;
    next.id = to;
    next.ran = '';
    this.pubs.set(to, next);
    const meta = this.metaOf(next);
    next.sent = JSON.stringify(meta);
    this.opts.badge?.set(to, badgeOf(meta.state));
    const layout = this.opts.layout?.();
    this.broadcast({ t: 'session', replaces: from, ...meta, ...(layout ? { layout } : {}) });
    for (const [client, sub] of this.liveSubs()) {
      if (sub.sid !== from) continue;
      sub.sid = to;
      sub.agent = null;
      if (sub.bg) void this.outRun(client, sub, () => this.outReset(sub, null));
      else this.sendReset(client, sub);
    }
  }

  // ---------- helpers ----------

  private pub(sid: string): Pub | undefined {
    let p = this.pubs.get(sid);
    if (p || !this.transcripts.has(sid)) return p;
    p = {
      id: sid, status: null, statusAt: 0, statusDetail: {}, choice: null, pending: [], held: [], stream: null,
      sent: '', ran: '', working: new Set(), since: new Map(), cmdTimer: null, cmdDue: 0, shown: null, queued: false, gone: false,
    };
    this.pubs.set(sid, p);
    return p;
  }

  private metaOf(p: Pub): SessionMeta {
    const t = this.transcripts.get(p.id) as Transcript;
    const first = t.items.find((i) => i.k === 'you')?.text ?? '';
    const w = this.opts.written?.(p.id);
    const ran = this.transcripts.running(p.id);
    const status: Status = p.status ?? transcriptStatus(ran);
    let statusAt = p.statusAt;
    if (!p.status) {
      statusAt = this.transcripts.lastAt(p.id);
      // your turn after background subagents: its age counts from when the last one finished
      for (const a of t.agents()) if (a.end && !a.running) statusAt = Math.max(statusAt, Date.parse(a.end) || 0);
      if (ran.ask?.since) statusAt = ran.ask.since;
    }
    // R6.8: the question or plan another process asks, which the page shows read-only. Only while
    // it is what makes the session need you: not with a request of ours, nor for an ask our own
    // process left behind (status.ts gives that no waiting, and the page reads "Not answered").
    const ask = status === 'waiting' && !p.pending.length ? ran.ask ?? null : null;
    // FR-SES-06: your rename, then Claude's title, then the CLI's ai-title, then the first prompt.
    const title = t.customTitle || w?.title || t.aiTitle || first.split('\n')[0].slice(0, 80) || 'New session';
    return {
      id: p.id,
      title,
      // R3.4: the CLI's own name for it (its ai-title), shown small in the header so you recognise
      // its terminal tab; only while another process (a terminal) holds it, not in a session Synopia
      // runs, which has no tab, and left out while it is the title itself.
      name: t.aiTitle && t.aiTitle !== title && (p.statusDetail.terminal || p.statusDetail.external) ? t.aiTitle : '',
      now: w?.now ?? '',
      cwd: displayPath(this.transcripts.cwdOf(p.id), this.home),
      prs: t.prs,
      // From the transcript until a session sets it: working while subagents or forks run, else your
      // turn, or the main turn runs in another process (status.ts transcriptStatus). The page shows
      // what status.ts sessionState makes of it, words and marks included.
      state: sessionState({ status, at: statusAt, detail: p.statusDetail }, {
        pending: p.pending.map((r) => needsOf(r.kind)),
        ask,
        interrupted: interruptedLast(t.items),
        command: this.commandOf(p, t),
        background: this.backgroundOf(t),
        input: Boolean(p.shown?.bang()?.running && p.shown.bang()?.waiting),
        review: t.agents().filter((a) => a.finished && this.toReview(a)).length,
        // a status from Synopia's own process, not the transcript alone nor a terminal that holds it
        driven: p.status !== null && !p.statusDetail.terminal && !p.statusDetail.external,
      }),
      ask,
      ...resolveModel(p.choice, { model: typeof t.requestedModel === 'string' ? t.requestedModel : null, effort: effortOf(t.effort) }, this.opts.defaultModel?.()),
      outbox: p.shown?.outbox() ?? [],
      bang: p.shown?.bang() ?? null,
      bangs: p.shown?.bangs() ?? [],
      gone: p.gone,
    };
  }

  // Items as the pages get them: a running tool whose start is known carries it as `since`.
  private dress(sid: string, items: Item[]): Item[] {
    const since = this.pubs.get(sid)?.since;
    if (!since?.size) return items;
    return items.map((i) => {
      const at = i.k === 'tool' && i.state === 'running' ? since.get(i.id) : undefined;
      return at === undefined ? i : { ...i, since: new Date(at).toISOString() } as Item;
    });
  }

  private sendReset(client: Client, sub: Sub, from?: string | null): void {
    const t = this.transcripts.get(sub.sid, sub.agent);
    const at = t && from ? t.items.findIndex((i) => i.id === from) : -1;
    const v = !t ? { items: [], total: 0 }
      : at >= 0 && at < t.items.length - WINDOW ? { items: t.items.slice(at), total: t.items.length } : t.view(WINDOW);
    sub.from = v.total - v.items.length;
    client.send({ t: 'items', sid: sub.sid, agent: sub.agent, upsert: this.dress(sub.sid, v.items), total: v.total, reset: true });
  }

  private sendUpserts(client: Client, sub: Sub, t: Transcript, changed: string[]): void {
    if (!changed.length) return;
    const ids = new Set(changed);
    const upsert: Item[] = this.dress(sub.sid, t.items.slice(sub.from).filter((i) => ids.has(i.id)));
    if (upsert.length) client.send({ t: 'items', sid: sub.sid, agent: sub.agent, upsert, total: t.total, reset: false });
  }

  // Subscriptions of pages still connected; a closed page's subscription goes.
  private liveSubs(): [Client, Sub][] {
    const clients = this.opts.clients();
    for (const c of this.subs.keys()) if (!clients.has(c)) this.subs.delete(c);
    return [...this.subs];
  }

  // The command the main turn waits on (status.ts commandOf, R8.2, 2026-11-27): its own Bash step, or a foreground
  // subagent's, once it has run COMMAND_MS. A younger one arms a flush for when it gets there.
  private commandOf(p: Pub, t: Transcript): Command | null {
    const threadOf = (tr: Transcript): Thread => ({
      items: tr.items,
      child: (tid) => {
        const a = t.agents().find((x) => x.toolUseId === tid);
        const sub = a && this.transcripts.get(p.id, a.id);
        return a && sub ? { thread: threadOf(sub), name: a.description } : null;
      },
    });
    const since = (it: Item) => p.since.get(it.id) ?? (it.ts ? Date.parse(it.ts) || null : null);
    const { command, due } = commandOf(threadOf(t), since, Date.now());
    this.armCommand(p, due);
    return command;
  }

  private armCommand(p: Pub, due: number | null): void {
    if (due !== null && p.cmdTimer && p.cmdDue === due) return;
    if (p.cmdTimer) clearTimeout(p.cmdTimer);
    p.cmdTimer = null;
    p.cmdDue = due ?? 0;
    if (due === null) return;
    p.cmdTimer = setTimeout(() => { p.cmdTimer = null; this.changed(p.id); }, Math.max(0, due - Date.now()) + 50);
    p.cmdTimer.unref?.();
  }

  // Claude's background work (status.ts backgroundOf, R8.2, 2026-11-27): what runs, as the Main conversation card counts
  // it, and whether a job's report waits for Claude to read it. A monitor past its timeout has timed out (runs.js bgState).
  private backgroundOf(t: Transcript): { running: number; report: boolean } {
    const now = Date.now();
    const agents = t.agents().map((a) => ({ id: a.id, running: a.running, stopped: a.stopped, end: a.end, ...(a.parent ? { parent: a.parent } : {}) }));
    const shells = t.background().map((b) => {
      const out = b.kind === 'monitor' && typeof b.timeout === 'number' && b.timeout > 0 && !b.persistent && b.start && Date.parse(b.start) + b.timeout < now;
      return { running: b.status === 'running' && !out, stopped: b.status === 'killed' || b.status === 'stopped', end: b.end, ...(b.agentId ? { agentId: b.agentId } : {}) };
    });
    return backgroundOf(agents, shells, lastWordsMs(t.items), now);
  }

  // A "For review: …" subagent not marked reviewed yet (R10.1).
  private toReview(a: Agent): boolean {
    return a.review && !this.opts.reviewed?.(a.id);
  }

  // Subagents as the pages get them: `review` is true while the deliverable waits to be reviewed.
  private agentsOut(list: Agent[]): Agent[] {
    return list.map((a) => (a.review && !this.toReview(a) ? { ...a, review: false } : a));
  }
}

// The page's kinds for a request: a plan, a permission, else a question.
function needsOf(kind: string): Needs {
  return kind === 'plan' ? 'plan' : kind === 'permission' ? 'permission' : 'question';
}

// Stopped by you: the latest item (a retitle after Esc Esc aside) is the `stop` interrupt marker.
// claude-jsonl.ts sets `interrupted` for that marker only; a turned-down tool is `turnedDown`.
function interruptedLast(items: Item[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].k === 'title') continue;
    return items[i].k === 'you' && items[i].interrupted === true;
  }
  return false;
}


const termFields = (p: TermPart) => ({ data: p.data, from: p.from, to: p.to, live: p.live });
