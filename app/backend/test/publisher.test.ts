import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transcripts } from '../src/transcripts.ts';
import { Publisher, WINDOW } from '../src/publisher.ts';
import type { PublisherOptions } from '../src/publisher.ts';
import type { Client } from '../src/server.ts';
import { Sessions } from '../src/sessions.ts';
import { openStore } from '../src/store.ts';
import { OpenItems } from '../src/open-items.ts';
import { emit, fakeQuery } from './support/fake-query.ts';

const CLAUDE = path.join(import.meta.dirname, 'fixtures', 'claude');
const HOME = '/Users/fixture';
const AGENTS = '44444444-0000-4000-8000-000000000004';

type Msg = { t: string; [k: string]: unknown };
function client(): Client & { got: Msg[]; take: (t?: string) => Msg[] } {
  const got: Msg[] = [];
  return {
    got,
    send: (m) => got.push(JSON.parse(JSON.stringify(m))),
    close: () => {},
    take(t) {
      const out = got.filter((m) => !t || m.t === t);
      got.length = 0;
      return out;
    },
  };
}

// The reading set and the publisher, with no timers (tests call poll()).
function reading(claudeDir: string, clients: () => Set<Client>, o: Partial<PublisherOptions> = {}) {
  const transcripts = new Transcripts({ claudeDir, home: HOME, pollMs: 0, watch: false, written: o.written as never });
  const publisher = new Publisher({ transcripts, clients, home: HOME, recheckMs: 0, ...o });
  return { transcripts, publisher };
}

function setup(claudeDir: string) {
  const clients = new Set<Client>();
  const { transcripts, publisher } = reading(claudeDir, () => clients);
  return { clients, transcripts, publisher };
}

const line = (o: object) => JSON.stringify(o) + '\n';
const you = (i: number) => line({ type: 'user', uuid: `u${i}`, timestamp: `2026-11-20T10:00:${String(i % 60).padStart(2, '0')}.000Z`, message: { role: 'user', content: `prompt ${i}` } });

function tempSession(id: string, body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-publisher-'));
  fs.mkdirSync(path.join(dir, 'projects', '-tmp-x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects', '-tmp-x', `${id}.jsonl`), body);
  return dir;
}

test('view: a reset with the items, then upserts for changed ids only', async () => {
  const id = 'aaaaaaaa-0000-4000-8000-00000000000a';
  const dir = tempSession(id, you(1) + line({
    type: 'assistant', uuid: 'a1', timestamp: '2026-11-20T10:00:02.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'ls' } }] },
  }));
  const { clients, transcripts, publisher } = setup(dir);
  const c = client();
  clients.add(c);
  transcripts.open(id);
  await Promise.resolve();
  const meta = c.take('session');
  assert.equal(meta.length, 1);
  assert.equal(meta[0].title, 'prompt 1');
  assert.equal((meta[0].state as { status: string }).status, 'busy', 'its last tool has no result yet: the turn runs (status.ts)');

  publisher.view(c, id, null);
  const [reset] = c.take('items');
  assert.equal(reset.reset, true);
  assert.equal(reset.total, 2);
  assert.deepEqual((reset.upsert as { id: string }[]).map((i) => i.id), ['u1', 'toolu_x']);

  // The tool's result changes one item, and a new prompt adds one.
  const file = path.join(dir, 'projects', '-tmp-x', `${id}.jsonl`);
  fs.appendFileSync(file, line({
    type: 'user', uuid: 'r1', timestamp: '2026-11-20T10:00:03.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }] },
  }) + you(4));
  transcripts.poll();
  const ups = c.take('items');
  assert.equal(ups.length, 1);
  assert.equal(ups[0].reset, false);
  assert.equal(ups[0].total, 3);
  const items = ups[0].upsert as { id: string; state?: string }[];
  assert.deepEqual(items.map((i) => i.id), ['toolu_x', 'u4']);
  assert.equal(items[0].state, 'done');

  // Nothing new: nothing sent. A page that left gets nothing.
  transcripts.poll();
  assert.equal(c.take('items').length, 0);
  clients.delete(c);
  fs.appendFileSync(file, you(5));
  transcripts.poll();
  assert.equal(c.take().length, 0);

  // A rewritten file resets the view.
  clients.add(c);
  publisher.view(c, id, null);
  c.take();
  fs.writeFileSync(file + '.new', you(9));
  fs.renameSync(file + '.new', file);
  transcripts.poll();
  const after = c.take('items');
  assert.equal(after.length, 1);
  assert.equal(after[0].reset, true);
  assert.deepEqual((after[0].upsert as { id: string }[]).map((i) => i.id), ['u9']);
  transcripts.stop(); publisher.stop();
});

test('view: the last 160 items with the total', () => {
  const id = 'bbbbbbbb-0000-4000-8000-00000000000b';
  let body = '';
  for (let i = 0; i < 400; i++) body += you(i);
  const { clients, transcripts, publisher } = setup(tempSession(id, body));
  const c = client();
  clients.add(c);
  transcripts.open(id);
  publisher.view(c, id, null);
  const [reset] = c.take('items');
  const items = reset.upsert as { id: string }[];
  assert.equal(WINDOW, 160);
  assert.equal(items.length, 160);
  assert.equal(reset.total, 400);
  assert.equal(items[0].id, 'u240');
  assert.equal(items[159].id, 'u399');
  transcripts.stop(); publisher.stop();
});

test('subagents: agents and background in hello, and a subagent view', async () => {
  const { clients, transcripts, publisher } = setup(CLAUDE);
  const c = client();
  clients.add(c);
  transcripts.open(AGENTS);
  await Promise.resolve();
  const agents = c.take('agents');
  assert.equal(agents.length, 1);
  const ids = (agents[0].upsert as { id: string }[]).map((a) => a.id);
  assert.deepEqual(ids, ['aaaa0001', 'aaaa0002', 'aaaa0003', 'aaaa0004', 'aaaa0005', 'aaaa0006']);

  const [hello] = publisher.sessions() as { id: string; agents: { id: string; running: boolean; total: number }[] }[];
  assert.equal(hello.id, AGENTS);
  const a2 = hello.agents.find((a) => a.id === 'aaaa0002');
  assert.equal(a2?.running, true);
  assert.equal(a2?.total, 2);

  publisher.view(c, AGENTS, 'aaaa0002');
  const [reset] = c.take('items');
  assert.equal(reset.agent, 'aaaa0002');
  assert.equal(reset.reset, true);
  assert.equal(reset.total, 2);
  assert.deepEqual((reset.upsert as { k: string }[]).map((i) => i.k), ['you', 'claude']);

  // An unknown subagent gives an empty reset, not an error.
  publisher.view(c, AGENTS, 'nope');
  const [empty] = c.take('items');
  assert.deepEqual([empty.total, (empty.upsert as unknown[]).length], [0, 0]);
  transcripts.stop(); publisher.stop();
});

test('status, pending, a stream clear and close are broadcast; the stream text goes to its viewers (FR-VIEW-17)', async () => {
  const { clients, transcripts, publisher } = setup(CLAUDE);
  const c = client();
  clients.add(c);
  transcripts.open(AGENTS);
  await Promise.resolve();
  c.take();
  publisher.setStatus(AGENTS, 'busy', 5);
  assert.deepEqual(c.take('session').map((m) => [(m.state as { status: string }).status, (m.state as { since: number }).since]), [['busy', 5]]);
  publisher.setPending(AGENTS, { id: 'r1', kind: 'plan', since: 1 });
  assert.deepEqual(publisher.pending().map((p) => p.request.id), ['r1']);
  publisher.clearPending(AGENTS, 'r1');
  assert.deepEqual(c.take('pending').map((m) => [m.request ? 'request' : 'cleared']), [['request'], ['cleared']]);
  const viewer = client(), late = client();
  clients.add(viewer);
  clients.add(late);
  publisher.view(viewer, AGENTS, null);
  publisher.setStream(AGENTS, 'Hel');
  publisher.view(late, AGENTS, null);
  publisher.setStream(AGENTS, null);
  assert.deepEqual(c.take('stream').map((m) => m.text ?? m.clear), [true], 'not viewing: only the clear');
  assert.deepEqual(viewer.take('stream').map((m) => m.text ?? m.clear), ['Hel', true]);
  assert.deepEqual(late.take('stream').map((m) => m.text ?? m.clear), ['Hel', true], 'a page that starts viewing gets the text so far');
  transcripts.close(AGENTS);
  assert.deepEqual(c.take('removed'), [{ t: 'removed', id: AGENTS }]);
  assert.equal(publisher.sessions().length, 0);
});

test('state: a turned-down tool reads "Your turn", an Esc Esc stop "Stopped", a retitle after it keeps it', () => {
  const id = 'aaaaaaaa-0000-4000-8000-0000000000ac';
  const marker = (uuid: string, s: number, text: string) => line({ type: 'user', uuid, timestamp: `2026-11-20T10:00:0${s}.000Z`, message: { role: 'user', content: [{ type: 'text', text }] } });
  const dir = tempSession(id, you(1) + marker('x2', 2, '[Request interrupted by user for tool use]'));
  const { transcripts, publisher } = setup(dir);
  transcripts.open(id);
  transcripts.poll();
  publisher.setStatus(id, 'idle', 5);
  const word = () => { const st = publisher.meta(id)!.state; return [st.word, st.stopped, st.mark]; };
  assert.deepEqual(word(), ['Your turn', false, 'stopped']);
  const file = path.join(dir, 'projects', '-tmp-x', `${id}.jsonl`);
  fs.appendFileSync(file, you(3) + marker('x4', 4, '[Request interrupted by user]'));
  transcripts.poll();
  assert.deepEqual(word(), ['Stopped', true, 'stopped']);
  fs.appendFileSync(file, line({ type: 'custom-title', customTitle: 'Renamed', sessionId: id }));
  transcripts.poll();
  assert.equal(publisher.meta(id)!.title, 'Renamed');
  assert.deepEqual(word(), ['Stopped', true, 'stopped'], 'a retitle is no new turn');
  publisher.setStatus(id, 'busy', 6);
  assert.deepEqual(word(), ['Thinking', false, 'work']);
  transcripts.stop(); publisher.stop();
});

test('review: a finished "For review: …" subagent is sent with review while its review item is open, and counts in the state (R10.1, FR-ITEM-03)', async () => {
  const clients = new Set<Client>();
  const store = openStore(fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-publisher-')), { minIntervalMs: 0 });
  let publisher: Publisher | null = null;
  const transcripts = new Transcripts({ claudeDir: CLAUDE, home: HOME, pollMs: 0, watch: false });
  const openItems = new OpenItems({
    store, home: HOME, lookMs: 0,
    facts: { ledgerOf: (sid) => transcripts.ledgerOf(sid), ownsOf: (sid, t) => transcripts.ownsOf(sid, t), agents: (sid) => transcripts.get(sid)?.agents() ?? [], lastYouAt: (sid) => transcripts.lastYouAt(sid), replies: (sid) => transcripts.replies(sid) },
    onChange: (sids) => { for (const s of sids) publisher?.changed(s); },
  });
  publisher = new Publisher({ transcripts, clients: () => clients, home: HOME, recheckMs: 0, openItems });
  const c = client();
  clients.add(c);
  transcripts.open(AGENTS);
  await Promise.resolve();
  type Hello = { agents: { id: string; review: boolean }[]; state: { review: number; waiting: number; due: number }; openItems: { items: { id: string; kind: string; text: string; agent?: string }[] } };
  const agent = (list: { id: string; review: boolean }[]) => list.find((a) => a.id === 'aaaa0004')?.review;
  const hello = () => (publisher!.sessions() as Hello[])[0];
  assert.deepEqual([agent(hello().agents), hello().state.review, hello().state.waiting, hello().state.due], [true, 1, 0, 0]);
  const item = hello().openItems.items.find((i) => i.agent === 'aaaa0004')!;
  assert.deepEqual([item.kind, item.text], ['review', 'Review: Draft the demo release notes']);
  const frame = c.take('openItems').at(-1) as { sid: string; items: unknown[] } | undefined;
  assert.deepEqual([frame?.sid, frame?.items.length], [AGENTS, 1], 'every page gets the list');
  c.take();
  assert.equal(openItems.markReviewed(AGENTS, item.id), true);
  const got = c.take();
  assert.equal(agent(got.find((m) => m.t === 'agents')!.upsert as { id: string; review: boolean }[]), false, 'the agent goes again with its flag');
  assert.deepEqual((got.find((m) => m.t === 'openItems') as { items: unknown[] }).items, [], 'and the list without it');
  assert.deepEqual([agent(hello().agents), hello().state.review], [false, 0]);
  transcripts.stop(); publisher.stop(); store.close();
});

test('model: a new session with no choice shows settings.model, not the CLI default', () => {
  const clients = new Set<Client>();
  const { transcripts, publisher } = reading(CLAUDE, () => clients, { defaultModel: () => 'haiku' });
  transcripts.open('new-1', { cwd: '/tmp/x' });
  assert.equal((publisher.sessions() as { id: string; model: unknown }[]).find((s) => s.id === 'new-1')!.model, 'haiku');
});

test('earlier: pages of 160 before an id, down to the first, then nothing', () => {
  const id = 'eeeeeeee-0000-4000-8000-00000000000e';
  let body = '';
  for (let i = 0; i < 400; i++) body += you(i);
  const dir = tempSession(id, body);
  const { clients, transcripts, publisher } = setup(dir);
  const c = client(), other = client();
  clients.add(c);
  clients.add(other);
  transcripts.open(id);
  transcripts.poll(); // the first read's changes go out before the pages view it
  publisher.view(c, id, null);
  publisher.view(other, id, null);
  c.take();
  other.take();
  const ids = (m: Msg) => (m.upsert as { id: string }[]).map((i) => i.id);

  // Before the oldest shown (u240): u80 to u239, in order, marked prepend.
  assert.equal(publisher.earlier(c, id, null, 'u240'), 160);
  const [p1] = c.take('items');
  assert.equal(p1.prepend, true);
  assert.equal(p1.reset, false);
  assert.equal(p1.total, 400);
  assert.deepEqual(ids(p1), Array.from({ length: 160 }, (_, i) => `u${80 + i}`));

  // The next page stops at the first item: 80 left.
  assert.equal(publisher.earlier(c, id, null, 'u80'), 80);
  const [p2] = c.take('items');
  assert.equal(ids(p2)[0], 'u0');
  assert.equal(ids(p2).length, 80);
  // At the start of history there is nothing before u0 (the page shows no link then).
  publisher.earlier(c, id, null, 'u0');
  assert.deepEqual(c.take('items').map(ids), [[]]);
  // An id not in the transcript, or another conversation than the one viewed: no reply.
  assert.equal(publisher.earlier(c, id, null, 'nope'), 0);
  assert.equal(publisher.earlier(c, id, 'aaaa0001', 'u80'), 0);
  assert.equal(c.take().length, 0);

  // Later items still arrive as upserts, on both pages.
  const file = path.join(dir, 'projects', '-tmp-x', `${id}.jsonl`);
  fs.appendFileSync(file, you(400));
  transcripts.poll();
  assert.deepEqual(c.take('items').map(ids), [['u400']]);
  assert.deepEqual(other.take('items').map(ids), [['u400']]);

  // A rewrite resets the loaded range back to the last 160.
  let again = '';
  for (let i = 0; i < 300; i++) again += you(i);
  fs.writeFileSync(file + '.new', again);
  fs.renameSync(file + '.new', file);
  transcripts.poll();
  const [reset] = c.take('items');
  assert.equal(reset.reset, true);
  assert.equal(ids(reset).length, 160);
  assert.equal(ids(reset)[0], 'u140');
  // So does a new `view`.
  publisher.earlier(c, id, null, 'u140');
  c.take();
  publisher.view(c, id, null);
  assert.equal(ids(c.take('items')[0])[0], 'u140');
  transcripts.stop(); publisher.stop();
});

test('view from: one reset from the oldest item the page had loaded, else the last 160', () => {
  const id = 'edededed-0000-4000-8000-0000000000ed';
  let body = '';
  for (let i = 0; i < 400; i++) body += you(i);
  const dir = tempSession(id, body);
  const { clients, transcripts, publisher } = setup(dir);
  const c = client();
  clients.add(c);
  transcripts.open(id);
  transcripts.poll();
  c.take();
  const ids = (m: Msg) => (m.upsert as { id: string }[]).map((i) => i.id);

  // From u50: one reset with u50 to u399, and nothing else.
  publisher.view(c, id, null, 'u50');
  const got = c.take();
  assert.equal(got.length, 1);
  assert.equal(got[0].reset, true);
  assert.equal(got[0].total, 400);
  assert.deepEqual(ids(got[0]), Array.from({ length: 350 }, (_, i) => `u${50 + i}`));
  // Earlier items go on before u50.
  assert.equal(publisher.earlier(c, id, null, 'u50'), 50);
  assert.equal(ids(c.take('items')[0])[0], 'u0');

  // An id within the last 160, an unknown id, none: the last 160.
  for (const from of ['u300', 'nope', null, undefined]) {
    publisher.view(c, id, null, from);
    const [r] = c.take('items');
    assert.equal(r.reset, true);
    assert.equal(ids(r).length, 160, String(from));
    assert.equal(ids(r)[0], 'u240', String(from));
  }
  // The first item: everything.
  publisher.view(c, id, null, 'u0');
  assert.equal(ids(c.take('items')[0]).length, 400);
  // A rewrite after that resets to the last 160 of the new file, as before.
  const file = path.join(dir, 'projects', '-tmp-x', `${id}.jsonl`);
  let again = '';
  for (let i = 0; i < 300; i++) again += you(i);
  fs.writeFileSync(file + '.new', again);
  fs.renameSync(file + '.new', file);
  transcripts.poll();
  assert.equal(ids(c.take('items')[0])[0], 'u140');
  transcripts.stop(); publisher.stop();
});

test('view from: an item loaded through from gets its upserts', () => {
  const id = 'edededed-0000-4000-8000-0000000000ee';
  let body = line({
    type: 'assistant', uuid: 'a0', timestamp: '2026-11-20T10:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_old', name: 'Bash', input: { command: 'sleep 1' } }] },
  });
  for (let i = 1; i < 200; i++) body += you(i);
  const dir = tempSession(id, body);
  const { clients, transcripts, publisher } = setup(dir);
  const c = client();
  clients.add(c);
  transcripts.open(id);
  transcripts.poll();
  c.take();
  publisher.view(c, id, null, 'toolu_old');
  assert.equal((c.take('items')[0].upsert as { id: string }[]).length, 200);
  fs.appendFileSync(path.join(dir, 'projects', '-tmp-x', `${id}.jsonl`), line({
    type: 'user', uuid: 'r0', timestamp: '2026-11-20T10:00:01.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_old', content: 'ok' }] },
  }));
  transcripts.poll();
  assert.deepEqual((c.take('items')[0].upsert as { id: string; state: string }[]).map((i) => [i.id, i.state]), [['toolu_old', 'done']]);
  transcripts.stop(); publisher.stop();
});

test('earlier: an item loaded earlier gets its upserts, only on the page that loaded it', () => {
  const id = 'efefefef-0000-4000-8000-0000000000ef';
  let body = line({
    type: 'assistant', uuid: 'a0', timestamp: '2026-11-20T10:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_old', name: 'Bash', input: { command: 'sleep 1' } }] },
  });
  for (let i = 1; i < 200; i++) body += you(i);
  const dir = tempSession(id, body);
  const { clients, transcripts, publisher } = setup(dir);
  const c = client(), other = client();
  clients.add(c);
  clients.add(other);
  transcripts.open(id);
  transcripts.poll();
  publisher.view(c, id, null);
  publisher.view(other, id, null);
  publisher.earlier(c, id, null, (c.take('items')[0].upsert as { id: string }[])[0].id);
  other.take();
  assert.equal((c.take('items')[0].upsert as { id: string }[])[0].id, 'toolu_old');
  fs.appendFileSync(path.join(dir, 'projects', '-tmp-x', `${id}.jsonl`), line({
    type: 'user', uuid: 'r0', timestamp: '2026-11-20T10:00:01.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_old', content: 'ok' }] },
  }));
  transcripts.poll();
  const [up] = c.take('items');
  assert.deepEqual((up.upsert as { id: string; state: string }[]).map((i) => [i.id, i.state]), [['toolu_old', 'done']]);
  assert.equal(other.take('items').length, 0);
  transcripts.stop(); publisher.stop();
});

test('earlier: a subagent view pages its own transcript', () => {
  const id = 'fefefefe-0000-4000-8000-0000000000fe';
  const dir = tempSession(id, you(0));
  const sub = path.join(dir, 'projects', '-tmp-x', id, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  let body = '';
  for (let i = 0; i < 250; i++) {
    body += line({
      type: 'assistant', uuid: `s${i}`, timestamp: '2026-11-20T10:01:00.000Z', isSidechain: true, agentId: 'bbbb0001',
      message: { role: 'assistant', content: [{ type: 'text', text: `step ${i}` }] },
    });
  }
  fs.writeFileSync(path.join(sub, 'agent-bbbb0001.jsonl'), body);
  const { clients, transcripts, publisher } = setup(dir);
  const c = client();
  clients.add(c);
  transcripts.open(id);
  transcripts.poll();
  publisher.view(c, id, 'bbbb0001');
  const [reset] = c.take('items');
  const shown = reset.upsert as { id: string; text: string }[];
  assert.equal(reset.total, 250);
  assert.equal(shown.length, 160);
  assert.equal(shown[0].text, 'step 90');
  // The main conversation's `earlier` doesn't answer for the subagent view.
  assert.equal(publisher.earlier(c, id, null, shown[0].id), 0);
  assert.equal(publisher.earlier(c, id, 'bbbb0001', shown[0].id), 90);
  const [p] = c.take('items');
  assert.equal(p.agent, 'bbbb0001');
  assert.equal(p.prepend, true);
  assert.deepEqual((p.upsert as { text: string }[]).map((i) => i.text), Array.from({ length: 90 }, (_, i) => `step ${i}`));
  transcripts.stop(); publisher.stop();
});
test('rekey: a card, the held messages and the stream preview move to the new id (L5)', () => {
  const { transcripts, publisher } = setup(CLAUDE);
  transcripts.open('new-2', { cwd: '/tmp/x' });
  publisher.setPending('new-2', { id: 'r1', kind: 'question', since: 1 });
  publisher.setHeld('new-2', ['wait']);
  publisher.setStream('new-2', 'Partly');
  const id = 'aaaaaaaa-0000-4000-8000-0000000000cd';
  transcripts.rekey('new-2', id);
  assert.deepEqual(publisher.pending().map((p) => [p.sid, p.request.id]), [[id, 'r1']]);
  publisher.clearPending(id, 'r1');
  assert.deepEqual(publisher.pending(), []);
  const s = (publisher.sessions() as { id: string; held: string[]; stream: string | null }[]).find((x) => x.id === id)!;
  assert.deepEqual([s.held, s.stream], [['wait'], 'Partly']);
});

test('meta: the CLI ai-title is the name, shown when it is not the title and a terminal holds it (L3)', () => {
  const id = 'aaaaaaaa-0000-4000-8000-0000000000ce';
  const dir = tempSession(id, you(1) + line({ type: 'ai-title', aiTitle: 'Count the lines', sessionId: id }));
  const clients = new Set<Client>();
  let written: { title?: string } | undefined;
  const { transcripts, publisher } = reading(dir, () => clients, { written: () => written });
  transcripts.open(id);
  assert.deepEqual([publisher.meta(id)?.title, publisher.meta(id)?.name], ['Count the lines', '']);
  written = { title: 'Counting fixture lines' };
  assert.deepEqual([publisher.meta(id)?.title, publisher.meta(id)?.name], ['Counting fixture lines', ''], 'no tab: Synopia runs it or nothing does');
  publisher.setStatus(id, 'idle', 5, { terminal: 4242 });
  assert.deepEqual([publisher.meta(id)?.title, publisher.meta(id)?.name], ['Counting fixture lines', 'Count the lines']);
  publisher.setStatus(id, 'idle', 6);
  assert.equal(publisher.meta(id)?.name, '', 'the terminal let go of it');
});

test('work: a question or plan another process asks is a work line until answered (R6.8)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-ext-'));
  fs.cpSync(path.join(import.meta.dirname, 'fixtures', 'claude-ext'), dir, { recursive: true });
  const Q = 'e1e1e1e1-0000-4000-8000-00000000000a', P = 'e2e2e2e2-0000-4000-8000-00000000000b';
  const asks: string[] = [];
  const { transcripts, publisher } = reading(dir, () => new Set(), { onRunning: (sid, r) => asks.push(`${sid}:${r.ask?.toolUseId ?? ''}`) });
  transcripts.open(Q);
  transcripts.open(P);
  transcripts.poll();
  assert.deepEqual(publisher.work(Q), ['card waiting for you: question “Which release channel should the checklist target?” and 1 more']);
  assert.deepEqual(publisher.work(P), ['card waiting for you: approve the plan or ask for changes']);
  assert.ok(asks.includes(`${Q}:toolu_xask1`));
  fs.appendFileSync(path.join(dir, 'projects', '-tmp-ext', `${Q}.jsonl`), JSON.stringify({ type: 'user', uuid: 'x1-u3', timestamp: '2026-11-24T09:02:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_xask1', content: 'answered' }] } }) + '\n');
  transcripts.poll();
  assert.deepEqual(publisher.work(Q), []);
  assert.equal(asks.at(-1), `${Q}:`, 'the ask ending reaches onRunning (sessions tells the writer)');
  transcripts.stop(); publisher.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('work: a background shell ending between turns tells the writer, and its line says so', () => {
  const id = 'aaaaaaaa-0000-4000-8000-0000000000cf';
  const dir = tempSession(id, you(1) + line({
    type: 'assistant', uuid: 'a1', timestamp: '2026-11-20T10:00:02.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Bash', input: { command: 'sleep 90', description: 'Wait a while', run_in_background: true } }] },
  }));
  const ended: string[] = [];
  const { transcripts, publisher } = reading(dir, () => new Set(), { onWorkEnded: (sid) => ended.push(sid) });
  transcripts.open(id);
  transcripts.poll();
  assert.deepEqual(ended, [], 'reading it running is no end');
  assert.deepEqual(publisher.work(id), ['shell “Wait a while”: running']);
  transcripts.taskEnded(id, 'toolu_bg', 'killed', '');
  assert.deepEqual(ended, [id]);
  assert.deepEqual(publisher.work(id), ['shell “Wait a while”: killed']);
  transcripts.taskEnded(id, 'toolu_bg', 'killed', '');
  assert.deepEqual(ended, [id], 'once');
});

test('rekey: the work seen running moves with the record, so its end reaches the writer', () => {
  const id = 'aaaaaaaa-0000-4000-8000-0000000000d2', next = 'aaaaaaaa-0000-4000-8000-0000000000d3';
  const body = you(1) + line({
    type: 'assistant', uuid: 'a1', timestamp: '2026-11-20T10:00:02.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Bash', input: { command: 'sleep 90', description: 'Wait a while', run_in_background: true } }] },
  });
  const dir = tempSession(id, body);
  fs.writeFileSync(path.join(dir, 'projects', '-tmp-x', `${next}.jsonl`), body);
  const ended: string[] = [];
  const { transcripts, publisher } = reading(dir, () => new Set(), { onWorkEnded: (sid) => ended.push(sid) });
  transcripts.open(id);
  transcripts.poll();
  publisher.setChoice(id, { model: 'opus', effort: 'high' });
  transcripts.rekey(id, next);
  transcripts.taskEnded(next, 'toolu_bg', 'killed', ''); // before the new file's first flush: it reads ended at once
  assert.deepEqual(ended, [next]);
  assert.deepEqual([publisher.meta(next)?.model, publisher.meta(next)?.effort], ['opus', 'high'], 'the choice moved too');
  transcripts.stop(); publisher.stop();
});

test("work: the SDK's task_started gives a shell its task id when the file has none", () => {
  const id = 'aaaaaaaa-0000-4000-8000-0000000000d0';
  const dir = tempSession(id, you(1) + line({
    type: 'assistant', uuid: 'a1', timestamp: '2026-11-20T10:00:02.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Bash', input: { command: 'sleep 90', description: 'Wait a while', run_in_background: true } }] },
  }));
  const sent: { t?: string; upsert?: { toolUseId: string; taskId: string | null }[] }[] = [];
  const client = { send: (m: object) => sent.push(m) } as unknown as Client;
  const { transcripts, publisher } = reading(dir, () => new Set([client]));
  transcripts.open(id);
  transcripts.poll();
  sent.length = 0;
  transcripts.taskStarted(id, 'toolu_bg', 'b1x2');
  const up = sent.find((m) => m.t === 'background')?.upsert ?? [];
  assert.deepEqual(up.map((b) => [b.toolUseId, b.taskId]), [['toolu_bg', 'b1x2']]);
  transcripts.stop(); publisher.stop();
});

test("toolProgress: a running tool's start (now minus the elapsed time) goes with its item, once, and leaves with its result", () => {
  const id = 'aaaaaaaa-0000-4000-8000-0000000000d1';
  const dir = tempSession(id, you(1) + line({
    type: 'assistant', uuid: 'a1', timestamp: '2026-11-20T10:00:02.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_run', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }] },
  }));
  const { clients, transcripts, publisher } = setup(dir);
  const c = client();
  clients.add(c);
  transcripts.open(id);
  transcripts.poll();
  publisher.view(c, id, null);
  const tool = (m: Msg) => (m.upsert as { id: string; since?: string; state?: string }[]).find((i) => i.id === 'toolu_run');
  assert.equal(tool(c.take('items')[0])?.since, undefined, 'no progress yet: no start');
  const now = Date.parse('2026-11-20T10:01:00.000Z');
  publisher.toolProgress(id, 'toolu_run', 42, now);
  const [up] = c.take('items');
  assert.equal(up.reset, false);
  assert.deepEqual((up.upsert as unknown[]).length, 1);
  assert.equal(tool(up)?.since, '2026-11-20T10:00:18.000Z');
  publisher.toolProgress(id, 'toolu_run', 43, now + 1000);
  assert.deepEqual(c.take('items'), [], 'later progress changes nothing');
  publisher.toolProgress(id, 'toolu_none', -1, now);
  assert.deepEqual(c.take('items'), [], 'a bad elapsed time is ignored');
  publisher.view(c, id, null);
  assert.equal(tool(c.take('items')[0])?.since, '2026-11-20T10:00:18.000Z', 'a reset carries it too');
  fs.appendFileSync(path.join(dir, 'projects', '-tmp-x', `${id}.jsonl`), line({
    type: 'user', uuid: 'r1', timestamp: '2026-11-20T10:01:01.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_run', content: 'ok' }] },
  }));
  transcripts.poll();
  const done = tool(c.take('items')[0]);
  assert.equal(done?.state, 'done');
  assert.equal(done?.since, undefined, 'finished: no start');
  type Inner = { pubs: Map<string, { since: Map<string, number> }> };
  assert.equal((publisher as unknown as Inner).pubs.get(id)?.since.size, 0, 'its start is dropped when it ends');
  transcripts.stop(); publisher.stop();
});

test('state: thinking, then running a command once the Bash step has run 3 s by its tool_progress; thinking again at its result (R8.2, 2026-11-27)', async () => {
  const id = 'aaaaaaaa-0000-4000-8000-0000000000d2';
  const dir = tempSession(id, you(1) + line({
    type: 'assistant', uuid: 'a1', timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_cmd', name: 'Bash', input: { command: 'git worktree remove ../wt-3', description: 'Remove the worktree' } }] },
  }));
  const { clients, transcripts, publisher } = setup(dir);
  const c = client();
  clients.add(c);
  transcripts.open(id);
  transcripts.poll();
  publisher.setStatus(id, 'busy', Date.now());
  const st = () => publisher.meta(id)!.state;
  assert.deepEqual([st().word, st().mark, st().command], ['Thinking', 'work', null], 'under 3 s: the arc');
  publisher.toolProgress(id, 'toolu_cmd', 2.8); // after Allow once, it has run 2.8 s
  c.take();
  await new Promise((r) => setTimeout(r, 400));
  const sent = c.take('session').at(-1) as { state?: { word: string; mark: string; command: { obj: string; since: number } } } | undefined;
  assert.deepEqual([sent?.state?.word, sent?.state?.mark, sent?.state?.command.obj], ['Running a command', 'k_shell', 'Remove the worktree'], 'a flush when it reached 3 s');
  assert.ok(Math.abs(Date.now() - 400 - 2800 - (sent?.state?.command.since ?? 0)) < 150, 'its time counts from tool_progress');
  fs.appendFileSync(path.join(dir, 'projects', '-tmp-x', `${id}.jsonl`), line({
    type: 'user', uuid: 'r1', timestamp: new Date().toISOString(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_cmd', content: 'ok' }] },
  }));
  transcripts.poll();
  assert.deepEqual([st().word, st().mark, st().command], ['Thinking', 'work', null], 'its result landed: the model again');
  transcripts.stop(); publisher.stop();
});

test('state: a foreground subagent\'s command reaches the row; a background one leaves it idle, then your turn when it ended and Claude wrote (R8.2, 2026-11-27)', () => {
  const id = 'aaaaaaaa-0000-4000-8000-0000000000d3';
  const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
  const tu = (uuid: string, s: number, tid: string, name: string, input: object) => line({ type: 'assistant', uuid, timestamp: ago(s), message: { role: 'assistant', content: [{ type: 'tool_use', id: tid, name, input }] } });
  const dir = tempSession(id, you(1) + tu('a1', 60, 'toolu_fg', 'Agent', { description: 'Draft the release notes', prompt: 'made-up' }));
  const sub = path.join(dir, 'projects', '-tmp-x', id, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-ffff0001.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Draft the release notes', toolUseId: 'toolu_fg', spawnDepth: 1 }));
  fs.writeFileSync(path.join(sub, 'agent-ffff0001.jsonl'), line({ type: 'user', uuid: 's-u1', isSidechain: true, timestamp: ago(59), message: { role: 'user', content: 'made-up' } })
    + line({ type: 'assistant', uuid: 's-a1', isSidechain: true, timestamp: ago(41), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_docs', name: 'Bash', input: { command: 'npm run docs:build', description: 'Build the docs' } }] } }));
  const { transcripts, publisher } = setup(dir);
  transcripts.open(id);
  transcripts.poll();
  publisher.setStatus(id, 'busy', Date.now());
  const st = () => publisher.meta(id)!.state;
  assert.deepEqual([st().word, st().mark, st().command?.obj, st().command?.agent], ['Running a command', 'k_shell', 'Build the docs', 'Draft the release notes']);
  publisher.setStatus(id, 'idle', Date.now());
  assert.deepEqual([st().command, st().mark], [null, 's_agent'], 'no command once the turn is over (its subagent still runs)');
  transcripts.stop(); publisher.stop();
  // the main turn is over and a background subagent runs: idle, then its end leaves a report to read
  const id2 = 'aaaaaaaa-0000-4000-8000-0000000000d4';
  const dir2 = tempSession(id2, you(1) + tu('b1', 30, 'toolu_bg', 'Agent', { description: 'Profile the resize step', prompt: 'made-up', run_in_background: true })
    + line({ type: 'user', uuid: 'b2', timestamp: ago(29), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: 'Async agent launched successfully.' }] } })
    + line({ type: 'assistant', uuid: 'b3', timestamp: ago(28), message: { role: 'assistant', content: [{ type: 'text', text: 'It runs; I will go on when it reports.' }] } }));
  const sub2 = path.join(dir2, 'projects', '-tmp-x', id2, 'subagents');
  fs.mkdirSync(sub2, { recursive: true });
  fs.writeFileSync(path.join(sub2, 'agent-ffff0002.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Profile the resize step', toolUseId: 'toolu_bg', spawnDepth: 1 }));
  fs.writeFileSync(path.join(sub2, 'agent-ffff0002.jsonl'), line({ type: 'user', uuid: 'p-u1', isSidechain: true, timestamp: ago(29), message: { role: 'user', content: 'made-up' } }));
  const r2 = setup(dir2);
  r2.transcripts.open(id2);
  r2.transcripts.poll();
  r2.publisher.setStatus(id2, 'idle', Date.now());
  const st2 = () => r2.publisher.meta(id2)!.state;
  assert.deepEqual([st2().word, st2().tone, st2().mark, st2().light, st2().background], ['Idle, 1 running in the background', 'grey', 's_agent', 'amber', 1]);
  fs.appendFileSync(path.join(sub2, 'agent-ffff0002.jsonl'), line({ type: 'assistant', uuid: 'p-a1', isSidechain: true, timestamp: ago(1), message: { role: 'assistant', content: [{ type: 'text', text: 'The resize step takes 6 of the 9 minutes.' }] } }));
  r2.transcripts.poll();
  r2.transcripts.taskEnded(id2, 'toolu_bg', 'completed', 'Done', new Date().toISOString());
  r2.publisher.changed(id2);
  assert.deepEqual([st2().word, st2().background], ['Idle', 0], 'ended, its report not read yet');
  fs.appendFileSync(path.join(dir2, 'projects', '-tmp-x', `${id2}.jsonl`), line({ type: 'assistant', uuid: 'b4', timestamp: new Date(Date.now() + 1000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'The resize step is the slow part.' }] } }));
  r2.transcripts.poll();
  assert.equal(st2().word, 'Your turn', 'Claude read the report');
  r2.transcripts.stop(); r2.publisher.stop();
});

test('toolOutput: the full result read again from its line, also after the file grew; a toast when it is gone', async () => {
  const id = 'abababab-0000-4000-8000-00000000000b';
  const out = Array.from({ length: 30 }, (_, i) => `out ${i}`).join('\n');
  const dir = tempSession(id, you(1) + line({
    type: 'assistant', uuid: 'a1', timestamp: '2026-11-20T10:00:02.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_o', name: 'Bash', input: { command: 'seq 30', description: 'Count' } }] },
  }) + line({
    type: 'user', uuid: 'r1', timestamp: '2026-11-20T10:00:03.000Z', toolUseResult: { stdout: out, stderr: '', interrupted: false },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_o', content: out }] },
  }));
  const file = path.join(dir, 'projects', '-tmp-x', `${id}.jsonl`);
  const { transcripts, publisher } = setup(dir);
  const c = client();
  transcripts.open(id);
  publisher.view(c, id, null);
  const item = (c.take('items')[0].upsert as Msg[]).find((i) => i.id === 'toolu_o') as Msg;
  assert.equal(item.input, 'seq 30');
  assert.deepEqual({ ...item.out, at: '' }, { text: out.split('\n').slice(0, 20).join('\n'), lines: 30, cut: true, at: '' }, 'the first lines');
  assert.equal(await publisher.toolOutput(c, id, null, 'toolu_o'), true);
  assert.deepEqual(c.take(), [{ t: 'toolOutput', sid: id, agent: null, toolUseId: 'toolu_o', text: out }]);
  fs.appendFileSync(file, you(4) + you(5));
  transcripts.poll();
  c.take();
  assert.equal(await publisher.toolOutput(c, id, null, 'toolu_o'), true, 'the offset holds after the file grew');
  assert.equal(c.take('toolOutput')[0].text, out);
  assert.equal(await publisher.toolOutput(c, id, null, 'toolu_none'), false);
  assert.equal(c.take('toast').length, 1, 'an unknown tool gets a toast');
  fs.writeFileSync(file, you(9) + you(9) + you(9) + you(9)); // rewritten, not yet re-read
  assert.equal(await publisher.toolOutput(c, id, null, 'toolu_o'), false);
  assert.equal(c.take('toast').length, 1, 'a rewritten file gets a toast');
  fs.rmSync(file);
  assert.equal(await publisher.toolOutput(c, id, null, 'toolu_o'), false);
  assert.match(String(c.take('toast')[0].text), /gone or was rewritten/);
});


test('flush: a status set while a flush runs is in that flush, and the frames keep their order', () => {
  const id = 'aaaaaaaa-0000-4000-8000-0000000000f5';
  const dir = tempSession(id, you(1));
  const clients = new Set<Client>();
  let pub: Publisher | null = null;
  // what status.ts does: what runs by the transcript sets the status, from inside the flush
  const { transcripts, publisher } = reading(dir, () => clients, { onRunning: (sid, r) => pub?.setStatus(sid, r.turn ? 'compacting' : 'idle', 7) });
  pub = publisher;
  const c = client();
  clients.add(c);
  transcripts.open(id);
  transcripts.poll();
  publisher.view(c, id, null);
  c.take();
  fs.appendFileSync(path.join(dir, 'projects', '-tmp-x', `${id}.jsonl`), line({
    type: 'assistant', uuid: 'a1', timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_t', name: 'Bash', input: { command: 'ls' } }] },
  }));
  transcripts.poll();
  const got = c.take();
  assert.deepEqual(got.map((m) => m.t), ['session', 'items'], 'one session frame, then the items');
  assert.equal((got[0].state as { status: string }).status, 'compacting', 'with the status set while it ran');
  transcripts.stop(); publisher.stop();
});

test('restore and toast: to the page that acted while it is connected, else to every page', () => {
  const id = 'aaaaaaaa-0000-4000-8000-0000000000f6';
  const { clients, transcripts, publisher } = setup(tempSession(id, you(1)));
  const a = client(), b = client();
  clients.add(a);
  clients.add(b);
  transcripts.open(id);
  publisher.restore(id, [{ text: 'hi', images: [] }], a);
  publisher.toast('Not sent', a);
  assert.deepEqual([a.take().map((m) => m.t), b.take().length], [['restore', 'toast'], 0]);
  publisher.toast('Claude stopped');
  assert.deepEqual([a.take().length, b.take().length], [1, 1], 'no page acted: every page');
  clients.delete(a);
  publisher.restore(id, [{ text: 'hi', images: [] }], a);
  assert.deepEqual([a.take().length, b.take('restore').map((m) => m.texts)], [0, [['hi']]], 'gone: every page left gets it');
  publisher.restore(id, [], b);
  assert.equal(b.take().length, 0, 'nothing to give back: no frame');
  transcripts.stop(); publisher.stop();
});

test('outbox: session.ts owns it; a queued message lands by its record once, an interrupt gives the rest back to the page that sent it (R5.5)', async () => {
  const REAL = '11111111-2222-4333-8444-555555555555';
  const U1 = '11111111-0000-4000-8000-000000000001', U2 = '11111111-0000-4000-8000-000000000002';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-publisher-'));
  const claudeDir = path.join(root, 'claude'), cwd = path.join(root, 'scratch');
  fs.mkdirSync(path.join(claudeDir, 'projects', '-tmp-x'), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const store = openStore(path.join(root, 'state'), { minIntervalMs: 0 });
  const a = client(), b = client();
  const clients = new Set<Client>([a, b]);
  let sessions: Sessions | null = null;
  const transcripts = new Transcripts({ claudeDir, home: root, pollMs: 0, watch: false });
  const publisher = new Publisher({ transcripts, clients: () => clients, home: root, recheckMs: 0, onRunning: (sid, r) => sessions?.runningChanged(sid, r) });
  const q = fakeQuery();
  sessions = new Sessions({ store, transcripts, publisher, sdk: q.sdk, home: root });
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const ph = sessions.newSession(cwd);
  sessions.get(ph)!.send('count slowly', [], '0e9b7f1c-0000-4000-8000-0000000000a1', a);
  await tick();
  emit(q.calls[0], { type: 'system', subtype: 'init', session_id: REAL, uuid: 'u-init', capabilities: ['interrupt_cancel_queued_v1'] });
  emit(q.calls[0], { type: 'system', subtype: 'session_state_changed', state: 'running', uuid: 'u-s', session_id: REAL });
  await tick();
  const outbox = () => (publisher.meta(REAL)?.outbox ?? []).map((m) => `${m.text}${m.landed ? `@${m.landed}` : ''}${m.queued ? '' : ' (not queued)'}`);
  sessions.get(REAL)!.send('First, **then**', [], U1, a);
  sessions.get(REAL)!.send('Second', [], U2, a);
  sessions.get(REAL)!.send('Second', [], U2, a);
  assert.deepEqual(outbox().filter((m) => !m.endsWith('(not queued)')), ['First, **then**', 'Second'], 'shown at once, queued while the turn runs, one per uuid');
  publisher.view(a, REAL, null);
  a.take();
  b.take();
  // the CLI writes it as a queued_command attachment of its own uuid, after it was sent
  fs.writeFileSync(path.join(claudeDir, 'projects', '-tmp-x', `${REAL}.jsonl`), line({
    type: 'attachment', uuid: 'att1', timestamp: new Date().toISOString(), attachment: { type: 'queued_command', prompt: 'First, **then**', commandMode: 'prompt' },
  }));
  await transcripts.poll(); // its file is new: found async
  assert.ok(outbox().includes('First, **then**@att1'), 'landed, still sent once so the page swaps it with its prompt');
  const order = a.got.map((m) => m.t);
  assert.ok(order.includes('items') && order.indexOf('session') < order.indexOf('items'), 'the meta naming it landed, then the prompt item');
  publisher.changed(REAL);
  assert.ok(!outbox().some((m) => m.startsWith('First')), 'the next flush drops it');
  a.take();
  b.take();
  q.calls[0].reply = { still_queued: [], cancelled: [U2] };
  await sessions.get(REAL)!.interrupt(a);
  assert.ok(!outbox().includes('Second'), 'the cancelled message leaves the outbox');
  assert.deepEqual([a.take('restore').map((m) => m.texts), b.take('restore').length], [[['Second']], 0], 'back in the box of the page that interrupted');
  sessions.stop();
  transcripts.stop(); publisher.stop();
  store.close();
});

test("a shell's and a monitor's view (R7.2): its output as one reset, then what it adds, earlier output, nothing of the main conversation", async () => {
  const id = 'aaaaaaaa-0000-4000-8000-00000000b0b0';
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-shell-')), 'bsh1.output');
  fs.writeFileSync(out, 'Serving demo\n');
  const ts = (s: number) => `2026-11-20T10:00:${String(s).padStart(2, '0')}.000Z`;
  const dir = tempSession(id, you(1)
    + line({ type: 'assistant', uuid: 'a1', timestamp: ts(2), message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_sh', name: 'Bash', input: { command: 'npx serve demo', description: 'Serve the demo', run_in_background: true } }] } })
    + line({ type: 'user', uuid: 'u2', timestamp: ts(3), toolUseResult: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bsh1' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_sh', content: `Command running in background with ID: bsh1. Output is being written to: ${out} You will be notified when it completes.` }] } })
    + line({ type: 'assistant', uuid: 'a2', timestamp: ts(4), message: { id: 'm2', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_mon', name: 'Monitor', input: { command: 'tail -f build.log', description: 'Watch the build', timeout_ms: 600000 } }] } })
    + line({ type: 'user', uuid: 'u3', timestamp: ts(5), toolUseResult: { taskId: 'bmon1', timeoutMs: 600000, persistent: false }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_mon', content: 'Monitor started (task bmon1, expires in 10m).' }] } }));
  const file = path.join(dir, 'projects', '-tmp-x', `${id}.jsonl`);
  const { clients, transcripts, publisher } = setup(dir);
  const c = client();
  clients.add(c);
  transcripts.open(id);
  await Promise.resolve();
  c.take();
  await publisher.view(c, id, null, null, 'toolu_sh');
  assert.deepEqual(c.take('output'), [{ t: 'output', sid: id, bg: 'toolu_sh', text: 'Serving demo\n', from: 0, to: 13, total: 13, reset: true }]);
  // the file grows: the next look sends only what came; a new main item doesn't reach this view
  fs.appendFileSync(out, 'GET / 200\n');
  fs.appendFileSync(file, you(9));
  await transcripts.poll();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(c.take('output').map((m) => [m.text, m.from, m.to, m.reset ?? false]), [['GET / 200\n', 13, 23, false]]);
  assert.equal(c.take('items').length, 0, 'no main items in a shell view');
  // a long output: the last window in whole lines, the part before it on asking, and from where the page's began after a reload
  const rows = Array.from({ length: 15000 }, (_, i) => `row ${i}\n`).join('');
  fs.appendFileSync(out, rows);
  const whole = 'Serving demo\nGET / 200\n' + rows;
  await publisher.view(c, id, null, null, 'toolu_sh');
  const [tail] = c.take('output') as { text: string; from: number; to: number }[];
  assert.ok(tail.from > 0 && tail.to === whole.length && whole.slice(tail.from) === tail.text && /^row \d+\n/.test(tail.text));
  await publisher.earlierOutput(c, id, 'toolu_sh', tail.from);
  const [before] = c.take('output') as { text: string; from: number; to: number; prepend: boolean }[];
  assert.ok(before.prepend && before.to === tail.from && whole.slice(before.from, before.to) === before.text);
  await publisher.view(c, id, null, String(before.from), 'toolu_sh');
  assert.deepEqual(c.take('output').map((m) => [m.from, m.to]), [[before.from, whole.length]]);
  // a gone file reads as gone
  fs.rmSync(out);
  await publisher.view(c, id, null, null, 'toolu_sh');
  assert.equal(c.take('output')[0].lost, 'gone');
  // a monitor: its events
  const event = (s: number, text: string) => line({ type: 'user', uuid: `ev${s}`, timestamp: ts(s), message: { role: 'user', content: `<task-notification>\n<task-id>bmon1</task-id>\n<summary>Monitor event: "Watch the build"</summary>\n<event>${text}</event>\n</task-notification>` } });
  fs.appendFileSync(file, event(10, 'step 1 of 2'));
  await transcripts.poll();
  await publisher.view(c, id, null, null, 'toolu_mon');
  assert.deepEqual(c.take('output').map((m) => [m.text, m.from, m.to, m.total, m.reset]), [['step 1 of 2', 0, 1, 1, true]]);
  fs.appendFileSync(file, event(11, 'step 2 of 2\nbuilt'));
  await transcripts.poll();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(c.take('output').map((m) => [m.text, m.from, m.to]), [['step 2 of 2\nbuilt', 1, 2]]);
  // back to the main conversation: items again, no output
  publisher.view(c, id, null);
  assert.equal(c.take('items').length, 1);
  fs.appendFileSync(file, event(12, 'more'));
  await transcripts.poll();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(c.take('output').length, 0);
  transcripts.stop(); publisher.stop();
});
