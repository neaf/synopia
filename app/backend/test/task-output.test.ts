// Task output (R7.2): byte windows of a shell's output file in whole lines and whole characters, and a
// monitor's events cut the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readOutput, outputTail, outputBefore, outputSize, eventTail, eventsFrom, eventsBefore, OUTPUT_WINDOW, EVENT_WINDOW } from '../src/task-output.ts';

const tmp = (body: string | Buffer) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-task-output-')), 'b1.output');
  fs.writeFileSync(f, body);
  return f;
};

test('a short file reads whole; a gone one is null and size -1', async () => {
  const f = tmp('one\ntwo\n');
  assert.deepEqual(await outputTail(f), { text: 'one\ntwo\n', from: 0, to: 8, total: 8 });
  assert.equal(await outputTail(f + '.gone'), null);
  assert.equal(await outputSize(f + '.gone'), -1);
});

test('a long file: the last window in whole lines, then the window before it, down to the start', async () => {
  const lines = Array.from({ length: 20000 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const f = tmp(lines), size = Buffer.byteLength(lines);
  const tail = await outputTail(f);
  assert.ok(tail && tail.to === size && tail.total === size && size - tail.from <= OUTPUT_WINDOW);
  assert.match(tail.text, /^line \d+\n/, 'starts on a whole line');
  assert.equal(lines.slice(tail.from), tail.text);
  let before = tail.from, pages = 0, text = tail.text;
  while (before > 0) {
    const p = await outputBefore(f, before);
    assert.ok(p && p.to === before);
    text = p.text + text; before = p.from; pages++;
  }
  assert.equal(text, lines, 'the pages join into the whole file');
  assert.ok(pages >= 2);
  const again = await outputTail(f, lines.indexOf('line 100\n'));
  assert.equal(again?.from, lines.indexOf('line 100\n'), 'from a line start the page had loaded: kept as is');
});

test('a character cut at the end waits for the next read', async () => {
  const f = tmp(Buffer.concat([Buffer.from('ok '), Buffer.from('é').subarray(0, 1)]));
  assert.deepEqual(await readOutput(f, 0, 10), { text: 'ok ', from: 0, to: 3, total: 4 });
  fs.appendFileSync(f, Buffer.from('é').subarray(1));
  assert.deepEqual(await readOutput(f, 3, 10), { text: 'é', from: 3, to: 5, total: 5 });
});

test('monitor events: the last window, what came since, the window before', () => {
  const events = Array.from({ length: EVENT_WINDOW + 20 }, (_, n) => ({ n, ts: null, text: `e${n}` }));
  const tail = eventTail(events);
  assert.deepEqual([tail.from, tail.to, tail.total], [20, EVENT_WINDOW + 20, EVENT_WINDOW + 20]);
  assert.equal(tail.text.split('\n')[0], 'e20');
  assert.deepEqual(eventsFrom(events, EVENT_WINDOW + 18), { text: `e${EVENT_WINDOW + 18}\ne${EVENT_WINDOW + 19}`, from: EVENT_WINDOW + 18, to: EVENT_WINDOW + 20, total: EVENT_WINDOW + 20 });
  const before = eventsBefore(events, 20);
  assert.deepEqual([before.from, before.to, before.text.split('\n').length], [0, 20, 20]);
  assert.deepEqual(eventTail([], null), { text: '', from: 0, to: 0, total: 0 });
  assert.equal(eventTail(events, 5).from, 5, 'from an earlier event the page had loaded');
});
