// Claude Code CLIs running in a terminal (FR-SES-08, FR-SES-10): which sessions they hold, from
// their pid files `~/.claude/sessions/<pid>.json`, and the take-over's mechanics (ending the CLI,
// the note to its terminal, waiting for the transcript to settle). The files are undocumented:
// this is the only module that reads them, and it fails safe. See docs/Claude Code terminals.md.
// Process facts come from macos.ts, all async.
import fs from 'node:fs';
import path from 'node:path';
import type { Log, LogFields } from './log.ts';
import { nullLog } from './log.ts';
import { findTranscript } from './transcripts.ts';
import * as macos from './macos.ts';

export type Terminal = { pid: number; sessionId: string; procStart: string; cwd: string; status: string; statusUpdatedAt: number };
export const POLL_MS = 2000;
export const EXIT_MS = 10_000; // how long the take-over waits for the CLI to exit
export const SIGINT_MS = 5000; // when it asks again, with SIGINT
export const STABLE_MS = 500; // the transcript unchanged this long before the resume
const STABLE_CAP_MS = 5000;
const NAME = /^\d+\.json$/; // never a `*.key` file (docs/Claude Code terminals.md#pid-files)
const ANCESTRY = 8; // parents walked up to find Synopia's own pid
const CACHE_CAP = 500;

// What the terminals ask the system: tests replace it. null: the probe failed, ask again later.
export type Probe = {
  alive(pid: number): boolean;
  startOf(pid: number): Promise<string | null>; // '' no such process
  parentOf(pid: number): Promise<number | null>; // 0 no such process
};

export const realProbe: Probe = { alive: macos.alive, startOf: (pid) => macos.procStart(pid), parentOf: (pid) => macos.parentOf(pid) };

export type CliTerminalsOptions = {
  dir: string; // ~/.claude/sessions
  log?: Log;
  probe?: Probe;
  self?: number; // Synopia's pid (default process.pid)
  pollMs?: number; // 0: no timer (tests call scan)
  watch?: boolean;
  end?: EndDeps; // the take-over's system calls (tests replace them)
};

const sigOf = (held: Map<string, Terminal>, ...sets: Set<string>[]) => [[...held.values()].map((t) => `${t.sessionId}:${t.pid}:${t.status}`), ...sets.map((x) => [...x])].map((l) => l.sort().join(',')).join('|');
const newer = (t: Terminal, than: Terminal | null | undefined) => !than || t.statusUpdatedAt > than.statusUpdatedAt;

export class CliTerminals {
  private dir: string;
  private log: Log;
  private probe: Probe;
  private self: number;
  private opts: CliTerminalsOptions;
  private held = new Map<string, Terminal>(); // by session id
  private verified = new Map<string, boolean>(); // `${pid}|${procStart}` → counts; failures are never stored
  private listeners: (() => void)[] = [];
  private timer: NodeJS.Timeout | null = null;
  private watcher: fs.FSWatcher | null = null;
  private logged = new Set<string>();
  private sig = '';
  private scanned = false; // a scan of the folder finished
  private unsure = new Set<string>(); // sessions with a live pid file the last scan couldn't verify (ps failed)
  private open = new Set<string>(); // sessions a live pid file not Synopia's names, of any kind
  private scanning: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(opts: CliTerminalsOptions) {
    this.opts = opts;
    this.dir = opts.dir;
    this.log = opts.log ?? nullLog;
    this.probe = opts.probe ?? realProbe;
    this.self = opts.self ?? process.pid;
  }

  start(): void {
    this.stopped = false;
    void this.scan();
    const ms = this.opts.pollMs ?? POLL_MS;
    if (ms > 0) {
      this.timer = setInterval(() => { this.watchDir(); void this.scan(); }, ms);
      this.timer.unref?.();
    }
    this.watchDir();
  }

  stop(): void {
    this.stopped = true;
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

  // No Claude Code process outside Synopia has the session open, by the last scan: no live pid file
  // names it (a terminal's or any other CLI's, such as another app's SDK child), and none waits on a
  // ps that failed. False before the first scan: not known.
  free(sid: string): boolean {
    return this.scanned && !this.unsure.has(sid) && !this.open.has(sid);
  }

  // Right before acting (a start, a take-over): that session's files read again and each pid's
  // liveness now. A file whose process isn't verified yet counts (one writer: better refuse a start
  // than run beside a terminal) and starts a scan, which tells the listeners if it doesn't count.
  // The take-over checks the start time afresh before it signals (`end`).
  recheck(sid: string): Terminal | null {
    let best: Terminal | null = null;
    let unverified = false;
    for (const t of this.files((j) => j.sessionId === sid)) {
      const v = this.known(t);
      if (v === false) continue;
      if (v === undefined) unverified = true;
      if (newer(t, best)) best = t;
    }
    if (best) this.held.set(sid, best);
    else this.held.delete(sid);
    this.sig = sigOf(this.held, this.unsure, this.open); // the next scan reports any difference to this answer
    if (unverified) void this.scan();
    return best;
  }

  // The start check (session.ts `starting`): that session's files read again and every live pid
  // verified afresh (start time and ancestry now, not from the store), so a pid file left by a CLI
  // that died, whose pid another process reused, holds nothing. A probe that fails counts as holding
  // (one writer). Never rejects.
  async confirm(sid: string): Promise<Terminal | null> {
    let best: Terminal | null = null;
    try {
      for (const t of this.files((j) => j.sessionId === sid)) {
        const v = await this.verify(t, true);
        if (v === false) continue;
        if (v === null) this.once('terminals.unverified', { pid: t.pid });
        if (newer(t, best)) best = t;
      }
    } catch {
      this.once('terminals.scanFailed');
    }
    if (best) this.held.set(sid, best);
    else this.held.delete(sid);
    this.sig = sigOf(this.held, this.unsure, this.open);
    return best;
  }

  // Reads the folder; tells the listeners when the set of terminals or their status changed. One
  // scan at a time: a call during a scan runs one more after it.
  scan(): Promise<void> {
    if (this.scanning) {
      this.again = true;
      return this.scanning;
    }
    this.scanning = (async () => {
      do {
        this.again = false;
        try {
          await this.scanOnce();
        } catch {
          this.once('terminals.scanFailed');
        }
      } while (this.again && !this.stopped);
    })().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  private async scanOnce(): Promise<void> {
    const files = this.pidFiles(() => true);
    const counts = await Promise.all(files.map((f) => this.verify(f.t, false)));
    if (this.stopped) return;
    const next = new Map<string, Terminal>();
    files.forEach(({ t, cli }, i) => {
      if (cli && counts[i] === true && newer(t, next.get(t.sessionId))) next.set(t.sessionId, t);
    });
    this.held = next;
    this.open = new Set(files.filter((f, i) => counts[i] === true).map((f) => f.t.sessionId));
    this.unsure = new Set(files.filter((f, i) => counts[i] === null).map((f) => f.t.sessionId));
    const sig = sigOf(next, this.unsure, this.open);
    const first = !this.scanned;
    this.scanned = true;
    if (sig === this.sig && !first) return; // the first scan tells even with no terminal: now it is known
    this.sig = sig;
    for (const fn of this.listeners) fn();
  }

  // Ends a terminal's CLI for a take-over and waits for the session's transcript (beside this
  // folder, in projects/) to settle. False when it wouldn't exit, or when its start time couldn't
  // be read just before the signal. A pid that is no longer that CLI gets no signal: it is gone.
  async end(t: Terminal, note: string, sid: string): Promise<boolean> {
    const deps = this.opts.end ?? realEnd;
    const same = await this.verify(t, true);
    if (same === null) {
      this.once('terminals.unverified', { pid: t.pid });
      return false;
    }
    const ok = same ? await endTerminal(t, note, deps, (e) => this.once(e)) : true;
    const file = ok && same ? findTranscript(path.dirname(this.dir), sid) : null;
    if (file) await waitStable(file, deps);
    await this.scan();
    return ok;
  }

  // The pid files of terminals (format and kind checks passed), unverified.
  private files(want: (j: Record<string, unknown>) => boolean): Terminal[] {
    return this.pidFiles(want).filter((f) => f.cli).map((f) => f.t);
  }

  // Every pid file that passes the format check and isn't a spare, unverified. `cli`: a terminal's
  // (kind and entrypoint); the others are SDK children and other non-terminal CLIs.
  private pidFiles(want: (j: Record<string, unknown>) => boolean): { t: Terminal; cli: boolean }[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.once('terminals.unreadable');
      return [];
    }
    const out: { t: Terminal; cli: boolean }[] = [];
    for (const name of names) {
      if (!NAME.test(name)) continue;
      let j: Record<string, unknown>;
      try {
        const v = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
        if (!v || typeof v !== 'object') throw new Error('not an object');
        j = v as Record<string, unknown>;
      } catch {
        continue; // gone, or caught mid-write: the next scan reads it
      }
      if (typeof j.pid !== 'number' || typeof j.sessionId !== 'string' || typeof j.procStart !== 'string' || typeof j.kind !== 'string') {
        this.once('terminals.format');
        continue;
      }
      if (!want(j)) continue;
      if (j.spare === true || j.isSpare === true || `${j.pid}.json` !== name) continue;
      // SDK children write pid files too, entrypoint `sdk-ts` (docs/Claude Code terminals.md#quirk-sdk-children-write-pid-files-too)
      const cli = j.kind === 'interactive' && j.entrypoint === 'cli';
      out.push({ cli, t: {
        pid: j.pid,
        sessionId: j.sessionId,
        procStart: j.procStart,
        cwd: typeof j.cwd === 'string' ? j.cwd : '',
        status: typeof j.status === 'string' ? j.status : '',
        statusUpdatedAt: typeof j.statusUpdatedAt === 'number' ? j.statusUpdatedAt : 0,
      } });
    }
    return out;
  }

  private key(t: Terminal): string {
    return `${t.pid}|${t.procStart.replace(/\s+/g, ' ').trim()}`;
  }

  // Without asking ps: false when dead, else the stored verification (undefined: none yet).
  private known(t: Terminal): boolean | undefined {
    if (!this.probe.alive(t.pid)) {
      this.verified.delete(this.key(t));
      return false;
    }
    return this.verified.get(this.key(t));
  }

  // Alive, the same start time (the CLI writes it in UTC: docs/Claude Code terminals.md#quirk-procstart-is-utc)
  // and not one of Synopia's own. Stored per pid and start time while the pid lives, unless `fresh`.
  // null: a probe failed, so nothing is stored and the next scan asks again.
  private async verify(t: Terminal, fresh: boolean): Promise<boolean | null> {
    if (!this.probe.alive(t.pid)) {
      this.verified.delete(this.key(t));
      return false;
    }
    const k = this.verified.get(this.key(t));
    if (k !== undefined && !fresh) return k;
    if (!t.procStart.trim()) return this.store(t, false);
    const now = await this.probe.startOf(t.pid);
    if (now === null) return null;
    if (now === '') return false; // exited meanwhile
    if (!macos.sameStart(now, t.procStart)) {
      // A live pid whose start differs: a reused pid, or the CLI changed how it writes the time.
      this.once('terminals.startMismatch', { pid: t.pid });
      return this.store(t, false);
    }
    const ours = await macos.descendsFrom(t.pid, this.self, ANCESTRY, (p) => this.probe.parentOf(p));
    if (ours === null) return null;
    return this.store(t, !ours);
  }

  private store(t: Terminal, ok: boolean): boolean {
    if (this.verified.size > CACHE_CAP) this.verified.clear();
    this.verified.set(this.key(t), ok);
    return ok;
  }

  private watchDir(): void {
    if (this.watcher || this.opts.watch === false) return;
    try {
      // fs.watch can merge or drop events: the poll runs beside it (docs/macOS.md#fswatch-merges-and-drops-events)
      this.watcher = fs.watch(this.dir, () => { void this.scan(); });
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null; });
      this.watcher.unref?.();
    } catch {
      this.watcher = null; // no folder yet: the poll tries again
    }
  }

  private once(event: string, fields?: LogFields): void {
    if (this.logged.has(event)) return;
    this.logged.add(event);
    this.log(event, fields);
  }
}

// ---------- the take-over: ending a terminal's CLI ----------

export type EndDeps = {
  kill(pid: number, signal: 'SIGTERM' | 'SIGINT'): void;
  alive(pid: number): boolean;
  ttyOf(pid: number): Promise<string | null>; // `ttys004`, '??' none, '' or null unknown
  write(device: string, text: string): void; // throws when it can't
  stat(file: string): string; // size and mtime, '' when gone
  sleep(ms: number): Promise<void>;
  now(): number;
};

export const realEnd: EndDeps = {
  kill: (pid, sig) => macos.signal(pid, sig),
  alive: macos.alive,
  ttyOf: (pid) => macos.ttyOf(pid),
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
// docs/Claude Code terminals.md#quirk-tty-names
export function ttyDevice(tty: string): string {
  const t = tty.trim();
  return /^ttys?\d+$/.test(t) || /^pts\/\d+$/.test(t) ? `/dev/${t}` : '';
}

// SIGTERM, SIGINT after SIGINT_MS, and false if it still runs at EXIT_MS. Never SIGKILL. The note
// goes to its terminal once it exited, so the CLI's last redraw doesn't cover it.
export async function endTerminal(t: Terminal, note: string, d: EndDeps, logOnce: (event: string) => void = () => {}): Promise<boolean> {
  const device = ttyDevice((await d.ttyOf(t.pid)) ?? ''); // before it exits: then ps has nothing to say
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
    logOnce('terminals.noTty');
    return true;
  }
  try {
    d.write(device, note);
  } catch {
    logOnce('terminals.noteFailed');
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
