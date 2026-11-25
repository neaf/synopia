// Claude Code transcript records (docs/Claude Code transcripts.md) as typed, classified records.
// The format is undocumented: every record shape and text prefix Synopia relies on is read here,
// so transcript.ts reduces typed records and never a raw field. Pure: no I/O.
import path from 'node:path';
import type { JsonRecord } from './tail.ts';
import { parseBashOutput, splitBash } from './bang.ts';
import type { BashOutput, BashRun } from './bang.ts';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): JsonRecord => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonRecord) : {});
const isBlock = (b: unknown, type: string): boolean => obj(b).type === type;

// The text of a message's content: a string, or its text blocks joined by newlines.
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => isBlock(b, 'text')).map((b) => str(obj(b).text)).join('\n');
}

// An image block: where it sits in its content array, its declared type and its base64 bytes (null
// for any other source).
export type ImageBlock = { index: number; mediaType: string; data: string | null };

export function imageBlocks(content: unknown): ImageBlock[] {
  if (!Array.isArray(content)) return [];
  const out: ImageBlock[] = [];
  content.forEach((raw, index) => {
    const b = obj(raw);
    if (b.type !== 'image') return;
    const src = obj(b.source);
    out.push({ index, mediaType: str(src.media_type), data: src.type === 'base64' && typeof src.data === 'string' ? src.data : null });
  });
  return out;
}

// A hunk of `structuredPatch` (Edit, Write) or of `bashEditDiff` (a shell command's edits).
export type RawHunk = { oldStart: number; newStart: number; lines: string[] };
export type FileEdit = { filePath: string; created: boolean; hunks: RawHunk[] };
// `changedFiles`: files the command changed, absolute (resolved against the record's cwd).
export type BashEdit = { files: FileEdit[]; changedFiles: string[]; moreFiles: number };

const hunksOf = (v: unknown): RawHunk[] => (Array.isArray(v) ? v : []).map(obj).map((h) => ({
  oldStart: Number(h.oldStart ?? 0), newStart: Number(h.newStart ?? 0), lines: Array.isArray(h.lines) ? h.lines.map(str) : [],
}));

// An Edit's or Write's result (`toolUseResult` with `filePath`). A Write that creates a file has
// `type: "create"`, its `content` and an empty `structuredPatch`: the content becomes one hunk.
export function fileEditOf(tur: JsonRecord): FileEdit | null {
  const filePath = str(tur.filePath);
  if (!filePath) return null;
  let hunks = hunksOf(tur.structuredPatch);
  const created = tur.type === 'create';
  if (!hunks.length && created) {
    const lines = str(tur.content).split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop(); // the final newline is not a line
    hunks = [{ oldStart: 0, newStart: 1, lines: lines.map((l) => '+' + l) }];
  }
  return { filePath, created, hunks };
}

// `toolUseResult.bashEditDiff` (docs/Claude Code transcripts.md#shell-edits-basheditdiff). Relative
// paths resolve against `cwd`.
export function bashEditOf(diff: JsonRecord, cwd: string): BashEdit {
  const abs = (p: string) => (p && !path.isAbsolute(p) && cwd ? path.resolve(cwd, p) : p);
  const files: FileEdit[] = [];
  for (const f of (Array.isArray(diff.files) ? diff.files : []).map(obj)) {
    const filePath = abs(str(f.filePath));
    if (filePath) files.push({ filePath, created: f.created === true, hunks: hunksOf(f.hunks) });
  }
  const changedFiles = (Array.isArray(diff.changedFiles) ? diff.changedFiles.map(str) : []).map(abs).filter(Boolean);
  const moreFiles = typeof diff.moreFiles === 'number' && diff.moreFiles > 0 ? diff.moreFiles : 0;
  return { files, changedFiles, moreFiles };
}

export type Question = { q: string; header: unknown; multi: boolean; opts: [string, string][] };

// A tool_use block. `input` is the tool's own parameters, kept for the step's display lines; the
// fields the reducer acts on are read out here.
export type ToolUse = {
  type: 'tool_use'; index: number; id: string; name: string; input: JsonRecord;
  background: boolean; // `run_in_background`
  description: string; command: string; timeout: unknown; timeoutMs: unknown; persistent: boolean;
  plan: string; // ExitPlanMode's plan (can be an older revision than the card's)
  questions: Question[]; // AskUserQuestion's
  to: string | null; // SendMessage's recipient
};
export type AssistantBlock = { type: 'text'; index: number; text: string } | ToolUse | { type: 'other'; index: number; blockType: string };

function toolUseOf(b: JsonRecord, index: number): ToolUse {
  const inp = obj(b.input);
  const name = str(b.name);
  const questions: Question[] = name !== 'AskUserQuestion' ? [] : (Array.isArray(inp.questions) ? inp.questions : []).map((q0) => {
    const q = obj(q0);
    return {
      q: str(q.question), header: q.header, multi: Boolean(q.multiSelect),
      opts: (Array.isArray(q.options) ? q.options : []).map((o) => [str(obj(o).label), str(obj(o).description)] as [string, string]),
    };
  });
  return {
    type: 'tool_use', index, id: str(b.id), name, input: inp, background: Boolean(inp.run_in_background),
    description: str(inp.description), command: str(inp.command), timeout: inp.timeout, timeoutMs: inp.timeout_ms,
    persistent: Boolean(inp.persistent), plan: str(inp.plan), questions, to: typeof inp.to === 'string' ? inp.to : null,
  };
}

// The tool results an interrupt or a resume wrote: the CLI's text for a tool an Esc cut short, and
// for a question a quit left open (docs/Claude Code transcripts.md#interrupts).
const CUT_SHORT = /^\[(Request interrupted by user|Tool call interrupted)/;
const STOP_MARKER = '[Request interrupted by user';
const TURNED_DOWN_MARKER = '[Request interrupted by user for tool use';

// A tool call that never ran because a permission check said no (docs/Claude Code
// transcripts.md#denied-tool-calls): `auto`, auto mode's classifier blocked it; `you`, you turned it
// down at the terminal's permission prompt. The user record's `toolDenialKind` says which; an
// auto-mode block is also known by its result's fixed prefix. A hook or rule block (`permission-rule`)
// is neither: Claude reads its reason and carries on, so it stays a failed step.
export type Denial = 'auto' | 'you';
const DENIAL_KINDS = new Map<string, Denial>([['automode-blocked', 'auto'], ['user-rejected', 'you']]);
const AUTO_MODE_BLOCKED = 'Permission for this action was denied by the Claude Code auto mode classifier';

// A tool_result block. `text`: what Claude got (images aren't text). `cutShort`: an error result
// the CLI wrote for an interrupt. `denial`: an error result for a call a permission check denied.
// `outputFile`: where a background shell's output goes, as its result text names it ("Output is being
// written to: <path>"; docs/Claude Code transcripts.md#background-output), else ''.
export type ToolResult = { index: number; toolUseId: string; isError: boolean; text: string; cutShort: boolean; denial: Denial | null; images: ImageBlock[]; outputFile: string };
const OUTPUT_FILE = /Output is being written to: (\/\S+?\.output)(?=\s|$)/;

function toolResultOf(b: JsonRecord, index: number, denialKind: unknown): ToolResult {
  const text = textOf(b.content);
  const isError = Boolean(b.is_error);
  const denial = !isError ? null : DENIAL_KINDS.get(str(denialKind)) ?? (text.trimStart().startsWith(AUTO_MODE_BLOCKED) ? 'auto' : null);
  return { index, toolUseId: str(b.tool_use_id), isError, text, cutShort: isError && CUT_SHORT.test(text.trim()), denial, images: imageBlocks(b.content), outputFile: OUTPUT_FILE.exec(text)?.[1] ?? '' };
}

// A user record's `toolUseResult`, for its first tool_result. `taskId`: the id that stops it
// (a moved or background shell's `backgroundTaskId`, a monitor's `taskId`, an async Agent's `agentId`).
export type ToolUseResult = {
  toolUseId: string; asyncLaunched: boolean; backgroundTaskId: string; taskId: string; interrupted: boolean;
  edit: FileEdit | null; bashEdit: BashEdit | null;
};

// One `<task-notification>` (docs/Claude Code transcripts.md#background-work). A monitor's event has
// no tool-use id; a subagent woken again has its task id only. `event`: the monitor output lines it
// carries; `outputFile`: the task's output file, named at its end.
export type TaskNote = {
  taskId: string | null; toolUseId: string | null; status: string | null; summary: string | null; result: string | null;
  event: string | null; outputFile: string | null;
};

export function taskNotes(text: string): TaskNote[] {
  const out: TaskNote[] = [];
  for (const tn of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const tag = (name: string) => new RegExp(`<${name}>([^<]+)`).exec(tn[1])?.[1] ?? null;
    out.push({ taskId: tag('task-id'), toolUseId: tag('tool-use-id'), status: tag('status'), summary: tag('summary'), result: /<result>([\s\S]*?)<\/result>/.exec(tn[1])?.[1] ?? null,
      event: /<event>([\s\S]*?)<\/event>/.exec(tn[1])?.[1] ?? null, outputFile: tag('output-file') });
  }
  return out;
}

// What a user record's text is. `interrupt`: `stop` for "[Request interrupted by user]" (you stopped
// the turn), `toolUse` for "… for tool use]" (you turned a tool down; Claude carries on).
export type Interrupt = 'stop' | 'toolUse';
export type UserBody =
  | { kind: 'results' } // tool results only
  // `!` commands (splitBash): `then` is the body of the text after them (`rest`), as one record can hold the next prompt too
  | { kind: 'bash-input'; runs: BashRun[]; rest: string; then: UserBody | null }
  | { kind: 'bash-output'; out: BashOutput | null }
  | { kind: 'meta' } // an isMeta note: skipped
  | { kind: 'notification' } // task notifications only (in `notes`)
  | { kind: 'report'; agent: string | null; text: string }
  | { kind: 'command'; text: string } // a slash command you typed: `/name args`
  | { kind: 'system' } // reminders, local command output, hooks: skipped
  | { kind: 'interrupt'; interrupt: Interrupt }
  | { kind: 'moved'; to: string } // Synopia continued the session in another folder (movedContext)
  | { kind: 'prompt' };

type Base = { uuid: string; ts: string | null; sidechain: boolean };
export type UserRecord = Base & {
  kind: 'user'; cwd: string; text: string; images: ImageBlock[]; results: ToolResult[];
  toolUse: ToolUseResult | null; notes: TaskNote[]; body: UserBody;
};
export type AssistantRecord = Base & {
  kind: 'assistant'; messageId: string; requestedModel: unknown; effort: unknown; blocks: AssistantBlock[];
};
export type ClaudeRecord =
  | (Base & { kind: 'ai-title'; title: string })
  | (Base & { kind: 'custom-title'; title: string }) // empty: the rename was removed
  | (Base & { kind: 'pr-link'; pr: unknown })
  | (Base & { kind: 'permission-mode'; mode: string })
  | (Base & { kind: 'turn-end'; by: 'turn_duration' | 'stop_hook_summary'; durationMs: number | null })
  // A `queued_command` attachment: a message, notification or hand-back taken in by a running turn.
  // `user`: what shows of it (a typed prompt, a notification or a report), null for the rest.
  | (Base & { kind: 'queued'; user: UserRecord | null })
  | UserRecord
  | AssistantRecord
  | (Base & { kind: 'other' });

const REPORT_PREFIX = 'Another Claude session sent a message';

// A subagent's report: the text after "The report follows:", else the agent-message's body, two
// spaces of indent taken off each line.
function reportOf(text: string): { agent: string | null; text: string } {
  let body = text.includes('The report follows:')
    ? text.replace(/^[\s\S]*?The report follows:[ \t]*\r?\n?/, '')
    : text.replace(/^<agent-message[^>]*>\s*/, '');
  body = body.replace(/<\/agent-message>[\s\S]*$/, '');
  body = body.split(/\r?\n/).map((l) => (l.startsWith('  ') ? l.slice(2) : l)).join('\n');
  const frm = /agent-message from="([0-9a-z]+)/.exec(text);
  return { agent: frm ? frm[1] : null, text: body };
}

// Synopia's own context line when it continues a session whose folder is gone in another folder (R3.11):
// a `shouldQuery: false` user message, so Claude reads it with your next message and no turn starts. The
// transcript shows it as "Continued in <to>". `to` is the folder as the page shows it, `abs` the real path.
export const MOVED_TAG = '<synopia-moved';
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const unescapeAttr = (s: string) => s.replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
export function movedContext(to: string, abs: string, from: string): string {
  return `${MOVED_TAG} to="${escAttr(to)}">This session continues in ${abs}. Its folder ${from} no longer exists, so work in ${abs} from here.</synopia-moved>`;
}

function bodyOf(d: JsonRecord, text: string, images: number, onlyResults: boolean): UserBody {
  if (onlyResults) return { kind: 'results' };
  if (text.startsWith('<bash-input>')) {
    const b = splitBash(text);
    if (!b) return { kind: 'bash-input', runs: [], rest: '', then: null };
    return { kind: 'bash-input', ...b, then: b.rest ? bodyOf(d, b.rest, images, false) : null };
  }
  if (text.startsWith('<bash-stdout>')) return { kind: 'bash-output', out: parseBashOutput(text) };
  if (d.isMeta && !text.startsWith(REPORT_PREFIX)) return { kind: 'meta' };
  if (text.startsWith('<task-notification>')) return { kind: 'notification' };
  if (text.startsWith(REPORT_PREFIX) || text.startsWith('<agent-message')) return { kind: 'report', ...reportOf(text) };
  if (text.startsWith('<command-name>')) {
    const m = /<command-name>([^<]+)/.exec(text);
    const args = /<command-args>([^<]*)/.exec(text);
    return { kind: 'command', text: `${m ? m[1] : ''} ${args ? args[1] : ''}`.trim() };
  }
  if (text.startsWith(MOVED_TAG)) return { kind: 'moved', to: unescapeAttr(/^<synopia-moved to="([^"]*)"/.exec(text)?.[1] ?? '') };
  if (text.startsWith('<') && !images) return { kind: 'system' };
  if (text.startsWith(TURNED_DOWN_MARKER)) return { kind: 'interrupt', interrupt: 'toolUse' };
  if (text.startsWith(STOP_MARKER)) return { kind: 'interrupt', interrupt: 'stop' };
  return { kind: 'prompt' };
}

function userOf(d: JsonRecord, base: Base, content: unknown): UserRecord {
  const blocks = Array.isArray(content) ? content : [];
  const results = blocks.map((b, i) => (isBlock(b, 'tool_result') ? toolResultOf(obj(b), i, d.toolDenialKind) : null)).filter((r): r is ToolResult => r !== null);
  const tur = d.toolUseResult && typeof d.toolUseResult === 'object' && !Array.isArray(d.toolUseResult) ? (d.toolUseResult as JsonRecord) : null;
  let toolUse: ToolUseResult | null = null;
  if (tur && results.length) {
    const async = tur.status === 'async_launched';
    const diff = tur.bashEditDiff;
    toolUse = {
      toolUseId: results[0].toolUseId, asyncLaunched: async, backgroundTaskId: str(tur.backgroundTaskId),
      taskId: str(tur.backgroundTaskId) || str(tur.taskId) || (async ? str(tur.agentId) : ''),
      interrupted: tur.interrupted === true, edit: fileEditOf(tur),
      bashEdit: diff && typeof diff === 'object' && !Array.isArray(diff) ? bashEditOf(diff as JsonRecord, str(d.cwd)) : null,
    };
  }
  const onlyResults = results.length > 0 && blocks.every((b) => isBlock(b, 'tool_result'));
  const text = textOf(content);
  const images = imageBlocks(content);
  const body = bodyOf(d, text, images.length, onlyResults);
  const notes = body.kind === 'results' || body.kind === 'bash-input' || body.kind === 'bash-output' || body.kind === 'meta' ? [] : taskNotes(text);
  return { ...base, kind: 'user', cwd: str(d.cwd), text, images, results, toolUse, notes, body };
}

// One raw record (a parsed JSONL line) as a typed one. Record types Synopia doesn't read are `other`.
export function classify(d: JsonRecord): ClaudeRecord {
  const base: Base = { uuid: str(d.uuid), ts: typeof d.timestamp === 'string' ? d.timestamp : null, sidechain: d.isSidechain === true };
  const t = d.type;
  if (t === 'ai-title') return { ...base, kind: 'ai-title', title: str(d.aiTitle) };
  if (t === 'custom-title') return { ...base, kind: 'custom-title', title: str(d.customTitle) };
  if (t === 'pr-link') return { ...base, kind: 'pr-link', pr: d.prNumber ?? null };
  if (t === 'permission-mode') return { ...base, kind: 'permission-mode', mode: str(d.permissionMode) };
  if (t === 'system' && (d.subtype === 'turn_duration' || d.subtype === 'stop_hook_summary')) {
    return { ...base, kind: 'turn-end', by: d.subtype, durationMs: typeof d.durationMs === 'number' ? d.durationMs : null };
  }
  if (t === 'attachment') {
    // A message sent during a turn lands here, not as a user record (docs/Claude Code
    // transcripts.md#messages-sent-during-a-turn); `prompt` is a string or text and image blocks.
    const a = obj(d.attachment);
    const blocks = Array.isArray(a.prompt) ? a.prompt : null;
    const prompt = blocks ? textOf(blocks) : str(a.prompt);
    const images = blocks ? blocks.some((b) => isBlock(b, 'image')) : false;
    if (a.type !== 'queued_command' || (!prompt && !images)) return { ...base, kind: 'other' };
    const typed = a.commandMode === 'prompt' && (!prompt.startsWith('<') || images);
    // a `!` command taken in by a running turn comes as two of these: its input, then its output (bang.ts)
    const shown = typed || (a.commandMode === 'prompt' && (prompt.startsWith('<bash-input>') || prompt.startsWith('<bash-stdout>'))) || prompt.startsWith('<task-notification>') || prompt.startsWith('<agent-message');
    return { ...base, kind: 'queued', user: shown ? userOf(d, base, blocks ?? prompt) : null };
  }
  if (t === 'user') return userOf(d, base, obj(d.message).content);
  if (t === 'assistant') {
    const m = obj(d.message);
    const content = Array.isArray(m.content) ? m.content : [];
    const blocks: AssistantBlock[] = content.map((raw, index) => {
      const b = obj(raw);
      if (b.type === 'text') return { type: 'text', index, text: str(b.text) };
      if (b.type === 'tool_use') return toolUseOf(b, index);
      return { type: 'other', index, blockType: str(b.type) };
    });
    // One content block per record; the records of one response share `message.id`
    // (docs/Claude Code transcripts.md#assistant-records-one-block-per-record).
    return { ...base, kind: 'assistant', messageId: str(m.id), requestedModel: d.requestedModel, effort: d.effort, blocks };
  }
  return { ...base, kind: 'other' };
}

// A subagent's `.meta.json` (docs/Claude Code transcripts.md#files). It can lag or lack `finished`.
export type AgentMeta = {
  agentType: string; isFork: boolean; description: string; toolUseId: string; model: unknown; spawnDepth: unknown;
  finished: boolean; stoppedByUser: boolean;
};

export function agentMetaOf(raw: JsonRecord): AgentMeta {
  return {
    agentType: str(raw.agentType), isFork: Boolean(raw.isFork), description: str(raw.description), toolUseId: str(raw.toolUseId),
    model: raw.model ?? null, spawnDepth: raw.spawnDepth, finished: raw.finished === true, stoppedByUser: raw.stoppedByUser === true,
  };
}

// Lookups in one record read again from its line (`/api/image`, `toolOutput`).

// The full text of the tool_result for `toolUseId` in a user record; null when there is none.
export function resultTextIn(d: unknown, toolUseId: string): string | null {
  const content = obj(obj(d).message).content;
  const b = Array.isArray(content) ? content.find((x) => isBlock(x, 'tool_result') && obj(x).tool_use_id === toolUseId) : undefined;
  return b ? textOf(obj(b).content) : null;
}

// The base64 image at `at` (`[3]`, or `[1, 0]` inside a tool_result) of the record `recordId`; null
// when the record there is another one or holds no base64 image at that place. A record with no uuid
// has an id with `@` in it (`user@3`).
export function imageIn(raw: unknown, recordId: string, at: number[]): { mediaType: string; data: string } | null {
  const d = obj(raw);
  if (d.uuid ? d.uuid !== recordId : !recordId.includes('@')) return null;
  // a message queued during a turn keeps its blocks in the attachment's prompt
  let b: unknown = d.type === 'attachment' ? obj(d.attachment).prompt : obj(d.message).content;
  at.forEach((i, k) => {
    const list = k === 0 ? b : obj(b).content;
    b = Array.isArray(list) ? list[i] : undefined;
  });
  const src = obj(obj(b).source);
  if (obj(b).type !== 'image' || src.type !== 'base64' || typeof src.data !== 'string') return null;
  return { mediaType: str(src.media_type), data: src.data };
}

// A main-thread assistant record's message id and block types (the stream preview clears by them),
// null for any other record. Cheaper than classify: it runs beside it on every record read.
export function landedBlocks(d: JsonRecord): { messageId: string; types: string[] } | null {
  if (d.type !== 'assistant' || d.isSidechain === true) return null;
  const m = obj(d.message);
  if (typeof m.id !== 'string') return null;
  return { messageId: m.id, types: Array.isArray(m.content) ? m.content.map((b) => String(obj(b).type ?? '')) : [] };
}

// The first record's cwd among `records`, '' when none has one.
export function cwdOfRecords(records: JsonRecord[]): string {
  for (const r of records) if (typeof r.cwd === 'string' && r.cwd) return r.cwd;
  return '';
}
