// The scripted SDK (dev/scripted-sdk.ts) under the real Sessions and Views: the state folder it seeds,
// the steps it plays with the clock moved, its control calls, what it writes to a transcript, its
// listSessions, the writer's call, and the pretend terminals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Views } from '../src/views.ts';
import { Sessions } from '../src/sessions.ts';
import { Writer } from '../src/writer.ts';
import { openStore } from '../src/store.ts';
import { CliTerminals } from '../src/cli-terminals.ts';
import { readMenu } from '../src/sdk.ts';
import { openScripted, seedState, ScriptClock, SCRIPT_FILE } from '../dev/scripted-sdk.ts';
import type { Script } from '../dev/scripted-sdk.ts';
import type { Client } from '../src/server.ts';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const S1 = '11111111-0000-4000-8000-000000000001', S2 = '22222222-0000-4000-8000-000000000002', S4 = '44444444-0000-4000-8000-000000000004';
type Msg = { t: string; [k: string]: unknown };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const running = (ago = 0) => ({ ago, message: { type: 'system', subtype: 'session_state_changed', state: 'running' } });

// A fixture tree copied to a temp folder, its script changed by `edit`, and the backend's parts over it.
async function setup(tree = 'claude', edit?: (s: Script) => void) {
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
  const views = new Views({
    claudeDir, clients: () => new Set([c]), home: scripted.home, pollMs: 0, watch: false,
    onAssistant: (sid, mid, types) => sessions?.landed(sid, mid, types),
    onRunning: (sid, r) => sessions?.runningChanged(sid, r),
  });
  sessions = new Sessions({ store, views, sdk: scripted.sdk, home: scripted.home, now: scripted.clock.now, timer: scripted.clock.timer });
  sessions.start();
  scripted.attach(sessions);
  await scripted.whenPlayed();
  await sleep(10);
  views.check();
  const meta = (sid: string) => views.meta(sid) as NonNullable<ReturnType<Views['meta']>> & { driven: boolean };
  const stop = () => { sessions?.stop(); views.stop(); store.close(); };
  return { root, claudeDir, stateDir, scripted, store, views, sessions: sessions as Sessions, got, meta, stop };
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
  const { views, sessions, meta, got, stop } = await setup();
  try {
    const pending = views.pending().map((p) => [p.sid.slice(0, 4), p.request.id, p.request.kind]);
    assert.deepEqual(pending, [['2222', 'req-question-1', 'question'], ['3333', 'req-permission-1', 'permission'], ['5555', 'req-plan-1', 'plan']]);
    const perm = views.pending()[1].request as { always: string | null; cwd: string; since: number };
    assert.ok(perm.always, 'the suggestion gives an "Always allow"');
    assert.equal(perm.cwd, '~/dev/demo');
    assert.ok(Math.abs(Date.now() - 120_000 - perm.since) < 2000, 'the card is 2 min old (ago)');
    assert.equal(meta(S2).status, 'waiting');
    assert.ok(Math.abs(Date.now() - 240_000 - meta(S2).statusAt) < 2000);
    await sleep(700); // the stream's last delta is 600 ms in
    assert.equal(meta(S4).status, 'busy');
    const stream = got.filter((m) => m.t === 'stream' && m.sid === S4).pop();
    assert.equal(stream?.text, "Two subagents are still running. I'll merge their changes when both report back.");
    assert.ok([S1, S2, S4].every((s) => meta(s).driven), 'Synopia\'s own processes drive them');
    // the menu from S1's running process: HTML unescaped, internal commands left out
    const menu = await readMenu(sessions.menuSource(S1)!, 1000);
    assert.equal(menu.commands.length, 7);
    assert.equal(menu.commands.find((c) => c.name === 'pr-review')?.hint, '<number>');
    assert.deepEqual(menu.models.map((m) => m.value), ['default', 'fixture-large', 'fixture-small']);
    // an answer settles the request: working, then the script's result 3 s later
    assert.equal(sessions.answer(S2, 'req-question-1', { questions: [{ picks: ['No'] }, { picks: ['Docs'] }] }).ok, true);
    assert.ok(!views.pending().some((p) => p.request.id === 'req-question-1'));
    await sleep(20);
    assert.equal(meta(S2).status, 'busy');
  } finally { stop(); }
});

test('scripted: the states fixture plays one session per wired state, on the real status rules', async () => {
  const { views, meta, stop } = await setup('claude-states');
  try {
    await sleep(30); // e5e5's stale timer, armed 16 min in the past, is due at once
    const all = views.sessions() as { id: string; status: string; statusAt: number; statusDetail: { queued?: number; retry?: { attempt: number; max: number; at: number }; external?: true }; driven: boolean }[];
    assert.deepEqual(all.map((s) => s.status), ['busy', 'compacting', 'retrying', 'signedout', 'stale', 'busy', 'busy']);
    assert.equal(all[0].statusDetail.queued, 1, 'the message sent during the turn');
    assert.deepEqual([all[2].statusDetail.retry?.attempt, all[2].statusDetail.retry?.max], [3, 10]);
    assert.ok(Math.abs((all[2].statusDetail.retry?.at ?? 0) - Date.now() - 38_000) < 2000, 'the retry 38 s off');
    assert.ok(Math.abs(Date.now() - 300_000 - all[3].statusAt) < 2000, 'signed out 5 min ago');
    assert.ok(Math.abs(Date.now() - 960_000 - all[4].statusAt) < 2000, 'no message for 16 min');
    assert.equal(all[5].driven, true, 'f6f6: its own background subagents, no other process');
    assert.equal(all[6].driven, false, 'f7f7: its main turn runs in another process');
    assert.equal(all[6].statusDetail.external, true);
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
  const { claudeDir, sessions, views, meta, got, stop } = await setup('claude', (s) => {
    s.sessions = { [S1]: { start: true, steps: [running(30_000)] } };
  });
  try {
    assert.equal(meta(S1).status, 'busy');
    const a = '0a0a0a0a-0000-4000-8000-00000000000a', b = '0b0b0b0b-0000-4000-8000-00000000000b';
    assert.equal(sessions.send(S1, 'First, queued.', [], a).ok, true);
    assert.equal(sessions.send(S1, 'Second, queued.', [], b).ok, true);
    await sleep(10);
    assert.equal(meta(S1).statusDetail.queued, 2);
    // the first lands, as the CLI writes a queued message it took in
    const file = path.join(claudeDir, 'projects', '-tmp-fixture', `${S1}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ type: 'attachment', uuid: 'land-1', timestamp: new Date().toISOString(), sessionId: S1, attachment: { type: 'queued_command', prompt: 'First, queued.' } }) + '\n');
    got.length = 0;
    await sessions.interrupt(S1);
    await sleep(20);
    views.check();
    assert.deepEqual(got.filter((m) => m.t === 'restore').map((m) => m.texts), [['Second, queued.']]);
    assert.equal(meta(S1).status, 'stopped');
  } finally { stop(); }
});

test('scripted: a message that starts a turn and bash mode\'s context go to the transcript as the CLI writes them', async () => {
  const { claudeDir, sessions, views, meta, stop } = await setup('claude', (s) => {
    s.onSend = [{ after: 20, message: { type: 'result', subtype: 'success', is_error: false, result: '' } }, { message: { type: 'system', subtype: 'session_state_changed', state: 'idle' } }];
    s.sessions = { [S1]: { start: true } };
  });
  try {
    const file = path.join(claudeDir, 'projects', '-tmp-fixture', `${S1}.jsonl`);
    const uuid = '0c0c0c0c-0000-4000-8000-00000000000c';
    assert.equal(sessions.send(S1, 'Read the notes again.', [], uuid).ok, true);
    await sleep(5);
    assert.equal(meta(S1).status, 'busy');
    const last = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').pop()!);
    assert.deepEqual([last.type, last.uuid, last.sessionId, last.message.content], ['user', uuid, S1, 'Read the notes again.']);
    await sleep(60);
    views.check();
    assert.equal(meta(S1).status, 'idle', 'the script\'s onSend ended the turn');
    // bash mode's context: a user message with shouldQuery false, no turn
    const before = fs.readFileSync(file, 'utf8').split('\n').length;
    const proc = (sessions as unknown as { live: Map<string, { proc: { pushQuiet(t: string, u: string): void } }> }).live.get(S1)!.proc;
    proc.pushQuiet('<bash-input>ls</bash-input>', '0d0d0d0d-0000-4000-8000-00000000000d');
    await sleep(10);
    assert.equal(fs.readFileSync(file, 'utf8').split('\n').length, before + 1);
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
