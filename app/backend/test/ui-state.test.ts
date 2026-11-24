import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, normalize } from '../src/store.ts';
import { patchUi, pruneUi, rekeyUi, draftImage, normalizeUi, DRAFT_IMAGE_MAX } from '../src/ui-state.ts';

const SID = '11111111-2222-4333-8444-555555555555';
const NEW = '66666666-7777-4888-8999-aaaaaaaaaaaa';
// A made-up PNG of n bytes: the signature, then zeros.
const png = (n: number) => { const b = Buffer.alloc(n); Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(b); return b.toString('base64'); };

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-ui-'));
  const store = openStore(dir, { minIntervalMs: 0 });
  return { dir, store, drafts: (sid: string) => path.join(dir, 'drafts', sid) };
}

test('ui: a patch merges top-level fields and per-session fields; null removes; unknown fields are ignored', () => {
  const { store } = setup();
  patchUi(store, { current: SID, view: 'agent-1', mode: 'insert', bogus: 1, openList: { filter: 'demo' }, sessions: { [SID]: { steps: ['|toolu_1'], scroll: { '': { id: 'run:toolu_1', off: 12.4 } }, junk: true } } });
  const ui = store.state.ui;
  assert.equal(ui.current, SID);
  assert.equal(ui.view, 'agent-1');
  assert.equal(ui.mode, 'insert');
  assert.deepEqual(ui.openList, { filter: 'demo' });
  assert.equal((ui as Record<string, unknown>).bogus, undefined);
  assert.deepEqual(ui.sessions[SID], { steps: ['|toolu_1'], scroll: { '': { id: 'run:toolu_1', off: 12 } } });
  // a second patch keeps what it doesn't name
  patchUi(store, { mode: 'normal', openList: null, sessions: { [SID]: { diffs: ['|diff-x-0'], steps: null } } });
  assert.equal(ui.current, SID);
  assert.equal(ui.mode, 'normal');
  assert.equal(ui.openList, null);
  assert.deepEqual(ui.sessions[SID], { scroll: { '': { id: 'run:toolu_1', off: 12 } }, diffs: ['|diff-x-0'] });
  // a bad mode and a bad anchor are dropped, not stored
  patchUi(store, { mode: 'visual', sessions: { [SID]: { scroll: { '': { id: 3 }, a: { bottom: true } } } } });
  assert.equal(ui.mode, 'normal');
  assert.deepEqual(ui.sessions[SID].scroll, { a: { bottom: true } });
  // the theme choice: light or dark is kept, null (follow the system) and anything else clears it
  patchUi(store, { theme: 'dark' });
  assert.equal(ui.theme, 'dark');
  patchUi(store, { mode: 'insert' });
  assert.equal(ui.theme, 'dark');
  patchUi(store, { theme: 'sepia' });
  assert.equal(ui.theme, null);
  patchUi(store, { theme: 'light' });
  patchUi(store, { theme: null });
  assert.equal(ui.theme, null);
  // ids that aren't file names, and sessions that aren't open, are dropped
  patchUi(store, { sessions: { '../x': { steps: ['a'] }, other: { steps: ['a'] } } }, { known: (id) => id === SID });
  assert.deepEqual(Object.keys(ui.sessions), [SID]);
});

test('ui: it survives a restart through state.json, and a damaged ui field loads as empty', () => {
  const { dir, store } = setup();
  patchUi(store, { current: SID, preview: { path: '/tmp/a.md', scroll: 40, find: 'x' }, sessions: { [SID]: { cards: { 'req-1': { qi: 0, oi: 1, picks: { 0: ['Yes'] } } } } } });
  store.close();
  const again = openStore(dir, { minIntervalMs: 0 });
  assert.equal(again.state.ui.current, SID);
  assert.deepEqual(again.state.ui.preview, { path: '/tmp/a.md', scroll: 40, find: 'x' });
  assert.deepEqual(again.state.ui.sessions[SID].cards, { 'req-1': { qi: 0, oi: 1, picks: { 0: ['Yes'] } } });
  assert.deepEqual(normalize({ ui: 'nope' }).ui, { sessions: {} });
  assert.deepEqual(normalizeUi({ sessions: { [SID]: 3 } }), { sessions: { [SID]: {} } });
});

test('ui: draft images are files, served back, and removed when the draft drops them or is sent', async () => {
  const { store, drafts } = setup();
  patchUi(store, { sessions: { [SID]: { draft: { text: 'hello', cursor: [2, 3], images: [{ id: 'img1', mediaType: 'image/png', data: png(100) }, { id: 'img2', mediaType: 'image/jpeg', data: png(50) }] } } } });
  const d = store.state.ui.sessions[SID].draft;
  assert.deepEqual(d, { text: 'hello', cursor: [2, 3], images: [{ id: 'img1', mediaType: 'image/png', size: 100 }, { id: 'img2', mediaType: 'image/jpeg', size: 50 }] });
  assert.deepEqual(fs.readdirSync(drafts(SID)).sort(), ['img1.png', 'img2.jpg']);
  assert.ok(!JSON.stringify(store.state).includes(png(100)), 'no image bytes in state.json');
  const r = await draftImage(store, SID, 'draft:img1');
  assert.equal(r.status, 200);
  assert.equal(r.status === 200 && r.type, 'image/png');
  assert.equal(r.status === 200 && r.body.length, 100);
  assert.equal((await draftImage(store, SID, 'draft:nope')).status, 404);
  // the next patch lists the stored image without its bytes, and drops the other
  patchUi(store, { sessions: { [SID]: { draft: { text: 'hello!', cursor: [6, 6], images: [{ id: 'img1', mediaType: 'image/png' }] } } } });
  assert.deepEqual(fs.readdirSync(drafts(SID)), ['img1.png']);
  assert.equal(store.state.ui.sessions[SID].draft?.images[0].size, 100);
  // each image keeps the number of its [Image #n] tag; a bad number is dropped
  patchUi(store, { sessions: { [SID]: { draft: { text: 'a [Image #2] b', cursor: [0, 0], images: [{ id: 'img1', mediaType: 'image/png', n: 2 }, { id: 'img3', mediaType: 'image/png', n: -1, data: png(10) }] } } } });
  assert.deepEqual(store.state.ui.sessions[SID].draft?.images, [{ id: 'img1', mediaType: 'image/png', size: 100, n: 2 }, { id: 'img3', mediaType: 'image/png', size: 10 }]);
  // sent: the draft is cleared, and its folder goes
  patchUi(store, { sessions: { [SID]: { draft: { text: '', cursor: [0, 0], images: [] } } } });
  assert.equal(store.state.ui.sessions[SID], undefined, 'nothing left for the session');
  assert.ok(!fs.existsSync(drafts(SID)));
});

test('ui: an image over 5 MB, or past 20 MB for the session, is not kept, with a toast', () => {
  const { store, drafts } = setup();
  const toasts: string[] = [];
  const big = png(DRAFT_IMAGE_MAX + 1), four = png(4.5 * 1024 * 1024);
  const images = [{ id: 'big', mediaType: 'image/png', data: big }, ...[1, 2, 3, 4, 5].map((i) => ({ id: `p${i}`, mediaType: 'image/png', data: four }))];
  patchUi(store, { sessions: { [SID]: { draft: { text: '', images } } } }, { toast: (t) => toasts.push(t) });
  assert.deepEqual(store.state.ui.sessions[SID].draft?.images.map((im) => im.id), ['p1', 'p2', 'p3', 'p4']);
  assert.deepEqual(fs.readdirSync(drafts(SID)).sort(), ['p1.png', 'p2.png', 'p3.png', 'p4.png']);
  assert.equal(toasts.length, 2);
  assert.match(toasts[0], /over 5 MB/);
  assert.match(toasts[1], /20 MB/);
  // a type other than PNG or JPEG isn't listed at all
  patchUi(store, { sessions: { [SID]: { draft: { text: 'x', images: [{ id: 'g', mediaType: 'image/gif', data: png(10) }] } } } });
  assert.deepEqual(store.state.ui.sessions[SID].draft?.images, []);
  assert.ok(!fs.existsSync(drafts(SID)));
});

test('ui: pruning a closed session drops its data, draft files and current session; null in a patch drops the data', () => {
  const { store, drafts } = setup();
  patchUi(store, { current: SID, view: 'a1', sessions: { [SID]: { draft: { text: 't', images: [{ id: 'i', mediaType: 'image/png', data: png(10) }] } }, [NEW]: { steps: ['|x'] } } });
  assert.ok(fs.existsSync(drafts(SID)));
  pruneUi(store, SID);
  assert.equal(store.state.ui.sessions[SID], undefined);
  assert.equal(store.state.ui.current, null);
  assert.equal(store.state.ui.view, null);
  assert.ok(!fs.existsSync(drafts(SID)));
  assert.deepEqual(store.state.ui.sessions[NEW], { steps: ['|x'] });
  patchUi(store, { sessions: { [NEW]: null } });
  assert.deepEqual(store.state.ui.sessions, {});
});

test('ui: a new id re-keys the session data, its draft files and the current session', async () => {
  const { store, drafts } = setup();
  patchUi(store, { current: SID, sessions: { [SID]: { steps: ['|x'], draft: { text: 't', images: [{ id: 'i', mediaType: 'image/png', data: png(10) }] } } } });
  rekeyUi(store, SID, NEW);
  assert.equal(store.state.ui.current, NEW);
  assert.equal(store.state.ui.sessions[SID], undefined);
  assert.deepEqual(store.state.ui.sessions[NEW].steps, ['|x']);
  assert.ok(!fs.existsSync(drafts(SID)));
  assert.deepEqual(fs.readdirSync(drafts(NEW)), ['i.png']);
  assert.equal((await draftImage(store, NEW, 'draft:i')).status, 200);
  // a late patch with the old id reaches the new one through resolve
  patchUi(store, { sessions: { [SID]: { folds: ['|run:a#0'] } } }, { resolve: (id) => (id === SID ? NEW : id) });
  assert.deepEqual(store.state.ui.sessions[NEW].folds, ['|run:a#0']);
});

test('ui: an emptied entry of the current session keeps current and view', () => {
  const { store, drafts } = setup();
  patchUi(store, { current: SID, view: 'a1', sessions: { [SID]: { draft: { text: 't', images: [{ id: 'i', mediaType: 'image/png', data: png(10) }] } } } });
  patchUi(store, { sessions: { [SID]: { draft: null } } }); // the draft sent: the entry's last field
  assert.equal(store.state.ui.sessions[SID], undefined);
  assert.ok(!fs.existsSync(drafts(SID)));
  assert.equal(store.state.ui.current, SID);
  assert.equal(store.state.ui.view, 'a1');
  patchUi(store, { sessions: { [SID]: { steps: ['|x'] } } });
  patchUi(store, { sessions: { [SID]: { steps: null } } }); // the last fold closed
  assert.equal(store.state.ui.current, SID);
  patchUi(store, { sessions: { [SID]: null } }); // a null entry drops the data, not the current session
  assert.equal(store.state.ui.current, SID);
  assert.equal(store.state.ui.view, 'a1');
  store.flush(); // what a reload reads
  const again = openStore(path.dirname(store.path));
  assert.equal(again.state.ui.current, SID);
  assert.equal(again.state.ui.view, 'a1');
});
