// The page's frames through a real daemon's socket (main.ts onMessage), on the fixture tree under --fake:
// what each one changes, as the next hello or a reply shows it, and the log line of one it ignores.
// A characterization of the dispatch as it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, connectPage, waitFor, FIXTURES, tmp } from './daemon-harness.ts';
import type { Daemon } from './daemon-harness.ts';

const S1 = '11111111-0000-4000-8000-000000000001', S2 = '22222222-0000-4000-8000-000000000002', S3 = '33333333-0000-4000-8000-000000000003';
const S4 = '44444444-0000-4000-8000-000000000004', S5 = '55555555-0000-4000-8000-000000000005';

let d: Daemon;
test.before(async () => { d = await startDaemon(['--fake', '--claude-dir', FIXTURES, '--no-parent', '--dry-open']); });
test.after(() => d.stop());

// frames from one page, then what a second page's hello holds
async function sendThenHello(...msgs: object[]) {
  const p = await connectPage(d.info);
  for (const m of msgs) p.send(m);
  await new Promise((ok) => setTimeout(ok, 200));
  await p.close();
  const q = await connectPage(d.info);
  await q.close();
  return q.hello as Record<string, unknown>;
}
const logged = (re: RegExp) => waitFor(() => re.test(d.log()), 5000, String(re));

test('reviewed: stored once, in the next hello', async () => {
  const hello = await sendThenHello({ t: 'reviewed', agentId: 'aaaa0002' }, { t: 'reviewed', agentId: 'aaaa0002' }, { t: 'reviewed' });
  assert.deepEqual(hello.reviewed, ['aaaa0002']);
});

test('layout: reconciled with the open sessions (unknown and repeated ids dropped, the rest in others)', async () => {
  const hello = await sendThenHello({ t: 'layout', layout: { groups: [{ id: 'g1', name: 'Work', ids: [S2, S1, 'nope', S2] }, { id: 'g2', name: '', ids: [] }], others: [S3] } });
  assert.deepEqual(hello.layout, { groups: [{ id: 'g1', name: 'Work', ids: [S2, S1] }], others: [S3, S4, S5] });
  const again = await sendThenHello({ t: 'layout' }, { t: 'layout', layout: 'flat' });
  assert.deepEqual(again.layout, hello.layout, 'a layout frame without an object layout changes nothing');
});

test('ui: the patch is stored and comes back in hello', async () => {
  const hello = await sendThenHello({ t: 'ui', patch: { current: S2, view: null, mode: 'insert', openList: { filter: 'demo' }, theme: 'dark' } });
  const ui = hello.ui as Record<string, unknown>;
  assert.equal(ui.current, S2);
  assert.equal(ui.mode, 'insert');
  assert.deepEqual(ui.openList, { filter: 'demo' });
  assert.equal(ui.theme, 'dark');
  const later = (await sendThenHello({ t: 'ui', patch: { openList: null } })).ui as Record<string, unknown>;
  assert.equal(later.openList, null, 'null clears a field');
  assert.equal(later.current, S2, 'the rest stays');
});

test('open: a path or an http link is planned and logged (dry run), anything else is a toast', async () => {
  const dir = tmp('router'), file = join(dir, 'notes.txt');
  writeFileSync(file, 'a\n');
  const p = await connectPage(d.info);
  p.send({ t: 'open', path: file });
  await logged(/ open how=open dry=true/);
  p.send({ t: 'open', path: dir });
  await logged(/ open how=reveal dry=true/);
  p.send({ t: 'open', url: 'https://example.com/x' });
  await logged(/ open how=url dry=true/);
  const at = p.frames.length;
  p.send({ t: 'open', url: 'file:///etc/hosts' });
  assert.equal((await p.next('toast', () => true, 5000, at)).text, 'Only http and https links open from Synopia.');
  p.send({ t: 'open', path: 'relative/notes.txt' });
  assert.match(String((await p.next('toast', (m) => m !== p.frames[at], 5000, at + 1)).text), /the path is not absolute/);
  await p.close();
});

test('preview: a text file comes back as a preview frame; a missing one is a toast', async () => {
  const file = join(tmp('router'), 'notes.txt');
  writeFileSync(file, 'one\ntwo\nthree\n');
  const p = await connectPage(d.info);
  p.send({ t: 'preview', path: file, theme: 'dark' });
  const r = await p.next('preview');
  assert.equal(r.path, file);
  assert.equal(r.lines, 3);
  assert.equal(typeof r.html, 'string');
  assert.equal(String(r.html).split('\n').length >= 3, true);
  const at = p.frames.length;
  p.send({ t: 'preview', path: join(tmp('router'), 'gone.txt') });
  assert.match(String((await p.next('toast', () => true, 5000, at)).text), /no longer exists/);
  await p.close();
});

test('a frame of an unknown type is logged and ignored; one without a type is a bad frame', async () => {
  const p = await connectPage(d.info);
  p.send({ t: 'bogus', x: 1 });
  await logged(/ ws\.ignored t=bogus/);
  p.send({ x: 1 });
  p.ws.send('not json');
  await waitFor(() => (d.log().match(/ ws\.badFrame/g) || []).length >= 2, 5000, 'two ws.badFrame lines');
  // the socket stays open and the daemon answers
  p.send({ t: 'view', sid: S1, agent: null });
  assert.equal((await p.next('items')).sid, S1);
  await p.close();
});
