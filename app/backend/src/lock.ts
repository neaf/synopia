// An exclusive lock file in the state folder, so only one backend writes the
// state and drives the sessions. The file holds the owner's pid; a lock whose
// pid no longer runs is stale and taken over. The pid is written to a file of
// our own first and linked into place, so the lock never exists empty: a second
// backend can't read it between the create and the write and take it as stale.
import { writeFileSync, linkSync, readFileSync, unlinkSync } from 'node:fs';
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
  const mine = `${path}.${process.pid}`;
  writeFileSync(mine, String(process.pid), { mode: 0o600 });
  try {
    return take(path, mine);
  } finally {
    try {
      unlinkSync(mine);
    } catch {
      // Already gone.
    }
  }
}

function take(path: string, mine: string): Lock {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      linkSync(mine, path); // fails with EEXIST while another backend holds it
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
