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
import { transcriptStatus, sessionState, badgeOf } from './status.ts';
import type { BadgeCounter, Running, SessionState, Needs, Status, StatusDetail } from './status.ts';
import type { Agent, Item, PendingAsk, Transcript } from './transcript.ts';
import { Transcripts, WINDOW, effortOf } from './transcripts.ts';
import type { ReadChanges } from './transcripts.ts';
import type { Client } from './server.ts';
import { displayPath } from './paths.ts';
import { resolveModel } from './session.ts';
import type { ModelChoice, QueuedMessage, ShownBang } from './session.ts';
import type { PendingRequest } from './cards.ts';
import type { Returned } from './sdk.ts';
import { VERSION } from '../../web/js/protocol.js';

export { WINDOW } from './transcripts.ts';
export const RECHECK_MS = 60_000;

export type SessionMeta = {
  id: string; title: string; name: string; now: string; cwd: string; prs: unknown[];
  state: SessionState; model: unknown; effort: unknown;
  ask: PendingAsk | null; outbox: QueuedMessage[]; bang: ShownBang | null;
};

// What a session shows that it owns itself (session.ts): its queued messages and its `!` run, and
// what it makes of the prompt and bash items that just landed (before the meta is built).
export type Shown = {
  outbox(): QueuedMessage[];
  bang(): ShownBang | null;
  landed(items: Item[]): void;
};

export type PublisherOptions = {
  transcripts: Transcripts;
  clients: () => Set<Client>;
  home?: string; // for `~` in paths; the fixtures use their own
  // A turn running by the transcript alone ends after QUIET_MS without a change: every session is
  // flushed this often to notice. 0 turns it off (tests).
  recheckMs?: number;
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
};

// What `hello` carries besides the sessions and their cards (main.ts gathers it).
export type Hello = { code: string; layout: unknown; menu: unknown; ui: unknown; update: boolean };

type Sub = { sid: string; agent: string | null; from: number };
type Pub = {
  id: string;
  status: Status | null; statusAt: number; statusDetail: StatusDetail; // set by session.ts; null: from the transcript
  choice: ModelChoice | null; pending: PendingRequest[]; held: string[]; stream: string | null;
  sent: string; // the last `session` meta sent
  ran: string; // the last Running given to onRunning
  working: Set<string>; // background work and subagents seen running, to tell when one ends
  since: Map<string, number>; // tool use id -> when a running tool started, from the SDK's tool_progress (R5.6)
  shown: Shown | null;
  queued: boolean;
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

  constructor(opts: PublisherOptions) {
    this.opts = opts;
    this.transcripts = opts.transcripts;
    this.home = opts.home ?? os.homedir();
    this.transcripts.listen({
      changed: (sid) => this.changed(sid),
      closed: (sid) => this.closed(sid),
      rekeyed: (from, to) => this.rekeyed(from, to),
    });
    const every = opts.recheckMs ?? RECHECK_MS;
    if (every > 0) {
      this.recheck = setInterval(() => { for (const id of this.transcripts.ids()) this.changed(id); }, every);
      this.recheck.unref?.();
    }
  }

  stop(): void {
    if (this.recheck) clearInterval(this.recheck);
    this.recheck = null;
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
    for (const [client, sub] of this.liveSubs()) if (sub.sid === sid && sub.agent === null) client.send({ t: 'stream', sid, text });
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
  // `since` (ISO).
  toolProgress(sid: string, toolUseId: string, elapsedSeconds: number, now = Date.now()): void {
    const p = this.pub(sid);
    if (!p || p.since.has(toolUseId) || !Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) return;
    p.since.set(toolUseId, now - Math.round(elapsedSeconds * 1000));
    for (const [client, sub] of this.liveSubs()) {
      if (sub.sid !== sid) continue;
      const t = this.transcripts.get(sid, sub.agent);
      if (t) this.sendUpserts(client, sub, t, [toolUseId]);
    }
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
  view(client: Client, sid: string, agent: string | null, from?: string | null): void {
    const sub: Sub = { sid, agent: agent || null, from: 0 };
    this.subs.set(client, sub);
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
    if (!sub || sub.sid !== sid || sub.agent !== (agent || null)) return 0;
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
    const ranKey = `${ran.agents}:${ran.turn}:${ran.ask?.toolUseId ?? ''}`;
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
      if (sub.sid !== sid) continue;
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
      this.sendReset(client, sub);
    }
  }

  // ---------- helpers ----------

  private pub(sid: string): Pub | undefined {
    let p = this.pubs.get(sid);
    if (p || !this.transcripts.has(sid)) return p;
    p = {
      id: sid, status: null, statusAt: 0, statusDetail: {}, choice: null, pending: [], held: [], stream: null,
      sent: '', ran: '', working: new Set(), since: new Map(), shown: null, queued: false,
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
      // it from the terminal; left out while it is the title itself.
      name: t.aiTitle && t.aiTitle !== title ? t.aiTitle : '',
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
        review: t.agents().filter((a) => a.finished && this.toReview(a)).length,
        // a status from Synopia's own process, not the transcript alone nor a terminal that holds it
        driven: p.status !== null && !p.statusDetail.terminal && !p.statusDetail.external,
      }),
      ask,
      ...resolveModel(p.choice, { model: typeof t.requestedModel === 'string' ? t.requestedModel : null, effort: effortOf(t.effort) }, this.opts.defaultModel?.()),
      outbox: p.shown?.outbox() ?? [],
      bang: p.shown?.bang() ?? null,
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
