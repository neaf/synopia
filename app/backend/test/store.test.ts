import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, defaultState, reconcileLayout } from '../src/store.ts';
import type { OpenEntry, Layout } from '../src/store.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'synopia-store-'));
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

test('defaults when there is no state file', () => {
  const dir = tmp();
  const s = openStore(dir);
  assert.deepEqual(s.state, defaultState());
  assert.equal(s.state.settings.newSessionCwd, '~/dev/demo-project');
  assert.equal(s.state.settings.writerModel, 'haiku');
  assert.equal(existsSync(join(dir, 'state.json')), false);
});

test('a partial state file is filled with defaults', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, reviewed: ['a1'], settings: { writerModel: 'sonnet' }, layout: 7 }));
  const s = openStore(dir);
  assert.deepEqual(s.state.reviewed, ['a1']);
  assert.equal(s.state.settings.writerModel, 'sonnet');
  assert.equal(s.state.settings.newSessionCwd, '~/dev/demo-project');
  assert.deepEqual(s.state.layout, { groups: [], others: [] });
  assert.deepEqual(s.state.open, []);
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

// Layout reconcile (section 11).
const open = (ids: string[], closed: string[] = []): OpenEntry[] => [
  ...ids.map((id) => ({ id, cwd: '/x', openedAt: 1, closedAt: null })),
  ...closed.map((id) => ({ id, cwd: '/x', openedAt: 1, closedAt: 2 })),
];
const empty: Layout = { groups: [], others: [] };

test('reconcile: new sessions go to Not in a group', () => {
  const stored: Layout = { groups: [{ id: 'g1', name: 'Work', ids: ['a'] }], others: [] };
  const got = reconcileLayout(stored, stored, open(['a', 'b', 'c']));
  assert.deepEqual(got, { groups: [{ id: 'g1', name: 'Work', ids: ['a'] }], others: ['b', 'c'] });
});

test('reconcile: the page layout is authoritative for visible ids', () => {
  const stored: Layout = { groups: [{ id: 'g1', name: 'Work', ids: ['a', 'b'] }], others: ['c'] };
  const incoming: Layout = { groups: [{ id: 'g1', name: 'Renamed', ids: ['c', 'a'] }], others: ['b'] };
  assert.deepEqual(reconcileLayout(incoming, stored, open(['a', 'b', 'c'])), incoming);
});

test('reconcile: closed ids stay hidden in their group, at their place', () => {
  const stored: Layout = { groups: [{ id: 'g1', name: 'Work', ids: ['a', 'x', 'b'] }], others: ['y'] };
  // The page doesn't show x and y (closed) and moves b before a.
  const incoming: Layout = { groups: [{ id: 'g1', name: 'Work', ids: ['b', 'a'] }], others: [] };
  const got = reconcileLayout(incoming, stored, open(['a', 'b'], ['x', 'y']));
  assert.deepEqual(got, { groups: [{ id: 'g1', name: 'Work', ids: ['b', 'a', 'x'] }], others: ['y'] });
});

test('reconcile: a group with only hidden ids is kept', () => {
  const stored: Layout = { groups: [{ id: 'g1', name: 'Old', ids: ['x', 'a'] }], others: [] };
  // The page moved a out and no longer sends g1.
  const incoming: Layout = { groups: [], others: ['a'] };
  const got = reconcileLayout(incoming, stored, open(['a'], ['x']));
  assert.deepEqual(got, { groups: [{ id: 'g1', name: 'Old', ids: ['x'] }], others: ['a'] });
});

test('reconcile: a group with no ids at all is dropped', () => {
  const stored: Layout = { groups: [{ id: 'g1', name: 'Work', ids: ['a'] }, { id: 'g2', name: 'Empty', ids: [] }], others: [] };
  const incoming: Layout = { groups: [{ id: 'g1', name: 'Work', ids: [] }, { id: 'g2', name: 'Empty', ids: [] }], others: ['a'] };
  assert.deepEqual(reconcileLayout(incoming, stored, open(['a'])), { groups: [], others: ['a'] });
});

test('reconcile: unknown and duplicate ids are removed', () => {
  const incoming: Layout = { groups: [{ id: 'g1', name: 'Work', ids: ['a', 'ghost', 'a'] }], others: ['a', 'b'] };
  assert.deepEqual(reconcileLayout(incoming, empty, open(['a', 'b'])), {
    groups: [{ id: 'g1', name: 'Work', ids: ['a'] }],
    others: ['b'],
  });
});

test('reconcile: a reopened session keeps its place', () => {
  const stored: Layout = { groups: [{ id: 'g1', name: 'Work', ids: ['a', 'x', 'b'] }], others: [] };
  // x was closed and is now open again: it is visible where it was.
  const got = reconcileLayout(stored, stored, open(['a', 'x', 'b']));
  assert.deepEqual(got, stored);
});

test('reconcile: malformed input is treated as empty', () => {
  const got = reconcileLayout({ groups: 'no' } as unknown as Layout, empty, open(['a']));
  assert.deepEqual(got, { groups: [], others: ['a'] });
});
