// A real daemon (src/main.ts) for the contract tests: started on a temp state folder, found through its
// daemon.json, and a page's socket on it that records every frame. Not a test file itself.
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess, StdioOptions } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { readDaemonInfo } from '../src/daemon.ts';
import type { DaemonInfo } from '../src/daemon.ts';

export const MAIN = new URL('../src/main.ts', import.meta.url).pathname;
export const FIXTURES = new URL('./fixtures/claude', import.meta.url).pathname;
export const NODE_FLAGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];

export const tmp = (name = 'daemon') => mkdtempSync(join(tmpdir(), `synopia-${name}-`));

export async function waitFor<T>(get: () => T | null | undefined | false, ms = 15_000, what = 'a condition'): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((ok) => setTimeout(ok, 50));
  }
}

// A copy of a fixture tree, so a test can change its files and its script.
export function fixtureCopy(src = FIXTURES): string {
  const dir = join(tmp('claude'), 'claude');
  cpSync(src, dir, { recursive: true });
  return dir;
}

// The flags for the scripted SDK over a claude tree (dev/scripted-sdk.ts): a copy of the fixture tree
// unless given, since the script writes to the transcripts as a CLI would.
export function scripted(claude = fixtureCopy()): string[] {
  return ['--claude-dir', claude, '--sdk-script', join(claude, 'sdk-script.json')];
}

export type Daemon = { child: ChildProcess; info: DaemonInfo; stateDir: string; log: () => string; stop: () => Promise<void> };

// `args` follow `--state-dir`; the daemon is ready once its daemon.json names its pid.
export async function startDaemon(args: string[], opts: { stateDir?: string; main?: string; stdio?: StdioOptions } = {}): Promise<Daemon> {
  const stateDir = opts.stateDir ?? tmp('state');
  const child = spawn(process.execPath, [...NODE_FLAGS, opts.main ?? MAIN, '--state-dir', stateDir, ...args], { stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  const info = await Promise.race([
    waitFor(() => { const i = readDaemonInfo(stateDir); return i?.pid === child.pid ? i : null; }, 20_000, 'daemon.json'),
    exited.then(([code]) => { throw new Error(`the daemon exited with ${code} before it was ready`); }),
  ]);
  return {
    child, info, stateDir,
    log: () => { try { return readFileSync(join(stateDir, 'backend.log'), 'utf8'); } catch { return ''; } },
    stop: async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; } },
  };
}

export type Msg = { t: string; [k: string]: unknown };
export type Page = {
  ws: WebSocket; hello: Msg; frames: Msg[];
  send: (m: object) => void;
  // the first frame from `since` on (an index into frames) of type `t` that `ok` accepts
  next: (t: string, ok?: (m: Msg) => boolean, ms?: number, since?: number) => Promise<Msg>;
  close: () => Promise<void>;
};

// A page's socket: the token first, then every frame recorded from the hello on.
export async function connectPage(info: Pick<DaemonInfo, 'port' | 'token'>): Promise<Page> {
  const origin = `http://127.0.0.1:${info.port}`;
  const ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws`, { origin });
  const frames: Msg[] = [];
  ws.on('message', (d) => frames.push(JSON.parse(String(d))));
  await once(ws, 'open');
  ws.send(JSON.stringify({ t: 'auth', token: info.token }));
  const next: Page['next'] = async (t, ok = () => true, ms = 10_000, since = 0) => {
    const found = () => frames.slice(since).find((m) => m.t === t && ok(m));
    return waitFor(found, ms, `a ${t} frame`);
  };
  const hello = await next('hello');
  return {
    ws, hello, frames, next,
    send: (m) => ws.send(JSON.stringify(m)),
    close: async () => { if (ws.readyState === ws.CLOSED) return; const c = once(ws, 'close'); ws.close(); await c; },
  };
}

// GET or POST /api/<path> with the daemon's token.
export const api = (info: Pick<DaemonInfo, 'port' | 'token'>, path: string, init?: RequestInit) =>
  fetch(`http://127.0.0.1:${info.port}/api/${path}${path.includes('?') ? '&' : '?'}token=${info.token}`, init);
