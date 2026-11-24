import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Tailer, SubagentWatcher, SLICE_BYTES } from '../src/tail.ts';
import type { JsonRecord } from '../src/tail.ts';
import { Transcript } from '../src/transcript.ts';

function tmp(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-tail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tailer(file: string, opts: { chunkBytes?: number } = {}) {
  const got: JsonRecord[] = [];
  let resets = 0;
  const tail = new Tailer(file, { onRecords: (r) => got.push(...r), onReset: () => resets++, pollMs: 0, watch: false, ...opts });
  return { tail, got, resets: () => resets };
}

const until = async (ok: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('a partial last line waits for its newline', (t) => {
  const file = path.join(tmp(t), 's.jsonl');
  fs.writeFileSync(file, '{"a":1}\n{"b":');
  const { tail, got } = tailer(file);
  tail.check();
  assert.deepEqual(got, [{ a: 1 }]);
  fs.appendFileSync(file, '2}\n');
  tail.check();
  assert.deepEqual(got, [{ a: 1 }, { b: 2 }]);
});

test('an append in two writes, and bad JSON lines skipped', (t) => {
  const file = path.join(tmp(t), 's.jsonl');
  fs.writeFileSync(file, '');
  const { tail, got } = tailer(file);
  assert.equal(tail.check(), false); // empty: nothing read
  fs.appendFileSync(file, '{"type":"user","n":');
  tail.check();
  assert.deepEqual(got, []);
  fs.appendFileSync(file, '1}\nnot json\n\n[1,2]\n{"n":2}\n');
  tail.check();
  assert.deepEqual(got, [{ type: 'user', n: 1 }, { n: 2 }]);
  assert.equal(tail.skipped, 2);
  assert.equal(tail.check(), false); // nothing new
});

test('truncation resets to 0', (t) => {
  const file = path.join(tmp(t), 's.jsonl');
  fs.writeFileSync(file, '{"n":1}\n{"n":2}\n');
  const { tail, got, resets } = tailer(file);
  tail.check();
  fs.writeFileSync(file, '{"n":9}\n');
  tail.check();
  assert.equal(resets(), 1);
  assert.deepEqual(got, [{ n: 1 }, { n: 2 }, { n: 9 }]);
  assert.equal(tail.offset, 8);
});

test('a new inode resets', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, '{"n":1}\n');
  const { tail, got, resets } = tailer(file);
  tail.check();
  fs.writeFileSync(path.join(dir, 'new'), '{"n":1}\n{"n":2}\n');
  fs.renameSync(path.join(dir, 'new'), file);
  tail.check();
  assert.equal(resets(), 1);
  assert.deepEqual(got, [{ n: 1 }, { n: 1 }, { n: 2 }]);
});

test('a rewrite to the same size resets (size plus mtime)', (t) => {
  const file = path.join(tmp(t), 's.jsonl');
  fs.writeFileSync(file, '{"n":1}\n');
  fs.utimesSync(file, 1000, 1000);
  const { tail, got, resets } = tailer(file);
  tail.check();
  fs.writeFileSync(file, '{"n":7}\n');
  fs.utimesSync(file, 2000, 2000);
  tail.check();
  assert.equal(resets(), 1);
  assert.deepEqual(got, [{ n: 1 }, { n: 7 }]);
});

test('a 60 KB line across small read chunks', (t) => {
  const file = path.join(tmp(t), 's.jsonl');
  const big = { type: 'assistant', text: 'é'.repeat(30_000) }; // 60 KB of UTF-8, split mid-character
  fs.writeFileSync(file, JSON.stringify(big) + '\n' + JSON.stringify({ n: 2 }) + '\n');
  const { tail, got } = tailer(file, { chunkBytes: 4095 });
  tail.check();
  assert.deepEqual(got, [big, { n: 2 }]);
});

test('fs.watch triggers a read without the poll', async (t) => {
  const file = path.join(tmp(t), 's.jsonl');
  fs.writeFileSync(file, '');
  const got: JsonRecord[] = [];
  const tail = new Tailer(file, { onRecords: (r) => got.push(...r), pollMs: 0 }).start();
  t.after(() => tail.stop());
  // macOS arms fs.watch asynchronously: an append right after start can land before the watcher
  // does (the poll covers that in real use). Let it settle so this test checks the watch path only.
  await new Promise((r) => setTimeout(r, 200));
  fs.appendFileSync(file, '{"n":1}\n');
  await until(() => got.length === 1, 5000);
});

test('the poll triggers a read without fs.watch, and picks up a file created later', async (t) => {
  const file = path.join(tmp(t), 's.jsonl');
  const got: JsonRecord[] = [];
  const tail = new Tailer(file, { onRecords: (r) => got.push(...r), pollMs: 20, watch: false }).start();
  t.after(() => tail.stop());
  fs.writeFileSync(file, '{"n":1}\n');
  await until(() => got.length === 1);
  fs.appendFileSync(file, '{"n":2}\n');
  await until(() => got.length === 2);
});

test('a subagents folder created later is picked up by the watcher', async (t) => {
  const dir = path.join(tmp(t), 'session');
  const seen: string[] = [];
  const w = new SubagentWatcher(dir, { onAgent: (id) => seen.push(id), onMeta: () => {} }, { pollMs: 50 }).start();
  t.after(() => w.stop());
  fs.mkdirSync(path.join(dir, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'subagents', 'agent-cccc.jsonl'), '');
  await until(() => seen.length === 1);
  assert.deepEqual(seen, ['cccc']);
});

test('first read of a 50 MB transcript takes under 2 s', (t) => {
  const file = path.join(tmp(t), 'big.jsonl');
  const fd = fs.openSync(file, 'w');
  const filler = 'made-up filler text for the timing test. '.repeat(300); // about 12 KB
  let size = 0;
  for (let i = 0; size < 50 * 1024 * 1024; i++) {
    const ts = new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString();
    const recs: JsonRecord[] = [
      { type: 'user', uuid: `u${i}`, timestamp: ts, message: { role: 'user', content: `prompt ${i}` } },
      // one content block per assistant record, as the CLI writes them
      {
        type: 'assistant', uuid: `a${i}`, timestamp: ts, requestedModel: 'm', effort: 'low',
        message: { id: `msg_${i}`, role: 'assistant', content: [{ type: 'text', text: filler }] },
      },
      {
        type: 'assistant', uuid: `b${i}`, timestamp: ts, requestedModel: 'm', effort: 'low',
        message: { id: `msg_${i}`, role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: 'ls', description: 'List' } }] },
      },
      {
        type: 'user', uuid: `r${i}`, timestamp: ts,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: i % 50 ? filler : filler.repeat(5) }] },
      },
    ];
    const chunk = recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
    fs.writeSync(fd, chunk);
    size += Buffer.byteLength(chunk);
  }
  fs.closeSync(fd);
  const start = performance.now();
  const tr = new Transcript({ home: '/Users/fixture' });
  const tail = new Tailer(file, { onRecords: (r) => tr.pushAll(r), pollMs: 0, watch: false });
  tail.check();
  const ms = performance.now() - start;
  assert.ok(tr.total > 4000, `items ${tr.total}`);
  assert.equal(tr.get(`t${10}`)?.state, 'done');
  assert.ok(ms < 2000, `first read took ${Math.round(ms)} ms`);
});

test('start reads a large backlog in slices, letting the event loop run between them (L7)', async (t) => {
  const file = path.join(tmp(t), 'big.jsonl');
  const line = JSON.stringify({ type: 'user', text: 'made-up filler '.repeat(200) }) + '\n';
  fs.writeFileSync(file, line.repeat(Math.ceil((SLICE_BYTES * 2.5) / line.length)));
  const size = fs.statSync(file).size;
  const { tail, got } = tailer(file);
  let ticked = false;
  setImmediate(() => (ticked = true));
  tail.start();
  assert.ok(tail.offset <= SLICE_BYTES + (4 << 20) && tail.offset < size, 'start returned after one slice');
  assert.equal(tail.catchingUp, true);
  assert.equal(tail.check(), false, 'a poll or watch event leaves it to the slices');
  await until(() => !tail.catchingUp);
  assert.ok(ticked, 'other callbacks ran in between');
  assert.equal(tail.offset, size);
  assert.equal(got.length, size / line.length);
  // a small file is read at once
  const small = path.join(tmp(t), 'small.jsonl');
  fs.writeFileSync(small, line.repeat(3));
  const s = tailer(small);
  s.tail.start();
  assert.equal(s.got.length, 3);
  assert.equal(s.tail.catchingUp, false);
});

test('the subagent watcher calls onScan after every scan, so its subagents need no timers (L6)', (t) => {
  const dir = path.join(tmp(t), 'session');
  fs.mkdirSync(path.join(dir, 'subagents'), { recursive: true });
  let scans = 0;
  const w = new SubagentWatcher(dir, { onAgent: () => {}, onMeta: () => {}, onScan: () => scans++ }, { pollMs: 0, watch: false });
  w.start();
  w.scan();
  assert.equal(scans, 2);
});

test('formats#B5: a bare touch (same bytes, new mtime) reads nothing and resets nothing', (t) => {
  const file = path.join(tmp(t), 's.jsonl');
  fs.writeFileSync(file, '{"n":1}\n{"n":2}\n');
  fs.utimesSync(file, 1000, 1000);
  const { tail, got, resets } = tailer(file);
  tail.check();
  fs.utimesSync(file, 2000, 2000);
  assert.equal(tail.check(), false);
  assert.equal(resets(), 0);
  assert.deepEqual(got, [{ n: 1 }, { n: 2 }]);
  fs.appendFileSync(file, '{"n":3}\n');
  tail.check();
  assert.deepEqual(got, [{ n: 1 }, { n: 2 }, { n: 3 }], 'an append after the touch reads on from the offset');
  // a same-size rewrite after the touch still resets
  fs.writeFileSync(file, '{"n":7}\n{"n":8}\n{"n":9}\n');
  fs.utimesSync(file, 3000, 3000);
  tail.check();
  assert.equal(resets(), 1);
  assert.deepEqual(got.slice(3), [{ n: 7 }, { n: 8 }, { n: 9 }]);
});

test('final-adapters#B2: a rewrite in place that grows resets; an append with the same start does not', (t) => {
  const file = path.join(tmp(t), 's.jsonl');
  fs.writeFileSync(file, '{"n":1,"plan":"old"}\n{"n":2}\n');
  const ino = fs.statSync(file).ino;
  const { tail, got, resets } = tailer(file);
  tail.check();
  fs.appendFileSync(file, '{"n":3}\n');
  tail.check();
  assert.equal(resets(), 0, 'an append is no rewrite');
  // the same inode, rewritten longer (a plan approval edits a record and the file goes on)
  fs.writeFileSync(file, '{"n":1,"plan":"new, longer"}\n{"n":2}\n{"n":3}\n{"n":4}\n');
  assert.equal(fs.statSync(file).ino, ino, 'rewritten in place');
  tail.check();
  assert.equal(resets(), 1);
  assert.deepEqual(got.slice(3), [{ n: 1, plan: 'new, longer' }, { n: 2 }, { n: 3 }, { n: 4 }], 'read again from the start, not mid-record');
});
