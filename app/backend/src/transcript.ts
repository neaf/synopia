// Claude Code records to items for one conversation (the main one or a subagent's): a reducer over
// the typed records of claude-jsonl.ts, which reads every raw field. Records arrive in file order,
// and a later record (a tool result, a task notification) updates an earlier item in place. Every
// item has a stable id; takeChanges() lists what changed since the last call.
import os from 'node:os';
import type { JsonRecord, Span } from './tail.ts';
import { displayIn } from './paths.ts';
import { BANG_CAP } from './bang.ts';
import { stepOf, sessionOf, fullName } from './agent-tools.ts';
// A subagent's open_items call names no ledger: only the main conversation's facts are read (`sidechain`).
const OPEN_ITEMS = fullName('open_items');
import type { BashOutput } from './bang.ts';
import { classify, agentMetaOf } from './claude-jsonl.ts';
import { isLedgerPath, ledgerPathOf, ledgerPathIn, ownedIds } from './ledger.ts';
import type { AgentMeta, AssistantRecord, BashEdit, ClaudeRecord, Denial, FileEdit, ImageBlock, Question, RawHunk, TaskNote, ToolUse, UserRecord } from './claude-jsonl.ts';

export type { Question } from './claude-jsonl.ts';
export type Hunk = { o: number; n: number; lines: string[] };
// `bare`: a file a shell command changed with no diff in the record (bashEditDiff.changedFiles).
// `unnumbered`: a diff from the tool's input, with no line numbers (claude-jsonl.ts inputEditOf).
// `ledger`: the file is an open-items ledger (ledger.ts isLedgerPath), which Files changed leaves out (R5.9).
export type Patch = {
  file: string; abs: string; add: number; del: number; created: boolean; cut: boolean; hunks: Hunk[]; bare?: boolean; unnumbered?: true; ledger?: true;
};
// A tool result's preview: its first PREVIEW_LINES lines, PREVIEW_BYTES at most; `lines` counts all
// of them, `cut` says the preview isn't all (the page asks for the rest with `toolOutput`).
// `at`: the result's time (its record's), where a foreground Bash's shell view ends its time (R7.2, 2026-11-26).
export type Output = { text: string; lines: number; cut: boolean; interrupted?: boolean; at?: string };
// An image block in a record (a pasted image in your prompt, or one in a tool's result): only where it
// is, never its bytes. `ref` is `<record id>:<block path>` (`3`, or `1.0` for a block in a tool_result's
// content); the page loads it from `GET /api/image`. `w` and `h` come from the image's header when cheap.
export type ImageRef = { ref: string; mediaType: string; w?: number; h?: number };
export type Item = {
  id: string; k: 'you' | 'claude' | 'tool' | 'report' | 'ask' | 'title' | 'bang' | 'moved' | 'resumed' | 'aside'; ts: string | null;
  // aside: f, f interrupted the turn for your queued messages (R9.8, 2026-11-26): the live line as it was then, a
  // still record. `step`: the main step it named (a tool item's id), none while Claude only wrote or thought.
  // claude: `aside` is the id of the aside whose interrupted reply this text was, so it shows greyed above it.
  step?: string; aside?: string;
  cwd?: string; // moved: the folder the session continues in (R3.11), as the page shows it
  cmd?: string; sh?: BashOutput; // bang: a bash-mode command (`!`) and its output, from Synopia or the CLI (R5.13)
  title?: string; by?: 'claude' | 'you'; // title: the shown title changed to this, renamed by you (custom-title) or by Claude
  text?: string; images?: number; workedMs?: number; // you (workedMs also a bang that started a turn)
  queued?: boolean; // you, bang: a message a running turn took in from its queue (a `queued_command`), not a turn's start
  // you: an interrupt marker. `interrupted`: you stopped the turn; `turnedDown`: you turned a tool
  // down and Claude carries on (docs/Claude Code transcripts.md#interrupts).
  interrupted?: boolean; turnedDown?: boolean;
  imgs?: ImageRef[]; // you, tool: the images the prompt sent or the result holds (R5.13)
  agent?: string | null; // report
  name?: string; verb?: string; obj?: string; to?: string; state?: string; toolUseId?: string; patch?: Patch; // tool (to: SendMessage's recipient)
  patches?: Patch[]; moreFiles?: number; // tool: the files a Bash command changed (bashEditDiff), and how many more it didn't list
  input?: string; out?: Output; // tool: its input as the expanded step shows it, and its result's preview (R5.6)
  fg?: boolean; // tool: a foreground Bash or Agent still running, which b, b can send to the background (R9)
  bg?: boolean; // tool: a step still running in the background (a background subagent), not the main turn's own (R5.5)
  session?: string; // tool: the session a finished start_session started (R3.15), which its result line links to
  denied?: Denial; // tool, state denied: who said no when it has no card answer (auto mode, or you at a terminal)
  qs?: Question[]; answer?: string | null; // ask
};
export type Background = {
  toolUseId: string; taskId: string | null; kind: 'shell' | 'monitor'; description: string; command: string;
  timeout: unknown; persistent: boolean; start: string | null;
  status: string; summary: string; end: string | null;
  agentId?: string; // started by this subagent (from its own transcript); absent for the main thread's
};
export type Agent = {
  id: string; type: string; fork: boolean; description: string; toolUseId: string | null;
  model: unknown; depth: unknown; finished: boolean; running: boolean; review: boolean; stopped: boolean;
  // running, but idle: its turn ended with its own shells or monitors still running, and it wakes when they end
  // (docs/Claude Code transcripts.md#a-subagent-waiting-on-its-own-background-work)
  waiting: boolean;
  start: string | null; end: string | null; total: number;
};
// A question or plan card waiting in the transcript: an AskUserQuestion or ExitPlanMode tool_use of
// the latest assistant message with no tool_result yet (Transcript.pendingAsk). `agentId`: the
// subagent that asked (null: the main conversation). `since`: the tool_use's time (ms, 0 unknown).
export type PendingAsk = { kind: 'question' | 'plan'; toolUseId: string; agentId: string | null; since: number; qs?: Question[]; plan?: string };
// A title Synopia's writer gave the session, and when (ms): state.json `written[sid].history`.
export type WrittenTitle = { title: string; at: number };
// The session's ledger by its transcript (FR-ITEM-01): the last `.ai-notes/<area>/open-items.md` the main
// conversation named in a Read, Write or Edit, or in a Bash command; `at` that tool use's time, `results` how many
// results of such tool uses have landed (a new one: read the file again).
export type LedgerFact = { path: string; at: string | null; toolUseId: string; results: number };
export type Changes = { items: string[]; background: string[]; agents: string[]; meta: boolean };
// One event of a monitor (its notification's `<event>`): `n` counts its events from 0, so a reader's
// place survives the oldest ones being dropped past MAX_EVENTS.
export type OutEvent = { n: number; ts: string | null; text: string };
// Where a background shell's or monitor's output is (R7.2): a shell's output file (null until its
// result names it), a monitor's events.
export type BgOutput = { kind: 'shell' | 'monitor'; file: string | null; events: OutEvent[] };

const MAX_TEXT = 6000;
const MAX_BANG_CMD = 4000;
const MAX_DIFF_LINES = 400;
const MAX_EVENTS = 20000;
// Records in an ended subagent's file this long after its end notification: it was woken again. Its last
// record comes a few ms before the notification (docs/Claude Code transcripts.md#a-subagent-resumed-by-sendmessage).
const WOKE_MS = 2000;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const titleKey = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

export function clip(s: string, n = MAX_TEXT): string {
  return s.length <= n ? s : s.slice(0, n) + '\n\n[cut: message continues]';
}

// Paths as the page shows them (paths.ts): /tmp and home as you know them, home as `~`.
function tilde(p: string, home: string): string {
  return displayIn(p, home);
}

// A step's verb and object. `input` is the tool's own parameters (the Claude Code tools' inputs),
// read here for display only.
export function toolLine(name: string, input: JsonRecord, home: string): [string, string] {
  const inp = input;
  const ours = stepOf(name, inp); // Synopia's own tools (agent-tools.ts): "Start session(<title>)"
  if (ours) return ours;
  if (name === 'Bash') return ['Ran', str(inp.description) || str(inp.command).slice(0, 120)];
  if (name === 'Read' || name === 'Edit' || name === 'Write' || name === 'NotebookEdit') {
    const p = str(inp.file_path) || str(inp.notebook_path);
    const verb = { Read: 'Read', Edit: 'Edited', Write: 'Wrote', NotebookEdit: 'Edited' }[name];
    return [verb, tilde(p, home)];
  }
  if (name === 'Grep' || name === 'Glob') return ['Searched', str(inp.pattern)];
  if (name === 'Agent' || name === 'Task') return ['Subagent', str(inp.description)];
  if (name === 'Skill') return ['Skill', str(inp.skill)];
  if (name === 'WebFetch') return ['Fetched', str(inp.url)];
  if (name === 'WebSearch') return ['Searched the web', str(inp.query)];
  if (name === 'AskUserQuestion') {
    const qs = Array.isArray(inp.questions) ? inp.questions : [];
    return ['Asked you', qs.map((q) => str((q as JsonRecord | null)?.question)).join('; ')];
  }
  if (name === 'ExitPlanMode') return ['Plan', 'shown for approval'];
  if (name === 'ToolSearch') return ['Loaded tools', str(inp.query).split('select:').join('')];
  if (name === 'ScheduleWakeup') return ['Scheduled a check-in', str(inp.reason)];
  if (name === 'TaskOutput') return ['Checked a background task', ''];
  if (name === 'SendMessage') return ['Messaged a subagent', str(inp.summary) || str(inp.message).split('\n')[0].slice(0, 120)]; // the recipient is the item's `to`
  if (name === 'Monitor') return ['Watched', str(inp.description)];
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    return [(parts[1] ?? '').split('_').join(' '), parts[parts.length - 1].split('_').join(' ')];
  }
  return [name, ''];
}

// An Edit's or Write's change as a patch.
export function patchOf(edit: FileEdit, home: string): Patch {
  const p = patchFrom(edit.hunks, edit.filePath, edit.created, home);
  return edit.unnumbered ? { ...p, unnumbered: true } : p;
}

// The files a Bash command edited: one patch per diffed file, built as an Edit's, then each
// changed file with no diff as a bare patch (no counts, no diff).
export function bashPatchesOf(edit: BashEdit, home: string): { patches: Patch[]; more: number } {
  const patches = edit.files.map((f) => patchFrom(f.hunks, f.filePath, f.created, home));
  for (const file of edit.changedFiles) {
    if (!patches.some((x) => x.abs === file)) {
      const bare: Patch = { file: tilde(file, home), abs: file, add: 0, del: 0, created: false, cut: false, hunks: [], bare: true };
      patches.push(isLedgerPath(file) ? { ...bare, ledger: true } : bare);
    }
  }
  return { patches, more: edit.moreFiles };
}

function patchFrom(hunks: RawHunk[], abs: string, created: boolean, home: string): Patch {
  let add = 0;
  let del = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.startsWith('+')) add++;
      else if (l.startsWith('-')) del++;
    }
  }
  const out: Hunk[] = [];
  let budget = MAX_DIFF_LINES;
  for (const h of hunks) {
    const lines = h.lines.slice(0, Math.max(budget, 0));
    budget -= lines.length;
    out.push({ o: h.oldStart, n: h.newStart, lines });
    if (budget <= 0) break;
  }
  const p: Patch = { file: tilde(abs, home), abs, add, del, created, cut: budget <= 0, hunks: out };
  return isLedgerPath(abs) ? { ...p, ledger: true } : p;
}

export const PREVIEW_LINES = 20;
export const PREVIEW_BYTES = 4096;

export function previewOf(text: string): Output {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  let lines = 1;
  let end = -1;
  for (let i = body.indexOf('\n'); i !== -1; i = body.indexOf('\n', i + 1)) {
    if (lines === PREVIEW_LINES) end = i;
    lines++;
  }
  let head = end === -1 ? body : body.slice(0, end);
  let cut = end !== -1;
  const buf = Buffer.from(head, 'utf8');
  if (buf.length > PREVIEW_BYTES) {
    head = buf.subarray(0, PREVIEW_BYTES).toString('utf8').replace(/�+$/, ''); // no half character at the end
    cut = true;
  } else head = buf.toString('utf8'); // a copy, so the record's whole text isn't kept alive by a slice of it
  return { text: body ? head : '', lines: body ? lines : 0, cut };
}

// The input of a tool as an expanded step shows it: a Bash command in full (4 KB at most), else one
// `key: value` line per short field. Edit and Write show nothing here: their diff is the way to see them.
export function inputOf(name: string, input: JsonRecord): string {
  if (name === 'Bash') return clip(str(input.command), PREVIEW_BYTES);
  if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit' || name === 'AskUserQuestion' || name === 'ExitPlanMode') return '';
  const out: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue;
    const s = String(v);
    out.push(`${k}: ${s.length > 300 ? s.slice(0, 300) + '…' : s}`);
    if (out.length === 8) break;
  }
  return out.join('\n');
}

// The image types the page is served (GET /api/image); any other gets a 415. protocol.js
// IMAGE_TYPES is the other set: what a message you send may carry.
export const SERVED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const JPEG_SCAN = 64 * 1024; // how far into a JPEG to look for its size (EXIF can come first)
const sized = (w: number, h: number) => (w > 0 && h > 0 ? { w, h } : null);

// Width and height from the first bytes of a PNG, GIF, WebP or JPEG, given as base64; null when the
// header doesn't say within the first bytes. Decodes a prefix only, never the whole image. The declared
// type goes first, then the other served types: a record can label a JPEG a PNG, and the browser goes
// by the bytes, so this still gives the thumbnail its shape before it loads.
export function imageSize(mediaType: string, b64: string): { w: number; h: number } | null {
  if (!SERVED_IMAGE_TYPES.includes(mediaType)) return null;
  for (const t of [mediaType, ...SERVED_IMAGE_TYPES.filter((x) => x !== mediaType)]) {
    const size = sizeAs(t, b64);
    if (size) return size;
  }
  return null;
}
function sizeAs(mediaType: string, b64: string): { w: number; h: number } | null {
  const head = (n: number) => Buffer.from(b64.slice(0, Math.ceil(n / 3) * 4), 'base64');
  try {
    if (mediaType === 'image/png') {
      const b = head(24);
      if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('latin1', 12, 16) === 'IHDR') return sized(b.readUInt32BE(16), b.readUInt32BE(20));
    } else if (mediaType === 'image/gif') {
      const b = head(10);
      if (b.length >= 10 && b.toString('latin1', 0, 4) === 'GIF8') return sized(b.readUInt16LE(6), b.readUInt16LE(8));
    } else if (mediaType === 'image/webp') {
      const b = head(30);
      if (b.length < 30 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null;
      const chunk = b.toString('latin1', 12, 16);
      if (chunk === 'VP8 ') return sized(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
      if (chunk === 'VP8L') return sized(1 + (((b[22] & 0x3f) << 8) | b[21]), 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)));
      if (chunk === 'VP8X') return sized(1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3));
    } else if (mediaType === 'image/jpeg') {
      const b = head(JPEG_SCAN);
      if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
      for (let i = 2; i + 9 <= b.length;) {
        if (b[i] !== 0xff) return null;
        const m = b[i + 1];
        if (m === 0xff) { i++; continue; } // fill byte
        if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; } // markers with no length
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return sized(b.readUInt16BE(i + 7), b.readUInt16BE(i + 5));
        if (m === 0xd9 || m === 0xda) return null; // the end, or a scan with no frame header before it
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch {
    return null;
  }
  return null;
}


// The image blocks of a content array (a user record's, or a tool_result's under `at`), as refs.
export function imageRefs(recordId: string, blocks: ImageBlock[], at = ''): ImageRef[] {
  return blocks.map((b) => {
    const ref: ImageRef = { ref: `${recordId}:${at}${b.index}`, mediaType: b.mediaType };
    const size = b.data !== null ? imageSize(b.mediaType, b.data) : null;
    if (size) Object.assign(ref, size);
    return ref;
  });
}

// A ref's record id and block path (`[3]`, or `[1, 0]` inside a tool_result); null when it isn't one.
export function parseRef(ref: string): { recordId: string; path: number[] } | null {
  const m = /^(.+):(\d{1,4}(?:\.\d{1,4})?)$/.exec(ref);
  return m ? { recordId: m[1], path: m[2].split('.').map(Number) } : null;
}

type ToolUseRef = { id: string; ts: string | null; name: string };
// `waiting`: a subagent's "waiting on its own background work" (claude-jsonl.ts TaskNote), not its end
type Note = { status: string; summary: string; end: string | null; waiting?: boolean };
type AgentLink = { meta: AgentMeta | null; sub: Transcript | null };

// What a file's records built: a new one when the file is rewritten (Transcript.reset), so a reset
// can't keep a stale field.
class ReadState {
  items: Item[] = [];
  customTitle: string | null = null;
  aiTitle: string | null = null;
  permissionMode: string | null = null;
  lastNonPlanMode: string | null = null;
  requestedModel: unknown = null;
  effort: unknown = null;
  firstTs: string | null = null;
  lastTs: string | null = null;
  // The main thread's turn, for a session no Synopia process drives (status.ts): opened by a prompt
  // you typed (a user record, a slash command or a queued_command attachment), closed by
  // system/turn_duration, system/stop_hook_summary or an interrupt marker. An assistant record
  // after a marker opens it again: Claude carried on.
  turnOpen = false;
  afterMarker = false;
  // The request the CLI retries now: the main thread's latest record is a system/api_error (status.ts).
  apiError: { text: string; status: number | null; credential: boolean } | null = null;
  // The tool uses of the latest assistant message: every record of its `message.id` (one block per
  // record), or the one record when it has no id.
  message: { key: string; uses: ToolUseRef[] } = { key: '', uses: [] };
  prs: unknown[] = [];
  byId = new Map<string, Item>();
  seq = 0;
  lastYou: Item | null = null;
  lastBang: Item | null = null; // the bash-mode command whose output comes next
  results = new Map<string, boolean>(); // tool_use id -> is_error
  asks = new Set<string>();
  answers = new Map<string, string>();
  patches = new Map<string, Patch>();
  bashPatches = new Map<string, { patches: Patch[]; more: number }>();
  inputEdits = new Map<string, FileEdit>(); // tool_use id -> an Edit's or Write's change from its input, until its result
  // A tool's result: only its preview stays in memory, and where its record sits for the rest.
  outs = new Map<string, Output>();
  outSpans = new Map<string, Span>();
  span: Span | undefined; // of the record being pushed
  // Images: the line of each record that holds one (by record id), and the images of each tool's result.
  imageSpans = new Map<string, Span>();
  outImgs = new Map<string, ImageRef[]>();
  bgTool = new Map<string, boolean>(); // tool_use id -> runs in the background (input flag or async launch)
  fgBash = new Map<string, Pick<Background, 'description' | 'command' | 'timeout' | 'start'>>(); // foreground Bash uses, in case one moves to the background
  notes = new Map<string, Note>();
  ends = new Map<string, Note[]>(); // tool_use id -> its end notifications that weren't "waiting", oldest first
  sdkEnd = new WeakSet<Note>(); // ends the SDK told of, until the JSONL's own note of them
  resumes = new Map<string, string>(); // agent id -> when a SendMessage last resumed it (its result's `resumedAgentId`)
  outFiles = new Map<string, string>(); // tool_use id -> a background shell's output file (its result, or its end notification)
  events = new Map<string, OutEvent[]>(); // task id -> a monitor's events, oldest first (the last MAX_EVENTS)
  taskIds: Map<string, string>; // tool_use id -> the SDK task id (background_tasks_changed lists these)
  reportKind = new Map<string, 'message' | 'result'>(); // agent id -> where its report came from
  bg = new Map<string, Background>();
  changed = new Set<string>();
  changedBg = new Set<string>();
  changedAgents = new Set<string>();
  metaChanged = false;
  interrupted = new Set<string>(); // tool uses whose result the CLI wrote for an interrupt
  denials = new Map<string, Denial>(); // tool uses a permission check denied (claude-jsonl.ts Denial)
  lastErrors: string[] = []; // the error results of the record just read, if it held results
  // Title items (R5.x): the shown title's sources as read so far, in record and time order (a
  // custom-title, else the writer's, else the ai-title, as the header picks), the last shown one's
  // key, whether a prompt came yet, and the writer's history entries already placed (by `at`).
  titles: { you: string; written: string; ai: string } = { you: '', written: '', ai: '' };
  shownTitle: string | null = null;
  prompted = false;
  writtenAt = -Infinity;
  // f, f's interrupt route (R9.8): the claude items of each message, and the aside that cut a message short.
  // the main conversation's open-items facts (FR-ITEM-01, FR-ITEM-04); a subagent's Transcript keeps none
  ledger: Omit<LedgerFact, 'results'> | null = null;
  ledgerUses = new Set<string>(); // tool uses that named a ledger
  ledgerResults = 0;
  owns = new Map<string, string[]>(); // an Agent tool use id -> the ids its brief's `Open items:` line names
  textsOf = new Map<string, string[]>();
  asideOf = new Map<string, string>();

  // `taskIds`: the SDK's task_started ids, which a rewrite keeps.
  constructor(taskIds: Map<string, string>) {
    this.taskIds = new Map(taskIds);
  }
}

const msOf = (ts: string | null | undefined): number | null => {
  const n = ts ? Date.parse(ts) : NaN;
  return Number.isFinite(n) ? n : null;
};

export class Transcript {
  readonly sidechain: boolean;
  readonly home: string;
  private r: ReadState;
  private agentMeta = new Map<string, AgentLink>();
  // Kept over a rewrite, not read from the file:
  // the session's process ended then (ISO, and as ms): work started before it can't still run.
  private ended: string | null = null;
  private endedMs: number | null = null;
  private endedFailed = false; // that end was a process failure (else close, idle end or quit)
  private sdkTasks = new Map<string, string>(); // tool_use id -> task id, from the SDK's task_started
  // The SDK's background_tasks_changed level (task ids) for a Synopia-driven process, and the tasks
  // that left it before any notification said how they ended (a note wins).
  private live = new Set<string>();
  private gone = new Map<string, Note>();
  private answerOf: (toolUseId: string) => string | undefined;
  private planOf: (toolUseId: string) => string | undefined;
  private titlesOf: () => WrittenTitle[] | undefined;

  // `answerOf`: the card answer Synopia stored for a tool use ("Allow once", "Denied: …"), shown as
  // your turn before the tool. The JSONL holds no text for an allowed permission.
  // `planOf`: the plan text an answered plan card showed; the JSONL's ExitPlanMode input can be an
  // older revision (the CLI reads the plan file when it asks).
  // `titlesOf`: the writer's title history, placed among the records by time (title items).
  constructor(opts: { sidechain?: boolean; home?: string; answerOf?: (toolUseId: string) => string | undefined; planOf?: (toolUseId: string) => string | undefined; titlesOf?: () => WrittenTitle[] | undefined } = {}) {
    this.sidechain = opts.sidechain ?? false;
    this.home = opts.home ?? os.homedir();
    this.answerOf = opts.answerOf ?? (() => undefined);
    this.planOf = opts.planOf ?? (() => undefined);
    this.titlesOf = opts.titlesOf ?? (() => undefined);
    this.r = new ReadState(this.sdkTasks);
  }

  get items(): Item[] { return this.r.items; }
  get customTitle(): string | null { return this.r.customTitle; }
  get aiTitle(): string | null { return this.r.aiTitle; }
  get permissionMode(): string | null { return this.r.permissionMode; }
  get lastNonPlanMode(): string | null { return this.r.lastNonPlanMode; }
  get requestedModel(): unknown { return this.r.requestedModel; }
  get effort(): unknown { return this.r.effort; }
  get firstTs(): string | null { return this.r.firstTs; }
  get lastTs(): string | null { return this.r.lastTs; }
  get apiError(): { text: string; status: number | null; credential: boolean } | null { return this.r.apiError; }

  // The session's ledger by this transcript (main conversation only), or null.
  get ledger(): LedgerFact | null {
    return this.r.ledger ? { ...this.r.ledger, results: this.r.ledgerResults } : null;
  }

  // The ids an Agent tool use's brief owns (its `Open items:` line), [] when none.
  ownsOf(toolUseId: string): string[] {
    return this.r.owns.get(toolUseId) ?? [];
  }

  get title(): string | null {
    return this.r.customTitle || this.r.aiTitle;
  }

  get prs(): unknown[] {
    return this.r.prs.slice(-4);
  }

  get total(): number {
    return this.r.items.length;
  }

  get(id: string): Item | undefined {
    return this.r.byId.get(id);
  }

  // The last `last` items, for a first view.
  view(last = 160): { items: Item[]; total: number } {
    return { items: this.r.items.slice(-last), total: this.r.items.length };
  }

  // Back to empty, for a file that was rewritten (docs/Claude Code transcripts.md#quirk-plan-approval-rewrites-the-file).
  // Subagent links, the process end and what the SDK said are kept: they don't come from the file.
  reset(): void {
    this.r = new ReadState(this.sdkTasks);
    this.r.metaChanged = true;
  }

  takeChanges(): Changes {
    const r = this.r;
    this.placeWritten(Infinity); // the writer's newest titles come after every record read so far
    // Subagents' shells and monitors: their own changes, and all of a changed subagent's (they end with it).
    const bg = new Set(r.changedBg);
    for (const [aid, a] of this.agentMeta) {
      if (!a.sub) continue;
      for (const id of a.sub.takeBackgroundChanges()) bg.add(id);
      if (r.changedAgents.has(aid)) for (const b of a.sub.background()) bg.add(b.toolUseId);
    }
    const out = {
      items: [...r.changed], background: [...bg], agents: [...r.changedAgents], meta: r.metaChanged,
    };
    r.changed.clear();
    r.changedBg.clear();
    r.changedAgents.clear();
    r.metaChanged = false;
    return out;
  }

  // spans: where each record's line sits in the file (Tailer), so a tool's full result can be read again.
  pushAll(records: JsonRecord[], spans?: Span[]): void {
    records.forEach((d, i) => this.push(d, spans?.[i]));
  }

  // Where an image block sits: its record's line in this conversation's file and the path inside it.
  imageAt(ref: string): { span: Span; recordId: string; path: number[] } | null {
    const p = parseRef(ref);
    const span = p && this.r.imageSpans.get(p.recordId);
    return p && span ? { span, ...p } : null;
  }

  // Where the record holding a tool's result sits in this conversation's file.
  resultSpan(toolUseId: string): Span | undefined {
    return this.r.outSpans.get(toolUseId);
  }

  push(d: JsonRecord, span?: Span): void {
    this.reduce(classify(d), span);
  }

  private reduce(rec: ClaudeRecord, span?: Span): void {
    const r = this.r;
    r.span = span;
    r.seq++;
    const ts = rec.ts;
    if (ts) {
      r.firstTs ??= ts;
      r.lastTs = ts;
      const ms = msOf(ts);
      if (ms !== null) this.placeWritten(ms);
    }
    // A subagent's record inside the main file (sidechain) is the subagent's, not this thread's.
    const foreign = rec.sidechain && !this.sidechain;
    if (!foreign && (rec.kind === 'user' || rec.kind === 'assistant' || rec.kind === 'turn-end' || rec.kind === 'queued')) r.apiError = null; // the retry is over
    switch (rec.kind) {
      case 'ai-title':
        r.aiTitle = rec.title || null;
        r.metaChanged = true;
        this.retitle('ai', rec.title, rec.uuid || `title@${r.seq}`, ts);
        return;
      case 'custom-title':
        // An empty one removes your rename.
        r.customTitle = rec.title || null;
        r.metaChanged = true;
        this.retitle('you', rec.title, rec.uuid || `title@${r.seq}`, ts);
        return;
      case 'pr-link':
        if (rec.pr != null && !r.prs.includes(rec.pr)) {
          r.prs.push(rec.pr);
          r.metaChanged = true;
        }
        return;
      case 'permission-mode':
        if (rec.mode) {
          r.permissionMode = rec.mode;
          if (rec.mode !== 'plan') r.lastNonPlanMode = rec.mode;
          r.metaChanged = true;
        }
        return;
      case 'turn-end':
        if (!foreign) this.turnEnd(rec.by, rec.durationMs, rec.sidechain, ts);
        return;
      case 'queued':
        if (foreign) return;
        r.turnOpen = true; // written when a turn takes it in
        r.afterMarker = false;
        if (rec.user) this.user(rec.user, rec.uuid || `attachment@${r.seq}`, true);
        return;
      case 'user':
        if (!foreign) this.user(rec, rec.uuid || `user@${r.seq}`);
        return;
      case 'assistant':
        if (!foreign) this.assistant(rec, rec.uuid || `assistant@${r.seq}`);
        return;
      case 'api-error':
        if (!foreign) r.apiError = { text: rec.text, status: rec.status, credential: rec.credential };
        return;
      case 'other':
        return;
    }
  }

  // turn_duration or stop_hook_summary (docs/Claude Code transcripts.md#turn-ends).
  private turnEnd(by: 'turn_duration' | 'stop_hook_summary', durationMs: number | null, sidechain: boolean, ts: string | null): void {
    const r = this.r;
    r.turnOpen = false;
    r.afterMarker = false;
    const you = r.lastYou;
    if (by === 'turn_duration') {
      if (you && durationMs !== null) {
        you.workedMs = durationMs;
        r.changed.add(you.id);
      }
      return;
    }
    // An SDK-driven CLI (entrypoint sdk-cli, as Synopia's own sessions are) writes stop_hook_summary
    // but rarely turn_duration (2 of 19 turns seen): the time from your prompt to it stands in, and a
    // turn_duration after it (the interactive CLI writes one right after) wins.
    if (sidechain || this.sidechain || !you || you.workedMs !== undefined || you.interrupted) return;
    const from = msOf(you.ts), to = msOf(ts);
    if (from !== null && to !== null && to >= from) {
      you.workedMs = to - from;
      r.changed.add(you.id);
    }
  }

  private user(u: UserRecord, uuid: string, queued = false): void {
    const r = this.r;
    const tu = u.toolUse;
    if (tu && tu.toolUseId) {
      const tid = tu.toolUseId;
      // An Agent launched in the background returns at once: its launch result isn't the end.
      if (tu.asyncLaunched) r.bgTool.set(tid, true);
      // A foreground Bash moved to the background while it ran (Ctrl+B, a timeout, or a message
      // sent during it) returns a backgroundTaskId too (17 such results seen): a background shell from then.
      const fg = r.fgBash.get(tid);
      if (fg && tu.backgroundTaskId && !r.bg.has(tid)) {
        r.bg.set(tid, { ...fg, toolUseId: tid, taskId: null, kind: 'shell', persistent: false, status: 'running', summary: '', end: null });
        this.stopIfEnded(tid);
        r.changedBg.add(tid);
      }
      if (tu.taskId) this.setTask(tid, tu.taskId);
      // A SendMessage woke a subagent that had ended: it runs again (agentRunning).
      if (tu.resumedAgentId && u.ts) {
        r.resumes.set(tu.resumedAgentId, u.ts);
        r.changedAgents.add(tu.resumedAgentId);
      }
      if (tu.edit) {
        r.patches.set(tid, patchOf(tu.edit, this.home));
        this.refreshTool(tid);
      }
      if (tu.bashEdit) {
        r.bashPatches.set(tid, bashPatchesOf(tu.bashEdit, this.home));
        this.refreshTool(tid);
      }
    }
    if (u.results.length) {
      const errors: string[] = [];
      for (const res of u.results) {
        const tid = res.toolUseId;
        if (!r.results.has(tid) && r.ledgerUses.has(tid)) r.ledgerResults++;
        r.results.set(tid, res.isError);
        if (res.outputFile) r.outFiles.set(tid, res.outputFile);
        // A shell or monitor started in the background runs from its result, not its tool use: a permission card
        // or check can hold the tool use first (docs/Claude Code transcripts.md#quirk-a-background-shell-starts-at-its-result).
        const sb = r.bg.get(tid);
        if (sb && !res.isError && u.ts && (r.bgTool.get(tid) || sb.kind === 'monitor') && sb.start && Date.parse(u.ts) > Date.parse(sb.start)) {
          sb.start = u.ts;
          r.changedBg.add(tid);
        }
        if (res.taskId && !r.taskIds.has(tid)) this.setTask(tid, res.taskId); // a subagent's shell or monitor: only its text names it
        r.fgBash.delete(tid);
        // no toolUseResult (a subagent's edit in an SDK-driven session): the change comes from its input
        const fromInput = r.inputEdits.get(tid);
        if (fromInput && !res.isError && !r.patches.has(tid)) r.patches.set(tid, patchOf(fromInput, this.home));
        r.inputEdits.delete(tid);
        if (res.isError) errors.push(tid);
        if (res.cutShort) r.interrupted.add(tid);
        if (res.denial) r.denials.set(tid, res.denial);
        if (r.asks.has(tid)) r.answers.set(tid, clip(res.text, 2000));
        else {
          const interrupted = r.interrupted.has(tid) || (res === u.results[0] && tu?.interrupted === true);
          const pv = previewOf(res.text);
          r.outs.set(tid, { ...pv, ...(interrupted ? { interrupted } : {}), ...(u.ts ? { at: u.ts } : {}) });
          if (r.span) r.outSpans.set(tid, r.span);
          const imgs = imageRefs(uuid, res.images, `${res.index}.`);
          if (imgs.length) {
            r.outImgs.set(tid, imgs);
            if (r.span) r.imageSpans.set(uuid, r.span);
          }
        }
        this.refreshTool(tid);
      }
      r.lastErrors = errors;
    }
    let body = u.body, text = u.text;
    if (body.kind === 'results' || body.kind === 'meta') return;
    // Bash mode (R5.13), as the CLI records it: a `<bash-input>` record, then one with its output, or
    // one record with both, several commands, or the next prompt after them (docs/Claude Code
    // transcripts.md, "Bash mode records"). Each command is an item of its own, in place; the record's
    // uuid goes to its only command, or to the prompt after them. One a running turn took in from its
    // queue is `queued` (the turn goes on through it). One Synopia sent as a turn (R5.13, 2026-11-27:
    // not `context`) counts the turn's time from it, as your prompt does.
    if (body.kind === 'bash-input') {
      const { runs, then } = body;
      for (let n = 0; n < runs.length; n++) {
        const out = runs[n].out;
        r.lastBang = this.put({ id: n || then ? `${uuid}:bang${n}` : uuid, k: 'bang', ts: u.ts, cmd: clip(runs[n].cmd, MAX_BANG_CMD),
          ...(out ? { sh: { ...out, out: clip(out.out, BANG_CAP), err: clip(out.err, BANG_CAP) } } : {}), ...(queued ? { queued } : {}) });
      }
      if (!then && !queued && !body.context && r.lastBang && runs.length === 1) {
        r.afterMarker = false;
        r.lastErrors = [];
        r.lastYou = r.lastBang;
      }
      if (!then) return;
      text = body.rest;
      body = then;
    }
    if (body.kind === 'bash-output') {
      const b = r.lastBang;
      if (body.out && b && !b.sh) {
        b.sh = { ...body.out, out: clip(body.out.out, BANG_CAP), err: clip(body.out.err, BANG_CAP) };
        r.changed.add(b.id);
      }
      return;
    }
    // Synopia continued it in another folder (R3.11): a quiet line in place, not a turn
    if (body.kind === 'moved') {
      this.put({ id: uuid, k: 'moved', ts: u.ts, cwd: body.to });
      return;
    }
    // Synopia resumed a turn the credentials failed (R8.2, 2026-11-26): a quiet line that opens Claude's turn
    if (body.kind === 'resumed') {
      r.turnOpen = true;
      r.afterMarker = false;
      r.lastErrors = [];
      r.lastYou = this.put({ id: uuid, k: 'resumed', ts: u.ts });
      return;
    }
    for (const n of u.notes) this.note(n, u.ts);
    if (body.kind === 'notification' || body.kind === 'system') return;
    if (body.kind === 'report') {
      // A message from one of this session's own subagents is its report: one per subagent, in
      // place of the <result> one. Messages from other sessions stay one item each.
      const agent = body.agent;
      const own = Boolean(agent && this.toolOfAgent(agent));
      if (own && agent) r.reportKind.set(agent, 'message');
      this.put({ id: own ? `report:${agent}` : uuid, k: 'report', ts: u.ts, agent, text: clip(body.text.trim(), 3000) });
      return;
    }
    if (body.kind === 'command') {
      r.lastYou = this.put({ id: uuid, k: 'you', ts: u.ts, text: body.text });
      r.turnOpen = true;
      r.afterMarker = false;
      return;
    }
    const images = u.images.length;
    const item: Item = { id: uuid, k: 'you', ts: u.ts, text: clip(text), images, ...(queued ? { queued } : {}) };
    if (images) {
      item.imgs = imageRefs(uuid, u.images);
      if (r.span) r.imageSpans.set(uuid, r.span);
    }
    if (body.kind === 'interrupt') {
      // Stopped by you, or a tool you turned down (Claude carries on after it).
      if (body.interrupt === 'stop') item.interrupted = true;
      else item.turnedDown = true;
      // The CLI writes the tools the interrupt cut short as error results just before this marker.
      for (const tid of r.lastErrors) {
        r.interrupted.add(tid);
        this.refreshTool(tid);
      }
      // Either marker ends the turn for now (a later assistant record means Claude carried on).
      r.turnOpen = false;
      r.afterMarker = true;
      r.lastErrors = [];
      const put = this.put(item);
      // A turned-down tool is not a prompt: the turn's time still counts from yours.
      if (body.interrupt === 'stop') r.lastYou = put;
      return;
    }
    // Any other prompt you typed opens a turn.
    r.turnOpen = true;
    r.afterMarker = false;
    r.lastErrors = [];
    r.lastYou = this.put(item);
  }

  // One task notification: the task it ends, and a subagent's last message as its report.
  private note(n: TaskNote, ts: string | null): void {
    const r = this.r;
    // A subagent woken again after its first end notifies by task id only, or with the tool use id of
    // what woke it (a SendMessage): its own Agent tool use wins.
    const tid = (n.taskId ? this.toolOfAgent(n.taskId) : null) ?? n.toolUseId;
    if (n.event !== null && n.taskId) { // a monitor's output lines, by its task id (its view shows them, R7.2)
      const list = r.events.get(n.taskId) ?? [];
      list.push({ n: (list.at(-1)?.n ?? -1) + 1, ts, text: clip(n.event, 4000) });
      if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS);
      r.events.set(n.taskId, list);
    }
    if (tid && n.outputFile) r.outFiles.set(tid, n.outputFile);
    if (!tid) return; // a monitor's event: it keeps running
    if (n.taskId) this.setTask(tid, n.taskId);
    const end: Note = { status: n.status ?? 'completed', summary: n.summary ?? '', end: ts, ...(n.waiting ? { waiting: true } : {}) };
    r.notes.set(tid, end);
    if (!n.waiting) this.addEnd(tid, end);
    // A subagent's last message comes back as <result>: its report, unless it sent one itself. While it
    // waits on its own background work that message isn't its report yet.
    const tool = r.byId.get(tid);
    if (n.result !== null && !n.waiting && n.taskId && tool && (tool.name === 'Agent' || tool.name === 'Task') && !r.reportKind.has(n.taskId)) {
      r.reportKind.set(n.taskId, 'result');
      this.put({ id: `report:${n.taskId}`, k: 'report', ts, agent: n.taskId, text: clip(n.result.trim(), 3000) });
    }
    this.refreshTool(tid);
  }

  private assistant(a: AssistantRecord, uuid: string): void {
    const r = this.r;
    const ts = a.ts;
    r.lastErrors = [];
    if (a.requestedModel !== undefined) r.requestedModel = a.requestedModel;
    if (a.effort !== undefined) r.effort = a.effort;
    if (r.afterMarker) r.turnOpen = true;
    r.afterMarker = false;
    // One block per record: the latest message's tool uses span all records of its id.
    const key = a.messageId || `record:${uuid}`;
    if (r.message.key !== key) r.message = { key, uses: [] };
    for (const b of a.blocks) {
      if (b.type === 'text') {
        if (!b.text.trim()) continue;
        const id = `${uuid}:${b.index}`, aside = r.asideOf.get(key);
        this.put({ id, k: 'claude', ts, text: clip(b.text), ...(aside ? { aside } : {}) });
        if (a.messageId) r.textsOf.set(key, [...(r.textsOf.get(key) ?? []).filter((x) => x !== id), id]);
        continue;
      }
      if (b.type !== 'tool_use') continue;
      const tid = b.id || `${uuid}:${b.index}`;
      r.message.uses.push({ id: tid, ts, name: b.name });
      this.toolUse(b, tid, ts);
      if (!this.sidechain) this.openItemFacts(b, tid, ts, a.cwd);
    }
  }

  // FR-ITEM-01, FR-ITEM-04: a tool use naming a ledger, and an Agent brief's owned ids. Only the brief's
  // ids are kept, not its prompt.
  private openItemFacts(b: ToolUse, tid: string, ts: string | null, cwd: string): void {
    const r = this.r, name = b.name;
    const p = typeof b.input.file_path === 'string' ? b.input.file_path : '';
    const tl = name === OPEN_ITEMS && typeof b.input.ledger === 'string' ? b.input.ledger : ''; // open_items' `ledger` (FR-ITEM-12)
    const led = name === 'Read' || name === 'Write' || name === 'Edit' ? (p ? ledgerPathOf(p, cwd, this.home) : null)
      : name === 'Bash' ? ledgerPathIn(b.command, cwd, this.home) : tl ? ledgerPathOf(tl, cwd, this.home) : null;
    if (led) {
      r.ledger = { path: led, at: ts, toolUseId: tid };
      r.ledgerUses.add(tid);
      if (r.results.has(tid)) r.ledgerResults++; // its result came first
    }
    if ((name === 'Agent' || name === 'Task') && typeof b.input.prompt === 'string') {
      const ids = ownedIds(b.input.prompt);
      if (ids.length) r.owns.set(tid, ids);
      else r.owns.delete(tid);
    }
  }

  private toolUse(b: ToolUse, tid: string, ts: string | null): void {
    const r = this.r;
    const name = b.name;
    r.bgTool.set(tid, b.background);
    if (b.edit && !r.results.has(tid)) r.inputEdits.set(tid, b.edit);
    if (name === 'Monitor' || (name === 'Bash' && b.background)) {
      r.bg.set(tid, {
        toolUseId: tid, taskId: r.taskIds.get(tid) ?? null, kind: name === 'Monitor' ? 'monitor' : 'shell', description: b.description,
        command: b.command.slice(0, 300), timeout: b.timeoutMs, persistent: b.persistent,
        start: ts, status: 'running', summary: '', end: null,
      });
      this.stopIfEnded(tid);
      r.changedBg.add(tid);
    } else if (name === 'Bash') {
      r.fgBash.set(tid, { description: b.description, command: b.command.slice(0, 300), timeout: b.timeout, start: ts });
      if (this.isLive(tid)) this.toBackground(tid); // backgrounded before this file was read again
    }
    if (name === 'AskUserQuestion') {
      r.asks.add(tid);
      this.put({ id: tid, k: 'ask', ts, qs: b.questions, answer: null, state: 'pending' });
    } else {
      // The plan sits in the transcript as Claude's reply (R6.6); the card holds only the decision.
      const plan = name === 'ExitPlanMode' ? this.planOf(tid) ?? b.plan : '';
      if (plan.trim()) this.put({ id: `plan:${tid}`, k: 'claude', ts, text: clip(plan) });
      const [verb, o] = toolLine(name, b.input, this.home);
      const item: Item = { id: tid, k: 'tool', ts, name, verb, obj: o.slice(0, 200), state: 'running' };
      if (name === 'SendMessage' && b.to !== null) item.to = b.to.slice(0, 80); // whom it went to
      if (name === 'Agent' || name === 'Task') item.toolUseId = tid;
      const input = inputOf(name, b.input);
      if (input) item.input = input;
      this.put(item);
    }
    this.refreshTool(tid);
  }

  // The session's process ended at `at` (close, idle end, quit, failure). Background shells,
  // monitors and subagents live inside it, so those started before then and still running read as
  // stopped. A notification that arrives later still wins. A foreground tool started before then
  // with no result reads as failed when the process failed (`failed`), else as stopped.
  processEnded(at: string, failed = false): void {
    const ms = msOf(at);
    if (ms === null || (this.endedMs !== null && this.endedMs >= ms)) return;
    this.ended = at;
    this.endedMs = ms;
    this.endedFailed = failed;
    this.live.clear(); // the level is per process: the next one starts empty
    const r = this.r;
    for (const tid of r.bg.keys()) this.stopIfEnded(tid);
    for (const it of r.items) if (it.k === 'tool' && it.state === 'running') this.refreshTool(it.id);
    for (const [aid, a] of this.agentMeta) {
      const tid = a.meta?.toolUseId;
      if (tid) this.refreshTool(tid);
      r.changedAgents.add(aid);
    }
  }

  // A task ended, as the SDK's task_notification says (`end` ISO): it reads as ended until the
  // JSONL's own notification lands, which wins.
  // A subagent resumed after an end is keyed by its task id (the agent id): its own Agent tool use wins.
  taskEnded(tid0: string, status: string, summary: string, end: string, taskId = ''): void {
    const tid = (taskId && this.toolOfAgent(taskId)) || tid0;
    const aid = taskId && tid !== tid0 ? taskId : this.agentOfTool(tid);
    if (this.r.notes.has(tid) && !(aid && this.resumedAt(aid))) return;
    const note: Note = { status, summary, end };
    this.r.notes.set(tid, note);
    this.addEnd(tid, note, true);
    this.refreshTool(tid);
  }

  // A task started, as the SDK's task_started says: its task id (background_tasks_changed lists these), and for a foreground
  // Bash or Agent the sign that b, b can move it (docs/Claude Code
  // transcripts.md#quirk-subagent-shells-have-no-task-id-in-sdk-sessions).
  taskStarted(tid: string, task: string): void {
    if (!tid || !task || this.sdkTasks.has(tid)) return;
    this.sdkTasks.set(tid, task);
    if (!this.r.taskIds.has(tid)) this.setTask(tid, task);
    for (const a of this.agentMeta.values()) if (a.sub?.getBackground(tid)) this.r.changedBg.add(tid);
    this.refreshTool(tid); // a foreground step can go to the background from now (`fg`)
  }

  // f, f's interrupt route (R9.8, 2026-11-26): the live line as it was, kept as a still record at the end,
  // naming the main step it named then (the newest step of the turn's own, while it runs). `msg`: the
  // message Claude was writing (the stream preview's), whose text, landed or still to land, is greyed above it.
  setAside(at: string, msg: string | null): void {
    const r = this.r;
    const last = [...r.items].reverse().find((i) => i.k === 'tool' && !i.bg);
    const id = `aside:${at}`;
    this.put({ id, k: 'aside', ts: at, ...(last && last.state === 'running' ? { step: last.id } : {}) });
    if (!msg) return;
    r.asideOf.set(msg, id);
    for (const t of r.textsOf.get(msg) ?? []) {
      const it = r.byId.get(t);
      if (it) { it.aside = id; r.changed.add(t); }
    }
  }

  // f, f (R9.8): the main conversation's running foreground Bash and Agent steps by tool use id.
  // `ready`: its task_started came, so backgroundTasks(id) moves it; `early`: not yet (the 2 s gap).
  foreground(): { ready: string[]; early: string[] } {
    const ready: string[] = [], early: string[] = [];
    for (const it of this.r.items) {
      if (it.k !== 'tool' || it.state !== 'running' || !(it.name === 'Bash' || it.name === 'Agent' || it.name === 'Task')) continue;
      if (it.fg) ready.push(it.id);
      else if (!this.sdkTasks.has(it.id) && !this.r.bgTool.get(it.id) && !this.r.bg.has(it.id)) early.push(it.id);
    }
    return { ready, early };
  }

  // The SDK's background_tasks_changed: the whole set of the process's live background tasks (task
  // ids; the caller leaves ambient ones out). A foreground Bash or Agent that joins it went to the
  // background (b, b or Ctrl+B): at once a running shell, or an Agent that runs until its
  // notification, under its tool use id, so the transcript's own result later adds nothing. A task
  // that leaves it with no notification yet reads as completed until one says how it ended.
  backgroundTasks(taskIds: string[], at: string): void {
    const now = new Set(taskIds);
    const byTask = new Map([...this.r.taskIds].map(([tid, task]) => [task, tid]));
    for (const task of this.live) {
      const tid = byTask.get(task);
      if (now.has(task) || !tid || this.r.notes.has(tid)) continue;
      this.gone.set(tid, { status: 'completed', summary: '', end: at });
      this.refreshTool(tid);
    }
    this.live = now;
    for (const task of now) {
      const tid = byTask.get(task);
      if (tid) this.toBackground(tid);
    }
  }

  private isLive(tid: string): boolean {
    const task = this.r.taskIds.get(tid);
    return Boolean(task && this.live.has(task));
  }

  // A foreground Bash or Agent of this file that is background work now; nothing for other tools.
  private toBackground(tid: string): void {
    const r = this.r;
    const fg = r.fgBash.get(tid);
    const it = r.byId.get(tid);
    if (fg && !r.bg.has(tid)) {
      r.bg.set(tid, { ...fg, toolUseId: tid, taskId: r.taskIds.get(tid) ?? null, kind: 'shell', persistent: false, status: 'running', summary: '', end: null });
      this.stopIfEnded(tid);
      r.changedBg.add(tid);
    } else if (it && (it.name === 'Agent' || it.name === 'Task') && !r.bgTool.get(tid)) {
      r.bgTool.set(tid, true);
    } else return;
    this.refreshTool(tid);
  }

  // Started no later than the process ended (by time, not by text). No time: before.
  private endedBefore(ts: string | null | undefined): boolean {
    if (this.endedMs === null) return false;
    const ms = msOf(ts);
    return ms === null || ms <= this.endedMs;
  }

  private stopIfEnded(tid: string): void {
    const b = this.r.bg.get(tid);
    if (!b || b.status !== 'running' || this.noteOf(tid) || !this.endedBefore(b.start)) return;
    b.status = 'stopped';
    b.end = this.ended;
    this.r.changedBg.add(tid);
  }

  // The writer's titles up to `ms` (inclusive) not placed yet, oldest first, as title items here.
  private placeWritten(ms: number): void {
    if (this.sidechain) return;
    const r = this.r;
    const due = (this.titlesOf() ?? []).filter((h) => h.at > r.writtenAt && h.at <= ms).sort((a, b) => a.at - b.at);
    for (const h of due) {
      r.writtenAt = h.at;
      this.retitle('written', h.title, `title:${h.at}`, new Date(h.at).toISOString());
    }
  }

  // One source of the title changed ('' : that source has none now, as when you remove a rename).
  // A title item when the title the header shows (custom, else written, else ai) changes to one
  // that differs in more than case and spaces; none for the first title (it names the session,
  // nothing was retitled) nor before your first prompt.
  private retitle(source: 'you' | 'written' | 'ai', title: string, id: string, ts: string | null): void {
    const r = this.r;
    const clean = title.replace(/\s+/g, ' ').trim();
    if (this.sidechain || (!clean && source !== 'you')) return;
    r.titles[source] = clean;
    const shown = r.titles.you || r.titles.written || r.titles.ai;
    if (!shown) return; // no title left: the header falls back to the first prompt
    const key = titleKey(shown);
    const prev = r.shownTitle;
    r.shownTitle = key;
    if (prev === null || prev === key || !r.prompted) return;
    this.put({ id, k: 'title', ts, title: shown, by: r.titles.you ? 'you' : 'claude' });
  }

  private put(item: Item): Item {
    const r = this.r;
    if (item.k === 'you') r.prompted = true;
    const old = r.byId.get(item.id);
    if (old) {
      for (const key of Object.keys(old)) delete (old as Record<string, unknown>)[key];
      Object.assign(old, item);
      item = old;
    } else {
      r.items.push(item);
      r.byId.set(item.id, item);
    }
    r.changed.add(item.id);
    return item;
  }

  // Recomputes everything a tool id feeds: the item's state, patch or answer, the background
  // entry and the subagents linked to it. Order-independent: records can come in any order.
  private refreshTool(tid: string): void {
    const r = this.r;
    const it = r.byId.get(tid);
    const res = r.results.get(tid);
    const note = this.noteOf(tid);
    if (it && it.k === 'ask') {
      const answer = r.answers.get(tid) ?? null;
      const state = res !== undefined ? 'answered' : 'pending';
      if (it.answer !== answer || it.state !== state) {
        it.answer = answer;
        it.state = state;
        r.changed.add(tid);
      }
    } else if (it && it.k === 'tool') {
      let state: string;
      const answer = res !== undefined ? this.answerOf(tid) : undefined;
      const denial = res ? r.denials.get(tid) : undefined;
      if ((it.name === 'Agent' || it.name === 'Task') && res === false) {
        state = (note && !note.waiting) || !r.bgTool.get(tid) || this.endedBefore(it.ts) ? 'done' : 'running';
      } else if (res !== undefined) {
        // You denied it, or sent the plan back: your answer above says so, it didn't fail. Auto mode
        // blocked it, or you turned it down at a terminal: denied too, before the marker that follows.
        state = !res ? 'done' : denial ? 'denied' : r.interrupted.has(tid) ? 'stopped' : answer && /^(Denied|Changes)\b/.test(answer) ? 'denied' : 'failed';
      }
      // A plan with no answer stays running: the page shows it as "Not answered".
      else if (it.name !== 'ExitPlanMode' && this.endedBefore(it.ts)) state = this.endedFailed ? 'failed' : 'stopped';
      else state = 'running';
      const patch = r.patches.get(tid);
      const bash = r.bashPatches.get(tid);
      const out = r.outs.get(tid);
      const imgs = r.outImgs.get(tid);
      // Only once the CLI registered it as a task (the SDK's task_started, about 2 s into a Bash
      // command, live check 2026-11-24): backgroundTasks() before then moves nothing.
      const fg = state === 'running' && res === undefined && (it.name === 'Bash' || it.name === 'Agent' || it.name === 'Task') && !r.bgTool.get(tid) && !r.bg.has(tid) && this.sdkTasks.has(tid);
      if (Boolean(it.fg) !== fg) {
        if (fg) it.fg = true;
        else delete it.fg;
        r.changed.add(tid);
      }
      // A subagent or shell that runs in the background: not the main turn's own step, so the live line doesn't name it
      const bg = state === 'running' && (Boolean(r.bgTool.get(tid)) || r.bg.has(tid));
      if (Boolean(it.bg) !== bg) {
        if (bg) it.bg = true;
        else delete it.bg;
        r.changed.add(tid);
      }
      const plan = it.name === 'ExitPlanMode' ? this.planOf(tid) : undefined;
      const planItem = plan ? r.byId.get(`plan:${tid}`) : undefined;
      if (plan && planItem && planItem.text !== clip(plan)) {
        planItem.text = clip(plan);
        r.changed.add(planItem.id);
      }
      const started = state === 'done' && out ? sessionOf(it.name ?? '', out.text) : null;
      if (it.state !== state || it.patch !== patch || (bash && it.patches !== bash.patches) || (out && it.out !== out) || (imgs && it.imgs !== imgs) || (answer && it.answer !== answer) || it.denied !== denial || (it.session ?? null) !== started) {
        it.state = state;
        if (started) it.session = started;
        else delete it.session;
        if (denial) it.denied = denial;
        else delete it.denied;
        if (out) it.out = out;
        if (imgs) it.imgs = imgs;
        if (patch) it.patch = patch;
        if (bash) {
          it.patches = bash.patches;
          if (bash.more) it.moreFiles = bash.more;
        }
        if (answer) it.answer = answer;
        r.changed.add(tid);
      }
    }
    const b = r.bg.get(tid);
    if (b && note && (b.status !== note.status || b.end !== note.end || b.summary !== note.summary)) {
      Object.assign(b, note);
      r.changedBg.add(tid);
    }
    for (const [aid, a] of this.agentMeta) {
      if (a.meta && a.meta.toolUseId === tid) r.changedAgents.add(aid);
      if (!b && a.sub?.getBackground(tid)) r.changedBg.add(tid); // a subagent's, notified in this file
    }
  }

  // The Agent tool_use id of one of this conversation's subagents (from its launch result or its meta).
  private toolOfAgent(agentId: string): string | null {
    if (!agentId) return null;
    const meta = this.agentMeta.get(agentId)?.meta;
    if (meta && meta.toolUseId) return meta.toolUseId;
    for (const [tid, task] of this.r.taskIds) {
      const it = this.r.byId.get(tid);
      if (task === agentId && it && (it.name === 'Agent' || it.name === 'Task')) return tid;
    }
    return null;
  }

  // The subagent whose Agent tool use this is, by its meta.
  private agentOfTool(tid: string): string | null {
    for (const [aid, a] of this.agentMeta) if (tid && a.meta?.toolUseId === tid) return aid;
    return null;
  }

  // How a task ended: its notification (the JSONL's or the SDK's), else its leaving the live set.
  private noteOf(tid: string): Note | undefined {
    return this.r.notes.get(tid) ?? this.gone.get(tid);
  }

  // A subagent's latest end that wasn't "waiting" (a notification, or its leaving the SDK's live set).
  private lastEnd(aid: string): Note | undefined {
    const tid = this.agentMeta.get(aid)?.meta?.toolUseId ?? '';
    return this.r.ends.get(tid)?.at(-1) ?? this.gone.get(tid);
  }

  // Resumed after its latest end (R7.1, 2026-11-26): when its new run began, else null. A SendMessage
  // result after that end names it (`resumedAgentId`), or its file got records well after it (WOKE_MS).
  // The meta keeps `finished: true` through a resume, so that flag can't tell (docs/Claude Code
  // transcripts.md#a-subagent-resumed-by-sendmessage). The run ends at its next notification.
  private resumedAt(aid: string): string | null {
    const end = this.lastEnd(aid), at = this.r.resumes.get(aid) ?? null;
    const endMs = msOf(end?.end), atMs = msOf(at);
    if (!end) return at; // a resume before any end was seen: its meta said finished, the notification lags
    if (endMs === null) return null;
    if (atMs !== null && atMs > endMs) return at;
    const last = msOf(this.agentMeta.get(aid)?.sub?.lastTs);
    return last !== null && last - endMs > WOKE_MS ? end.end : null;
  }

  // When each run of a subagent ended (ms), oldest first, and whether it was stopped: its end
  // notifications, else (none, and it is over) its last record (status.ts blockedSubagent).
  runEnds(aid: string): { at: number; stopped: boolean }[] {
    const tid = this.agentMeta.get(aid)?.meta?.toolUseId ?? '';
    const stopped = (s: string) => s === 'killed' || s === 'stopped';
    const out = (this.r.ends.get(tid) ?? []).flatMap((e) => { const at = msOf(e.end); return at === null ? [] : [{ at, stopped: stopped(e.status) }]; });
    if (out.length) return out;
    const a = this.getAgent(aid), at = msOf(a?.end);
    return a && !a.running && at !== null ? [{ at, stopped: a.stopped }] : [];
  }

  private setTask(tid: string, task: string): void {
    const r = this.r;
    if (r.taskIds.get(tid) === task) return;
    r.taskIds.set(tid, task);
    const b = r.bg.get(tid);
    if (b) {
      b.taskId = task;
      r.changedBg.add(tid);
    }
  }

  // The main thread's shells and monitors, then each subagent's, tagged with its id.
  background(): Background[] {
    const out = [...this.r.bg.values()];
    for (const aid of [...this.agentMeta.keys()].sort()) {
      const sub = this.agentMeta.get(aid)?.sub;
      if (sub) for (const b of sub.background()) out.push(this.subBackground(aid, sub, b));
    }
    return out;
  }

  // A shell's or monitor's output source, from this file and its subagents' (a subagent's monitor
  // can be notified in either).
  outputOf(id: string): BgOutput | undefined {
    const b = this.getBackground(id);
    if (!b) return undefined;
    const reads = [this.r, ...[...this.agentMeta.values()].flatMap((a) => (a.sub ? [a.sub.r] : []))];
    const file = reads.map((r) => r.outFiles.get(id)).find(Boolean) ?? null;
    const events = b.taskId ? reads.flatMap((r) => r.events.get(b.taskId as string) ?? []) : [];
    if (reads.filter((r) => b.taskId && r.events.has(b.taskId)).length < 2) return { kind: b.kind, file, events };
    // both files have some: by time, counted again (each keeps far fewer than MAX_EVENTS)
    events.sort((x, y) => (x.ts ?? '').localeCompare(y.ts ?? ''));
    return { kind: b.kind, file, events: events.map((e, n) => ({ ...e, n })) };
  }

  getBackground(id: string): Background | undefined {
    const own = this.r.bg.get(id);
    if (own) return own;
    for (const [aid, a] of this.agentMeta) {
      const b = a.sub?.getBackground(id);
      if (b && a.sub) return this.subBackground(aid, a.sub, b);
    }
    return undefined;
  }

  // A shell or monitor a subagent started lives in that subagent's file. Its notification can
  // land there (already in `b`) or in this file. With none, it runs while its subagent runs (a
  // subagent waiting on it runs). Once the subagent is over it ended with it: a background subagent
  // that notified "finished" had none of its own work running (the CLI says "waiting" then), so it
  // had ended; otherwise (a foreground subagent, stopped, failed, or the process ended) it was stopped.
  private subBackground(aid: string, sub: Transcript, b0: Background): Background {
    const b: Background = { ...b0, taskId: b0.taskId ?? this.r.taskIds.get(b0.toolUseId) ?? null, agentId: aid };
    if (b.status !== 'running') return b;
    const note = this.noteOf(b.toolUseId);
    if (note) return Object.assign(b, note);
    const tid = this.agentMeta.get(aid)?.meta?.toolUseId ?? '';
    // Started in a run of the subagent that ended before it was resumed: it ended with that run.
    const before = this.endedRunOf(aid, b);
    if (!before && this.agentRunning(aid)) return b;
    const fin = before ?? this.noteOf(tid);
    const finished = Boolean(fin && !fin.waiting && fin.status === 'completed' && this.r.bgTool.get(tid) && (before || !this.endedAgent(aid)));
    const end = before ? before.end : sub.lastTs;
    if (finished) Object.assign(b, { status: 'completed', summary: 'Ended before its subagent finished', end: end ?? fin?.end ?? null });
    else Object.assign(b, { status: 'stopped', summary: 'Ended with its subagent', end: end ?? this.ended });
    return b;
  }

  // The end of an earlier run of the subagent, one it was resumed after, that a shell or monitor of its
  // own started in; undefined for one of its latest run.
  private endedRunOf(aid: string, b: Background): Note | undefined {
    const from = msOf(b.start);
    if (from === null) return undefined;
    const ends = this.r.ends.get(this.agentMeta.get(aid)?.meta?.toolUseId ?? '') ?? [];
    const resumed = msOf(this.r.resumes.get(aid)), back = this.resumedAt(aid);
    for (let i = 0; i < ends.length; i++) {
      const at = msOf(ends[i].end);
      if (at === null || at < from) continue;
      // the run it started in ended here; was the subagent resumed after?
      return i < ends.length - 1 || back || (resumed !== null && resumed > at) ? ends[i] : undefined;
    }
    return undefined;
  }

  // One more end of a task. The SDK's note of an end gives way to the JSONL's of the same end.
  private addEnd(tid: string, note: Note, sdk = false): void {
    const list = this.r.ends.get(tid) ?? [];
    if (!sdk && this.r.sdkEnd.has(list.at(-1) as Note)) list.pop();
    list.push(note);
    if (sdk) this.r.sdkEnd.add(note);
    this.r.ends.set(tid, list);
  }

  // A subagent's own shells or monitors with no end yet (a notification in either file, or the SDK's).
  private ownRunning(aid: string): boolean {
    const sub = this.agentMeta.get(aid)?.sub;
    return Boolean(sub && sub.background().some((b) => b.status === 'running' && !this.noteOf(b.toolUseId) && !this.endedRunOf(aid, b)));
  }

  // The subagent's file has records after `at`: it woke (its own work ended, or a message came).
  private wokeAfter(aid: string, at: string | null): boolean {
    const last = msOf(this.agentMeta.get(aid)?.sub?.lastTs), from = msOf(at);
    return last !== null && from !== null && last > from;
  }

  // Its turn ended with its own background work running: its latest notification says it waits and it
  // hasn't woken since, or (that notification not here yet) a background subagent's meta says finished.
  private idleWaiting(aid: string): boolean {
    const a = this.agentMeta.get(aid);
    const tid = a?.meta?.toolUseId ?? '', note = this.noteOf(tid);
    if (note) return Boolean(note.waiting) && !this.wokeAfter(aid, note.end);
    return Boolean(a?.meta?.finished && tid && this.r.bgTool.get(tid)) && this.ownRunning(aid);
  }

  // This (subagent's) conversation's background ids that changed since last asked.
  takeBackgroundChanges(): string[] {
    const out = [...this.r.changedBg];
    this.r.changedBg.clear();
    return out;
  }

  // Links a subagent to this (main) conversation. `meta` is its .meta.json (null until it
  // arrives), `sub` its own Transcript. Call again when either changes.
  setAgent(id: string, meta: JsonRecord | null | undefined, sub?: Transcript | null): void {
    const a = this.agentMeta.get(id) ?? { meta: null, sub: null };
    if (meta !== undefined) a.meta = meta ? agentMetaOf(meta) : null;
    if (sub !== undefined) a.sub = sub;
    this.agentMeta.set(id, a);
    this.r.changedAgents.add(id);
  }

  // The latest message's tool uses still waiting for a result (and the process didn't end after them).
  private waiting(): ToolUseRef[] {
    return this.r.message.uses.filter((u) => !this.r.results.has(u.id) && !this.endedBefore(u.ts));
  }

  // The main thread's turn runs (by the transcript alone): the latest assistant message has a
  // tool_use with no result yet (and the process didn't end after it), or a turn is open and the
  // transcript changed within `quietMs`, so a crashed process doesn't read as working for ever.
  // A question or plan with no result waits on you, not on work: it is pendingAsk's, and goes stale.
  turnRunning(now: number, quietMs: number): boolean {
    if (this.waiting().some((u) => u.name !== 'AskUserQuestion' && u.name !== 'ExitPlanMode')) return true;
    if (!this.r.turnOpen || this.endedBefore(this.r.lastTs)) return false;
    const last = msOf(this.r.lastTs);
    return last !== null && now - last < quietMs;
  }

  // A question or plan waiting for its answer (R6.8): the latest assistant message of this thread
  // has an AskUserQuestion or ExitPlanMode with no result (and the process didn't end after it);
  // else the first running subagent's own. Null when none waits. With `now` and `staleMs`, also null
  // when no record here or in a subagent's file is younger than `staleMs`, nor the file itself
  // (`changedAt`, its mtime in ms): the process that asked is gone.
  pendingAsk(now?: number, staleMs?: number, changedAt?: () => number): PendingAsk | null {
    if (now !== undefined && staleMs !== undefined) {
      const last = this.lastActivity();
      if (last && now - last >= staleMs && now - (changedAt?.() ?? 0) >= staleMs) return null;
    }
    const u = this.waiting().find((x) => x.name === 'AskUserQuestion' || x.name === 'ExitPlanMode');
    if (u) {
      const since = msOf(u.ts) ?? 0;
      if (u.name === 'AskUserQuestion') return { kind: 'question', toolUseId: u.id, agentId: null, since, qs: this.r.byId.get(u.id)?.qs ?? [] };
      return { kind: 'plan', toolUseId: u.id, agentId: null, since, plan: this.r.byId.get(`plan:${u.id}`)?.text ?? '' };
    }
    for (const [aid, a] of [...this.agentMeta].sort(([x], [y]) => (x < y ? -1 : 1))) {
      if (!a.sub || !this.agentRunning(aid)) continue;
      const sub = a.sub.pendingAsk();
      if (sub && !sub.agentId) return { ...sub, agentId: aid };
    }
    return null;
  }

  // The latest record time (ms) in this file or a subagent's, 0 when none has one.
  private lastActivity(): number {
    let last = msOf(this.r.lastTs) ?? 0;
    for (const a of this.agentMeta.values()) last = Math.max(last, msOf(a.sub?.lastTs) ?? 0);
    return last;
  }

  // Running when `finished` isn't true, its Agent tool has no (final) result and no task
  // notification arrived. A background Agent's launch result isn't final: it ends with the notification.
  // A subagent waiting on its own background work runs too (the CLI marks it `finished` and notifies
  // "waiting"): while that work runs, or once it woke after the notification, until a later one ends it.
  // Resumed after an end (resumedAt), it runs again until its next notification or the process's end.
  agentRunning(id: string): boolean {
    const a = this.agentMeta.get(id);
    if (!a) return false;
    const back = this.resumedAt(id);
    if (back) return !this.endedBefore(back);
    const tid = a.meta?.toolUseId ?? '';
    const note = this.noteOf(tid);
    if (note && !note.waiting) return false;
    if (this.endedAgent(id)) return false;
    if (note) return this.ownRunning(id) || this.wokeAfter(id, note.end);
    if (a.meta?.finished) return this.idleWaiting(id);
    if (!tid) return true;
    const res = this.r.results.get(tid);
    if (res === undefined) return true;
    return !res && Boolean(this.r.bgTool.get(tid));
  }

  // A subagent that had not finished when the session's process ended (it started before then).
  private endedAgent(id: string): boolean {
    const a = this.agentMeta.get(id);
    if (!a || this.endedMs === null) return false;
    const back = this.resumedAt(id);
    if (back) return this.endedBefore(back);
    const r = this.r;
    const tid = a.meta?.toolUseId ?? '';
    const note = r.notes.get(tid);
    if (note && !note.waiting) return false;
    if (a.meta?.finished && !note && !this.idleWaiting(id)) return false;
    if (tid && r.results.get(tid) !== undefined && !(r.results.get(tid) === false && r.bgTool.get(tid))) return false; // its result came: finished
    return this.endedBefore((tid && r.byId.get(tid)?.ts) || a.sub?.firstTs);
  }

  getAgent(id: string): Agent | undefined {
    const a = this.agentMeta.get(id);
    if (!a) return undefined;
    const meta = a.meta;
    const description = meta?.description ?? '';
    const running = this.agentRunning(id);
    const note = this.noteOf(meta?.toolUseId ?? '');
    // resumed, the end before says nothing about this run
    const status = note && !note.waiting && !this.resumedAt(id) ? note.status : '';
    return {
      id, type: meta?.agentType || 'subagent', fork: meta?.isFork ?? false, description,
      toolUseId: meta?.toolUseId || null, model: meta?.model ?? null, depth: meta?.spawnDepth ?? 1,
      finished: !running, running, review: /^for review:/i.test(description),
      // the meta's stop flag, like `finished`, may outlive a resume: the run's own notification says then
      stopped: !running && ((meta?.stoppedByUser === true && !this.r.resumes.has(id)) || status === 'stopped' || status === 'killed' || (!status && this.endedAgent(id))),
      waiting: running && this.idleWaiting(id),
      start: a.sub?.firstTs ?? null, end: a.sub?.lastTs ?? null, total: a.sub?.total ?? 0,
    };
  }

  agents(): Agent[] {
    return [...this.agentMeta.keys()].sort().map((id) => this.getAgent(id) as Agent);
  }
}
// `<session>.jsonl` -> `<session>/`, the folder that holds `subagents/`.
export function sessionDirOf(transcriptPath: string): string {
  return transcriptPath.replace(/\.jsonl$/, '');
}
