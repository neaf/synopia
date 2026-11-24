// One session's state machine (session.ts): the states a process goes through, the start check, the
// end at quit, an id swap onto an open id, the total image size, and the one model resolver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transcripts } from '../src/transcripts.ts';
import { Publisher } from '../src/publisher.ts';
import { Sessions } from '../src/sessions.ts';
import { resolveModel } from '../src/session.ts';
import type { TerminalSource } from '../src/session.ts';
import type { Terminal } from '../src/cli-terminals.ts';
import { MAX_TOTAL_IMAGE_BYTES, imageError } from '../src/sdk.ts';
import { emit, fakeQuery } from './support/fake-query.ts';
import { openStore } from '../src/store.ts';
import type { Client } from '../src/server.ts';

type Msg = { t: string; [k: string]: unknown };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const SID = '11111111-2222-4333-8444-555555555555';
const OTHER = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const RESULT = { type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed' };
const term = (pid = 777): Terminal => ({ pid, sessionId: SID, procStart: 'Tue Nov 24 10:02:03 2026', cwd: '/tmp/x', status: 'busy', statusUpdatedAt: 1 });

// `confirm`: the start check's answer, resolved by the test.
function setup(o: { idleMs?: number; open?: string[]; confirm?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-session-'));
  const claudeDir = path.join(root, 'claude');
  const cwd = path.join(root, 'scratch');
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const got: Msg[] = [];
  const c: Client = { send: (m) => got.push(JSON.parse(JSON.stringify(m))), close: () => {} };
  const store = openStore(path.join(root, 'state'), { minIntervalMs: 0 });
  for (const id of o.open ?? [SID]) store.state.open.push({ id, cwd, openedAt: 1, closedAt: null });
  const transcripts = new Transcripts({ claudeDir, home: root, pollMs: 0, watch: false });
  const publisher = new Publisher({ transcripts, clients: () => new Set([c]), home: root, recheckMs: 0 });
  const q = fakeQuery();
  const logs: string[] = [];
  const checks: ((t: Terminal | null) => void)[] = [];
  const registry: TerminalSource = {
    holder: () => null,
    recheck: () => null,
    onChange: () => {},
    end: async () => true,
    ...(o.confirm ? { confirm: () => new Promise<Terminal | null>((r) => checks.push(r)) } : {}),
  };
  const sessions = new Sessions({ store, transcripts, publisher, sdk: q.sdk, home: root, idleMs: o.idleMs, registry, log: (e) => logs.push(e) });
  sessions.start();
  const take = (t: string) => { const out = got.filter((m) => m.t === t); for (const m of out) got.splice(got.indexOf(m), 1); return out; };
  const last = () => [...got].reverse().find((m) => m.t === 'session' && m.id === SID) as { state: { status: string; detail: Record<string, unknown> } } | undefined;
  return { sessions, store, transcripts, publisher, q, logs, checks, take, last, s: () => sessions.get(SID)! };
}

test('session: idle, running, ending at the idle end, idle at the exit, then running again', async () => {
  const t = setup({ idleMs: 30 });
  assert.equal(t.s().phase, 'idle');
  t.sessions.send(SID, 'one');
  assert.equal(t.s().phase, 'running');
  emit(t.q.calls[0], RESULT);
  await tick(60);
  assert.equal(t.q.calls[0].out.ended, true, 'the idle end closed its input');
  await tick();
  assert.equal(t.s().phase, 'idle');
  t.sessions.send(SID, 'two');
  assert.equal(t.s().phase, 'running');
  assert.equal(t.q.calls.length, 2);
  assert.equal(t.q.calls[1].options.resume, SID);
  t.sessions.stop();
});

test('session: the start check runs first; messages wait in starting, then go in order (FR-SES-11)', async () => {
  const t = setup({ confirm: true });
  assert.equal(t.sessions.send(SID, 'one').ok, true);
  assert.equal(t.sessions.send(SID, 'two').ok, true);
  assert.equal(t.s().phase, 'starting');
  assert.equal(t.q.calls.length, 0, 'no process before the check answers');
  t.checks[0](null);
  await tick();
  assert.equal(t.s().phase, 'running');
  assert.equal(t.q.calls.length, 1);
  assert.deepEqual(t.q.calls[0].inputs.map((m) => m.message.content), ['one', 'two']);
  assert.equal(t.last()?.state.status, 'busy');
  t.sessions.stop();
});

test('session: a terminal the start check finds keeps the messages in the box, read-only, with a toast', async () => {
  const t = setup({ confirm: true });
  t.take('restore');
  t.sessions.send(SID, 'hello');
  t.checks[0](term(4321));
  await tick();
  assert.equal(t.q.calls.length, 0, 'one writer: no process');
  assert.equal(t.s().phase, 'yielded');
  assert.deepEqual(t.take('restore').map((m) => m.texts), [['hello']]);
  assert.match(String(t.take('toast')[0]?.text), /terminal holds this session \(pid 4321\)/);
  assert.equal(t.last()?.state.detail.terminal, 4321);
});

test('session: a close while the start check runs starts nothing', async () => {
  const t = setup({ confirm: true });
  t.sessions.send(SID, 'hello');
  t.sessions.close(SID);
  t.checks[0](null);
  await tick();
  assert.equal(t.q.calls.length, 0);
});

test('session: after quit a process exit runs nothing: no toast, no next process (sessions-sdk#B10)', async () => {
  const t = setup({ idleMs: 30 });
  t.sessions.send(SID, 'one');
  t.q.calls[0].exitDelay = 50; // the process takes a while to go after its input closes
  emit(t.q.calls[0], RESULT);
  await tick(45);
  assert.equal(t.s().phase, 'ending');
  t.sessions.send(SID, 'for the next process');
  t.take('toast');
  t.sessions.stop();
  await tick(80);
  assert.equal(t.q.calls.length, 1, 'the queued message starts no process during the quit');
  assert.equal(t.take('toast').length, 0);
  assert.notEqual(t.last()?.state.status, 'failed');
});

test('session: an id swap onto another open session is refused, logged and toasted (sessions-sdk#B6)', async () => {
  const t = setup({ open: [SID, OTHER] });
  t.sessions.send(SID, 'hello');
  emit(t.q.calls[0], { type: 'conversation_reset', new_conversation_id: OTHER });
  await tick();
  assert.ok(t.logs.includes('sessions.swapRefused'));
  assert.match(String(t.take('toast')[0]?.text), /another open session/);
  assert.equal(t.s().id, SID, 'it keeps its id');
  assert.equal(t.sessions.resolve(SID), SID);
  t.sessions.stop();
});

test('session: images over 20 MB together are refused with a reason, below the 32 MB frame (seams#B2)', () => {
  const four = 'A'.repeat(Math.floor((4.5 * 1048576) / 3) * 4); // 4.5 MB of base64 data
  const five = Array.from({ length: 5 }, () => ({ mediaType: 'image/png', data: four }));
  assert.ok(MAX_TOTAL_IMAGE_BYTES * 4 / 3 < 32 * 1048576, 'the base64 frame stays under the socket cap');
  assert.equal(imageError(five.slice(0, 4)), null, '18 MB is fine');
  assert.match(String(imageError(five)), /23 MB together, over 20 MB/);
  const t = setup();
  const r = t.sessions.send(SID, 'look', five);
  assert.equal(r.ok, false);
  assert.equal(t.q.calls.length, 0);
});

test('model: one resolver for the header and the process', () => {
  assert.deepEqual(resolveModel({ model: 'opus', effort: 'high' }, { model: 'haiku', effort: 'low' }, 'sonnet'), { model: 'opus', effort: 'high' });
  assert.deepEqual(resolveModel({ model: 'default' }, { model: 'haiku', effort: 'low' }), { model: 'default', effort: null }, 'a choice wins whole');
  assert.deepEqual(resolveModel(null, { model: 'haiku', effort: 'low' }, 'sonnet'), { model: 'haiku', effort: 'low' });
  assert.deepEqual(resolveModel(undefined, { model: null, effort: null }, 'sonnet'), { model: 'sonnet', effort: null });
  assert.deepEqual(resolveModel(undefined, { model: null, effort: null }), { model: null, effort: null });
});

test('close: the session rules go, so a reopened session asks again (sessions-sdk#B1, Q6)', async () => {
  const t = setup();
  t.store.state.rules[SID] = ['Read(//tmp/**)'];
  t.sessions.send(SID, 'hello');
  assert.deepEqual(t.q.calls[0].options.allowedTools, ['Read(//tmp/**)'], 'for this session');
  t.sessions.close(SID);
  assert.equal(SID in t.store.state.rules, false);
});
