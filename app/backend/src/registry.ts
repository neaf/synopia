// The terminal registry (requirements R3.2, plan sections 6 and 13): which sessions a Claude Code
// in a terminal holds, from the CLI's pid files `~/.claude/sessions/<pid>.json`. They are
// undocumented: this is the only module that reads them, and it fails safe. A file it can't
// make sense of counts as no terminal (logged once), so Synopia then simply stops seeing terminals.
// - Only names matching `^\d+\.json$` are read; the `*.key` files beside them never are.
// - A file counts when its pid is alive, its `procStart` is the process's start time
//   (`LC_ALL=C TZ=UTC ps -o lstart=`: the CLI writes it in UTC), it is `kind: "interactive"` with
//   `entrypoint: "cli"`, not spare, and the process isn't one of Synopia's own (by pid ancestry;
//   the SDK's children write pid files too, with entrypoint `sdk-ts`).
// - Fields used: pid, sessionId, cwd, status (busy, idle or waiting), statusUpdatedAt.
// Plus the take-over's mechanics: ending a terminal's CLI (SIGTERM, then SIGINT, never SIGKILL),
// the note to its terminal, and waiting for the transcript to settle.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Log } from './log.ts';
import { nullLog } from './log.ts';

export type Terminal = { pid: number; sessionId: string; cwd: string; status: string; statusUpdatedAt: number };
export const POLL_MS = 2000;
export const EXIT_MS = 10_000; // how long the take-over waits for the CLI to exit
export const SIGINT_MS = 5000; // when it asks again, with SIGINT
export const STABLE_MS = 500; // the transcript unchanged this long before the resume
const STABLE_CAP_MS = 5000;
const NAME = /^\d+\.json$/;
const ANCESTRY = 8; // parents walked up to find Synopia's own pid

// What the registry asks the system: tests replace it.
export type Probe = {
  alive(pid: number): boolean;
  startOf(pid: number): string; // '' when unknown
  parentOf(pid: number): number; // 0 when unknown
};

function ps(field: string, pid: number): string {
  try {
    return execFileSync('/bin/ps', ['-o', `${field}=`, '-p', String(pid)], {
      env: { LC_ALL: 'C', TZ: 'UTC' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    }).trim();
  } catch {
    return '';
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export const realProbe: Probe = {
  alive,
  startOf: (pid) => ps('lstart', pid),
  parentOf: (pid) => Number(ps('ppid', pid)) || 0,
};

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

export type RegistryOptions = {
  dir: string; // ~/.claude/sessions
  log?: Log;
  probe?: Probe;
  self?: number; // Synopia's pid (default process.pid)
  pollMs?: number; // 0: no timer (tests call scan)
  watch?: boolean;
  end?: EndDeps; // the take-over's system calls (tests replace them)
};

export class Registry {
  private dir: string;
  private log: Log;
  private probe: Probe;
  private self: number;
  private opts: RegistryOptions;
  private held = new Map<string, Terminal>(); // by session id
  private verified = new Map<string, boolean>(); // `${pid}|${procStart}` → counts
  private listeners: (() => void)[] = [];
  private timer: NodeJS.Timeout | null = null;
  private watcher: fs.FSWatcher | null = null;
  private logged = new Set<string>();
  private sig = '';

  constructor(opts: RegistryOptions) {
    this.opts = opts;
    this.dir = opts.dir;
    this.log = opts.log ?? nullLog;
    this.probe = opts.probe ?? realProbe;
    this.self = opts.self ?? process.pid;
  }

  start(): void {
    this.scan();
    const ms = this.opts.pollMs ?? POLL_MS;
    if (ms > 0) {
      this.timer = setInterval(() => { this.watchDir(); this.scan(); }, ms);
      this.timer.unref?.();
    }
    this.watchDir();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  // The terminal that holds a session, as of the last scan.
  holder(sid: string): Terminal | null {
    return this.held.get(sid) ?? null;
  }

  // Right before acting (a start, a take-over): that session's files again, each verified anew.
  recheck(sid: string): Terminal | null {
    let best: Terminal | null = null;
    for (const t of this.read((j) => j.sessionId === sid, true)) if (!best || t.statusUpdatedAt > best.statusUpdatedAt) best = t;
    if (best) this.held.set(sid, best);
    else this.held.delete(sid);
    return best;
  }

  // Reads the folder; tells the listeners when the set of terminals or their status changed.
  scan(): void {
    const next = new Map<string, Terminal>();
    for (const t of this.read(() => true, false)) {
      const had = next.get(t.sessionId);
      if (!had || t.statusUpdatedAt > had.statusUpdatedAt) next.set(t.sessionId, t);
    }
    this.held = next;
    const sig = [...next.values()].map((t) => `${t.sessionId}:${t.pid}:${t.status}`).sort().join(',');
    if (sig === this.sig) return;
    this.sig = sig;
    for (const fn of this.listeners) fn();
  }

  // Ends a terminal's CLI for a take-over and waits for the session's transcript (beside this
  // folder, in projects/) to settle. False when it wouldn't exit.
  async end(t: Terminal, note: string, sid: string): Promise<boolean> {
    const deps = this.opts.end ?? realEnd;
    const ok = await endTerminal(t, note, deps, (e) => this.once(e));
    const file = ok ? transcriptOf(path.dirname(this.dir), sid) : null;
    if (file) await waitStable(file, deps);
    this.scan();
    return ok;
  }

  private read(want: (j: Record<string, unknown>) => boolean, fresh: boolean): Terminal[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.once('registry.unreadable');
      return [];
    }
    const out: Terminal[] = [];
    for (const name of names) {
      if (!NAME.test(name)) continue; // never a .key file
      let j: Record<string, unknown>;
      try {
        const v = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
        if (!v || typeof v !== 'object') throw new Error('not an object');
        j = v as Record<string, unknown>;
      } catch {
        continue; // gone, or caught mid-write: the next scan reads it
      }
      if (typeof j.pid !== 'number' || typeof j.sessionId !== 'string' || typeof j.procStart !== 'string' || typeof j.kind !== 'string') {
        this.once('registry.format');
        continue;
      }
      if (!want(j)) continue;
      if (j.kind !== 'interactive' || j.entrypoint !== 'cli' || j.spare === true || j.isSpare === true) continue;
      if (`${j.pid}.json` !== name) continue;
      const pid = j.pid;
      if (!this.counts(pid, j.procStart, fresh)) continue;
      out.push({
        pid,
        sessionId: j.sessionId,
        cwd: typeof j.cwd === 'string' ? j.cwd : '',
        status: typeof j.status === 'string' ? j.status : '',
        statusUpdatedAt: typeof j.statusUpdatedAt === 'number' ? j.statusUpdatedAt : 0,
      });
    }
    return out;
  }

  // Alive (every time), the same start time and not ours (once per pid and start time, unless fresh).
  private counts(pid: number, start: string, fresh: boolean): boolean {
    const key = `${pid}|${squash(start)}`;
    if (!this.probe.alive(pid)) {
      this.verified.delete(key);
      return false;
    }
    if (!fresh && this.verified.has(key)) return this.verified.get(key) as boolean;
    const ok = squash(start) !== '' && squash(this.probe.startOf(pid)) === squash(start) && !this.ours(pid);
    if (this.verified.size > 500) this.verified.clear();
    this.verified.set(key, ok);
    return ok;
  }

  private ours(pid: number): boolean {
    let p = pid;
    for (let i = 0; i < ANCESTRY && p > 1; i++) {
      if (p === this.self) return true;
      p = this.probe.parentOf(p);
    }
    return false;
  }

  private watchDir(): void {
    if (this.watcher || this.opts.watch === false) return;
    try {
      this.watcher = fs.watch(this.dir, () => this.scan());
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null; });
      this.watcher.unref?.();
    } catch {
      this.watcher = null; // no folder yet: the poll tries again
    }
  }

  private once(event: string): void {
    if (this.logged.has(event)) return;
    this.logged.add(event);
    this.log(event);
  }
}

// ---------- the take-over: ending a terminal's CLI ----------

export type EndDeps = {
  kill(pid: number, signal: 'SIGTERM' | 'SIGINT'): void;
  alive(pid: number): boolean;
  ttyOf(pid: number): string; // `ttys004`, '' when none
  write(device: string, text: string): void; // throws when it can't
  stat(file: string): string; // size and mtime, '' when gone
  sleep(ms: number): Promise<void>;
  now(): number;
};

export const realEnd: EndDeps = {
  kill: (pid, signal) => { process.kill(pid, signal); },
  alive,
  ttyOf: (pid) => ps('tty', pid),
  write: (device, text) => {
    const fd = fs.openSync(device, fs.constants.O_WRONLY | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK);
    try { fs.writeSync(fd, text); } finally { fs.closeSync(fd); }
  },
  stat: (file) => {
    try {
      const s = fs.statSync(file);
      return `${s.size}:${s.mtimeMs}`;
    } catch {
      return '';
    }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: Date.now,
};

// The note left in the terminal's tab (R3.2): when, and how to go back.
export function takeoverNote(sid: string, at: Date): string {
  const hh = String(at.getHours()).padStart(2, '0'), mm = String(at.getMinutes()).padStart(2, '0');
  return `Synopia took over this session at ${hh}:${mm}. To continue here instead: claude --resume ${sid}\n`;
}

// The CLI's controlling terminal as a device, or '' (none, or not one we'd write to).
export function ttyDevice(tty: string): string {
  const t = tty.trim();
  return /^ttys?\d+$/.test(t) || /^pts\/\d+$/.test(t) ? `/dev/${t}` : '';
}

// SIGTERM, SIGINT after SIGINT_MS, and false if it still runs at EXIT_MS. Never SIGKILL. The note
// goes to its terminal once it exited, so the CLI's last redraw doesn't cover it.
export async function endTerminal(t: Terminal, note: string, d: EndDeps, logOnce: (event: string) => void = () => {}): Promise<boolean> {
  const device = ttyDevice(d.ttyOf(t.pid)); // before it exits: then ps has nothing to say
  try {
    d.kill(t.pid, 'SIGTERM');
  } catch {
    if (d.alive(t.pid)) return false; // not ours to signal
  }
  const start = d.now();
  let asked = false;
  while (d.alive(t.pid)) {
    const waited = d.now() - start;
    if (waited >= EXIT_MS) return false;
    if (!asked && waited >= SIGINT_MS) {
      asked = true;
      try { d.kill(t.pid, 'SIGINT'); } catch { /* gone meanwhile */ }
    }
    await d.sleep(100);
  }
  if (!device) {
    logOnce('registry.noTty');
    return true;
  }
  try {
    d.write(device, note);
  } catch {
    logOnce('registry.noteFailed');
  }
  return true;
}

// Until the file hasn't changed for STABLE_MS (at most STABLE_CAP_MS): the CLI's last lines are in.
export async function waitStable(file: string, d: EndDeps): Promise<void> {
  const start = d.now();
  let last = d.stat(file), since = d.now();
  while (d.now() - start < STABLE_CAP_MS) {
    await d.sleep(100);
    const cur = d.stat(file);
    if (cur !== last) { last = cur; since = d.now(); continue; }
    if (d.now() - since >= STABLE_MS) return;
  }
}

// The session's transcript `<claude dir>/projects/<folder>/<sid>.jsonl`, by its name only.
export function transcriptOf(claudeDir: string, sid: string): string | null {
  const root = path.join(claudeDir, 'projects');
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const f = path.join(root, d, `${sid}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}
