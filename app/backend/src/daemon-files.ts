// Synopia's own on-disk daemon contract (docs/Daemon files.md): `daemon.json` (where the running
// daemon listens, and a `handover` while it hands over), `backend.lock` (one daemon per state
// folder), `daemon.log` rotation and the exit codes. The shell's DaemonFiles.swift is the only
// other reader.
import { chmodSync, closeSync, constants, copyFileSync, ftruncateSync, openSync, readFileSync, renameSync, statSync, truncateSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { alive, procStart } from './macos.ts';

export const DAEMON_FILE = 'daemon.json';
export const DAEMON_LOG = 'daemon.log';
export const LOCK_FILE = 'backend.lock';
export const LOG_LIMIT = 5 * 1024 * 1024;

// The daemon's exit codes; the shell reads 3 (docs/Daemon files.md#exit-codes).
export const EXIT = { ok: 0, crash: 1, badArgs: 2, locked: 3, listen: 4 } as const;

export type HandoverReason = 'update' | 'restart';
// Set by a daemon that hands over, as it exits: the shell waits for `successor` instead of starting one.
export type Handover = { reason: HandoverReason; successor: number };
export type DaemonInfo = {
  pid: number; procStart: string; port: number; token: string; version: string; code: string; v: number;
  handover?: Handover;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPid = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

// A parsed daemon.json, or null when any field is missing or of the wrong shape. A malformed
// `handover` makes the whole file malformed.
export function parseDaemonInfo(text: string): DaemonInfo | null {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(o) || !isPid(o.pid)) return null;
  if (!Number.isInteger(o.port) || (o.port as number) <= 0 || (o.port as number) > 65535) return null;
  if (typeof o.token !== 'string' || !/^[0-9a-f]{64}$/.test(o.token)) return null;
  if (typeof o.procStart !== 'string' || typeof o.version !== 'string' || typeof o.code !== 'string' || !Number.isInteger(o.v)) return null;
  const info: DaemonInfo = { pid: o.pid, procStart: o.procStart, port: o.port as number, token: o.token, version: o.version, code: o.code, v: o.v as number };
  if (o.handover !== undefined) {
    const h = o.handover;
    if (!isObj(h) || (h.reason !== 'update' && h.reason !== 'restart') || !isPid(h.successor)) return null;
    info.handover = { reason: h.reason, successor: h.successor };
  }
  return info;
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
  chmodSync(tmp, 0o600); // the mode above is masked by the umask (docs/macOS.md#file-modes)
  renameSync(tmp, path);
}

// Removes daemon.json; with a pid, only while it is still that daemon's.
export function removeDaemonInfo(stateDir: string, pid?: number): void {
  if (pid !== undefined && readDaemonInfo(stateDir)?.pid !== pid) return;
  try {
    unlinkSync(join(stateDir, DAEMON_FILE));
  } catch {
    // Already gone.
  }
}

// At start, with the lock held: a daemon.json left there is stale, unless it is a handover to this
// daemon (the shell reads it until this one writes its own).
export function clearStaleDaemonInfo(stateDir: string, pid = process.pid): void {
  const i = readDaemonInfo(stateDir);
  if (i?.handover?.successor === pid) return;
  removeDaemonInfo(stateDir);
}

// The handing-over daemon's last word: its daemon.json gains `handover`, while it still names this
// daemon. false when it doesn't (nothing written).
export function markHandover(stateDir: string, pid: number, handover: Handover): boolean {
  const i = readDaemonInfo(stateDir);
  if (i?.pid !== pid) return false;
  writeDaemonInfo(stateDir, { ...i, handover });
  return true;
}

export type Probe = { alive: (pid: number) => boolean; startOf: (pid: number) => Promise<string | null> };
const realProbe: Probe = { alive, startOf: (pid) => procStart(pid) };

// Whether daemon.json still names a running daemon: its pid runs and started when the file says
// (`ps -o lstart=` as printed: the app compares the same string, docs/Daemon files.md#quirk-process-start-strings).
// A missing, malformed or stale file is false, and so is a start `ps` couldn't give.
// (The app also asks GET /api/ping with the token.)
export async function isLive(info: DaemonInfo | null, probe: Probe = realProbe): Promise<boolean> {
  if (!info || !probe.alive(info.pid)) return false;
  return info.procStart !== '' && (await probe.startOf(info.pid)) === info.procStart;
}

// This daemon's start time for daemon.json: `ps` asked up to three times, '' when it never answers
// (the app then reads the file as stale).
export async function ownStart(pid = process.pid, startOf: (pid: number) => Promise<string | null> = (p) => procStart(p)): Promise<string> {
  for (let i = 0; i < 3; i++) {
    const s = await startOf(pid);
    if (s !== null) return s;
  }
  return '';
}

// ---------- the lock ----------

// open(2)'s O_EXLOCK on macOS, which Node's fs.constants doesn't list (docs/macOS.md#file-locks).
const O_EXLOCK = 0x20;

export class LockedError extends Error {
  pid: number;
  constructor(path: string, pid: number) {
    super(Number.isNaN(pid) ? `Another Synopia backend holds ${path}` : `Another Synopia backend (pid ${pid}) holds ${path}`);
    this.pid = pid;
  }
}

export type Lock = { path: string; release: () => void };

// One daemon per state folder: `backend.lock` opened with an exclusive flock that the kernel drops
// when the process ends, however it ends. No stale lock to take over, so two starters can't both
// win. The file holds the owner's pid (for the refusal message) and is never removed: a removed
// lock file would let a second starter lock a new file beside the old one's holder.
export function acquireLock(stateDir: string): Lock {
  const path = join(stateDir, LOCK_FILE);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | O_EXLOCK, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EAGAIN') throw e;
    let pid = NaN;
    try {
      pid = Number.parseInt(readFileSync(path, 'utf8'), 10);
    } catch {
      // Unreadable: the message goes without the pid.
    }
    throw new LockedError(path, pid);
  }
  ftruncateSync(fd, 0);
  writeSync(fd, String(process.pid), 0);
  let held = true;
  return {
    path,
    release() {
      if (!held) return;
      held = false;
      try { ftruncateSync(fd, 0); } catch { /* the lock goes with the descriptor anyway */ }
      closeSync(fd);
    },
  };
}

// The pid in backend.lock, or null when the file is empty, missing or not a pid. Whether it holds
// the lock is the flock's business: a dead owner's pid may still be there.
export function lockOwner(stateDir: string): number | null {
  try {
    const n = Number.parseInt(readFileSync(join(stateDir, LOCK_FILE), 'utf8'), 10);
    return isPid(n) ? n : null;
  } catch {
    return null;
  }
}

// ---------- daemon.log ----------

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
