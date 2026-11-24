import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Views, WINDOW } from '../src/views.ts';
import type { Client } from '../src/server.ts';

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

function setup(claudeDir: string) {
  const clients = new Set<Client>();
  const views = new Views({ claudeDir, clients: () => clients, home: HOME, pollMs: 0, watch: false });
  return { clients, views };
}

const line = (o: object) => JSON.stringify(o) + '\n';
const you = (i: number) => line({ type: 'user', uuid: `u${i}`, timestamp: `2026-11-20T10:00:${String(i % 60).padStart(2, '0')}.000Z`, message: { role: 'user', content: `prompt ${i}` } });

function tempSession(id: string, body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-views-'));
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
  const { clients, views } = setup(dir);
  const c = client();
  clients.add(c);
  views.open(id);
  await Promise.resolve();
  const meta = c.take('session');
  assert.equal(meta.length, 1);
  assert.equal(meta[0].title, 'prompt 1');
  assert.equal(meta[0].status, 'busy', 'its last tool has no result yet: the turn runs (status.ts)');

  views.view(c, id, null);
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
  views.check();
  const ups = c.take('items');
  assert.equal(ups.length, 1);
  assert.equal(ups[0].reset, false);
  assert.equal(ups[0].total, 3);
  const items = ups[0].upsert as { id: string; state?: string }[];
  assert.deepEqual(items.map((i) => i.id), ['toolu_x', 'u4']);
  assert.equal(items[0].state, 'done');

  // Nothing new: nothing sent. A page that left gets nothing.
  views.check();
  assert.equal(c.take('items').length, 0);
  clients.delete(c);
  fs.appendFileSync(file, you(5));
  views.check();
  assert.equal(c.take().length, 0);

  // A rewritten file resets the view.
  clients.add(c);
  views.view(c, id, null);
  c.take();
  fs.writeFileSync(file + '.new', you(9));
  fs.renameSync(file + '.new', file);
  views.check();
  const after = c.take('items');
  assert.equal(after.length, 1);
  assert.equal(after[0].reset, true);
  assert.deepEqual((after[0].upsert as { id: string }[]).map((i) => i.id), ['u9']);
  views.stop();
});

test('view: the last 160 items with the total', () => {
  const id = 'bbbbbbbb-0000-4000-8000-00000000000b';
  let body = '';
  for (let i = 0; i < 400; i++) body += you(i);
  const { clients, views } = setup(tempSession(id, body));
  const c = client();
  clients.add(c);
  views.open(id);
  views.view(c, id, null);
  const [reset] = c.take('items');
  const items = reset.upsert as { id: string }[];
  assert.equal(WINDOW, 160);
  assert.equal(items.length, 160);
  assert.equal(reset.total, 400);
  assert.equal(items[0].id, 'u240');
  assert.equal(items[159].id, 'u399');
  views.stop();
});

test('subagents: agents and background in hello, and a subagent view', async () => {
  const { clients, views } = setup(CLAUDE);
  const c = client();
  clients.add(c);
  views.open(AGENTS);
  await Promise.resolve();
  const agents = c.take('agents');
  assert.equal(agents.length, 1);
  const ids = (agents[0].upsert as { id: string }[]).map((a) => a.id);
  assert.deepEqual(ids, ['aaaa0001', 'aaaa0002', 'aaaa0003', 'aaaa0004', 'aaaa0005', 'aaaa0006']);

  const [hello] = views.sessions() as { id: string; agents: { id: string; running: boolean; total: number }[] }[];
  assert.equal(hello.id, AGENTS);
  const a2 = hello.agents.find((a) => a.id === 'aaaa0002');
  assert.equal(a2?.running, true);
  assert.equal(a2?.total, 2);

  views.view(c, AGENTS, 'aaaa0002');
  const [reset] = c.take('items');
  assert.equal(reset.agent, 'aaaa0002');
  assert.equal(reset.reset, true);
  assert.equal(reset.total, 2);
  assert.deepEqual((reset.upsert as { k: string }[]).map((i) => i.k), ['you', 'claude']);

  // An unknown subagent gives an empty reset, not an error.
  views.view(c, AGENTS, 'nope');
  const [empty] = c.take('items');
  assert.deepEqual([empty.total, (empty.upsert as unknown[]).length], [0, 0]);
  views.stop();
});

test('status, pending, stream and close are broadcast', async () => {
  const { clients, views } = setup(CLAUDE);
  const c = client();
  clients.add(c);
  views.open(AGENTS);
  await Promise.resolve();
  c.take();
  views.setStatus(AGENTS, 'busy', 5);
  assert.deepEqual(c.take('session').map((m) => [m.status, m.statusAt]), [['busy', 5]]);
  views.setPending(AGENTS, { id: 'r1', kind: 'plan', since: 1 });
  assert.deepEqual(views.pending().map((p) => p.request.id), ['r1']);
  views.clearPending(AGENTS, 'r1');
  assert.deepEqual(c.take('pending').map((m) => [m.request ? 'request' : 'cleared']), [['request'], ['cleared']]);
  views.setStream(AGENTS, 'Hel');
  views.setStream(AGENTS, null);
  assert.deepEqual(c.take('stream').map((m) => m.text ?? m.clear), ['Hel', true]);
  views.close(AGENTS);
  assert.deepEqual(c.take('removed'), [{ t: 'removed', id: AGENTS }]);
  assert.equal(views.sessions().length, 0);
});

test('turns: an interrupted turn says so to the writer; a turned-down tool does not (seams#B3)', () => {
  const id = 'aaaaaaaa-0000-4000-8000-0000000000ab';
  const marker = (uuid: string, s: number, text: string) => line({ type: 'user', uuid, timestamp: `2026-11-20T10:00:0${s}.000Z`, message: { role: 'user', content: [{ type: 'text', text }] } });
  const dir = tempSession(id, you(1) + marker('x2', 2, '[Request interrupted by user for tool use]') + you(3) + marker('x4', 4, '[Request interrupted by user]'));
  const { views } = setup(dir);
  views.open(id);
  assert.deepEqual(views.turns(id), [{ you: 'prompt 1', claude: '' }, { you: 'prompt 3', claude: '(You interrupted this turn.)' }]);
});

test('model: a new session with no choice shows settings.model, not the CLI default', () => {
  const clients = new Set<Client>();
  const views = new Views({ claudeDir: CLAUDE, clients: () => clients, home: HOME, pollMs: 0, watch: false, defaultModel: () => 'haiku' });
  views.open('new-1', { cwd: '/tmp/x' });
  assert.equal((views.sessions() as { id: string; model: unknown }[]).find((s) => s.id === 'new-1')!.model, 'haiku');
});

test('earlier: pages of 160 before an id, down to the first, then nothing', () => {
  const id = 'eeeeeeee-0000-4000-8000-00000000000e';
  let body = '';
  for (let i = 0; i < 400; i++) body += you(i);
  const dir = tempSession(id, body);
  const { clients, views } = setup(dir);
  const c = client(), other = client();
  clients.add(c);
  clients.add(other);
  views.open(id);
  views.check(); // the first read's changes go out before the pages view it
  views.view(c, id, null);
  views.view(other, id, null);
  c.take();
  other.take();
  const ids = (m: Msg) => (m.upsert as { id: string }[]).map((i) => i.id);

  // Before the oldest shown (u240): u80 to u239, in order, marked prepend.
  assert.equal(views.earlier(c, id, null, 'u240'), 160);
  const [p1] = c.take('items');
  assert.equal(p1.prepend, true);
  assert.equal(p1.reset, false);
  assert.equal(p1.total, 400);
  assert.deepEqual(ids(p1), Array.from({ length: 160 }, (_, i) => `u${80 + i}`));

  // The next page stops at the first item: 80 left.
  assert.equal(views.earlier(c, id, null, 'u80'), 80);
  const [p2] = c.take('items');
  assert.equal(ids(p2)[0], 'u0');
  assert.equal(ids(p2).length, 80);
  // At the start of history there is nothing before u0 (the page shows no link then).
  views.earlier(c, id, null, 'u0');
  assert.deepEqual(c.take('items').map(ids), [[]]);
  // An id not in the transcript, or another conversation than the one viewed: no reply.
  assert.equal(views.earlier(c, id, null, 'nope'), 0);
  assert.equal(views.earlier(c, id, 'aaaa0001', 'u80'), 0);
  assert.equal(c.take().length, 0);

  // Later items still arrive as upserts, on both pages.
  const file = path.join(dir, 'projects', '-tmp-x', `${id}.jsonl`);
  fs.appendFileSync(file, you(400));
  views.check();
  assert.deepEqual(c.take('items').map(ids), [['u400']]);
  assert.deepEqual(other.take('items').map(ids), [['u400']]);

  // A rewrite resets the loaded range back to the last 160.
  let again = '';
  for (let i = 0; i < 300; i++) again += you(i);
  fs.writeFileSync(file + '.new', again);
  fs.renameSync(file + '.new', file);
  views.check();
  const [reset] = c.take('items');
  assert.equal(reset.reset, true);
  assert.equal(ids(reset).length, 160);
  assert.equal(ids(reset)[0], 'u140');
  // So does a new `view`.
  views.earlier(c, id, null, 'u140');
  c.take();
  views.view(c, id, null);
  assert.equal(ids(c.take('items')[0])[0], 'u140');
  views.stop();
});

test('view from: one reset from the oldest item the page had loaded, else the last 160', () => {
  const id = 'edededed-0000-4000-8000-0000000000ed';
  let body = '';
  for (let i = 0; i < 400; i++) body += you(i);
  const dir = tempSession(id, body);
  const { clients, views } = setup(dir);
  const c = client();
  clients.add(c);
  views.open(id);
  views.check();
  c.take();
  const ids = (m: Msg) => (m.upsert as { id: string }[]).map((i) => i.id);

  // From u50: one reset with u50 to u399, and nothing else.
  views.view(c, id, null, 'u50');
  const got = c.take();
  assert.equal(got.length, 1);
  assert.equal(got[0].reset, true);
  assert.equal(got[0].total, 400);
  assert.deepEqual(ids(got[0]), Array.from({ length: 350 }, (_, i) => `u${50 + i}`));
  // Earlier items go on before u50.
  assert.equal(views.earlier(c, id, null, 'u50'), 50);
  assert.equal(ids(c.take('items')[0])[0], 'u0');

  // An id within the last 160, an unknown id, none: the last 160.
  for (const from of ['u300', 'nope', null, undefined]) {
    views.view(c, id, null, from);
    const [r] = c.take('items');
    assert.equal(r.reset, true);
    assert.equal(ids(r).length, 160, String(from));
    assert.equal(ids(r)[0], 'u240', String(from));
  }
  // The first item: everything.
  views.view(c, id, null, 'u0');
  assert.equal(ids(c.take('items')[0]).length, 400);
  // A rewrite after that resets to the last 160 of the new file, as before.
  const file = path.join(dir, 'projects', '-tmp-x', `${id}.jsonl`);
  let again = '';
  for (let i = 0; i < 300; i++) again += you(i);
  fs.writeFileSync(file + '.new', again);
  fs.renameSync(file + '.new', file);
  views.check();
  assert.equal(ids(c.take('items')[0])[0], 'u140');
  views.stop();
});

test('view from: an item loaded through from gets its upserts', () => {
  const id = 'edededed-0000-4000-8000-0000000000ee';
  let body = line({
    type: 'assistant', uuid: 'a0', timestamp: '2026-11-20T10:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_old', name: 'Bash', input: { command: 'sleep 1' } }] },
  });
  for (let i = 1; i < 200; i++) body += you(i);
  const dir = tempSession(id, body);
  const { clients, views } = setup(dir);
  const c = client();
  clients.add(c);
  views.open(id);
  views.check();
  c.take();
  views.view(c, id, null, 'toolu_old');
  assert.equal((c.take('items')[0].upsert as { id: string }[]).length, 200);
  fs.appendFileSync(path.join(dir, 'projects', '-tmp-x', `${id}.jsonl`), line({
    type: 'user', uuid: 'r0', timestamp: '2026-11-20T10:00:01.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_old', content: 'ok' }] },
  }));
  views.check();
  assert.deepEqual((c.take('items')[0].upsert as { id: string; state: string }[]).map((i) => [i.id, i.state]), [['toolu_old', 'done']]);
  views.stop();
});

test('earlier: an item loaded earlier gets its upserts, only on the page that loaded it', () => {
  const id = 'efefefef-0000-4000-8000-0000000000ef';
  let body = line({
    type: 'assistant', uuid: 'a0', timestamp: '2026-11-20T10:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_old', name: 'Bash', input: { command: 'sleep 1' } }] },
  });
  for (let i = 1; i < 200; i++) body += you(i);
  const dir = tempSession(id, body);
  const { clients, views } = setup(dir);
  const c = client(), other = client();
  clients.add(c);
  clients.add(other);
  views.open(id);
  views.check();
  views.view(c, id, null);
  views.view(other, id, null);
  views.earlier(c, id, null, (c.take('items')[0].upsert as { id: string }[])[0].id);
  other.take();
  assert.equal((c.take('items')[0].upsert as { id: string }[])[0].id, 'toolu_old');
  fs.appendFileSync(path.join(dir, 'projects', '-tmp-x', `${id}.jsonl`), line({
    type: 'user', uuid: 'r0', timestamp: '2026-11-20T10:00:01.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_old', content: 'ok' }] },
  }));
  views.check();
  const [up] = c.take('items');
  assert.deepEqual((up.upsert as { id: string; state: string }[]).map((i) => [i.id, i.state]), [['toolu_old', 'done']]);
  assert.equal(other.take('items').length, 0);
  views.stop();
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
  const { clients, views } = setup(dir);
  const c = client();
  clients.add(c);
  views.open(id);
  views.check();
  views.view(c, id, 'bbbb0001');
  const [reset] = c.take('items');
  const shown = reset.upsert as { id: string; text: string }[];
  assert.equal(reset.total, 250);
  assert.equal(shown.length, 160);
  assert.equal(shown[0].text, 'step 90');
  // The main conversation's `earlier` doesn't answer for the subagent view.
  assert.equal(views.earlier(c, id, null, shown[0].id), 0);
  assert.equal(views.earlier(c, id, 'bbbb0001', shown[0].id), 90);
  const [p] = c.take('items');
  assert.equal(p.agent, 'bbbb0001');
  assert.equal(p.prepend, true);
  assert.deepEqual((p.upsert as { text: string }[]).map((i) => i.text), Array.from({ length: 90 }, (_, i) => `step ${i}`));
  views.stop();
});
test('rekey: a card, the held messages and the stream preview move to the new id (L5)', () => {
  const { views } = setup(CLAUDE);
  views.open('new-2', { cwd: '/tmp/x' });
  views.setPending('new-2', { id: 'r1', kind: 'question', since: 1 });
  views.setHeld('new-2', ['wait']);
  views.setStream('new-2', 'Partly');
  const id = 'aaaaaaaa-0000-4000-8000-0000000000cd';
  views.rekey('new-2', id);
  assert.deepEqual(views.pending().map((p) => [p.sid, p.request.id]), [[id, 'r1']]);
  views.clearPending(id, 'r1');
  assert.deepEqual(views.pending(), []);
  const s = (views.sessions() as { id: string; held: string[]; stream: string | null }[]).find((x) => x.id === id)!;
  assert.deepEqual([s.held, s.stream], [['wait'], 'Partly']);
});

test('meta: the CLI ai-title is the name, shown when it is not the title (L3)', () => {
  const id = 'aaaaaaaa-0000-4000-8000-0000000000ce';
  const dir = tempSession(id, you(1) + line({ type: 'ai-title', aiTitle: 'Count the lines', sessionId: id }));
  const clients = new Set<Client>();
  let written: { title?: string } | undefined;
  const views = new Views({ claudeDir: dir, clients: () => clients, home: HOME, pollMs: 0, watch: false, written: () => written });
  views.open(id);
  assert.deepEqual([views.meta(id)?.title, views.meta(id)?.name], ['Count the lines', '']);
  written = { title: 'Counting fixture lines' };
  assert.deepEqual([views.meta(id)?.title, views.meta(id)?.name], ['Counting fixture lines', 'Count the lines']);
});

test('subagents: read from the folder scan; a finished, quiet one only now and then (L6)', () => {
  const { views } = setup(CLAUDE);
  views.open(AGENTS);
  type Inner = { live: Map<string, { t: { agentRunning: (id: string) => boolean }; watcher: { scan: () => void }; children: Map<string, { tailer: { check: () => boolean } }> }> };
  const s = (views as unknown as Inner).live.get(AGENTS)!;
  const counts = new Map<string, number>();
  for (const [aid, c] of s.children) {
    const check = c.tailer.check.bind(c.tailer);
    c.tailer.check = () => { counts.set(aid, (counts.get(aid) ?? 0) + 1); return check(); };
  }
  for (let i = 0; i < 40; i++) s.watcher.scan();
  const running = [...s.children.keys()].filter((aid) => s.t.agentRunning(aid));
  const finished = [...s.children.keys()].filter((aid) => !s.t.agentRunning(aid));
  assert.ok(finished.length > 0);
  for (const aid of running) assert.equal(counts.get(aid), 40, `${aid} runs: read at every scan`);
  for (const aid of finished) assert.ok((counts.get(aid) ?? 0) <= 8, `${aid} finished: read ${counts.get(aid)} times in 40 scans`);
  views.stop();
});

test('work: a question or plan another process asks is a work line until answered (R6.8)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-ext-'));
  fs.cpSync(path.join(import.meta.dirname, 'fixtures', 'claude-ext'), dir, { recursive: true });
  const Q = 'e1e1e1e1-0000-4000-8000-00000000000a', P = 'e2e2e2e2-0000-4000-8000-00000000000b';
  const asks: string[] = [];
  const views = new Views({ claudeDir: dir, clients: () => new Set(), home: HOME, pollMs: 0, watch: false, onRunning: (sid, r) => asks.push(`${sid}:${r.ask?.toolUseId ?? ''}`) });
  views.open(Q);
  views.open(P);
  views.check();
  assert.deepEqual(views.work(Q), ['card waiting for you: question “Which release channel should the checklist target?” and 1 more']);
  assert.deepEqual(views.work(P), ['card waiting for you: approve the plan or ask for changes']);
  assert.ok(asks.includes(`${Q}:toolu_xask1`));
  fs.appendFileSync(path.join(dir, 'projects', '-tmp-ext', `${Q}.jsonl`), JSON.stringify({ type: 'user', uuid: 'x1-u3', timestamp: '2026-11-24T09:02:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_xask1', content: 'answered' }] } }) + '\n');
  views.check();
  assert.deepEqual(views.work(Q), []);
  assert.equal(asks.at(-1), `${Q}:`, 'the ask ending reaches onRunning (sessions tells the writer)');
  views.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('work: a background shell ending between turns tells the writer, and its line says so', () => {
  const id = 'aaaaaaaa-0000-4000-8000-0000000000cf';
  const dir = tempSession(id, you(1) + line({
    type: 'assistant', uuid: 'a1', timestamp: '2026-11-20T10:00:02.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Bash', input: { command: 'sleep 90', description: 'Wait a while', run_in_background: true } }] },
  }));
  const ended: string[] = [];
  const views = new Views({ claudeDir: dir, clients: () => new Set(), home: HOME, pollMs: 0, watch: false, onWorkEnded: (sid) => ended.push(sid) });
  views.open(id);
  views.check();
  assert.deepEqual(ended, [], 'reading it running is no end');
  assert.deepEqual(views.work(id), ['shell “Wait a while”: running']);
  views.taskEnded(id, 'toolu_bg', 'killed', '');
  assert.deepEqual(ended, [id]);
  assert.deepEqual(views.work(id), ['shell “Wait a while”: killed']);
  views.taskEnded(id, 'toolu_bg', 'killed', '');
  assert.deepEqual(ended, [id], 'once');
});

test("work: the SDK's task_started gives a shell its task id when the file has none", () => {
  const id = 'aaaaaaaa-0000-4000-8000-0000000000d0';
  const dir = tempSession(id, you(1) + line({
    type: 'assistant', uuid: 'a1', timestamp: '2026-11-20T10:00:02.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Bash', input: { command: 'sleep 90', description: 'Wait a while', run_in_background: true } }] },
  }));
  const sent: { t?: string; upsert?: { toolUseId: string; taskId: string | null }[] }[] = [];
  const client = { send: (m: object) => sent.push(m) } as unknown as Client;
  const views = new Views({ claudeDir: dir, clients: () => new Set([client]), home: HOME, pollMs: 0, watch: false });
  views.open(id);
  views.check();
  sent.length = 0;
  views.taskStarted(id, 'toolu_bg', 'b1x2');
  const up = sent.find((m) => m.t === 'background')?.upsert ?? [];
  assert.deepEqual(up.map((b) => [b.toolUseId, b.taskId]), [['toolu_bg', 'b1x2']]);
  views.stop();
});

test("toolProgress: a running tool's start (now minus the elapsed time) goes with its item, once, and leaves with its result", () => {
  const id = 'aaaaaaaa-0000-4000-8000-0000000000d1';
  const dir = tempSession(id, you(1) + line({
    type: 'assistant', uuid: 'a1', timestamp: '2026-11-20T10:00:02.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_run', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }] },
  }));
  const { clients, views } = setup(dir);
  const c = client();
  clients.add(c);
  views.open(id);
  views.check();
  views.view(c, id, null);
  const tool = (m: Msg) => (m.upsert as { id: string; since?: string; state?: string }[]).find((i) => i.id === 'toolu_run');
  assert.equal(tool(c.take('items')[0])?.since, undefined, 'no progress yet: no start');
  const now = Date.parse('2026-11-20T10:01:00.000Z');
  views.toolProgress(id, 'toolu_run', 42, now);
  const [up] = c.take('items');
  assert.equal(up.reset, false);
  assert.deepEqual((up.upsert as unknown[]).length, 1);
  assert.equal(tool(up)?.since, '2026-11-20T10:00:18.000Z');
  views.toolProgress(id, 'toolu_run', 43, now + 1000);
  assert.deepEqual(c.take('items'), [], 'later progress changes nothing');
  views.toolProgress(id, 'toolu_none', -1, now);
  assert.deepEqual(c.take('items'), [], 'a bad elapsed time is ignored');
  views.view(c, id, null);
  assert.equal(tool(c.take('items')[0])?.since, '2026-11-20T10:00:18.000Z', 'a reset carries it too');
  fs.appendFileSync(path.join(dir, 'projects', '-tmp-x', `${id}.jsonl`), line({
    type: 'user', uuid: 'r1', timestamp: '2026-11-20T10:01:01.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_run', content: 'ok' }] },
  }));
  views.check();
  const done = tool(c.take('items')[0]);
  assert.equal(done?.state, 'done');
  assert.equal(done?.since, undefined, 'finished: no start');
  views.stop();
});

test('toolOutput: the full result read again from its line, also after the file grew; a toast when it is gone', () => {
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
  const { views } = setup(dir);
  const c = client();
  views.open(id);
  views.view(c, id, null);
  const item = (c.take('items')[0].upsert as Msg[]).find((i) => i.id === 'toolu_o') as Msg;
  assert.equal(item.input, 'seq 30');
  assert.deepEqual(item.out, { text: out.split('\n').slice(0, 20).join('\n'), lines: 30, cut: true });
  assert.equal(views.toolOutput(c, id, null, 'toolu_o'), true);
  assert.deepEqual(c.take(), [{ t: 'toolOutput', sid: id, agent: null, toolUseId: 'toolu_o', text: out, truncated: false }]);
  fs.appendFileSync(file, you(4) + you(5));
  views.check();
  c.take();
  assert.equal(views.toolOutput(c, id, null, 'toolu_o'), true, 'the offset holds after the file grew');
  assert.equal(c.take('toolOutput')[0].text, out);
  assert.equal(views.toolOutput(c, id, null, 'toolu_none'), false);
  assert.equal(c.take('toast').length, 1, 'an unknown tool gets a toast');
  fs.writeFileSync(file, you(9) + you(9) + you(9) + you(9)); // rewritten, not yet re-read
  assert.equal(views.toolOutput(c, id, null, 'toolu_o'), false);
  assert.equal(c.take('toast').length, 1, 'a rewritten file gets a toast');
  fs.rmSync(file);
  assert.equal(views.toolOutput(c, id, null, 'toolu_o'), false);
  assert.match(String(c.take('toast')[0].text), /gone or was rewritten/);
});

test('outbox: a message sent during a turn is queued, lands by its prompt record once, an interrupt takes the rest (R5.5)', async () => {
  const id = 'aaaaaaaa-0000-4000-8000-0000000000e1';
  const dir = tempSession(id, you(1));
  const { clients, views } = setup(dir);
  const c = client();
  clients.add(c);
  views.open(id);
  await Promise.resolve();
  const outbox = () => (views.meta(id)?.outbox ?? []).map((q) => `${q.text}${q.landed ? `@${q.landed}` : ''}`);
  assert.equal(views.queues(id), false, 'not driven: nothing runs that a message waits behind');
  views.setStatus(id, 'busy');
  assert.equal(views.queues(id), true);
  views.sent(id, '11111111-0000-4000-8000-000000000001', 'First, **then**');
  views.sent(id, '11111111-0000-4000-8000-000000000002', 'Second');
  views.sent(id, '11111111-0000-4000-8000-000000000002', 'Second'); // the same uuid once
  assert.deepEqual(outbox(), ['First, **then**', 'Second']);
  views.view(c, id, null);
  c.take();
  // the CLI writes it as a queued_command attachment of its own uuid, after it was sent
  fs.appendFileSync(path.join(dir, 'projects', '-tmp-x', `${id}.jsonl`), line({
    type: 'attachment', uuid: 'att1', timestamp: new Date().toISOString(), attachment: { type: 'queued_command', prompt: 'First, **then**', commandMode: 'prompt' },
  }));
  views.check();
  assert.deepEqual(outbox(), ['First, **then**@att1', 'Second'], 'landed, still sent once so the page swaps it with its prompt');
  const order = c.got.map((m) => m.t);
  assert.ok(order.includes('items') && order.indexOf('session') < order.indexOf('items'), 'the meta naming it landed, then the prompt item');
  views.refresh(id);
  assert.deepEqual(outbox(), ['Second'], 'the next flush drops it');
  // an older prompt with the same text doesn't count
  views.sent(id, '11111111-0000-4000-8000-000000000003', 'prompt 1');
  views.check();
  assert.deepEqual(outbox(), ['Second', 'prompt 1']);
  c.take();
  views.restore(id, ['Second', 'prompt 1']);
  assert.deepEqual(outbox(), []);
  assert.deepEqual(c.take('restore').map((m) => m.texts), [['Second', 'prompt 1']]);
  // not behind a card: those are held
  views.setPending(id, { id: 'r1', kind: 'question', since: 1 });
  views.sent(id, '11111111-0000-4000-8000-000000000004', 'held');
  assert.deepEqual(outbox(), []);
  views.stop();
});
