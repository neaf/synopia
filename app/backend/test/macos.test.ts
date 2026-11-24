import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { alive, descendsFrom, parentOf, procStart, ps, sameStart, ttyOf } from '../src/macos.ts';

// A stand-in for /bin/ps: a shell script that prints `out`, exits `code`, or hangs.
function fakePs(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-ps-'));
  const bin = path.join(dir, 'ps');
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return bin;
}
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid as number;

test('ps: this process has a start time in the C locale, a single-digit day padded', async () => {
  const s = await procStart(process.pid);
  assert.match(s ?? '', /^\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}$/);
  const padded = fakePs('echo "Wed Nov  4 10:00:00 2026"');
  assert.equal(await procStart(1, { bin: padded }), 'Wed Nov  4 10:00:00 2026', 'kept as printed');
  assert.equal(sameStart('Wed Nov  4 10:00:00 2026', 'Wed Nov 4 10:00:00 2026'), true, 'spacing aside');
  assert.equal(sameStart('Wed Nov  4 10:00:00 2026', 'Wed Nov  4 11:00:00 2026'), false);
  assert.equal(sameStart('', ''), false, 'an empty start never matches');
});

test('ps: no such process is empty, a failure is null', async () => {
  assert.equal(await procStart(deadPid()), '');
  assert.equal(await ttyOf(deadPid()), '');
  assert.equal(await parentOf(deadPid()), 0);
  assert.equal(await ps('lstart', 1, { bin: fakePs('sleep 5'), timeoutMs: 100 }), null, 'a timeout');
  assert.equal(await ps('lstart', 1, { bin: path.join(os.tmpdir(), 'synopia-no-such-ps') }), null, 'no binary');
  assert.equal(await ps('lstart', 1, { bin: fakePs('echo oops >&2; exit 2') }), null, 'another exit code');
  assert.equal(await parentOf(1, { bin: fakePs('sleep 5'), timeoutMs: 100 }), null);
});

test('ps: tty and parent of this process', async () => {
  assert.equal(await parentOf(process.pid), process.ppid);
  assert.equal(typeof await ttyOf(process.pid), 'string');
  assert.equal(await ttyOf(1, { bin: fakePs('echo "??"') }), '??');
});

test('alive: this process yes, a finished one and bad pids no', () => {
  assert.equal(alive(process.pid), true);
  assert.equal(alive(deadPid()), false);
  assert.equal(alive(0), false);
  assert.equal(alive(-1), false);
  assert.equal(alive(1.5), false);
});

test('descendsFrom: walks parents, at most depth, null when a step fails', async () => {
  const parents = new Map([[40, 30], [30, 20], [20, 10], [10, 1]]);
  const parent = async (p: number) => parents.get(p) ?? 0;
  assert.equal(await descendsFrom(40, 20, 8, parent), true);
  assert.equal(await descendsFrom(40, 40, 8, parent), true, 'itself');
  assert.equal(await descendsFrom(40, 99, 8, parent), false);
  assert.equal(await descendsFrom(40, 10, 2, parent), false, 'beyond the depth');
  assert.equal(await descendsFrom(40, 10, 8, async (p) => (p === 30 ? null : parents.get(p) ?? 0)), null);
});
