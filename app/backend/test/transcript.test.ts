import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Tailer, SubagentWatcher } from '../src/tail.ts';
import type { JsonRecord, Span } from '../src/tail.ts';
import { Transcript, findTranscript, sessionDirOf, clip, previewOf, readResult } from '../src/transcript.ts';
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
    'toolu_bashedit1', 'toolu_grep1', 'toolu_mcp1', 'toolu_ts1', 'toolu_fetch1', 't-a5:1', 't-u9', 't-u10',
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

test('tools: files a Bash command changed (bashEditDiff)', () => {
  const t = load(ID.tools);
  const it = byId(t, 'toolu_bashedit1');
  assert.deepEqual([it.verb, it.obj, it.state, it.patch], ['Ran', 'Reword the second idea and add the tidy script', 'done', undefined]);
  assert.deepEqual(it.patches, [
    { file: '~/dev/demo/notes.md', abs: '/Users/fixture/dev/demo/notes.md', add: 1, del: 1, created: false, cut: false,
      hunks: [{ o: 4, n: 4, lines: [' the first idea', '-a second idea', '+a second, better idea', ' end'] }] },
    { file: '~/dev/demo/scripts/tidy.sh', abs: '/Users/fixture/dev/demo/scripts/tidy.sh', add: 2, del: 0, created: true, cut: false,
      hunks: [{ o: 0, n: 1, lines: ['+#!/bin/sh', "+sed -i '' 's/teh/the/g' notes.md"] }] },
    // a changed file with no diff: a path only, resolved against the record's cwd
    { file: '~/dev/demo/.tidy-stamp', abs: '/Users/fixture/dev/demo/.tidy-stamp', add: 0, del: 0, created: false, cut: false, hunks: [], bare: true },
  ]);
  assert.equal(it.moreFiles, 2);
  assert.equal(byId(t, 'toolu_bash1').patches, undefined); // a Bash result without bashEditDiff
});

test('bashEditDiff: the 400-line cut, and the result before its tool use', () => {
  const lines = Array.from({ length: 450 }, (_, i) => `+line ${i}`);
  const t = new Transcript({ home: HOME });
  t.push({ type: 'user', uuid: 'r', cwd: '/tmp', toolUseResult: { stdout: '', bashEditDiff: { files: [{ filePath: '/Users/fixture/big.txt', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 450, lines }], created: true }], moreFiles: 0, changedFiles: ['/Users/fixture/big.txt'] } }, message: { content: [{ type: 'tool_result', tool_use_id: 'tb', content: '' }] } });
  t.push({ type: 'assistant', uuid: 'a', message: { content: [{ type: 'tool_use', id: 'tb', name: 'Bash', input: { command: 'gen > big.txt' } }] } });
  const it = byId(t, 'tb');
  assert.equal(it.patches!.length, 1);
  assert.deepEqual([it.patches![0].file, it.patches![0].add, it.patches![0].cut, it.patches![0].hunks[0].lines.length], ['~/big.txt', 450, true, 400]);
  assert.equal(it.moreFiles, undefined);
});

test('previewOf: 20 lines, 4 KB at most, the count of all lines', () => {
  assert.deepEqual(previewOf(''), { text: '', lines: 0, cut: false });
  assert.deepEqual(previewOf('one\ntwo\n'), { text: 'one\ntwo', lines: 2, cut: false });
  const lines = Array.from({ length: 25 }, (_, i) => `l${i}`);
  assert.deepEqual(previewOf(lines.join('\n')), { text: lines.slice(0, 20).join('\n'), lines: 25, cut: true });
  assert.deepEqual(previewOf(lines.slice(0, 20).join('\n')), { text: lines.slice(0, 20).join('\n'), lines: 20, cut: false });
  const wide = previewOf('é'.repeat(3000)); // 6000 bytes on one line
  assert.equal(wide.cut, true);
  assert.equal(wide.text, 'é'.repeat(2048), 'cut at a character, not inside one');
  assert.equal(wide.lines, 1);
});

test('tool steps: input and result preview, the span of the result record, and the full read', () => {
  const file = findTranscript(CLAUDE, ID.tools) as string;
  const recs: JsonRecord[] = [];
  const spans: Span[] = [];
  new Tailer(file, { onRecords: (r, s) => { recs.push(...r); spans.push(...s); }, pollMs: 0, watch: false, chunkBytes: 512 }).check();
  assert.equal(recs.length, spans.length);
  const t = new Transcript({ home: HOME });
  t.pushAll(recs, spans);
  const bash = byId(t, 'toolu_bash1');
  assert.equal(bash.input, 'ls -la /Users/fixture/dev/demo');
  assert.deepEqual(bash.out, { text: 'notes.md\nREADME.md', lines: 2, cut: false });
  assert.equal(byId(t, 'toolu_grep1').input, 'pattern: TODO');
  assert.equal(byId(t, 'toolu_edit1').input, undefined, 'an edit shows its diff instead');
  const span = t.resultSpan('toolu_read1')!;
  assert.equal(readResult(file, span, 'toolu_read1'), 'File does not exist.', 'a record holding two results, read across 512-byte chunks');
  assert.equal(readResult(file, span, 'toolu_bash1'), 'notes.md\nREADME.md');
  assert.equal(readResult(file, { offset: span.offset + 1, length: span.length }, 'toolu_bash1'), null, 'not a record there');
  assert.equal(readResult(file + '.gone', span, 'toolu_bash1'), null);
});

test('tools: title, PRs, model, effort and mode', () => {
  const t = load(ID.tools);
  assert.equal(t.title, 'Demo notes cleanup'); // custom-title beats a later ai-title
  assert.deepEqual(t.prs, [102, 103, 104, 105]);
  assert.equal(t.requestedModel, 'claude-opus-4-1');
  assert.equal(t.effort, 'high');
  assert.equal(t.permissionMode, 'auto');
  assert.equal(t.view(3).items.length, 3);
  assert.equal(t.view(3).total, 15);
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
    toolUseId: 'toolu_bgsh1', taskId: 'bash_1', kind: 'shell', description: 'Build the demo', command: 'make demo-build',
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
    model: 'haiku', depth: 1, finished: true, running: false, review: false, stopped: false,
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

test('slice 3: a plan shows as Claude\'s reply, and a stored card answer lands on the tool once its result does', () => {
  const answers: Record<string, string> = { 'tu-bash': 'Allow once' };
  const t = new Transcript({ home: HOME, answerOf: (id) => answers[id] });
  t.push({ type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [
    { type: 'tool_use', id: 'tu-plan', name: 'ExitPlanMode', input: { plan: '1. Read it\n2. Fix it', planFilePath: '/tmp/p.md' } },
  ] } });
  assert.deepEqual([byId(t, 'plan:tu-plan').k, byId(t, 'plan:tu-plan').text], ['claude', '1. Read it\n2. Fix it']);
  assert.equal(byId(t, 'tu-plan').k, 'tool');
  t.push({ type: 'assistant', uuid: 'a2', message: { id: 'm2', content: [{ type: 'tool_use', id: 'tu-bash', name: 'Bash', input: { command: 'ls' } }] } });
  assert.equal(byId(t, 'tu-bash').answer, undefined, 'no answer before the result');
  t.push({ type: 'user', uuid: 'u2', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-bash', content: 'ok' }] } });
  assert.equal(byId(t, 'tu-bash').answer, 'Allow once');
  // A rewritten file resets the reader; the stored answers still apply on the re-read.
  t.reset();
  t.push({ type: 'assistant', uuid: 'a2', message: { id: 'm2', content: [{ type: 'tool_use', id: 'tu-bash', name: 'Bash', input: { command: 'ls' } }] } });
  t.push({ type: 'user', uuid: 'u2', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-bash', content: 'ok' }] } });
  assert.equal(byId(t, 'tu-bash').answer, 'Allow once');
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

// The shapes a live session writes (made-up content): an Agent launched async, its hand-back and its
// task notification queued during the turn as `attachment` records, background task ids from results.
const at = (s: number) => `2026-11-21T10:00:${String(s).padStart(2, '0')}.000Z`;
const queued = (uuid: string, s: number, prompt: string, kind: string): JsonRecord => ({
  type: 'attachment', uuid, timestamp: at(s),
  attachment: { type: 'queued_command', prompt, commandMode: kind === 'peer' ? 'prompt' : 'task-notification', origin: { kind } },
});
const result = (uuid: string, tid: string, tur: JsonRecord): JsonRecord => ({
  type: 'user', uuid, timestamp: at(2), toolUseResult: tur,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: 'ok' }] },
});

function liveShapes(): Transcript {
  const t = new Transcript({ home: HOME });
  t.pushAll([
    { type: 'user', uuid: 'l-u1', timestamp: at(0), message: { role: 'user', content: 'Start the helpers' } },
    { type: 'assistant', uuid: 'l-a1', timestamp: at(1), message: { id: 'm1', content: [
      { type: 'tool_use', id: 'toolu_la1', name: 'Agent', input: { description: 'For review: Draft the notes', subagent_type: 'Explore' } },
      { type: 'tool_use', id: 'toolu_la2', name: 'Agent', input: { description: 'Count files', subagent_type: 'Explore' } },
      { type: 'tool_use', id: 'toolu_lsh', name: 'Bash', input: { command: 'sleep 120', description: 'Sleep', run_in_background: true } },
      { type: 'tool_use', id: 'toolu_lmon', name: 'Monitor', input: { command: 'tail -f x.log', description: 'Watch the log', timeout_ms: 60000 } },
    ] } },
    result('l-r1', 'toolu_la1', { status: 'async_launched', agentId: 'abc001', description: 'd', prompt: 'p', outputFile: '/tmp/o' }),
    result('l-r2', 'toolu_la2', { status: 'async_launched', agentId: 'abc002', description: 'd', prompt: 'p', outputFile: '/tmp/o' }),
    result('l-r3', 'toolu_lsh', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bsh01' }),
    result('l-r4', 'toolu_lmon', { taskId: 'bmon1', timeoutMs: 60000 }),
  ]);
  t.setAgent('abc001', { agentType: 'Explore', description: 'For review: Draft the notes', toolUseId: 'toolu_la1', finished: false });
  t.setAgent('abc002', { agentType: 'Explore', description: 'Count files', toolUseId: 'toolu_la2' });
  return t;
}

test('live shapes: an async Agent runs until its notification; background task ids', () => {
  const t = liveShapes();
  assert.deepEqual(['toolu_la1', 'toolu_la2'].map((id) => byId(t, id).state), ['running', 'running']);
  assert.deepEqual(t.agents().map((a) => [a.id, a.running]), [['abc001', true], ['abc002', true]]);
  assert.deepEqual(t.background().map((b) => [b.toolUseId, b.taskId, b.status]), [['toolu_lsh', 'bsh01', 'running'], ['toolu_lmon', 'bmon1', 'running']]);
  assert.equal(byId(t, 'toolu_lmon').obj, 'Watch the log');
});

test('live shapes: hand-back and task notifications queued as attachments give one report each', () => {
  const t = liveShapes();
  t.takeChanges();
  t.pushAll([
    queued('l-q1', 10, '<agent-message from="abc001">\n[Subagent hand-back] Made-up preface. The report follows:\n  Notes are drafted.\n  - one point\n</agent-message>', 'peer'),
    queued('l-q2', 11, '<task-notification>\n<task-id>abc001</task-id>\n<tool-use-id>toolu_la1</tool-use-id>\n<status>completed</status>\n<summary>Agent done</summary>\n<result>I handed back.</result>\n</task-notification>', 'task-notification'),
    queued('l-q3', 12, '<task-notification>\n<task-id>abc002</task-id>\n<tool-use-id>toolu_la2</tool-use-id>\n<status>completed</status>\n<summary>Agent done</summary>\n<result>There are 3 files.\n</result>\n</task-notification>', 'task-notification'),
    queued('l-q4', 13, '<task-notification>\n<task-id>bmon1</task-id>\n<summary>Monitor event</summary>\n<event>tick</event>\n</task-notification>', 'task-notification'),
    { type: 'user', uuid: 'l-n5', timestamp: at(14), origin: { kind: 'task-notification' },
      message: { role: 'user', content: '<task-notification>\n<task-id>bsh01</task-id>\n<tool-use-id>toolu_lsh</tool-use-id>\n<status>killed</status>\n<summary>Stopped</summary>\n</task-notification>' } },
  ]);
  assert.deepEqual(t.items.filter((i) => i.k === 'report').map((r) => [r.id, r.agent, r.text]), [
    ['report:abc001', 'abc001', 'Notes are drafted.\n- one point'],
    ['report:abc002', 'abc002', 'There are 3 files.'],
  ]);
  assert.deepEqual(t.agents().map((a) => [a.id, a.running, a.review]), [['abc001', false, true], ['abc002', false, false]]);
  assert.deepEqual(['toolu_la1', 'toolu_la2'].map((id) => byId(t, id).state), ['done', 'done']);
  // a monitor's event keeps it running; the stopped shell is over
  assert.deepEqual(t.background().map((b) => [b.toolUseId, b.status]), [['toolu_lsh', 'killed'], ['toolu_lmon', 'running']]);
  const ch = t.takeChanges();
  assert.ok(ch.agents.includes('abc001') && ch.background.includes('toolu_lsh'));
});

test('live shapes: a result notification first, then the hand-back, keeps one report', () => {
  const t = liveShapes();
  t.pushAll([
    queued('l-q2', 11, '<task-notification><task-id>abc001</task-id><tool-use-id>toolu_la1</tool-use-id><status>stopped</status><result>Partial.</result></task-notification>', 'task-notification'),
    queued('l-q1', 12, '<agent-message from="abc001">\n[Subagent hand-back] The report follows:\n  Final.\n</agent-message>', 'peer'),
  ]);
  assert.deepEqual(t.items.filter((i) => i.k === 'report').map((r) => [r.id, r.text]), [['report:abc001', 'Final.']]);
  assert.equal(t.getAgent('abc001')!.stopped, true);
});

test('live shapes: a notification by task id only, and a report sent as a user record, stay one report', () => {
  const t = liveShapes();
  t.pushAll([
    { type: 'user', uuid: 'l-n1', timestamp: at(20), message: { role: 'user', content: '<task-notification>\n<task-id>abc002</task-id>\n<status>completed</status>\n<result>Counted.</result>\n</task-notification>' } },
    { type: 'user', uuid: 'l-m1', isMeta: true, timestamp: at(21), message: { role: 'user', content: 'Another Claude session sent a message: <agent-message from="abc002">\n[Subagent hand-back] The report follows:\n  Three files.\n</agent-message>' } },
    { type: 'user', uuid: 'l-m2', isMeta: true, timestamp: at(22), message: { role: 'user', content: 'Another Claude session sent a message: <agent-message from="fff999">\nThe report follows:\n  From elsewhere.\n</agent-message>' } },
  ]);
  assert.deepEqual(t.items.filter((i) => i.k === 'report').map((r) => [r.id, r.text]), [['report:abc002', 'Three files.'], ['l-m2', 'From elsewhere.']]);
  assert.equal(t.getAgent('abc002')!.running, false);
  assert.equal(byId(t, 'toolu_la2').state, 'done');
});

test('process ended: running shells, monitors and subagents started before it read as stopped', () => {
  const t = liveShapes();
  t.pushAll([queued('l-q2', 11, '<task-notification>\n<task-id>abc002</task-id>\n<tool-use-id>toolu_la2</tool-use-id>\n<status>completed</status>\n<summary>Agent done</summary>\n<result>Done.</result>\n</task-notification>', 'task-notification')]);
  t.takeChanges();
  t.processEnded(at(20));
  const ch = t.takeChanges();
  assert.deepEqual(t.background().map((b) => [b.toolUseId, b.status, b.end]), [['toolu_lsh', 'stopped', at(20)], ['toolu_lmon', 'stopped', at(20)]]);
  assert.deepEqual(t.agents().map((a) => [a.id, a.running, a.finished, a.stopped]), [['abc001', false, true, true], ['abc002', false, true, false]], 'a finished one stays finished');
  assert.equal(byId(t, 'toolu_la1').state, 'done', 'no longer "Running in the background"');
  assert.deepEqual(ch.background.sort(), ['toolu_lmon', 'toolu_lsh']);
  assert.ok(ch.agents.includes('abc001'));
  // work started after the end runs; a late notification still wins
  t.pushAll([
    { type: 'assistant', uuid: 'l-a9', timestamp: at(30), message: { id: 'm9', content: [
      { type: 'tool_use', id: 'toolu_new', name: 'Bash', input: { command: 'sleep 5', description: 'Later', run_in_background: true } }] } },
    { type: 'user', uuid: 'l-n9', timestamp: at(31), origin: { kind: 'task-notification' },
      message: { role: 'user', content: '<task-notification>\n<task-id>bsh01</task-id>\n<tool-use-id>toolu_lsh</tool-use-id>\n<status>completed</status>\n<summary>Done</summary>\n</task-notification>' } },
  ]);
  assert.equal(t.getBackground('toolu_new')!.status, 'running');
  assert.equal(t.getBackground('toolu_lsh')!.status, 'completed');
});

test('process ended: kept across a rewrite, and applied to records read after it', () => {
  const t = new Transcript({ home: HOME });
  t.processEnded(at(20));
  t.reset();
  const fresh = liveShapes();
  t.pushAll([
    { type: 'assistant', uuid: 'l-a1', timestamp: at(1), message: { id: 'm1', content: [
      { type: 'tool_use', id: 'toolu_lsh', name: 'Bash', input: { command: 'sleep 120', description: 'Sleep', run_in_background: true } }] } },
  ]);
  assert.equal(t.getBackground('toolu_lsh')!.status, 'stopped');
  assert.equal(fresh.getBackground('toolu_lsh')!.status, 'running', 'without an end it still runs');
});

test('process ended: a foreground tool left without a result reads as stopped, or failed when the process failed', () => {
  const recs: JsonRecord[] = [
    { type: 'assistant', uuid: 'f-a1', timestamp: at(1), message: { id: 'm1', content: [
      { type: 'tool_use', id: 'toolu_fg', name: 'Bash', input: { command: 'sleep 60', description: 'Wait' } },
      { type: 'tool_use', id: 'toolu_ok', name: 'Read', input: { file_path: '/tmp/a.txt' } },
      { type: 'tool_use', id: 'toolu_plan', name: 'ExitPlanMode', input: { plan: 'Do it.' } }] } },
    { type: 'user', uuid: 'f-u1', timestamp: at(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ok', content: 'a' }] } },
  ];
  const closed = new Transcript({ home: HOME });
  closed.pushAll(recs);
  assert.equal(byId(closed, 'toolu_fg').state, 'running');
  closed.takeChanges();
  closed.processEnded(at(10));
  assert.equal(byId(closed, 'toolu_fg').state, 'stopped');
  assert.ok(closed.takeChanges().items.includes('toolu_fg'), 'pages get it');
  assert.equal(byId(closed, 'toolu_ok').state, 'done');
  assert.equal(byId(closed, 'toolu_plan').state, 'running', 'an unanswered plan stays "Not answered"');
  const failed = new Transcript({ home: HOME });
  failed.processEnded(at(10), true); // as after a restart: the mark comes first, then the records
  failed.reset();
  failed.pushAll(recs);
  assert.equal(byId(failed, 'toolu_fg').state, 'failed');
  // a tool started after the end runs; a result the CLI wrote for an interrupt reads as stopped
  failed.pushAll([
    { type: 'assistant', uuid: 'f-a2', timestamp: at(20), message: { id: 'm2', content: [
      { type: 'tool_use', id: 'toolu_new', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_use', id: 'toolu_int', name: 'Bash', input: { command: 'sleep 9' } }] } },
    { type: 'user', uuid: 'f-u2', timestamp: at(21), message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_int', is_error: true, content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] }] } },
  ]);
  assert.equal(byId(failed, 'toolu_new').state, 'running');
  assert.equal(byId(failed, 'toolu_int').state, 'stopped');
});

test('interrupt: the tool an interrupt cut short reads as stopped, an earlier failure stays failed', () => {
  const t = new Transcript({ home: HOME });
  const err = (id: string) => ({ type: 'tool_result', tool_use_id: id, is_error: true, content: 'no' });
  t.pushAll([
    { type: 'assistant', uuid: 'i-a1', timestamp: at(1), message: { id: 'm1', content: [{ type: 'tool_use', id: 'toolu_f', name: 'Bash', input: { command: 'false' } }] } },
    { type: 'user', uuid: 'i-u1', timestamp: at(2), message: { role: 'user', content: [err('toolu_f')] } },
    { type: 'assistant', uuid: 'i-a2', timestamp: at(3), message: { id: 'm2', content: [{ type: 'tool_use', id: 'toolu_p', name: 'Bash', input: { command: 'ping -c 45 127.0.0.1' } }] } },
    { type: 'user', uuid: 'i-u2', timestamp: at(4), message: { role: 'user', content: [err('toolu_p')] } },
    { type: 'user', uuid: 'i-u3', timestamp: at(4), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } },
  ]);
  assert.deepEqual([byId(t, 'toolu_f').state, byId(t, 'toolu_p').state], ['failed', 'stopped']);
});

test('a tool you denied, or a plan you sent back, reads as denied, not failed', () => {
  const answers: Record<string, string> = { toolu_p: 'Changes: use "final"', toolu_d: 'Denied', toolu_ok: 'Approved' };
  const t = new Transcript({ home: HOME, answerOf: (id) => answers[id] });
  const err = (id: string) => ({ type: 'tool_result', tool_use_id: id, is_error: true, content: 'rejected' });
  t.pushAll([
    { type: 'assistant', uuid: 'd-a1', timestamp: at(1), message: { id: 'm1', content: [
      { type: 'tool_use', id: 'toolu_p', name: 'ExitPlanMode', input: { plan: 'Draft.' } },
      { type: 'tool_use', id: 'toolu_d', name: 'Bash', input: { command: 'rm x' } },
      { type: 'tool_use', id: 'toolu_e', name: 'Bash', input: { command: 'false' } }] } },
    { type: 'user', uuid: 'd-u1', timestamp: at(2), message: { role: 'user', content: [err('toolu_p'), err('toolu_d'), err('toolu_e')] } },
  ]);
  assert.deepEqual(['toolu_p', 'toolu_d', 'toolu_e'].map((id) => byId(t, id).state), ['denied', 'denied', 'failed']);
  assert.equal(byId(t, 'toolu_p').answer, 'Changes: use "final"');
});

test("task ended: the SDK's notification ends a background shell until the JSONL's own lands", () => {
  const t = new Transcript({ home: HOME });
  t.pushAll([
    { type: 'assistant', uuid: 'k-a1', timestamp: at(1), message: { id: 'm1', content: [
      { type: 'tool_use', id: 'toolu_sl', name: 'Bash', input: { command: 'sleep 300', description: 'Long sleep', run_in_background: true } }] } },
    { type: 'user', uuid: 'k-u1', timestamp: at(2), toolUseResult: { backgroundTaskId: 'bsl1' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_sl', content: 'started' }] } },
  ]);
  assert.equal(t.getBackground('toolu_sl')!.status, 'running');
  t.takeChanges();
  t.taskEnded('toolu_sl', 'stopped', '', at(5));
  assert.deepEqual([t.getBackground('toolu_sl')!.status, t.getBackground('toolu_sl')!.end], ['stopped', at(5)]);
  assert.deepEqual(t.takeChanges().background, ['toolu_sl']);
  t.pushAll([{ type: 'user', uuid: 'k-n1', timestamp: at(9), origin: { kind: 'task-notification' },
    message: { role: 'user', content: '<task-notification>\n<task-id>bsl1</task-id>\n<tool-use-id>toolu_sl</tool-use-id>\n<status>killed</status>\n<summary>Killed</summary>\n</task-notification>' } }]);
  assert.deepEqual([t.getBackground('toolu_sl')!.status, t.getBackground('toolu_sl')!.end], ['killed', at(9)]);
});

test('plan: the text the card showed wins over an older one in the JSONL', () => {
  const plans: Record<string, string> = {};
  const t = new Transcript({ home: HOME, planOf: (id) => plans[id] });
  const ask = { type: 'assistant', uuid: 'p-a1', timestamp: at(1), message: { id: 'm1', content: [
    { type: 'tool_use', id: 'toolu_pl', name: 'ExitPlanMode', input: { plan: 'Write "draft".' } }] } };
  t.pushAll([ask]);
  assert.equal(byId(t, 'plan:toolu_pl').text, 'Write "draft".');
  plans.toolu_pl = 'Write "final".'; // stored when you answered the card
  t.takeChanges();
  t.pushAll([{ type: 'user', uuid: 'p-u1', timestamp: at(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_pl', content: 'ok' }] } }]);
  assert.equal(byId(t, 'plan:toolu_pl').text, 'Write "final".');
  assert.ok(t.takeChanges().items.includes('plan:toolu_pl'), 'pages get it');
  const again = new Transcript({ home: HOME, planOf: (id) => plans[id] }); // after a restart
  again.pushAll([ask]);
  assert.equal(byId(again, 'plan:toolu_pl').text, 'Write "final".');
});

// The main turn by the transcript alone (a session another process drives). Made-up records.
const NOW = Date.parse('2026-11-23T12:00:00.000Z');
const QUIET = 30 * 60_000;
const ago = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const typed = (uuid: string, text: string, ts: string): JsonRecord => ({ type: 'user', uuid, timestamp: ts, message: { role: 'user', content: text } });
const replied = (uuid: string, ts: string, content: unknown[]): JsonRecord => ({ type: 'assistant', uuid, timestamp: ts, message: { role: 'assistant', content } });
const toolResult = (uuid: string, ts: string, tid: string, extra: object = {}): JsonRecord => ({ type: 'user', uuid, timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: 'ok', ...extra }] } });
const bashUse = (id: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } });

test('turn: a prompt opens it, turn_duration or stop_hook_summary closes it', () => {
  const t = new Transcript({ home: HOME });
  t.pushAll([typed('u1', 'Go', ago(5)), replied('a1', ago(4), [{ type: 'text', text: 'On it.' }])]);
  assert.equal(t.turnRunning(NOW, QUIET), true);
  t.pushAll([{ type: 'system', subtype: 'turn_duration', durationMs: 60000, timestamp: ago(4) }]);
  assert.equal(t.turnRunning(NOW, QUIET), false);
  t.pushAll([typed('u2', 'Again', ago(3))]);
  assert.equal(t.turnRunning(NOW, QUIET), true);
  t.pushAll([{ type: 'system', subtype: 'stop_hook_summary', timestamp: ago(2) }]);
  assert.equal(t.turnRunning(NOW, QUIET), false);
  t.pushAll([{ type: 'attachment', uuid: 'q1', timestamp: ago(1), attachment: { type: 'queued_command', prompt: 'and this', commandMode: 'prompt' } }]);
  assert.equal(t.turnRunning(NOW, QUIET), true, 'a queued message is taken in by a running turn');
});

test('turn: quiet for 30 min with no tool waiting is your turn; a tool without its result runs on', () => {
  const t = new Transcript({ home: HOME });
  t.pushAll([typed('u1', 'Go', ago(45)), replied('a1', ago(44), [{ type: 'text', text: 'On it.' }])]);
  assert.equal(t.turnRunning(NOW, QUIET), false, 'crashed or gone: not working for ever');
  t.pushAll([replied('a2', ago(40), [bashUse('toolu_long')])]);
  assert.equal(t.turnRunning(NOW, QUIET), true, 'a foreground tool still waits for its result');
  t.pushAll([toolResult('r1', ago(39), 'toolu_long')]);
  assert.equal(t.turnRunning(NOW, QUIET), false);
});

test('turn: "for tool use" is a tool you turned down, and Claude carrying on keeps it running; a plain interrupt ends it', () => {
  const t = new Transcript({ home: HOME });
  t.pushAll([
    typed('u1', 'Go', ago(5)),
    replied('a1', ago(5), [bashUse('toolu_rm')]),
    toolResult('r1', ago(4), 'toolu_rm', { is_error: true, content: "The user doesn't want to proceed with this tool use." }),
    typed('u2', '[Request interrupted by user for tool use]', ago(4)),
  ]);
  assert.equal(t.turnRunning(NOW, QUIET), false, 'nothing after the marker yet');
  t.pushAll([replied('a2', ago(3), [{ type: 'text', text: "I'll leave it." }])]);
  assert.equal(t.turnRunning(NOW, QUIET), true, 'Claude carried on');
  t.pushAll([typed('u3', '[Request interrupted by user]', ago(2))]);
  assert.equal(t.turnRunning(NOW, QUIET), false);
  assert.equal(t.items.at(-1)?.text, '[Request interrupted by user]', 'the page reads this last item as stopped by you');
});

// Shells and monitors a subagent started live in its own file (claude-rail fixture).
function loadRail(): Transcript {
  const claude = path.join(import.meta.dirname, 'fixtures', 'claude-rail');
  const file = findTranscript(claude, '66666666-0000-4000-8000-000000000006') as string;
  const main = new Transcript({ home: HOME });
  main.pushAll(records(file));
  const w = new SubagentWatcher(sessionDirOf(file), {
    onAgent: (aid, f) => {
      const sub = new Transcript({ sidechain: true, home: HOME });
      sub.pushAll(records(f));
      main.setAgent(aid, undefined, sub);
    },
    onMeta: (aid, meta) => main.setAgent(aid, meta),
  }, { pollMs: 0, watch: false });
  w.scan();
  return main;
}

test("subagents' shells and monitors: tagged, notified in either file, stopped with their subagent", () => {
  const t = loadRail();
  assert.deepEqual(t.background().map((b) => [b.toolUseId, b.agentId ?? null, b.kind, b.status, b.taskId]), [
    ['toolu_rsh', null, 'shell', 'running', 'bmain1'], // the main thread's own
    ['toolu_bsh1', 'bbbb0001', 'shell', 'running', 'bsub1'], // no notification, its subagent runs
    ['toolu_bmon1', 'bbbb0001', 'monitor', 'running', 'bsubm1'],
    ['toolu_bsh2', 'bbbb0001', 'shell', 'failed', 'bsub2'], // notified in the subagent's file
    ['toolu_bsh3', 'bbbb0001', 'shell', 'completed', 'bsub3'], // notified in the main file
    ['toolu_bsh4', 'bbbb0002', 'shell', 'stopped', 'bsub4'], // its subagent finished, no notification
  ]);
  const b4 = t.getBackground('toolu_bsh4');
  assert.deepEqual([b4?.summary, b4?.end], ['Ended with its subagent', '2026-11-20T13:03:50.000Z']);
  assert.equal(t.getBackground('toolu_bsh3')?.summary, 'Copied the icons');
  assert.ok(!t.items.some((i) => i.id.startsWith('toolu_bsh') || i.id.startsWith('toolu_bmon')), 'not in the main transcript');
});

test("subagents' shells and monitors: changes reported, and they end when their subagent does", () => {
  const t = loadRail();
  const first = t.takeChanges().background;
  for (const id of ['toolu_rsh', 'toolu_bsh1', 'toolu_bmon1', 'toolu_bsh4']) assert.ok(first.includes(id), id);
  assert.deepEqual(t.takeChanges().background, []);
  t.taskEnded('toolu_bmon1', 'stopped', '', '2026-11-20T13:07:00.000Z'); // the SDK's, by its tool use id
  assert.deepEqual(t.takeChanges().background, ['toolu_bmon1']);
  assert.equal(t.getBackground('toolu_bmon1')?.status, 'stopped');
  t.setAgent('bbbb0001', { agentType: 'general-purpose', description: 'Build image thumbnails', toolUseId: 'toolu_r1', finished: true });
  assert.ok(t.takeChanges().background.includes('toolu_bsh1'));
  assert.deepEqual([t.getBackground('toolu_bsh1')?.status, t.getBackground('toolu_bsh1')?.summary], ['stopped', 'Ended with its subagent']);
});
