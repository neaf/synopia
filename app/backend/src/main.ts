// The Synopia backend, a daemon the app starts detached (plan section 2): it owns every session's
// process and all state, and outlives the app. Once it listens it writes <state-dir>/daemon.json
// (daemon.ts), where the app finds it. It ends on POST /api/stop ("Stop All Work"), on SIGTERM or
// SIGINT, or after 30 min with no page connected and nothing running. app/dev.sh runs it with
// --no-parent: {"port":…,"token":…} as the first stdout line, and no idle exit.
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { acquireLock, LockedError } from './lock.ts';
import { openLog } from './log.ts';
import { openStore, reconcileLayout } from './store.ts';
import { startServer } from './server.ts';
import { Views } from './views.ts';
import { FakeDriver, loadScript } from './fake-driver.ts';
import { Sessions } from './sessions.ts';
import { openTarget } from './open.ts';
import { loadBat, previewFile } from './preview.ts';
import { displayPath } from './paths.ts';
import { Writer } from './writer.ts';
import { Menus } from './menu.ts';
import { Badge, badgeCount } from './badge.ts';
import { DAEMON_LOG, IDLE_EXIT_MS, IdleExit, procStart, removeDaemonInfo, rotateLog, writeDaemonInfo } from './daemon.ts';
import { patchUi, draftImage } from './ui.ts';
import type { Image } from './sessions.ts';
import type { CardAnswer } from './answers.ts';
import type { Lock } from './lock.ts';
import type { BadgeSession } from './badge.ts';
import type { Layout, OpenEntry } from './store.ts';
import type { Client, Server } from './server.ts';

const expand = (p: string) => resolve(p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

const { values: flags } = parseArgs({
  options: {
    'claude-dir': { type: 'string' },
    'state-dir': { type: 'string' },
    port: { type: 'string' },
    'no-parent': { type: 'boolean', default: false },
    fake: { type: 'boolean', default: false },
    'idle-ms': { type: 'string' }, // test-only: a shorter idle end than 30 min
    'exit-idle-ms': { type: 'string' }, // test-only: a shorter daemon idle exit than 30 min
    'dry-open': { type: 'boolean', default: false }, // `open` logs its branch and runs nothing (checks)
  },
  strict: true,
});

const claudeDir = expand(flags['claude-dir'] ?? '~/.claude');
const stateDir = expand(flags['state-dir'] ?? '~/Library/Application Support/Synopia');
const port = flags.port === undefined ? 0 : Number(flags.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write(`Synopia backend: bad --port ${flags.port}\n`);
  process.exit(2);
}
if (flags.fake && flags['claude-dir'] === undefined) {
  // The fake driver opens every session it finds: keep it on a fixture tree.
  process.stderr.write('Synopia backend: --fake needs --claude-dir (a fixture tree)\n');
  process.exit(2);
}
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
chmodSync(stateDir, 0o700); // daemon.json holds the token

const log = openLog(
  flags['state-dir'] !== undefined ? join(stateDir, 'backend.log') : join(homedir(), 'Library/Logs/Synopia/backend.log'),
);

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

log('backend.start', { pid: process.pid, fake: flags.fake, daemon: !flags['no-parent'] });
removeDaemonInfo(stateDir); // the lock is ours, so a daemon.json left there is stale
const store = openStore(stateDir, { log });
const token = randomBytes(32).toString('hex');

const VERSION = String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
let server: Server | undefined;
const noClients = new Set<Client>();
const script = flags.fake ? loadScript(claudeDir) : null;
let sessions: Sessions | null = null;
let badge: Badge | null = null;
const views = new Views({
  claudeDir, clients: () => server?.clients ?? noClients, home: script?.home, log,
  onAssistant: (sid, mid, types) => sessions?.landed(sid, mid, types),
  written: (sid) => store.state.written[sid],
  answerOf: (toolUseId) => store.state.answers[toolUseId],
  planOf: (toolUseId) => store.state.plans[toolUseId],
  choice: (sid) => (sessions ? sessions.choiceOf(sid) : store.state.models[sid]),
  defaultModel: () => store.state.settings.model,
  onChange: () => badge?.changed(),
  onRunning: (sid, r) => sessions?.runningChanged(sid, r),
  onWorkEnded: (sid) => writer?.workEnded(sid),
});
// bat for the file preview, found once (plain text without it)
const bat = loadBat({ log });
const fake = script ? new FakeDriver(views, script, { log }) : null;
// Slice 5: the slash menu and the model list per folder (the fake driver has its own).
const menus = fake ? null : new Menus({ clients: () => server?.clients ?? noClients, log, cacheFile: join(stateDir, 'menu-cache.json') });
const idleMs = flags['idle-ms'] === undefined ? undefined : Number(flags['idle-ms']);
// Slice 6: Claude-written titles and Now lines, after each turn and on open.
const writer = fake ? null : new Writer({
  store, stateDir, log,
  source: {
    title: (sid) => views.meta(sid)?.title,
    turns: (sid) => views.turns(sid),
    resolve: (sid) => sessions?.resolve(sid) ?? sid,
    changed: (sid) => views.refresh(sid),
    work: (sid) => views.work(sid),
  },
});
if (!fake) {
  sessions = new Sessions({
    store, views, log, idleMs: idleMs && idleMs > 0 ? idleMs : undefined,
    onTurnEnded: (sid) => writer?.turnEnded(sid),
    onOpened: (sid) => writer?.opened(sid),
    onWaiting: (sid) => writer?.waitingChanged(sid),
    onCommands: (sid, commands) => {
      const folder = views.meta(sid)?.cwd;
      if (folder) menus?.commandsChanged(folder, commands);
    },
  });
}

// The open sessions: state.json's open list, or every fixture session under --fake.
function openEntries(): OpenEntry[] {
  if (!fake) return sessions ? sessions.layoutEntries() : store.state.open;
  return views.ids().map((id) => ({ id, cwd: views.meta(id)?.cwd ?? '', openedAt: 0, closedAt: null }));
}

const badgeSource = { sessions: () => views.sessions() as BadgeSession[], pending: () => views.pending(), reviewed: () => store.state.reviewed };

// Something runs that the idle exit must not end: a turn, a subagent, a background shell or
// monitor (the ⌥⌘Q confirm's list), or a card waiting on an answer.
function busy(): boolean {
  const q = sessions?.quitCheck();
  return (q ? q.running.length + q.background.length : 0) > 0 || views.pending().length > 0;
}

function onMessage(client: Client, msg: { t: string; [k: string]: unknown }) {
  if (msg.t === 'view' && typeof msg.sid === 'string') {
    const sid = sessions ? sessions.resolve(msg.sid) : msg.sid;
    views.view(client, sid, typeof msg.agent === 'string' ? msg.agent : null, typeof msg.from === 'string' ? msg.from : null);
    const folder = views.meta(sid)?.cwd, abs = sessions?.cwdOf(sid);
    if (menus && sessions && folder && abs) void menus.viewed(client, folder, abs, sessions.menuSource(sid));
  } else if (msg.t === 'earlier' && typeof msg.sid === 'string' && typeof msg.before === 'string') {
    const sid = sessions ? sessions.resolve(msg.sid) : msg.sid;
    views.earlier(client, sid, typeof msg.agent === 'string' ? msg.agent : null, msg.before);
  } else if (msg.t === 'toolOutput' && typeof msg.sid === 'string' && typeof msg.toolUseId === 'string') {
    const sid = sessions ? sessions.resolve(msg.sid) : msg.sid;
    views.toolOutput(client, sid, typeof msg.agent === 'string' ? msg.agent : null, msg.toolUseId);
  } else if (msg.t === 'setModel' && typeof msg.sid === 'string' && typeof msg.model === 'string') {
    const effort = typeof msg.effort === 'string' && msg.effort ? msg.effort : null;
    if (sessions) {
      void sessions.setModel(msg.sid, msg.model, effort).then((r) => { if (!r.ok) client.send({ t: 'toast', text: r.error }); });
    } else { // the fake driver: stored and shown, nothing runs
      store.state.models[msg.sid] = { model: msg.model, effort };
      store.changed();
      views.refresh(msg.sid);
    }
  } else if (sessions && msg.t === 'newSession') {
    sessions.newSession();
  } else if (sessions && msg.t === 'listRecent') {
    const s = sessions;
    s.listRecent(typeof msg.filter === 'string' ? msg.filter : '').then(
      (list) => client.send({ t: 'recent', filter: msg.filter ?? '', sessions: list }),
      (e) => { log('sessions.listFailed', { error: String((e as Error)?.name ?? 'error') }); client.send({ t: 'recent', filter: msg.filter ?? '', sessions: [], error: true }); },
    );
  } else if (sessions && msg.t === 'openSession' && typeof msg.id === 'string') {
    sessions.openSession(msg.id).then(
      (r) => { if (!r.ok) client.send({ t: 'toast', text: r.error }); },
      () => client.send({ t: 'toast', text: "Synopia couldn't read the list of past sessions." }),
    );
  } else if (sessions && msg.t === 'close' && typeof msg.sid === 'string') {
    const r = sessions.close(msg.sid);
    if (!r.ok) client.send({ t: 'toast', text: r.error });
  } else if (sessions && msg.t === 'interrupt' && typeof msg.sid === 'string') {
    void sessions.interrupt(msg.sid);
  } else if (sessions && msg.t === 'send' && typeof msg.sid === 'string') {
    const images = Array.isArray(msg.images)
      ? (msg.images as Image[]).filter((im) => im && typeof im.mediaType === 'string' && typeof im.data === 'string')
      : [];
    const r = sessions.send(msg.sid, typeof msg.text === 'string' ? msg.text : '', images, typeof msg.uuid === 'string' ? msg.uuid : undefined);
    if (!r.ok) client.send({ t: 'toast', text: r.error });
  } else if (sessions && msg.t === 'answer' && typeof msg.sid === 'string' && typeof msg.requestId === 'string') {
    const r = sessions.answer(msg.sid, msg.requestId, (msg.answer && typeof msg.answer === 'object' ? msg.answer : {}) as CardAnswer);
    if (!r.ok) client.send({ t: 'toast', text: r.error });
  } else if (msg.t === 'reviewed' && typeof msg.agentId === 'string') {
    if (!store.state.reviewed.includes(msg.agentId)) store.state.reviewed.push(msg.agentId);
    store.changed();
    badge?.changed();
  } else if (sessions && msg.t === 'stopTask' && typeof msg.sid === 'string' && typeof msg.taskId === 'string') {
    void sessions.stopTask(msg.sid, msg.taskId).then((r) => { if (!r.ok) client.send({ t: 'toast', text: r.error }); });
  } else if (msg.t === 'open') {
    openTarget({ path: msg.path, url: msg.url }, { dryRun: flags['dry-open'], log, onError: (text) => client.send({ t: 'toast', text }) });
  } else if (msg.t === 'preview') { // a text file's read-only preview; anything else opens as `open` does
    const toast = (text: string) => client.send({ t: 'toast', text });
    void bat.then((b) => previewFile(msg.path, {
      bat: b, log, display: (p) => displayPath(p, script?.home ?? homedir()), reply: (r) => client.send(r), toast,
      open: (p) => openTarget({ path: p }, { dryRun: flags['dry-open'], log, onError: toast }),
    }));
  } else if (msg.t === 'ui') { // the page's UI state (R3.9): stored, returned in hello, never broadcast
    patchUi(store, msg.patch, { resolve: (id) => sessions?.resolve(id) ?? id, known: (id) => views.meta(id) !== undefined, toast: (text) => client.send({ t: 'toast', text }) });
  } else if (msg.t === 'layout' && msg.layout && typeof msg.layout === 'object') {
    store.state.layout = reconcileLayout(msg.layout as Layout, store.state.layout, openEntries());
    store.changed();
  } else if (!fake?.onMessage(client, msg)) {
    log('ws.ignored', { t: msg.t }); // the rest of section 5 comes with later tasks
  }
}

try {
  server = await startServer({
    port,
    token,
    webRoot: fileURLToPath(new URL('../../web/', import.meta.url)),
    log,
    hello: () => ({
      sessions: views.sessions(),
      layout: store.state.layout,
      reviewed: store.state.reviewed,
      menu: fake ? fake.menu() : menus?.all() ?? {},
      settings: store.state.settings,
      pending: views.pending(),
      ui: store.state.ui,
    }),
    quitCheck: () => sessions?.quitCheck() ?? { running: [], background: [] },
    badge: () => badgeCount(badgeSource),
    onStop: () => void shutdown('stopAll'),
    image: (sid, agent, ref) => ref.startsWith('draft:') ? draftImage(store, sessions ? sessions.resolve(sid) : sid, ref) : views.image(sessions ? sessions.resolve(sid) : sid, agent, ref),
    onMessage,
  });
} catch (e) {
  lock.release();
  log('server.failed', { code: (e as NodeJS.ErrnoException).code ?? 'unknown' });
  process.stderr.write(`Synopia backend: cannot listen on 127.0.0.1:${port} (${(e as NodeJS.ErrnoException).code ?? 'error'})\n`);
  process.exit(4);
}

let stopping = false;
let idleTimer: NodeJS.Timeout | null = null;
async function shutdown(reason: string) {
  if (stopping) return;
  stopping = true;
  log('backend.stop', { reason });
  process.stderr.write(`${new Date().toISOString()} Synopia backend: stop (${reason})\n`);
  if (idleTimer) clearInterval(idleTimer);
  removeDaemonInfo(stateDir, process.pid);
  fake?.stop();
  badge?.stop();
  writer?.stop();
  menus?.stop();
  sessions?.stop();
  views.stop();
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
writeDaemonInfo(stateDir, { pid: process.pid, procStart: procStart(process.pid), port: (server as Server).port, token, version: VERSION });
log('daemon.ready', { port: (server as Server).port });
if (fake) fake.start(claudeDir);
else sessions?.start();
// The Dock badge (requirements R2.6): the shell polls GET /api/badge; each change is logged.
badge = new Badge({ source: badgeSource, emit: (n) => log('badge', { n }) });
badge.changed();

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
