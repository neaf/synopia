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
import { openStore } from './store.ts';
import { OpenItems } from './open-items.ts';
import { startServer } from './server.ts';
import { Transcripts } from './transcripts.ts';
import { Publisher } from './publisher.ts';
import { Sessions } from './sessions.ts';
import { CliTerminals, realEnd } from './cli-terminals.ts';
import { realSdk, mcpProbe, awsAuthRefreshOf } from './sdk.ts';
import { Creds, gitRoot, guessCommand } from './creds.ts';
import { Terms } from './terms.ts';
import { shellPty } from './pty.ts';
import { Mcp, cliRunner } from './mcp.ts';
import { loadBat } from './preview.ts';
import { Router } from './router.ts';
import { loadLoginEnv } from './login-env.ts';
import { Writer } from './writer.ts';
import { Keeper } from './keeper.ts';
import { Menus } from './menu.ts';
import { BadgeCounter, quitSummary } from './status.ts';
import { startDaemon } from './daemon.ts';
import { EXIT } from './daemon-files.ts';
import { draftImage } from './ui-state.ts';
import { FileRefs } from './file-refs.ts';
import { load as loadBundle } from './bundle.ts';
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
  harness: { type: 'string' }, // the agent-harness plugin folder (bundle.ts), from the app's config.json; dev and checks pass none
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
// The bundled agent-harness (R3.17): read once, its counts logged. Sessions don't load it yet.
const bundle = flags.harness === undefined ? null : await loadBundle(expand(flags.harness), log);
void bundle;
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
// The reading set (every open transcript) and the one sender of frames to the pages.
const transcripts = new Transcripts({
  claudeDir, home, log,
  onAssistant: (sid, mid, types) => sessions.landed(sid, mid, types),
  written: (sid) => store.state.written[sid],
  answerOf: (toolUseId) => store.state.answers[toolUseId],
  planOf: (toolUseId) => store.state.plans[toolUseId],
});
// The open-items lists (open-items.ts): read from each session's ledger and transcript; a change flushes the
// sessions that show the list.
const openItems = new OpenItems({
  store, home, log,
  facts: {
    ledgerOf: (sid) => transcripts.ledgerOf(sid),
    ownsOf: (sid, toolUseId) => transcripts.ownsOf(sid, toolUseId),
    agents: (sid) => transcripts.get(sid)?.agents() ?? [],
    lastYouAt: (sid) => transcripts.lastYouAt(sid),
    replies: (sid) => transcripts.replies(sid),
    exchangeKeys: (sid) => transcripts.exchangeKeys(sid),
    title: (sid) => publisher.meta(sid)?.title ?? '',
    // a turn runs: Synopia's process works, else the transcript shows a turn open (a terminal's)
    turnRunning: (sid) => Boolean(sessions.get(sid)?.working) || transcripts.running(sid).turn,
  },
  onChange: (sids) => { for (const sid of sids) publisher.changed(sid); },
  ask: (sid, kind, key) => keeper.ask(sid, kind, key),
});
// The open-items keeper (keeper.ts): a one-shot call per exchange open-items.ts asks for; its ops go back there.
const keeper = new Keeper({
  store, stateDir, log, sdk,
  source: {
    exchange: (sid, kind) => transcripts.exchange(sid, kind),
    list: (sid) => openItems.keeperList(sid),
    work: (sid) => publisher.work(sid),
    resolve: (sid) => sessions.resolve(sid),
    apply: (sid, ex, ops, began) => openItems.applyOps(sid, ex, ops, began),
  },
});
// The terminals of the runs Synopia holds a pty for (terms.ts): your `!` commands and the credential refresh.
const terms = new Terms();
const publisher = new Publisher({
  transcripts, clients: pages, home, terms,
  written: (sid) => store.state.written[sid],
  defaultModel: () => store.state.settings.model,
  openItems,
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
  store, transcripts, publisher, log, sdk, home, now: scripted?.clock.now, timer: scripted?.clock.timer, pretendFolder: scripted?.pretendFolder,
  idleMs: ms('idle-ms'), terminals, terms,
  onTurnEnded: (sid) => writer.turnEnded(sid),
  onOpened: (sid) => writer.opened(sid),
  onWaiting: (sid) => writer.waitingChanged(sid),
  onCommands: (sid, commands) => {
    const folder = publisher.meta(sid)?.cwd;
    if (folder) menus.commandsChanged(folder, commands);
  },
  onSignedOut: (sid, cwd, on) => void creds.signedOut(sid, cwd, on),
  onGone: (sid) => creds.forget(sid),
  items: openItems,
  onClosed: (sid) => openItems.close(sid),
  onRekeyed: (from, to) => openItems.rekey(from, to),
});

// The credential refresh of a session's folder when its model sign-in expires (creds.ts): the folder's saved
// command in a pseudo-terminal, `zsh -lc` (`sh -lc` under the script, so a check reads no profile of yours).
const creds = new Creds({
  start: shellPty, commands: store.state.refresh, saved: () => store.changed(),
  prefill: (cwd, root) => guessCommand(cwd, root, scripted ? async () => '' : awsAuthRefreshOf),
  rootOf: gitRoot, send: (msg) => publisher.broadcast(msg),
  refreshing: (sids, on) => sessions.refreshing(sids, on), refreshed: (sids) => sessions.refreshed(sids),
  log, shell: scripted ? '/bin/sh' : undefined, againMs: scripted ? 1500 : undefined, terms,
});

// Something runs that the idle exit must not end: a turn, a subagent, a background shell or
// monitor (the ⌥⌘Q confirm's list), or a card waiting on an answer. The update restart waits on the same.
function busy(): boolean {
  const q = sessions.quitCheck();
  return q.running.length + q.background.length > 0 || publisher.pending().length > 0;
}

// /mcp (R5.15): a session's MCP servers; sign-in and sign-out through the bundled CLI (the script's pretend one).
const mcp = new Mcp({ runner: scripted?.mcpRunner ?? cliRunner, probe: (cwd) => mcpProbe(sdk.query, cwd), send: (msg) => publisher.broadcast(msg), log });

// Page frames (router.ts): checked, one module acts, actions acked.
const fileRefs = new FileRefs({ home });
const router = new Router({ sessions, transcripts, publisher, menus, mcp, creds, terms, store, openItems, bat, home, log, dryRun, fileRefs });

try {
  server = await startServer({
    port,
    token,
    webRoot: fileURLToPath(new URL('../../web/', import.meta.url)),
    log,
    onAuthed: (client) => {
      publisher.hello(client, { code: CODE, layout: sessions.layout.get(), menu: menus.all(), ui: store.state.ui, update: daemon.updatePending });
      for (const f of creds.frames()) publisher.reply(client, f); // a refresh that needs you or runs
    },
    quitCheck: () => quitSummary(sessions.quitCheck()),
    badge: () => badge.count,
    ping: () => ({ code: CODE, v: PROTOCOL }),
    onStop: () => void daemon.stop('stopAll'),
    // "Restart Backend Now…": a handover at once, whatever runs (the shell asked first). Not under dev.sh.
    onRestart: flags['no-parent'] ? undefined : () => void daemon.handOver('restart'),
    image: async (sid, agent, ref) => ref.startsWith('draft:') ? draftImage(store, sessions.resolve(sid), ref)
      : ref.startsWith('file:') ? fileRefs.image(sessions.resolve(sid), ref)
      : ref.startsWith('queued:') ? (sessions.get(sid)?.queuedImage(ref) ?? { status: 404 })
      : transcripts.image(sessions.resolve(sid), agent, ref),
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
    keeper.stop();
    menus.stop();
    mcp.stop();
    creds.stop();
    terminals.stop();
    sessions.stop();
    openItems.stop();
    publisher.stop();
    transcripts.stop();
  },
  flush: () => store.close(),
  close: () => (server as Server).close(),
}, { port: (server as Server).port, token, version: VERSION, v: PROTOCOL });
terminals.start();
sessions.start();
scripted?.attach(sessions); // the scripted sessions' processes start
