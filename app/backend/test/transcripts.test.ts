// transcripts.ts, the reading set: what it reads and tells its listener, and the facts others read.
// The frames built from it are publisher.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transcripts } from '../src/transcripts.ts';

const CLAUDE = path.join(import.meta.dirname, 'fixtures', 'claude');
const HOME = '/Users/fixture';
const AGENTS = '44444444-0000-4000-8000-000000000004';

const line = (o: object) => JSON.stringify(o) + '\n';
const you = (i: number, ts = `2026-11-20T10:00:${String(i % 60).padStart(2, '0')}.000Z`) => line({ type: 'user', uuid: `u${i}`, timestamp: ts, message: { role: 'user', content: `prompt ${i}` } });
const bgShell = (ts = '2026-11-20T10:00:02.000Z') => line({
  type: 'assistant', uuid: 'a1', timestamp: ts,
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Bash', input: { command: 'sleep 90', description: 'Wait a while', run_in_background: true } }] },
});

function tempSession(id: string, body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-transcripts-'));
  fs.mkdirSync(path.join(dir, 'projects', '-tmp-x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects', '-tmp-x', `${id}.jsonl`), body);
  return dir;
}

// A reading set with no timers and a listener that records what it hears.
function reading(claudeDir: string) {
  const heard: string[] = [];
  const transcripts = new Transcripts({ claudeDir, home: HOME, pollMs: 0, watch: false });
  transcripts.listen({
    changed: (sid) => heard.push(`changed ${sid}`),
    closed: (sid) => heard.push(`closed ${sid}`),
    rekeyed: (from, to) => heard.push(`rekeyed ${from} ${to}`),
  });
  return { transcripts, heard };
}

test('poll: a new session\'s file is found once it appears, read, and told once per batch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-transcripts-'));
  const id = 'aaaaaaaa-0000-4000-8000-0000000000f1';
  const { transcripts, heard } = reading(dir);
  transcripts.open(id, { cwd: '/tmp/x' });
  await transcripts.poll();
  assert.deepEqual([transcripts.pathOf(id), heard], [null, []], 'no file yet: nothing to tell');
  fs.mkdirSync(path.join(dir, 'projects', '-tmp-x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects', '-tmp-x', `${id}.jsonl`), you(1) + you(2));
  await transcripts.poll(); // the look for a new file is async (NFR-06)
  assert.deepEqual(heard, [`changed ${id}`], 'told once the file is found');
  assert.deepEqual(transcripts.get(id)?.items.map((i) => i.id), ['u1', 'u2']);
  assert.deepEqual(transcripts.takeChanges(id)?.items, ['u1', 'u2']);
  await Promise.resolve();
  assert.equal(heard.length, 1, 'the batch is told once, not again by its microtask');
  transcripts.poll();
  assert.equal(heard.length, 1, 'nothing new: nothing told');
  transcripts.stop();
});

test('open, rekey, close: the listener hears each; a rekey reads the new id\'s file from the start', () => {
  const id = 'aaaaaaaa-0000-4000-8000-0000000000f2', next = 'aaaaaaaa-0000-4000-8000-0000000000f3';
  const dir = tempSession(id, you(1));
  fs.writeFileSync(path.join(dir, 'projects', '-tmp-x', `${next}.jsonl`), you(7) + you(8));
  const { transcripts, heard } = reading(dir);
  transcripts.open(id, { cwd: '/tmp/x' });
  transcripts.rekey(id, next);
  assert.deepEqual([transcripts.ids(), transcripts.cwdOf(next)], [[next], '/tmp/x']);
  assert.deepEqual(transcripts.get(next)?.items.map((i) => i.id), ['u7', 'u8']);
  transcripts.close(next);
  assert.deepEqual(heard, [`rekeyed ${id} ${next}`, `closed ${next}`]);
  assert.equal(transcripts.get(next), null);
  transcripts.stop();
});

test('turns: an interrupted turn says so to the writer; a turned-down tool does not (seams#B3)', () => {
  const id = 'aaaaaaaa-0000-4000-8000-0000000000ab';
  const marker = (uuid: string, s: number, text: string) => line({ type: 'user', uuid, timestamp: `2026-11-20T10:00:0${s}.000Z`, message: { role: 'user', content: [{ type: 'text', text }] } });
  const dir = tempSession(id, you(1) + marker('x2', 2, '[Request interrupted by user for tool use]') + you(3) + marker('x4', 4, '[Request interrupted by user]'));
  const { transcripts } = reading(dir);
  transcripts.open(id);
  assert.deepEqual(transcripts.turns(id), [{ you: 'prompt 1', claude: '' }, { you: 'prompt 3', claude: '(You interrupted this turn.)' }]);
  assert.equal(transcripts.turns('nope'), undefined);
});

test('subagents: read from the folder scan; a finished, quiet one only now and then (L6)', () => {
  const { transcripts } = reading(CLAUDE);
  transcripts.open(AGENTS);
  type Inner = { live: Map<string, { t: { agentRunning: (id: string) => boolean }; watcher: { scan: () => void }; children: Map<string, { tailer: { check: () => boolean } }> }> };
  const s = (transcripts as unknown as Inner).live.get(AGENTS)!;
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
  assert.deepEqual(transcripts.facts(AGENTS)?.runningWork.filter((k) => k === 'subagent').length, running.length);
  transcripts.stop();
});

test('work: a background shell running, then ended by the SDK\'s notification, is a line that says so', () => {
  const id = 'aaaaaaaa-0000-4000-8000-0000000000cf';
  const { transcripts, heard } = reading(tempSession(id, you(1) + bgShell()));
  transcripts.open(id);
  assert.deepEqual(transcripts.work(id), ['shell “Wait a while”: running']);
  assert.equal(transcripts.facts(id)?.working, true);
  heard.length = 0;
  transcripts.taskEnded(id, 'toolu_bg', 'killed', '');
  assert.deepEqual(heard, [`changed ${id}`], 'an SDK event is told at once');
  assert.deepEqual(transcripts.work(id), ['shell “Wait a while”: killed']);
  assert.equal(transcripts.facts(id)?.working, false);
  transcripts.stop();
});

test('work: what ended counts since your last message by instant, not by ISO text (formats#B6)', () => {
  const id = 'aaaaaaaa-0000-4000-8000-0000000000f4';
  // your last message at 10:00:05.500; the shell ends at 10:00:05 written without milliseconds,
  // which sorts after ".500Z" as text ('Z' > '.') but is half a second before it
  const ended = (at: string) => {
    const { transcripts } = reading(tempSession(id, bgShell('2026-11-20T10:00:01.000Z') + you(5, '2026-11-20T10:00:05.500Z')));
    transcripts.open(id);
    transcripts.get(id)!.taskEnded('toolu_bg', 'completed', '', at);
    const out = transcripts.work(id);
    transcripts.stop();
    return out;
  };
  assert.deepEqual(ended('2026-11-20T10:00:05Z'), [], 'ended before your message: not news');
  assert.deepEqual(ended('2026-11-20T10:00:06Z'), ['shell “Wait a while”: finished'], 'ended after it: a line');
});

test("taskStarted: the SDK's task id reaches the shell when the file has none", () => {
  const id = 'aaaaaaaa-0000-4000-8000-0000000000d0';
  const { transcripts } = reading(tempSession(id, you(1) + bgShell()));
  transcripts.open(id);
  transcripts.takeChanges(id);
  transcripts.taskStarted(id, 'toolu_bg', 'b1x2');
  assert.deepEqual(transcripts.takeChanges(id)?.background, ['toolu_bg']);
  assert.equal(transcripts.get(id)?.getBackground('toolu_bg')?.taskId, 'b1x2');
  transcripts.stop();
});

test('resultText: the full result read again from its line, after the file grew; null when it is gone', async () => {
  const id = 'abababab-0000-4000-8000-00000000000c';
  const out = Array.from({ length: 30 }, (_, i) => `out ${i}`).join('\n');
  const dir = tempSession(id, you(1) + line({
    type: 'assistant', uuid: 'a1', timestamp: '2026-11-20T10:00:02.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_o', name: 'Bash', input: { command: 'seq 30', description: 'Count' } }] },
  }) + line({
    type: 'user', uuid: 'r1', timestamp: '2026-11-20T10:00:03.000Z', toolUseResult: { stdout: out, stderr: '', interrupted: false },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_o', content: out }] },
  }));
  const file = path.join(dir, 'projects', '-tmp-x', `${id}.jsonl`);
  const { transcripts } = reading(dir);
  transcripts.open(id);
  fs.appendFileSync(file, you(4));
  transcripts.poll();
  assert.equal(await transcripts.resultText(id, null, 'toolu_o'), out);
  assert.equal(await transcripts.resultText(id, null, 'toolu_none'), null);
  fs.rmSync(file);
  assert.equal(await transcripts.resultText(id, null, 'toolu_o'), null);
  transcripts.stop();
});
