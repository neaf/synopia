// The Synopia backend. Started by the shell (stdin is its lifetime) or by
// app/dev.sh with --no-parent. Prints one stdout line: {"port":…,"token":…}.
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { acquireLock, LockedError } from './lock.ts';
import { openLog } from './log.ts';
import { openStore, reconcileLayout } from './store.ts';
import { startServer } from './server.ts';
import { Views } from './views.ts';
import { FakeDriver, loadScript } from './fake-driver.ts';
import type { Lock } from './lock.ts';
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
mkdirSync(stateDir, { recursive: true });

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

log('backend.start', { pid: process.pid, fake: flags.fake, parent: !flags['no-parent'] });
const store = openStore(stateDir, { log });
const token = randomBytes(32).toString('hex');

let server: Server | undefined;
const noClients = new Set<Client>();
const script = flags.fake ? loadScript(claudeDir) : null;
const views = new Views({ claudeDir, clients: () => server?.clients ?? noClients, home: script?.home, log });
const fake = script ? new FakeDriver(views, script, { log }) : null;

// The open sessions: state.json's open list (filled from S1-6 on), or every fixture session under --fake.
function openEntries(): OpenEntry[] {
  if (!fake) return store.state.open;
  return views.ids().map((id) => ({ id, cwd: views.meta(id)?.cwd ?? '', openedAt: 0, closedAt: null }));
}

function onMessage(client: Client, msg: { t: string; [k: string]: unknown }) {
  if (msg.t === 'view' && typeof msg.sid === 'string') {
    views.view(client, msg.sid, typeof msg.agent === 'string' ? msg.agent : null);
  } else if (msg.t === 'reviewed' && typeof msg.agentId === 'string') {
    if (!store.state.reviewed.includes(msg.agentId)) store.state.reviewed.push(msg.agentId);
    store.changed();
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
      menu: fake ? fake.menu() : {},
      settings: store.state.settings,
      pending: views.pending(),
    }),
    quitCheck: () => ({ running: [], background: [] }),
    onMessage,
  });
} catch (e) {
  lock.release();
  log('server.failed', { code: (e as NodeJS.ErrnoException).code ?? 'unknown' });
  process.stderr.write(`Synopia backend: cannot listen on 127.0.0.1:${port} (${(e as NodeJS.ErrnoException).code ?? 'error'})\n`);
  process.exit(4);
}

let stopping = false;
async function shutdown(reason: string) {
  if (stopping) return;
  stopping = true;
  log('backend.stop', { reason });
  fake?.stop();
  views.stop();
  store.close();
  await server?.close();
  lock.release();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('sigint'));
process.on('SIGTERM', () => shutdown('sigterm'));
if (!flags['no-parent']) {
  process.stdin.on('end', () => shutdown('stdin'));
  process.stdin.on('close', () => shutdown('stdin'));
  process.stdin.resume();
}

if (fake) fake.start(claudeDir);
else for (const e of store.state.open) if (e.closedAt === null) views.open(e.id, { cwd: e.cwd });
process.stdout.write(JSON.stringify({ port: (server as Server).port, token }) + '\n');
