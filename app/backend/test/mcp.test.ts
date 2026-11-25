// mcp.ts (R5.15): the panel's rows and actions over an injected SDK control and CLI runner; no real CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk';
import { Mcp, rowOf, sentence, TERMINAL_NOTE, NO_CONTROL } from '../src/mcp.ts';
import type { McpRunner, McpTarget } from '../src/mcp.ts';
import type { McpControl } from '../src/sdk.ts';

type Frame = { t: string; sid: string; servers: { name: string; status: string; busy: string | null; signIn: boolean; reconnect: boolean; kind: string }[]; error: string | null; note: string | null; reading: boolean };
const http = (name: string, status: McpServerStatus['status']): McpServerStatus => ({ name, status, scope: 'user', config: { type: 'http', url: 'https://example.test/mcp' } } as McpServerStatus);

// A process's control calls over a little state: reconnect connects a signed-in server, else it needs auth.
function fakeControl(list: McpServerStatus[], signedIn: Set<string>) {
  const calls: string[] = [];
  const control: McpControl = {
    mcpServerStatus: async () => list.map((s) => ({ ...s })),
    reconnectMcpServer: async (n) => { calls.push(`reconnect ${n}`); const s = list.find((x) => x.name === n); if (!s) throw new Error(`Server not found: ${n}`); s.status = signedIn.has(n) ? 'connected' : 'needs-auth'; },
    toggleMcpServer: async (n, on) => { calls.push(`toggle ${n} ${on}`); const s = list.find((x) => x.name === n)!; s.status = on ? 'connected' : 'disabled'; },
  };
  return { control, calls };
}
function setup(o: { list?: McpServerStatus[]; runner?: McpRunner; terminal?: boolean; own?: boolean } = {}) {
  const signedIn = new Set<string>();
  const list = o.list ?? [http('figma', 'needs-auth'), { name: 'synopia', status: 'connected', scope: 'dynamic', source: 'sdk' } as McpServerStatus];
  const { control, calls } = fakeControl(list, signedIn);
  const frames: Frame[] = [];
  const runs: { args: string[]; cwd: string; pty: boolean }[] = [];
  const runner: McpRunner = o.runner ?? (async (args, r) => { runs.push({ args, cwd: r.cwd, pty: r.pty }); if (args[1] === 'login') signedIn.add(args[2]); else signedIn.delete(args[2]); return { code: 0, stdout: '', stderr: '' }; });
  let probes = 0, closed = 0;
  const mcp = new Mcp({ runner, send: (m) => frames.push(m as Frame), settleMs: 2, probe: () => { probes++; return { control, close: () => { closed++; } }; } });
  const t: McpTarget = { id: 'S', cwd: '/work/app', terminal: o.terminal ?? false, control: () => (o.own ? control : null) };
  return { mcp, t, frames, runs, calls, list, last: () => frames.at(-1)!, probes: () => probes, closed: () => closed };
}

test('mcp: rows carry the kind, what can be signed in to and reconnected', () => {
  assert.deepEqual(rowOf(http('a', 'needs-auth')), { name: 'a', status: 'needs-auth', kind: 'http', scope: 'user', signIn: true, reconnect: true, busy: null });
  assert.equal(rowOf({ name: 's', status: 'connected', source: 'sdk' } as McpServerStatus).kind, 'sdk');
  assert.equal(rowOf({ name: 's', status: 'connected', source: 'sdk' } as McpServerStatus).reconnect, false); // MC-1: an SDK server can't be reconnected
  assert.equal(rowOf({ name: 'l', status: 'failed', config: { command: 'x' } } as McpServerStatus).signIn, false);
  assert.equal(rowOf(http('d', 'disabled')).reconnect, false); // MC-1: enable first
  assert.equal(rowOf({ name: 'c', status: 'connected', config: { type: 'claudeai-proxy', url: 'u', id: 'i' } } as McpServerStatus).signIn, true);
});

test('mcp: one sentence from what the CLI said', () => {
  assert.equal(sentence('Opening browser\nNo MCP server named "x". Run `claude mcp add` to add one.\n'), 'No MCP server named "x".');
  assert.equal(sentence('\x1b[31merror: refused\x1b[0m'), 'error: refused.');
  assert.equal(sentence(''), '');
  // a sign-in under a pty: carriage returns, an echoed ^D, the authorization URL; none of it reaches the panel
  assert.equal(sentence('^D\x04Starting…\r\nVisit: https://auth.example.test/authorize?state=x\r\nAuthentication failed: see https://example.test/help for more.\r\n'), 'Authentication failed: see  for more.');
});

test('mcp: list reads the status, through a probe when no process runs', async () => {
  const s = setup();
  await s.mcp.list(s.t);
  assert.equal(s.probes(), 1);
  assert.deepEqual(s.last().servers.map((r) => [r.name, r.status]), [['figma', 'needs-auth'], ['synopia', 'connected']]);
  assert.equal(s.last().reading, false);
  assert.equal(s.frames[0].reading, true); // the page shows it reads
  s.mcp.stop();
  assert.equal(s.closed(), 1);
});

test('mcp: the session\'s own process wins over a probe', async () => {
  const s = setup({ own: true });
  await s.mcp.list(s.t);
  assert.equal(s.probes(), 0);
});

test('mcp: sign in runs `claude mcp login <name>` in the session\'s folder, shows it busy, then reconnects', async () => {
  let release = () => {};
  const s = setup({ runner: (args, r) => new Promise((res) => { release = () => { res({ code: 0, stdout: '', stderr: '' }); }; assert.equal(r.cwd, '/work/app'); assert.deepEqual(args, ['mcp', 'login', 'figma']); assert.equal(r.pty, true); }) });
  await s.mcp.list(s.t);
  const p = s.mcp.act(s.t, 'figma', 'login');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(s.last().servers.find((r) => r.name === 'figma')?.busy, 'login');
  release();
  const r = await p;
  assert.deepEqual(r, { ok: true });
  assert.ok(s.calls.includes('reconnect figma'));
  assert.equal(s.last().servers.find((x) => x.name === 'figma')?.busy, null);
});

test('mcp: login then reconnect makes a needs-auth server connected; logout brings it back', async () => {
  const s = setup();
  await s.mcp.act(s.t, 'figma', 'login');
  assert.equal(s.last().servers.find((r) => r.name === 'figma')?.status, 'connected');
  assert.equal(s.last().error, null);
  await s.mcp.act(s.t, 'figma', 'logout');
  assert.deepEqual(s.runs.map((r) => r.args.join(' ')), ['mcp login figma', 'mcp logout figma']);
  assert.deepEqual(s.runs.map((r) => r.pty), [true, false]); // MC-2: login refuses a run with no TTY; logout needs none
  assert.equal(s.last().servers.find((r) => r.name === 'figma')?.status, 'needs-auth');
});

test('mcp: a failed sign-in is one sentence in the panel, the ack is ok', async () => {
  const s = setup({ runner: async () => ({ code: 1, stdout: '', stderr: 'Authentication failed: the server refused. Try again later.\n' }) });
  assert.deepEqual(await s.mcp.act(s.t, 'figma', 'login'), { ok: true });
  assert.equal(s.last().error, 'Sign-in to figma failed: Authentication failed: the server refused.');
  assert.ok(!s.calls.includes('reconnect figma'));
});

test('mcp: Cancel kills a waiting sign-in: no error, no reconnect, the row is free again', async () => {
  let aborted = false;
  const s = setup({ runner: (_args, r) => new Promise((res) => { r.signal.addEventListener('abort', () => { aborted = true; res({ code: null, stdout: '', stderr: '' }); }, { once: true }); }) });
  await s.mcp.list(s.t);
  assert.equal((await s.mcp.act(s.t, 'figma', 'cancel')).ok, false); // nothing runs yet
  const p = s.mcp.act(s.t, 'figma', 'login');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(s.last().servers.find((r) => r.name === 'figma')?.busy, 'login');
  assert.deepEqual(await s.mcp.act(s.t, 'figma', 'cancel'), { ok: true });
  assert.deepEqual(await p, { ok: true });
  assert.ok(aborted);
  assert.equal(s.last().error, null);
  assert.ok(!s.calls.includes('reconnect figma'));
  const fig = s.last().servers.find((r) => r.name === 'figma');
  assert.deepEqual([fig?.busy, fig?.status], [null, 'needs-auth']);
});

test('mcp: a sign-in that never finishes times out with its own sentence', async () => {
  const s = setup({ runner: async () => ({ code: null, stdout: '', stderr: '', timedOut: true }) });
  await s.mcp.act(s.t, 'figma', 'login');
  assert.match(s.last().error!, /^The sign-in to figma didn't finish within 5 minutes\.$/);
});

test('mcp: reconnect, disable and enable go to the control calls; their errors are sentences', async () => {
  const s = setup();
  await s.mcp.act(s.t, 'figma', 'disable');
  assert.equal(s.last().servers.find((r) => r.name === 'figma')?.status, 'disabled');
  await s.mcp.act(s.t, 'figma', 'enable');
  await s.mcp.act(s.t, 'nope', 'reconnect');
  assert.deepEqual(s.calls, ['toggle figma false', 'toggle figma true', 'reconnect nope']);
  assert.equal(s.last().error, 'Reconnecting nope failed: Server not found: nope.');
});

test('mcp: a terminal\'s session gets the note, and actions are refused', async () => {
  const s = setup({ terminal: true });
  await s.mcp.list(s.t);
  assert.equal(s.last().note, TERMINAL_NOTE);
  assert.equal(s.probes(), 0);
  assert.deepEqual(await s.mcp.act(s.t, 'figma', 'login'), { ok: false, error: TERMINAL_NOTE });
});

test('mcp: a second action on a busy server is refused; an unknown action too', async () => {
  let release = () => {};
  const s = setup({ runner: () => new Promise((res) => { release = () => res({ code: 0, stdout: '', stderr: '' }); }) });
  const p = s.mcp.act(s.t, 'figma', 'login');
  const r = await s.mcp.act(s.t, 'figma', 'logout');
  assert.equal(r.ok, false);
  release();
  await p;
  assert.equal((await s.mcp.act(s.t, 'figma', 'explode' as never)).ok, false);
});

test('mcp: a fresh source that answers with no servers yet is read again (MC-1); pending is read until it settles', async () => {
  const list = [http('figma', 'pending')];
  let reads = 0;
  const control: McpControl = {
    mcpServerStatus: async () => { reads++; if (reads === 1) return []; if (reads === 3) list[0].status = 'connected'; return list.map((x) => ({ ...x })); },
    reconnectMcpServer: async () => {}, toggleMcpServer: async () => {},
  };
  const frames: Frame[] = [];
  const mcp = new Mcp({ runner: async () => ({ code: 0, stdout: '', stderr: '' }), send: (m) => frames.push(m as Frame), settleMs: 2, probe: () => ({ control, close: () => {} }) });
  await mcp.list({ id: 'S', cwd: '/w', terminal: false, control: () => null });
  assert.equal(reads, 3);
  assert.equal(frames.at(-1)!.servers[0].status, 'connected');
  assert.ok(frames.some((f) => f.servers[0]?.status === 'pending'));
  mcp.stop();
});

test('mcp: no control calls at all: the panel says so', async () => {
  const frames: Frame[] = [];
  const mcp = new Mcp({ runner: async () => ({ code: 0, stdout: '', stderr: '' }), send: (m) => frames.push(m as Frame), settleMs: 2, probe: () => ({ control: null, close: () => {} }) });
  await mcp.list({ id: 'S', cwd: '/w', terminal: false, control: () => null });
  assert.equal(frames.at(-1)!.error, NO_CONTROL);
  mcp.stop();
});
