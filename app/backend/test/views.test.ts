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
  assert.equal(meta[0].status, 'idle');

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

test('model: a new session with no choice shows settings.model, not the CLI default', () => {
  const clients = new Set<Client>();
  const views = new Views({ claudeDir: CLAUDE, clients: () => clients, home: HOME, pollMs: 0, watch: false, defaultModel: () => 'haiku' });
  views.open('new-1', { cwd: '/tmp/x' });
  assert.equal((views.sessions() as { id: string; model: unknown }[]).find((s) => s.id === 'new-1')!.model, 'haiku');
});
