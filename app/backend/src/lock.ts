// An exclusive lock file in the state folder, so only one backend writes the
// state and drives the sessions. The file holds the owner's pid; a lock whose
// pid no longer runs is stale and taken over.
import { openSync, writeSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export type Lock = { path: string; release: () => void };

export class LockedError extends Error {
  pid: number;
  constructor(path: string, pid: number) {
    super(`Another Synopia backend (pid ${pid}) holds ${path}`);
    this.pid = pid;
  }
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function acquireLock(stateDir: string): Lock {
  const path = join(stateDir, 'backend.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let pid = NaN;
      try {
        pid = Number.parseInt(readFileSync(path, 'utf8'), 10);
      } catch {
        // Vanished between the open and the read: try again.
      }
      if (alive(pid)) throw new LockedError(path, pid);
      try {
        unlinkSync(path);
      } catch {
        // Someone else removed it first.
      }
      continue;
    }
    writeSync(fd, String(process.pid));
    closeSync(fd);
    let held = true;
    return {
      path,
      release() {
        if (!held) return;
        held = false;
        try {
          if (readFileSync(path, 'utf8') === String(process.pid)) unlinkSync(path);
        } catch {
          // Already gone.
        }
      },
    };
  }
  throw new LockedError(path, NaN);
}
