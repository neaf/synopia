// Bash mode (R5.13): the run (cwd, env, cap, exit code, the kill on interrupt), the CLI's record
// shapes, and the delivery to the session as context that starts no turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bang, bashInput, bashOutput, parseBashInput, parseBashOutput, BANG_CAP } from '../src/bang.ts';
import type { BangRun, BangOptions } from '../src/bang.ts';
import { Transcript } from '../src/transcript.ts';
import { Transcripts } from '../src/transcripts.ts';
import { Publisher } from '../src/publisher.ts';
import { Sessions } from '../src/sessions.ts';
import { openStore } from '../src/store.ts';
import { emit, fakeQuery } from './support/fake-query.ts';
import type { Client } from '../src/server.ts';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-bang-')));
const ID = '0b0b0b0b-1111-4222-8333-444444444444';

function run(cmd: string, o: Partial<BangOptions> = {}): Promise<{ run: BangRun }> {
  return new Promise((resolve) => {
    new Bang({ id: ID, cmd, cwd: o.cwd ?? tmp(), shell: '/bin/sh', tickMs: 5, ...o, onUpdate: () => {}, onDone: (r) => resolve({ run: { ...r } }) });
  });
}

test('bang: runs in the folder with the given env, stdout and stderr apart, the exit code', async () => {
  const cwd = tmp();
  const { run: r } = await run('pwd; echo "v=$SYNOPIA_BANG_T"; echo hi; echo err >&2; exit 3', { cwd, env: { ...process.env, SYNOPIA_BANG_T: 'made-up' } });
  assert.equal(r.out, `${cwd}\nv=made-up\nhi\n`);
  assert.equal(r.err, 'err\n');
  assert.equal(r.exit, 3);
  assert.equal(r.running, false);
  assert.equal(r.interrupted, false);
  assert.equal(r.cut, false);
});

test('bang: the command is one argument of $SHELL -c, never interpolated', async () => {
  const { run: r } = await run(`printf '%s\\n' "a'b" '$HOME'`);
  assert.equal(r.out, "a'b\n$HOME\n");
  assert.equal(r.exit, 0);
});

test('bang: $SHELL from the env when no shell is given', async () => {
  const { run: r } = await run('echo $0', { shell: undefined, env: { ...process.env, SHELL: '/bin/sh' } });
  assert.equal(r.out.trim(), '/bin/sh');
});

test('bang: output past the cap is cut at 30,000 characters together', async () => {
  assert.equal(BANG_CAP, 30_000);
  const { run: r } = await run('yes abcdefghi | head -c 50000; yes e | head -c 100 >&2');
  assert.equal(r.out.length + r.err.length, BANG_CAP);
  assert.equal(r.cut, true);
  const small = await run('yes x | head -c 400', { cap: 100 });
  assert.equal(small.run.out.length, 100);
});

test('bang: kill ends the whole group (TERM), and KILL follows for what ignores TERM', async () => {
  const dir = tmp();
  let bang!: Bang;
  const done = new Promise<BangRun>((resolve) => {
    bang = new Bang({ id: ID, cmd: `echo $$ > pid; sleep 30 & echo $! > child; wait`, cwd: dir, shell: '/bin/sh', onUpdate: () => {}, onDone: (r) => resolve({ ...r }) });
  });
  await new Promise((r) => setTimeout(r, 200));
  const child = Number(fs.readFileSync(path.join(dir, 'child'), 'utf8'));
  bang.kill();
  const r = await done;
  assert.equal(r.interrupted, true);
  assert.equal(r.exit, 143, '128 + SIGTERM');
  await new Promise((res) => setTimeout(res, 100));
  assert.throws(() => process.kill(child, 0), 'its background child went with the group');

  const dir2 = tmp();
  let b2!: Bang;
  const t0 = Date.now();
  const done2 = new Promise<BangRun>((resolve) => {
    b2 = new Bang({ id: ID, cmd: `trap '' TERM; echo ready; while :; do sleep 0.05; done`, cwd: dir2, shell: '/bin/sh', killAfterMs: 300, onUpdate: () => {}, onDone: (r) => resolve({ ...r }) });
  });
  await new Promise((r) => setTimeout(r, 200));
  b2.kill();
  const r2 = await done2;
  assert.equal(r2.exit, 137, '128 + SIGKILL');
  assert.ok(Date.now() - t0 >= 450, 'after the KILL delay');
});

test('bang: a folder that is gone fails to start', async () => {
  const { run: r } = await run('echo x', { cwd: path.join(tmp(), 'gone') });
  assert.match(r.error ?? '', /couldn't start/);
});

test('bang: a spawn that throws ends the run after the constructor, never inside it (sessions-sdk#B3)', async () => {
  let inside = true;
  let done: BangRun | null = null;
  new Bang({ id: ID, cmd: 'echo \0x', cwd: tmp(), shell: '/bin/sh', onUpdate: () => {}, onDone: (r) => { assert.equal(inside, false, 'not from the constructor'); done = r; } });
  inside = false;
  await new Promise((r) => setTimeout(r, 10));
  assert.match((done as BangRun | null)?.error ?? '', /couldn't start/);
});

test('bang: the SIGKILL timer goes once the group is empty (sessions-sdk#B4)', async () => {
  let bang!: Bang;
  const done = new Promise<void>((resolve) => {
    bang = new Bang({ id: ID, cmd: 'sleep 30', cwd: tmp(), shell: '/bin/sh', killAfterMs: 60_000, onUpdate: () => {}, onDone: () => resolve() });
  });
  await new Promise((r) => setTimeout(r, 100));
  bang.kill();
  await done;
  assert.equal((bang as unknown as { killTimer: unknown }).killTimer, null, 'no SIGKILL armed for a group id that may be reused');
});

test('bang: the cap counts code points, never splits a pair, and the cut line names the cap (sessions-sdk#B5)', async () => {
  const { run: r } = await run(`printf '\\360\\237\\230\\200%.0s' 1 2 3 4 5`, { cap: 3 });
  assert.equal(r.out, '😀😀😀');
  assert.equal(r.cut, true);
  assert.equal(bashOutput({ out: 'x', err: '', cut: true, exit: 0 }, 3), '<bash-stdout>x</bash-stdout><bash-stderr>[Output cut at 3 characters]</bash-stderr>');
});

test('delivery: a command that cannot spawn toasts, and the daemon goes on (sessions-sdk#B3)', async () => {
  const { sessions, SID, got, last } = setup();
  assert.equal(sessions.get(SID)!.runBang('echo \0x').ok, true);
  await until(() => last()?.bang?.running === false);
  assert.match(String(got.find((m) => m.t === 'toast')?.text), /couldn't start/);
  assert.equal(sessions.get(SID)!.runBang('echo again').ok, true, 'the next command runs');
  await until(() => last()?.bang?.running === false);
  sessions.stop();
});

test('bang format: the CLI tags, the exit and cut lines, and back', () => {
  assert.equal(bashInput('ls -la'), '<bash-input>ls -la</bash-input>');
  const text = bashOutput({ out: 'hi\n', err: 'err\n', cut: false, exit: 3 });
  assert.equal(text, '<bash-stdout>hi\n</bash-stdout><bash-stderr>err\nExit code 3</bash-stderr>');
  assert.deepEqual(parseBashOutput(text), { out: 'hi\n', err: 'err', cut: false, exit: 3 });
  assert.deepEqual(parseBashOutput('<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>'), { out: 'ok', err: '', cut: false, exit: null });
  const cut = bashOutput({ out: 'x', err: '', cut: true, exit: 0 });
  assert.equal(cut, '<bash-stdout>x</bash-stdout><bash-stderr>[Output cut at 30,000 characters]</bash-stderr>');
  assert.deepEqual(parseBashOutput(cut), { out: 'x', err: '', cut: true, exit: null });
  assert.equal(parseBashInput('<bash-input>echo a</bash-input>'), 'echo a');
  assert.equal(parseBashInput('echo a'), null);
  assert.equal(parseBashOutput('<bash-stdout>x'), null);
});

test('transcript: the CLI records of bash mode make one bang item, no prompt and no turn', () => {
  const t = new Transcript({ home: '/Users/fixture' });
  const ts = '2026-11-24T10:00:00.000Z';
  t.pushAll([
    { type: 'user', uuid: 'b-u1', timestamp: ts, message: { role: 'user', content: '<bash-input>echo made-up</bash-input>' } },
    { type: 'user', uuid: 'b-u2', parentUuid: 'b-u1', timestamp: ts, message: { role: 'user', content: [{ type: 'text', text: '<bash-stdout>made-up\n</bash-stdout><bash-stderr>warn\nExit code 2</bash-stderr>' }] } },
  ]);
  assert.deepEqual(t.items.map((i) => [i.id, i.k]), [['b-u1', 'bang']]);
  const it = t.get('b-u1');
  assert.equal(it?.cmd, 'echo made-up');
  assert.deepEqual(it?.sh, { out: 'made-up\n', err: 'warn', cut: false, exit: 2 });
  assert.equal(t.turnRunning(Date.parse(ts) + 1000, 60_000), false, 'bash mode starts no turn');
});

// ---------- the delivery: two shouldQuery:false user messages in the CLI's format ----------
function setup() {
  const root = tmp();
  const claudeDir = path.join(root, 'claude');
  const cwd = path.join(root, 'scratch');
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const got: { t: string; [k: string]: unknown }[] = [];
  const c: Client = { send: (m) => got.push(JSON.parse(JSON.stringify(m))), close: () => {} };
  const store = openStore(path.join(root, 'state'), { minIntervalMs: 0 });
  const SID = '0c0c0c0c-1111-4222-8333-444444444444';
  store.state.open.push({ id: SID, cwd, openedAt: 1, closedAt: null });
  const transcripts = new Transcripts({ claudeDir, home: root, pollMs: 0, watch: false });
  const publisher = new Publisher({ transcripts, clients: () => new Set([c]), home: root, recheckMs: 0 });
  const inputs: SDKUserMessage[] = [];
  const q = fakeQuery({ onInput: (_, m) => { inputs.push(m); } });
  const sessions = new Sessions({ store, transcripts, publisher, sdk: q.sdk, home: root });
  sessions.start();
  const last = () => [...got].reverse().find((m) => m.t === 'session' && m.id === SID) as { state: { status: string }; bang: (BangRun & { landed?: string }) | null } | undefined;
  return { sessions, SID, cwd, inputs, q, got, last };
}
const until = async (fn: () => boolean, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };

test('delivery: the command and its output go as shouldQuery:false user messages, and no turn starts', async () => {
  const { sessions, SID, inputs, q, last } = setup();
  const r = sessions.get(SID)!.runBang('echo hi; echo err >&2; exit 3', ID);
  assert.equal(r.ok, true);
  assert.equal(last()?.bang?.running, true, 'the page sees it running');
  await until(() => inputs.length === 2);
  assert.deepEqual(inputs.map((m) => [m.message.content, m.shouldQuery, m.parent_tool_use_id]), [
    ['<bash-input>echo hi; echo err >&2; exit 3</bash-input>', false, null],
    ['<bash-stdout>hi\n</bash-stdout><bash-stderr>err\nExit code 3</bash-stderr>', false, null],
  ]);
  assert.equal(inputs[0].uuid, ID, 'the input record carries the run id, so it lands in place');
  assert.deepEqual({ ...last()?.bang, at: 0 }, { id: ID, cmd: 'echo hi; echo err >&2; exit 3', out: 'hi\n', err: 'err\n', cut: false, running: false, exit: 3, interrupted: false, at: 0 });
  // A process started only for this: its init starts no turn.
  emit(q.calls[0], { type: 'system', subtype: 'init', session_id: SID });
  await new Promise((r) => setTimeout(r, 20));
  assert.notEqual(last()?.state.status, 'busy');
  // The next message goes as usual and starts the turn.
  assert.equal(sessions.get(SID)!.send('what did it print?').ok, true);
  await until(() => inputs.length === 3);
  assert.equal(inputs[2].shouldQuery, undefined);
  assert.equal(last()?.state.status, 'busy');
  sessions.stop();
});

test('delivery: one command at a time, Esc, Esc ends it, not in a session a terminal holds', async () => {
  const { sessions, SID, inputs, last } = setup();
  assert.equal(sessions.get(SID)!.runBang('sleep 30').ok, true);
  const second = sessions.get(SID)!.runBang('echo again');
  assert.equal(second.ok, false);
  assert.match((second as { error: string }).error, /still running/);
  await sessions.get(SID)!.interrupt();
  await until(() => last()?.bang?.running === false);
  assert.equal(last()?.bang?.interrupted, true);
  assert.equal(last()?.bang?.exit, 143);
  await until(() => inputs.length === 2);
  assert.match(String(inputs[1].message.content), /<bash-stderr>Interrupted by the user, exit code 143<\/bash-stderr>$/);
  assert.deepEqual(parseBashOutput(String(inputs[1].message.content)), { out: '', err: '', cut: false, exit: 143, interrupted: true });
  assert.equal(sessions.get(SID)!.runBang('  ').ok, false);
  sessions.stop();
});
