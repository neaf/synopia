import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, defaultState } from '../src/store.ts';
import { AGENT_CLOSED_MAX } from '../src/open-items.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'synopia-store-'));
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

test('defaults when there is no state file', () => {
  const dir = tmp();
  const s = openStore(dir);
  assert.deepEqual(s.state, defaultState());
  assert.equal(s.state.settings.writerModel, 'haiku');
  assert.equal(existsSync(join(dir, 'state.json')), false);
});

test('a partial state file is filled with defaults', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, reviewed: ['a1'], settings: { writerModel: 'sonnet' }, layout: 7 }));
  const s = openStore(dir);
  assert.deepEqual(s.state.items, { lists: {}, carried: ['a1'] }, 'the old reviewed marks are carried into items');
  assert.equal('reviewed' in s.state, false);
  assert.equal(s.state.settings.writerModel, 'sonnet');
  assert.deepEqual(s.state.layout, { groups: [], others: [] });
  assert.deepEqual(s.state.open, []);
});

test('an older newSessionCwd setting loads and is dropped (R3.3: New session asks)', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, settings: { newSessionCwd: '~/work', writerModel: 'haiku' } }));
  const s = openStore(dir).state;
  assert.equal('newSessionCwd' in s.settings, false);
  assert.equal(s.settings.writerModel, 'haiku');
});

test('a corrupt state file is kept aside, not overwritten', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'state.json'), '{not json');
  const s = openStore(dir);
  assert.deepEqual(s.state, defaultState());
  assert.ok(readdirSync(dir).some((f) => f.startsWith('state.json.bad-')));
});

test('writes atomically, debounced, and reloads', async () => {
  const dir = tmp();
  const s = openStore(dir, { minIntervalMs: 50 });
  s.state.items.carried.push('r1');
  s.changed();
  s.state.items.carried.push('r2');
  s.changed();
  assert.equal(existsSync(join(dir, 'state.json')), false, 'not written synchronously');
  await wait(20);
  const first = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  assert.deepEqual(first.items.carried, ['r1', 'r2']);
  // A second change within the interval waits for it.
  s.state.items.carried.push('r3');
  s.changed();
  await wait(5);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).items.carried, ['r1', 'r2']);
  await wait(80);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).items.carried, ['r1', 'r2', 'r3']);
  // No temp file is left behind.
  assert.deepEqual(readdirSync(dir), ['state.json']);
  assert.deepEqual(openStore(dir).state.items.carried, ['r1', 'r2', 'r3']);
});

test('flush writes at once', () => {
  const dir = tmp();
  const s = openStore(dir);
  s.state.settings.writerModel = 'opus';
  s.changed();
  s.flush();
  assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).settings.writerModel, 'opus');
});

test('a failed write keeps the state dirty and is tried again; the file is 0600', async () => {
  const dir = tmp();
  const lines: string[] = [];
  const s = openStore(dir, { minIntervalMs: 30, log: (e, f) => lines.push(`${e} ${f?.code ?? ''}`.trim()) });
  const blocker = join(dir, `state.json.tmp-${process.pid}`);
  mkdirSync(blocker); // the temp file can't be written while a folder holds its name
  s.state.settings.writerModel = 'opus';
  s.changed();
  s.flush();
  assert.equal(existsSync(join(dir, 'state.json')), false);
  await wait(80);
  assert.deepEqual(lines, ['store.new', 'store.writeFailed EISDIR'], 'logged once, though tried again');
  rmSync(blocker, { recursive: true });
  await wait(80);
  assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).settings.writerModel, 'opus', 'written on a retry, no change needed');
  assert.equal(lines.at(-1), 'store.writeOk');
  assert.equal(statSync(join(dir, 'state.json')).mode & 0o777, 0o600);
  mkdirSync(blocker);
  s.state.settings.writerModel = 'sonnet';
  s.changed();
  s.close(); // a stop's last write fails: nothing stays armed to hold the process
  rmSync(blocker, { recursive: true });
  await wait(80);
  assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).settings.writerModel, 'opus');
});

test('every map entry is checked on load; a wrong one is dropped', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    version: 1,
    models: { a: { model: 'opus', effort: 'high' }, b: { model: 'sonnet', effort: null }, c: { model: 3 }, d: 'opus', e: { model: 'haiku', effort: 7 } },
    rules: { a: ['Bash(ls:*)'], b: ['x', 2], c: 'x' },
    answers: { t1: 'Yes', t2: { no: 1 } },
    plans: { t1: 'The plan', t2: null },
    status: { a: { status: 'idle', at: 5 }, b: { status: 'busy' }, c: { status: 1, at: 5 }, d: null },
    ended: { a: 5, b: '5', c: Infinity },
    endedFailed: { a: true, b: 'yes' },
    written: {
      a: { title: 'Ship it', now: 'Waiting', at: 9, history: [{ title: 'Ship', at: 1 }, { title: 2, at: 2 }] },
      b: { title: 'No time' }, c: { at: 3, title: 4 }, d: { at: 4, history: 'x' },
    },
    reviewed: Array.from({ length: 1005 }, (_, i) => `agent-${i}`),
  }));
  const st = openStore(dir).state;
  assert.deepEqual(st.models, { a: { model: 'opus', effort: 'high' }, b: { model: 'sonnet', effort: null }, e: { model: 'haiku' } });
  assert.deepEqual(st.rules, { a: ['Bash(ls:*)'] });
  assert.deepEqual(st.answers, { t1: 'Yes' });
  assert.deepEqual(st.plans, { t1: 'The plan' });
  assert.deepEqual(st.status, { a: { status: 'idle', at: 5 } });
  assert.deepEqual(st.ended, { a: 5 });
  assert.deepEqual(st.endedFailed, { a: true });
  assert.deepEqual(st.written, {
    a: { at: 9, title: 'Ship it', now: 'Waiting', history: [{ title: 'Ship', at: 1 }] },
    c: { at: 3 }, d: { at: 4, history: [] },
  });
  // the old reviewed marks: carried into items, the newest AGENT_CLOSED_MAX kept
  assert.equal(st.items.carried.length, AGENT_CLOSED_MAX);
  assert.equal(st.items.carried[0], 'agent-5');
  assert.equal(st.items.carried.at(-1), 'agent-1004');
});

test('the items section: validated on load; the reviewed field is carried over once and not written again', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    version: 1, reviewed: ['old'],
    items: { lists: { '/tmp/shop/.ai-notes/m2/open-items.md': { top: { Y: 3, A: 1 }, items: [
      { id: 'Y3', kind: 'review', text: 'Review: Copy', fields: { subagent: 'Copy' }, source: 'synopia', agent: 'ag', at: 1, closed: { how: 'done', at: 2, note: 'marked reviewed', by: 'synopia' } },
      { id: 'Y3', kind: 'decision', text: 'twice', fields: {}, source: 'agent' },
      { id: 'Z1', kind: 'decision', text: 'bad id', fields: {}, source: 'agent' },
    ] }, bad: 7 }, carried: ['kept', 3] },
  }));
  const s = openStore(dir, { minIntervalMs: 0 });
  const lists = s.state.items.lists;
  assert.deepEqual(Object.keys(lists), ['/tmp/shop/.ai-notes/m2/open-items.md']);
  assert.deepEqual(lists['/tmp/shop/.ai-notes/m2/open-items.md'].items.map((h) => [h.id, h.kind, h.closed?.note]), [['Y3', 'review', 'marked reviewed']]);
  assert.deepEqual(s.state.items.carried, ['kept', 'old']);
  s.changed();
  s.flush();
  const raw = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  assert.equal('reviewed' in raw, false);
  assert.deepEqual(raw.items.carried, ['kept', 'old']);
  s.close();
});
