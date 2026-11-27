// f, f (R9.8, FR-KEY-08): "send queued messages now". The route session.ts picks from what runs and
// what is queued (nowRoute), and what each route asks of the process (docs/Agent SDK.md, "Sending
// queued messages now", live runs PR-1 and PR-2). Made-up sessions on the fake SDK.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transcripts } from '../src/transcripts.ts';
import { Publisher } from '../src/publisher.ts';
import { Sessions } from '../src/sessions.ts';
import { nowRoute, NOTHING_QUEUED } from '../src/session.ts';
import { emit, fakeQuery } from './support/fake-query.ts';
import { openStore } from '../src/store.ts';
import type { Client } from '../src/server.ts';
import type { CanUseTool, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

type Msg = { t: string; [k: string]: unknown };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const SID = '99999999-0000-4000-8000-0000000000f1';
const init = { type: 'system', subtype: 'init', session_id: SID, uuid: 'u-init' };
const U1 = '99999999-0000-4000-8000-00000000aa01';
const U2 = '99999999-0000-4000-8000-00000000aa02';
const DRAFT = '99999999-0000-4000-8000-00000000dd01';

// One open session whose transcript holds a prompt and, with `bash`, a running foreground Bash.
async function setup(o: { bash?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-sendnow-'));
  const claudeDir = path.join(root, 'claude'), cwd = path.join(root, 'scratch');
  const dir = path.join(claudeDir, 'projects', '-tmp-sendnow');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const rec = (r: object) => JSON.stringify({ sessionId: SID, cwd, ...r }) + '\n';
  fs.writeFileSync(path.join(dir, `${SID}.jsonl`), rec({ type: 'user', uuid: 'n-u1', timestamp: '2026-11-25T10:00:00.000Z', message: { role: 'user', content: 'Build it' } })
    + (o.bash ? rec({ type: 'assistant', uuid: 'n-a1', timestamp: '2026-11-25T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_nb', name: 'Bash', input: { command: 'sleep 40', description: 'Wait' } }] } }) : ''));
  const got: Msg[] = [];
  const c: Client = { send: (m) => got.push(JSON.parse(JSON.stringify(m))), close: () => {} };
  const store = openStore(path.join(root, 'state'), { minIntervalMs: 0 });
  let sessions: Sessions | null = null;
  const transcripts = new Transcripts({ claudeDir, home: root, pollMs: 0, watch: false });
  const publisher = new Publisher({ transcripts, clients: () => new Set([c]), home: root, recheckMs: 0, onRunning: (sid, r) => sessions?.runningChanged(sid, r) });
  const q = fakeQuery({ sessions: [{ sessionId: SID, summary: 'made up', lastModified: 1000, cwd }] });
  const logs: { e: string; d: Record<string, unknown> }[] = [];
  sessions = new Sessions({ store, transcripts, publisher, sdk: q.sdk, home: root, log: (e, d) => logs.push({ e, d: (d ?? {}) as Record<string, unknown> }) });
  await sessions.openSession(SID);
  transcripts.poll();
  const s = sessions.get(SID)!;
  s.send('go');
  await tick();
  const call = q.calls[0];
  emit(call, init);
  await tick();
  const stop = () => { sessions!.stop(); transcripts.stop(); publisher.stop(); };
  const pushes = () => call.inputs.map((m: SDKUserMessage) => ({ text: typeof m.message.content === 'string' ? m.message.content : '', priority: m.priority ?? null, origin: m.origin?.kind ?? null }));
  const route = () => [...logs].reverse().find((l) => l.e === 'session.sendNow')?.d.route;
  const append = (r: object) => { fs.appendFileSync(path.join(dir, `${SID}.jsonl`), rec(r)); transcripts.poll(); };
  return { s, call, got, logs, stop, pushes, route, transcripts, append };
}

test('nowRoute: the route table, and never "now" while anything is queued', () => {
  const base = { driven: true, working: true, cards: 0, queued: 0, draft: false, fg: { ready: [] as string[], early: [] as string[] } };
  assert.deepEqual(nowRoute({ ...base, draft: true }), { kind: 'now' }, 'nothing queued, a draft');
  assert.deepEqual(nowRoute(base), { kind: 'none', error: NOTHING_QUEUED });
  assert.deepEqual(nowRoute({ ...base, queued: 2, fg: { ready: ['toolu_a'], early: [] } }), { kind: 'background', ids: ['toolu_a'] });
  assert.deepEqual(nowRoute({ ...base, queued: 2, fg: { ready: ['toolu_a'], early: ['toolu_b'] } }), { kind: 'wait', ids: ['toolu_b'] }, 'a step in its 2 s gap is waited for');
  assert.deepEqual(nowRoute({ ...base, queued: 1 }), { kind: 'interrupt' }, 'Claude only writing');
  assert.equal(nowRoute({ ...base, queued: 1, cards: 1, draft: true }).kind, 'none', 'a card comes first');
  assert.equal(nowRoute({ ...base, driven: false, queued: 1, draft: true }).kind, 'none', 'not our process');
  assert.deepEqual(nowRoute({ ...base, working: false, draft: true }), { kind: 'send' }, 'the turn ended meanwhile: a plain send');
  for (const queued of [1, 3]) for (const draft of [true, false]) for (const ready of [[], ['t1']]) for (const early of [[], ['t2']]) {
    assert.notEqual(nowRoute({ ...base, queued, draft, fg: { ready, early } }).kind, 'now', `queued ${queued}`);
  }
});

test('sendNow: a draft with nothing queued goes as priority now with a human origin', async () => {
  const t = await setup();
  assert.deepEqual(await t.s.sendNow(null), { ok: false, error: NOTHING_QUEUED }, 'nothing queued, no draft');
  const r = await t.s.sendNow({ text: 'Look at the README first', images: [], uuid: DRAFT });
  assert.deepEqual(r, { ok: true, sid: SID });
  assert.equal(t.route(), 'now');
  await tick();
  assert.deepEqual(t.pushes().at(-1), { text: 'Look at the README first', priority: 'now', origin: 'human' });
  assert.equal(t.call.interrupts.length, 0);
  assert.equal(t.call.controls.filter(([k]) => k === 'backgroundTasks').length, 0);
  const shown = (t.got.filter((m) => m.t === 'session' && Array.isArray(m.outbox)).at(-1)?.outbox ?? []) as { id: string; queued?: boolean }[];
  assert.ok(shown.some((o) => o.id === DRAFT && o.queued), 'the draft shows as a queued band until it lands');
  t.stop();
});

test('sendNow: messages queued and a foreground Bash: backgroundTasks(its id), then the draft at the default priority', async () => {
  const t = await setup({ bash: true });
  t.s.send('one', [], U1); t.s.send('two', [], U2);
  emit(t.call, { type: 'system', subtype: 'task_started', task_id: 'bnb1', tool_use_id: 'toolu_nb', description: 'Wait', is_backgrounded: false, task_type: 'local_bash', uuid: 'u-ts', session_id: SID });
  await tick();
  assert.deepEqual(await t.s.sendNow({ text: 'three', images: [], uuid: DRAFT }), { ok: true, sid: SID });
  assert.equal(t.route(), 'background');
  await tick();
  assert.deepEqual(t.call.controls.filter(([k]) => k === 'backgroundTasks'), [['backgroundTasks', 'toolu_nb']], 'only that step');
  assert.equal(t.call.interrupts.length, 0);
  assert.deepEqual(t.pushes().slice(-3).map((p) => [p.text, p.priority]), [['one', null], ['two', null], ['three', null]], 'never now with a queue');
  t.stop();
});

test('sendNow: a Bash in its 2 s gap is waited for, then moved', async () => {
  const t = await setup({ bash: true });
  t.s.send('one', [], U1);
  await tick();
  const p = t.s.sendNow(null);
  await tick(150);
  assert.equal(t.call.controls.filter(([k]) => k === 'backgroundTasks').length, 0, 'not before its task_started');
  emit(t.call, { type: 'system', subtype: 'task_started', task_id: 'bnb1', tool_use_id: 'toolu_nb', description: 'Wait', is_backgrounded: false, task_type: 'local_bash', uuid: 'u-ts', session_id: SID });
  assert.deepEqual(await p, { ok: true, sid: SID });
  assert.deepEqual(t.call.controls.filter(([k]) => k === 'backgroundTasks'), [['backgroundTasks', 'toolu_nb']]);
  t.stop();
});

test('sendNow: messages queued while Claude writes: the plain interrupt, no Stop, the queue not given back', async () => {
  const t = await setup();
  t.s.send('one', [], U1); t.s.send('two', [], U2);
  t.call.reply = { still_queued: [U1, U2] };
  t.got.length = 0;
  assert.deepEqual(await t.s.sendNow({ text: 'three', images: [], uuid: DRAFT }), { ok: true, sid: SID });
  assert.equal(t.route(), 'interrupt');
  await tick();
  assert.deepEqual(t.call.interrupts, [undefined], 'without cancelQueued');
  assert.deepEqual(t.pushes().at(-1), { text: 'three', priority: null, origin: null });
  emit(t.call, { type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', uuid: 'u-r', session_id: SID });
  await tick();
  assert.equal(t.got.filter((m) => m.t === 'restore').length, 0, 'nothing back in the box');
  assert.equal(t.got.filter((m) => m.t === 'toast').length, 0, 'no toast');
  assert.notEqual(t.s.status.status, 'stopped', 'not shown as a Stop');
  assert.notEqual(t.s.status.status, 'failed');
  t.stop();
});

test('sendNow, the interrupt route: the live line stays as a still aside, and the reply it cut short is marked as its', async () => {
  const t = await setup();
  const ev = (event: object) => emit(t.call, { type: 'stream_event', event, parent_tool_use_id: null, uuid: 'u-se', session_id: SID });
  ev({ type: 'message_start', message: { id: 'msg_cut' } });
  ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The build is half' } });
  await tick();
  t.s.send('one', [], U1);
  t.call.reply = { still_queued: [U1] };
  assert.deepEqual(await t.s.sendNow(null), { ok: true, sid: SID });
  assert.equal(t.route(), 'interrupt');
  const items = () => t.transcripts.get(SID)!.items;
  const aside = items().find((i) => i.k === 'aside');
  assert.ok(aside && aside.step === undefined, 'Claude only wrote: the line names no step');
  t.append({ type: 'assistant', uuid: 'n-a9', timestamp: new Date().toISOString(), message: { role: 'assistant', id: 'msg_cut', content: [{ type: 'text', text: 'The build is half' }] } });
  await tick(20);
  const text = items().find((i) => i.k === 'claude');
  assert.equal(text?.aside, aside!.id, 'the partial reply that lands after it is greyed with it');
  t.stop();
});

test('sendNow, the background route: no aside, the step goes to the background', async () => {
  const t = await setup({ bash: true });
  t.transcripts.taskStarted(SID, 'toolu_nb', 'bnb1');
  t.s.send('one', [], U1);
  assert.deepEqual(await t.s.sendNow(null), { ok: true, sid: SID });
  assert.equal(t.route(), 'background');
  assert.equal(t.transcripts.get(SID)!.items.some((i) => i.k === 'aside'), false);
  t.stop();
});

test('sendNow: with a card waiting it does nothing, and the draft stays the page\'s', async () => {
  const t = await setup();
  t.s.send('one', [], U1);
  const ctl = new AbortController();
  void (t.call.options.canUseTool as CanUseTool)('Bash', { command: 'rm -rf build', description: 'Clean' }, { signal: ctl.signal, toolUseID: 'tu-c', requestId: 'rq-c' } as Parameters<CanUseTool>[2]);
  await tick();
  const before = t.call.inputs.length;
  const r = await t.s.sendNow({ text: 'three', images: [], uuid: DRAFT });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /Answer it first/);
  assert.equal(t.route(), 'none');
  assert.equal(t.call.inputs.length, before, 'nothing pushed');
  assert.equal(t.call.interrupts.length + t.call.controls.filter(([k]) => k === 'backgroundTasks').length, 0);
  ctl.abort();
  t.stop();
});
