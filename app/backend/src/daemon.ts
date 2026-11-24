// The daemon's discovery file and its lifetime (plan section 2). The app is only UI: it finds a
// running backend through `<state-dir>/daemon.json` ({pid, procStart, port, token, version}, mode
// 0600, written atomically when the server listens) and starts a new one when that file is
// missing or stale. The backend ends on "Stop All Work" or after 30 min with no page connected and
// nothing running; its stdout and stderr (`daemon.log`) are rotated at 5 MB. It records a hash of
// its own code at start, and hands over to a new daemon once the checkout's code differs and
// nothing runs (or at once on "Restart Backend Now…").
import { chmodSync, closeSync, copyFileSync, openSync, readdirSync, readFileSync, renameSync, statSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const DAEMON_FILE = 'daemon.json';
export const DAEMON_LOG = 'daemon.log';
export const LOG_LIMIT = 5 * 1024 * 1024;
export const IDLE_EXIT_MS = 30 * 60 * 1000;

export type DaemonInfo = { pid: number; procStart: string; port: number; token: string; version: string; code: string };

// A parsed daemon.json, or null when any field is missing or of the wrong shape.
export function parseDaemonInfo(text: string): DaemonInfo | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const o = v as Partial<DaemonInfo> | null;
  if (!o || typeof o !== 'object') return null;
  if (!Number.isInteger(o.pid) || (o.pid as number) <= 0) return null;
  if (!Number.isInteger(o.port) || (o.port as number) <= 0 || (o.port as number) > 65535) return null;
  if (typeof o.token !== 'string' || !/^[0-9a-f]{64}$/.test(o.token)) return null;
  if (typeof o.procStart !== 'string' || typeof o.version !== 'string' || typeof o.code !== 'string') return null;
  return { pid: o.pid as number, procStart: o.procStart, port: o.port as number, token: o.token, version: o.version, code: o.code };
}

export function readDaemonInfo(stateDir: string): DaemonInfo | null {
  try {
    return parseDaemonInfo(readFileSync(join(stateDir, DAEMON_FILE), 'utf8'));
  } catch {
    return null;
  }
}

// Written to a file of our own (0600) and renamed into place, so a reader never sees half of it.
export function writeDaemonInfo(stateDir: string, info: DaemonInfo): void {
  const path = join(stateDir, DAEMON_FILE);
  const tmp = `${path}.${info.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(info) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600); // the mode above is masked by the umask; this isn't
  renameSync(tmp, path);
}

// Removes daemon.json; with a pid, only while it is still that daemon's. Without one, at start:
// the lock is ours, so a file left there is stale.
export function removeDaemonInfo(stateDir: string, pid?: number): void {
  if (pid !== undefined && readDaemonInfo(stateDir)?.pid !== pid) return;
  try {
    unlinkSync(join(stateDir, DAEMON_FILE));
  } catch {
    // Already gone.
  }
}

// A process's start time as `ps -o lstart=` prints it in the C locale and UTC
// ("Tue Nov 24 10:00:00 2026"), or '' when there is no such process. The app runs the same
// command, so the two compare as strings, and a reused pid never passes for the daemon.
export function procStart(pid: number): string {
  try {
    return execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      env: { LC_ALL: 'C', TZ: 'UTC' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    }).trim();
  } catch {
    return '';
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type Probe = { alive: (pid: number) => boolean; startOf: (pid: number) => string };
const realProbe: Probe = { alive, startOf: procStart };

// Whether daemon.json still names a running daemon: its pid runs and started when the file says.
// A missing, malformed or stale file is false. (The app also asks GET /api/ping with the token.)
export function isLive(info: DaemonInfo | null, probe: Probe = realProbe): boolean {
  if (!info || !probe.alive(info.pid)) return false;
  return info.procStart !== '' && probe.startOf(info.pid) === info.procStart;
}

// Copy and truncate, as logrotate's copytruncate: the daemon's stdout and stderr are the file
// itself (opened for append by the app), so it can't be renamed from under them.
export function rotateLog(file: string, limit = LOG_LIMIT): boolean {
  try {
    if (statSync(file).size <= limit) return false;
    copyFileSync(file, `${file}.1`);
    truncateSync(file, 0);
    return true;
  } catch {
    return false;
  }
}

// The idle-exit rule: the daemon ends once `timeoutMs` have passed since it last saw a page
// connected or something running (a turn, a subagent, a background shell or monitor, a pending card).
export type Activity = { pages: number; busy: boolean };
export class IdleExit {
  private since: number;
  private timeoutMs: number;
  constructor(timeoutMs: number, now: number) {
    this.timeoutMs = timeoutMs;
    this.since = now;
  }
  // true when the daemon should exit now.
  check(a: Activity, now: number): boolean {
    if (a.pages > 0 || a.busy) {
      this.since = now;
      return false;
    }
    return now - this.since >= this.timeoutMs;
  }
}

// The backend's code version: a SHA-256 over `src/**/*.ts` (each path and content, in path order)
// and `package-lock.json`, its first 16 hex digits. null while a file can't be read (a save or a
// checkout in progress). About a millisecond for the whole tree.
export function codeHash(backendDir: string): string | null {
  try {
    const files = (readdirSync(join(backendDir, 'src'), { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts')).map((f) => join('src', f)).sort();
    const h = createHash('sha256');
    for (const f of [...files, 'package-lock.json']) h.update(f).update('\0').update(readFileSync(join(backendDir, f))).update('\0');
    return h.digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

export const UPDATE_READ_MS = 10_000;

// The update rule. The daemon reads the checkout's code hash every 10 s: an update is pending once
// a hash other than the running one reads the same twice in a row (no restart halfway through a
// save or a checkout), and the daemon restarts once one is pending and nothing runs. A hash whose
// new daemon failed to start isn't tried again; a checkout back at the running code clears it.
export class UpdateCheck {
  readonly running: string;
  pending = false;
  private last: string;
  private failed: string | null = null;
  constructor(running: string) {
    this.running = running;
    this.last = running;
  }
  // One reading of the checkout's hash (null: unreadable, skipped); true when `pending` changed.
  read(hash: string | null): boolean {
    if (hash === null) return false;
    const was = this.pending;
    this.pending = hash !== this.running && hash === this.last && hash !== this.failed;
    this.last = hash;
    return this.pending !== was;
  }
  restartNow(busy: boolean): boolean {
    return this.pending && !busy;
  }
  // The new daemon didn't start: wait for the next change.
  fail(): void {
    this.failed = this.last;
    this.pending = false;
  }
}

// The new daemon's command line: this one's, with `--after <pid>` (it waits for this daemon to
// exit before it takes the lock) in place of any earlier one.
export function successorArgs(argv: string[], pid: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--after') { i++; continue; }
    if (argv[i].startsWith('--after=')) continue;
    out.push(argv[i]);
  }
  return [...out, '--after', String(pid)];
}

export type Successor = { loaded: Promise<boolean>; abort: () => void };

// Starts the new daemon (detached: its own session, stdout and stderr appended to daemon.log).
// `loaded` is true once it has loaded every module and waits for this one to exit; false when it
// exits or stays silent for 20 s first (say a syntax error in the new code: this daemon stays).
// `abort` ends a waiting one, when work started in the meantime.
export function startSuccessor(logFile: string, timeoutMs = 20_000): Successor {
  const fd = openSync(logFile, 'a', 0o600);
  const child = spawn(process.execPath, [...process.execArgv, ...successorArgs(process.argv.slice(1), process.pid)], {
    detached: true, stdio: ['ignore', fd, fd, 'ipc'],
  });
  closeSync(fd);
  const loaded = new Promise<boolean>((done) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); done(false); }, timeoutMs);
    const end = (ok: boolean) => { clearTimeout(timer); done(ok); };
    child.once('message', (m) => end((m as { t?: string } | null)?.t === 'loaded'));
    child.once('exit', () => end(false));
    child.once('error', () => end(false));
  }).then((ok) => {
    if (child.connected) child.disconnect();
    child.unref();
    return ok;
  });
  return { loaded, abort: () => { child.kill('SIGTERM'); } };
}

// In the new daemon, before it takes the lock: tells the old one it loaded, then waits (at most
// 20 s) for the old one's pid to go, so two daemons never run on one state folder.
export async function awaitHandover(oldPid: number, timeoutMs = 20_000): Promise<void> {
  process.send?.({ t: 'loaded' });
  if (process.connected) process.disconnect();
  const deadline = Date.now() + timeoutMs;
  while (alive(oldPid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
}
