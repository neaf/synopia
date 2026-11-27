// The page's frames through a real daemon's socket (router.ts), on the fixture tree under the scripted SDK:
// what each one changes, as the next hello or a reply shows it, the ack of an action, and the log line of
// one it ignores. Then the router alone, on stand-ins: a handler that throws, and a stop with an action
// still running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, connectPage, waitFor, scripted, tmp, api } from './daemon-harness.ts';
import type { Daemon } from './daemon-harness.ts';
import { Router, FAILED, STOPPING, UNREADABLE } from '../src/router.ts';
import type { RouterOptions } from '../src/router.ts';
import type { Client } from '../src/server.ts';

const S1 = '11111111-0000-4000-8000-000000000001', S2 = '22222222-0000-4000-8000-000000000002', S3 = '33333333-0000-4000-8000-000000000003';
const S4 = '44444444-0000-4000-8000-000000000004', S5 = '55555555-0000-4000-8000-000000000005';
const REVIEW = 'aaaa0004'; // S4's "For review: Draft the demo release notes", finished

let d: Daemon;
test.before(async () => { d = await startDaemon([...scripted(), '--no-parent', '--dry-run']); });
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

test('item reviewed: Mark reviewed closes the review item; the next hello shows the deliverable reviewed and the badge drops (R10.2, FR-ITEM-03)', async () => {
  type S = { id: string; state: { review: number }; agents: { id: string; review: boolean }[]; openItems: { items: { id: string; kind: string; agent?: string }[]; closed: { id: string; note: string }[] } };
  const of = (hello: Record<string, unknown>) => (hello.sessions as S[]).find((s) => s.id === S4)!;
  const badge = async () => ((await (await api(d.info, 'badge')).json()) as { badge: number }).badge;
  const before = of(await sendThenHello());
  assert.equal(before.agents.find((a) => a.id === REVIEW)?.review, true, 'a finished "For review: …" subagent');
  assert.equal(before.state.review, 1);
  const item = before.openItems.items.find((i) => i.kind === 'review' && i.agent === REVIEW);
  assert.ok(item, 'its review item');
  const n = await badge();
  const hello = await sendThenHello({ t: 'item', sid: S4, item: item.id, act: 'reviewed' }, { t: 'item', sid: S4, item: item.id, act: 'reviewed' }, { t: 'item', sid: S4 });
  const after = of(hello);
  assert.equal(after.agents.find((a) => a.id === REVIEW)?.review, false);
  assert.equal(after.state.review, 0);
  assert.equal(after.openItems.items.some((i) => i.id === item.id), false);
  assert.equal(await badge(), n - 1);
  assert.equal(hello.reviewed, undefined, 'the page gets the marks only as the items and the subagents\' review flag');
});

test('layout: intents change the layout every page gets, and the next hello has it; a refused one is acked with why', async () => {
  const p = await connectPage(d.info), q = await connectPage(d.info);
  assert.deepEqual(p.hello.layout, { groups: [], others: [S1, S2, S3, S4, S5] }, 'every open session has a place');
  p.send({ t: 'newGroup', id: 'n1', sid: S2, onto: S1, group: 'g1' });
  assert.deepEqual(await p.next('ack', (m) => m.id === 'n1'), { t: 'ack', id: 'n1', ok: true });
  p.send({ t: 'renameGroup', id: 'r1', group: 'g1', name: ' Work ' });
  p.send({ t: 'moveSession', id: 'm1', sid: S3, before: S1 });
  assert.equal((await p.next('ack', (m) => m.id === 'm1')).ok, true);
  const want = { groups: [{ id: 'g1', name: 'Work', ids: [S3, S1, S2] }], others: [S4, S5] };
  assert.deepEqual((await q.next('layout', (m) => JSON.stringify(m.layout) === JSON.stringify(want))).layout, want, 'the other page gets it too');
  p.send({ t: 'moveSession', id: 'm2', sid: S4, group: 'g9' });
  assert.deepEqual(await p.next('ack', (m) => m.id === 'm2'), { t: 'ack', id: 'm2', ok: false, error: 'That group is gone.' });
  await p.close(); await q.close();
  const hello = await sendThenHello({ t: 'layout', layout: { groups: [], others: [] } });
  assert.deepEqual(hello.layout, want, 'the whole-layout frame is gone: ignored');
  await logged(/ router\.unknown t=layout/);
  // back as it was, for the other tests
  await sendThenHello({ t: 'moveSession', sid: S3, group: 'others' }, { t: 'moveSession', sid: S1, group: 'others' }, { t: 'moveSession', sid: S2, group: 'others' });
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
  // not text: opened as `open` would, and the page hears so
  const pdf = join(tmp('router'), 'report.pdf');
  writeFileSync(pdf, '%PDF-1.4\n');
  p.send({ t: 'preview', path: pdf });
  assert.deepEqual(await p.next('preview', (m) => m.path === pdf), { t: 'preview', path: pdf, opened: true });
  await logged(/ preview\.open/);
  await p.close();
});

test('a frame of an unknown type is logged and ignored; one without a type is a bad frame', async () => {
  const p = await connectPage(d.info);
  p.send({ t: 'bogus', x: 1 });
  await logged(/ router\.unknown t=bogus/);
  p.send({ x: 1 });
  p.ws.send('not json');
  await waitFor(() => (d.log().match(/ ws\.badFrame/g) || []).length >= 2, 5000, 'two ws.badFrame lines');
  // the socket stays open and the daemon answers
  p.send({ t: 'view', sid: S1, agent: null });
  assert.equal((await p.next('items')).sid, S1);
  await p.close();
});

test('actions: one ack each, to the page that sent it, with the error when not done; none without an id', async () => {
  const p = await connectPage(d.info), q = await connectPage(d.info);
  p.send({ t: 'close', id: 'c1', sid: 'not-a-session' });
  assert.deepEqual(await p.next('ack', (m) => m.id === 'c1'), { t: 'ack', id: 'c1', ok: false, error: "That session isn't open any more." });
  p.send({ t: 'item', id: 'r1', sid: S4, item: 'Y99', act: 'reviewed' }); // no such item
  assert.deepEqual(await p.next('ack', (m) => m.id === 'r1'), { t: 'ack', id: 'r1', ok: false, error: "That item isn't in an open session's list any more." });
  p.send({ t: 'answer', id: 'a1', sid: S2 }); // no requestId
  assert.deepEqual(await p.next('ack', (m) => m.id === 'a1'), { t: 'ack', id: 'a1', ok: false, error: UNREADABLE });
  await logged(/ router\.invalid t=answer problem="?answer\.requestId missing/);
  p.send({ t: 'setModel', id: 'm1', sid: S1, model: 'default' }); // async: acked once done
  assert.equal((await p.next('ack', (m) => m.id === 'm1')).ok, true);
  const at = p.frames.length;
  p.send({ t: 'close', sid: 'not-a-session' }); // no id: no ack
  p.send({ t: 'item', id: 'r2', sid: 'not-a-session', item: 'Y1', act: 'reviewed' });
  await p.next('ack', (m) => m.id === 'r2', 5000, at);
  assert.deepEqual(p.frames.slice(at).filter((m) => m.t === 'ack').map((m) => m.id), ['r2']);
  assert.equal(q.frames.some((m) => m.t === 'ack'), false, 'only the page that acted');
  await p.close(); await q.close();
});

// ---------- the router alone ----------

type Sent = { to: Client; msg: Record<string, unknown> };
function standIn(session: Record<string, unknown>) {
  const sent: Sent[] = [], lines: string[] = [];
  const opts = {
    sessions: { resolve: (id: string) => id, get: (id: string) => (id === 'S' ? session : undefined) },
    publisher: { reply: (to: Client, msg: Record<string, unknown>) => sent.push({ to, msg }), toast: () => {} },
    log: (event: string, fields?: object) => lines.push(`${event} ${JSON.stringify(fields ?? {})}`),
  } as unknown as RouterOptions;
  const page = { send: () => {}, close: () => {}, buffered: () => 0 } as Client;
  return { router: new Router(opts), sent, lines, page, acks: () => sent.map((s) => s.msg) };
}

test('router: a handler that throws acks ok:false and is logged; the next frame is served (NFR-07)', () => {
  const r = standIn({ send: () => { throw new TypeError('boom'); }, cancelTakeover: () => ({ ok: true, sid: 'S' }) });
  r.router.handle(r.page, { t: 'send', id: 'x1', sid: 'S', text: 'hi' });
  r.router.handle(r.page, { t: 'cancelTakeover', id: 'x2', sid: 'S' });
  assert.deepEqual(r.acks(), [{ t: 'ack', id: 'x1', ok: false, error: FAILED }, { t: 'ack', id: 'x2', ok: true }]);
  assert.match(r.lines[0], /^router\.failed .*"t":"send".*"error":"TypeError"/);
});

test('router: an async action that rejects acks ok:false; one without an id is only logged', async () => {
  const r = standIn({ background: () => Promise.reject(new RangeError('no')) });
  r.router.handle(r.page, { t: 'background', id: 'b1', sid: 'S' });
  r.router.handle(r.page, { t: 'background', sid: 'S' });
  await new Promise((ok) => setTimeout(ok, 10));
  assert.deepEqual(r.acks(), [{ t: 'ack', id: 'b1', ok: false, error: FAILED }]);
  assert.equal(r.lines.filter((l) => l.startsWith('router.failed')).length, 2);
});

test('router: stop acks an action still running at once, and refuses every later one', async () => {
  let finish: (v: unknown) => void = () => {};
  const r = standIn({ setModel: () => new Promise((ok) => { finish = ok; }) });
  r.router.handle(r.page, { t: 'setModel', id: 'm1', sid: 'S', model: 'x' });
  assert.deepEqual(r.acks(), []);
  r.router.stop();
  assert.deepEqual(r.acks(), [{ t: 'ack', id: 'm1', ok: false, error: STOPPING }]);
  finish({ ok: true, sid: 'S' });
  await new Promise((ok) => setTimeout(ok, 10));
  r.router.handle(r.page, { t: 'close', id: 'c1', sid: 'S' });
  r.router.handle(r.page, { t: 'view', sid: 'S' });
  assert.deepEqual(r.acks(), [{ t: 'ack', id: 'm1', ok: false, error: STOPPING }, { t: 'ack', id: 'c1', ok: false, error: STOPPING }], 'acked once, and the later one refused');
});
