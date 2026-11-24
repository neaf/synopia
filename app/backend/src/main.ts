// The Synopia backend, a daemon the app starts detached (plan section 2): it owns every session's
// process and all state, and outlives the app. Once it listens it writes <state-dir>/daemon.json
// (daemon.ts), where the app finds it. It ends on POST /api/stop ("Stop All Work"), on SIGTERM or
// SIGINT, or after 30 min with no page connected and nothing running. When its checkout's code
// changes it hands over to a new daemon once nothing runs (POST /api/restart: at once). app/dev.sh
// runs it with --no-parent: {"port":…,"token":…} as the first stdout line, no idle exit, no updates.
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { acquireLock, LockedError } from './lock.ts';
import { openLog } from './log.ts';
import { openStore, ReviewedMarks } from './store.ts';
import { startServer } from './server.ts';
import { Transcripts } from './transcripts.ts';
import { Publisher } from './publisher.ts';
import { Sessions } from './sessions.ts';
import { CliTerminals, realEnd } from './cli-terminals.ts';
import { realSdk } from './sdk.ts';
import { loadBat } from './preview.ts';
import { Router } from './router.ts';
import { loadLoginEnv } from './login-env.ts';
import { Writer } from './writer.ts';
import { Menus } from './menu.ts';
import { BadgeCounter } from './status.ts';
import {
  DAEMON_LOG, IDLE_EXIT_MS, IdleExit, UPDATE_READ_MS, UpdateCheck, awaitHandover, codeHash, ownStart, removeDaemonInfo, rotateLog,
  startSuccessor, writeDaemonInfo,
} from './daemon.ts';
import { draftImage } from './ui.ts';
import type { Lock } from './lock.ts';
import type { Successor } from './daemon.ts';
import type { Client, Server } from './server.ts';

const expand = (p: string) => resolve(p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

const { values: flags } = parseArgs({
  options: {
    'claude-dir': { type: 'string' },
    'state-dir': { type: 'string' },
    port: { type: 'string' },
    'no-parent': { type: 'boolean', default: false },
    'sdk-script': { type: 'string' }, // dev and checks: the scripted SDK (dev/scripted-sdk.ts) over --claude-dir
    'idle-ms': { type: 'string' }, // test-only: a shorter idle end than 30 min
    'exit-idle-ms': { type: 'string' }, // test-only: a shorter daemon idle exit than 30 min
    'dry-run': { type: 'boolean', default: false }, // `open` and a take-over's signal log and act on nothing (checks)
    after: { type: 'string' }, // set by the daemon this one replaces: wait for its pid to go first
  },
  strict: true,
});

// The code this daemon runs: its modules are loaded by now (daemon.json, /api/ping, updates).
const backendDir = fileURLToPath(new URL('..', import.meta.url));
const CODE = codeHash(backendDir) ?? 'unknown';

const claudeDir = expand(flags['claude-dir'] ?? '~/.claude');
const stateDir = expand(flags['state-dir'] ?? '~/Library/Application Support/Synopia');
const port = flags.port === undefined ? 0 : Number(flags.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write(`Synopia backend: bad --port ${flags.port}\n`);
  process.exit(2);
}
if (flags['sdk-script'] !== undefined && flags['claude-dir'] === undefined) {
  // The script opens every session it finds and writes to their transcripts: keep it on a fixture tree.
  process.stderr.write('Synopia backend: --sdk-script needs --claude-dir (a fixture tree)\n');
  process.exit(2);
}
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
chmodSync(stateDir, 0o700); // daemon.json holds the token

const log = openLog(
  flags['state-dir'] !== undefined ? join(stateDir, 'backend.log') : join(homedir(), 'Library/Logs/Synopia/backend.log'),
);

// A handover (an update or "Restart Backend Now…"): the old daemon writes state.json and releases
// the lock once it hears this one loaded; this one takes the lock only after its pid has gone.
if (flags.after !== undefined) await awaitHandover(Number(flags.after));

let lock: Lock;
try {
  lock = acquireLock(stateDir);
} catch (e) {
  if (e instanceof LockedError) {
    log('lock.refused', { pid: e.pid });
    process.stderr.write(`Synopia backend: ${e.message}. Quit it first.\n`);
    process.exit(3);
  }
  throw e;
}

log('backend.start', { pid: process.pid, scripted: flags['sdk-script'] !== undefined, daemon: !flags['no-parent'] });
// The scripted SDK (dev and checks, no model call). It seeds a fresh state folder: before openStore.
const scripted = flags['sdk-script'] === undefined ? null
  : (await import('../dev/scripted-sdk.ts')).openScripted({ file: expand(flags['sdk-script']), claudeDir, stateDir, log });
const sdk = scripted?.sdk ?? realSdk;
const home = scripted?.home ?? homedir();
// The user's login PATH and its kin (login-env.ts), before anything spawns: an app started from
// the Dock gives the daemon launchd's short PATH, and every session's tools need the real one.
// Not under the script (no CLI runs), nor in a successor (it inherits the merged environment).
if (!scripted) await loadLoginEnv({ log });
removeDaemonInfo(stateDir); // the lock is ours, so a daemon.json left there is stale
const store = openStore(stateDir, { log });
const token = randomBytes(32).toString('hex');

const VERSION = String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
const updates = new UpdateCheck(CODE);
let server: Server | undefined;
const noClients = new Set<Client>();
// The Dock badge (requirements R2.6): status.ts keeps the count as sessions change; the shell polls
// GET /api/badge, and each change is logged.
const badge = new BadgeCounter((n) => log('badge', { n }));
const marks = new ReviewedMarks(store);
// The reading set (every open transcript) and the one sender of frames to the pages.
const transcripts = new Transcripts({
  claudeDir, home, log,
  onAssistant: (sid, mid, types) => sessions.landed(sid, mid, types),
  written: (sid) => store.state.written[sid],
  answerOf: (toolUseId) => store.state.answers[toolUseId],
  planOf: (toolUseId) => store.state.plans[toolUseId],
});
const publisher = new Publisher({
  transcripts, clients: () => server?.clients ?? noClients, home,
  written: (sid) => store.state.written[sid],
  defaultModel: () => store.state.settings.model,
  reviewed: (id) => marks.has(id),
  badge,
  onRunning: (sid, r) => sessions.runningChanged(sid, r),
  onWorkEnded: (sid) => writer.workEnded(sid),
});
// bat for the file preview, found once (plain text without it)
const bat = loadBat({ log });
// Slice 5: the slash menu and the model list per folder.
const menus = new Menus({ clients: () => server?.clients ?? noClients, reply: (c, msg) => publisher.reply(c, msg), log, cacheFile: join(stateDir, 'menu-cache.json'), sdk });
const idleMs = flags['idle-ms'] === undefined ? undefined : Number(flags['idle-ms']);
// Slice 6: Claude-written titles and Now lines, after each turn and on open.
const writer = new Writer({
  store, stateDir, log, sdk,
  source: {
    title: (sid) => publisher.meta(sid)?.title,
    turns: (sid) => transcripts.turns(sid),
    resolve: (sid) => sessions.resolve(sid),
    changed: (sid) => publisher.changed(sid),
    work: (sid) => publisher.work(sid),
  },
});
// FR-SES-08: the terminals that hold sessions, from the CLI's pid files (cli-terminals.ts). Under the
// script, its pretend CLIs; with --dry-run a take-over's signal is only logged.
const dryEnd = { ...realEnd, kill: (pid: number, signal: string) => log('terminals.dryKill', { pid, signal }) };
const terminals = new CliTerminals({
  dir: join(claudeDir, 'sessions'), log, probe: scripted?.probe, end: scripted?.end ?? (flags['dry-run'] ? dryEnd : undefined),
});
const sessions = new Sessions({
  store, transcripts, publisher, log, sdk, home, now: scripted?.clock.now, timer: scripted?.clock.timer,
  idleMs: idleMs && idleMs > 0 ? idleMs : undefined, registry: terminals,
  onTurnEnded: (sid) => writer.turnEnded(sid),
  onOpened: (sid) => writer.opened(sid),
  onWaiting: (sid) => writer.waitingChanged(sid),
  onCommands: (sid, commands) => {
    const folder = publisher.meta(sid)?.cwd;
    if (folder) menus.commandsChanged(folder, commands);
  },
});

// Something runs that the idle exit must not end: a turn, a subagent, a background shell or
// monitor (the ⌥⌘Q confirm's list), or a card waiting on an answer. The update restart waits on the same.
function busy(): boolean {
  const q = sessions.quitCheck();
  return q.running.length + q.background.length > 0 || publisher.pending().length > 0;
}

// Page frames (router.ts): checked, one module acts, actions acked.
const router = new Router({ sessions, transcripts, publisher, menus, store, marks, bat, home, log, dryRun: flags['dry-run'] });

try {
  server = await startServer({
    port,
    token,
    webRoot: fileURLToPath(new URL('../../web/', import.meta.url)),
    log,
    onAuthed: (client) => publisher.hello(client, { code: CODE, layout: store.state.layout, menu: menus.all(), ui: store.state.ui, update: updates.pending }),
    quitCheck: () => sessions.quitCheck(),
    badge: () => badge.count,
    ping: () => ({ code: CODE }),
    onStop: () => void shutdown('stopAll'),
    // "Restart Backend Now…": a handover at once, whatever runs (the shell asked first). Not under dev.sh.
    onRestart: flags['no-parent'] ? undefined : () => void handOver('restart'),
    image: (sid, agent, ref) => ref.startsWith('draft:') ? draftImage(store, sessions.resolve(sid), ref) : transcripts.image(sessions.resolve(sid), agent, ref),
    onMessage: (client, msg) => router.handle(client, msg),
  });
} catch (e) {
  lock.release();
  log('server.failed', { code: (e as NodeJS.ErrnoException).code ?? 'unknown' });
  process.stderr.write(`Synopia backend: cannot listen on 127.0.0.1:${port} (${(e as NodeJS.ErrnoException).code ?? 'error'})\n`);
  process.exit(4);
}

let stopping = false;
let idleTimer: NodeJS.Timeout | null = null;
let updateTimer: NodeJS.Timeout | null = null;
// daemon.log's stop line ("… Synopia backend: stop (update)") is also how the shell tells a
// handover from a crash: it waits for the new daemon instead of starting one.
async function shutdown(reason: string) {
  if (stopping) return;
  stopping = true;
  log('backend.stop', { reason });
  process.stderr.write(`${new Date().toISOString()} Synopia backend: stop (${reason})\n`);
  if (idleTimer) clearInterval(idleTimer);
  if (updateTimer) clearInterval(updateTimer);
  router.stop(); // nothing more reaches the sessions (a handover's new daemon takes over); actions still running are acked
  removeDaemonInfo(stateDir, process.pid);
  writer.stop();
  menus.stop();
  terminals.stop();
  sessions.stop();
  publisher.stop();
  transcripts.stop();
  store.close();
  await server?.close();
  lock.release();
  process.exit(0);
}

// Any other end (an uncaught error, whose trace goes to daemon.log): logged, and daemon.json goes.
process.on('exit', (code) => {
  if (!stopping) log('backend.exit', { code });
  removeDaemonInfo(stateDir, process.pid);
});
process.on('SIGINT', () => shutdown('sigint'));
process.on('SIGTERM', () => shutdown('sigterm'));
// A memory figure on demand, without --inspect (the perf measurements in .ai-notes/app read it).
process.on('SIGUSR2', () => {
  (globalThis as { gc?: () => void }).gc?.(); // with --expose-gc: the live heap, not garbage
  const m = process.memoryUsage();
  const mb = (n: number) => Math.round(n / 1048576);
  log('memory', { rss: mb(m.rss), heapUsed: mb(m.heapUsed), heapTotal: mb(m.heapTotal), external: mb(m.external), arrayBuffers: mb(m.arrayBuffers) });
});
// Ready first: the app loads the page while the open sessions' transcripts are read (a large one
// in slices, tail.ts), so the window isn't blank until every file is parsed. The daemon's stdout
// is daemon.log, so the token goes only to daemon.json (0600); dev.sh reads it from stdout.
if (flags['no-parent']) process.stdout.write(JSON.stringify({ port: (server as Server).port, token }) + '\n');
writeDaemonInfo(stateDir, { pid: process.pid, procStart: await ownStart(), port: (server as Server).port, token, version: VERSION, code: CODE });
log('daemon.ready', { port: (server as Server).port, code: CODE });
terminals.start();
sessions.start();
scripted?.attach(sessions); // the scripted sessions' processes start
// The idle exit: 30 min with no page connected and nothing running (none under dev.sh). The same
// timer rotates daemon.log at 5 MB, each minute (or a tenth of a shorter test timeout).
const exitIdleMs = flags['exit-idle-ms'] === undefined ? IDLE_EXIT_MS : Number(flags['exit-idle-ms']);
const idle = new IdleExit(exitIdleMs, Date.now());
const daemonLog = join(stateDir, DAEMON_LOG);
rotateLog(daemonLog);
if (!flags['no-parent']) {
  idleTimer = setInterval(() => {
    rotateLog(daemonLog);
    if (idle.check({ pages: (server as Server).clients.size, busy: busy() }, Date.now())) void shutdown('idle');
  }, Math.max(50, Math.min(60_000, Math.floor(exitIdleMs / 10))));
}

// Updates: the daemon reads its checkout's code hash every 10 s (daemon.ts UpdateCheck). While
// one is pending the page shows "Update ready: restarts when idle", and each second the daemon
// checks whether anything runs; once nothing does, it hands over to a new daemon. None under dev.sh.
let handingOver = false;
async function handOver(reason: 'update' | 'restart') {
  if (stopping || handingOver) return;
  handingOver = true;
  log('handover.start', { reason, code: CODE });
  let next: Successor | null = null;
  try {
    next = startSuccessor(daemonLog);
  } catch {
    // Can't open daemon.log or spawn node: handled as a new daemon that didn't load.
  }
  const ok = next ? await next.loaded : false;
  handingOver = false;
  if (stopping) return next?.abort();
  if (!ok || !next) { // the new code didn't load: this daemon stays (daemon.log has the new one's error)
    log('handover.failed', { reason });
    if (reason === 'update') {
      updates.fail();
      broadcast({ t: 'update', pending: false });
    }
    broadcast({ t: 'toast', text: "The new backend didn't start, so this one goes on. See daemon.log." });
    return;
  }
  if (reason === 'update' && busy()) { // work started while the new daemon loaded: later
    next.abort();
    log('handover.deferred', {});
    return;
  }
  void shutdown(reason);
}
function broadcast(msg: object) {
  publisher.broadcast(msg);
}
if (!flags['no-parent']) {
  let tick = 0;
  updateTimer = setInterval(() => {
    if (++tick % Math.round(UPDATE_READ_MS / 1000) === 0 && updates.read(codeHash(backendDir))) {
      log('update.pending', { pending: updates.pending });
      broadcast({ t: 'update', pending: updates.pending });
    }
    if (updates.restartNow(busy())) void handOver('update');
  }, 1000);
}
