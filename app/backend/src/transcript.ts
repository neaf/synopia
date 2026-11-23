// JSONL records to items for one conversation (the main one or a subagent's).
// A stateful port of export_transcripts.py lines 101-252 (plan section 7): records arrive in
// file order, and a later record (a tool result, a task notification) updates an earlier item
// in place. Every item has a stable id; takeChanges() lists what changed since the last call.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { JsonRecord, Span } from './tail.ts';
import { displayIn } from './paths.ts';

export type Hunk = { o: number; n: number; lines: string[] };
// `bare`: a file a shell command changed with no diff in the record (bashEditDiff.changedFiles).
export type Patch = {
  file: string; abs: string; add: number; del: number; created: boolean; cut: boolean; hunks: Hunk[]; bare?: boolean;
};
// A tool result's preview: its first PREVIEW_LINES lines, PREVIEW_BYTES at most; `lines` counts all
// of them, `cut` says the preview isn't all (the page asks for the rest with `toolOutput`).
export type Output = { text: string; lines: number; cut: boolean; interrupted?: boolean };
export type Question = { q: string; header: unknown; multi: boolean; opts: [string, string][] };
export type Item = {
  id: string; k: 'you' | 'claude' | 'tool' | 'report' | 'ask'; ts: string | null;
  text?: string; images?: number; interrupted?: boolean; workedMs?: number; // you
  agent?: string | null; // report
  name?: string; verb?: string; obj?: string; state?: string; toolUseId?: string; patch?: Patch; // tool
  patches?: Patch[]; moreFiles?: number; // tool: the files a Bash command changed (bashEditDiff), and how many more it didn't list
  input?: string; out?: Output; // tool: its input as the expanded step shows it, and its result's preview (R5.6)
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
  start: string | null; end: string | null; total: number;
};
export type Changes = { items: string[]; background: string[]; agents: string[]; meta: boolean };

const MAX_TEXT = 6000;
const MAX_DIFF_LINES = 400;
const REPORT_PREFIX = 'Another Claude session sent a message';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): JsonRecord => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonRecord) : {});

export function clip(s: string, n = MAX_TEXT): string {
  return s.length <= n ? s : s.slice(0, n) + '\n\n[cut: message continues]';
}

// Paths as the page shows them (paths.ts): /tmp and home as you know them, home as `~`.
function tilde(p: string, home: string): string {
  return displayIn(p, home);
}

export function toolLine(name: string, input: unknown, home: string): [string, string] {
  const inp = obj(input);
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
    return ['Asked you', qs.map((q) => str(obj(q).question)).join('; ')];
  }
  if (name === 'ExitPlanMode') return ['Plan', 'shown for approval'];
  if (name === 'ToolSearch') return ['Loaded tools', str(inp.query).split('select:').join('')];
  if (name === 'ScheduleWakeup') return ['Scheduled a check-in', str(inp.reason)];
  if (name === 'TaskOutput') return ['Checked a background task', ''];
  if (name === 'SendMessage') return ['Messaged a subagent', ''];
  if (name === 'Monitor') return ['Watched', str(inp.description)];
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    return [(parts[1] ?? '').split('_').join(' '), parts[parts.length - 1].split('_').join(' ')];
  }
  return [name, ''];
}

export function patchOf(tur: JsonRecord, home: string): Patch {
  let hunks = (Array.isArray(tur.structuredPatch) ? tur.structuredPatch : []).map(obj);
  if (!hunks.length && tur.type === 'create') {
    const lines = str(tur.content).split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop(); // the final newline is not a line
    hunks = [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => '+' + l) }];
  }
  return patchFrom(hunks, str(tur.filePath), tur.type === 'create', home);
}

// The files a Bash command edited (toolUseResult.bashEditDiff): one patch per `files` entry, built
// as an Edit's, then each `changedFiles` path with no entry as a bare patch (no counts, no diff).
// Relative paths resolve against the record's cwd.
export function bashPatchesOf(diff: JsonRecord, cwd: string, home: string): { patches: Patch[]; more: number } {
  const abs = (p: string) => (p && !path.isAbsolute(p) && cwd ? path.resolve(cwd, p) : p);
  const patches: Patch[] = [];
  for (const f of (Array.isArray(diff.files) ? diff.files : []).map(obj)) {
    const file = abs(str(f.filePath));
    if (file) patches.push(patchFrom((Array.isArray(f.hunks) ? f.hunks : []).map(obj), file, f.created === true, home));
  }
  for (const p of Array.isArray(diff.changedFiles) ? diff.changedFiles.map(str) : []) {
    const file = abs(p);
    if (file && !patches.some((x) => x.abs === file)) {
      patches.push({ file: tilde(file, home), abs: file, add: 0, del: 0, created: false, cut: false, hunks: [], bare: true });
    }
  }
  const more = typeof diff.moreFiles === 'number' && diff.moreFiles > 0 ? diff.moreFiles : 0;
  return { patches, more };
}

function patchFrom(hunks: JsonRecord[], abs: string, created: boolean, home: string): Patch {
  const linesOf = (h: JsonRecord): string[] => (Array.isArray(h.lines) ? h.lines.map(str) : []);
  let add = 0;
  let del = 0;
  for (const h of hunks) {
    for (const l of linesOf(h)) {
      if (l.startsWith('+')) add++;
      else if (l.startsWith('-')) del++;
    }
  }
  const out: Hunk[] = [];
  let budget = MAX_DIFF_LINES;
  for (const h of hunks) {
    const lines = linesOf(h).slice(0, Math.max(budget, 0));
    budget -= lines.length;
    out.push({ o: Number(h.oldStart ?? 0), n: Number(h.newStart ?? 0), lines });
    if (budget <= 0) break;
  }
  return { file: tilde(abs, home), abs, add, del, created, cut: budget <= 0, hunks: out };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => obj(b).type === 'text').map((b) => str(obj(b).text)).join('\n');
}

const isBlock = (b: unknown, type: string): boolean => obj(b).type === type;

export const PREVIEW_LINES = 20;
export const PREVIEW_BYTES = 4096;

// A tool_result block's text, as Claude got it (for Bash: stdout, then stderr). Images aren't text.
export function resultText(block: JsonRecord): string {
  return textOf(block.content);
}

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
export function inputOf(name: string, input: unknown): string {
  const inp = obj(input);
  if (name === 'Bash') return clip(str(inp.command), PREVIEW_BYTES);
  if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit' || name === 'AskUserQuestion' || name === 'ExitPlanMode') return '';
  const out: string[] = [];
  for (const [k, v] of Object.entries(inp)) {
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue;
    const s = String(v);
    out.push(`${k}: ${s.length > 300 ? s.slice(0, 300) + '…' : s}`);
    if (out.length === 8) break;
  }
  return out.join('\n');
}

// Reads one record line again (`span`, from the tailer) and gives the full text of the tool_result for
// `toolUseId` in it; null when the file is gone or no longer has that record there (rewritten, rotated).
export function readResult(file: string, span: Span, toolUseId: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(span.length);
    if (fs.readSync(fd, buf, 0, span.length, span.offset) !== span.length) return null;
    const d = JSON.parse(buf.toString('utf8'));
    const content = obj(obj(d).message).content;
    const b = Array.isArray(content) ? content.find((x) => isBlock(x, 'tool_result') && obj(x).tool_use_id === toolUseId) : undefined;
    return b ? resultText(obj(b)) : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

export class Transcript {
  readonly sidechain: boolean;
  readonly home: string;
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
  private turnOpen = false;
  private afterMarker = false;
  private lastToolUses: { id: string; ts: string | null }[] = []; // of the latest main assistant record
  private allPrs: unknown[] = [];
  private byId = new Map<string, Item>();
  private seq = 0;
  private lastYou: Item | null = null;
  private results = new Map<string, boolean>(); // tool_use id -> is_error
  private asks = new Set<string>();
  private answers = new Map<string, string>();
  private patches = new Map<string, Patch>();
  private bashPatches = new Map<string, { patches: Patch[]; more: number }>();
  // A tool's result: only its preview stays in memory, and where its record sits for the rest.
  private outs = new Map<string, Output>();
  private outSpans = new Map<string, Span>();
  private span: Span | undefined; // of the record being pushed
  private bgTool = new Map<string, boolean>(); // tool_use id -> runs in the background (input flag or async launch)
  private notes = new Map<string, { status: string; summary: string; end: string | null }>();
  private taskIds = new Map<string, string>(); // tool_use id -> the task id stopTask takes
  private reportKind = new Map<string, 'message' | 'result'>(); // agent id -> where its report came from
  private bg = new Map<string, Background>();
  private agentMeta = new Map<string, { meta: JsonRecord | null; sub: Transcript | null }>();
  private changed = new Set<string>();
  private changedBg = new Set<string>();
  private changedAgents = new Set<string>();
  private metaChanged = false;
  private answerOf: (toolUseId: string) => string | undefined;
  // Slice 5: the session's process ended then (ISO): work started before it can't still run.
  private ended: string | null = null;
  private endedFailed = false; // that end was a process failure (else close, idle end or quit)
  private interrupted = new Set<string>(); // tool uses whose result the CLI wrote for an interrupt
  private lastErrors: string[] = []; // the error results of the record just read, if it held results

  // `answerOf`: the card answer Synopia stored for a tool use ("Allow once", "Denied: …"), shown as
  // your turn before the tool (slice 3). The JSONL holds no text for an allowed permission.
  // `planOf`: the plan text an answered plan card showed; the JSONL's ExitPlanMode input can be an
  // older revision (the CLI reads the plan file when it asks).
  constructor(opts: { sidechain?: boolean; home?: string; answerOf?: (toolUseId: string) => string | undefined; planOf?: (toolUseId: string) => string | undefined } = {}) {
    this.sidechain = opts.sidechain ?? false;
    this.home = opts.home ?? os.homedir();
    this.answerOf = opts.answerOf ?? (() => undefined);
    this.planOf = opts.planOf ?? (() => undefined);
  }
  private planOf: (toolUseId: string) => string | undefined;

  get title(): string | null {
    return this.customTitle || this.aiTitle;
  }

  get prs(): unknown[] {
    return this.allPrs.slice(-4);
  }

  get total(): number {
    return this.items.length;
  }

  get(id: string): Item | undefined {
    return this.byId.get(id);
  }

  // The last `last` items, for a first view.
  view(last = 160): { items: Item[]; total: number } {
    return { items: this.items.slice(-last), total: this.items.length };
  }

  // Back to empty, for a file that was rewritten. Subagent links are kept: they come from the folder.
  reset(): void {
    const keep = this.agentMeta, ended = this.ended, endedFailed = this.endedFailed;
    const fresh = new Transcript({ sidechain: this.sidechain, home: this.home, answerOf: this.answerOf, planOf: this.planOf });
    Object.assign(this, fresh);
    this.agentMeta = keep;
    this.ended = ended;
    this.endedFailed = endedFailed;
    this.metaChanged = true;
  }

  takeChanges(): Changes {
    // Subagents' shells and monitors: their own changes, and all of a changed subagent's (they end with it).
    const bg = new Set(this.changedBg);
    for (const [aid, a] of this.agentMeta) {
      if (!a.sub) continue;
      for (const id of a.sub.takeBackgroundChanges()) bg.add(id);
      if (this.changedAgents.has(aid)) for (const b of a.sub.background()) bg.add(b.toolUseId);
    }
    const out = {
      items: [...this.changed], background: [...bg], agents: [...this.changedAgents], meta: this.metaChanged,
    };
    this.changed.clear();
    this.changedBg.clear();
    this.changedAgents.clear();
    this.metaChanged = false;
    return out;
  }

  // spans: where each record's line sits in the file (Tailer), so a tool's full result can be read again.
  pushAll(records: JsonRecord[], spans?: Span[]): void {
    records.forEach((r, i) => this.push(r, spans?.[i]));
  }

  // Where the record holding a tool's result sits in this conversation's file.
  resultSpan(toolUseId: string): Span | undefined {
    return this.outSpans.get(toolUseId);
  }

  push(d: JsonRecord, span?: Span): void {
    this.span = span;
    this.seq++;
    const t = d.type;
    const ts = typeof d.timestamp === 'string' ? d.timestamp : null;
    if (ts) {
      this.firstTs ??= ts;
      this.lastTs = ts;
    }
    if (t === 'ai-title') {
      this.aiTitle = str(d.aiTitle) || null;
      this.metaChanged = true;
    } else if (t === 'custom-title') {
      this.customTitle = str(d.customTitle) || this.customTitle;
      this.metaChanged = true;
    } else if (t === 'pr-link') {
      if (d.prNumber != null && !this.allPrs.includes(d.prNumber)) {
        this.allPrs.push(d.prNumber);
        this.metaChanged = true;
      }
    } else if (t === 'permission-mode') {
      const mode = str(d.permissionMode);
      if (mode) {
        this.permissionMode = mode;
        if (mode !== 'plan') this.lastNonPlanMode = mode;
        this.metaChanged = true;
      }
    }
    if (t === 'system' && (d.subtype === 'turn_duration' || d.subtype === 'stop_hook_summary') && !(d.isSidechain && !this.sidechain)) {
      this.turnOpen = false;
      this.afterMarker = false;
    }
    if (t === 'system' && d.subtype === 'turn_duration') {
      if (this.lastYou && typeof d.durationMs === 'number') {
        this.lastYou.workedMs = d.durationMs;
        this.changed.add(this.lastYou.id);
      }
    }
    if (t === 'attachment' && !(d.isSidechain && !this.sidechain)) this.queuedCommand(d, ts);
    if ((d.isSidechain && !this.sidechain) || (t !== 'user' && t !== 'assistant')) return;
    const uuid = str(d.uuid) || `${t}@${this.seq}`;
    const content = obj(d.message).content;
    if (t === 'user') this.user(d, uuid, ts, content);
    else this.assistant(d, uuid, ts, content);
  }

  // A task notification or a subagent's hand-back queued during a turn lands as an `attachment`
  // record (`queued_command`, the text in `prompt`), not as a user record. So does a message you
  // sent during a turn (`commandMode: 'prompt'`; slice 3 saw no user record for it), so it shows too.
  private queuedCommand(d: JsonRecord, ts: string | null): void {
    const a = obj(d.attachment);
    const prompt = str(a.prompt);
    if (a.type !== 'queued_command' || !prompt) return;
    this.turnOpen = true; // written when a turn takes it in
    this.afterMarker = false;
    const typed = a.commandMode === 'prompt' && !prompt.startsWith('<');
    if (!typed && !prompt.startsWith('<task-notification>') && !prompt.startsWith('<agent-message')) return;
    this.user({ ...d, type: 'user' }, str(d.uuid) || `attachment@${this.seq}`, ts, prompt);
  }

  private user(d: JsonRecord, uuid: string, ts: string | null, content: unknown): void {
    const tur = d.toolUseResult;
    if (tur && typeof tur === 'object' && !Array.isArray(tur) && Array.isArray(content)) {
      const first = content.find((b) => isBlock(b, 'tool_result'));
      const tid = first && str(obj(first).tool_use_id);
      const r = tur as JsonRecord;
      if (tid) {
        // An Agent launched in the background returns at once: its launch result isn't the end.
        if (r.status === 'async_launched') this.bgTool.set(tid, true);
        const task = str(r.backgroundTaskId) || str(r.taskId) || (r.status === 'async_launched' ? str(r.agentId) : '');
        if (task) this.setTask(tid, task);
      }
    }
    if (tur && typeof tur === 'object' && !Array.isArray(tur) && str((tur as JsonRecord).filePath) && Array.isArray(content)) {
      const first = content.find((b) => isBlock(b, 'tool_result'));
      const tid = first && str(obj(first).tool_use_id);
      if (tid) {
        this.patches.set(tid, patchOf(tur as JsonRecord, this.home));
        this.refreshTool(tid);
      }
    }
    const bashDiff = tur && typeof tur === 'object' && !Array.isArray(tur) ? (tur as JsonRecord).bashEditDiff : undefined;
    if (bashDiff && typeof bashDiff === 'object' && !Array.isArray(bashDiff) && Array.isArray(content)) {
      const first = content.find((b) => isBlock(b, 'tool_result'));
      const tid = first && str(obj(first).tool_use_id);
      if (tid) {
        this.bashPatches.set(tid, bashPatchesOf(bashDiff as JsonRecord, str(d.cwd), this.home));
        this.refreshTool(tid);
      }
    }
    if (Array.isArray(content) && content.some((b) => isBlock(b, 'tool_result'))) {
      const errors: string[] = [];
      for (const b of content) {
        if (!isBlock(b, 'tool_result')) continue;
        const r = obj(b);
        const tid = str(r.tool_use_id);
        this.results.set(tid, Boolean(r.is_error));
        if (r.is_error) errors.push(tid);
        if (r.is_error && /^\[(Request interrupted by user|Tool call interrupted)/.test(textOf(r.content).trim())) this.interrupted.add(tid);
        if (this.asks.has(tid)) this.answers.set(tid, clip(textOf(r.content), 2000));
        else {
          const interrupted = this.interrupted.has(tid) || (r === obj(content.find((x) => isBlock(x, 'tool_result'))) && obj(tur).interrupted === true);
          this.outs.set(tid, { ...previewOf(resultText(r)), ...(interrupted ? { interrupted } : {}) });
          if (this.span) this.outSpans.set(tid, this.span);
        }
        this.refreshTool(tid);
      }
      this.lastErrors = errors;
      if (content.every((b) => isBlock(b, 'tool_result'))) return;
    }
    const txt = textOf(content);
    if (d.isMeta && !txt.startsWith(REPORT_PREFIX)) return;
    const images = Array.isArray(content) ? content.filter((b) => isBlock(b, 'image')).length : 0;
    for (const tn of txt.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
      const task = /<task-id>([^<]+)/.exec(tn[1]);
      // A subagent woken again after its first end notifies by task id only.
      const tid = /<tool-use-id>([^<]+)/.exec(tn[1])?.[1] ?? (task ? this.toolOfAgent(task[1]) : null);
      const st = /<status>([^<]+)/.exec(tn[1]);
      if (!tid) continue; // a monitor's event: it keeps running
      const su = /<summary>([^<]+)/.exec(tn[1]);
      if (task) this.setTask(tid, task[1]);
      this.notes.set(tid, { status: st ? st[1] : 'completed', summary: su ? su[1] : '', end: ts });
      // A subagent's last message comes back as <result>: its report, unless it sent one itself.
      const res = /<result>([\s\S]*?)<\/result>/.exec(tn[1]);
      const tool = this.byId.get(tid);
      if (res && task && tool && (tool.name === 'Agent' || tool.name === 'Task') && !this.reportKind.has(task[1])) {
        this.reportKind.set(task[1], 'result');
        this.put({ id: `report:${task[1]}`, k: 'report', ts, agent: task[1], text: clip(res[1].trim(), 3000) });
      }
      this.refreshTool(tid);
    }
    if (txt.startsWith('<task-notification>')) return;
    if (txt.startsWith(REPORT_PREFIX) || txt.startsWith('<agent-message')) {
      let body = txt.includes('The report follows:')
        ? txt.replace(/^[\s\S]*?The report follows:[ \t]*\r?\n?/, '')
        : txt.replace(/^<agent-message[^>]*>\s*/, '');
      body = body.replace(/<\/agent-message>[\s\S]*$/, '');
      body = body.split(/\r?\n/).map((l) => (l.startsWith('  ') ? l.slice(2) : l)).join('\n');
      const frm = /agent-message from="([0-9a-z]+)/.exec(txt);
      const agent = frm ? frm[1] : null;
      // A message from one of this session's own subagents is its report: one per subagent, in
      // place of the <result> one. Messages from other sessions stay one item each.
      const own = Boolean(agent && this.toolOfAgent(agent as string));
      if (own) this.reportKind.set(agent as string, 'message');
      this.put({ id: own ? `report:${agent}` : uuid, k: 'report', ts, agent, text: clip(body.trim(), 3000) });
      return;
    }
    if (txt.startsWith('<command-name>')) {
      const m = /<command-name>([^<]+)/.exec(txt);
      const args = /<command-args>([^<]*)/.exec(txt);
      this.lastYou = this.put({ id: uuid, k: 'you', ts, text: `${m ? m[1] : ''} ${args ? args[1] : ''}`.trim() });
      this.turnOpen = true;
      this.afterMarker = false;
      return;
    }
    if (txt.startsWith('<') && !images) return; // system reminders, local command output, hooks
    const item: Item = { id: uuid, k: 'you', ts, text: clip(txt), images };
    if (txt.startsWith('[Request interrupted by user')) {
      item.interrupted = true;
      // The CLI writes the tools the interrupt cut short as error results just before this marker.
      for (const tid of this.lastErrors) {
        this.interrupted.add(tid);
        this.refreshTool(tid);
      }
    }
    // Either marker ends the turn for now (a later assistant record means Claude carried on);
    // any other prompt you typed opens one.
    this.turnOpen = !item.interrupted;
    this.afterMarker = Boolean(item.interrupted);
    this.lastErrors = [];
    this.lastYou = this.put(item);
  }

  private assistant(d: JsonRecord, uuid: string, ts: string | null, content: unknown): void {
    this.lastErrors = [];
    if (d.requestedModel !== undefined) this.requestedModel = d.requestedModel;
    if (d.effort !== undefined) this.effort = d.effort;
    if (this.afterMarker) this.turnOpen = true;
    this.afterMarker = false;
    if (Array.isArray(content)) {
      this.lastToolUses = content.map((b, i) => ({ b: obj(b), i }))
        .filter(({ b }) => b.type === 'tool_use')
        .map(({ b, i }) => ({ id: str(b.id) || `${uuid}:${i}`, ts }));
    }
    if (!Array.isArray(content)) return;
    content.forEach((raw, i) => {
      const b = obj(raw);
      if (b.type === 'text' && str(b.text).trim()) {
        this.put({ id: `${uuid}:${i}`, k: 'claude', ts, text: clip(str(b.text)) });
        return;
      }
      if (b.type !== 'tool_use') return;
      const name = str(b.name);
      const inp = obj(b.input);
      const tid = str(b.id) || `${uuid}:${i}`;
      this.bgTool.set(tid, Boolean(inp.run_in_background));
      if (name === 'Monitor' || (name === 'Bash' && inp.run_in_background)) {
        this.bg.set(tid, {
          toolUseId: tid, taskId: this.taskIds.get(tid) ?? null, kind: name === 'Monitor' ? 'monitor' : 'shell', description: str(inp.description),
          command: str(inp.command).slice(0, 300), timeout: inp.timeout_ms, persistent: Boolean(inp.persistent),
          start: ts, status: 'running', summary: '', end: null,
        });
        this.stopIfEnded(tid);
        this.changedBg.add(tid);
      }
      if (name === 'AskUserQuestion') {
        const qs: Question[] = (Array.isArray(inp.questions) ? inp.questions : []).map((q0) => {
          const q = obj(q0);
          return {
            q: str(q.question), header: q.header, multi: Boolean(q.multiSelect),
            opts: (Array.isArray(q.options) ? q.options : []).map((o) => [str(obj(o).label), str(obj(o).description)]),
          };
        });
        this.asks.add(tid);
        this.put({ id: tid, k: 'ask', ts, qs, answer: null, state: 'pending' });
      } else {
        // The plan sits in the transcript as Claude's reply (R6.6); the card holds only the decision.
        const plan = name === 'ExitPlanMode' ? this.planOf(tid) ?? str(inp.plan) : '';
        if (plan.trim()) this.put({ id: `plan:${tid}`, k: 'claude', ts, text: clip(plan) });
        const [verb, o] = toolLine(name, inp, this.home);
        const item: Item = { id: tid, k: 'tool', ts, name, verb, obj: o.slice(0, 200), state: 'running' };
        if (name === 'Agent' || name === 'Task') item.toolUseId = tid;
        const input = inputOf(name, inp);
        if (input) item.input = input;
        this.put(item);
      }
      this.refreshTool(tid);
    });
  }

  // Slice 5: the session's process ended at `at` (close, idle end, quit, failure). Background shells,
  // monitors and subagents live inside it, so those started before then and still running read as
  // stopped. A notification that arrives later still wins. A foreground tool started before then
  // with no result reads as failed when the process failed (`failed`), else as stopped.
  processEnded(at: string, failed = false): void {
    if (this.ended && this.ended >= at) return;
    this.ended = at;
    this.endedFailed = failed;
    for (const tid of this.bg.keys()) this.stopIfEnded(tid);
    for (const it of this.items) if (it.k === 'tool' && it.state === 'running') this.refreshTool(it.id);
    for (const [aid, a] of this.agentMeta) {
      const tid = str(a.meta?.toolUseId);
      if (tid) this.refreshTool(tid);
      this.changedAgents.add(aid);
    }
  }

  // A task ended, as the SDK's task_notification says (`end` ISO): it reads as ended until the
  // JSONL's own notification lands, which wins.
  taskEnded(tid: string, status: string, summary: string, end: string): void {
    if (this.notes.has(tid)) return;
    this.notes.set(tid, { status, summary, end });
    this.refreshTool(tid);
  }

  private endedBefore(ts: string | null | undefined): boolean {
    return this.ended !== null && (!ts || ts <= this.ended);
  }

  private stopIfEnded(tid: string): void {
    const b = this.bg.get(tid);
    if (!b || b.status !== 'running' || this.notes.has(tid) || !this.endedBefore(b.start)) return;
    b.status = 'stopped';
    b.end = this.ended;
    this.changedBg.add(tid);
  }

  private put(item: Item): Item {
    const old = this.byId.get(item.id);
    if (old) {
      for (const key of Object.keys(old)) delete (old as Record<string, unknown>)[key];
      Object.assign(old, item);
      item = old;
    } else {
      this.items.push(item);
      this.byId.set(item.id, item);
    }
    this.changed.add(item.id);
    return item;
  }

  // Recomputes everything a tool id feeds: the item's state, patch or answer, the background
  // entry and the subagents linked to it. Order-independent, like the reference parser's final pass.
  private refreshTool(tid: string): void {
    const it = this.byId.get(tid);
    const res = this.results.get(tid);
    const note = this.notes.get(tid);
    if (it && it.k === 'ask') {
      const answer = this.answers.get(tid) ?? null;
      const state = res !== undefined ? 'answered' : 'pending';
      if (it.answer !== answer || it.state !== state) {
        it.answer = answer;
        it.state = state;
        this.changed.add(tid);
      }
    } else if (it && it.k === 'tool') {
      let state: string;
      const answer = res !== undefined ? this.answerOf(tid) : undefined;
      if ((it.name === 'Agent' || it.name === 'Task') && res === false) {
        state = note || !this.bgTool.get(tid) || this.endedBefore(it.ts) ? 'done' : 'running';
      } else if (res !== undefined) {
        // You denied it, or sent the plan back: your answer above says so, it didn't fail.
        state = !res ? 'done' : this.interrupted.has(tid) ? 'stopped' : answer && /^(Denied|Changes)\b/.test(answer) ? 'denied' : 'failed';
      }
      // A plan with no answer stays running: the page shows it as "Not answered".
      else if (it.name !== 'ExitPlanMode' && this.endedBefore(it.ts)) state = this.endedFailed ? 'failed' : 'stopped';
      else state = 'running';
      const patch = this.patches.get(tid);
      const bash = this.bashPatches.get(tid);
      const out = this.outs.get(tid);
      const plan = it.name === 'ExitPlanMode' ? this.planOf(tid) : undefined;
      const planItem = plan ? this.byId.get(`plan:${tid}`) : undefined;
      if (plan && planItem && planItem.text !== clip(plan)) {
        planItem.text = clip(plan);
        this.changed.add(planItem.id);
      }
      if (it.state !== state || it.patch !== patch || (bash && it.patches !== bash.patches) || (out && it.out !== out) || (answer && it.answer !== answer)) {
        it.state = state;
        if (out) it.out = out;
        if (patch) it.patch = patch;
        if (bash) {
          it.patches = bash.patches;
          if (bash.more) it.moreFiles = bash.more;
        }
        if (answer) it.answer = answer;
        this.changed.add(tid);
      }
    }
    const b = this.bg.get(tid);
    if (b && note && (b.status !== note.status || b.end !== note.end || b.summary !== note.summary)) {
      Object.assign(b, note);
      this.changedBg.add(tid);
    }
    for (const [aid, a] of this.agentMeta) {
      if (a.meta && a.meta.toolUseId === tid) this.changedAgents.add(aid);
      if (!b && a.sub?.getBackground(tid)) this.changedBg.add(tid); // a subagent's, notified in this file
    }
  }

  // The Agent tool_use id of one of this conversation's subagents (from its launch result or its meta).
  private toolOfAgent(agentId: string): string | null {
    if (!agentId) return null;
    const meta = this.agentMeta.get(agentId)?.meta;
    if (meta && str(meta.toolUseId)) return str(meta.toolUseId);
    for (const [tid, task] of this.taskIds) {
      const it = this.byId.get(tid);
      if (task === agentId && it && (it.name === 'Agent' || it.name === 'Task')) return tid;
    }
    return null;
  }

  private setTask(tid: string, task: string): void {
    if (this.taskIds.get(tid) === task) return;
    this.taskIds.set(tid, task);
    const b = this.bg.get(tid);
    if (b) {
      b.taskId = task;
      this.changedBg.add(tid);
    }
  }

  // The main thread's shells and monitors, then each subagent's, tagged with its id.
  background(): Background[] {
    const out = [...this.bg.values()];
    for (const aid of [...this.agentMeta.keys()].sort()) {
      const sub = this.agentMeta.get(aid)?.sub;
      if (sub) for (const b of sub.background()) out.push(this.subBackground(aid, sub, b));
    }
    return out;
  }

  getBackground(id: string): Background | undefined {
    const own = this.bg.get(id);
    if (own) return own;
    for (const [aid, a] of this.agentMeta) {
      const b = a.sub?.getBackground(id);
      if (b && a.sub) return this.subBackground(aid, a.sub, b);
    }
    return undefined;
  }

  // A shell or monitor a subagent started lives in that subagent's file. Its notification can
  // land there (already in `b`) or in this file. With none, it runs while its subagent runs; once
  // the subagent is over it reads as stopped, ended with its subagent.
  private subBackground(aid: string, sub: Transcript, b0: Background): Background {
    const b: Background = { ...b0, taskId: b0.taskId ?? this.taskIds.get(b0.toolUseId) ?? null, agentId: aid };
    if (b.status !== 'running') return b;
    const note = this.notes.get(b.toolUseId);
    if (note) return Object.assign(b, note);
    if (!this.agentRunning(aid)) Object.assign(b, { status: 'stopped', summary: 'Ended with its subagent', end: sub.lastTs ?? this.ended });
    return b;
  }

  // This (subagent's) conversation's background ids that changed since last asked.
  takeBackgroundChanges(): string[] {
    const out = [...this.changedBg];
    this.changedBg.clear();
    return out;
  }

  // Links a subagent to this (main) conversation. `meta` is its .meta.json (null until it
  // arrives), `sub` its own Transcript. Call again when either changes.
  setAgent(id: string, meta: JsonRecord | null | undefined, sub?: Transcript | null): void {
    const a = this.agentMeta.get(id) ?? { meta: null, sub: null };
    if (meta !== undefined) a.meta = meta;
    if (sub !== undefined) a.sub = sub;
    this.agentMeta.set(id, a);
    this.changedAgents.add(id);
  }

  // The main thread's turn runs (by the transcript alone): the latest assistant record has a
  // tool_use with no result yet (and the process didn't end after it), or a turn is open and the
  // transcript changed within `quietMs`, so a crashed process doesn't read as working for ever.
  turnRunning(now: number, quietMs: number): boolean {
    if (this.lastToolUses.some((u) => !this.results.has(u.id) && !this.endedBefore(u.ts))) return true;
    if (!this.turnOpen || this.endedBefore(this.lastTs)) return false;
    const last = this.lastTs ? Date.parse(this.lastTs) : NaN;
    return Number.isFinite(last) && now - last < quietMs;
  }

  // Running when `finished` isn't true, its Agent tool has no (final) result and no task
  // notification arrived. A background Agent's launch result isn't final: it ends with the notification.
  agentRunning(id: string): boolean {
    const a = this.agentMeta.get(id);
    if (!a) return false;
    const meta = a.meta ?? {};
    if (meta.finished === true) return false;
    const tid = str(meta.toolUseId);
    if (this.notes.has(tid)) return false;
    if (this.endedAgent(id)) return false;
    if (!tid) return true;
    const res = this.results.get(tid);
    if (res === undefined) return true;
    return !res && Boolean(this.bgTool.get(tid));
  }

  // A subagent that had not finished when the session's process ended (it started before then).
  private endedAgent(id: string): boolean {
    const a = this.agentMeta.get(id);
    if (!a || this.ended === null || a.meta?.finished === true) return false;
    const tid = str(a.meta?.toolUseId);
    if (tid && this.notes.has(tid)) return false;
    if (tid && this.results.get(tid) !== undefined && !(this.results.get(tid) === false && this.bgTool.get(tid))) return false; // its result came: finished
    return this.endedBefore((tid && this.byId.get(tid)?.ts) || a.sub?.firstTs);
  }

  getAgent(id: string): Agent | undefined {
    const a = this.agentMeta.get(id);
    if (!a) return undefined;
    const meta = a.meta ?? {};
    const description = str(meta.description);
    const running = this.agentRunning(id);
    const status = this.notes.get(str(meta.toolUseId))?.status ?? '';
    return {
      id, type: str(meta.agentType) || 'subagent', fork: Boolean(meta.isFork), description,
      toolUseId: str(meta.toolUseId) || null, model: meta.model ?? null, depth: meta.spawnDepth ?? 1,
      finished: !running, running, review: /^for review:/i.test(description),
      stopped: meta.stoppedByUser === true || status === 'stopped' || status === 'killed' || (!status && meta.finished !== true && this.endedAgent(id)),
      start: a.sub?.firstTs ?? null, end: a.sub?.lastTs ?? null, total: a.sub?.total ?? 0,
    };
  }

  agents(): Agent[] {
    return [...this.agentMeta.keys()].sort().map((id) => this.getAgent(id) as Agent);
  }
}

// The first `projects/*/<id>.jsonl` under the claude dir, or null.
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

// `<session>.jsonl` -> `<session>/`, the folder that holds `subagents/`.
export function sessionDirOf(transcriptPath: string): string {
  return transcriptPath.replace(/\.jsonl$/, '');
}
