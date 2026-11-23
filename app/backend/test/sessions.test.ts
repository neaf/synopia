import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Views } from '../src/views.ts';
import { Sessions, StreamPreview, renameInLayout } from '../src/sessions.ts';
import { STATE_FLAG } from '../src/driver.ts';
import type { QueryFn } from '../src/driver.ts';
import { openStore } from '../src/store.ts';
import type { Client } from '../src/server.ts';
import type { CanUseTool, Options, SDKMessage, SDKSessionInfo, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

type Msg = { t: string; [k: string]: unknown };
const tick = () => new Promise((r) => setTimeout(r, 5));

// An async-iterable channel: the fake CLI's output.
function channel<T>() {
  const buf: T[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  let fail: Error | null = null;
  return {
    push(m: T) { buf.push(m); wake?.(); wake = null; },
    end(err?: Error) { done = true; fail = err ?? null; wake?.(); wake = null; },
    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
      while (true) {
        while (buf.length) yield buf.shift() as T;
        if (fail) throw fail;
        if (done) return;
        await new Promise<void>((r) => (wake = r));
      }
    },
  };
}

type Call = {
  options: Options; inputs: SDKUserMessage[]; out: ReturnType<typeof channel<SDKMessage>>; closed: boolean;
  interrupts: unknown[]; reply: { still_queued: string[]; cancelled?: string[] } | undefined;
  controls: [string, unknown][]; // slice 5: setModel and applyFlagSettings calls
};
function fakeQuery() {
  const calls: Call[] = [];
  const fn: QueryFn = ({ prompt, options }) => {
    const out = channel<SDKMessage>();
    const call: Call = { options, inputs: [], out, closed: false, interrupts: [], reply: { still_queued: [] }, controls: [] };
    calls.push(call);
    void (async () => {
      for await (const m of prompt) call.inputs.push(m);
      out.end(); // the input closed: the process ends after its turn
    })();
    return Object.assign(out, {
      close: () => { call.closed = true; out.end(); },
      interrupt: async (req?: unknown) => { call.interrupts.push(req); return call.reply; },
      setModel: async (m?: string) => { call.controls.push(['setModel', m]); },
      applyFlagSettings: async (x: unknown) => { call.controls.push(['applyFlagSettings', x]); },
    });
  };
  return { calls, fn };
}

const emit = (c: Call, m: object) => c.out.push(m as SDKMessage);
const init = (id: string) => ({ type: 'system', subtype: 'init', session_id: id, uuid: 'u-init' });
const RESULT = { type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed' };
const REAL = '11111111-2222-4333-8444-555555555555';
const RESET = '66666666-7777-4888-8999-aaaaaaaaaaaa';

function setup(dir?: string, past: SDKSessionInfo[] = [], extra: { idleMs?: number } = {}) {
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
  const views = new Views({
    claudeDir, clients: () => clients, home: root, pollMs: 0, watch: false,
    onAssistant: (sid, mid, types) => sessions?.landed(sid, mid, types),
    choice: (sid) => sessions?.choiceOf(sid),
  });
  const q = fakeQuery();
  sessions = new Sessions({ store, views, queryFn: q.fn, listFn: async () => past, home: root, ...extra });
  const take = (t?: string) => { const out = got.filter((m) => !t || m.t === t); got.length = 0; return out; };
  return { root, claudeDir, cwd, c, store, views, sessions, q, take };
}

test('sessions: a placeholder takes its real id from system/init', async () => {
  const { sessions, store, q, take, cwd, c, views } = setup();
  const ph = sessions.newSession();
  assert.match(ph, /^new-/);
  const first = take('session');
  assert.equal(first.length, 1);
  assert.equal(first[0].id, ph);
  assert.equal(first[0].title, 'New session');
  assert.equal(store.state.open.length, 0, 'a placeholder is not stored');
  views.view(c, ph, null);

  assert.equal(sessions.send(ph, 'hello').ok, true);
  await tick();
  assert.equal(q.calls.length, 1);
  const o = q.calls[0].options;
  assert.equal(o.cwd, cwd);
  assert.equal(o.resume, undefined);
  assert.equal(o.model, 'haiku');
  assert.equal(o.permissionMode, undefined, 'your own permission setting applies');
  assert.equal(o.includePartialMessages, true);
  assert.equal(o.perTaskStopAffordance, true);
  assert.equal((o.env as Record<string, string>)[STATE_FLAG], '1');
  assert.equal(o.settingSources, undefined);
  assert.equal(take('session').at(-1)?.status, 'busy');

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
  assert.deepEqual(views.ids(), [REAL]);
});

test('sessions: two sends before init go to one process, in order', async () => {
  const { sessions, q } = setup();
  const ph = sessions.newSession();
  sessions.send(ph, 'one', [], '0e9b7f1c-0000-4000-8000-000000000001');
  sessions.send(ph, 'two', [{ mediaType: 'image/png', data: Buffer.from('png').toString('base64') }], '0e9b7f1c-0000-4000-8000-000000000002');
  await tick();
  assert.equal(q.calls.length, 1);
  const inputs = q.calls[0].inputs;
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].message.content, 'one');
  assert.equal(inputs[0].uuid, '0e9b7f1c-0000-4000-8000-000000000001');
  const blocks = inputs[1].message.content as { type: string }[];
  assert.deepEqual(blocks.map((b) => b.type), ['image', 'text']);
  assert.equal(inputs[1].uuid, '0e9b7f1c-0000-4000-8000-000000000002');

  emit(q.calls[0], init(REAL));
  await tick();
  sessions.send(ph, 'three'); // an old id still reaches the session
  await tick();
  assert.equal(q.calls.length, 1);
  assert.equal(inputs.length, 3);
});

test('sessions: images over 5 MB or not PNG/JPEG are refused', () => {
  const { sessions, q } = setup();
  const ph = sessions.newSession();
  const big = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
  assert.equal(sessions.send(ph, 'x', [{ mediaType: 'image/png', data: big }]).ok, false);
  assert.equal(sessions.send(ph, 'x', [{ mediaType: 'image/gif', data: 'R0lG' }]).ok, false);
  assert.equal(q.calls.length, 0);
});

test('sessions: the alias map reaches the session through every id it had', async () => {
  const { sessions, q, views, c, take } = setup();
  const ph = sessions.newSession();
  sessions.send(ph, 'hi');
  emit(q.calls[0], init(REAL));
  await tick();
  emit(q.calls[0], { type: 'conversation_reset', new_conversation_id: RESET, uuid: 'u-r', session_id: REAL, trigger: 'clear' });
  await tick();
  assert.equal(sessions.resolve(ph), RESET);
  assert.equal(sessions.resolve(REAL), RESET);
  assert.equal(sessions.resolve('unknown'), 'unknown');
  take();
  views.view(c, sessions.resolve(ph), null);
  const items = take('items');
  assert.equal(items[0].sid, RESET);
  assert.equal(items[0].reset, true);
});

test('sessions: conversation_reset moves the id in the open list, layout, models, rules and status', async () => {
  const { sessions, store, q, take } = setup();
  const ph = sessions.newSession();
  sessions.send(ph, 'hi');
  emit(q.calls[0], init(REAL));
  await tick();
  const st = store.state;
  st.layout = { groups: [{ id: 'g1', name: 'Group', ids: ['x', REAL] }], others: [] };
  st.models[REAL] = { model: 'haiku', effort: 'low' };
  st.rules[REAL] = ['Bash(ls:*)'];
  st.written[REAL] = { title: 'Old title', now: 'Old now', at: 1 };
  take();
  emit(q.calls[0], { type: 'conversation_reset', new_conversation_id: RESET, uuid: 'u-r', session_id: REAL });
  await tick();
  assert.deepEqual(st.open.map((e) => e.id), [RESET]);
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

test('sessions: the open list is stored, and the session resumes on the first message after a restart', async () => {
  const a = setup();
  const ph = a.sessions.newSession();
  a.sessions.newSession(); // never sent to: not stored
  a.sessions.send(ph, 'hi');
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
  assert.deepEqual(b.views.ids(), [REAL]);
  assert.equal(b.q.calls.length, 0, 'no process until a message');
  b.sessions.send(REAL, 'four');
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
  a.views.check();
  a.sessions.send(REAL, 'go');
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
  t.sessions.send(ph, 'go');
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
  assert.equal(got.filter((m) => m.t === 'session').at(-1)?.status, 'waiting', 'needs you wins over running');
  // A reload gets them again in hello, oldest first.
  assert.deepEqual(t.views.pending().map((p) => p.request.id), ['rq-1', 'rq-2']);

  assert.equal(t.sessions.answer(REAL, 'rq-1', { choice: 'once' }).ok, true);
  await tick();
  assert.deepEqual(ra, { behavior: 'allow', updatedInput: { command: 'npm test', description: 'Run the tests' }, decisionClassification: 'user_temporary' });
  assert.equal(rb, null);
  assert.equal(t.store.state.answers['tu-1'], 'Allow once');
  const after = t.take();
  assert.deepEqual(after.filter((m) => m.t === 'pending').map((m) => m.cleared), ['rq-1']);
  assert.equal(after.filter((m) => m.t === 'session').length, 0, 'still needs you: one request left');
  assert.deepEqual(t.views.pending().map((p) => p.request.id), ['rq-2']);

  assert.equal(t.sessions.answer(REAL, 'rq-2', { questions: [{ picks: ['B'], note: 'because' }] }).ok, true);
  await tick();
  assert.deepEqual((rb as { updatedInput: Record<string, unknown> }).updatedInput.answers, { 'Which?': 'B' });
  assert.equal(t.take('session').at(-1)?.status, 'busy');
  assert.equal(t.sessions.answer(REAL, 'rq-2', { choice: 'once' }).ok, false, 'an answered request is gone');
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
  assert.equal(t.views.pending().length, 0);
  assert.equal(t.take('pending').at(-1)?.cleared, 'rq-1');

  // An interrupt ends what is left and sends back the messages held behind the card.
  const b = askOpts('2');
  let rb: unknown = null;
  void t.canUseTool('ExitPlanMode', { plan: '1. Do it' }, b.o).then((r) => (rb = r));
  await tick();
  assert.equal(t.sessions.send(REAL, 'wait, one more thing').ok, true);
  assert.deepEqual(t.take('session').at(-1)?.held, ['wait, one more thing']);
  await t.sessions.interrupt(REAL);
  assert.equal((rb as { behavior: string }).behavior, 'deny');
  assert.equal(t.views.pending().length, 0);
  const got = t.take();
  assert.deepEqual(got.filter((m) => m.t === 'restore').map((m) => m.texts), [['wait, one more thing']]);
  assert.equal(t.call.inputs.length, 1, 'the held message was never pushed');

  // The process ends with a request open.
  const c = askOpts('3');
  void t.canUseTool('AskUserQuestion', { questions: [] }, c.o);
  await tick();
  assert.equal(t.views.pending().length, 1);
  t.call.out.end();
  await tick();
  assert.equal(t.views.pending().length, 0);
  assert.notEqual(t.take('session').at(-1)?.status, 'waiting');
});

test('needs you: a message sent while a card waits is held, and pushed once the card is answered', async () => {
  const t = await waitingSession();
  const a = askOpts('1');
  void t.canUseTool('Bash', { command: 'ls' }, a.o);
  await tick();
  t.sessions.send(REAL, 'first');
  t.sessions.send(REAL, 'second');
  await tick();
  assert.equal(t.call.inputs.length, 1);
  assert.deepEqual(t.views.sessions().find((s) => (s as { id: string }).id === REAL)?.['held' as never], ['first', 'second']);
  t.take();
  t.sessions.answer(REAL, 'rq-1', { choice: 'deny', text: 'not now' });
  await tick();
  assert.deepEqual(t.call.inputs.slice(1).map((m) => m.message.content), ['first', 'second']);
  assert.deepEqual(t.take('session').find((m) => 'held' in m)?.held, []);
  assert.equal(t.store.state.answers['tu-1'], 'Denied: not now');
});

test('needs you: Always allow stores session rules, passed back as allowedTools on the next start', async () => {
  const t = await waitingSession();
  const a = askOpts('1', { suggestions: [READ_SUGGESTION, { type: 'addDirectories', directories: ['/tmp/x'], destination: 'session' }] as Opts['suggestions'] });
  let ra: unknown = null;
  void t.canUseTool('Read', { file_path: '/tmp/x/a.txt' }, a.o).then((r) => (ra = r));
  await tick();
  const req = t.take('pending')[0].request as Record<string, unknown>;
  assert.equal(req.always, 'Always allow Read(//tmp/x/**) for this session, and allow access to /tmp/x for this session.');
  t.sessions.answer(REAL, 'rq-1', { choice: 'always' });
  await tick();
  assert.deepEqual((ra as { updatedPermissions: unknown }).updatedPermissions, req.suggestions);
  assert.deepEqual(t.store.state.rules[REAL], ['Read(//tmp/x/**)']);
  assert.equal(t.store.state.answers['tu-1'], 'Always allow');
  t.call.out.end();
  await tick();
  t.sessions.send(REAL, 'again');
  await tick();
  assert.deepEqual(t.q.calls[1].options.allowedTools, ['Read(//tmp/x/**)']);
});

test('needs you: suppressAlwaysAllowRule hides Always allow and refuses it', async () => {
  const t = await waitingSession();
  const a = askOpts('1', { suggestions: [BASH_SUGGESTION] as Opts['suggestions'], suppressAlwaysAllowRule: true });
  void t.canUseTool('Bash', { command: 'npm test' }, a.o);
  await tick();
  assert.equal((t.take('pending')[0].request as Record<string, unknown>).always, null);
  assert.equal(t.sessions.answer(REAL, 'rq-1', { choice: 'always' }).ok, false);
  assert.equal(t.views.pending().length, 1, 'still waiting');
});

test('sessions: statuses go working, then your turn; a failed process is failed and toasts', async () => {
  const { sessions, q, take } = setup();
  const ph = sessions.newSession();
  sessions.send(ph, 'hi');
  emit(q.calls[0], init(REAL));
  emit(q.calls[0], { type: 'system', subtype: 'session_state_changed', state: 'running' });
  await tick();
  emit(q.calls[0], RESULT);
  await tick();
  assert.equal(take('session').at(-1)?.status, 'busy');
  emit(q.calls[0], { type: 'system', subtype: 'session_state_changed', state: 'idle' });
  await tick();
  assert.equal(take('session').at(-1)?.status, 'idle');

  q.calls[0].out.end(new Error('boom'));
  await tick();
  const got = take();
  assert.equal(got.filter((m) => m.t === 'session').at(-1)?.status, 'failed');
  assert.equal(got.filter((m) => m.t === 'toast').length, 1);
  sessions.send(REAL, 'again');
  await tick();
  assert.equal(q.calls.length, 2, 'the next message tries again');
  assert.equal(q.calls[1].options.resume, REAL);
});

test('sessions: a missing folder fails without starting a process', () => {
  const { sessions, store, q, take } = setup();
  store.state.settings.newSessionCwd = '/tmp/synopia-no-such-folder-' + process.pid;
  const ph = sessions.newSession();
  const r = sessions.send(ph, 'hi');
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /no longer exists/);
  assert.equal(q.calls.length, 0);
  assert.equal(take('session').at(-1)?.status, 'failed');
});

test('sessions: the stream preview builds from deltas and clears when the block lands and on result', async () => {
  const { sessions, q, take, claudeDir, views } = setup();
  const ph = sessions.newSession();
  sessions.send(ph, 'hi');
  emit(q.calls[0], init(REAL));
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
  views.check();
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

test('renameInLayout: swaps in place, or adds to Not in a group', () => {
  assert.deepEqual(renameInLayout({ groups: [{ id: 'g', name: 'G', ids: ['a', 'b'] }], others: [] }, 'a', 'z', true),
    { groups: [{ id: 'g', name: 'G', ids: ['z', 'b'] }], others: [] });
  assert.deepEqual(renameInLayout({ groups: [], others: ['q'] }, 'a', 'z', true), { groups: [], others: ['q', 'z'] });
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
});

test('openSession: adds it to the open list, shows its transcript, and resumes it on the first message', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-sessions-'));
  const cwd = path.join(root, 'scratch');
  const file = writePast(path.join(root, 'claude'), cwd);
  const { sessions, store, q, take, views, c } = setup(root, [info(PAST, { cwd, lastModified: Date.parse('2026-11-20T10:00:05.000Z') })]);
  assert.equal((await sessions.listRecent()).length, 1);
  take();
  const r = await sessions.openSession(PAST);
  assert.deepEqual(r, { ok: true, sid: PAST });
  assert.deepEqual(store.state.open.map((e) => [e.id, e.cwd, e.closedAt]), [[PAST, cwd, null]]);
  assert.deepEqual(store.state.layout.others, [PAST]);
  const meta = take('session');
  assert.equal(meta[0].id, PAST);
  assert.equal(meta[0].title, 'Count the fixture lines');
  views.view(c, PAST, null);
  const items = take('items');
  assert.equal(items[0].reset, true);
  assert.ok((items[0].upsert as unknown[]).length >= 2, 'the history shows at once');
  assert.equal((await sessions.listRecent()).length, 0, 'an open session is no longer listed');

  assert.equal(sessions.send(PAST, 'And now?').ok, true);
  await tick();
  assert.equal(q.calls.length, 1);
  assert.equal(q.calls[0].options.resume, PAST);
  assert.equal(q.calls[0].options.cwd, cwd);
  assert.equal(q.calls[0].options.model, 'claude-haiku-test', 'the resume keeps the model the session used');
  emit(q.calls[0], init(PAST));
  await tick();
  assert.deepEqual(views.ids(), [PAST], 'the same id, no swap');
  assert.ok(fs.existsSync(file));
  assert.equal((await sessions.openSession('not-an-id')).ok, false);
});

const Q1 = '0e9b7f1c-0000-4000-8000-0000000000a1';
const Q2 = '0e9b7f1c-0000-4000-8000-0000000000a2';
const Q3 = '0e9b7f1c-0000-4000-8000-0000000000a3';
async function runningTurn(caps: string[] | undefined) {
  const t = setup();
  const ph = t.sessions.newSession();
  t.sessions.send(ph, 'count slowly', [], Q1);
  await tick();
  emit(t.q.calls[0], { ...init(REAL), ...(caps ? { capabilities: caps } : {}) });
  emit(t.q.calls[0], { type: 'system', subtype: 'session_state_changed', state: 'running', uuid: 'u-s', session_id: REAL });
  await tick();
  t.sessions.send(REAL, 'and then this', [], Q2);
  t.sessions.send(REAL, '', [{ mediaType: 'image/png', data: Buffer.from('png').toString('base64') }], Q3);
  t.take();
  return t;
}

test('interrupt: with interrupt_cancel_queued_v1 it cancels the queued messages and restores their text', async () => {
  const t = await runningTurn(['interrupt_receipt_v1', 'interrupt_cancel_queued_v1']);
  t.q.calls[0].reply = { still_queued: [], cancelled: [Q2, Q3, 'unknown-uuid'] };
  await t.sessions.interrupt(REAL);
  assert.deepEqual(t.q.calls[0].interrupts, [{ cancelQueued: true }]);
  const got = t.take();
  assert.deepEqual(got.filter((m) => m.t === 'restore'), [{ t: 'restore', sid: REAL, texts: ['and then this'] }], 'an image-only message and unknown uuids give no text');
  assert.equal(got.filter((m) => m.t === 'toast').length, 0);
  emit(t.q.calls[0], { ...RESULT, subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' });
  emit(t.q.calls[0], { type: 'system', subtype: 'session_state_changed', state: 'idle', uuid: 'u-i', session_id: REAL });
  await tick();
  assert.equal(t.take('session').at(-1)?.status, 'stopped');
  assert.equal(t.q.calls[0].closed, false, 'the process (and its background work) keeps running');
  assert.equal(t.q.calls.length, 1);
});

test('interrupt: without the capability it uses the plain interrupt and toasts what still runs', async () => {
  const t = await runningTurn(['interrupt_receipt_v1']);
  t.q.calls[0].reply = { still_queued: [Q2] };
  await t.sessions.interrupt(REAL);
  assert.deepEqual(t.q.calls[0].interrupts, [undefined]);
  const got = t.take();
  assert.equal(got.filter((m) => m.t === 'restore').length, 0);
  assert.match(String(got.find((m) => m.t === 'toast')?.text), /queued message will still run/);
  emit(t.q.calls[0], { ...RESULT, subtype: 'success' });
  emit(t.q.calls[0], { type: 'system', subtype: 'session_state_changed', state: 'idle', uuid: 'u-i', session_id: REAL });
  await tick();
  assert.equal(t.take('session').at(-1)?.status, 'stopped', 'an interrupted turn is stopped by you, whatever its subtype');
});

test('interrupt: an idle session or one without a process is left alone', async () => {
  const t = setup();
  const ph = t.sessions.newSession();
  await t.sessions.interrupt(ph);
  t.sessions.send(ph, 'hi');
  await tick();
  emit(t.q.calls[0], init(REAL));
  emit(t.q.calls[0], RESULT);
  await tick();
  await t.sessions.interrupt(REAL);
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
  st.layout = { groups: [{ id: 'g1', name: 'Work', ids: ['x', PAST] }], others: [] };
  t.sessions.send(PAST, 'go');
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
  assert.equal(t.sessions.has(PAST), false);
  assert.deepEqual((await t.sessions.listRecent()).map((r) => r.id), [PAST], 'the Open list has it again');
  t.store.flush();

  // after a restart it stays closed
  const t2 = setup(root, past);
  t2.sessions.start();
  assert.deepEqual(t2.views.ids(), []);
  assert.equal(t2.sessions.send(PAST, 'x').ok, false);

  // reopening it: back in its group, the same open[] entry
  await t2.sessions.openSession(PAST);
  assert.deepEqual(t2.views.ids(), [PAST]);
  assert.equal(t2.store.state.open.length, 1);
  assert.equal(t2.store.state.open[0].closedAt, null);
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
  t.sessions.send(ph, 'hi');
  await tick();
  emit(t.q.calls[0], init(REAL));
  emit(t.q.calls[0], RESULT);
  await tick();
  assert.equal(t.q.calls[0].inputs.length, 1);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(t.sessions.quitCheck().running.length, 0);
  t.take();
  assert.equal(t.take('toast').length, 0);
  t.sessions.send(REAL, 'again');
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
  t.sessions.send(BG, 'go');
  await tick();
  const c = t.sessions.quitCheck();
  assert.deepEqual(c.running, [BG]);
  assert.deepEqual(c.background, [{ sid: BG, kind: 'monitor' }]);
  emit(t.q.calls[0], init(BG));
  emit(t.q.calls[0], RESULT);
  await tick();
  assert.deepEqual(t.sessions.quitCheck(), { running: [], background: [{ sid: BG, kind: 'monitor' }] });
});

test('process end: background work of a failed or quit process reads as stopped, also after a restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-sessions-'));
  const BG = '33333333-0000-4000-8000-000000000003';
  const dir = path.join(root, 'claude', 'projects', '-tmp-fixture');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, 'fixtures/claude/projects/-tmp-fixture', `${BG}.jsonl`), path.join(dir, `${BG}.jsonl`));
  const t = setup(root, [info(BG, { cwd: path.join(root, 'scratch') })]);
  await t.sessions.openSession(BG);
  t.views.check();
  const running = () => (t.views.sessions() as { id: string; background: { status: string }[] }[]).find((s) => s.id === BG)!.background.filter((b) => b.status === 'running').length;
  assert.equal(running(), 1, 'the fixture monitor runs');
  t.sessions.send(BG, 'go');
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
  t.sessions.stop();
  t.views.stop();
  // a restart: the transcript still says running, the stored end says stopped
  const t2 = setup(root);
  t2.store.state.open.push({ id: BG, cwd: path.join(root, 'scratch'), openedAt: 0, closedAt: null });
  t2.store.state.ended[BG] = t.store.state.ended[BG];
  t2.sessions.start();
  t2.views.check();
  const bg2 = (t2.views.sessions() as { id: string; background: { status: string }[] }[]).find((s) => s.id === BG)!.background;
  assert.ok(bg2.some((b) => b.status === 'stopped') && !bg2.some((b) => b.status === 'running'));
});

test('process end: quit marks the work of every running process', async () => {
  const t = setup();
  const id = t.sessions.newSession();
  t.sessions.send(id, 'hi');
  await tick();
  emit(t.q.calls[0], init(REAL));
  await tick();
  t.sessions.stop();
  assert.equal(typeof t.store.state.ended[REAL], 'number');
});

test('model: a choice without a process is stored and passed at the next start; default passes no model', async () => {
  const t = setup();
  const id = t.sessions.newSession();
  assert.deepEqual(await t.sessions.setModel(id, 'sonnet', 'low'), { ok: true, sid: id });
  assert.equal(t.store.state.models[id], undefined, 'a placeholder is not stored');
  t.sessions.send(id, 'hello');
  await tick();
  assert.equal(t.q.calls[0].options.model, 'sonnet');
  assert.equal(t.q.calls[0].options.effort, 'low');
  emit(t.q.calls[0], init(REAL));
  await tick();
  assert.deepEqual(t.store.state.models[REAL], { model: 'sonnet', effort: 'low' }, 'moves to the real id');
  t.q.calls[0].out.end(); // the process ends
  await tick();
  await t.sessions.setModel(REAL, 'default', null);
  t.sessions.send(REAL, 'again');
  await tick();
  assert.equal(t.q.calls[1].options.model, undefined, 'default: the CLI default, not the last requestedModel');
  assert.equal(t.q.calls[1].options.effort, undefined);
  assert.deepEqual(t.q.calls[1].controls, []);
});

test('model: a running process gets setModel and applyFlagSettings; an effort change alone no setModel', async () => {
  const t = setup();
  const id = t.sessions.newSession();
  t.sessions.send(id, 'hello');
  await tick();
  emit(t.q.calls[0], init(REAL));
  await tick();
  t.take();
  await t.sessions.setModel(REAL, 'sonnet', 'high');
  assert.deepEqual(t.q.calls[0].controls, [['setModel', 'sonnet'], ['applyFlagSettings', { effortLevel: 'high' }]]);
  assert.equal((t.views.meta(REAL) as { model: unknown }).model, 'sonnet', 'the meta shows the choice');
  assert.equal((t.views.meta(REAL) as { effort: unknown }).effort, 'high');
  t.q.calls[0].controls.length = 0;
  await t.sessions.setModel(REAL, 'sonnet', 'low');
  assert.deepEqual(t.q.calls[0].controls, [['applyFlagSettings', { effortLevel: 'low' }]]);
  t.q.calls[0].controls.length = 0;
  await t.sessions.setModel(REAL, 'default', null);
  assert.deepEqual(t.q.calls[0].controls, [['setModel', undefined], ['applyFlagSettings', { effortLevel: null }]]);
  assert.deepEqual(t.store.state.models[REAL], { model: 'default', effort: null });
  assert.ok(t.take('session').some((m) => m.id === REAL && m.model === 'default'), 'pages get the change');
  assert.equal((await t.sessions.setModel('nope', 'sonnet', null)).ok, false);
});
