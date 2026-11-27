// Synopia's tools for agents (agent-tools.ts, R3.15): the server every session Synopia runs gets,
// start_session's placement under the caller (layout.ts), its refusals, its card and its step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transcripts } from '../src/transcripts.ts';
import { Publisher } from '../src/publisher.ts';
import { Sessions } from '../src/sessions.ts';
import { openStore } from '../src/store.ts';
import { placeUnder } from '../src/layout.ts';
import { callServed, cardOf, firstWords, fullName, sessionOf, startedText, stepOf, answerOf } from '../src/agent-tools.ts';
import { toolLine } from '../src/transcript.ts';
import { writerOptions } from '../src/sdk.ts';
import { emit, fakeQuery } from './support/fake-query.ts';
import type { FakeCall } from './support/fake-query.ts';
import type { Client } from '../src/server.ts';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';

type Msg = { t: string; [k: string]: unknown };
const tick = () => new Promise((r) => setTimeout(r, 5));
const START = fullName('start_session');
const CALLER = '11111111-2222-4333-8444-555555555555';
const NEW1 = '22222222-3333-4444-8555-666666666666';
const NEW2 = '33333333-4444-4555-8666-777777777777';
const init = (id: string) => ({ type: 'system', subtype: 'init', session_id: id, uuid: 'u-init' });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-tools-'));
  const claudeDir = path.join(root, 'claude');
  const cwd = path.join(root, 'dev', 'demo');
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const got: Msg[] = [];
  const c: Client = { send: (m) => got.push(JSON.parse(JSON.stringify(m))), close: () => {} };
  const store = openStore(path.join(root, 'state'), { minIntervalMs: 0 });
  let sessions: Sessions | null = null;
  const transcripts = new Transcripts({ claudeDir, home: root, pollMs: 0, watch: false, onAssistant: (sid, mid, types) => sessions?.landed(sid, mid, types) });
  const publisher = new Publisher({ transcripts, clients: () => new Set([c]), home: root, recheckMs: 0, written: (sid) => store.state.written[sid], onRunning: (sid, r) => sessions?.runningChanged(sid, r), layout: () => sessions?.layout.get() });
  const q = fakeQuery();
  sessions = new Sessions({ store, transcripts, publisher, sdk: q.sdk, home: root });
  const take = (t?: string) => { const out = got.filter((m) => !t || m.t === t); got.length = 0; return out; };
  return { root, cwd, store, sessions, q, take };
}

// A caller with a running process and its real id.
async function caller(t: ReturnType<typeof setup>, id = CALLER): Promise<FakeCall> {
  const ph = t.sessions.newSession(t.cwd);
  assert.equal(t.sessions.get(ph)!.send('Plan the release').ok, true);
  await tick();
  const call = t.q.calls.at(-1)!;
  emit(call, init(id));
  await tick();
  return call;
}

// start_session called by the caller's process, as the CLI does once canUseTool allowed it; the new
// session's init comes with `newId`.
async function start(t: ReturnType<typeof setup>, from: FakeCall, input: Record<string, unknown>, newId?: string) {
  const n = t.q.calls.length;
  const p = callServed(from.options.mcpServers as Record<string, unknown>, START, input);
  assert.ok(p, 'the server holds start_session');
  await tick();
  const started = t.q.calls.length > n ? t.q.calls.at(-1)! : null;
  if (started && newId) emit(started, init(newId));
  const res = await p;
  return { res, started, text: res.content.map((b) => b.text).join('') };
}

test('agent tools: every session Synopia runs gets the synopia server; the writer gets none', async () => {
  const t = setup();
  const call = await caller(t);
  const servers = call.options.mcpServers as Record<string, { type: string; name: string; tools?: unknown[] }>;
  assert.deepEqual(Object.keys(servers), ['synopia']);
  assert.equal(servers.synopia.type, 'sdk');
  assert.deepEqual(servers.synopia.tools, [{ name: 'start_session', permission_policy: 'always_ask' }, { name: 'open_items', permission_policy: 'always_ask' }], 'each call asks (live run TL-1), open_items too: cards.ts answers it');
  assert.deepEqual(writerOptions('haiku', '/tmp/w', 'x').mcpServers, {});
  assert.equal(writerOptions('haiku', '/tmp/w', 'x').persistSession, false);
});

test('agent tools: start_session starts a session in the caller\'s folder and makes a group of the two', async () => {
  const t = setup();
  const call = await caller(t);
  t.store.state.written[CALLER] = { title: 'Plan the release', now: '', at: 0, history: [] }; // Claude's title for it
  t.take();
  const { res, started, text } = await start(t, call, { prompt: 'Read HANDOFF.md, then go on.\nMore detail.', title: 'Next steps' }, NEW1);
  assert.equal(res.isError, undefined, text);
  assert.ok(started, 'a new process started');
  assert.equal(started!.options.cwd, t.cwd);
  assert.equal(started!.options.resume, undefined);
  assert.equal(started!.options.title, undefined, 'no Options.title: no custom-title record');
  assert.equal(t.store.state.written[NEW1]?.title, 'Next steps', 'the first title, as written text the writer replaces');
  assert.equal(t.store.state.written[NEW1].now, undefined, 'no Now line until the writer writes');
  assert.ok(!Object.keys(t.store.state.written).some((k) => k.startsWith('new-')), 'moved to the real id');
  assert.equal(started!.inputs[0].message.content, 'Read HANDOFF.md, then go on.\nMore detail.', 'the prompt is its first message');
  assert.equal(text, startedText(NEW1, 'Next steps'));
  assert.equal(sessionOf(START, text), NEW1);
  const l = t.sessions.layout.get();
  assert.equal(l.groups.length, 1);
  assert.equal(l.groups[0].name, 'Plan the release', 'named after the caller\'s title');
  assert.deepEqual(l.groups[0].ids, [CALLER, NEW1]);
  assert.deepEqual(l.others, []);
  const frames = t.take('started');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].from, CALLER);
  assert.match(String(frames[0].sid), /^new-/, 'sent while it is new: a page viewing the caller shows it');
  assert.ok(t.sessions.get(CALLER), 'the caller stays open');
});

test('agent tools: in a group, a started session goes right under the caller', async () => {
  const t = setup();
  const call = await caller(t);
  await start(t, call, { prompt: 'First handoff' }, NEW1);
  const r2 = await start(t, call, { prompt: 'Second handoff' }, NEW2);
  assert.equal(r2.res.isError, undefined, r2.text);
  assert.equal(r2.text, startedText(NEW2, 'Second handoff'), 'no title: the first words');
  const l = t.sessions.layout.get();
  assert.equal(l.groups.length, 1);
  assert.deepEqual(l.groups[0].ids, [CALLER, NEW2, NEW1]);
});

test('agent tools: placeUnder, pure', () => {
  const l = { groups: [{ id: 'g1', name: 'A', ids: ['a', 'b'] }], others: ['c', 'n'] };
  assert.deepEqual(placeUnder(l, 'n', 'a', 'g2', 'A'), { groups: [{ id: 'g1', name: 'A', ids: ['a', 'n', 'b'] }], others: ['c'] });
  assert.deepEqual(placeUnder(l, 'n', 'c', 'g2', 'Title of c'), { groups: [{ id: 'g1', name: 'A', ids: ['a', 'b'] }, { id: 'g2', name: 'Title of c', ids: ['c', 'n'] }], others: [] });
  assert.equal(typeof placeUnder(l, 'n', 'gone', 'g2', 'x'), 'string');
  assert.equal(typeof placeUnder(l, 'a', 'a', 'g2', 'x'), 'string');
});

test('agent tools: refusals: an empty prompt, a gone folder, a session Synopia no longer runs', async () => {
  const t = setup();
  const call = await caller(t);
  const n = t.q.calls.length;
  const empty = await start(t, call, { prompt: '   ' });
  assert.equal(empty.res.isError, true);
  assert.match(empty.text, /prompt is empty/);
  fs.rmSync(t.cwd, { recursive: true });
  const gone = await start(t, call, { prompt: 'Go on' });
  assert.equal(gone.res.isError, true);
  assert.match(gone.text, /no longer exists/);
  fs.mkdirSync(t.cwd, { recursive: true });
  t.sessions.close(CALLER);
  const closed = await start(t, call, { prompt: 'Go on' });
  assert.equal(closed.res.isError, true);
  assert.match(closed.text, /isn't one Synopia runs/);
  assert.equal(t.q.calls.length, n, 'no session started');
  assert.equal(t.sessions.layout.get().groups.length, 0);
});

test('agent tools: the card words the call; Always allow keeps a session rule that skips the card', async () => {
  const t = setup();
  const call = await caller(t);
  const canUseTool = call.options.canUseTool as CanUseTool;
  t.take();
  const o = (id: string) => ({ signal: new AbortController().signal, toolUseID: id, requestId: id, suggestions: [] }) as unknown as Parameters<CanUseTool>[2];
  let r1: PermissionResult | null = null;
  void canUseTool(START, { prompt: 'Write the release notes.\nThen stop.', title: 'Notes' }, o('t1')).then((r) => (r1 = r));
  await tick();
  const req = t.take('pending').at(-1)?.request as Record<string, unknown>;
  assert.equal(req.kind, 'permission');
  const own = req.own as Record<string, string>;
  assert.equal(own.text, `Start a new session in ${path.join('~', 'dev', 'demo')} with: Write the release notes.`);
  assert.equal(own.wants, 'start a new session');
  assert.equal(req.always, 'Starts new sessions from this session without asking, until you close it.');
  assert.deepEqual(t.sessions.get(CALLER)!.answer('t1', { choice: 'always' }), { ok: true, sid: CALLER });
  await tick();
  assert.equal(r1!.behavior, 'allow');
  assert.deepEqual(t.store.state.rules[CALLER], [START]);
  t.take();
  const r2 = await canUseTool(START, { prompt: 'Again' }, o('t2'));
  assert.equal(r2.behavior, 'allow', 'the rule allows it with no card');
  assert.equal(t.take('pending').length, 0);
  t.sessions.close(CALLER);
  assert.equal(t.store.state.rules[CALLER], undefined, 'the rule goes with the session (Q6)');
});

test('agent tools: wording, the step and the result', () => {
  assert.deepEqual(stepOf(START, { prompt: 'Read HANDOFF.md and go on', title: 'Next' }), ['Start session', 'Next']);
  assert.deepEqual(toolLine(START, { prompt: 'Read HANDOFF.md and go on with the rest of the release work today' }, '/h'), ['Start session', 'Read HANDOFF.md and go on with the rest…']);
  assert.equal(stepOf('Bash', {}), null);
  assert.equal(cardOf('Bash', {}, '~'), null);
  assert.equal(firstWords('  one two\nthree'), 'one two');
  assert.equal(sessionOf(START, 'The prompt is empty.'), null);
  assert.equal(sessionOf('Bash', startedText(NEW1, 'x')), null);
});

test('agent tools: open_items has no card, its step reads Open items(Y5: text), a subagent\'s call is refused (FR-ITEM-12)', () => {
  const name = fullName('open_items');
  assert.equal(cardOf(name, {}, '~/x'), null);
  assert.deepEqual(stepOf(name, { op: 'close', id: 'Y5', text: 'Can I remove the worktrees?\nmore' }), ['Open items', 'Y5: Can I remove the worktrees?']);
  assert.deepEqual(stepOf(name, { op: 'open', text: 'Run it?' }), ['Open items', 'Run it?']);
  assert.deepEqual(stepOf(name, { op: 'list' }), ['Open items', 'list']);
  assert.equal(answerOf(name, { op: 'list' }, 'agent-1')?.behavior, 'deny');
  assert.equal(answerOf(name, { op: 'list' }, undefined)?.behavior, 'allow');
});
