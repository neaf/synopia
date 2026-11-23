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
import { openStore } from './store.ts';
import { startServer } from './server.ts';
import type { Lock } from './lock.ts';
import type { Server } from './server.ts';

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

let server: Server;
try {
  server = await startServer({
    port,
    token,
    webRoot: fileURLToPath(new URL('../../web/', import.meta.url)),
    log,
    hello: () => ({
      sessions: [],
      layout: store.state.layout,
      reviewed: store.state.reviewed,
      menu: {},
      settings: store.state.settings,
      pending: [],
    }),
    quitCheck: () => ({ running: [], background: [] }),
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
  store.close();
  await server.close();
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

void claudeDir; // used by the transcript reader and sessions from S1-4 on
process.stdout.write(JSON.stringify({ port: server.port, token }) + '\n');
