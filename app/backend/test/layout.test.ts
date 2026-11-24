// The sidebar's layout (layout.ts): the reconcile with the open list, the page's intents, an id swap,
// and the owner that is the only writer of state.json's `layout`. Then the router: an intent sent with an
// old id (a new session's placeholder) still moves that session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.ts';
import type { OpenEntry } from '../src/store.ts';
import { Layouts, cleanLayout, moveSession, newGroup, reconcile, renameGroup, renameId } from '../src/layout.ts';
import type { Layout } from '../src/layout.ts';
import { Router } from '../src/router.ts';
import type { RouterOptions } from '../src/router.ts';
import type { Client } from '../src/server.ts';

const open = (ids: string[], closed: string[] = []): OpenEntry[] => [
  ...ids.map((id) => ({ id, cwd: '/x', openedAt: 1, closedAt: null })),
  ...closed.map((id) => ({ id, cwd: '/x', openedAt: 1, closedAt: 2 })),
];
const empty: Layout = { groups: [], others: [] };
const work = (...ids: string[]) => ({ id: 'g1', name: 'Work', ids });

// ---------- reconcile ----------

test('reconcile: new sessions go last under Not in a group', () => {
  assert.deepEqual(reconcile({ groups: [work('a')], others: [] }, open(['a', 'b', 'c'])), { groups: [work('a')], others: ['b', 'c'] });
});

test('reconcile: closed ids stay hidden in their group, at their place', () => {
  const l: Layout = { groups: [work('a', 'x', 'b')], others: ['y'] };
  assert.deepEqual(reconcile(l, open(['a', 'b'], ['x', 'y'])), l);
});

test('reconcile: a group with only hidden ids is kept; one with no ids goes', () => {
  const l: Layout = { groups: [{ id: 'g1', name: 'Old', ids: ['x'] }, { id: 'g2', name: 'Empty', ids: [] }], others: ['a'] };
  assert.deepEqual(reconcile(l, open(['a'], ['x'])), { groups: [{ id: 'g1', name: 'Old', ids: ['x'] }], others: ['a'] });
});

test('reconcile: unknown and repeated ids go (the first place wins)', () => {
  assert.deepEqual(reconcile({ groups: [work('a', 'ghost', 'a')], others: ['a', 'b'] }, open(['a', 'b'])), { groups: [work('a')], others: ['b'] });
});

test('reconcile: a reopened session is where it was', () => {
  const l: Layout = { groups: [work('a', 'x', 'b')], others: [] };
  assert.deepEqual(reconcile(l, open(['a', 'x', 'b'])), l);
});

test('reconcile: malformed input is treated as empty', () => {
  assert.deepEqual(reconcile({ groups: 'no' } as unknown as Layout, open(['a'])), { groups: [], others: ['a'] });
  assert.deepEqual(cleanLayout(7), empty);
});

// ---------- intents ----------

test('moveSession: before, after, last in a group or in Not in a group; an emptied group goes', () => {
  const l: Layout = { groups: [work('a', 'b')], others: ['c', 'd'] };
  assert.deepEqual(moveSession(l, 'c', { before: 'a' }), { groups: [work('c', 'a', 'b')], others: ['d'] });
  assert.deepEqual(moveSession(l, 'd', { after: 'a' }), { groups: [work('a', 'd', 'b')], others: ['c'] });
  assert.deepEqual(moveSession(l, 'b', { group: 'others' }), { groups: [work('a')], others: ['c', 'd', 'b'] });
  assert.deepEqual(moveSession(l, 'c', { group: 'g1' }), { groups: [work('a', 'b', 'c')], others: ['d'] });
  assert.deepEqual(moveSession(l, 'a', { before: 'a' }), l, 'onto itself: no change');
  const one: Layout = { groups: [work('a')], others: ['c'] };
  assert.deepEqual(moveSession(one, 'a', { after: 'c' }), { groups: [], others: ['c', 'a'] });
  assert.equal(typeof moveSession(l, 'c', { before: 'zz' }), 'string', 'a target that is gone');
  assert.equal(typeof moveSession(l, 'c', { group: 'g9' }), 'string', 'a group that is gone');
  assert.deepEqual(l, { groups: [work('a', 'b')], others: ['c', 'd'] }, 'the input is not changed');
});

test('moveSession: a hidden (closed) id keeps its place among the moved ones', () => {
  const l: Layout = { groups: [work('a', 'x', 'b')], others: ['c'] };
  assert.deepEqual(moveSession(l, 'b', { before: 'a' }), { groups: [work('b', 'a', 'x')], others: ['c'] });
});

test('newGroup: a session not in a group and the one dropped on it, last among the groups', () => {
  const l: Layout = { groups: [work('a')], others: ['b', 'c', 'd'] };
  assert.deepEqual(newGroup(l, 'd', 'c', 'g2'), { groups: [work('a'), { id: 'g2', name: 'New group', ids: ['c', 'd'] }], others: ['b'] });
  assert.deepEqual(newGroup(l, 'a', 'b', 'g2', ' Demo '), { groups: [{ id: 'g2', name: 'Demo', ids: ['b', 'a'] }], others: ['c', 'd'] }, 'a group it emptied goes');
  assert.equal(typeof newGroup(l, 'b', 'a', 'g2'), 'string', 'onto a session in a group');
  assert.equal(typeof newGroup(l, 'c', 'b', 'g1'), 'string', 'a group id that is taken');
  assert.equal(typeof newGroup(l, 'c', 'b', 'others'), 'string');
  assert.equal(typeof newGroup(l, 'c', 'b', 'a b'), 'string', 'not an id');
  assert.equal(typeof newGroup(l, 'b', 'b', 'g2'), 'string', 'onto itself');
});

test('renameGroup: trimmed; an empty name or a gone group is refused', () => {
  const l: Layout = { groups: [work('a')], others: [] };
  assert.deepEqual(renameGroup(l, 'g1', '  Alpha  '), { groups: [{ id: 'g1', name: 'Alpha', ids: ['a'] }], others: [] });
  assert.equal(typeof renameGroup(l, 'g1', '   '), 'string');
  assert.equal(typeof renameGroup(l, 'g9', 'Alpha'), 'string');
});

test('renameId: swaps in place, or adds last under Not in a group', () => {
  assert.deepEqual(renameId({ groups: [work('a', 'b')], others: [] }, 'a', 'z'), { groups: [work('z', 'b')], others: [] });
  assert.deepEqual(renameId({ groups: [], others: ['q'] }, 'a', 'z'), { groups: [], others: ['q', 'z'] });
});

// ---------- the owner ----------

function owner(entries: OpenEntry[]) {
  const store = openStore(mkdtempSync(join(tmpdir(), 'synopia-layout-')), { minIntervalMs: 0 });
  const sent: Layout[] = [];
  const layouts = new Layouts({ store, entries: () => entries, publish: (l) => sent.push(structuredClone(l)) });
  return { store, sent, layouts, entries };
}

test('Layouts: an intent is stored and sent whole; a refused one changes and sends nothing', () => {
  const o = owner(open(['a', 'b', 'c'], ['x']));
  o.layouts.sync();
  assert.deepEqual(o.store.state.layout, { groups: [], others: ['a', 'b', 'c'] });
  assert.deepEqual(o.layouts.newGroup('b', 'a', 'g1'), { ok: true });
  assert.deepEqual(o.layouts.renameGroup('g1', 'Work'), { ok: true });
  assert.deepEqual(o.layouts.move('c', { before: 'a' }), { ok: true });
  assert.deepEqual(o.store.state.layout, { groups: [work('c', 'a', 'b')], others: [] });
  assert.equal(o.sent.length, 4);
  assert.deepEqual(o.sent.at(-1), o.store.state.layout);
  assert.equal(o.layouts.move('x', { before: 'a' }).ok, false, 'a closed session is not moved');
  assert.equal(o.layouts.move('ghost', { before: 'a' }).ok, false);
  assert.equal(o.layouts.renameGroup('g1', '').ok, false);
  assert.deepEqual(o.layouts.move('a', { before: 'a' }), { ok: true });
  assert.equal(o.sent.length, 4, 'nothing changed, nothing sent');
  o.store.close();
});

test('Layouts: an id swap keeps the place and is not sent alone (the session frame carries it)', () => {
  const o = owner(open(['a', 'b']));
  o.layouts.sync();
  o.layouts.newGroup('b', 'a', 'g1');
  const n = o.sent.length;
  o.entries.splice(0, 1, { id: 'z', cwd: '/x', openedAt: 1, closedAt: null });
  o.layouts.rename('a', 'z');
  assert.deepEqual(o.store.state.layout.groups[0].ids, ['z', 'b']);
  assert.equal(o.sent.length, n);
  o.store.close();
});

// ---------- a late intent ----------

test('router: an intent with an old id moves the session that id became', () => {
  const o = owner(open(['real', 'b', 'c']));
  o.layouts.sync();
  const aliases: Record<string, string> = { 'new-1': 'real' };
  const acks: unknown[] = [];
  const router = new Router({
    sessions: { resolve: (id: string) => aliases[id] ?? id, layout: o.layouts },
    publisher: { reply: (_c: Client, msg: unknown) => acks.push(msg), toast: () => {} },
    log: () => {},
  } as unknown as RouterOptions);
  const page = { send: () => {}, close: () => {}, buffered: () => 0 } as Client;
  router.handle(page, { t: 'newGroup', id: 'n1', sid: 'new-1', onto: 'b', group: 'g1' });
  router.handle(page, { t: 'moveSession', id: 'm1', sid: 'c', before: 'new-1' });
  router.handle(page, { t: 'moveSession', id: 'm2', sid: 'c', before: 'b', after: 'b' });
  router.handle(page, { t: 'renameGroup', id: 'r1', group: 'g1', name: 'Work' });
  assert.deepEqual(o.store.state.layout, { groups: [{ id: 'g1', name: 'Work', ids: ['b', 'c', 'real'] }], others: [] });
  assert.deepEqual(acks.map((a) => (a as { ok: boolean }).ok), [true, true, false, true], 'two targets at once is refused');
  o.store.close();
});
