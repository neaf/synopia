// The scripted SDK (dev/scripted-sdk.ts) under the real Sessions, Transcripts and Publisher: the state folder it seeds,
// the steps it plays with the clock moved, its control calls, what it writes to a transcript, its
// listSessions, the writer's call, and the pretend terminals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transcripts } from '../src/transcripts.ts';
import { Publisher } from '../src/publisher.ts';
import { Sessions } from '../src/sessions.ts';
import { Writer } from '../src/writer.ts';
import { openStore } from '../src/store.ts';
import { CliTerminals } from '../src/cli-terminals.ts';
import { readMenu } from '../src/sdk.ts';
import { openScripted, seedState, ScriptClock, SCRIPT_FILE } from '../dev/scripted-sdk.ts';
import type { Script } from '../dev/scripted-sdk.ts';
import type { Client } from '../src/server.ts';
import type { SessionState } from '../src/status.ts';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const S1 = '11111111-0000-4000-8000-000000000001', S2 = '22222222-0000-4000-8000-000000000002', S4 = '44444444-0000-4000-8000-000000000004';
type Msg = { t: string; [k: string]: unknown };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const running = (ago = 0) => ({ ago, message: { type: 'system', subtype: 'session_state_changed', state: 'running' } });

// A fixture tree copied to a temp folder, its script changed by `edit`, and the backend's parts over it.
// `pretend`: the script's home folders count as there (main.ts passes Scripted.pretendFolder).
async function setup(tree = 'claude', edit?: (s: Script) => void, pretend = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-scripted-'));
  const claudeDir = path.join(root, 'claude'), stateDir = path.join(root, 'state');
  fs.cpSync(path.join(FIXTURES, tree), claudeDir, { recursive: true });
  const file = path.join(claudeDir, SCRIPT_FILE);
  if (edit) {
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) as Script;
    edit(s);
    fs.writeFileSync(file, JSON.stringify(s));
  }
  const scripted = openScripted({ file, claudeDir, stateDir });
  const store = openStore(stateDir, { minIntervalMs: 0 });
  const got: Msg[] = [];
  const c: Client = { send: (m) => got.push(JSON.parse(JSON.stringify(m))), close: () => {} };
  let sessions: Sessions | null = null;
  const transcripts = new Transcripts({ claudeDir, home: scripted.home, pollMs: 0, watch: false, onAssistant: (sid, mid, types) => sessions?.landed(sid, mid, types) });
  const publisher = new Publisher({ transcripts, clients: () => new Set([c]), home: scripted.home, recheckMs: 0, onRunning: (sid, r) => sessions?.runningChanged(sid, r) });
  sessions = new Sessions({ store, transcripts, publisher, sdk: scripted.sdk, home: scripted.home, now: scripted.clock.now, timer: scripted.clock.timer, ...(pretend ? { pretendFolder: scripted.pretendFolder } : {}) });
  sessions.start();
  scripted.attach(sessions);
  await scripted.whenPlayed();
  await sleep(10);
  transcripts.poll();
  const meta = (sid: string) => publisher.meta(sid)!.state;
  const stop = () => { sessions?.stop(); transcripts.stop(); publisher.stop(); store.close(); };
  return { root, claudeDir, stateDir, scripted, store, transcripts, publisher, sessions: sessions as Sessions, got, meta, stop };
}

test('scripted: a fresh state folder gets every fixture session, with the script\'s status, age and folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-seed-'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 1, written: { [S1]: { title: 'Kept', at: 1 } } }));
  const claude = path.join(FIXTURES, 'claude');
  const script = JSON.parse(fs.readFileSync(path.join(claude, SCRIPT_FILE), 'utf8')) as Script;
  assert.equal(seedState(dir, claude, script, 1_000_000_000), true);
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.deepEqual(st.open.map((e: { id: string }) => e.id.slice(0, 4)), ['1111', '2222', '3333', '4444', '5555']);
  assert.deepEqual(st.status[S1], { status: 'idle', at: 1_000_000_000 - 720_000 });
  assert.equal(st.open[2].cwd, '/Users/fixture/dev/demo', 'the script names the folder its records lack');
  assert.equal(st.open[0].cwd, '/Users/fixture/dev/demo', 'else the records\' cwd');
  assert.equal(st.written[S1].title, 'Kept', 'what was there stays');
  assert.equal(seedState(dir, claude, script), false, 'an open list there: no new seed');
});

test('scripted: the main fixture\'s cards, working session and stream preview, on the real Sessions', async () => {
  const { transcripts, publisher, sessions, meta, got, stop } = await setup();
  try {
    const pending = publisher.pending().map((p) => [p.sid.slice(0, 4), p.request.id, p.request.kind]);
    assert.deepEqual(pending, [['2222', 'req-question-1', 'question'], ['3333', 'req-permission-1', 'permission'], ['5555', 'req-plan-1', 'plan']]);
    const perm = publisher.pending()[1].request as { always: string | null; cwd: string; since: number };
    assert.ok(perm.always, 'the suggestion gives an "Always allow"');
    assert.equal(perm.cwd, '~/dev/demo');
    assert.ok(Math.abs(Date.now() - 120_000 - perm.since) < 2000, 'the card is 2 min old (ago)');
    assert.equal(meta(S2).status, 'waiting');
    assert.ok(Math.abs(Date.now() - 240_000 - meta(S2).since) < 2000);
    await sleep(700); // the stream's last delta is 600 ms in
    assert.equal(meta(S4).status, 'busy');
    const stream = (publisher.sessions() as { id: string; stream: string | null }[]).find((s) => s.id === S4);
    assert.equal(stream?.stream, "Two subagents are still running. I'll merge their changes when both report back.");
    assert.ok([S1, S2, S4].every((s) => meta(s).driven), 'Synopia\'s own processes drive them');
    // the menu from S1's running process: HTML unescaped, internal commands left out
    const menu = await readMenu(sessions.get(S1)!.menuSource()!, 1000);
    assert.equal(menu.commands.length, 7);
    assert.equal(menu.commands.find((c) => c.name === 'pr-review')?.hint, '<number>');
    assert.deepEqual(menu.models.map((m) => m.value), ['default', 'fixture-large', 'fixture-small']);
    // an answer settles the request: working, then the script's result 3 s later
    assert.equal(sessions.get(S2)!.answer('req-question-1', { questions: [{ picks: ['No'] }, { picks: ['Docs'] }] }).ok, true);
    assert.ok(!publisher.pending().some((p) => p.request.id === 'req-question-1'));
    await sleep(20);
    assert.equal(meta(S2).status, 'busy');
  } finally { stop(); }
});

test('scripted: the states fixture plays one session per wired state, on the real status rules', async () => {
  const { transcripts, publisher, meta, stop } = await setup('claude-states');
  try {
    await sleep(30); // e5e5's stale timer, armed 16 min in the past, is due at once
    const every = (publisher.sessions() as { id: string; state: SessionState }[]).map((s) => ({ id: s.id, ...s.state }));
    // a8a8: a terminal session whose ended turn has a step auto mode blocked (R8.2)
    const blocked = every.find((s) => s.id.startsWith('a8a8'));
    assert.deepEqual([blocked?.status, blocked?.light, blocked?.word, blocked?.mark, blocked?.needsYou], ['idle', 'red', 'Needs you, blocked', 'pause', 'blocked']);
    const all = every.filter((s) => s !== blocked);
    assert.deepEqual(all.map((s) => s.status), ['busy', 'compacting', 'retrying', 'signedout', 'stale', 'busy', 'busy']);
    assert.equal(all[0].detail.queued, 1, 'the message sent during the turn');
    assert.deepEqual([all[2].detail.retry?.attempt, all[2].detail.retry?.max], [3, 10]);
    assert.ok(Math.abs((all[2].detail.retry?.at ?? 0) - Date.now() - 38_000) < 2000, 'the retry 38 s off');
    assert.ok(Math.abs(Date.now() - 300_000 - all[3].since) < 2000, 'signed out 5 min ago');
    assert.ok(Math.abs(Date.now() - 960_000 - all[4].since) < 2000, 'no message for 16 min');
    assert.equal(all[5].driven, true, 'f6f6: its own background subagents, no other process');
    assert.equal(all[6].driven, false, 'f7f7: its main turn runs in another process');
    assert.equal(all[6].detail.external, true);
    assert.equal(meta(all[6].id).status, 'busy');
  } finally { stop(); }
});

test('scripted: the clock reads the past only while a step plays, and its timers count on it', async () => {
  const clock = new ScriptClock();
  let fired = 0;
  clock.offset = -60_000;
  assert.ok(Math.abs(clock.now() - (Date.now() - 60_000)) < 50);
  clock.timer(() => fired++, 30_000); // due 30 s ago
  clock.offset = 0;
  const later = clock.timer(() => fired++, 60_000);
  await sleep(10);
  later();
  assert.equal(fired, 1);
});

test('scripted: an interrupt cancels the queued messages not in the transcript, and ends the turn stopped', async () => {
  const { claudeDir, sessions, transcripts, publisher, meta, got, stop } = await setup('claude', (s) => {
    s.sessions = { [S1]: { start: true, steps: [running(30_000)] } };
  });
  try {
    assert.equal(meta(S1).status, 'busy');
    const a = '0a0a0a0a-0000-4000-8000-00000000000a', b = '0b0b0b0b-0000-4000-8000-00000000000b';
    assert.equal(sessions.get(S1)!.send('First, queued.', [], a).ok, true);
    assert.equal(sessions.get(S1)!.send('Second, queued.', [], b).ok, true);
    await sleep(10);
    assert.equal(meta(S1).detail.queued, 2);
    // the first lands, as the CLI writes a queued message it took in
    const file = path.join(claudeDir, 'projects', '-tmp-fixture', `${S1}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ type: 'attachment', uuid: 'land-1', timestamp: new Date().toISOString(), sessionId: S1, attachment: { type: 'queued_command', prompt: 'First, queued.' } }) + '\n');
    got.length = 0;
    await sessions.get(S1)!.interrupt();
    await sleep(20);
    transcripts.poll();
    assert.deepEqual(got.filter((m) => m.t === 'restore').map((m) => m.texts), [['Second, queued.']]);
    assert.equal(meta(S1).status, 'stopped');
  } finally { stop(); }
});

test('scripted: a message that starts a turn and bash mode\'s context go to the transcript as the CLI writes them', async () => {
  const { claudeDir, sessions, transcripts, publisher, meta, stop } = await setup('claude', (s) => {
    s.onSend = [{ after: 20, message: { type: 'result', subtype: 'success', is_error: false, result: '' } }, { message: { type: 'system', subtype: 'session_state_changed', state: 'idle' } }];
    s.sessions = { [S1]: { start: true } };
  });
  try {
    const file = path.join(claudeDir, 'projects', '-tmp-fixture', `${S1}.jsonl`);
    const uuid = '0c0c0c0c-0000-4000-8000-00000000000c';
    assert.equal(sessions.get(S1)!.send('Read the notes again.', [], uuid).ok, true);
    await sleep(5);
    assert.equal(meta(S1).status, 'busy');
    const last = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').pop()!);
    assert.deepEqual([last.type, last.uuid, last.sessionId, last.message.content], ['user', uuid, S1, 'Read the notes again.']);
    await sleep(60);
    transcripts.poll();
    assert.equal(meta(S1).status, 'idle', 'the script\'s onSend ended the turn');
    // bash mode's context: a user message with shouldQuery false, no turn
    const before = fs.readFileSync(file, 'utf8').split('\n').length;
    const proc = (sessions as unknown as { live: Map<string, { proc: { pushQuiet(t: string, u: string): void } }> }).live.get(S1)!.proc;
    proc.pushQuiet('<bash-input>ls</bash-input>', '0d0d0d0d-0000-4000-8000-00000000000d');
    proc.pushQuiet('<bash-stdout>a</bash-stdout><bash-stderr></bash-stderr>', '0d0d0d0d-0000-4000-8000-00000000000e');
    await sleep(10);
    assert.equal(fs.readFileSync(file, 'utf8').split('\n').length, before + 1, 'the two go in one record, as the CLI writes them');
    const joined = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').pop()!);
    assert.deepEqual([joined.uuid, joined.queueTranscriptOnly, joined.mergedSendUuids, joined.message.content],
      ['0d0d0d0d-0000-4000-8000-00000000000d', true, ['0d0d0d0d-0000-4000-8000-00000000000e'], '<bash-input>ls</bash-input>\n<bash-stdout>a</bash-stdout><bash-stderr></bash-stderr>']);
    assert.equal(meta(S1).status, 'idle');
  } finally { stop(); }
});

test('scripted: listSessions lists the tree\'s transcripts; the writer gets the script\'s reply or a failure', async () => {
  const { scripted, root, store, stop } = await setup('claude');
  try {
    const list = await scripted.sdk.listSessions();
    assert.equal(list.length, 5);
    const s1 = list.find((s) => s.sessionId === S1)!;
    assert.equal(s1.cwd, '/Users/fixture/dev/demo');
    assert.ok(s1.firstPrompt && s1.lastModified > 0);
    const run = async (reply?: { title: string; now: string }) => {
      (scripted.script as Script).writer = reply;
      const w = new Writer({ store, stateDir: root, debounceMs: 0, sdk: scripted.sdk, source: { title: () => 'T', turns: () => [{ you: 'a', claude: 'b' }], resolve: (x) => x, changed: () => {} } });
      w.turnEnded(S1);
      await sleep(30);
      w.stop();
      return store.state.written[S1];
    };
    assert.equal(await run(), undefined, 'no reply: the call failed, nothing written');
    assert.equal((await run({ title: 'Scripted title', now: 'Your turn' }))?.title, 'Scripted title');
  } finally { stop(); }
});

test('scripted: every pid file is a live CLI that isn\'t Synopia\'s; a take-over\'s signal only logs', async () => {
  const { claudeDir, scripted, stop } = await setup('claude', (s) => { s.sessions = {}; });
  try {
    fs.mkdirSync(path.join(claudeDir, 'sessions'));
    fs.writeFileSync(path.join(claudeDir, 'sessions', '90001.json'), JSON.stringify({ pid: 90001, sessionId: S1, cwd: '/tmp', procStart: 'Mon Nov 23 09:00:00 2026', kind: 'interactive', entrypoint: 'cli', status: 'idle', statusUpdatedAt: 1 }));
    const t = new CliTerminals({ dir: path.join(claudeDir, 'sessions'), probe: scripted.probe, end: scripted.end, pollMs: 0, watch: false });
    await t.scan();
    const held = t.holder(S1);
    assert.equal(held?.pid, 90001);
    assert.equal(await t.end(held!, 'note', S1), true, 'the pretend CLI exits on the signal');
    assert.equal(t.holder(S1), null);
    t.stop();
  } finally { stop(); }
});

test('scripted: a fork with another cwd gets a new id and a file under the new folder with the whole history (docs/Agent SDK.md)', async () => {
  const t = await setup();
  const next = path.join(t.root, 'next');
  const src = path.join(t.claudeDir, 'projects', '-tmp-fixture', `${S2}.jsonl`);
  const before = fs.readFileSync(src, 'utf8');
  let push: ((m: unknown) => void) | null = null;
  const prompt = { async *[Symbol.asyncIterator]() { yield* await new Promise<unknown[]>((r) => { push = (m) => r([m]); }); } };
  const q = t.scripted.sdk.query({ prompt: prompt as never, options: { cwd: next, resume: S2, forkSession: true, canUseTool: (async () => ({ behavior: 'deny', message: 'no' })) as never } });
  push!({ type: 'user', message: { role: 'user', content: 'Moved here.' }, parent_tool_use_id: null, uuid: '0e9b7f1c-0000-4000-8000-0000000000f1', shouldQuery: false });
  await sleep(20);
  const list = await t.scripted.sdk.listSessions();
  const fork = list.find((s) => s.cwd === next);
  assert.ok(fork && fork.sessionId !== S2, 'a new id, listed under the new folder');
  const file = path.join(t.claudeDir, 'projects', next.replace(/[^A-Za-z0-9]/g, '-'), `${fork!.sessionId}.jsonl`);
  const recs = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(recs.length, before.trim().split('\n').length + 1, 'the whole history, then the context line');
  assert.ok(recs.every((r) => r.sessionId === fork!.sessionId));
  assert.equal(recs.at(-1).message.content, 'Moved here.');
  assert.equal(fs.readFileSync(src, 'utf8'), before, 'the old file is left as it was');
  q.close?.();
  t.stop();
});

test('scripted: a call of Synopia\'s own tool asks, runs the tool from the session\'s server and writes both records (live run TL-1)', async () => {
  const START = 'mcp__synopia__start_session';
  const jsonLine = (l: string) => { try { return [JSON.parse(l)]; } catch { return []; } }; // the fixture keeps a broken line
  const t = await setup('claude', (s) => {
    s.sessions[S1] = { ...s.sessions[S1], steps: [running(), { call: { tool: START, input: { prompt: 'Read HANDOFF.md and go on.', title: 'Next steps' }, toolUseId: 'toolu_start1' } }] };
  }, true);
  try {
    const req = t.publisher.pending().map((p) => p.request).find((r) => r.toolUseId === 'toolu_start1');
    assert.ok(req, 'the call waits on the card');
    assert.match((req!.own as { text: string }).text, /^Start a new session in \S+ with: Read HANDOFF\.md and go on\.$/);
    assert.equal(t.sessions.get(S1)!.answer(req!.id, { choice: 'once' }).ok, true);
    let file = '';
    for (let i = 0; i < 100 && !file; i++) {
      await sleep(20);
      const f = t.scripted.fileOf(S1, '');
      const recs = fs.readFileSync(f, 'utf8').split('\n').flatMap(jsonLine);
      if (recs.some((r) => r.toolUseResult && r.message?.content?.[0]?.tool_use_id === 'toolu_start1')) file = f;
    }
    assert.ok(file, 'the tool_result record was written');
    const recs = fs.readFileSync(file, 'utf8').split('\n').flatMap(jsonLine);
    const use = recs.find((r) => r.type === 'assistant' && r.message.content[0]?.name === START);
    assert.deepEqual(use.message.content[0].input, { prompt: 'Read HANDOFF.md and go on.', title: 'Next steps' });
    const res = recs.find((r) => r.toolUseResult && r.message?.content?.[0]?.tool_use_id === 'toolu_start1');
    const block = res.message.content[0];
    assert.equal(block.tool_use_id, 'toolu_start1');
    assert.equal(block.is_error, undefined, JSON.stringify(block.content));
    const newId = /Started session (\S+) “Next steps”/.exec(block.content[0].text)?.[1];
    assert.ok(newId && t.sessions.get(newId), 'the new session is open under its real id');
    const titled = fs.readdirSync(path.join(t.claudeDir, 'projects'), { recursive: true }).map(String).find((f) => f.endsWith(`${newId}.jsonl`));
    const newRecs = fs.readFileSync(path.join(t.claudeDir, 'projects', titled!), 'utf8').split('\n').flatMap(jsonLine);
    assert.equal(newRecs.find((r) => r.type === 'custom-title')?.customTitle, 'Next steps', 'Options.title as a custom-title record');
  } finally {
    t.stop();
  }
});
