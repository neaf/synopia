import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Tailer, SubagentWatcher } from '../src/tail.ts';
import type { JsonRecord } from '../src/tail.ts';
import { Transcript, findTranscript, sessionDirOf, clip } from '../src/transcript.ts';
import type { Item } from '../src/transcript.ts';

const CLAUDE = path.join(import.meta.dirname, 'fixtures', 'claude');
const HOME = '/Users/fixture';
const ID = {
  tools: '11111111-0000-4000-8000-000000000001',
  ask: '22222222-0000-4000-8000-000000000002',
  bg: '33333333-0000-4000-8000-000000000003',
  agents: '44444444-0000-4000-8000-000000000004',
  plan: '55555555-0000-4000-8000-000000000005',
};

function records(file: string): JsonRecord[] {
  const out: JsonRecord[] = [];
  const t = new Tailer(file, { onRecords: (r) => out.push(...r), pollMs: 0, watch: false });
  t.check();
  return out;
}

function load(id: string): Transcript {
  const t = new Transcript({ home: HOME });
  t.pushAll(records(findTranscript(CLAUDE, id) as string));
  return t;
}

const byId = (t: Transcript, id: string): Item => t.get(id) as Item;

test('tools: verbs, states, ids and skipped records', () => {
  const t = load(ID.tools);
  assert.deepEqual(t.items.map((i) => i.id), [
    't-u1', 't-a1:1', 'toolu_bash1', 'toolu_read1', 'toolu_edit1', 'toolu_write1', 'toolu_write2',
    'toolu_grep1', 'toolu_mcp1', 'toolu_ts1', 'toolu_fetch1', 't-a5:1', 't-u9', 't-u10',
  ]);
  assert.deepEqual(byId(t, 't-u1'), {
    id: 't-u1', k: 'you', ts: '2026-11-20T10:00:00.000Z', text: 'Tidy the demo notes and add a changelog.', images: 0,
  });
  assert.equal(byId(t, 't-a1:1').k, 'claude');
  const bash = byId(t, 'toolu_bash1');
  assert.deepEqual([bash.k, bash.name, bash.verb, bash.obj, bash.state], ['tool', 'Bash', 'Ran', 'List the demo folder', 'done']);
  const read = byId(t, 'toolu_read1');
  assert.deepEqual([read.verb, read.obj, read.state], ['Read', '~/dev/demo/missing.md', 'failed']);
  assert.deepEqual([byId(t, 'toolu_grep1').verb, byId(t, 'toolu_grep1').obj], ['Searched', 'TODO']);
  assert.deepEqual([byId(t, 'toolu_mcp1').verb, byId(t, 'toolu_mcp1').obj], ['demo server', 'list open items']);
  assert.deepEqual([byId(t, 'toolu_ts1').verb, byId(t, 'toolu_ts1').obj], ['Loaded tools', 'WebFetch']);
  assert.deepEqual([byId(t, 'toolu_fetch1').verb, byId(t, 'toolu_fetch1').state], ['Fetched', 'running']);
  assert.equal(byId(t, 'toolu_bash1').toolUseId, undefined);
  assert.deepEqual(byId(t, 't-u9'), { id: 't-u9', k: 'you', ts: '2026-11-20T10:01:00.000Z', text: '/review the changelog' });
  assert.equal(byId(t, 't-u10').images, 2);
  assert.equal(byId(t, 't-a5:1').text, 'Done. The notes are tidy.');
});

test('tools: diffs for update, create and the 400-line cut', () => {
  const t = load(ID.tools);
  assert.deepEqual(byId(t, 'toolu_edit1').patch, {
    file: '~/dev/demo/notes.md', abs: '/Users/fixture/dev/demo/notes.md', add: 2, del: 1, created: false, cut: false,
    hunks: [{ o: 3, n: 3, lines: [' # Notes', '-teh first idea', '+the first idea', '+a second idea', ' end'] }],
  });
  const created = byId(t, 'toolu_write1').patch;
  assert.deepEqual(created, {
    file: '~/dev/demo/CHANGELOG.md', abs: '/Users/fixture/dev/demo/CHANGELOG.md', add: 3, del: 0, created: true, cut: false,
    hunks: [{ o: 0, n: 1, lines: ['+# Changelog', '+', '+- Fixed a typo'] }],
  });
  const big = byId(t, 'toolu_write2').patch!;
  assert.equal(big.add, 410);
  assert.equal(big.cut, true);
  assert.equal(big.hunks[0].lines.length, 400);
  assert.equal(byId(t, 'toolu_write2').verb, 'Wrote');
});

test('tools: title, PRs, model, effort and mode', () => {
  const t = load(ID.tools);
  assert.equal(t.title, 'Demo notes cleanup'); // custom-title beats a later ai-title
  assert.deepEqual(t.prs, [102, 103, 104, 105]);
  assert.equal(t.requestedModel, 'claude-opus-4-1');
  assert.equal(t.effort, 'high');
  assert.equal(t.permissionMode, 'auto');
  assert.equal(t.view(3).items.length, 3);
  assert.equal(t.view(3).total, 14);
});

test('a tool result updates the same item, and takeChanges lists it', () => {
  const recs = records(findTranscript(CLAUDE, ID.tools) as string);
  const t = new Transcript({ home: HOME });
  t.pushAll(recs.slice(0, 4));
  const first = t.takeChanges();
  assert.deepEqual(first.items, ['t-u1', 't-a1:1', 'toolu_bash1', 'toolu_read1']);
  assert.equal(first.meta, true);
  assert.equal(byId(t, 'toolu_bash1').state, 'running');
  t.push(recs[4]);
  assert.deepEqual(t.takeChanges().items, ['toolu_bash1', 'toolu_read1']);
  assert.equal(byId(t, 'toolu_bash1').state, 'done');
  assert.equal(byId(t, 'toolu_read1').state, 'failed');
  assert.equal(t.items.length, 4);
  assert.deepEqual(t.takeChanges(), { items: [], background: [], agents: [], meta: false });
});

test('reset clears everything and a re-read gives the same ids', () => {
  const t = load(ID.tools);
  const ids = t.items.map((i) => i.id);
  t.reset();
  assert.equal(t.items.length, 0);
  assert.equal(t.title, null);
  t.pushAll(records(findTranscript(CLAUDE, ID.tools) as string));
  assert.deepEqual(t.items.map((i) => i.id), ids);
});

test('AskUserQuestion: answered and pending', () => {
  const t = load(ID.ask);
  const a1 = byId(t, 'toolu_ask1');
  assert.equal(a1.k, 'ask');
  assert.equal(a1.state, 'answered');
  assert.match(a1.answer!, /"Which colour\?"="Teal"/);
  assert.deepEqual(a1.qs, [
    { q: 'Which colour?', header: 'Colour', multi: false, opts: [['Teal (recommended)', 'Matches the logo'], ['Orange', 'Louder']] },
    { q: 'Which pages?', header: 'Pages', multi: true, opts: [['Home', 'The landing page'], ['Docs', 'The help pages']] },
  ]);
  const a2 = byId(t, 'toolu_ask2');
  assert.deepEqual([a2.state, a2.answer], ['pending', null]);
  assert.deepEqual(t.items.map((i) => i.k), ['you', 'ask', 'claude', 'ask']);
});

test('background shell and monitors with task notifications', () => {
  const t = load(ID.bg);
  const bg = t.background();
  assert.deepEqual(bg.map((b) => [b.toolUseId, b.kind, b.status]), [
    ['toolu_bgsh1', 'shell', 'completed'], ['toolu_mon1', 'monitor', 'failed'], ['toolu_mon2', 'monitor', 'running'],
  ]);
  assert.deepEqual(bg[0], {
    toolUseId: 'toolu_bgsh1', kind: 'shell', description: 'Build the demo', command: 'make demo-build',
    timeout: undefined, persistent: false, start: '2026-11-20T12:00:05.000Z',
    status: 'completed', summary: 'Build finished with 0 errors', end: '2026-11-20T12:05:00.000Z',
  });
  assert.deepEqual([bg[1].timeout, bg[1].persistent, bg[1].summary, bg[1].end], [600000, false, '', '2026-11-20T12:06:00.000Z']);
  assert.deepEqual([bg[2].persistent, bg[2].end], [true, null]);
  assert.equal(byId(t, 'toolu_mon1').verb, 'Watched');
  // notifications are not items
  assert.deepEqual(t.items.map((i) => i.k), ['you', 'tool', 'tool', 'tool', 'claude']);
});

test('background changes are reported when a notification lands', () => {
  const recs = records(findTranscript(CLAUDE, ID.bg) as string);
  const t = new Transcript({ home: HOME });
  t.pushAll(recs.slice(0, 4));
  assert.deepEqual(t.takeChanges().background, ['toolu_bgsh1', 'toolu_mon1', 'toolu_mon2']);
  t.push(recs[4]);
  assert.deepEqual(t.takeChanges().background, ['toolu_bgsh1']);
});

function loadAgents(): { main: Transcript; subs: Map<string, Transcript> } {
  const file = findTranscript(CLAUDE, ID.agents) as string;
  const main = load(ID.agents);
  const subs = new Map<string, Transcript>();
  const w = new SubagentWatcher(sessionDirOf(file), {
    onAgent: (aid, f) => {
      const sub = new Transcript({ sidechain: true, home: HOME });
      sub.pushAll(records(f));
      subs.set(aid, sub);
      main.setAgent(aid, undefined, sub);
    },
    onMeta: (aid, meta) => main.setAgent(aid, meta),
  }, { pollMs: 0, watch: false });
  w.scan();
  return { main, subs };
}

test('subagents: meta, running rule, fork, For review and a file without meta', () => {
  const { main, subs } = loadAgents();
  const agents = main.agents();
  assert.deepEqual(agents.map((a) => [a.id, a.type, a.running]), [
    ['aaaa0001', 'Explore', false], // finished: true
    ['aaaa0002', 'general-purpose', true], // finished missing, background, no notification
    ['aaaa0003', 'general-purpose', false], // finished: false, but notified
    ['aaaa0004', 'general-purpose', false],
    ['aaaa0005', 'subagent', true], // no meta yet
    ['aaaa0006', 'Explore', false], // finished missing, foreground Agent has its result
  ]);
  const a1 = main.getAgent('aaaa0001')!;
  assert.deepEqual(a1, {
    id: 'aaaa0001', type: 'Explore', fork: false, description: 'Find the demo config', toolUseId: 'toolu_ag1',
    model: 'haiku', depth: 1, finished: true, running: false, review: false,
    start: '2026-11-20T13:00:06.000Z', end: '2026-11-20T13:01:50.000Z', total: 2,
  });
  assert.equal(main.getAgent('aaaa0003')!.fork, true);
  assert.equal(main.getAgent('aaaa0004')!.review, true);
  assert.equal(main.getAgent('aaaa0002')!.finished, false);
  // subagent transcripts read their sidechain records
  assert.deepEqual(subs.get('aaaa0001')!.items.map((i) => [i.id, i.k]), [['aaaa0001-u1', 'you'], ['aaaa0001-a1:0', 'claude']]);
  // the Agent tool items
  assert.deepEqual(['toolu_ag1', 'toolu_ag2', 'toolu_ag3', 'toolu_ag4', 'toolu_ag6'].map((id) => byId(main, id).state),
    ['done', 'running', 'done', 'running', 'done']);
  assert.equal(byId(main, 'toolu_ag2').toolUseId, 'toolu_ag2');
  assert.equal(byId(main, 'toolu_ag2').verb, 'Subagent');
});

test('subagents: a meta arriving later, and a notification, mark the agent changed', () => {
  const { main } = loadAgents();
  main.takeChanges();
  main.setAgent('aaaa0005', { agentType: 'Plan', description: 'Late meta', finished: true });
  assert.deepEqual(main.takeChanges().agents, ['aaaa0005']);
  assert.equal(main.getAgent('aaaa0005')!.type, 'Plan');
  assert.equal(main.getAgent('aaaa0005')!.running, false);
  main.push({
    type: 'user', uuid: 'late-n', timestamp: '2026-11-20T13:30:00.000Z',
    message: { role: 'user', content: '<task-notification><tool-use-id>toolu_ag2</tool-use-id><status>completed</status></task-notification>' },
  });
  const ch = main.takeChanges();
  assert.deepEqual(ch.agents, ['aaaa0002']);
  assert.deepEqual(ch.items, ['toolu_ag2']);
  assert.equal(main.getAgent('aaaa0002')!.running, false);
});

test('agent reports from agent-message', () => {
  const { main } = loadAgents();
  const r = byId(main, 's-u4');
  assert.deepEqual(r, {
    id: 's-u4', k: 'report', ts: '2026-11-20T13:12:00.000Z', agent: 'aaaa0004',
    text: '# Release notes\n- Teal banner\n  - nested point',
  });
});

test('interrupted prompt, permission-mode plan and turn_duration', () => {
  const t = load(ID.plan);
  const last = t.items[t.items.length - 1];
  assert.deepEqual(last, {
    id: 'i-u3', k: 'you', ts: '2026-11-20T14:01:20.000Z', text: '[Request interrupted by user for tool use]', images: 0, interrupted: true,
  });
  assert.equal(t.permissionMode, 'plan');
  assert.equal(t.lastNonPlanMode, 'acceptEdits');
  assert.equal(byId(t, 'i-u1').workedMs, 31000);
  assert.equal(byId(t, 'i-u2').workedMs, undefined);
  const plan = byId(t, 'toolu_plan1');
  assert.deepEqual([plan.verb, plan.obj, plan.state], ['Plan', 'shown for approval', 'running']);
});

test('long text is clipped as in the reference parser', () => {
  const t = new Transcript({ home: HOME });
  t.push({ type: 'user', uuid: 'long', message: { content: 'x'.repeat(7000) } });
  assert.equal(byId(t, 'long').text, 'x'.repeat(6000) + '\n\n[cut: message continues]');
  assert.equal(clip('short'), 'short');
});

test('findTranscript finds projects/*/<id>.jsonl, or null', () => {
  assert.equal(findTranscript(CLAUDE, ID.ask), path.join(CLAUDE, 'projects', '-tmp-fixture', `${ID.ask}.jsonl`));
  assert.equal(findTranscript(CLAUDE, 'nope'), null);
  assert.equal(findTranscript(path.join(os.tmpdir(), 'no-such-claude-dir'), ID.ask), null);
});

test('a subagent file seen before its meta', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-sub-'));
  try {
    const events: string[] = [];
    const w = new SubagentWatcher(dir, {
      onAgent: (id) => events.push(`agent ${id}`),
      onMeta: (id, meta) => events.push(`meta ${id} ${meta.agentType}`),
    }, { pollMs: 0, watch: false });
    w.scan();
    fs.mkdirSync(path.join(dir, 'subagents'));
    fs.writeFileSync(path.join(dir, 'subagents', 'agent-bbbb.jsonl'), '');
    w.scan();
    fs.writeFileSync(path.join(dir, 'subagents', 'agent-bbbb.meta.json'), '{"agentType":');
    w.scan(); // half written: skipped
    fs.writeFileSync(path.join(dir, 'subagents', 'agent-bbbb.meta.json'), '{"agentType":"Explore"}');
    w.scan();
    w.scan(); // unchanged: not reported again
    assert.deepEqual(events, ['agent bbbb', 'meta bbbb Explore']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
