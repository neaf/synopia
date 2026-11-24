// Process facts from macOS, all async: nothing here blocks the event loop (NFR-06). `ps` runs as
// `/bin/ps -o <field>= -p <pid>` under `LC_ALL=C TZ=UTC`; see docs/macOS.md#ps.
// Each probe tells a failure (timeout, spawn error: `null`) from "no such process" (`''` or 0), so a
// caller can try again instead of remembering a transient failure as a fact.
import { execFile } from 'node:child_process';

export const PS = '/bin/ps';
export const PS_TIMEOUT_MS = 2000;

export type PsOptions = { bin?: string; timeoutMs?: number };

// One `ps` field of one process: its text (trimmed), '' when no such process, null when `ps` failed.
export function ps(field: 'lstart' | 'tty' | 'ppid', pid: number, o: PsOptions = {}): Promise<string | null> {
  return new Promise((done) => {
    execFile(o.bin ?? PS, ['-o', `${field}=`, '-p', String(pid)], {
      env: { LC_ALL: 'C', TZ: 'UTC' }, encoding: 'utf8', timeout: o.timeoutMs ?? PS_TIMEOUT_MS,
    }, (err, stdout) => {
      const out = String(stdout ?? '').trim();
      if (!err) return done(out);
      // ps exits 1 with nothing on stdout when the pid doesn't exist; a kill (timeout) or a spawn error is a failure.
      const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string | null };
      done(e.code === 1 && !e.killed && !e.signal && out === '' ? '' : null);
    });
  });
}

// A process's start time as `ps -o lstart=` prints it in the C locale and UTC
// ("Tue Nov  4 10:00:00 2026": a single-digit day is padded). '' no such process, null unknown.
// Kept as printed: the shell compares daemon.json's copy as a string (docs/Daemon files.md).
export const procStart = (pid: number, o?: PsOptions) => ps('lstart', pid, o);

// Two start strings for one moment: runs of spaces don't matter (the CLI's pid file and `ps` pad differently).
export function sameStart(a: string, b: string): boolean {
  const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
  return squash(a) !== '' && squash(a) === squash(b);
}

// The controlling terminal (`ttys004`, `??` for none), '' no such process, null unknown.
export const ttyOf = (pid: number, o?: PsOptions) => ps('tty', pid, o);

// The parent pid, 0 no such process, null unknown.
export async function parentOf(pid: number, o?: PsOptions): Promise<number | null> {
  const out = await ps('ppid', pid, o);
  return out === null ? null : Number(out) || 0;
}

// Alive: signal 0 reaches it, or it exists under another user (EPERM).
export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// One process; throws when it can't be signalled (gone, or not ours).
export function signal(pid: number, sig: NodeJS.Signals): void {
  process.kill(pid, sig);
}

// A whole process group (a child started `detached` leads its own); quiet when it is gone.
export function signalGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch {
    /* already gone */
  }
}

// Whether `pid` is `ancestor` or below it, walking at most `depth` parents. null when a step failed.
export async function descendsFrom(
  pid: number, ancestor: number, depth: number, parent: (pid: number) => Promise<number | null> = parentOf,
): Promise<boolean | null> {
  let p = pid;
  for (let i = 0; i < depth && p > 1; i++) {
    if (p === ancestor) return true;
    const next = await parent(p);
    if (next === null) return null;
    p = next;
  }
  return false;
}
