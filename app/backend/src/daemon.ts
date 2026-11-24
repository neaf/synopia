// The daemon's discovery file and its lifetime (plan section 2). The app is only UI: it finds a
// running backend through `<state-dir>/daemon.json` ({pid, procStart, port, token, version}, mode
// 0600, written atomically when the server listens) and starts a new one when that file is
// missing or stale. The backend ends on "Stop All Work" or after 30 min with no page connected and
// nothing running; its stdout and stderr (`daemon.log`) are rotated at 5 MB.
import { chmodSync, copyFileSync, readFileSync, renameSync, statSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export const DAEMON_FILE = 'daemon.json';
export const DAEMON_LOG = 'daemon.log';
export const LOG_LIMIT = 5 * 1024 * 1024;
export const IDLE_EXIT_MS = 30 * 60 * 1000;

export type DaemonInfo = { pid: number; procStart: string; port: number; token: string; version: string };

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
  if (typeof o.procStart !== 'string' || typeof o.version !== 'string') return null;
  return { pid: o.pid as number, procStart: o.procStart, port: o.port as number, token: o.token, version: o.version };
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
