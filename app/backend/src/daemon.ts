// The daemon's lifecycle (requirements R2.8): starting (the lock taken, a handover's old daemon gone
// first), ready (daemon.json written, the idle exit and the update check running) and stopping (the
// shutdown order, then exit). The backend ends on "Stop All Work", SIGTERM or SIGINT, or after 30 min
// with no page connected and nothing running. It records a hash of its own code at start and hands
// over to a new daemon once the checkout's code differs and nothing runs (at once on "Restart
// Backend Now…"). An uncaught error flushes state.json and ends it with exit 1; the shell restarts
// it once. Under app/dev.sh (`parent: false`) there is no idle exit, update or restart.
import { closeSync, openSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { alive } from './macos.ts';
import {
  DAEMON_LOG, EXIT, LockedError, acquireLock, clearStaleDaemonInfo, markHandover, ownStart, removeDaemonInfo, rotateLog, writeDaemonInfo,
} from './daemon-files.ts';
import type { HandoverReason, Lock } from './daemon-files.ts';
import type { Log } from './log.ts';

export const IDLE_EXIT_MS = 30 * 60 * 1000;
export const UPDATE_READ_MS = 10_000;
export const SUCCESSOR_MS = 20_000;

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

type HashIo = {
  readdir: (dir: string) => Promise<string[]>;
  stat: (file: string) => Promise<{ size: number; mtimeMs: number; ctimeMs: number; ino: number }>;
  readFile: (file: string) => Promise<Buffer>;
};
const realIo: HashIo = {
  readdir: async (dir) => (await readdir(dir, { recursive: true })) as string[],
  stat: (f) => stat(f),
  readFile: (f) => readFile(f),
};

// The page's protocol schema, which the backend imports too (main.ts, router.ts, publisher.ts): a
// change to it alone is new backend code. Relative to the backend folder; a missing one is a state.
export const PROTOCOL_FILE = '../web/js/protocol.js';
// The page modules the backend imports besides it: the matcher (sessions.ts, the Open list).
export const SHARED_FILES = [PROTOCOL_FILE, '../web/js/fuzzy.js'];

// The backend's code version: a SHA-256 over `src/**/*.ts`, `package-lock.json` and SHARED_FILES
// (each path and its content's digest), its first 16 hex digits. null while a file can't be read (a
// save or a checkout in progress). Async, and a file whose size, times and inode are unchanged since
// the last reading isn't read again (NFR-06).
export class CodeHasher {
  private dir: string;
  private io: HashIo;
  private seen = new Map<string, { key: string; digest: string }>();
  constructor(backendDir: string, io: HashIo = realIo) {
    this.dir = backendDir;
    this.io = io;
  }
  async read(): Promise<string | null> {
    try {
      const files = (await this.io.readdir(join(this.dir, 'src'))).filter((f) => f.endsWith('.ts')).map((f) => join('src', f)).sort();
      const h = createHash('sha256');
      const next = new Map<string, { key: string; digest: string }>();
      for (const f of [...files, 'package-lock.json', ...SHARED_FILES]) {
        let st;
        try {
          st = await this.io.stat(join(this.dir, f));
        } catch (e) {
          if (!SHARED_FILES.includes(f) || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          h.update(f).update('\0-\0'); // a backend without the page beside it (a test's copy)
          continue;
        }
        const key = `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;
        let e = this.seen.get(f);
        if (!e || e.key !== key) e = { key, digest: createHash('sha256').update(await this.io.readFile(join(this.dir, f))).digest('hex') };
        next.set(f, e);
        h.update(f).update('\0').update(e.digest).update('\0');
      }
      this.seen = next;
      return h.digest('hex').slice(0, 16);
    } catch {
      return null;
    }
  }
}
export const codeHash = (backendDir: string) => new CodeHasher(backendDir).read();

// The update rule. The daemon reads the checkout's code hash every 10 s: an update is pending once
// a hash other than the running one reads the same twice in a row (no restart halfway through a
// save or a checkout), and the daemon restarts once one is pending and nothing runs. A handover put
// off because work started waits for the next reading (a new hash cycle), not the next idle
// second. A hash whose new daemon failed to start isn't tried again; a checkout back at
// the running code clears it.
export class UpdateCheck {
  readonly running: string;
  pending = false;
  cycle = 0; // readings so far
  private last: string;
  private failed: string | null = null;
  private deferredAt = -1;
  constructor(running: string) {
    this.running = running;
    this.last = running;
  }
  // One reading of the checkout's hash (null: unreadable, skipped); true when `pending` changed.
  read(hash: string | null): boolean {
    if (hash === null) return false;
    this.cycle++;
    const was = this.pending;
    this.pending = hash !== this.running && hash === this.last && hash !== this.failed;
    this.last = hash;
    return this.pending !== was;
  }
  restartNow(busy: boolean): boolean {
    return this.pending && !busy && this.cycle > this.deferredAt;
  }
  // Work started while the new daemon loaded: try again after the next reading.
  defer(): void {
    this.deferredAt = this.cycle;
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

export type Successor = { pid: number; loaded: Promise<boolean>; abort: () => void };

// Starts the new daemon (detached: its own session, stdout and stderr appended to daemon.log).
// `loaded` is true once it has loaded every module and waits for this one to exit; false when it
// exits or stays silent for `timeoutMs` first (say a syntax error in the new code: this daemon stays).
// `abort` ends a waiting one, when work started in the meantime.
export function startSuccessor(logFile: string, timeoutMs = SUCCESSOR_MS): Successor {
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
  return { pid: child.pid ?? 0, loaded, abort: () => { child.kill('SIGTERM'); } };
}

// In the new daemon, before it takes the lock: tells the old one it loaded, then waits (at most
// `timeoutMs`) for the old one's pid to go, so two daemons never run on one state folder.
export async function awaitHandover(oldPid: number, timeoutMs = SUCCESSOR_MS): Promise<void> {
  process.send?.({ t: 'loaded' });
  if (process.connected) process.disconnect();
  const deadline = Date.now() + timeoutMs;
  while (alive(oldPid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
}

// ---------- the lifecycle ----------

export type DaemonState = 'starting' | 'ready' | 'stopping';

export type DaemonOptions = {
  stateDir: string;
  backendDir: string;
  log: Log;
  parent: boolean; // false under app/dev.sh (--no-parent): no idle exit, update or restart
  after?: number; // a handover's old daemon: wait for its pid to go before the lock
  exitIdleMs?: number;
  updateReadMs?: number; // test-only: a shorter update reading than 10 s
  successorMs?: number; // test-only: a shorter wait for the new daemon than 20 s
};

// What the daemon stops, in this order, and what it asks while it runs.
export type Parts = {
  busy: () => boolean;
  pages: () => number;
  broadcast: (msg: object) => void;
  refuse: () => void; // no frame acts any more, running actions are acked, and the pages get nothing more
  stop: () => void; // every module's timers and processes
  flush: () => void; // state.json, synchronously
  close: () => Promise<void>; // the server: each page's socket, then the listener
};

export type Daemon = {
  readonly code: string;
  readonly state: DaemonState;
  readonly updatePending: boolean;
  // The server listens: daemon.json is written and the timers start.
  ready: (parts: Parts, listen: { port: number; token: string; version: string; v: number }) => Promise<void>;
  stop: (reason: string) => Promise<void>;
  handOver: (reason: HandoverReason) => Promise<void>;
  // The server couldn't listen: exit 4.
  cannotListen: (port: number, code: string) => never;
};

// Starting: the code hash, a handover's wait, the lock (exit 3 when another daemon holds it), and
// the exit and crash handlers. Then the caller wires the modules and calls `ready`.
export async function startDaemon(o: DaemonOptions): Promise<Daemon> {
  const { stateDir, log } = o;
  const hasher = new CodeHasher(o.backendDir);
  // The code this daemon runs: its modules are loaded by now (daemon.json, /api/ping, updates).
  const code = (await hasher.read()) ?? 'unknown';
  const successorMs = o.successorMs ?? SUCCESSOR_MS;
  const updateReadMs = o.updateReadMs ?? UPDATE_READ_MS;
  const exitIdleMs = o.exitIdleMs ?? IDLE_EXIT_MS;

  // A handover (an update or "Restart Backend Now…"): the old daemon writes state.json and releases
  // the lock once it hears this one loaded; this one takes the lock only after its pid has gone.
  if (o.after !== undefined) await awaitHandover(o.after, successorMs);

  let lock: Lock;
  try {
    lock = acquireLock(stateDir);
  } catch (e) {
    if (!(e instanceof LockedError)) throw e;
    log('lock.refused', { pid: Number.isNaN(e.pid) ? null : e.pid });
    process.stderr.write(`Synopia backend: ${e.message}. Quit it first.\n`);
    process.exit(EXIT.locked);
  }
  clearStaleDaemonInfo(stateDir);

  let state: DaemonState = 'starting';
  let parts: Parts | null = null;
  let handedOver = false; // daemon.json now names the successor's handover: leave it
  let crashed = false;
  const timers: NodeJS.Timeout[] = [];
  const updates = new UpdateCheck(code);
  const daemonLog = join(stateDir, DAEMON_LOG);

  // Any other end: logged, and daemon.json goes (unless it is a handover's).
  process.on('exit', (exitCode) => {
    if (state !== 'stopping' && !crashed) log('backend.exit', { code: exitCode });
    if (!handedOver) removeDaemonInfo(stateDir, process.pid);
  });
  // An uncaught error: its trace to daemon.log, state.json written now, exit 1.
  const crash = (kind: string) => (err: unknown) => {
    if (crashed) return;
    crashed = true;
    process.stderr.write(`${new Date().toISOString()} Synopia backend: ${kind}: ${(err as Error)?.stack ?? String(err)}\n`);
    log('backend.crash', { kind });
    try { parts?.flush(); } catch { /* the exit goes on */ }
    process.exit(EXIT.crash);
  };
  process.on('uncaughtException', crash('uncaughtException'));
  process.on('unhandledRejection', crash('unhandledRejection'));
  process.on('SIGINT', () => void stop('sigint'));
  process.on('SIGTERM', () => void stop('sigterm'));
  // A memory figure on demand, without --inspect (the perf measurements read it).
  process.on('SIGUSR2', () => {
    (globalThis as { gc?: () => void }).gc?.(); // with --expose-gc: the live heap, not garbage
    const m = process.memoryUsage();
    const mb = (n: number) => Math.round(n / 1048576);
    log('memory', { rss: mb(m.rss), heapUsed: mb(m.heapUsed), heapTotal: mb(m.heapTotal), external: mb(m.external), arrayBuffers: mb(m.arrayBuffers) });
  });

  // Stopping. The stop line on stderr is for people reading daemon.log; the shell tells a
  // handover from a crash by daemon.json's `handover`, not by this line.
  async function stop(reason: string, successor?: number): Promise<void> {
    if (state === 'stopping') return;
    const was = state;
    state = 'stopping';
    log('backend.stop', { reason });
    process.stderr.write(`${new Date().toISOString()} Synopia backend: stop (${reason})\n`);
    for (const t of timers) clearInterval(t);
    if (was === 'starting' || !parts) { lock.release(); process.exit(EXIT.ok); }
    parts.refuse();
    if (successor !== undefined && markHandover(stateDir, process.pid, { reason: reason as HandoverReason, successor })) handedOver = true;
    else removeDaemonInfo(stateDir, process.pid);
    parts.stop();
    parts.flush();
    await parts.close();
    lock.release();
    process.exit(EXIT.ok);
  }

  let handingOver = false;
  async function handOver(reason: HandoverReason): Promise<void> {
    if (state !== 'ready' || handingOver || !parts) return;
    handingOver = true;
    log('handover.start', { reason, code, cycle: updates.cycle });
    let next: Successor | null = null;
    try {
      next = startSuccessor(daemonLog, successorMs);
    } catch {
      // Can't open daemon.log or spawn node: handled as a new daemon that didn't load.
    }
    const ok = next ? await next.loaded : false;
    handingOver = false;
    if ((state as DaemonState) === 'stopping') return next?.abort();
    if (!ok || !next) { // the new code didn't load: this daemon stays (daemon.log has the new one's error)
      log('handover.failed', { reason });
      if (reason === 'update') {
        updates.fail();
        parts.broadcast({ t: 'update', pending: false });
      }
      parts.broadcast({ t: 'toast', text: "The new backend didn't start, so this one goes on. See daemon.log." });
      return;
    }
    if (reason === 'update' && parts.busy()) { // work started while the new daemon loaded: after the next reading
      next.abort();
      updates.defer();
      log('handover.deferred', { cycle: updates.cycle });
      return;
    }
    void stop(reason, next.pid);
  }

  async function ready(p: Parts, listen: { port: number; token: string; version: string; v: number }): Promise<void> {
    parts = p;
    writeDaemonInfo(stateDir, { pid: process.pid, procStart: await ownStart(), port: listen.port, token: listen.token, version: listen.version, code, v: listen.v });
    if ((state as DaemonState) === 'stopping') return;
    state = 'ready';
    log('daemon.ready', { port: listen.port, code });
    rotateLog(daemonLog);
    if (!o.parent) return;
    // The idle exit, each minute (or a tenth of a shorter test timeout); the same timer rotates
    // daemon.log at 5 MB.
    const idle = new IdleExit(exitIdleMs, Date.now());
    timers.push(setInterval(() => {
      rotateLog(daemonLog);
      if (idle.check({ pages: p.pages(), busy: p.busy() }, Date.now())) void stop('idle');
    }, Math.max(50, Math.min(60_000, Math.floor(exitIdleMs / 10)))));
    // Updates: a reading every 10 s. While one is pending the page shows "Update ready: restarts
    // when idle", and each second the daemon checks whether anything runs.
    const tickMs = Math.min(1000, updateReadMs);
    let lastRead = Date.now(), reading = false;
    timers.push(setInterval(() => {
      if (!reading && Date.now() - lastRead >= updateReadMs) {
        reading = true;
        void hasher.read().then((h) => {
          reading = false;
          lastRead = Date.now();
          if (state === 'ready' && updates.read(h)) {
            log('update.pending', { pending: updates.pending });
            p.broadcast({ t: 'update', pending: updates.pending });
          }
        });
      }
      if (updates.restartNow(p.busy())) void handOver('update');
    }, tickMs));
  }

  return {
    code,
    get state() { return state; },
    get updatePending() { return updates.pending; },
    ready,
    stop: (reason) => stop(reason),
    handOver,
    cannotListen(port, errCode) {
      lock.release();
      log('server.failed', { code: errCode });
      process.stderr.write(`Synopia backend: cannot listen on 127.0.0.1:${port} (${errCode})\n`);
      process.exit(EXIT.listen);
    },
  };
}
