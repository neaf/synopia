import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transcripts } from '../src/transcripts.ts';
import { Publisher } from '../src/publisher.ts';
import { Sessions } from '../src/sessions.ts';
import { StreamPreview } from '../src/session.ts';
import { STATE_FLAG } from '../src/sdk.ts';
import { emit, fakeQuery } from './support/fake-query.ts';
import { openStore } from '../src/store.ts';
import { patchUi } from '../src/ui-state.ts';
import type { Client } from '../src/server.ts';
import type { TerminalSource } from '../src/session.ts';
import type { Terminal } from '../src/cli-terminals.ts';
import type { CanUseTool, SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';

type Msg = { t: string; [k: string]: unknown };
const tick = () => new Promise((r) => setTimeout(r, 5));

const init = (id: string) => ({ type: 'system', subtype: 'init', session_id: id, uuid: 'u-init' });
const RESULT = { type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed' };
const REAL = '11111111-2222-4333-8444-555555555555';
const RESET = '66666666-7777-4888-8999-aaaaaaaaaaaa';

function setup(dir?: string, past: SDKSessionInfo[] = [], extra: { idleMs?: number; onWaiting?: (sid: string) => void; now?: () => number; terminals?: TerminalSource } = {}) {
  const root = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-sessions-'));
  const claudeDir = path.join(root, 'claude');
  const stateDir = path.join(root, 'state');
  const cwd = path.join(root, 'scratch');
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const got: Msg[] = [];
  const c: Client = { send: (m) => got.push(JSON.parse(JSON.stringify(m))), close: () => {} };
  const clients = new Set<Client>([c]);
  const store = openStore(stateDir, { minIntervalMs: 0 });
  store.state.settings.newSessionCwd = cwd;
  store.state.settings.model = 'haiku';
  let sessions: Sessions | null = null;
  const transcripts = new Transcripts({ claudeDir, home: root, pollMs: 0, watch: false, onAssistant: (sid, mid, types) => sessions?.landed(sid, mid, types) });
  const publisher = new Publisher({ transcripts, clients: () => clients, home: root, recheckMs: 0, onRunning: (sid, r) => sessions?.runningChanged(sid, r), layout: () => sessions?.layout.get() });
  const q = fakeQuery({ sessions: past });
  sessions = new Sessions({ store, transcripts, publisher, sdk: q.sdk, home: root, ...extra });
  const take = (t?: string) => { const out = got.filter((m) => !t || m.t === t); got.length = 0; return out; };
  return { root, claudeDir, cwd, c, store, transcripts, publisher, sessions, q, take };
}

test('sessions: a placeholder takes its real id from system/init', async () => {
  const { sessions, store, q, take, cwd, c, transcripts, publisher } = setup();
  const ph = sessions.newSession();
  assert.match(ph, /^new-/);
  const first = take('session');
  assert.equal(first.length, 1);
  assert.equal(first[0].id, ph);
  assert.equal(first[0].title, 'New session');
  assert.equal(store.state.open.length, 0, 'a placeholder is not stored');
  publisher.view(c, ph, null);

  assert.equal(sessions.get(ph)!.send('hello').ok, true);
  await tick();
  assert.equal(q.calls.length, 1);
  const o = q.calls[0].options;
  assert.equal(o.cwd, cwd);
  assert.equal(o.resume, undefined);
  assert.equal(o.model, 'haiku');
  assert.equal(o.permissionMode, undefined, 'your own permission setting applies');
  assert.equal(o.includePartialMessages, true);
  assert.equal(o.perTaskStopAffordance, true);
  assert.deepEqual(o.settings, { bashEditDiffEnabled: true }, 'shell edits get a diff (bashEditDiff)');
  assert.equal((o.env as Record<string, string>)[STATE_FLAG], '1');
  assert.equal(o.settingSources, undefined);
  assert.equal(take('session').at(-1)?.state.status, 'busy');

  emit(q.calls[0], init(REAL));
  await tick();
  const swapped = take('session');
  assert.equal(swapped[0].replaces, ph);
  assert.equal(swapped[0].id, REAL);
  assert.deepEqual(store.state.open.map((e) => e.id), [REAL]);
  assert.equal(store.state.open[0].cwd, cwd);
  assert.deepEqual(store.state.layout.others, [REAL]);
  assert.equal(store.state.status[REAL].status, 'busy');
  assert.equal(sessions.resolve(ph), REAL);
  assert.deepEqual(transcripts.ids(), [REAL]);
});

test('sessions: two sends before init go to one process, in order', async () => {
  const { sessions, q } = setup();
  const ph = sessions.newSession();
  sessions.get(ph)!.send('one', [], '0e9b7f1c-0000-4000-8000-000000000001');
  sessions.get(ph)!.send('two [Image #1]', [{ mediaType: 'image/png', data: Buffer.from('png').toString('base64'), n: 1 }], '0e9b7f1c-0000-4000-8000-000000000002');
  await tick();
  assert.equal(q.calls.length, 1);
  const inputs = q.calls[0].inputs;
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].message.content, 'one');
  assert.equal(inputs[0].uuid, '0e9b7f1c-0000-4000-8000-000000000001');
  const blocks = inputs[1].message.content as { type: string }[];
  assert.deepEqual(blocks.map((b) => b.type), ['text', 'image'], 'as the CLI sends a pasted image: the text, then the image');
  assert.equal(inputs[1].uuid, '0e9b7f1c-0000-4000-8000-000000000002');

  emit(q.calls[0], init(REAL));
  await tick();
  sessions.get(ph)!.send('three'); // an old id still reaches the session
  await tick();
  assert.equal(q.calls.length, 1);
  assert.equal(inputs.length, 3);
});

test('sessions: images over 5 MB or not PNG/JPEG are refused', () => {
  const { sessions, q } = setup();
  const ph = sessions.newSession();
  const big = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
  assert.equal(sessions.get(ph)!.send('x', [{ mediaType: 'image/png', data: big }]).ok, false);
  assert.equal(sessions.get(ph)!.send('x', [{ mediaType: 'image/gif', data: 'R0lG' }]).ok, false);
  assert.equal(sessions.get(ph)!.send('x', [{ mediaType: 'image/png', data: '' }]).ok, false, 'empty image data is refused');
  assert.equal(q.calls.length, 0);
});

test('sessions: the alias map reaches the session through every id it had', async () => {
  const { sessions, q, transcripts, publisher, c, take } = setup();
  const ph = sessions.newSession();
  sessions.get(ph)!.send('hi');
  emit(q.calls[0], init(REAL));
  await tick();
  emit(q.calls[0], { type: 'conversation_reset', new_conversation_id: RESET, uuid: 'u-r', session_id: REAL, trigger: 'clear' });
  await tick();
  assert.equal(sessions.resolve(ph), RESET);
  assert.equal(sessions.resolve(REAL), RESET);
  assert.equal(sessions.resolve('unknown'), 'unknown');
  take();
  publisher.view(c, sessions.resolve(ph), null);
  const items = take('items');
  assert.equal(items[0].sid, RESET);
  assert.equal(items[0].reset, true);
});

test('sessions: conversation_reset moves the id in the open list, layout, models, rules and status', async () => {
  const { sessions, store, q, take } = setup();
  const ph = sessions.newSession();
  sessions.get(ph)!.send('hi');
  emit(q.calls[0], init(REAL));
  await tick();
  const st = store.state;
  st.open.push({ id: 'x', cwd: '/x', openedAt: 0, closedAt: 1 }); // a closed one, hidden in the group
  st.layout = { groups: [{ id: 'g1', name: 'Group', ids: ['x', REAL] }], others: [] };
  st.models[REAL] = { model: 'haiku', effort: 'low' };
  st.rules[REAL] = ['Bash(ls:*)'];
  st.written[REAL] = { title: 'Old title', now: 'Old now', at: 1 };
  take();
  emit(q.calls[0], { type: 'conversation_reset', new_conversation_id: RESET, uuid: 'u-r', session_id: REAL });
  await tick();
  assert.deepEqual(st.open.map((e) => e.id), [RESET, 'x']);
  assert.deepEqual(st.layout.groups[0].ids, ['x', RESET]);
  assert.deepEqual(st.models[RESET], { model: 'haiku', effort: 'low' });
  assert.equal(st.models[REAL], undefined);
  assert.deepEqual(st.rules[RESET], ['Bash(ls:*)']);
  assert.ok(st.status[RESET]);
  assert.equal(st.status[REAL], undefined);
  assert.equal(st.written[RESET], undefined, 'the written title and Now line are cleared');
  assert.equal(st.written[REAL], undefined);
  const s = take('session');
  assert.equal(s[0].replaces, REAL);
  assert.equal(s[0].id, RESET);
});

test('sessions: the page ui state follows init and a reset, and goes when the session closes (R3.9)', async () => {
  const { sessions, store, q } = setup();
  const drafts = (id: string) => path.join(path.dirname(store.path), 'drafts', id);
  const ph = sessions.newSession();
  patchUi(store, { current: ph, sessions: { [ph]: { draft: { text: 'typed before init', images: [{ id: 'i1', mediaType: 'image/png', data: Buffer.from('made-up').toString('base64') }] } } } });
  sessions.get(ph)!.send('hi');
  emit(q.calls[0], init(REAL));
  await tick();
  const ui = store.state.ui;
  assert.equal(ui.current, REAL);
  assert.equal(ui.sessions[REAL].draft?.text, 'typed before init');
  assert.ok(fs.existsSync(path.join(drafts(REAL), 'i1.png')));
  emit(q.calls[0], { type: 'conversation_reset', new_conversation_id: RESET, uuid: 'u-r', session_id: REAL });
  await tick();
  assert.equal(ui.current, RESET);
  assert.deepEqual(Object.keys(ui.sessions), [RESET]);
  assert.ok(fs.existsSync(path.join(drafts(RESET), 'i1.png')));
  assert.equal(sessions.close(RESET).ok, true);
  assert.deepEqual(ui.sessions, {});
  assert.equal(ui.current, null);
  assert.ok(!fs.existsSync(drafts(RESET)));
});

test('sessions: the open list is stored, and the session resumes on the first message after a restart', async () => {
  const a = setup();
  const ph = a.sessions.newSession();
  a.sessions.newSession(); // never sent to: not stored
  a.sessions.get(ph)!.send('hi');
  emit(a.q.calls[0], init(REAL));
  emit(a.q.calls[0], RESULT);
  await tick();
  a.sessions.stop();
  await tick();
  a.store.close();
  const saved = JSON.parse(fs.readFileSync(path.join(a.root, 'state', 'state.json'), 'utf8'));
  assert.deepEqual(saved.open.map((e: { id: string }) => e.id), [REAL]);
  assert.equal(typeof saved.status[REAL].at, 'number');

  const b = setup(a.root);
  b.store.state.models[REAL] = { model: 'sonnet' };
  b.sessions.start();
  assert.deepEqual(b.transcripts.ids(), [REAL]);
  assert.equal(b.q.calls.length, 0, 'no process until a message');
  b.sessions.get(REAL)!.send('four');
  await tick();
  assert.equal(b.q.calls.length, 1);
  assert.equal(b.q.calls[0].options.resume, REAL);
  assert.equal(b.q.calls[0].options.model, 'sonnet', 'the stored model wins');
  emit(b.q.calls[0], init(REAL));
  await tick();
  assert.deepEqual(b.store.state.open.map((e) => e.id), [REAL], 'same id, no swap');
});

test('sessions: a session whose last permission mode is plan resumes in plan mode', async () => {
  const a = setup();
  const dir = path.join(a.claudeDir, 'projects', '-tmp-x');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${REAL}.jsonl`), JSON.stringify({ type: 'permission-mode', permissionMode: 'plan', sessionId: REAL }) + '\n');
  a.store.state.open.push({ id: REAL, cwd: a.cwd, openedAt: 0, closedAt: null });
  a.sessions.start();
  a.transcripts.poll();
  a.sessions.get(REAL)!.send('go');
  await tick();
  assert.equal(a.q.calls[0].options.permissionMode, 'plan');
});

type Opts = Parameters<CanUseTool>[2];
function askOpts(id: string, extra: Partial<Opts> = {}) {
  const ctl = new AbortController();
  return { ctl, o: { signal: ctl.signal, toolUseID: `tu-${id}`, requestId: `rq-${id}`, ...extra } as Opts };
}
async function waitingSession() {
  const t = setup();
  const ph = t.sessions.newSession();
  t.sessions.get(ph)!.send('go');
  emit(t.q.calls[0], init(REAL));
  await tick();
  t.take();
  return { ...t, call: t.q.calls[0], canUseTool: t.q.calls[0].options.canUseTool as CanUseTool };
}
const BASH_SUGGESTION = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' };
const READ_SUGGESTION = { type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '//tmp/x/**' }], behavior: 'allow', destination: 'session' };

test('needs you: canUseTool parks requests in arrival order, the status is needs you until the last is answered', async () => {
  const t = await waitingSession();
  const a = askOpts('1', { suggestions: [BASH_SUGGESTION] as Opts['suggestions'], description: 'Runs the tests' });
  const b = askOpts('2', { agentID: 'agent-7' });
  let ra: unknown = null; let rb: unknown = null;
  void t.canUseTool('Bash', { command: 'npm test', description: 'Run the tests' }, a.o).then((r) => (ra = r));
  void t.canUseTool('AskUserQuestion', { questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }] }, b.o).then((r) => (rb = r));
  await tick();
  const got = t.take();
  const pend = got.filter((m) => m.t === 'pending');
  assert.deepEqual(pend.map((m) => (m.request as { id: string }).id), ['rq-1', 'rq-2']);
  const r1 = pend[0].request as Record<string, unknown>;
  assert.equal(r1.kind, 'permission');
  assert.equal(r1.toolName, 'Bash');
  assert.equal(r1.toolUseId, 'tu-1');
  assert.equal(r1.cwd, '~/scratch');
  assert.equal(r1.always, 'Always allow Bash(npm test) in this project (.claude/settings.local.json).');
  assert.equal((pend[1].request as Record<string, unknown>).kind, 'question');
  assert.equal((pend[1].request as Record<string, unknown>).agentId, 'agent-7');
  assert.equal(got.filter((m) => m.t === 'session').at(-1)?.state.status, 'waiting', 'needs you wins over running');
  // A reload gets them again in hello, oldest first.
  assert.deepEqual(t.publisher.pending().map((p) => p.request.id), ['rq-1', 'rq-2']);

  assert.equal(t.sessions.get(REAL)!.answer('rq-1', { choice: 'once' }).ok, true);
  await tick();
  assert.deepEqual(ra, { behavior: 'allow', updatedInput: { command: 'npm test', description: 'Run the tests' }, decisionClassification: 'user_temporary' });
  assert.equal(rb, null);
  assert.equal(t.store.state.answers['tu-1'], 'Allow once');
  const after = t.take();
  assert.deepEqual(after.filter((m) => m.t === 'pending').map((m) => m.cleared), ['rq-1']);
  const left = after.filter((m) => m.t === 'session').map((m) => m.state as { status: string; needsYou: string });
  assert.deepEqual(left.map((st) => [st.status, st.needsYou]), [['waiting', 'question']], 'still needs you: one request left, a question now');
  assert.deepEqual(t.publisher.pending().map((p) => p.request.id), ['rq-2']);

  assert.equal(t.sessions.get(REAL)!.answer('rq-2', { questions: [{ picks: ['B'], note: 'because' }] }).ok, true);
  await tick();
  assert.deepEqual((rb as { updatedInput: Record<string, unknown> }).updatedInput.answers, { 'Which?': 'B' });
  assert.equal(t.take('session').at(-1)?.state.status, 'busy');
  assert.equal(t.sessions.get(REAL)!.answer('rq-2', { choice: 'once' }).ok, false, 'an answered request is gone');
});

test('needs you: a card appearing or answered tells the writer, and the work lines name it', async () => {
  const waits: string[] = [];
  const t = setup(undefined, [], { onWaiting: (sid) => waits.push(sid) });
  const ph = t.sessions.newSession();
  t.sessions.get(ph)!.send('go');
  emit(t.q.calls[0], init(REAL));
  await tick();
  const canUseTool = t.q.calls[0].options.canUseTool as CanUseTool;
  assert.deepEqual(waits, []);
  const a = askOpts('1'), b = askOpts('2');
  void canUseTool('Bash', { command: 'npm test', description: 'Run the tests' }, a.o);
  await tick();
  assert.deepEqual(waits, [REAL]);
  assert.deepEqual(t.publisher.work(REAL), ['card waiting for you: allow Bash “Run the tests”']);
  void canUseTool('AskUserQuestion', { questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'A' }], multiSelect: false }, { question: 'And?', header: 'B', options: [{ label: 'C' }], multiSelect: false }] }, b.o);
  await tick();
  assert.equal(waits.length, 2);
  assert.deepEqual(t.publisher.work(REAL), ['card waiting for you: allow Bash “Run the tests”', 'card waiting for you: question “Which?” and 1 more']);
  t.sessions.get(REAL)!.answer('rq-1', { choice: 'once' });
  await tick();
  assert.equal(waits.length, 3, 'answered');
  b.ctl.abort();
  await tick();
  assert.equal(waits.length, 4, 'dropped by its signal');
  assert.deepEqual(t.publisher.work(REAL), []);
  // A question another process asks (R6.8): once when it appears, not again while it stays, once when it ends.
  const ran = (ask: string | null) => ({ agents: 0, turn: false, lastAt: 0, ask: ask ? { kind: 'question' as const, toolUseId: ask, agentId: null, since: 1 } : null });
  t.sessions.runningChanged(REAL, ran('toolu_x'));
  t.sessions.runningChanged(REAL, ran('toolu_x'));
  assert.equal(waits.length, 5);
  t.sessions.runningChanged(REAL, ran(null));
  assert.equal(waits.length, 6);
});

test('needs you: a request ends when its signal aborts, on interrupt and when the process ends', async () => {
  const t = await waitingSession();
  const a = askOpts('1');
  let ra: unknown = null;
  void t.canUseTool('Bash', { command: 'ls' }, a.o).then((r) => (ra = r));
  await tick();
  a.ctl.abort();
  await tick();
  assert.equal((ra as { behavior: string }).behavior, 'deny');
  assert.equal(t.publisher.pending().length, 0);
  assert.equal(t.take('pending').at(-1)?.cleared, 'rq-1');

  // An interrupt ends what is left and sends back the messages held behind the card.
  const b = askOpts('2');
  let rb: unknown = null;
  void t.canUseTool('ExitPlanMode', { plan: '1. Do it' }, b.o).then((r) => (rb = r));
  await tick();
  assert.equal(t.sessions.get(REAL)!.send('wait, one more thing').ok, true);
  assert.deepEqual(t.take('session').at(-1)?.held, ['wait, one more thing']);
  await t.sessions.get(REAL)!.interrupt();
  assert.equal((rb as { behavior: string }).behavior, 'deny');
  assert.equal(t.publisher.pending().length, 0);
  const got = t.take();
  assert.deepEqual(got.filter((m) => m.t === 'restore').map((m) => m.texts), [['wait, one more thing']]);
  assert.equal(t.call.inputs.length, 1, 'the held message was never pushed');

  // The process ends with a request open.
  const c = askOpts('3');
  void t.canUseTool('AskUserQuestion', { questions: [] }, c.o);
  await tick();
  assert.equal(t.publisher.pending().length, 1);
  t.call.out.end();
  await tick();
  assert.equal(t.publisher.pending().length, 0);
  assert.notEqual(t.take('session').at(-1)?.state.status, 'waiting');
});

test('needs you: a message sent while a card waits is held, and pushed once the card is answered', async () => {
  const t = await waitingSession();
  const a = askOpts('1');
  void t.canUseTool('Bash', { command: 'ls' }, a.o);
  await tick();
  t.sessions.get(REAL)!.send('first');
  t.sessions.get(REAL)!.send('second');
  await tick();
  assert.equal(t.call.inputs.length, 1);
  assert.deepEqual(t.publisher.sessions().find((s) => (s as { id: string }).id === REAL)?.['held' as never], ['first', 'second']);
  t.take();
  t.sessions.get(REAL)!.answer('rq-1', { choice: 'deny', text: 'not now' });
  await tick();
  assert.deepEqual(t.call.inputs.slice(1).map((m) => m.message.content), ['first', 'second']);
  assert.deepEqual(t.take('session').find((m) => 'held' in m)?.held, []);
  assert.equal(t.store.state.answers['tu-1'], 'Denied: not now');
});

test('needs you: a plan answer stores the plan text the card showed', async () => {
  const t = await waitingSession();
  const a = askOpts('1');
  void t.canUseTool('ExitPlanMode', { plan: '1. Write "final"', planFilePath: '/tmp/p.md' }, a.o);
  await tick();
  assert.equal(t.sessions.get(REAL)!.answer('rq-1', { choice: 'changes', text: 'shorter' }).ok, true);
  assert.equal(t.store.state.plans['tu-1'], '1. Write "final"');
  assert.equal(t.store.state.answers['tu-1'], 'Changes: shorter');
});

test('needs you: Always allow stores session rules, passed back as allowedTools on the next start', async () => {
  const t = await waitingSession();
  const a = askOpts('1', { suggestions: [READ_SUGGESTION, { type: 'addDirectories', directories: ['/tmp/x'], destination: 'session' }] as Opts['suggestions'] });
  let ra: unknown = null;
  void t.canUseTool('Read', { file_path: '/tmp/x/a.txt' }, a.o).then((r) => (ra = r));
  await tick();
  const req = t.take('pending')[0].request as Record<string, unknown>;
  assert.equal(req.always, 'Always allow Read(//tmp/x/**) for this session, and allow access to /tmp/x for this session.');
  t.sessions.get(REAL)!.answer('rq-1', { choice: 'always' });
  await tick();
  assert.deepEqual((ra as { updatedPermissions: unknown }).updatedPermissions, req.suggestions);
  assert.deepEqual(t.store.state.rules[REAL], ['Read(//tmp/x/**)']);
  assert.equal(t.store.state.answers['tu-1'], 'Always allow');
  t.call.out.end();
  await tick();
  t.sessions.get(REAL)!.send('again');
  await tick();
  assert.deepEqual(t.q.calls[1].options.allowedTools, ['Read(//tmp/x/**)']);
});

test('needs you: suppressAlwaysAllowRule hides Always allow and refuses it', async () => {
  const t = await waitingSession();
  const a = askOpts('1', { suggestions: [BASH_SUGGESTION] as Opts['suggestions'], suppressAlwaysAllowRule: true });
  void t.canUseTool('Bash', { command: 'npm test' }, a.o);
  await tick();
  assert.equal((t.take('pending')[0].request as Record<string, unknown>).always, null);
  assert.equal(t.sessions.get(REAL)!.answer('rq-1', { choice: 'always' }).ok, false);
  assert.equal(t.publisher.pending().length, 1, 'still waiting');
});

test('sessions: statuses go working, then your turn; a failed process is failed and toasts', async () => {
  const { sessions, q, take } = setup();
  const ph = sessions.newSession();
  sessions.get(ph)!.send('hi');
  emit(q.calls[0], init(REAL));
  emit(q.calls[0], { type: 'system', subtype: 'session_state_changed', state: 'running' });
  await tick();
  emit(q.calls[0], RESULT);
  await tick();
  assert.equal(take('session').at(-1)?.state.status, 'busy');
  emit(q.calls[0], { type: 'system', subtype: 'session_state_changed', state: 'idle' });
  await tick();
  assert.equal(take('session').at(-1)?.state.status, 'idle');

  q.calls[0].out.end(new Error('boom'));
  await tick();
  const got = take();
  assert.equal(got.filter((m) => m.t === 'session').at(-1)?.state.status, 'failed');
  assert.equal(got.filter((m) => m.t === 'toast').length, 1);
  sessions.get(REAL)!.send('again');
  await tick();
  assert.equal(q.calls.length, 2, 'the next message tries again');
  assert.equal(q.calls[1].options.resume, REAL);
});

test('sessions: the process passes every message to the status: compacting, queued, signed out', async () => {
  const { sessions, q, take } = setup();
  const ph = sessions.newSession();
  sessions.get(ph)!.send('hi');
  emit(q.calls[0], init(REAL));
  emit(q.calls[0], { type: 'system', subtype: 'session_state_changed', state: 'running' });
  emit(q.calls[0], { type: 'system', subtype: 'status', status: 'compacting' });
  await tick();
  assert.equal(take('session').at(-1)?.state.status, 'compacting');
  emit(q.calls[0], { type: 'system', subtype: 'status', status: null });
  await tick();
  sessions.get(REAL)!.send('and this', [], Q_SENT);
  await tick();
  const s = take('session').at(-1) as { state: { status: string; detail: { queued?: number } } };
  assert.equal(s.state.status, 'busy');
  assert.deepEqual(s.state.detail, { queued: 1 });
  emit(q.calls[0], { type: 'assistant', parent_tool_use_id: null, error: 'authentication_failed', user_message_uuids: [Q_SENT], message: { content: [] } });
  emit(q.calls[0], { type: 'system', subtype: 'session_state_changed', state: 'idle' });
  await tick();
  const end = take('session').at(-1) as { state: { status: string; detail: object } };
  assert.equal(end.state.status, 'signedout');
  assert.deepEqual(end.state.detail, {});
});
const Q_SENT = '0e9b7f1c-0000-4000-8000-0000000000b1';

test('sessions: a missing folder fails without starting a process', () => {
  const { sessions, store, q, take } = setup();
  store.state.settings.newSessionCwd = '/tmp/synopia-no-such-folder-' + process.pid;
  const ph = sessions.newSession();
  const r = sessions.get(ph)!.send('hi');
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /no longer exists/);
  assert.equal(q.calls.length, 0);
  assert.equal(take('session').at(-1)?.state.status, 'failed');
});

test('sessions: the stream preview builds from deltas and clears when the block lands and on result', async () => {
  const { sessions, q, take, claudeDir, transcripts, publisher, c } = setup();
  const ph = sessions.newSession();
  sessions.get(ph)!.send('hi');
  emit(q.calls[0], init(REAL));
  await tick();
  publisher.view(c, REAL, null); // the text goes to the pages viewing it
  const ev = (event: object, parent: string | null = null) => emit(q.calls[0], { type: 'stream_event', event, parent_tool_use_id: parent, uuid: 'u', session_id: REAL });
  ev({ type: 'message_start', message: { id: 'msg_1' } });
  ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } });
  ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } });
  ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' sub' } }, 'toolu_sub');
  await new Promise((r) => setTimeout(r, 80));
  const s1 = take('stream');
  assert.equal(s1.at(-1)?.text, 'Hello');
  assert.equal(s1.at(-1)?.sid, REAL);

  // the block's record lands in the JSONL
  const dir = path.join(claudeDir, 'projects', '-tmp-x');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${REAL}.jsonl`), JSON.stringify({
    type: 'assistant', uuid: 'a1', timestamp: '2026-11-20T10:00:00.000Z', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
  }) + '\n');
  transcripts.poll();
  await tick();
  assert.equal(take('stream').at(-1)?.clear, true);

  ev({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'More' } });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(take('stream').at(-1)?.text, 'More');
  emit(q.calls[0], RESULT);
  await tick();
  assert.equal(take('stream').at(-1)?.clear, true);
});

test('stream preview: thinking blocks are not shown, and land by type', () => {
  const p = new StreamPreview();
  const e = (event: object) => p.event({ event, parent_tool_use_id: null });
  e({ type: 'message_start', message: { id: 'm' } });
  e({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } });
  e({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  assert.equal(e({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'A' } }), true);
  assert.equal(p.text(), 'A');
  assert.equal(p.land('m', ['thinking']), false);
  assert.equal(p.text(), 'A');
  assert.equal(p.land('m', ['text']), true);
  assert.equal(p.text(), null);
});

// A past session's JSONL, hand-written: one prompt and one reply.
const PAST = 'aaaaaaaa-0000-4000-8000-00000000000a';
function writePast(claudeDir: string, cwd: string, id = PAST): string {
  const dir = path.join(claudeDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const base = { sessionId: id, cwd, isSidechain: false };
  fs.writeFileSync(file, [
    { ...base, type: 'user', uuid: 'p-1', timestamp: '2026-11-20T10:00:00.000Z', message: { role: 'user', content: 'Count the fixture lines' } },
    { ...base, type: 'assistant', uuid: 'p-2', timestamp: '2026-11-20T10:00:05.000Z', requestedModel: 'claude-haiku-test', message: { id: 'm-1', role: 'assistant', content: [{ type: 'text', text: 'There are four.' }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}
const info = (id: string, over: Partial<SDKSessionInfo> = {}): SDKSessionInfo => ({ sessionId: id, summary: `Summary ${id.slice(0, 4)}`, lastModified: 1000, cwd: '/tmp/x', ...over });

test('listRecent: newest first, the open ones left out, title from customTitle, summary or firstPrompt, at most 50', async () => {
  const many = Array.from({ length: 60 }, (_, i) => info(`bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`, { lastModified: 2000 + i }));
  const past = [
    info(PAST, { lastModified: 9000, customTitle: 'Custom', summary: 'Sum' }),
    info(REAL, { lastModified: 8000 }),
    info('cccccccc-0000-4000-8000-00000000000c', { lastModified: 7000, summary: '', firstPrompt: 'First prompt\nsecond line' }),
    info('dddddddd-0000-4000-8000-00000000000d', { lastModified: 9500, cwd: undefined }),
    ...many,
  ];
  const { sessions, store, root } = setup(undefined, past);
  store.state.open.push({ id: REAL, cwd: root, openedAt: 0, closedAt: null });
  sessions.start();
  const list = await sessions.listRecent();
  assert.equal(list.length, 50);
  assert.equal(list[0].id, PAST);
  assert.equal(list[0].title, 'Custom');
  assert.ok(!list.some((r) => r.id === REAL), 'an open session is left out');
  assert.ok(!list.some((r) => r.id.startsWith('dddddddd')), 'a session without a folder is left out');
  assert.equal(list[1].title, 'First prompt');
  assert.equal(list[2].lastModified, 2059);
  const f = await sessions.listRecent('first');
  assert.deepEqual(f.map((r) => r.id), ['cccccccc-0000-4000-8000-00000000000c']);
  // a title Claude wrote for a session Synopia closed names it, unless you renamed it
  store.state.written['cccccccc-0000-4000-8000-00000000000c'] = { title: 'Written title', at: 1 };
  store.state.written[PAST] = { title: 'Not this', at: 1 };
  const w = await sessions.listRecent();
  assert.deepEqual([w[0].title, w[1].title], ['Custom', 'Written title']);
});

test('openSession: adds it to the open list, shows its transcript, and resumes it on the first message', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-sessions-'));
  const cwd = path.join(root, 'scratch');
  const file = writePast(path.join(root, 'claude'), cwd);
  const { sessions, store, q, take, transcripts, publisher, c } = setup(root, [info(PAST, { cwd, lastModified: Date.parse('2026-11-20T10:00:05.000Z') })]);
  assert.equal((await sessions.listRecent()).length, 1);
  take();
  const r = await sessions.openSession(PAST);
  assert.deepEqual(r, { ok: true, sid: PAST });
  assert.deepEqual(store.state.open.map((e) => [e.id, e.cwd, e.closedAt]), [[PAST, cwd, null]]);
  assert.deepEqual(store.state.layout.others, [PAST]);
  const meta = take('session');
  assert.equal(meta[0].id, PAST);
  assert.equal(meta[0].title, 'Count the fixture lines');
  publisher.view(c, PAST, null);
  const items = take('items');
  assert.equal(items[0].reset, true);
  assert.ok((items[0].upsert as unknown[]).length >= 2, 'the history shows at once');
  assert.equal((await sessions.listRecent()).length, 0, 'an open session is no longer listed');

  assert.equal(sessions.get(PAST)!.send('And now?').ok, true);
  await tick();
  assert.equal(q.calls.length, 1);
  assert.equal(q.calls[0].options.resume, PAST);
  assert.equal(q.calls[0].options.cwd, cwd);
  assert.equal(q.calls[0].options.model, 'claude-haiku-test', 'the resume keeps the model the session used');
  emit(q.calls[0], init(PAST));
  await tick();
  assert.deepEqual(transcripts.ids(), [PAST], 'the same id, no swap');
  assert.ok(fs.existsSync(file));
  assert.equal((await sessions.openSession('not-an-id')).ok, false);
});

const Q1 = '0e9b7f1c-0000-4000-8000-0000000000a1';
const Q2 = '0e9b7f1c-0000-4000-8000-0000000000a2';
const Q3 = '0e9b7f1c-0000-4000-8000-0000000000a3';
async function runningTurn(caps: string[] | undefined) {
  const t = setup();
  const ph = t.sessions.newSession();
  t.sessions.get(ph)!.send('count slowly', [], Q1);
  await tick();
  emit(t.q.calls[0], { ...init(REAL), ...(caps ? { capabilities: caps } : {}) });
  emit(t.q.calls[0], { type: 'system', subtype: 'session_state_changed', state: 'running', uuid: 'u-s', session_id: REAL });
  await tick();
  t.sessions.get(REAL)!.send('and then this', [], Q2);
  t.sessions.get(REAL)!.send('', [{ mediaType: 'image/png', data: Buffer.from('png').toString('base64') }], Q3);
  t.take();
  return t;
}

test('interrupt: with interrupt_cancel_queued_v1 it cancels the queued messages and restores their text', async () => {
  const t = await runningTurn(['interrupt_receipt_v1', 'interrupt_cancel_queued_v1']);
  t.q.calls[0].reply = { still_queued: [], cancelled: [Q2, Q3, 'unknown-uuid'] };
  await t.sessions.get(REAL)!.interrupt();
  assert.deepEqual(t.q.calls[0].interrupts, [{ cancelQueued: true }]);
  const got = t.take();
  // an image-only message comes back with its image; an unknown uuid gives nothing
  assert.deepEqual(got.filter((m) => m.t === 'restore'), [{ t: 'restore', sid: REAL, texts: ['and then this'], images: [{ mediaType: 'image/png', data: Buffer.from('png').toString('base64') }] }]);
  assert.equal(got.filter((m) => m.t === 'toast').length, 0);
  emit(t.q.calls[0], { ...RESULT, subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' });
  emit(t.q.calls[0], { type: 'system', subtype: 'session_state_changed', state: 'idle', uuid: 'u-i', session_id: REAL });
  await tick();
  assert.equal(t.take('session').at(-1)?.state.status, 'stopped');
  assert.equal(t.q.calls[0].closed, false, 'the process (and its background work) keeps running');
  assert.equal(t.q.calls.length, 1);
});

test('interrupt: without the capability it uses the plain interrupt and toasts what still runs', async () => {
  const t = await runningTurn(['interrupt_receipt_v1']);
  t.q.calls[0].reply = { still_queued: [Q2] };
  await t.sessions.get(REAL)!.interrupt();
  assert.deepEqual(t.q.calls[0].interrupts, [undefined]);
  const got = t.take();
  assert.equal(got.filter((m) => m.t === 'restore').length, 0);
  assert.match(String(got.find((m) => m.t === 'toast')?.text), /queued message will still run/);
  emit(t.q.calls[0], { ...RESULT, subtype: 'success' });
  emit(t.q.calls[0], { type: 'system', subtype: 'session_state_changed', state: 'idle', uuid: 'u-i', session_id: REAL });
  await tick();
  assert.equal(t.take('session').at(-1)?.state.status, 'stopped', 'an interrupted turn is stopped by you, whatever its subtype');
});

test('interrupt: an idle session or one without a process is left alone', async () => {
  const t = setup();
  const ph = t.sessions.newSession();
  await t.sessions.get(ph)!.interrupt();
  t.sessions.get(ph)!.send('hi');
  await tick();
  emit(t.q.calls[0], init(REAL));
  emit(t.q.calls[0], RESULT);
  await tick();
  await t.sessions.get(REAL)!.interrupt();
  assert.deepEqual(t.q.calls[0].interrupts, []);
});

test('close: ends the process, sends removed, hides it in its group; reopening puts it back there', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-sessions-'));
  const cwd = path.join(root, 'scratch');
  writePast(path.join(root, 'claude'), cwd);
  const past = [info(PAST, { cwd, lastModified: 5000 })];
  const t = setup(root, past);
  await t.sessions.openSession(PAST);
  const st = t.store.state;
  st.open.push({ id: 'x', cwd: '/x', openedAt: 0, closedAt: 1 }); // a closed one, hidden in the group
  st.layout = { groups: [{ id: 'g1', name: 'Work', ids: ['x', PAST] }], others: [] };
  t.sessions.get(PAST)!.send('go');
  await tick();
  emit(t.q.calls[0], init(PAST));
  await tick();
  t.take();
  assert.deepEqual(t.sessions.close(PAST), { ok: true, sid: PAST });
  await tick();
  assert.equal(t.q.calls[0].closed, true, 'the process ends now');
  assert.deepEqual(t.take('removed'), [{ t: 'removed', id: PAST }]);
  assert.equal(t.take('toast').length, 0, 'a close is not a failure');
  assert.equal(typeof st.open[0].closedAt, 'number');
  assert.deepEqual(st.layout.groups[0].ids, ['x', PAST], 'it keeps its place, hidden');
  assert.equal(t.sessions.get(PAST), undefined);
  assert.deepEqual((await t.sessions.listRecent()).map((r) => r.id), [PAST], 'the Open list has it again');
  t.store.flush();

  // after a restart it stays closed
  const t2 = setup(root, past);
  t2.sessions.start();
  assert.deepEqual(t2.transcripts.ids(), []);
  assert.equal(t2.sessions.get(PAST), undefined, 'not open');

  // reopening it: back in its group, the same open[] entry
  await t2.sessions.openSession(PAST);
  assert.deepEqual(t2.transcripts.ids(), [PAST]);
  assert.deepEqual(t2.store.state.open.map((e) => [e.id, e.closedAt === null]), [[PAST, true], ['x', false]], 'the same open[] entry');
  assert.deepEqual(t2.store.state.layout.groups[0].ids, ['x', PAST]);
});

test('close: a placeholder is dropped and never stored', () => {
  const t = setup();
  const ph = t.sessions.newSession();
  t.take();
  assert.equal(t.sessions.close(ph).ok, true);
  assert.deepEqual(t.take('removed'), [{ t: 'removed', id: ph }]);
  assert.equal(t.store.state.open.length, 0);
});

test('idle end: the process ends after the idle time, not while background work runs, and the next message resumes', async () => {
  const t = setup(undefined, [], { idleMs: 30 });
  const ph = t.sessions.newSession();
  t.sessions.get(ph)!.send('hi');
  await tick();
  emit(t.q.calls[0], init(REAL));
  emit(t.q.calls[0], RESULT);
  await tick();
  assert.equal(t.q.calls[0].inputs.length, 1);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(t.sessions.quitCheck().running.length, 0);
  t.take();
  assert.equal(t.take('toast').length, 0);
  t.sessions.get(REAL)!.send('again');
  await tick();
  assert.equal(t.q.calls.length, 2, 'a new process');
  assert.equal(t.q.calls[1].options.resume, REAL);
});

test('quitCheck: running turns and the background work of running processes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-sessions-'));
  const BG = '33333333-0000-4000-8000-000000000003';
  const dir = path.join(root, 'claude', 'projects', '-tmp-fixture');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, 'fixtures/claude/projects/-tmp-fixture', `${BG}.jsonl`), path.join(dir, `${BG}.jsonl`));
  const t = setup(root, [info(BG, { cwd: path.join(root, 'scratch') })]);
  await t.sessions.openSession(BG);
  assert.deepEqual(t.sessions.quitCheck(), { running: [], background: [] }, 'no process, nothing stops');
  t.sessions.get(BG)!.send('go');
  await tick();
  const c = t.sessions.quitCheck();
  assert.deepEqual(c.running, [BG]);
  assert.deepEqual(c.background, [{ sid: BG, kind: 'monitor' }]);
  emit(t.q.calls[0], init(BG));
  emit(t.q.calls[0], RESULT);
  await tick();
  assert.deepEqual(t.sessions.quitCheck(), { running: [], background: [{ sid: BG, kind: 'monitor' }] });
});

test("task notification: the SDK's task_notification ends the task between turns", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-sessions-'));
  const BG = '33333333-0000-4000-8000-000000000003';
  const dir = path.join(root, 'claude', 'projects', '-tmp-fixture');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, 'fixtures/claude/projects/-tmp-fixture', `${BG}.jsonl`), path.join(dir, `${BG}.jsonl`));
  const t = setup(root, [info(BG, { cwd: path.join(root, 'scratch') })]);
  await t.sessions.openSession(BG);
  t.transcripts.poll();
  const bg = () => (t.publisher.sessions() as { id: string; background: { toolUseId: string; status: string }[] }[]).find((s) => s.id === BG)!.background;
  const run = bg().find((b) => b.status === 'running')!;
  t.sessions.get(BG)!.send('go');
  await tick();
  emit(t.q.calls[0], init(BG));
  emit(t.q.calls[0], RESULT);
  emit(t.q.calls[0], { type: 'system', subtype: 'task_notification', task_id: 'x1', tool_use_id: run.toolUseId, status: 'stopped', output_file: '', summary: '', uuid: 'u-tn', session_id: BG });
  await tick();
  assert.equal(bg().find((b) => b.toolUseId === run.toolUseId)!.status, 'stopped');
  assert.deepEqual(t.sessions.quitCheck().background, []);
  t.sessions.stop();
  t.transcripts.stop(); t.publisher.stop();
});

// b, b (R9): a session whose turn runs a foreground Bash and a foreground Agent (made up)
function backgroundSetup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-sessions-'));
  const BGS = '88888888-0000-4000-8000-000000000008';
  const dir = path.join(root, 'claude', 'projects', '-tmp-bg');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${BGS}.jsonl`);
  const rec = (r: object) => JSON.stringify({ sessionId: BGS, cwd: path.join(root, 'scratch'), ...r }) + '\n';
  fs.writeFileSync(file, rec({ type: 'user', uuid: 'b-u1', timestamp: '2026-11-24T10:00:00.000Z', message: { role: 'user', content: 'Wait, then look' } })
    + rec({ type: 'assistant', uuid: 'b-a1', timestamp: '2026-11-24T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_sl', name: 'Bash', input: { command: 'sleep 40; echo done', description: 'Wait' } }] } })
    + rec({ type: 'assistant', uuid: 'b-a2', timestamp: '2026-11-24T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_ag', name: 'Agent', input: { description: 'Look around', prompt: 'x' } }] } }));
  const t = setup(root, [info(BGS, { cwd: path.join(root, 'scratch') })]);
  return { ...t, BGS, file, rec };
}

test("tool_progress: a driven session's running step gets its start from the elapsed time (R5.6)", async () => {
  const t = backgroundSetup();
  const { BGS } = t;
  await t.sessions.openSession(BGS);
  t.transcripts.poll();
  t.publisher.view(t.c, BGS, null);
  t.sessions.get(BGS)!.send('go');
  await tick();
  const call = t.q.calls[0];
  emit(call, init(BGS));
  await tick();
  t.take();
  const before = Date.now();
  emit(call, { type: 'tool_progress', tool_use_id: 'toolu_sl', tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: 12, uuid: 'u-tp1', session_id: BGS });
  await tick();
  const ups = t.take('items').flatMap((m) => m.upsert as { id: string; since?: string }[]);
  const since = Date.parse(ups.find((i) => i.id === 'toolu_sl')?.since ?? '');
  assert.ok(since >= before - 12_000 && since <= Date.now() - 12_000, 'now minus 12 s');
  t.sessions.stop();
  t.transcripts.stop(); t.publisher.stop();
});

test('background: b, b calls backgroundTasks; background_tasks_changed shows the steps as background work at once, once', async () => {
  const t = backgroundSetup();
  const { BGS } = t;
  await t.sessions.openSession(BGS);
  t.transcripts.poll();
  const sess = () => (t.publisher.sessions() as { id: string; background: { toolUseId: string; status: string; taskId: string | null }[] }[]).find((s) => s.id === BGS)!;
  const item = (id: string) => t.transcripts.get(BGS)!.get(id)!;
  assert.equal(item('toolu_sl').fg, undefined, 'not before its task_started');
  assert.equal((await t.sessions.get(BGS)!.background()).ok, false, 'no process: nothing to move');
  t.sessions.get(BGS)!.send('go');
  await tick();
  const call = t.q.calls[0];
  emit(call, init(BGS));
  emit(call, { type: 'system', subtype: 'task_started', task_id: 'bsl1', tool_use_id: 'toolu_sl', description: 'Wait', is_backgrounded: false, task_type: 'local_bash', uuid: 'u-ts1', session_id: BGS });
  emit(call, { type: 'system', subtype: 'task_started', task_id: 'aag1', tool_use_id: 'toolu_ag', description: 'Look around', is_backgrounded: false, task_type: 'local_agent', uuid: 'u-ts2', session_id: BGS });
  await tick();
  assert.equal(item('toolu_sl').fg, true, 'a foreground Bash can go');
  assert.equal(item('toolu_ag').fg, true, 'a foreground Agent can go');
  t.take();
  assert.deepEqual(await t.sessions.get(BGS)!.background(), { ok: true, sid: BGS });
  assert.deepEqual(call.controls.filter(([k]) => k === 'backgroundTasks'), [['backgroundTasks', undefined]], 'every foreground task: no tool use id');
  emit(call, { type: 'system', subtype: 'background_tasks_changed', tasks: [
    { task_id: 'bsl1', task_type: 'local_bash', description: 'Wait' },
    { task_id: 'aag1', task_type: 'local_agent', description: 'Look around' },
    { task_id: 'amb1', task_type: 'local_bash', description: 'watcher', ambient: true },
  ], uuid: 'u-btc1', session_id: BGS });
  await tick();
  assert.deepEqual(sess().background.map((b) => [b.toolUseId, b.taskId, b.status]), [['toolu_sl', 'bsl1', 'running']], 'the shell shows as running background work');
  assert.equal(item('toolu_sl').fg, undefined);
  assert.equal(item('toolu_ag').fg, undefined);
  assert.equal(item('toolu_ag').state, 'running', 'the Agent runs on in the background');
  assert.ok(t.take('background').some((m) => (m.upsert as { toolUseId: string }[]).some((b) => b.toolUseId === 'toolu_sl')), 'pages get it');
  // the transcript's own record of the move adds nothing
  fs.appendFileSync(t.file, t.rec({ type: 'user', uuid: 'b-r1', timestamp: '2026-11-24T10:00:05.000Z', toolUseResult: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bsl1' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_sl', content: 'Command was moved to the background with ID: bsl1.' }] } })
    + t.rec({ type: 'user', uuid: 'b-r2', timestamp: '2026-11-24T10:00:05.000Z', toolUseResult: { status: 'async_launched', agentId: 'aag1' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ag', content: 'Moved to the background.' }] } }));
  t.transcripts.poll();
  await tick();
  assert.deepEqual(sess().background.map((b) => [b.toolUseId, b.status]), [['toolu_sl', 'running']], 'one shell, not two');
  assert.equal(item('toolu_ag').state, 'running');
  // leaving the live set ends them at once; the notification later says how
  emit(call, { type: 'system', subtype: 'background_tasks_changed', tasks: [], uuid: 'u-btc2', session_id: BGS });
  await tick();
  assert.equal(sess().background[0].status, 'completed');
  assert.equal(item('toolu_ag').state, 'done');
  emit(call, { type: 'system', subtype: 'task_notification', task_id: 'bsl1', tool_use_id: 'toolu_sl', status: 'failed', output_file: '', summary: 'exit 1', uuid: 'u-tn', session_id: BGS });
  await tick();
  assert.equal(sess().background[0].status, 'failed', 'the notification wins');
  assert.equal(sess().background.length, 1);
  t.sessions.stop();
  t.transcripts.stop(); t.publisher.stop();
});

test('background: a toast when nothing could go, or background tasks are turned off', async () => {
  const t = backgroundSetup();
  await t.sessions.openSession(t.BGS);
  t.sessions.get(t.BGS)!.send('go');
  await tick();
  const call = t.q.calls[0];
  emit(call, init(t.BGS));
  await tick();
  call.background = false;
  assert.deepEqual(await t.sessions.get(t.BGS)!.background(), { ok: false, error: 'Nothing could go to the background.' });
  call.background = new Error('disabled');
  const r = await t.sessions.get(t.BGS)!.background();
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /turned off.*CLAUDE_CODE_DISABLE_BACKGROUND_TASKS/);
  t.sessions.stop();
  t.transcripts.stop(); t.publisher.stop();
});

test('process end: background work of a failed or quit process reads as stopped, also after a restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-sessions-'));
  const BG = '33333333-0000-4000-8000-000000000003';
  const dir = path.join(root, 'claude', 'projects', '-tmp-fixture');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, 'fixtures/claude/projects/-tmp-fixture', `${BG}.jsonl`), path.join(dir, `${BG}.jsonl`));
  const t = setup(root, [info(BG, { cwd: path.join(root, 'scratch') })]);
  await t.sessions.openSession(BG);
  t.transcripts.poll();
  const running = () => (t.publisher.sessions() as { id: string; background: { status: string }[] }[]).find((s) => s.id === BG)!.background.filter((b) => b.status === 'running').length;
  assert.equal(running(), 1, 'the fixture monitor runs');
  t.sessions.get(BG)!.send('go');
  await tick();
  emit(t.q.calls[0], init(BG));
  await tick();
  t.take();
  t.q.calls[0].out.end(new Error('boom')); // the process fails
  await tick();
  assert.equal(running(), 0);
  assert.ok(t.take('background').some((m) => (m.upsert as { status: string }[]).some((b) => b.status === 'stopped')), 'pages get it');
  assert.deepEqual(t.sessions.quitCheck().background, []);
  assert.equal(typeof t.store.state.ended[BG], 'number', 'stored');
  assert.equal(t.store.state.endedFailed[BG], true, 'stored as a failure');
  t.sessions.stop();
  t.transcripts.stop(); t.publisher.stop();
  // a restart: the transcript still says running, the stored end says stopped
  const t2 = setup(root);
  t2.store.state.open.push({ id: BG, cwd: path.join(root, 'scratch'), openedAt: 0, closedAt: null });
  t2.store.state.ended[BG] = t.store.state.ended[BG];
  t2.sessions.start();
  t2.transcripts.poll();
  const bg2 = (t2.publisher.sessions() as { id: string; background: { status: string }[] }[]).find((s) => s.id === BG)!.background;
  assert.ok(bg2.some((b) => b.status === 'stopped') && !bg2.some((b) => b.status === 'running'));
});

test('process end: quit marks the work of every running process', async () => {
  const t = setup();
  const id = t.sessions.newSession();
  t.sessions.get(id)!.send('hi');
  await tick();
  emit(t.q.calls[0], init(REAL));
  await tick();
  t.sessions.stop();
  assert.equal(typeof t.store.state.ended[REAL], 'number');
  assert.equal(t.store.state.endedFailed[REAL], undefined, 'a quit is no failure');
});

test('model: a choice without a process is stored and passed at the next start; default passes no model', async () => {
  const t = setup();
  const id = t.sessions.newSession();
  assert.deepEqual(await t.sessions.get(id)!.setModel('sonnet', 'low'), { ok: true, sid: id });
  assert.equal(t.store.state.models[id], undefined, 'a placeholder is not stored');
  t.sessions.get(id)!.send('hello');
  await tick();
  assert.equal(t.q.calls[0].options.model, 'sonnet');
  assert.equal(t.q.calls[0].options.effort, 'low');
  emit(t.q.calls[0], init(REAL));
  await tick();
  assert.deepEqual(t.store.state.models[REAL], { model: 'sonnet', effort: 'low' }, 'moves to the real id');
  t.q.calls[0].out.end(); // the process ends
  await tick();
  await t.sessions.get(REAL)!.setModel('default', null);
  t.sessions.get(REAL)!.send('again');
  await tick();
  assert.equal(t.q.calls[1].options.model, undefined, 'default: the CLI default, not the last requestedModel');
  assert.equal(t.q.calls[1].options.effort, undefined);
  assert.deepEqual(t.q.calls[1].controls, []);
});

test('model: a running process gets setModel and applyFlagSettings; an effort change alone no setModel', async () => {
  const t = setup();
  const id = t.sessions.newSession();
  t.sessions.get(id)!.send('hello');
  await tick();
  emit(t.q.calls[0], init(REAL));
  await tick();
  t.take();
  await t.sessions.get(REAL)!.setModel('sonnet', 'high');
  assert.deepEqual(t.q.calls[0].controls, [['setModel', 'sonnet'], ['applyFlagSettings', { effortLevel: 'high' }]]);
  assert.equal((t.publisher.meta(REAL) as { model: unknown }).model, 'sonnet', 'the meta shows the choice');
  assert.equal((t.publisher.meta(REAL) as { effort: unknown }).effort, 'high');
  t.q.calls[0].controls.length = 0;
  await t.sessions.get(REAL)!.setModel('sonnet', 'low');
  assert.deepEqual(t.q.calls[0].controls, [['applyFlagSettings', { effortLevel: 'low' }]]);
  t.q.calls[0].controls.length = 0;
  await t.sessions.get(REAL)!.setModel('default', null);
  assert.deepEqual(t.q.calls[0].controls, [['setModel', undefined], ['applyFlagSettings', { effortLevel: null }]]);
  assert.deepEqual(t.store.state.models[REAL], { model: 'default', effort: null });
  assert.ok(t.take('session').some((m) => m.id === REAL && m.model === 'default'), 'pages get the change');
  assert.equal(t.sessions.get('nope'), undefined, 'an id no session has');
});

test('needs you: held messages go out when the last card ends by its own signal (M1)', async () => {
  const t = await waitingSession();
  const a = askOpts('1', { agentID: 'agent-7' });
  void t.canUseTool('Bash', { command: 'ls' }, a.o);
  await tick();
  assert.equal(t.sessions.get(REAL)!.send('held one').ok, true);
  assert.equal(t.call.inputs.length, 1, 'held while the card waits');
  t.take();
  a.ctl.abort(); // the subagent was stopped, or the CLI cancelled the tool
  await tick();
  assert.deepEqual(t.call.inputs.slice(1).map((m) => m.message.content), ['held one']);
  assert.deepEqual(t.take('session').find((m) => 'held' in m)?.held, [], 'the Queued line goes');
  assert.equal(t.take('restore').length, 0);
});

test('needs you: an interrupt restores the held messages even when the CLI aborts the card first (M1)', async () => {
  const t = await waitingSession();
  const a = askOpts('1');
  void t.canUseTool('Bash', { command: 'ls' }, a.o);
  await tick();
  t.sessions.get(REAL)!.send('keep me');
  // the CLI aborts the request's signal while the interrupt is on its way
  t.call.interrupts.push = (...x: unknown[]) => { a.ctl.abort(); return x.length; };
  await t.sessions.get(REAL)!.interrupt();
  assert.equal(t.call.inputs.length, 1, 'not pushed');
  assert.deepEqual(t.take('restore').map((m) => m.texts), [['keep me']]);
});

test('open list: after a reset the earlier conversation is listed and opens as itself (M3)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-sessions-'));
  const cwd = path.join(root, 'scratch');
  writePast(path.join(root, 'claude'), cwd);
  const past = [info(PAST, { cwd, lastModified: 5000 })];
  const t = setup(root, past);
  await t.sessions.openSession(PAST);
  t.sessions.get(PAST)!.send('go');
  await tick();
  emit(t.q.calls[0], init(PAST));
  emit(t.q.calls[0], { type: 'conversation_reset', new_conversation_id: RESET, uuid: 'u-r', session_id: PAST, trigger: 'clear' });
  await tick();
  assert.equal(t.sessions.resolve(PAST), RESET);
  assert.deepEqual((await t.sessions.listRecent()).map((r) => r.id), [PAST], 'the pre-clear conversation is a past session');
  assert.deepEqual(await t.sessions.openSession(PAST), { ok: true, sid: PAST });
  assert.deepEqual(t.transcripts.ids().sort(), [PAST, RESET].sort());
  assert.equal(t.sessions.resolve(PAST), PAST, 'page messages with its id reach it, not the new conversation');
  assert.deepEqual(t.store.state.open.map((e) => e.id).sort(), [PAST, RESET].sort());
  assert.deepEqual((await t.sessions.listRecent()).map((r) => r.id), []);
});

test('idle end: a message sent while the process is ending goes to the next process (L1)', async () => {
  const t = setup(undefined, [], { idleMs: 30 });
  const ph = t.sessions.newSession();
  t.sessions.get(ph)!.send('hi');
  await tick();
  emit(t.q.calls[0], init(REAL));
  emit(t.q.calls[0], RESULT);
  await tick();
  t.q.calls[0].exitDelay = 80;
  await new Promise((r) => setTimeout(r, 50)); // the idle end closed the input; the exit comes later
  t.take();
  assert.equal(t.sessions.get(REAL)!.send('during the exit').ok, true);
  await tick();
  assert.equal(t.q.calls.length, 1, 'never two processes for one session');
  assert.equal(t.take('session').at(-1)?.state.status, 'busy');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(t.q.calls.length, 2, 'a new process once the old one exited');
  assert.equal(t.q.calls[1].options.resume, REAL);
  assert.deepEqual(t.q.calls[1].inputs.map((m) => m.message.content), ['during the exit']);
});

test('status: an interrupt after the result, or one that failed, does not stop the next turn (L4)', async () => {
  const t = await runningTurn(['interrupt_receipt_v1']);
  const q = t.q.calls[0];
  const state = (s: string, uuid: string) => emit(q, { type: 'system', subtype: 'session_state_changed', state: s, uuid, session_id: REAL });
  emit(q, RESULT);
  await tick();
  await t.sessions.get(REAL)!.interrupt(); // Esc Esc between result and idle
  state('idle', 'u-i');
  await tick();
  t.sessions.get(REAL)!.send('next');
  state('running', 'u-s2');
  emit(q, RESULT);
  state('idle', 'u-i2');
  await tick();
  assert.equal(t.take('session').at(-1)?.state.status, 'idle');

  // an interrupt that throws
  t.sessions.get(REAL)!.send('again');
  state('running', 'u-s3');
  await tick();
  q.interrupts.push = () => { throw new Error('control channel closed'); };
  await t.sessions.get(REAL)!.interrupt();
  assert.match(String(t.take('toast').at(-1)?.text), /couldn't interrupt/);
  emit(q, RESULT);
  state('idle', 'u-i3');
  await tick();
  assert.equal(t.take('session').at(-1)?.state.status, 'idle');
});

test('layout: a new session dragged into a group keeps its place through init (L2)', async () => {
  const t = setup();
  const ph = t.sessions.newSession();
  const st = t.store.state;
  assert.deepEqual(st.layout.others, [ph], 'a new session is placed at once');
  const other = t.sessions.newSession();
  assert.deepEqual(t.sessions.layout.newGroup(ph, other, 'g1', 'Work'), { ok: true });
  assert.deepEqual(t.sessions.layout.move(other, { group: 'others' }), { ok: true });
  assert.deepEqual(st.layout.groups.map((g) => g.ids), [[ph]], 'the placeholder is kept in its group');
  const frames = t.take('layout');
  assert.deepEqual(frames.at(-1)?.layout, st.layout, 'each change goes to the pages');
  t.sessions.get(ph)!.send('hi');
  await tick();
  emit(t.q.calls[0], init(REAL));
  await tick();
  assert.deepEqual(st.layout.groups.map((g) => g.ids), [[REAL]]);
  assert.deepEqual(st.layout.others, [other], 'not also under Not in a group');
  const after = t.take();
  assert.deepEqual(after.find((m) => m.t === 'session' && m.replaces === ph)?.layout, st.layout, 'the session frame with replaces carries the layout');
  assert.equal(after.filter((m) => m.t === 'layout').length, 0, 'not sent alone');
  // a closed placeholder's id goes
  t.sessions.close(other);
  assert.deepEqual(st.layout, { groups: [{ id: 'g1', name: 'Work', ids: [REAL] }], others: [] });
});

test('sessions: a session whose turn runs in another process reads working, until that turn ends', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-sessions-'));
  const cwd = path.join(root, 'scratch');
  const file = writePast(path.join(root, 'claude'), cwd);
  const base = { sessionId: PAST, cwd, isSidechain: false };
  const add = (r: object) => fs.appendFileSync(file, JSON.stringify({ ...base, ...r }) + '\n');
  add({ type: 'user', uuid: 'p-3', timestamp: '2026-11-20T10:01:00.000Z', message: { role: 'user', content: 'Now run the tests' } });
  add({ type: 'assistant', uuid: 'p-4', timestamp: '2026-11-20T10:01:05.000Z', message: { id: 'm-2', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_ext', name: 'Bash', input: { command: 'npm test' } }] } });
  const { sessions, transcripts, publisher, take } = setup(root, [info(PAST, { cwd })]);
  await sessions.openSession(PAST);
  transcripts.poll();
  assert.equal(take('session').at(-1)?.state.status, 'busy', 'its tool waits for a result in the other process');
  add({ type: 'user', uuid: 'p-5', timestamp: '2026-11-20T10:02:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ext', content: 'ok' }] } });
  add({ type: 'system', subtype: 'turn_duration', durationMs: 60000, timestamp: '2026-11-20T10:02:01.000Z' });
  transcripts.poll();
  assert.equal(take('session').at(-1)?.state.status, 'idle');
});

// The pid-file registry as sessions see it (cli-terminals.ts): nothing known until its first scan.
// `scanned(sid, pid)`: a terminal holds sid; `scanned(sid, pid, false)`: another app's CLI has it
// open (not a terminal); `scanned()`: no pid file.
function fakeTerminals() {
  const held = new Map<string, Terminal>();
  const others = new Set<string>();
  const listeners: (() => void)[] = [];
  let known = false;
  const source: TerminalSource = {
    holder: (sid) => held.get(sid) ?? null,
    recheck: (sid) => held.get(sid) ?? null,
    free: (sid) => known && !held.has(sid) && !others.has(sid),
    onChange: (fn) => listeners.push(fn),
    end: async () => true,
  };
  const scanned = (sid?: string, pid = 0, terminal = true) => {
    known = true;
    held.clear();
    others.clear();
    if (sid && pid && terminal) held.set(sid, { pid, sessionId: sid, procStart: 'Fri Nov 27 09:00:00 2026', cwd: '/tmp/x', status: 'busy', statusUpdatedAt: 1 });
    else if (sid && pid) others.add(sid);
    for (const fn of listeners) fn();
  };
  return { source, scanned };
}

// A past session Synopia drove before it quit: its records, dated now (made up).
function pastWith(records: object[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-sessions-'));
  const cwd = path.join(root, 'scratch');
  const file = writePast(path.join(root, 'claude'), cwd);
  const base = { sessionId: PAST, cwd, isSidechain: false };
  for (const r of records) fs.appendFileSync(file, JSON.stringify({ ...base, timestamp: new Date().toISOString(), ...r }) + '\n');
  return { root, cwd, file };
}
const prompt = (uuid: string, text: string) => ({ type: 'user', uuid, message: { role: 'user', content: text } });
const toolCall = (uuid: string, id: string, name: string, input: object) => ({ type: 'assistant', uuid, message: { id: `m-${uuid}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });

test('no process holds it: a turn that ended on a permission nobody answered is your turn at once, its background subagent ended', async () => {
  const { root, cwd, file } = pastWith([
    prompt('p-3', 'Review the draft in the background, then start a helper session'),
    toolCall('p-4', 'toolu_bg', 'Agent', { description: 'Review the draft', prompt: 'invented', run_in_background: true }),
    { type: 'user', uuid: 'p-5', toolUseResult: { status: 'async_launched', agentId: 'cccc0001', description: 'd', prompt: 'p', outputFile: '/tmp/o' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: 'Launched.' }] } },
    toolCall('p-6', 'toolu_mcp', 'mcp__synopia__start_session', { prompt: 'invented' }),
    {
      type: 'user', uuid: 'p-7', toolDenialKind: 'permission-rule', toolDenialUnanswered: 'stream-closed', toolUseResult: 'Error: invented',
      permissionDecision: { decision: 'reject', source: 'config', reasonType: 'other', ruleSource: 'mcpServerPolicy', reasonCode: 'invented' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_mcp', is_error: true, content: 'Tool permission request failed: AbortError: Tool permission stream closed before response received' }] },
    },
  ]);
  const subs = path.join(file.replace(/\.jsonl$/, ''), 'subagents');
  fs.mkdirSync(subs, { recursive: true });
  fs.writeFileSync(path.join(subs, 'agent-cccc0001.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Review the draft', toolUseId: 'toolu_bg' }));
  fs.writeFileSync(path.join(subs, 'agent-cccc0001.jsonl'), JSON.stringify({ type: 'user', uuid: 'c-1', timestamp: new Date().toISOString(), isSidechain: true, agentId: 'cccc0001', message: { role: 'user', content: 'Review the draft.' } }) + '\n');
  const term = fakeTerminals();
  const { sessions, transcripts, take } = setup(root, [info(PAST, { cwd })], { terminals: term.source });
  sessions.start();
  await sessions.openSession(PAST);
  transcripts.poll();
  transcripts.poll();
  assert.equal(transcripts.get(PAST)?.agents()[0]?.running, true, 'its process may still run: the pid files are not read yet');
  assert.equal(transcripts.get(PAST)?.turnRunning(Date.now(), 30 * 60_000), false, 'the unanswered permission ended the turn, whatever holds the session');
  term.scanned();
  assert.equal(take('session').at(-1)?.state.status, 'idle', 'your turn, not working');
  const agent = transcripts.get(PAST)?.agents()[0];
  assert.equal(agent?.running, false, 'the subagent died with its process');
  assert.equal(agent?.stopped, true);
  sessions.stop();
});

test('no process holds it: a transcript cut mid-tool is not working once the pid files say so', async () => {
  const { root, cwd } = pastWith([prompt('p-3', 'Now run the tests'), toolCall('p-4', 'toolu_cut', 'Bash', { command: 'npm test' })]);
  const term = fakeTerminals();
  const { sessions, transcripts, take } = setup(root, [info(PAST, { cwd })], { terminals: term.source });
  sessions.start();
  await sessions.openSession(PAST);
  transcripts.poll();
  assert.equal(take('session').at(-1)?.state.status, 'busy', 'before the first scan: not known, so it may run elsewhere');
  term.scanned(PAST, 5151, false);
  assert.equal(take('session').at(-1)?.state.status ?? 'busy', 'busy', "another app's CLI has it open: it may still run");
  term.scanned();
  assert.equal(take('session').at(-1)?.state.status, 'idle');
  assert.equal(transcripts.get(PAST)?.get('toolu_cut')?.state, 'stopped');
  sessions.stop();
});

test('a terminal that holds the session mid-turn keeps it working; once it quits, what it ran ended with it', async () => {
  const { root, cwd } = pastWith([prompt('p-3', 'Now run the tests'), toolCall('p-4', 'toolu_t', 'Bash', { command: 'npm test' })]);
  const term = fakeTerminals();
  term.scanned(PAST, 4242);
  const { sessions, transcripts, take } = setup(root, [info(PAST, { cwd })], { terminals: term.source });
  sessions.start();
  await sessions.openSession(PAST);
  transcripts.poll();
  const held = take('session').at(-1)?.state as { status: string; detail: { terminal?: number } };
  assert.equal(held.status, 'busy');
  assert.equal(held.detail.terminal, 4242);
  term.scanned();
  assert.equal(take('session').at(-1)?.state.status, 'idle');
  assert.equal(transcripts.get(PAST)?.get('toolu_t')?.state, 'stopped');
  sessions.stop();
});

test('bash mode: refused while another process runs the turn, as with a terminal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-sessions-'));
  const cwd = path.join(root, 'scratch');
  const file = writePast(path.join(root, 'claude'), cwd);
  const base = { sessionId: PAST, cwd, isSidechain: false };
  const add = (r: object) => fs.appendFileSync(file, JSON.stringify({ ...base, ...r }) + '\n');
  add({ type: 'user', uuid: 'p-3', timestamp: new Date().toISOString(), message: { role: 'user', content: 'Now run the tests' } });
  add({ type: 'assistant', uuid: 'p-4', timestamp: new Date().toISOString(), message: { id: 'm-2', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_ext', name: 'Bash', input: { command: 'npm test' } }] } });
  const { sessions, transcripts } = setup(root, [info(PAST, { cwd })]);
  await sessions.openSession(PAST);
  transcripts.poll();
  const r = sessions.get(PAST)!.runBang('ls');
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /Another Claude Code process is running this session's turn/);
  add({ type: 'user', uuid: 'p-5', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ext', content: 'ok' }] } });
  add({ type: 'system', subtype: 'turn_duration', durationMs: 1000, timestamp: new Date().toISOString() });
  transcripts.poll();
  const ok = sessions.get(PAST)!.runBang('true');
  assert.equal(ok.ok, true, 'once that turn ended');
  sessions.stop();
});

test('openSession: reopening makes it the most recently opened, for the new-session folder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-sessions-'));
  const cwd = path.join(root, 'scratch');
  writePast(path.join(root, 'claude'), cwd);
  let now = 1000;
  const t = setup(root, [info(PAST, { cwd })], { now: () => now });
  const other = path.join(root, 'other');
  fs.mkdirSync(other);
  delete t.store.state.settings.newSessionCwd;
  await t.sessions.openSession(PAST);
  t.store.state.open.push({ id: RESET, cwd: other, openedAt: 2000, closedAt: null }); // opened after it
  t.sessions.close(PAST);
  now = 3000;
  await t.sessions.openSession(PAST);
  assert.equal(t.store.state.open.find((e) => e.id === PAST)?.openedAt, 3000);
  const ph = t.sessions.newSession();
  assert.equal(t.publisher.meta(ph)?.cwd, '~/scratch', 'the reopened one\'s folder');
});

test('start: the page ui state of a session that is not open goes, with its draft images', () => {
  const t = setup();
  const OPEN = REAL, CLOSED = RESET, GONE = '77777777-0000-4000-8000-000000000007';
  t.store.state.open.push({ id: OPEN, cwd: t.cwd, openedAt: 1, closedAt: null }, { id: CLOSED, cwd: t.cwd, openedAt: 1, closedAt: 2 });
  const png = Buffer.from('png').toString('base64');
  for (const sid of [OPEN, CLOSED, GONE]) patchUi(t.store, { sessions: { [sid]: { draft: { text: 'x', images: [{ id: 'i1', mediaType: 'image/png', data: png }] } } } });
  const drafts = (id: string) => path.join(path.dirname(t.store.path), 'drafts', id);
  fs.mkdirSync(drafts('88888888-0000-4000-8000-000000000008'), { recursive: true }); // a folder with no entry
  t.store.state.ui.current = GONE;
  t.sessions.start();
  assert.deepEqual(Object.keys(t.store.state.ui.sessions), [OPEN]);
  assert.equal(t.store.state.ui.current, null);
  assert.ok(fs.existsSync(drafts(OPEN)));
  assert.deepEqual(fs.readdirSync(path.join(path.dirname(t.store.path), 'drafts')), [OPEN]);
  t.sessions.stop();
});
