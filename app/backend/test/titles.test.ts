import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transcript } from '../src/transcript.ts';
import type { JsonRecord } from '../src/tail.ts';
import type { WrittenTitle } from '../src/transcript.ts';
import { Writer, withTitle, MAX_HISTORY } from '../src/writer.ts';
import type { WriterQueryFn } from '../src/writer.ts';
import { openStore } from '../src/store.ts';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const T = (min: number) => new Date(Date.UTC(2026, 10, 24, 9, min)).toISOString();
const you = (n: number, text: string): JsonRecord => ({ type: 'user', uuid: `u${n}`, timestamp: T(n), message: { role: 'user', content: text } });
const claude = (n: number, text: string): JsonRecord => ({ type: 'assistant', uuid: `a${n}`, timestamp: T(n), message: { role: 'assistant', content: [{ type: 'text', text }] } });
const ai = (n: number, title: string): JsonRecord => ({ type: 'ai-title', uuid: `t${n}`, timestamp: T(n), aiTitle: title, sessionId: 's' });
const custom = (n: number, title: string): JsonRecord => ({ type: 'custom-title', uuid: `c${n}`, timestamp: T(n), customTitle: title, sessionId: 's' });
const titles = (t: Transcript) => t.items.filter((i) => i.k === 'title').map((i) => [i.id, i.title, i.by]);
const kinds = (t: Transcript) => t.items.map((i) => (i.k === 'title' ? `title:${i.title}` : i.k));

test('title records: an item at the record, by Claude for ai-title and by you for custom-title; none for the first title', () => {
  const t = new Transcript();
  t.pushAll([ai(0, 'Start'), you(1, 'Fix the login'), claude(2, 'On it'), ai(3, 'Fix the login test'), claude(4, 'Done'), custom(5, 'Login fix'), you(6, 'Thanks')]);
  assert.deepEqual(titles(t), [['t3', 'Fix the login test', 'claude'], ['c5', 'Login fix', 'you']]);
  assert.deepEqual(kinds(t), ['you', 'claude', 'title:Fix the login test', 'claude', 'title:Login fix', 'you']);
  assert.equal(t.title, 'Login fix', 'the header title is unchanged by the items');
});

test('title records: none before your first prompt, none for the first title even after it', () => {
  const a = new Transcript();
  a.pushAll([ai(0, 'One'), ai(1, 'Two'), you(2, 'Go'), ai(3, 'Three')]);
  assert.deepEqual(titles(a), [['t3', 'Three', 'claude']], 'One and Two came before the prompt');
  const b = new Transcript();
  b.pushAll([you(0, 'Go'), ai(1, 'First'), ai(2, 'Second')]);
  assert.deepEqual(titles(b), [['t2', 'Second', 'claude']], 'the first title only names the session');
});

test('dedupe: an equal title (case and spaces aside) is no change, and a custom title hides later ai-titles', () => {
  const t = new Transcript();
  t.pushAll([you(0, 'Go'), ai(1, 'Fix the test'), ai(2, 'fix  the TEST '), ai(3, 'Fix the test'), custom(4, 'Mine'), ai(5, 'Something else'), custom(6, 'mine')]);
  assert.deepEqual(titles(t), [['c4', 'Mine', 'you']]);
});

test('history: written titles go in by time among the records, across sources, and stay put after a restart', () => {
  const recs = [you(0, 'Go'), ai(1, 'Fix the test'), claude(2, 'Fixed'), you(5, 'More'), claude(6, 'Also done')];
  // the writer's titles: one after the first turn, one equal to it (no item), one after the second turn
  const history: WrittenTitle[] = [
    { title: 'Fix the failing login test', at: Date.parse(T(3)) },
    { title: 'Fix the Failing login test', at: Date.parse(T(4)) },
  ];
  const t = new Transcript({ titlesOf: () => history });
  t.pushAll(recs);
  t.takeChanges();
  assert.deepEqual(kinds(t), ['you', 'claude', 'title:Fix the failing login test', 'you', 'claude']);
  assert.equal(t.items[2].id, `title:${history[0].at}`);
  assert.equal(t.items[2].ts, T(3));
  // live: a new one is written after the last record, and goes at the end
  history.push({ title: 'Login test and docs', at: Date.parse(T(7)) });
  const ch = t.takeChanges();
  assert.deepEqual(ch.items, [`title:${Date.parse(T(7))}`]);
  assert.deepEqual(kinds(t).slice(-1), ['title:Login test and docs']);
  // a restart (state.json round trip) reads the file again: the same items, in the same places
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-titles-'));
  const s1 = openStore(dir);
  s1.state.written.s = { title: 'Login test and docs', now: '', at: history[2].at, history };
  s1.changed();
  s1.close();
  const s2 = openStore(dir);
  const again = new Transcript({ titlesOf: () => s2.state.written.s?.history });
  again.pushAll([...recs, claude(8, 'Later')]);
  again.takeChanges();
  assert.deepEqual(kinds(again), ['you', 'claude', 'title:Fix the failing login test', 'you', 'claude', 'title:Login test and docs', 'claude']);
  assert.deepEqual(again.items.filter((i) => i.k === 'title').map((i) => i.id), t.items.filter((i) => i.k === 'title').map((i) => i.id));
  // a written title the CLI's ai-title then repeats is no change
  const dup = new Transcript({ titlesOf: () => [{ title: 'B', at: Date.parse(T(2)) }] });
  dup.pushAll([you(0, 'Go'), ai(1, 'A'), ai(3, 'b')]);
  assert.deepEqual(titles(dup), [[`title:${Date.parse(T(2))}`, 'B', 'claude']]);
});

test('history: the writer keeps a new title only when it changed, the newest 50', async () => {
  let h: WrittenTitle[] = [];
  h = withTitle(h, 'One', 1);
  h = withTitle(h, ' one ', 2);
  assert.deepEqual(h, [{ title: 'One', at: 1 }]);
  for (let i = 0; i < 60; i++) h = withTitle(h, `T${i}`, 10 + i);
  assert.equal(h.length, MAX_HISTORY);
  assert.deepEqual(h[0], { title: 'T10', at: 20 });
  assert.deepEqual(h[h.length - 1], { title: 'T59', at: 69 });
  // the writer stores it in written[sid].history
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-titles-'));
  const store = openStore(dir);
  let n = 0;
  const replies = ['Fix the test', 'Fix the test', 'Fix the docs'];
  const fn: WriterQueryFn = ({ prompt }) => (async function* () {
    for await (const _ of prompt) { /* drain */ }
    yield { type: 'result', subtype: 'success', result: JSON.stringify({ title: replies[n++], now: 'Now' }) } as unknown as SDKMessage;
  })();
  let clock = 1000;
  const w = new Writer({
    store, stateDir: dir, queryFn: fn, debounceMs: 1, now: () => clock++,
    source: { title: () => 'x', turns: () => [{ you: 'a', claude: 'b' }], resolve: (s) => s, changed: () => {} },
  });
  for (let i = 0; i < 3; i++) {
    w.turnEnded('s');
    await new Promise((r) => setTimeout(r, 30));
  }
  w.stop();
  store.close();
  assert.deepEqual(store.state.written.s.history?.map((x) => x.title), ['Fix the test', 'Fix the docs']);
});

test('store: a malformed history loads as the valid entries only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-titles-'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ written: { s: { title: 'x', at: 1, history: [{ title: 'ok', at: 2 }, { title: 3 }, null] }, r: { at: 1, history: 'no' } } }));
  const s = openStore(dir);
  assert.deepEqual(s.state.written.s.history, [{ title: 'ok', at: 2 }]);
  assert.deepEqual(s.state.written.r.history, []);
});
