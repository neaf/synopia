import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transcripts } from '../src/transcripts.ts';
import { Publisher } from '../src/publisher.ts';
import type { Client } from '../src/server.ts';

// docs/Claude Code transcripts.md "A subagent resumed by SendMessage" and "Denied tool calls": fixtures/claude-resume
// holds invented data in the shapes of a live session (2026-11-26). Two background subagents: the bank check ends after
// a step auto mode blocked (R8.2); the CSV check ends, a SendMessage resumes it and it ends again (R7.1).
const SID = '88888888-0000-4000-8000-000000000008';
const FROM = path.join(import.meta.dirname, 'fixtures', 'claude-resume', 'projects', '-tmp-fixture');
const HOME = '/Users/fixture';
const FILES = [`${SID}.jsonl`, `${SID}/subagents/agent-rrrr0001.jsonl`, `${SID}/subagents/agent-rrrr0002.jsonl`];
const lines = (f: string) => fs.readFileSync(path.join(FROM, f), 'utf8').split('\n').filter(Boolean);
const timeOf = (l: string) => (JSON.parse(l).timestamp as string).slice(11, 19);

// A copy of the fixture with its metas and no records, and `upTo`, which appends each file's records up to a time
// (HH:MM:SS), as the CLI writes them.
function session() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-resume-'));
  const to = path.join(dir, 'projects', '-tmp-fixture');
  fs.mkdirSync(path.join(to, SID, 'subagents'), { recursive: true });
  for (const a of ['rrrr0001', 'rrrr0002']) fs.copyFileSync(path.join(FROM, SID, 'subagents', `agent-${a}.meta.json`), path.join(to, SID, 'subagents', `agent-${a}.meta.json`));
  const done = new Map<string, number>();
  const upTo = (until: string, only = FILES) => {
    for (const f of only) {
      const all = lines(f), at = done.get(f) ?? 0;
      let n = at;
      while (n < all.length && timeOf(all[n]) <= until) n++;
      fs.appendFileSync(path.join(to, f), all.slice(at, n).map((l) => `${l}\n`).join(''));
      done.set(f, n);
    }
  };
  const transcripts = new Transcripts({ claudeDir: dir, home: HOME, pollMs: 0, watch: false });
  const publisher = new Publisher({ transcripts, clients: () => new Set<Client>(), home: HOME, recheckMs: 0 });
  const main = () => transcripts.get(SID)!;
  return {
    upTo, transcripts, publisher, main,
    state: () => publisher.meta(SID)!.state,
    agent: (aid: string) => main().getAgent(aid)!,
    running: () => main().agents().filter((a) => a.running).map((a) => a.id),
    stop: () => { transcripts.stop(); publisher.stop(); },
  };
}

test('a subagent ended after a step auto mode blocked: needs you, blocked, until your next message', () => {
  const s = session();
  s.upTo('09:03:06'); // both ended; Claude asks in plain text and its turn is over
  s.transcripts.open(SID);
  assert.deepEqual([s.state().word, s.state().needsYou], ['Needs you, blocked', 'blocked']);
  const step = s.transcripts.get(SID, 'rrrr0002')!.get('toolu_b2')!;
  assert.deepEqual([step.state, step.denied], ['denied', 'auto'], 'its view reads "Blocked by auto mode"');
  assert.deepEqual(s.running(), [], 'both under Past');
  s.upTo('09:05:00');
  s.transcripts.poll();
  assert.deepEqual([s.state().needsYou, s.state().word], [null, 'Your turn'], 'your message cleared it (the fixture is old: a quiet turn)');
  s.stop();
});

test('a subagent resumed by SendMessage runs again, its shell from the run before stays ended, until it ends again', () => {
  const s = session();
  s.upTo('09:05:05'); // a SendMessage resumed the CSV check; the main turn is over
  s.transcripts.open(SID);
  assert.deepEqual([s.running(), s.state().word], [['rrrr0001'], 'Your turn'], 'running in the background, its meta still says finished');
  assert.deepEqual([s.agent('rrrr0001').finished, s.agent('rrrr0001').stopped, s.agent('rrrr0001').waiting], [false, false, false]);
  const shell = () => s.main().background().find((b) => b.toolUseId === 'toolu_c2')!;
  assert.deepEqual([shell().status, shell().end], ['completed', '2026-11-24T09:02:00.000Z'], 'ended with the run before');
  s.upTo('09:06:10'); // its end notification
  s.transcripts.poll();
  assert.deepEqual([s.running(), s.agent('rrrr0001').finished, s.state().word], [[], true, 'Your turn'], 'back to Past');
  assert.equal(shell().status, 'completed');
  s.stop();
});

test('a resumed subagent seen by its file alone: records well after its end run it again', () => {
  const s = session();
  s.upTo('09:05:00'); // no SendMessage result in the main file yet
  s.upTo('09:05:40', [FILES[1]]); // the CSV check's new run
  s.transcripts.open(SID);
  assert.deepEqual(s.running(), ['rrrr0001']);
  s.stop();
});

test('a resumed subagent: the SDK says it ended (by its task id), or the process ends and it reads stopped', () => {
  const s = session();
  s.upTo('09:05:05');
  s.transcripts.open(SID);
  s.transcripts.taskEnded(SID, 'toolu_rs1', 'completed', '', 'rrrr0001'); // the SendMessage's tool use id, the agent's task id
  assert.deepEqual([s.running(), s.agent('rrrr0001').stopped], [[], false], 'the SDK told of its end before the JSONL');
  s.stop();
  const t = session();
  t.upTo('09:05:05');
  t.transcripts.open(SID);
  t.transcripts.processEnded(SID, Date.parse('2026-11-24T09:05:30.000Z'));
  assert.deepEqual([t.running(), t.agent('rrrr0001').stopped], [[], true]);
  t.stop();
});
