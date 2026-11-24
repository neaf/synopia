// The Synopia backend, a daemon the app starts detached (requirements R2.8): it owns every session's
// process and all state, and outlives the app. This file wires the modules; daemon.ts owns the
// lifecycle (lock, daemon.json, idle exit, updates, handover, shutdown order, crash exit). app/dev.sh
// runs it with --no-parent: {"port":…,"token":…} as the first stdout line, no idle exit, no updates.
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
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
import { BadgeCounter, quitSummary } from './status.ts';
import { startDaemon } from './daemon.ts';
import { EXIT } from './daemon-files.ts';
import { draftImage } from './ui-state.ts';
import { VERSION as PROTOCOL } from '../../web/js/protocol.js';
import type { Client, Server } from './server.ts';

const expand = (p: string) => resolve(p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

const OPTIONS = {
  'claude-dir': { type: 'string' },
  'state-dir': { type: 'string' },
  port: { type: 'string' },
  'no-parent': { type: 'boolean', default: false },
  'sdk-script': { type: 'string' }, // dev and checks: the scripted SDK (dev/scripted-sdk.ts) over --claude-dir
  'idle-ms': { type: 'string' }, // test-only: a shorter idle end than 30 min
  'exit-idle-ms': { type: 'string' }, // test-only: a shorter daemon idle exit than 30 min
  'update-read-ms': { type: 'string' }, // test-only: a shorter update reading than 10 s
  'successor-ms': { type: 'string' }, // test-only: a shorter wait for a new daemon than 20 s
  'dry-run': { type: 'boolean', default: false }, // `open` and a take-over's signal log and act on nothing (checks)
  after: { type: 'string' }, // set by the daemon this one replaces: wait for its pid to go first
  // The flags of the daemons before the scripted SDK. A successor gets its old daemon's command
  // line, so the one update from such a daemon (a check's, never the app's) must start:
  // --fake is the scripted SDK with no script, --dry-open is --dry-run.
  fake: { type: 'boolean', default: false },
  'dry-open': { type: 'boolean', default: false },
} as const;
// An unknown flag or a missing value is a bad argument (exit 2), as a bad --port is.
function parseFlags() {
  try {
    return parseArgs({ options: OPTIONS, strict: true }).values;
  } catch (e) {
    process.stderr.write(`Synopia backend: ${(e as Error).message}\n`);
    process.exit(EXIT.badArgs);
  }
}
const flags = parseFlags();
const dryRun = flags['dry-run'] || flags['dry-open'];
const legacyFake = flags.fake && flags['sdk-script'] === undefined;

const claudeDir = expand(flags['claude-dir'] ?? '~/.claude');
const stateDir = expand(flags['state-dir'] ?? '~/Library/Application Support/Synopia');
const port = flags.port === undefined ? 0 : Number(flags.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write(`Synopia backend: bad --port ${flags.port}\n`);
  process.exit(EXIT.badArgs);
}
// A test-only duration flag: a positive number of ms, else the default.
const ms = (name: 'idle-ms' | 'exit-idle-ms' | 'update-read-ms' | 'successor-ms') => {
  const n = flags[name] === undefined ? NaN : Number(flags[name]);
  return n > 0 ? n : undefined;
};
if ((flags['sdk-script'] !== undefined || legacyFake) && flags['claude-dir'] === undefined) {
  // The script opens every session it finds and writes to their transcripts: keep it on a fixture tree.
  process.stderr.write('Synopia backend: --sdk-script needs --claude-dir (a fixture tree)\n');
  process.exit(EXIT.badArgs);
}
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
chmodSync(stateDir, 0o700); // daemon.json holds the token

const log = openLog(
  flags['state-dir'] !== undefined ? join(stateDir, 'backend.log') : join(homedir(), 'Library/Logs/Synopia/backend.log'),
);

const daemon = await startDaemon({
  stateDir, log, backendDir: fileURLToPath(new URL('..', import.meta.url)), parent: !flags['no-parent'],
  after: flags.after === undefined ? undefined : Number(flags.after),
  exitIdleMs: ms('exit-idle-ms'), updateReadMs: ms('update-read-ms'), successorMs: ms('successor-ms'),
});
const CODE = daemon.code;

log('backend.start', { pid: process.pid, scripted: flags['sdk-script'] !== undefined || legacyFake, daemon: !flags['no-parent'] });
// The scripted SDK (dev and checks, no model call). It seeds a fresh state folder: before openStore.
const scripted = flags['sdk-script'] === undefined && !legacyFake ? null
  : (await import('../dev/scripted-sdk.ts')).openScripted({ file: flags['sdk-script'] === undefined ? null : expand(flags['sdk-script']), claudeDir, stateDir, log });
const sdk = scripted?.sdk ?? realSdk;
const home = scripted?.home ?? homedir();
// The user's login PATH and its kin (login-env.ts), before anything spawns: an app started from
// the Dock gives the daemon launchd's short PATH, and every session's tools need the real one.
// Not under the script (no CLI runs), nor in a successor (it inherits the merged environment).
if (!scripted) await loadLoginEnv({ log });
const store = openStore(stateDir, { log });
const token = randomBytes(32).toString('hex');

const VERSION = String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
let server: Server | undefined;
const noClients = new Set<Client>();
// Shutdown: once the router refused, the pages get nothing more (a card cleared on the way out
// would flash away before "Reconnecting…").
let quiet = false;
const pages = () => (quiet ? noClients : server?.clients ?? noClients);
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
  transcripts, clients: pages, home,
  written: (sid) => store.state.written[sid],
  defaultModel: () => store.state.settings.model,
  reviewed: (id) => marks.has(id),
  badge,
  onRunning: (sid, r) => sessions.runningChanged(sid, r),
  onWorkEnded: (sid) => writer.workEnded(sid),
  layout: () => sessions.layout.get(),
});
// bat for the file preview, found once (plain text without it)
const bat = loadBat({ log });
// The slash menu and the model list per folder.
const menus = new Menus({ clients: pages, reply: (c, msg) => publisher.reply(c, msg), log, cacheFile: join(stateDir, 'menu-cache.json'), sdk });
// Claude-written titles and Now lines, after each turn and on open.
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
  dir: join(claudeDir, 'sessions'), log, probe: scripted?.probe, end: scripted?.end ?? (dryRun ? dryEnd : undefined),
});
const sessions = new Sessions({
  store, transcripts, publisher, log, sdk, home, now: scripted?.clock.now, timer: scripted?.clock.timer,
  idleMs: ms('idle-ms'), terminals,
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
const router = new Router({ sessions, transcripts, publisher, menus, store, marks, bat, home, log, dryRun });

try {
  server = await startServer({
    port,
    token,
    webRoot: fileURLToPath(new URL('../../web/', import.meta.url)),
    log,
    onAuthed: (client) => publisher.hello(client, { code: CODE, layout: sessions.layout.get(), menu: menus.all(), ui: store.state.ui, update: daemon.updatePending }),
    quitCheck: () => quitSummary(sessions.quitCheck()),
    badge: () => badge.count,
    ping: () => ({ code: CODE, v: PROTOCOL }),
    onStop: () => void daemon.stop('stopAll'),
    // "Restart Backend Now…": a handover at once, whatever runs (the shell asked first). Not under dev.sh.
    onRestart: flags['no-parent'] ? undefined : () => void daemon.handOver('restart'),
    image: (sid, agent, ref) => ref.startsWith('draft:') ? draftImage(store, sessions.resolve(sid), ref) : transcripts.image(sessions.resolve(sid), agent, ref),
    onMessage: (client, msg) => router.handle(client, msg),
  });
} catch (e) {
  daemon.cannotListen(port, (e as NodeJS.ErrnoException).code ?? 'error');
}

// Ready first: the app loads the page while the open sessions' transcripts are read (a large one
// in slices, tail.ts), so the window isn't blank until every file is parsed. The daemon's stdout
// is daemon.log, so the token goes only to daemon.json (0600); dev.sh reads it from stdout.
if (flags['no-parent']) process.stdout.write(JSON.stringify({ port: (server as Server).port, token }) + '\n');
await daemon.ready({
  busy, pages: () => (server as Server).clients.size, broadcast: (msg) => publisher.broadcast(msg),
  refuse: () => { router.stop(); quiet = true; }, // actions still running are acked first
  stop: () => {
    writer.stop();
    menus.stop();
    terminals.stop();
    sessions.stop();
    publisher.stop();
    transcripts.stop();
  },
  flush: () => store.close(),
  close: () => (server as Server).close(),
}, { port: (server as Server).port, token, version: VERSION, v: PROTOCOL });
terminals.start();
sessions.start();
scripted?.attach(sessions); // the scripted sessions' processes start
