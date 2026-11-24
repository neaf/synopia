// The fake driver (plan section 3), used under --fake instead of driver.ts: every session in
// the claude dir's projects is open, and a script from a fixture file plays status changes,
// stream previews and pending requests over them, so the page can be checked without model calls.
// The script is `<claude-dir>/fake-script.json`; see the one in test/fixtures/claude/.
import fs from 'node:fs';
import path from 'node:path';
import type { Views, Status, PendingRequest } from './views.ts';
import type { StatusDetail } from './status.ts';
import type { Client } from './server.ts';
import type { Log } from './log.ts';
import { nullLog } from './log.ts';
import { alwaysText } from './answers.ts';
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';

export type FakeStep = {
  at: number; // ms after start
  sid: string;
  status?: Status;
  ago?: number; // the status (or the request) began this many ms before the step
  // The queued count and the retry of status.ts; `retry.in` is ms from the step until it goes.
  detail?: { queued?: number; retry?: { attempt: number; max: number; in: number } };
  pending?: Omit<PendingRequest, 'since'>;
  clear?: string; // a pending request id
  stream?: string | null;
  toast?: string;
  task?: { toolUseId: string; taskId: string }; // the SDK's task_started for a tool of the session
};
export type FakeMenu = { models: object[]; commands: object[] };
export type FakeScript = { home?: string; menu?: FakeMenu; steps: FakeStep[] };

export const SCRIPT_FILE = 'fake-script.json';

// Every `projects/*/<id>.jsonl`, sorted by id.
export function fixtureSessions(claudeDir: string): { id: string; path: string }[] {
  const projects = path.join(claudeDir, 'projects');
  const out: { id: string; path: string }[] = [];
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(projects).sort();
  } catch {
    return out;
  }
  for (const d of dirs) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(path.join(projects, d));
    } catch {
      continue;
    }
    for (const n of names) {
      const m = /^(.+)\.jsonl$/.exec(n);
      if (m && !out.some((s) => s.id === m[1])) out.push({ id: m[1], path: path.join(projects, d, n) });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function loadScript(claudeDir: string): FakeScript {
  const file = path.join(claudeDir, SCRIPT_FILE);
  if (!fs.existsSync(file)) return { steps: [] };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as FakeScript;
  return { home: raw.home, menu: raw.menu, steps: Array.isArray(raw.steps) ? raw.steps : [] };
}

export class FakeDriver {
  private views: Views;
  private script: FakeScript;
  private log: Log;
  private timers = new Set<NodeJS.Timeout>();

  constructor(views: Views, script: FakeScript, opts: { log?: Log } = {}) {
    this.views = views;
    this.script = script;
    this.log = opts.log ?? nullLog;
  }

  // Opens every fixture session, then plays the script on timers.
  start(claudeDir: string): this {
    for (const s of fixtureSessions(claudeDir)) this.views.open(s.id, { path: s.path });
    for (const step of this.script.steps) this.later(step.at, () => this.apply(step));
    this.log('fake.start', { sessions: this.views.ids().length, steps: this.script.steps.length });
    return this;
  }

  // Every step at once, in time order (tests and the prototype fixture builder).
  runAll(): void {
    for (const step of [...this.script.steps].sort((a, b) => a.at - b.at)) this.apply(step);
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  // The menu for `hello`, one entry per session folder.
  menu(): Record<string, FakeMenu> {
    const out: Record<string, FakeMenu> = {};
    if (!this.script.menu) return out;
    for (const id of this.views.ids()) out[this.views.meta(id)?.cwd ?? ''] = this.script.menu;
    return out;
  }

  apply(step: FakeStep): void {
    const at = Date.now() - (step.ago ?? 0);
    if (step.status) this.views.setStatus(step.sid, step.status, at, detailOf(step));
    if (step.pending) {
      // The "Always allow" text, as pending.ts builds it for a real request.
      const sug = Array.isArray(step.pending.suggestions) ? step.pending.suggestions as PermissionUpdate[] : [];
      const always = step.pending.always !== undefined ? step.pending.always : sug.length && !step.pending.suppressAlwaysAllowRule ? alwaysText(sug) : null;
      this.views.setPending(step.sid, { ...step.pending, since: at, always } as PendingRequest);
    }
    if (step.clear) this.views.clearPending(step.sid, step.clear);
    if (step.stream !== undefined) this.views.setStream(step.sid, step.stream);
    if (step.toast) this.views.toast(step.toast);
    if (step.task) this.views.taskStarted(step.sid, step.task.toolUseId, step.task.taskId);
  }

  // Page messages the fake answers: an answer settles its request and the session works for a
  // while. A message sent while a session works is queued (shown pending until a prompt record
  // with its text lands in the fixture file), and an interrupt sends the queued ones back to the box.
  onMessage(_client: Client, msg: { t: string; [k: string]: unknown }): boolean {
    if (msg.t === 'send' && typeof msg.sid === 'string' && typeof msg.uuid === 'string' && this.views.queues(msg.sid)) {
      this.views.sent(msg.sid, msg.uuid, typeof msg.text === 'string' ? msg.text : '', Array.isArray(msg.images) ? msg.images.length : 0);
      this.recount(msg.sid);
      return true;
    }
    if (msg.t === 'interrupt' && typeof msg.sid === 'string' && this.views.queues(msg.sid)) {
      const texts = this.waiting(msg.sid).map((q) => q.text).filter((t) => t.trim());
      this.views.setStatus(msg.sid, 'stopped');
      if (texts.length) this.views.restore(msg.sid, texts);
      return true;
    }
    if (msg.t !== 'answer' || typeof msg.sid !== 'string' || typeof msg.requestId !== 'string') return false;
    const sid = msg.sid;
    this.views.clearPending(sid, msg.requestId);
    this.views.setStatus(sid, 'busy');
    this.later(3000, () => this.views.setStatus(sid, 'idle'));
    return true;
  }

  // The session's queued messages that haven't landed.
  private waiting(sid: string) {
    return (this.views.meta(sid)?.outbox ?? []).filter((q) => !q.landed);
  }

  // The queued count of the status, as status.ts keeps it: looked at again each 250 ms until none is left.
  private recount(sid: string): void {
    const meta = this.views.meta(sid);
    if (!meta || !this.views.queues(sid)) return;
    const n = this.waiting(sid).length;
    if (n !== (meta.statusDetail.queued ?? 0)) this.views.setStatus(sid, meta.status, meta.statusAt, n ? { queued: n } : {});
    if (n) this.later(250, () => this.recount(sid));
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, Math.max(0, ms));
    this.timers.add(t);
  }
}

function detailOf(step: FakeStep): StatusDetail {
  const d = step.detail;
  if (!d) return {};
  const out: StatusDetail = {};
  if (typeof d.queued === 'number') out.queued = d.queued;
  if (d.retry) out.retry = { attempt: d.retry.attempt, max: d.retry.max, at: Date.now() + (d.retry.in ?? 0) };
  return out;
}
