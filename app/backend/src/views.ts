// The transcripts service: one tailer and one reducer per open session and per subagent,
// and the protocol messages that come from them (plan sections 5 and 7). It sends `session`
// meta, `agents` and `background` to every page, and `items` only to the pages viewing that
// conversation: a reset with the last WINDOW items (or from the page's `from`) on `view`, then upserts of changed ids, and
// the WINDOW items before the oldest shown on `earlier`.
// It also holds the status, the pending requests and the stream preview a driver sets.
// A session opened before its file exists (a new one) looks for it again every second.
import fs from 'node:fs';
import os from 'node:os';
import { Tailer, SubagentWatcher } from './tail.ts';
import type { JsonRecord } from './tail.ts';
import { Transcript, findTranscript, sessionDirOf, readResult, readImage, IMAGE_TYPES } from './transcript.ts';
import type { Item, PendingAsk } from './transcript.ts';
import type { Client } from './server.ts';
import type { Log } from './log.ts';
import { nullLog } from './log.ts';
import { transcriptStatus, QUIET_MS, ASK_STALE_MS } from './status.ts';
import type { Running } from './status.ts';
import type { Status, StatusDetail } from './status.ts';
import { displayPath } from './paths.ts';

export type { Status } from './status.ts';
export const WINDOW = 160;

export type PendingRequest = { id: string; kind: 'question' | 'permission' | 'plan'; since: number; [k: string]: unknown };
export type SessionMeta = {
  id: string; title: string; name: string; now: string; cwd: string; prs: unknown[];
  status: Status; statusAt: number; statusDetail: StatusDetail; model: unknown; effort: unknown;
  ask: PendingAsk | null;
};

type Sub = { sid: string; agent: string | null; from: number };
type Child = { t: Transcript; tailer: Tailer; calm: number; skip: number }; // calm: scans with nothing new
const CALM_SCANS = 3;
const SLOW_SCANS = 10;
type Live = {
  id: string; path: string | null; cwd: string; t: Transcript;
  tailer: Tailer | null; watcher: SubagentWatcher | null; children: Map<string, Child>;
  status: Status | null; statusAt: number; statusDetail: StatusDetail; stream: string | null; pending: PendingRequest[]; held: string[];
  sent: string; needReset: boolean; resetChildren: Set<string>; queued: boolean;
  finder: NodeJS.Timeout | null;
  working: Set<string>; // background work and subagents seen running, to tell when one ends
  ran: string; // the last Running sent to onRunning
};

export type ViewsOptions = {
  claudeDir: string;
  clients: () => Set<Client>;
  home?: string; // for `~` in paths; the fixtures use their own
  log?: Log;
  pollMs?: number; // passed to the tailers; 0 turns polling off (tests call check())
  watch?: boolean;
  // Each assistant record of a main conversation as it lands: its message id and block types.
  onAssistant?: (sid: string, messageId: string, blockTypes: string[]) => void;
  // Slice 6: the title and Now line Claude wrote for a session (state.json `written`).
  written?: (sid: string) => { title?: string; now?: string } | undefined;
  // Slice 3: the card answer stored for a tool use, shown as your turn in the transcript.
  answerOf?: (toolUseId: string) => string | undefined;
  // The plan text an answered plan card showed (state.json `plans`).
  planOf?: (toolUseId: string) => string | undefined;
  // Slice 5: the model and effort you chose for a session (state.json `models`), shown over the transcript's.
  choice?: (sid: string) => { model: string; effort?: string | null } | undefined;
  // settings.model: what a session with no choice and no model in its transcript starts with.
  defaultModel?: () => string | undefined;
  // After each message to the pages (the Dock badge recounts from it, debounced).
  onChange?: () => void;
  // What runs by the transcript changed: subagents and forks, and the main turn (status.ts setRunning).
  onRunning?: (sid: string, r: Running) => void;
  // A background shell, monitor or subagent of the session stopped running.
  onWorkEnded?: (sid: string) => void;
};

// The transcript's effort: a level, or {level} on some records.
const effortOf = (e: unknown): string | null => typeof e === 'string' ? e
  : e && typeof (e as { level?: unknown }).level === 'string' ? (e as { level: string }).level : null;

const tilde = (p: string, home: string): string => displayPath(p, home);

export class Views {
  private opts: ViewsOptions;
  private home: string;
  private log: Log;
  private live = new Map<string, Live>();
  private subs = new Map<Client, Sub>();

  private recheck: NodeJS.Timeout | null = null;

  constructor(opts: ViewsOptions) {
    this.opts = opts;
    this.home = opts.home ?? os.homedir();
    this.log = opts.log ?? nullLog;
    // A turn running by the transcript alone ends after QUIET_MS without a change: look again each minute.
    if (opts.watch !== false) {
      this.recheck = setInterval(() => { for (const s of this.live.values()) this.flush(s); }, 60_000);
      this.recheck.unref?.();
    }
  }

  ids(): string[] {
    return [...this.live.keys()];
  }

  // Starts tailing a session. Its file is found under projects/*/ (a new session has none yet).
  open(id: string, init: { cwd?: string; path?: string } = {}): void {
    if (this.live.has(id)) return;
    const file = init.path ?? findTranscript(this.opts.claudeDir, id);
    const s: Live = {
      id, path: file, cwd: init.cwd ?? '', t: new Transcript({ home: this.home, answerOf: this.opts.answerOf, planOf: this.opts.planOf }),
      tailer: null, watcher: null, children: new Map(),
      status: null, statusAt: 0, statusDetail: {}, stream: null, pending: [], held: [],
      sent: '', needReset: false, resetChildren: new Set(), queued: false, finder: null, working: new Set(), ran: '',
    };
    this.live.set(id, s);
    this.log('views.open', { sid: id, found: Boolean(file) });
    if (file) this.attach(s, file);
    else if (this.opts.pollMs !== 0) s.finder = setInterval(() => this.find(s), this.opts.pollMs ?? 1000);
  }

  // A new session's file appears with its first turn.
  private find(s: Live): void {
    if (s.path || this.live.get(s.id) !== s) return;
    const file = findTranscript(this.opts.claudeDir, s.id);
    if (!file) return;
    if (s.finder) clearInterval(s.finder);
    s.finder = null;
    this.log('views.found', { sid: s.id });
    this.attach(s, file);
  }

  private attach(s: Live, file: string): void {
    s.path = file;
    const tail = { pollMs: this.opts.pollMs, watch: this.opts.watch };
    s.tailer = new Tailer(file, {
      ...tail,
      onRecords: (records, spans) => {
        if (!s.cwd) s.cwd = cwdOf(records);
        s.t.pushAll(records, spans);
        if (this.opts.onAssistant) landed(records, (mid, types) => this.opts.onAssistant?.(s.id, mid, types));
        this.queue(s);
      },
      onReset: () => {
        s.t.reset();
        s.needReset = true;
        this.queue(s);
      },
    }).start();
    s.watcher = new SubagentWatcher(sessionDirOf(file), {
      onAgent: (aid, afile) => {
        const t = new Transcript({ sidechain: true, home: this.home, answerOf: this.opts.answerOf, planOf: this.opts.planOf });
        s.t.setAgent(aid, undefined, t);
        // No timer or watch of its own: the folder's watcher reads it after each scan (onScan).
        const tailer = new Tailer(afile, {
          pollMs: 0,
          watch: false,
          onRecords: (records, spans) => {
            t.pushAll(records, spans);
            s.t.setAgent(aid, undefined); // its total, start and end changed
            this.queue(s);
          },
          onReset: () => {
            t.reset();
            s.resetChildren.add(aid);
            this.queue(s);
          },
        });
        s.children.set(aid, { t, tailer, calm: 0, skip: 0 });
        tailer.start();
      },
      onMeta: (aid, meta) => {
        s.t.setAgent(aid, meta);
        this.queue(s);
      },
      // Running subagents are read at every scan; a finished one whose file stopped growing only
      // every SLOW_SCANS scans (it can be woken again).
      onScan: () => {
        for (const [aid, c] of s.children) {
          if (!s.t.agentRunning(aid) && c.calm >= CALM_SCANS && ++c.skip % SLOW_SCANS !== 0) continue;
          c.calm = c.tailer.check() ? 0 : c.calm + 1;
        }
      },
    }, tail).start();
  }

  close(id: string): void {
    const s = this.live.get(id);
    if (!s) return;
    this.stopOne(s);
    this.live.delete(id);
    for (const [c, sub] of this.subs) if (sub.sid === id) this.subs.delete(c);
    this.broadcast({ t: 'removed', id });
  }

  // The session's id changed (a new session's real id from system/init, or a conversation_reset):
  // it tails the new id's file from the start, keeps its folder and status, moves the pages
  // viewing it, and sends `session` with `replaces` once.
  rekey(oldId: string, newId: string): void {
    const s = this.live.get(oldId);
    if (!s || this.live.has(newId)) return;
    this.stopOne(s);
    this.live.delete(oldId);
    this.open(newId, { cwd: s.cwd });
    const n = this.live.get(newId) as Live;
    n.status = s.status;
    n.statusAt = s.statusAt;
    n.statusDetail = s.statusDetail;
    // the driver's state moves too: a card still up, the messages held behind it, the preview
    n.pending = s.pending;
    n.held = s.held;
    n.stream = s.stream;
    const meta = this.metaOf(n);
    n.sent = JSON.stringify(meta);
    this.broadcast({ t: 'session', replaces: oldId, ...meta });
    for (const [client, sub] of this.liveSubs()) {
      if (sub.sid !== oldId) continue;
      sub.sid = newId;
      sub.agent = null;
      this.sendReset(client, sub);
    }
  }

  // What a driver needs from the transcript to start a process.
  facts(id: string): {
    model: string | null; effort: string | null; permissionMode: string | null; modeBeforePlan: string | null; working: boolean; runningWork: ('subagent' | 'shell' | 'monitor')[];
  } | undefined {
    const s = this.live.get(id);
    if (!s) return undefined;
    const t = s.t;
    const effort = effortOf(t.effort);
    const runningWork = [
      ...t.agents().filter((a) => a.running).map(() => 'subagent' as const),
      ...t.background().filter((b) => b.status === 'running').map((b) => b.kind),
    ];
    return {
      runningWork,
      model: typeof t.requestedModel === 'string' ? t.requestedModel : null,
      effort,
      permissionMode: t.permissionMode,
      modeBeforePlan: t.lastNonPlanMode,
      // a subagent or background shell or monitor still running
      working: runningWork.length > 0,
    };
  }

  stop(): void {
    if (this.recheck) clearInterval(this.recheck);
    this.recheck = null;
    for (const s of this.live.values()) this.stopOne(s);
  }

  private stopOne(s: Live): void {
    if (s.finder) clearInterval(s.finder);
    s.finder = null;
    s.tailer?.stop();
    s.watcher?.stop();
    for (const c of s.children.values()) c.tailer.stop();
  }

  // Reads what is new right now (tests and the fixture builder; live sessions rely on the timers).
  check(): void {
    for (const s of this.live.values()) {
      if (!s.path) this.find(s);
      s.watcher?.scan();
      s.tailer?.check();
      for (const c of s.children.values()) c.tailer.check();
      this.flush(s);
    }
  }

  meta(id: string): SessionMeta | undefined {
    const s = this.live.get(id);
    return s && this.metaOf(s);
  }

  // What runs now by the transcript (nothing when it isn't open): subagents and forks, the main turn.
  running(id: string): Running {
    const s = this.live.get(id);
    return s ? runningOf(s.t, s.path) : { agents: 0, turn: false, lastAt: 0, ask: null };
  }

  private metaOf(s: Live): SessionMeta {
    const t = s.t;
    const first = t.items.find((i) => i.k === 'you')?.text ?? '';
    const w = this.opts.written?.(s.id);
    const ch = this.opts.choice?.(s.id);
    const ran = runningOf(t, s.path);
    const status = s.status ?? transcriptStatus(ran);
    let statusAt = s.statusAt;
    if (!s.status) {
      statusAt = (t.lastTs && Date.parse(t.lastTs)) || mtimeOf(s.path) || 0;
      // your turn after background subagents: its age counts from when the last one finished
      for (const a of t.agents()) if (a.end && !a.running) statusAt = Math.max(statusAt, Date.parse(a.end) || 0);
      if (ran.ask?.since) statusAt = ran.ask.since;
    }
    // Section 10: your rename, then Claude's title, then the CLI's ai-title.
    const title = t.customTitle || w?.title || t.aiTitle || first.split('\n')[0].slice(0, 80) || 'New session';
    return {
      id: s.id,
      title,
      // R3.4: the CLI's own name for it (its ai-title), shown small in the header so you recognise
      // it from the terminal; left out while it is the title itself.
      name: t.aiTitle && t.aiTitle !== title ? t.aiTitle : '',
      now: w?.now ?? '',
      cwd: tilde(s.cwd, this.home),
      prs: t.prs,
      // From the transcript until a driver sets it: working while subagents or forks run, else your
      // turn, or the main turn runs in another process (status.ts transcriptStatus). "Stopped" is read
      // from the items by the page.
      status,
      statusAt,
      statusDetail: s.statusDetail,
      // whether this status comes from Synopia's own process (the driver) rather than the transcript:
      // only then can the page offer Esc, Esc to interrupt
      driven: s.status !== null,
      // R6.8: the question or plan another process asks, which the page shows read-only. Only while
      // it is what makes the session need you: not with a request of ours, nor for an ask our own
      // process left behind (status.ts gives that no waiting, and the page reads "Not answered").
      ask: status === 'waiting' && !s.pending.length ? ran.ask ?? null : null,
      model: ch ? ch.model : t.requestedModel ?? this.opts.defaultModel?.() ?? null,
      effort: ch ? ch.effort ?? null : effortOf(t.effort),
    };
  }

  // Slice 6: the turns the writer reads, oldest first: each prompt you typed and Claude's text
  // until the next one. Undefined when the session isn't open.
  turns(id: string): { you: string; claude: string }[] | undefined {
    const s = this.live.get(id);
    if (!s) return undefined;
    const out: { you: string; claude: string }[] = [];
    for (const i of s.t.items) {
      if (i.k === 'you' && !i.interrupted) out.push({ you: i.text ?? '', claude: '' });
      else if (i.k === 'you' && out.length) {
        // An Esc Esc interrupt: say so, or the writer reads the turn as still waiting on its tool.
        const cur = out[out.length - 1];
        cur.claude = cur.claude ? `${cur.claude}\n\n(You interrupted this turn.)` : '(You interrupted this turn.)';
      } else if (i.k === 'claude' && out.length) {
        const cur = out[out.length - 1];
        cur.claude = cur.claude ? `${cur.claude}\n\n${i.text ?? ''}` : i.text ?? '';
      }
    }
    return out;
  }

  // For the writer: the background work that runs now, and what ended since your last message,
  // one line each ("shell “npm test”: running"), then the cards waiting on you. Empty without any.
  work(id: string): string[] | undefined {
    const s = this.live.get(id);
    if (!s) return undefined;
    const lastYou = [...s.t.items].reverse().find((i) => i.k === 'you')?.ts ?? '';
    const recent = (end: string | null) => !lastYou || (end !== null && end >= lastYou);
    const out: string[] = [];
    for (const b of s.t.background()) {
      if (b.agentId) continue; // a subagent's own: its subagent's line covers it
      if (b.status !== 'running' && !recent(b.end)) continue;
      out.push(`${b.kind} “${(b.description || b.command).slice(0, 80)}”: ${b.status === 'completed' ? 'finished' : b.status}`);
    }
    for (const a of s.t.agents()) {
      if (!a.running && !recent(a.end)) continue;
      out.push(`${a.fork ? 'fork' : 'subagent'} “${a.description.slice(0, 80)}”: ${a.running ? 'running' : a.stopped ? 'stopped' : 'finished'}`);
    }
    // the cards waiting on you, ours or the one another process asks (R6.8), so the Now line says so
    const cut = (v: unknown) => String(v ?? '').split('\n')[0].slice(0, 80);
    for (const r of s.pending) {
      const input = (r.input && typeof r.input === 'object' ? r.input : {}) as Record<string, unknown>;
      const qs = Array.isArray(input.questions) ? input.questions as { question?: unknown }[] : [];
      out.push(r.kind === 'question' ? `card waiting for you: question “${cut(qs[0]?.question)}”${qs.length > 1 ? ` and ${qs.length - 1} more` : ''}`
        : r.kind === 'plan' ? 'card waiting for you: approve the plan or ask for changes'
          : `card waiting for you: allow ${cut(r.toolName)} “${cut(input.description || input.command || input.file_path || r.title)}”`);
    }
    const ask = s.pending.length ? null : this.metaOf(s).ask;
    if (ask) {
      out.push(ask.kind === 'plan' ? 'card waiting for you: approve the plan or ask for changes'
        : `card waiting for you: question “${cut(ask.qs?.[0]?.q)}”${(ask.qs?.length ?? 0) > 1 ? ` and ${ask.qs!.length - 1} more` : ''}`);
    }
    return out;
  }

  // Slice 6: the written text changed; send `session` if the meta did.
  refresh(id: string): void {
    const s = this.live.get(id);
    if (s) this.flush(s);
  }

  // The sessions part of `hello`: meta, status, subagents, background work and the stream preview.
  sessions(): object[] {
    return [...this.live.values()].map((s) => ({
      ...this.metaOf(s), agents: s.t.agents(), background: s.t.background(), stream: s.stream, held: s.held,
    }));
  }

  pending(): { sid: string; request: PendingRequest }[] {
    return [...this.live.values()].flatMap((s) => s.pending.map((request) => ({ sid: s.id, request })));
  }

  // Everything one session would show, items included (the prototype fixture builder uses it).
  dump(id: string): object | undefined {
    const s = this.live.get(id);
    if (!s) return undefined;
    const v = s.t.view(WINDOW);
    return {
      ...this.metaOf(s), items: v.items, total: v.total, background: s.t.background(), stream: s.stream,
      pending: s.pending,
      agents: s.t.agents().map((a) => ({ ...a, items: s.children.get(a.id)?.t.view(WINDOW).items ?? [] })),
    };
  }

  // `view` from a page: it now watches this conversation, and gets it from the start. `from` is the
  // oldest item the page had loaded for it (its earlier items, ui.js): one reset from that item to
  // the end, so the page renders once. Without it, or when it is gone or within the last WINDOW,
  // the last WINDOW items.
  view(client: Client, sid: string, agent: string | null, from?: string | null): void {
    const sub: Sub = { sid, agent: agent || null, from: 0 };
    this.subs.set(client, sub);
    this.sendReset(client, sub, from);
  }

  // `earlier` from a page: the WINDOW items before `before` (the oldest item it shows), sent with
  // `prepend`. The page's window grows to them, so later upserts of those items reach it too.
  // A reply only for the conversation the page views, and only while `before` is still in it
  // (after a rewrite the page gets a reset instead). Returns how many items went out.
  earlier(client: Client, sid: string, agent: string | null, before: string): number {
    const sub = this.subs.get(client);
    if (!sub || sub.sid !== sid || sub.agent !== (agent || null)) return 0;
    const t = this.transcriptOf(sub.sid, sub.agent);
    if (!t) return 0;
    const end = t.items.findIndex((i) => i.id === before);
    if (end < 0) return 0;
    const start = Math.max(0, end - WINDOW);
    sub.from = Math.min(sub.from, start);
    const upsert = t.items.slice(start, end);
    client.send({ t: 'items', sid: sub.sid, agent: sub.agent, upsert, total: t.total, reset: false, prepend: true });
    return upsert.length;
  }

  // `toolOutput` from a page: the full result of one tool, read again from its record's line in the
  // file (only its preview is kept in memory). A toast when the file is gone or was rewritten.
  toolOutput(client: Client, sid: string, agent: string | null, toolUseId: string): boolean {
    const s = this.live.get(sid);
    const t = this.transcriptOf(sid, agent);
    const file = agent ? s?.children.get(agent)?.tailer.path : s?.path;
    const span = t?.resultSpan(toolUseId);
    const text = file && span ? readResult(file, span, toolUseId) : null;
    if (text === null) {
      client.send({ t: 'toast', text: "Synopia couldn't read that result again: the transcript file is gone or was rewritten." });
      return false;
    }
    client.send({ t: 'toolOutput', sid, agent: agent || null, toolUseId, text, truncated: false });
    return true;
  }

  // `GET /api/image`: one image block, read again from its record's line and decoded (items carry only
  // its ref). 404 for an unknown ref or a file that is gone or was rewritten, 415 for a type not served.
  image(sid: string, agent: string | null, ref: string): { status: 200; type: string; body: Buffer } | { status: 404 | 415 } {
    const s = this.live.get(sid);
    const t = this.transcriptOf(sid, agent);
    const file = agent ? s?.children.get(agent)?.tailer.path : s?.path;
    const at = t?.imageAt(ref);
    const img = file && at ? readImage(file, at.span, at.recordId, at.path) : null;
    if (!img) return { status: 404 };
    if (!IMAGE_TYPES.includes(img.mediaType)) return { status: 415 };
    return { status: 200, type: img.mediaType, body: img.data };
  }

  // detail: the queued count and the retry of status.ts, for the page's words.
  setStatus(sid: string, status: Status, at = Date.now(), detail: StatusDetail = {}): void {
    const s = this.live.get(sid);
    if (!s) return;
    s.status = status;
    s.statusAt = at;
    s.statusDetail = detail;
    this.flush(s);
  }

  setPending(sid: string, request: PendingRequest): void {
    const s = this.live.get(sid);
    if (!s) return;
    s.pending = [...s.pending.filter((r) => r.id !== request.id), request];
    this.broadcast({ t: 'pending', sid, request });
  }

  clearPending(sid: string, id: string): void {
    const s = this.live.get(sid);
    if (!s || !s.pending.some((r) => r.id === id)) return;
    s.pending = s.pending.filter((r) => r.id !== id);
    this.broadcast({ t: 'pending', sid, cleared: id });
  }

  setStream(sid: string, text: string | null): void {
    const s = this.live.get(sid);
    if (!s) return;
    s.stream = text;
    this.broadcast(text === null ? { t: 'stream', sid, clear: true } : { t: 'stream', sid, text });
  }

  toast(text: string): void {
    this.broadcast({ t: 'toast', text });
  }

  // Slice 3: the messages sent while a card waits, held behind it ("Queued until you answer the card above").
  setHeld(sid: string, texts: string[]): void {
    const s = this.live.get(sid);
    if (!s) return;
    s.held = texts;
    this.broadcast({ t: 'session', id: sid, held: texts });
  }

  // Slice 5: the session's process ended at `at` (ms): its background work and subagents that
  // were still running read as stopped (a foreground tool as failed when `failed`), and pages get
  // the changed ones.
  processEnded(sid: string, at: number, failed = false): void {
    const s = this.live.get(sid);
    if (!s) return;
    s.t.processEnded(new Date(at).toISOString(), failed);
    this.flush(s);
  }

  // The SDK's task_notification for one of the session's background tasks (its tool use id).
  taskEnded(sid: string, toolUseId: string, status: string, summary: string): void {
    const s = this.live.get(sid);
    if (!s) return;
    s.t.taskEnded(toolUseId, status, summary, new Date().toISOString());
    this.flush(s);
  }

  // The SDK's task_started for one of the session's tasks: the task id stopTask takes, by tool use id.
  taskStarted(sid: string, toolUseId: string, taskId: string): void {
    const s = this.live.get(sid);
    if (!s) return;
    s.t.taskStarted(toolUseId, taskId);
    this.flush(s);
  }

  // The SDK's background_tasks_changed for a Synopia-driven session: the task ids of its live
  // background work (REPLACE semantics). Steps that just went to the background show at once.
  backgroundTasks(sid: string, taskIds: string[]): void {
    const s = this.live.get(sid);
    if (!s) return;
    s.t.backgroundTasks(taskIds, new Date().toISOString());
    this.flush(s);
  }

  // Messages an interrupt cancelled, back to the session's message box.
  restore(sid: string, texts: string[]): void {
    if (this.live.has(sid)) this.broadcast({ t: 'restore', sid, texts });
  }

  private transcriptOf(sid: string, agent: string | null): Transcript | null {
    const s = this.live.get(sid);
    if (!s) return null;
    return agent ? s.children.get(agent)?.t ?? null : s.t;
  }

  private sendReset(client: Client, sub: Sub, from?: string | null): void {
    const t = this.transcriptOf(sub.sid, sub.agent);
    const at = t && from ? t.items.findIndex((i) => i.id === from) : -1;
    const v = !t ? { items: [], total: 0 }
      : at >= 0 && at < t.items.length - WINDOW ? { items: t.items.slice(at), total: t.items.length } : t.view(WINDOW);
    sub.from = v.total - v.items.length;
    client.send({ t: 'items', sid: sub.sid, agent: sub.agent, upsert: v.items, total: v.total, reset: true });
  }

  private sendUpserts(client: Client, sub: Sub, t: Transcript, changed: string[]): void {
    if (!changed.length) return;
    const ids = new Set(changed);
    const upsert: Item[] = t.items.slice(sub.from).filter((i) => ids.has(i.id));
    if (upsert.length) client.send({ t: 'items', sid: sub.sid, agent: sub.agent, upsert, total: t.total, reset: false });
  }

  // Records arrive in bursts (a tail read calls onRecords per chunk): send once, after the read.
  private queue(s: Live): void {
    if (s.queued) return;
    s.queued = true;
    queueMicrotask(() => this.flush(s));
  }

  private flush(s: Live): void {
    s.queued = false;
    if (this.live.get(s.id) !== s) return;
    const ch = s.t.takeChanges();
    const meta = this.metaOf(s);
    const key = JSON.stringify(meta);
    if (key !== s.sent) {
      s.sent = key;
      this.broadcast({ t: 'session', ...meta });
    }
    const ran = runningOf(s.t, s.path);
    const ranKey = `${ran.agents}:${ran.turn}:${ran.ask?.toolUseId ?? ''}`;
    if (ranKey !== s.ran) {
      s.ran = ranKey;
      this.opts.onRunning?.(s.id, ran);
    }
    if (ch.agents.length) {
      this.broadcast({ t: 'agents', sid: s.id, upsert: ch.agents.map((id) => s.t.getAgent(id)).filter(Boolean) });
    }
    if (ch.background.length) {
      this.broadcast({ t: 'background', sid: s.id, upsert: ch.background.map((id) => s.t.getBackground(id)).filter(Boolean) });
    }
    // A shell, monitor or subagent that was running ended (often between turns): the writer
    // looks again, as after a turn, so the Now line doesn't keep saying it runs.
    let ended = false;
    const track = (key: string, running: boolean) => {
      if (running) s.working.add(key);
      else if (s.working.delete(key)) ended = true;
    };
    for (const id of ch.background) { const b = s.t.getBackground(id); if (b) track(`b:${id}`, b.status === 'running'); }
    for (const id of ch.agents) { const a = s.t.getAgent(id); if (a) track(`a:${id}`, a.running); }
    if (ended) this.opts.onWorkEnded?.(s.id);
    const childChanges = new Map<string, string[]>();
    for (const [aid, c] of s.children) childChanges.set(aid, c.t.takeChanges().items);
    for (const [client, sub] of this.liveSubs()) {
      if (sub.sid !== s.id) continue;
      if (sub.agent === null) {
        if (s.needReset) this.sendReset(client, sub);
        else this.sendUpserts(client, sub, s.t, ch.items);
      } else {
        const c = s.children.get(sub.agent);
        if (!c) continue;
        if (s.resetChildren.has(sub.agent)) this.sendReset(client, sub);
        else this.sendUpserts(client, sub, c.t, childChanges.get(sub.agent) ?? []);
      }
    }
    s.needReset = false;
    s.resetChildren.clear();
  }

  // Subscriptions of pages still connected; a closed page's subscription goes.
  private liveSubs(): [Client, Sub][] {
    const clients = this.opts.clients();
    for (const c of this.subs.keys()) if (!clients.has(c)) this.subs.delete(c);
    return [...this.subs];
  }

  private broadcast(msg: object): void {
    for (const c of this.opts.clients()) c.send(msg);
    this.opts.onChange?.();
  }
}

// What runs by the transcript: the subagents and forks still running by its rule (shells and
// monitors aren't counted), and its main turn (Transcript.turnRunning, quiet after QUIET_MS), and a card it waits on (none after ASK_STALE_MS of quiet).
function runningOf(t: Transcript, file: string | null): Running {
  return { agents: t.agents().filter((a) => a.running).length, turn: t.turnRunning(Date.now(), QUIET_MS), lastAt: (t.lastTs && Date.parse(t.lastTs)) || 0, ask: t.pendingAsk(Date.now(), ASK_STALE_MS, () => mtimeOf(file)) };
}

function landed(records: JsonRecord[], fn: (messageId: string, blockTypes: string[]) => void): void {
  for (const r of records) {
    if (r.type !== 'assistant' || r.isSidechain === true) continue;
    const m = r.message as { id?: unknown; content?: unknown } | undefined;
    if (!m || typeof m.id !== 'string') continue;
    const types = Array.isArray(m.content) ? m.content.map((b) => String((b as { type?: unknown })?.type ?? '')) : [];
    fn(m.id, types);
  }
}

function cwdOf(records: JsonRecord[]): string {
  for (const r of records) if (typeof r.cwd === 'string' && r.cwd) return r.cwd;
  return '';
}

function mtimeOf(file: string | null): number {
  if (!file) return 0;
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}
