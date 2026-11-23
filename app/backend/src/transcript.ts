// JSONL records to items for one conversation (the main one or a subagent's).
// A stateful port of export_transcripts.py lines 101-252 (plan section 7): records arrive in
// file order, and a later record (a tool result, a task notification) updates an earlier item
// in place. Every item has a stable id; takeChanges() lists what changed since the last call.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { JsonRecord } from './tail.ts';

export type Hunk = { o: number; n: number; lines: string[] };
export type Patch = {
  file: string; abs: string; add: number; del: number; created: boolean; cut: boolean; hunks: Hunk[];
};
export type Question = { q: string; header: unknown; multi: boolean; opts: [string, string][] };
export type Item = {
  id: string; k: 'you' | 'claude' | 'tool' | 'report' | 'ask'; ts: string | null;
  text?: string; images?: number; interrupted?: boolean; workedMs?: number; // you
  agent?: string | null; // report
  name?: string; verb?: string; obj?: string; state?: string; toolUseId?: string; patch?: Patch; // tool
  qs?: Question[]; answer?: string | null; // ask
};
export type Background = {
  toolUseId: string; taskId: string | null; kind: 'shell' | 'monitor'; description: string; command: string;
  timeout: unknown; persistent: boolean; start: string | null;
  status: string; summary: string; end: string | null;
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

function tilde(p: string, home: string): string {
  return home ? p.split(home).join('~') : p;
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
  const abs = str(tur.filePath);
  return { file: tilde(abs, home), abs, add, del, created: tur.type === 'create', cut: budget <= 0, hunks: out };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => obj(b).type === 'text').map((b) => str(obj(b).text)).join('\n');
}

const isBlock = (b: unknown, type: string): boolean => obj(b).type === type;

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
  private allPrs: unknown[] = [];
  private byId = new Map<string, Item>();
  private seq = 0;
  private lastYou: Item | null = null;
  private results = new Map<string, boolean>(); // tool_use id -> is_error
  private asks = new Set<string>();
  private answers = new Map<string, string>();
  private patches = new Map<string, Patch>();
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

  constructor(opts: { sidechain?: boolean; home?: string } = {}) {
    this.sidechain = opts.sidechain ?? false;
    this.home = opts.home ?? os.homedir();
  }

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
    const keep = this.agentMeta;
    const fresh = new Transcript({ sidechain: this.sidechain, home: this.home });
    Object.assign(this, fresh);
    this.agentMeta = keep;
    this.metaChanged = true;
  }

  takeChanges(): Changes {
    const out = {
      items: [...this.changed], background: [...this.changedBg], agents: [...this.changedAgents], meta: this.metaChanged,
    };
    this.changed.clear();
    this.changedBg.clear();
    this.changedAgents.clear();
    this.metaChanged = false;
    return out;
  }

  pushAll(records: JsonRecord[]): void {
    for (const r of records) this.push(r);
  }

  push(d: JsonRecord): void {
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
    } else if (t === 'system' && d.subtype === 'turn_duration') {
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
  // record (`queued_command`, the text in `prompt`), not as a user record. Typed prompts queued
  // the same way are left to the user records.
  private queuedCommand(d: JsonRecord, ts: string | null): void {
    const a = obj(d.attachment);
    const prompt = str(a.prompt);
    if (a.type !== 'queued_command' || !prompt) return;
    if (!prompt.startsWith('<task-notification>') && !prompt.startsWith('<agent-message')) return;
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
    if (Array.isArray(content)) {
      for (const b of content) {
        if (!isBlock(b, 'tool_result')) continue;
        const r = obj(b);
        const tid = str(r.tool_use_id);
        this.results.set(tid, Boolean(r.is_error));
        if (this.asks.has(tid)) this.answers.set(tid, clip(textOf(r.content), 2000));
        this.refreshTool(tid);
      }
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
      return;
    }
    if (txt.startsWith('<') && !images) return; // system reminders, local command output, hooks
    const item: Item = { id: uuid, k: 'you', ts, text: clip(txt), images };
    if (txt.startsWith('[Request interrupted by user')) item.interrupted = true;
    this.lastYou = this.put(item);
  }

  private assistant(d: JsonRecord, uuid: string, ts: string | null, content: unknown): void {
    if (d.requestedModel !== undefined) this.requestedModel = d.requestedModel;
    if (d.effort !== undefined) this.effort = d.effort;
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
        const [verb, o] = toolLine(name, inp, this.home);
        const item: Item = { id: tid, k: 'tool', ts, name, verb, obj: o.slice(0, 200), state: 'running' };
        if (name === 'Agent' || name === 'Task') item.toolUseId = tid;
        this.put(item);
      }
      this.refreshTool(tid);
    });
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
      if ((it.name === 'Agent' || it.name === 'Task') && res === false) {
        state = note || !this.bgTool.get(tid) ? 'done' : 'running';
      } else if (res !== undefined) state = res ? 'failed' : 'done';
      else state = 'running';
      const patch = this.patches.get(tid);
      if (it.state !== state || it.patch !== patch) {
        it.state = state;
        if (patch) it.patch = patch;
        this.changed.add(tid);
      }
    }
    const b = this.bg.get(tid);
    if (b && note && (b.status !== note.status || b.end !== note.end || b.summary !== note.summary)) {
      Object.assign(b, note);
      this.changedBg.add(tid);
    }
    for (const [aid, a] of this.agentMeta) if (a.meta && a.meta.toolUseId === tid) this.changedAgents.add(aid);
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

  background(): Background[] {
    return [...this.bg.values()];
  }

  getBackground(id: string): Background | undefined {
    return this.bg.get(id);
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

  // Running when `finished` isn't true, its Agent tool has no (final) result and no task
  // notification arrived. A background Agent's launch result isn't final: it ends with the notification.
  agentRunning(id: string): boolean {
    const a = this.agentMeta.get(id);
    if (!a) return false;
    const meta = a.meta ?? {};
    if (meta.finished === true) return false;
    const tid = str(meta.toolUseId);
    if (!tid) return true;
    if (this.notes.has(tid)) return false;
    const res = this.results.get(tid);
    if (res === undefined) return true;
    return !res && Boolean(this.bgTool.get(tid));
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
      stopped: meta.stoppedByUser === true || status === 'stopped' || status === 'killed',
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
