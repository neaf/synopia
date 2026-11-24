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
import { Views } from '../src/views.ts';
import { Sessions } from '../src/sessions.ts';
import { openStore } from '../src/store.ts';
import type { QueryFn } from '../src/driver.ts';
import type { Client } from '../src/server.ts';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

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
function channel<T>() {
  const buf: T[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  return {
    push(m: T) { buf.push(m); wake?.(); wake = null; },
    end() { done = true; wake?.(); wake = null; },
    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
      while (true) {
        while (buf.length) yield buf.shift() as T;
        if (done) return;
        await new Promise<void>((r) => (wake = r));
      }
    },
  };
}

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
  const views = new Views({ claudeDir, clients: () => new Set([c]), home: root, pollMs: 0, watch: false });
  const inputs: SDKUserMessage[] = [];
  const outs: ReturnType<typeof channel<SDKMessage>>[] = [];
  const fn: QueryFn = ({ prompt }) => {
    const out = channel<SDKMessage>();
    outs.push(out);
    void (async () => { for await (const m of prompt) inputs.push(m); })();
    return Object.assign(out, { close: () => out.end(), interrupt: async () => ({ still_queued: [] }) });
  };
  const sessions = new Sessions({ store, views, queryFn: fn, listFn: async () => [], home: root });
  sessions.start();
  const last = () => [...got].reverse().find((m) => m.t === 'session' && m.id === SID) as { status: string; bang: (BangRun & { landed?: string }) | null } | undefined;
  return { sessions, SID, cwd, inputs, outs, got, last };
}
const until = async (fn: () => boolean, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };

test('delivery: the command and its output go as shouldQuery:false user messages, and no turn starts', async () => {
  const { sessions, SID, inputs, outs, last } = setup();
  const r = sessions.bang(SID, 'echo hi; echo err >&2; exit 3', ID);
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
  outs[0].push({ type: 'system', subtype: 'init', session_id: SID } as unknown as SDKMessage);
  await new Promise((r) => setTimeout(r, 20));
  assert.notEqual(last()?.status, 'busy');
  // The next message goes as usual and starts the turn.
  assert.equal(sessions.send(SID, 'what did it print?').ok, true);
  await until(() => inputs.length === 3);
  assert.equal(inputs[2].shouldQuery, undefined);
  assert.equal(last()?.status, 'busy');
  sessions.stop();
});

test('delivery: one command at a time, Esc, Esc ends it, not in a session a terminal holds', async () => {
  const { sessions, SID, inputs, last } = setup();
  assert.equal(sessions.bang(SID, 'sleep 30').ok, true);
  const second = sessions.bang(SID, 'echo again');
  assert.equal(second.ok, false);
  assert.match((second as { error: string }).error, /still running/);
  await sessions.interrupt(SID);
  await until(() => last()?.bang?.running === false);
  assert.equal(last()?.bang?.interrupted, true);
  assert.equal(last()?.bang?.exit, 143);
  await until(() => inputs.length === 2);
  assert.match(String(inputs[1].message.content), /<bash-stderr>Interrupted by the user, exit code 143<\/bash-stderr>$/);
  assert.deepEqual(parseBashOutput(String(inputs[1].message.content)), { out: '', err: '', cut: false, exit: 143, interrupted: true });
  assert.equal(sessions.bang(SID, '  ').ok, false);
  sessions.stop();
});
