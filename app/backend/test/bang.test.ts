// Bash mode (R5.13): the run (cwd, env, cap, exit code, the kill on interrupt), the CLI's record
// shapes, and the delivery to the session as context that starts no turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bang, bashInput, bashOutput, parseBashInput, parseBashOutput, splitBash, BANG_CAP } from '../src/bang.ts';
import type { BangRun, BangOptions } from '../src/bang.ts';
import { plainText } from '../src/pty.ts';
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

test('bang: a spawn that throws ends the run after the constructor, never inside it', async () => {
  let inside = true;
  let done: BangRun | null = null;
  new Bang({ id: ID, cmd: 'echo \0x', cwd: tmp(), shell: '/bin/sh', onUpdate: () => {}, onDone: (r) => { assert.equal(inside, false, 'not from the constructor'); done = r; } });
  inside = false;
  await new Promise((r) => setTimeout(r, 10));
  assert.match((done as BangRun | null)?.error ?? '', /couldn't start/);
});

test('bang: the SIGKILL timer goes once the group is empty', async () => {
  let bang!: Bang;
  const done = new Promise<void>((resolve) => {
    bang = new Bang({ id: ID, cmd: 'sleep 30', cwd: tmp(), shell: '/bin/sh', killAfterMs: 60_000, onUpdate: () => {}, onDone: () => resolve() });
  });
  await new Promise((r) => setTimeout(r, 100));
  bang.kill();
  await done;
  assert.equal((bang as unknown as { killTimer: unknown }).killTimer, null, 'no SIGKILL armed for a group id that may be reused');
});

test('bang: the cap counts code points, never splits a pair, and the cut line names the cap', async () => {
  const { run: r } = await run(`printf '\\360\\237\\230\\200%.0s' 1 2 3 4 5`, { cap: 3 });
  assert.equal(r.out, '😀😀😀');
  assert.equal(r.cut, true);
  assert.equal(bashOutput({ out: 'x', err: '', cut: true, exit: 0 }, 3), '<bash-stdout>x</bash-stdout><bash-stderr>[Output cut at 3 characters]</bash-stderr>');
});

test('delivery: a command that cannot spawn toasts, and the daemon goes on', async () => {
  const { sessions, SID, got, last } = setup();
  assert.equal(sessions.get(SID)!.runBang('echo \0x').ok, true);
  await until(() => last()?.bang?.running === false);
  assert.match(String(got.find((m) => m.t === 'toast')?.text), /couldn't start/);
  assert.equal(sessions.get(SID)!.runBang('echo again').ok, true, 'the next command runs');
  await until(() => last()?.bang?.running === false);
  sessions.stop();
});

// A terminal for the run (R5.13, 2026-11-26): pty.ts, one pseudo-terminal from start to end.
test('bang: runs in a terminal: stdin and stdout are TTYs, stderr apart, a typed line and an empty Enter reach it, CRLF normalised', async () => {
  let bang!: Bang;
  const typed: string[] = [];
  const r = await new Promise<BangRun>((resolve) => {
    bang = new Bang({ id: ID, cmd: `[ -t 0 ] && echo tty0; [ -t 1 ] && echo tty1; echo err >&2; printf 'Name: '; read a; echo "got [$a]"; printf 'Press Enter: '; read b; echo "then [$b]"`, cwd: tmp(), shell: '/bin/sh', tickMs: 5,
      onUpdate: (run) => {
        if (run.out.includes('Name: ') && !typed.length) { typed.push('demo'); assert.equal(bang.input('demo'), true); }
        if (run.out.includes('Press Enter: ') && typed.length === 1) { typed.push(''); assert.equal(bang.input(''), true); }
      },
      onDone: (run) => resolve({ ...run }) });
  });
  assert.equal(r.exit, 0);
  assert.equal(r.err, 'err\n', 'stderr on its own pipe');
  assert.match(r.out, /^tty0\ntty1\n/);
  assert.match(r.out, /got \[demo\]\n/);
  assert.match(r.out, /then \[\]\n$/);
  assert.doesNotMatch(r.out, /\r/, 'the CRLF of the pty is LF');
  assert.equal(bang.input('late'), false, 'nothing to type into once it ended');
});

test('bang: Esc, Esc ends a command that waits for Enter (TERM to its group)', async () => {
  let bang!: Bang;
  const done = new Promise<BangRun>((resolve) => {
    bang = new Bang({ id: ID, cmd: `printf 'Press Enter: '; read x; echo never`, cwd: tmp(), shell: '/bin/sh', tickMs: 5, onUpdate: () => {}, onDone: (r) => resolve({ ...r }) });
  });
  await new Promise((r) => setTimeout(r, 300));
  bang.kill();
  const r = await done;
  assert.equal(r.interrupted, true);
  assert.equal(r.exit, 143);
  assert.doesNotMatch(r.out, /never/);
});

test('bang: quiet once it goes a while with no output, so the page offers the input line', async () => {
  const seen: boolean[] = [];
  const r = await new Promise<BangRun>((resolve) => {
    new Bang({ id: ID, cmd: 'echo a; sleep 0.4; echo b', cwd: tmp(), shell: '/bin/sh', tickMs: 5, quietMs: 150, onUpdate: (run) => seen.push(run.quiet), onDone: (run) => resolve({ ...run }) });
  });
  assert.equal(seen.includes(true), true);
  assert.equal(r.quiet, true, 'it stays set');
  assert.equal(r.out, 'a\nb\n');
});

test('pty plainText: CRLF as LF, escapes out, a rewritten line as it ended', () => {
  assert.equal(plainText('a\r\nb\x1b[31mc\x1b[0m\r\nprog 10%\rprog 99%\r\n\x1b]0;title\x07d'), 'a\nbc\nprog 99%\nd');
  assert.equal(plainText('half\r'), 'half', 'a CR at the end waits for what comes');
});

test('delivery: a line typed with no command running is refused', async () => {
  const { sessions, SID } = setup();
  const r = sessions.get(SID)!.bangInput('x');
  assert.equal(r.ok, false);
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

// The CLI joins the shouldQuery:false messages it holds into one record (docs/Claude Code transcripts.md,
// "Bash mode records"): the shape seen live, on invented text.
const ts0 = '2026-11-24T10:00:00.000Z', ts1 = '2026-11-24T10:01:00.000Z', ts2 = '2026-11-24T10:02:00.000Z';
const joined = (uuid: string, ts: string, content: string, merged: string[] = ['m-2']) =>
  ({ type: 'user', uuid, timestamp: ts, queueTranscriptOnly: true, mergedSendUuids: merged, promptSource: 'sdk', permissionMode: 'default', message: { role: 'user', content } });
const shape = (t: Transcript) => t.items.map((i) => [i.id, i.k, i.k === 'bang' ? i.cmd : i.text]);

test('splitBash: one record holds a command and its output, several commands, or the prompt after them', () => {
  assert.deepEqual(splitBash('<bash-input>open demo.html</bash-input>\n<bash-stdout></bash-stdout><bash-stderr></bash-stderr>'),
    { runs: [{ cmd: 'open demo.html', out: { out: '', err: '', cut: false, exit: null } }], rest: '' });
  assert.deepEqual(splitBash('<bash-input>a</bash-input>\n<bash-stdout>1\n</bash-stdout><bash-stderr>Exit code 1</bash-stderr>\n<bash-input>b</bash-input>\n<bash-stdout>2</bash-stdout><bash-stderr></bash-stderr>\nWhat now?'),
    { runs: [{ cmd: 'a', out: { out: '1\n', err: '', cut: false, exit: 1 } }, { cmd: 'b', out: { out: '2', err: '', cut: false, exit: null } }], rest: 'What now?' });
  assert.deepEqual(splitBash('<bash-input>ls</bash-input>'), { runs: [{ cmd: 'ls', out: null }], rest: '' });
  assert.deepEqual(splitBash('<bash-input>cat x</bash-input>\n<bash-stdout>a</bash-stdout>b</bash-stdout><bash-stderr></bash-stderr>'),
    { runs: [{ cmd: 'cat x', out: { out: 'a</bash-stdout>b', err: '', cut: false, exit: null } }], rest: '' }, 'an output holding the tag text is read whole');
  assert.equal(splitBash('Tidy the notes.'), null);
});

test('transcript: a command and its output in one record land as one bang item, in place', () => {
  const t = new Transcript({ home: '/Users/fixture' });
  t.pushAll([
    { type: 'user', uuid: 'p-1', timestamp: ts0, message: { role: 'user', content: 'Draft the notes.' } },
    { type: 'assistant', uuid: 'a-1', timestamp: ts0, message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'Drafted.' }] } },
    joined('b-1', ts1, '<bash-input>open demo.html</bash-input>\n<bash-stdout></bash-stdout><bash-stderr></bash-stderr>'),
    { type: 'user', uuid: 'p-2', timestamp: ts2, message: { role: 'user', content: 'Now the summary.' } },
  ]);
  assert.deepEqual(shape(t), [['p-1', 'you', 'Draft the notes.'], ['a-1:0', 'claude', 'Drafted.'], ['b-1', 'bang', 'open demo.html'], ['p-2', 'you', 'Now the summary.']]);
  assert.deepEqual(t.get('b-1')?.sh, { out: '', err: '', cut: false, exit: null });
});

test('transcript: two commands in a row, one with stdout, and the next prompt in the same record', () => {
  const t = new Transcript({ home: '/Users/fixture' });
  t.pushAll([joined('r-1', ts1, '<bash-input>echo one</bash-input>\n<bash-stdout>one\n</bash-stdout><bash-stderr></bash-stderr>\n<bash-input>false</bash-input>\n<bash-stdout></bash-stdout><bash-stderr>Exit code 1</bash-stderr>\nWhat did they print?', ['m-2', 'm-3', 'm-4'])]);
  assert.deepEqual(shape(t), [['r-1:bang0', 'bang', 'echo one'], ['r-1:bang1', 'bang', 'false'], ['r-1', 'you', 'What did they print?']]);
  assert.equal(t.get('r-1:bang0')?.sh?.out, 'one\n');
  assert.equal(t.get('r-1:bang1')?.sh?.exit, 1);
});

test('transcript: a command a running turn takes in comes as two queued_command attachments: one bang item, no queued prompt', () => {
  const t = new Transcript({ home: '/Users/fixture' });
  const queued = (uuid: string, prompt: string) => ({ type: 'attachment', uuid, timestamp: ts1, attachment: { type: 'queued_command', prompt, source_uuid: uuid, delivery_id: 'd-' + uuid, commandMode: 'prompt', timestamp: ts1 } });
  t.pushAll([
    { type: 'user', uuid: 'p-1', timestamp: ts0, message: { role: 'user', content: 'Draft the notes.' } },
    { type: 'assistant', uuid: 'a-1', timestamp: ts0, message: { id: 'msg-1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/tmp/x' } }] } },
    { type: 'user', uuid: 'r-1', timestamp: ts1, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'x' }] } },
    queued('q-1', '<bash-input>open demo.png</bash-input>'),
    queued('q-2', '<bash-stdout></bash-stdout><bash-stderr></bash-stderr>'),
    { type: 'assistant', uuid: 'a-2', timestamp: ts2, message: { id: 'msg-2', role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  ]);
  assert.deepEqual(t.items.filter((i) => i.k === 'you' || i.k === 'bang').map((i) => [i.id, i.k, i.queued]), [['p-1', 'you', undefined], ['q-1', 'bang', undefined]]);
  assert.deepEqual(t.get('q-1')?.sh, { out: '', err: '', cut: false, exit: null });
  const ids = t.items.map((i) => i.id);
  assert.ok(ids.indexOf('q-1') < ids.indexOf('a-2:0'), 'in place, before the reply after it');
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
  return { sessions, SID, cwd, inputs, q, got, last, transcripts, claudeDir };
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
  assert.deepEqual({ ...last()?.bang, at: 0, end: 0 }, { id: ID, cmd: 'echo hi; echo err >&2; exit 3', out: 'hi\n', err: 'err\n', cut: false, running: false, exit: 3, interrupted: false, at: 0, end: 0, quiet: false });
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

test('delivery: the shown run lands as the item of the one record the CLI joins it into, and leaves the end of the log', async () => {
  const { sessions, SID, cwd, inputs, last, transcripts, claudeDir } = setup();
  assert.equal(sessions.get(SID)!.runBang('echo hi', ID).ok, true);
  await until(() => inputs.length === 2 && last()?.bang?.running === false);
  const dir = path.join(claudeDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(dir, `${SID}.jsonl`), [
    { ...joined(ID, at, `${inputs[0].message.content}\n${inputs[1].message.content}`, [String(inputs[1].uuid)]), sessionId: SID, cwd },
    { type: 'user', uuid: 'p-next', timestamp: at, sessionId: SID, cwd, message: { role: 'user', content: 'What did it print?' } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  transcripts.poll();
  try { await until(() => last()?.bang?.landed === ID); } finally { sessions.stop(); }
  const items = transcripts.get(SID)!.items;
  assert.deepEqual(items.map((i) => [i.id, i.k]), [[ID, 'bang'], ['p-next', 'you']], 'in place, before the next prompt');
  assert.equal(items[0].sh?.out, 'hi\n');
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
