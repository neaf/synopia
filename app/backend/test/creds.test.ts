import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Creds, guessCommand, gitRoot, screenText, AGAIN_MS } from '../src/creds.ts';
import type { CredsFrame } from '../src/creds.ts';
import type { PtyEnd, PtyStart } from '../src/pty.ts';
import { shellPty } from '../src/pty.ts';

// A fake pty: each start is recorded; the test prints into it and ends it.
function harness(commands: Record<string, string> = {}, prefill = '') {
  const runs: { command: string; cwd: string; typed: string[]; print: (s: string) => void; end: (e: PtyEnd) => void }[] = [];
  const start: PtyStart = (command, o) => {
    let end!: (e: PtyEnd) => void;
    const done = new Promise<PtyEnd>((r) => { end = r; });
    const run = { command, cwd: o.cwd, typed: [] as string[], print: o.onData, end };
    runs.push(run);
    return { write: (t) => run.typed.push(t), kill: () => end({ code: null, timedOut: false }), done };
  };
  const frames: CredsFrame[] = [];
  const refreshing: [string[], boolean][] = [];
  const refreshed: string[][] = [];
  let clock = 1_000_000, saves = 0;
  const c = new Creds({
    start, commands, saved: () => saves++, prefill: async () => prefill, rootOf: async (cwd) => cwd.replace(/\/sub$/, ''),
    send: (f) => frames.push(f), refreshing: (sids, on) => refreshing.push([sids, on]),
    // the sessions' sign-in clears: their status says so (session.ts onSignedOut)
    refreshed: (sids) => { refreshed.push(sids); for (const sid of sids) void c.signedOut(sid, '/repo', false); },
    now: () => clock,
  });
  const tick = () => new Promise((r) => setImmediate(r));
  return { c, runs, frames, refreshing, refreshed, commands, saves: () => saves, tick, move: (ms: number) => { clock += ms; } };
}

test('creds: a saved command runs on an expiry, its output is shown live, input reaches it, exit 0 clears it', async () => {
  const h = harness({ '/repo': 'bin/aws-login' });
  await h.c.signedOut('s1', '/repo', true);
  assert.equal(h.runs.length, 1);
  assert.deepEqual([h.runs[0].command, h.runs[0].cwd], ['bin/aws-login', '/repo']);
  assert.deepEqual(h.refreshing.at(-1), [['s1'], true]);
  h.runs[0].print('Code: \x1b[1mABCD-1234\x1b[0m\r\nPress Enter: ');
  assert.equal(h.frames.at(-1)?.output, 'Code: ABCD-1234\nPress Enter: ');
  assert.equal(h.frames.at(-1)?.phase, 'running');
  assert.deepEqual(h.c.input('s1', 'yes'), { ok: true });
  assert.deepEqual(h.runs[0].typed, ['yes\n']);
  h.runs[0].end({ code: 0, timedOut: false });
  await h.tick();
  assert.deepEqual(h.refreshed, [['s1']]);
  assert.deepEqual(h.refreshing.at(-1), [['s1'], false]);
  assert.equal(h.frames.at(-1)?.phase, 'idle', 'nothing left to show');
  assert.equal(h.frames.at(-1)?.output, '');
});

test('creds: two sessions in one folder share one run', async () => {
  const h = harness({ '/repo': 'bin/aws-login' });
  await h.c.signedOut('s1', '/repo', true);
  await h.c.signedOut('s2', '/repo/sub', true);
  assert.equal(h.runs.length, 1, 'one run per folder');
  assert.deepEqual(h.refreshing.at(-1), [['s2'], true]);
  assert.deepEqual(h.frames.at(-1)?.sids, ['s1', 's2']);
  h.runs[0].end({ code: 0, timedOut: false });
  await h.tick();
  assert.deepEqual(h.refreshed, [['s1', 's2']]);
});

test('creds: a failure shows the editable line with the command and the sentence; it waits for Save', async () => {
  const h = harness({ '/repo': 'bin/aws-login' });
  await h.c.signedOut('s1', '/repo', true);
  h.runs[0].print('Error: no such profile\r\n');
  h.runs[0].end({ code: 1, timedOut: false });
  await h.tick();
  const f = h.frames.at(-1);
  assert.deepEqual([f?.phase, f?.command, f?.error, f?.output], ['failed', 'bin/aws-login', 'The refresh command ended with exit code 1: Error: no such profile.', '']);
  await h.c.signedOut('s2', '/repo', true);
  assert.equal(h.runs.length, 1, 'no run again on its own');
  assert.deepEqual(await h.c.save('s1', '/repo', 'aws sso login --profile dev'), { ok: true });
  assert.equal(h.commands['/repo'], 'aws sso login --profile dev');
  assert.equal(h.runs.length, 2, 'Save runs it at once');
  assert.equal(h.runs[1].command, 'aws sso login --profile dev');
});

test('creds: no command saved asks with the guess; Save stores and runs it; saving it empty clears it', async () => {
  const h = harness({}, 'bin/aws-login');
  await h.c.signedOut('s1', '/repo', true);
  assert.equal(h.runs.length, 0);
  assert.deepEqual([h.frames.at(-1)?.phase, h.frames.at(-1)?.command], ['ask', 'bin/aws-login']);
  await h.c.save('s1', '/repo', '  bin/aws-login ');
  assert.deepEqual([h.commands['/repo'], h.saves(), h.runs.length], ['bin/aws-login', 1, 1]);
  h.runs[0].end({ code: 0, timedOut: false });
  await h.tick();
  await h.c.save('s1', '/repo', '');
  assert.equal('/repo' in h.commands, false);
  assert.deepEqual([h.frames.at(-1)?.phase, h.frames.at(-1)?.command], ['ask', '']);
});

test('creds: an expiry right after a refresh that succeeded doesn\'t run it again (no loop); Cancel stops a run', async () => {
  const h = harness({ '/repo': 'bin/aws-login' });
  await h.c.signedOut('s1', '/repo', true);
  h.runs[0].end({ code: 0, timedOut: false });
  await h.tick();
  await h.c.signedOut('s1', '/repo', true);
  assert.equal(h.runs.length, 1);
  assert.deepEqual([h.frames.at(-1)?.phase, h.frames.at(-1)?.error], ['failed', 'The refresh command succeeded, but the credentials still fail.']);
  await h.c.signedOut('s1', '/repo', false);
  h.move(AGAIN_MS);
  await h.c.signedOut('s1', '/repo', true);
  assert.equal(h.runs.length, 2, 'a later expiry runs it');
  assert.deepEqual(h.c.cancel('s1'), { ok: true });
  await h.tick();
  assert.deepEqual([h.frames.at(-1)?.phase, h.frames.at(-1)?.error], ['failed', 'The refresh command was stopped.']);
  assert.deepEqual(h.c.input('s1', 'x'), { ok: false, error: 'No refresh command is running.' });
});

test('creds: the guess is awsAuthRefresh, then an executable bin/aws-login, then empty; the folder is the git root', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-creds-'));
  try {
    fs.mkdirSync(path.join(dir, '.git'));
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.mkdirSync(path.join(dir, 'app'));
    const none = async () => '';
    assert.equal(await guessCommand(dir, dir, none), '', 'nothing there');
    fs.writeFileSync(path.join(dir, 'bin/aws-login'), '#!/bin/sh\n', { mode: 0o644 });
    assert.equal(await guessCommand(dir, dir, none), '', 'not executable');
    fs.chmodSync(path.join(dir, 'bin/aws-login'), 0o755);
    assert.equal(await guessCommand(dir, dir, none), 'bin/aws-login');
    assert.equal(await guessCommand(dir, dir, async () => 'aws sso login --profile dev'), 'aws sso login --profile dev', 'the setting first');
    assert.equal(await gitRoot(path.join(dir, 'app')), dir);
    assert.equal(screenText('a\rb\r\nc\x1b]0;title\x07d^D'), 'b\ncd');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pty: one pseudo-terminal for the whole run: stdin is a TTY, a typed line reaches it, the exit code comes back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-pty-'));
  try {
    fs.writeFileSync(path.join(dir, 'login.sh'), '#!/bin/sh\n[ -t 0 ] && echo tty\necho "Code: ABCD-1234"\nprintf "Press Enter: "\nread line\necho "got $line"\nexit 3\n', { mode: 0o755 });
    let out = '';
    const run = shellPty('./login.sh', { cwd: dir, shell: '/bin/sh', timeoutMs: 10_000, onData: (t) => { out += t; if (out.includes('Press Enter') && !out.includes('typed')) { out += '(typed)'; run.write('yes\n'); } } });
    const end = await run.done;
    assert.equal(end.code, 3);
    assert.match(out, /tty\r?\nCode: ABCD-1234/);
    assert.match(out, /got yes/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
