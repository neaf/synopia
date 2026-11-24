import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, defaultState, newSessionFolder, ReviewedMarks, REVIEWED_MAX } from '../src/store.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'synopia-store-'));
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

test('defaults when there is no state file', () => {
  const dir = tmp();
  const s = openStore(dir);
  assert.deepEqual(s.state, defaultState());
  assert.equal(s.state.settings.newSessionCwd, undefined);
  assert.equal(s.state.settings.writerModel, 'haiku');
  assert.equal(existsSync(join(dir, 'state.json')), false);
});

test('a partial state file is filled with defaults', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, reviewed: ['a1'], settings: { writerModel: 'sonnet' }, layout: 7 }));
  const s = openStore(dir);
  assert.deepEqual(s.state.reviewed, ['a1']);
  assert.equal(s.state.settings.writerModel, 'sonnet');
  assert.equal(s.state.settings.newSessionCwd, undefined);
  assert.deepEqual(s.state.layout, { groups: [], others: [] });
  assert.deepEqual(s.state.open, []);
});

test('new sessions open in the setting, else the most recent session folder, else home', () => {
  const s = defaultState();
  assert.equal(newSessionFolder(s), '~');
  s.open = [
    { id: 'a', cwd: '/w/old', openedAt: 1, closedAt: null },
    { id: 'b', cwd: '/w/new', openedAt: 3, closedAt: 5 },
    { id: 'c', cwd: '/w/mid', openedAt: 2, closedAt: null },
  ];
  assert.equal(newSessionFolder(s), '/w/new');
  s.settings.newSessionCwd = '~/work';
  assert.equal(newSessionFolder(s), '~/work');
  const dir = tmp();
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, settings: { newSessionCwd: '' } }));
  assert.equal(openStore(dir).state.settings.newSessionCwd, undefined);
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
  s.state.reviewed.push('r1');
  s.changed();
  s.state.reviewed.push('r2');
  s.changed();
  assert.equal(existsSync(join(dir, 'state.json')), false, 'not written synchronously');
  await wait(20);
  const first = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  assert.deepEqual(first.reviewed, ['r1', 'r2']);
  // A second change within the interval waits for it.
  s.state.reviewed.push('r3');
  s.changed();
  await wait(5);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).reviewed, ['r1', 'r2']);
  await wait(80);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).reviewed, ['r1', 'r2', 'r3']);
  // No temp file is left behind.
  assert.deepEqual(readdirSync(dir), ['state.json']);
  assert.deepEqual(openStore(dir).state.reviewed, ['r1', 'r2', 'r3']);
});

test('flush writes at once', () => {
  const dir = tmp();
  const s = openStore(dir);
  s.state.settings.writerModel = 'opus';
  s.changed();
  s.flush();
  assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).settings.writerModel, 'opus');
});

test('a failed write keeps the state dirty and is tried again (backend-core#B1); the file is 0600', async () => {
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

test('every map entry is checked on load; a wrong one is dropped (backend-core#B4)', () => {
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
  // reviewed marks: the newest REVIEWED_MAX kept (backend-core#B5)
  assert.equal(st.reviewed.length, REVIEWED_MAX);
  assert.equal(st.reviewed[0], 'agent-5');
  assert.equal(st.reviewed.at(-1), 'agent-1004');
});

test('reviewed marks: a new mark past REVIEWED_MAX drops the oldest (backend-core#B5)', () => {
  const s = openStore(tmp(), { minIntervalMs: 0 });
  const marks = new ReviewedMarks(s);
  for (let i = 0; i < REVIEWED_MAX; i++) marks.mark(`a${i}`);
  assert.equal(marks.mark('a5'), false, 'marked already');
  assert.equal(marks.mark('new'), true);
  assert.equal(s.state.reviewed.length, REVIEWED_MAX);
  assert.equal(marks.has('a0'), false);
  assert.equal(marks.has('a1'), true);
  assert.equal(marks.has('new'), true);
  s.close();
});
