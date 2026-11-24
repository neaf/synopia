// The reading set (FR-VIEW-18): one Tailer and one Transcript per open session and per subagent,
// the new-session finder, the facts other modules read, and the rereads for `toolOutput` and
// `GET /api/image`. It sends nothing: its one listener (publisher.ts) hears when a session's
// transcript changed, closed or moved to another id.
// One timer reads everything each second (`poll`): a new session's file that appears with its first
// turn, the subagent folders, every tailer. fs.watch wakes a tailer sooner.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Tailer, SubagentWatcher } from './tail.ts';
import type { JsonRecord, Span } from './tail.ts';
import { Transcript, sessionDirOf, SERVED_IMAGE_TYPES } from './transcript.ts';
import { landedBlocks, cwdOfRecords, resultTextIn, imageIn } from './claude-jsonl.ts';
import type { Log } from './log.ts';
import { nullLog } from './log.ts';
import { QUIET_MS, ASK_STALE_MS } from './status.ts';
import type { Running } from './status.ts';

export const WINDOW = 160; // the items a view gets, and an `earlier` page

export type TranscriptsOptions = {
  claudeDir: string;
  home?: string; // for `~` in paths; the fixtures use their own
  log?: Log;
  pollMs?: number; // the read timer, default 1000; 0 turns it off (tests call poll())
  watch?: boolean; // fs.watch on the files, default true
  // Each assistant record of a main conversation as it lands: its message id and block types.
  onAssistant?: (sid: string, messageId: string, blockTypes: string[]) => void;
  // The written titles of a session (state.json `written`), for its "Retitled" lines.
  written?: (sid: string) => { history?: { title: string; at: number }[] } | undefined;
  answerOf?: (toolUseId: string) => string | undefined; // a card's stored answer, shown as your turn
  planOf?: (toolUseId: string) => string | undefined; // the plan text an answered plan card showed
};

// What the publisher hears. `changed` comes once per batch of records (a microtask after a tail
// read), at the end of `poll`, and at once after an SDK event changed the reducer.
export type TranscriptListener = {
  changed(sid: string): void;
  closed(sid: string): void;
  rekeyed(from: string, to: string): void;
};

// A session's changes since the last take: item, agent and background ids, and the views to send
// again whole (a rewritten file).
export type ReadChanges = {
  items: string[]; agents: string[]; background: string[]; reset: boolean;
  children: Map<string, { items: string[]; reset: boolean }>;
};

export type Facts = {
  model: string | null; effort: string | null; permissionMode: string | null; modeBeforePlan: string | null;
  working: boolean; runningWork: ('subagent' | 'shell' | 'monitor')[];
};

type Child = { t: Transcript; tailer: Tailer; calm: number; skip: number; reset: boolean }; // calm: scans with nothing new
const CALM_SCANS = 3;
const SLOW_SCANS = 10;
type Reading = {
  id: string; path: string | null; cwd: string; t: Transcript;
  tailer: Tailer | null; watcher: SubagentWatcher | null; children: Map<string, Child>;
  reset: boolean; dirty: boolean;
  finding?: boolean; // poll's look for a new session's file is on its way
};

// The transcript's effort: a level, or {level} on some records.
export const effortOf = (e: unknown): string | null => typeof e === 'string' ? e
  : e && typeof (e as { level?: unknown }).level === 'string' ? (e as { level: string }).level : null;

export class Transcripts {
  private opts: TranscriptsOptions;
  private home: string;
  private log: Log;
  private live = new Map<string, Reading>();
  private listener: TranscriptListener | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: TranscriptsOptions) {
    this.opts = opts;
    this.home = opts.home ?? os.homedir();
    this.log = opts.log ?? nullLog;
    const pollMs = opts.pollMs ?? 1000;
    if (pollMs > 0) {
      this.timer = setInterval(() => this.poll(), pollMs);
      this.timer.unref?.();
    }
  }

  listen(l: TranscriptListener): void {
    this.listener = l;
  }

  ids(): string[] {
    return [...this.live.keys()];
  }

  has(id: string): boolean {
    return this.live.has(id);
  }

  // Starts reading a session. Its file is found under projects/*/ (a new session has none yet:
  // `poll` looks again).
  open(id: string, init: { cwd?: string; path?: string } = {}): void {
    if (this.live.has(id)) return;
    const file = init.path ?? findTranscript(this.opts.claudeDir, id);
    const s: Reading = { id, path: null, cwd: init.cwd ?? '', t: this.transcript(id), tailer: null, watcher: null, children: new Map(), reset: false, dirty: false };
    this.live.set(id, s);
    this.log('transcripts.open', { sid: id, found: Boolean(file) });
    if (file) this.attach(s, file);
  }

  close(id: string): void {
    const s = this.live.get(id);
    if (!s) return;
    this.stopOne(s);
    this.live.delete(id);
    this.listener?.closed(id);
  }

  // The session's id changed (a new session's real id from system/init, or a conversation_reset):
  // the reading starts again on the new id's file, from the start. The cwd stays.
  rekey(oldId: string, newId: string): void {
    const s = this.live.get(oldId);
    if (!s || this.live.has(newId)) return;
    this.stopOne(s);
    this.live.delete(oldId);
    const next: Reading = { id: newId, path: null, cwd: s.cwd, t: this.transcript(newId), tailer: null, watcher: null, children: new Map(), reset: false, dirty: false };
    this.live.set(newId, next);
    this.log('transcripts.rekey', { from: oldId, to: newId });
    const file = findTranscript(this.opts.claudeDir, newId);
    if (file) this.attach(next, file);
    this.listener?.rekeyed(oldId, newId);
  }

  // The read timer's tick: a new session's file, the subagent folders (which read their subagents'
  // files), every main file. Then the sessions that changed are told at once. A new session's file
  // is looked for async; the promise settles once those looks are done (tests wait for it).
  poll(): Promise<void> {
    const finds: Promise<void>[] = [];
    for (const s of [...this.live.values()]) {
      if (this.live.get(s.id) !== s) continue;
      if (!s.path) finds.push(this.find(s));
      s.watcher?.scan();
      s.tailer?.check();
    }
    for (const s of [...this.live.values()]) if (s.dirty) this.emit(s);
    return Promise.all(finds).then(() => {});
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const s of this.live.values()) this.stopOne(s);
  }

  // The main conversation's reducer, or a subagent's.
  get(sid: string, agent: string | null = null): Transcript | null {
    const s = this.live.get(sid);
    if (!s) return null;
    return agent ? s.children.get(agent)?.t ?? null : s.t;
  }

  pathOf(sid: string): string | null {
    return this.live.get(sid)?.path ?? null;
  }

  cwdOf(sid: string): string {
    return this.live.get(sid)?.cwd ?? '';
  }

  // The changes since the last take (publisher.ts flushes them).
  takeChanges(sid: string): ReadChanges | null {
    const s = this.live.get(sid);
    if (!s) return null;
    s.dirty = false;
    const ch = s.t.takeChanges();
    const children = new Map<string, { items: string[]; reset: boolean }>();
    for (const [aid, c] of s.children) {
      children.set(aid, { items: c.t.takeChanges().items, reset: c.reset });
      c.reset = false;
    }
    const reset = s.reset;
    s.reset = false;
    return { items: ch.items, agents: ch.agents, background: ch.background, reset, children };
  }

  // What a session's process needs from its transcript: the model, effort and modes it last used,
  // and the background work and subagents that still run.
  facts(id: string): Facts | undefined {
    const s = this.live.get(id);
    if (!s) return undefined;
    const t = s.t;
    const runningWork = [
      ...t.agents().filter((a) => a.running).map(() => 'subagent' as const),
      ...t.background().filter((b) => b.status === 'running').map((b) => b.kind),
    ];
    return {
      runningWork,
      model: typeof t.requestedModel === 'string' ? t.requestedModel : null,
      effort: effortOf(t.effort),
      permissionMode: t.permissionMode,
      modeBeforePlan: t.lastNonPlanMode,
      working: runningWork.length > 0, // a subagent or background shell or monitor still running
    };
  }

  // What runs now by the transcript (nothing when it isn't open): subagents and forks still running
  // by its rule (shells and monitors aren't counted), its main turn (quiet after QUIET_MS), and a
  // card it waits on (none after ASK_STALE_MS of quiet).
  running(id: string): Running {
    const s = this.live.get(id);
    if (!s) return { agents: 0, turn: false, lastAt: 0, ask: null };
    const t = s.t, now = Date.now();
    return { agents: t.agents().filter((a) => a.running).length, turn: t.turnRunning(now, QUIET_MS), lastAt: (t.lastTs && Date.parse(t.lastTs)) || 0, ask: t.pendingAsk(now, ASK_STALE_MS, () => mtimeOf(s.path)) };
  }

  // When the transcript last changed: its last record, else the file's mtime.
  lastAt(id: string): number {
    const s = this.live.get(id);
    if (!s) return 0;
    return (s.t.lastTs && Date.parse(s.t.lastTs)) || mtimeOf(s.path) || 0;
  }

  // The turns the writer reads, oldest first: each prompt you typed and Claude's text until the
  // next one. Undefined when the session isn't open.
  turns(id: string): { you: string; claude: string }[] | undefined {
    const s = this.live.get(id);
    if (!s) return undefined;
    const out: { you: string; claude: string }[] = [];
    for (const i of s.t.items) {
      if (i.k === 'you' && i.turnedDown) continue; // a tool you turned down: Claude carried on
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
  // one line each ("shell “npm test”: running"). Times compare as instants.
  work(id: string): string[] | undefined {
    const s = this.live.get(id);
    if (!s) return undefined;
    const lastYou = Date.parse([...s.t.items].reverse().find((i) => i.k === 'you')?.ts ?? '');
    const recent = (end: string | null) => !Number.isFinite(lastYou) || (end !== null && Date.parse(end) >= lastYou);
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
    return out;
  }

  // The full result of one tool, read again from its record's line (only its preview is kept in
  // memory). Null when the file is gone or was rewritten.
  async resultText(sid: string, agent: string | null, toolUseId: string): Promise<string | null> {
    const file = this.fileOf(sid, agent);
    const span = this.get(sid, agent)?.resultSpan(toolUseId);
    return file && span ? resultTextIn(await readLine(file, span), toolUseId) : null;
  }

  // `GET /api/image`: one image block, read again from its record's line and decoded (items carry only
  // its ref). 404 for an unknown ref or a file that is gone or was rewritten, 415 for a type not served.
  async image(sid: string, agent: string | null, ref: string): Promise<{ status: 200; type: string; body: Buffer } | { status: 404 | 415 }> {
    const file = this.fileOf(sid, agent);
    const at = this.get(sid, agent)?.imageAt(ref);
    const img = file && at ? await readImage(file, at.span, at.recordId, at.path) : null;
    if (!img) return { status: 404 };
    if (!SERVED_IMAGE_TYPES.includes(img.mediaType)) return { status: 415 };
    return { status: 200, type: img.mediaType, body: img.data };
  }

  // ---------- SDK events the reducer takes (session.ts) ----------

  // The session's process ended at `at` (ms): its background work and subagents that were still
  // running read as stopped (a foreground tool as failed when `failed`).
  processEnded(sid: string, at: number, failed = false): void {
    this.edit(sid, (t) => t.processEnded(new Date(at).toISOString(), failed));
  }

  // The SDK's task_notification for one of the session's background tasks (its tool use id).
  taskEnded(sid: string, toolUseId: string, status: string, summary: string): void {
    this.edit(sid, (t) => t.taskEnded(toolUseId, status, summary, new Date().toISOString()));
  }

  // The SDK's task_started: a task id by tool use id, matched against background_tasks_changed.
  taskStarted(sid: string, toolUseId: string, taskId: string): void {
    this.edit(sid, (t) => t.taskStarted(toolUseId, taskId));
  }

  // The SDK's background_tasks_changed: the task ids of its live background work (REPLACE semantics).
  backgroundTasks(sid: string, taskIds: string[]): void {
    this.edit(sid, (t) => t.backgroundTasks(taskIds, new Date().toISOString()));
  }

  // ---------- reading ----------

  private edit(sid: string, fn: (t: Transcript) => void): void {
    const s = this.live.get(sid);
    if (!s) return;
    fn(s.t);
    this.emit(s);
  }

  private emit(s: Reading): void {
    s.dirty = false;
    if (this.live.get(s.id) === s) this.listener?.changed(s.id);
  }

  // Records arrive in bursts (a tail read calls onRecords per chunk): one `changed` after the read.
  private queue(s: Reading): void {
    if (s.dirty) return;
    s.dirty = true;
    queueMicrotask(() => { if (s.dirty) this.emit(s); });
  }

  private transcript(id: string): Transcript {
    return new Transcript({ home: this.home, answerOf: this.opts.answerOf, planOf: this.opts.planOf, titlesOf: () => this.opts.written?.(id)?.history });
  }

  private fileOf(sid: string, agent: string | null): string | null {
    const s = this.live.get(sid);
    return (agent ? s?.children.get(agent)?.tailer.path : s?.path) ?? null;
  }

  // A new session's file appears with its first turn: looked for without blocking the loop, one
  // look at a time per session.
  private async find(s: Reading): Promise<void> {
    if (s.finding) return;
    s.finding = true;
    const file = await findTranscriptLater(this.opts.claudeDir, s.id);
    s.finding = false;
    if (!file || s.path || this.live.get(s.id) !== s) return; // found meanwhile, closed or moved
    this.log('transcripts.found', { sid: s.id });
    this.attach(s, file);
    if (s.dirty) this.emit(s);
  }

  private attach(s: Reading, file: string): void {
    s.path = file;
    const watch = this.opts.watch;
    s.tailer = new Tailer(file, {
      pollMs: 0, // poll() reads it
      watch,
      onRecords: (records, spans) => {
        if (!s.cwd) s.cwd = cwdOfRecords(records);
        s.t.pushAll(records, spans);
        if (this.opts.onAssistant) landed(records, (mid, types) => this.opts.onAssistant?.(s.id, mid, types));
        this.queue(s);
      },
      onReset: () => {
        s.t.reset();
        s.reset = true;
        this.queue(s);
      },
    }).start();
    s.watcher = new SubagentWatcher(sessionDirOf(file), {
      onAgent: (aid, afile) => {
        const t = new Transcript({ sidechain: true, home: this.home, answerOf: this.opts.answerOf, planOf: this.opts.planOf });
        s.t.setAgent(aid, undefined, t);
        // No timer or watch of its own: the folder's watcher reads it after each scan (onScan).
        const child: Child = { t, tailer: null as unknown as Tailer, calm: 0, skip: 0, reset: false };
        child.tailer = new Tailer(afile, {
          pollMs: 0,
          watch: false,
          onRecords: (records, spans) => {
            t.pushAll(records, spans);
            s.t.setAgent(aid, undefined); // its total, start and end changed
            this.queue(s);
          },
          onReset: () => {
            t.reset();
            child.reset = true;
            this.queue(s);
          },
        });
        s.children.set(aid, child);
        child.tailer.start();
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
    }, { pollMs: 0, watch }).start();
  }

  private stopOne(s: Reading): void {
    s.dirty = false;
    s.tailer?.stop();
    s.watcher?.stop();
    for (const c of s.children.values()) c.tailer.stop();
  }
}

function landed(records: JsonRecord[], fn: (messageId: string, blockTypes: string[]) => void): void {
  for (const r of records) {
    const l = landedBlocks(r);
    if (l) fn(l.messageId, l.types);
  }
}

// ---------- the files (the only I/O of the reading, with tail.ts) ----------

// The first `projects/*/<id>.jsonl` under the claude dir, or null. Synchronous: a session that
// opens shows its transcript at once (open, rekey; cli-terminals.ts on a pid file's change).
export function findTranscript(claudeDir: string, sessionId: string): string | null {
  const projects = path.join(claudeDir, 'projects');
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects).sort();
  } catch {
    return null;
  }
  for (const d of dirs) {
    const p = path.join(projects, d, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// The same, async: the poll's look for a new session's file, each second until it appears (NFR-06).
export async function findTranscriptLater(claudeDir: string, sessionId: string): Promise<string | null> {
  const projects = path.join(claudeDir, 'projects');
  let dirs: string[];
  try {
    dirs = (await fs.promises.readdir(projects)).sort();
  } catch {
    return null;
  }
  for (const d of dirs) {
    const p = path.join(projects, d, `${sessionId}.jsonl`);
    try {
      await fs.promises.access(p);
      return p;
    } catch { /* not in this folder */ }
  }
  return null;
}

// Reads one record line again (`span`, from the tailer) and parses it; undefined when the file is
// gone or the bytes there aren't one JSON value. Async: a line with an image can be megabytes (NFR-06).
export async function readLine(file: string, span: Span): Promise<unknown> {
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(file, 'r');
  } catch {
    return undefined;
  }
  try {
    const buf = Buffer.alloc(span.length);
    const { bytesRead } = await fh.read(buf, 0, span.length, span.offset);
    if (bytesRead !== span.length) return undefined;
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return undefined;
  } finally {
    await fh.close();
  }
}

// Reads one record line again (`span`) and decodes the image block at `path` in it. null when the file
// is gone, the line no longer holds that record (rewritten), or there is no base64 image there.
export async function readImage(file: string, span: Span, recordId: string, at: number[]): Promise<{ mediaType: string; data: Buffer } | null> {
  const img = imageIn(await readLine(file, span), recordId, at);
  return img ? { mediaType: img.mediaType, data: Buffer.from(img.data, 'base64') } : null;
}

export function mtimeOf(file: string | null): number {
  if (!file) return 0;
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}
