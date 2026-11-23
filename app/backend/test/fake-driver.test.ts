import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Views } from '../src/views.ts';
import { FakeDriver, fixtureSessions, loadScript } from '../src/fake-driver.ts';
import type { Client } from '../src/server.ts';

const CLAUDE = path.join(import.meta.dirname, 'fixtures', 'claude');

test('fake driver: opens every fixture session and plays the script', async () => {
  const got: { t: string; [k: string]: unknown }[] = [];
  const c: Client = { send: (m) => got.push(m as { t: string }), close: () => {} };
  const clients = new Set<Client>([c]);
  const script = loadScript(CLAUDE);
  const views = new Views({ claudeDir: CLAUDE, clients: () => clients, home: script.home, pollMs: 0, watch: false });
  const fake = new FakeDriver(views, script);
  fake.start(CLAUDE);
  fake.stop(); // the timers; runAll plays the same steps at once
  fake.runAll();

  assert.equal(views.ids().length, fixtureSessions(CLAUDE).length);
  assert.equal(views.ids().length, 5);
  const kinds = views.pending().map((p) => p.request.kind).sort();
  assert.deepEqual(kinds, ['permission', 'plan', 'question']);
  const q = views.pending().find((p) => p.request.kind === 'question')?.request as unknown as { input: { questions: { multiSelect: boolean }[] } };
  assert.ok(q.input.questions.some((x) => x.multiSelect));
  const perm = views.pending().find((p) => p.request.kind === 'permission')?.request as unknown as { suggestions: unknown[] };
  assert.ok(perm.suggestions.length > 0);
  const sessions = views.sessions() as { id: string; status: string; stream: string | null; cwd: string }[];
  assert.ok(sessions.some((s) => s.status === 'busy' && s.stream));
  assert.equal(sessions.find((s) => s.id.startsWith('1111'))?.cwd, '~/dev/demo');
  assert.ok(Object.keys(fake.menu()).length > 0);
  assert.ok(got.some((m) => m.t === 'stream'));

  // An answer settles its request.
  const sid = views.pending()[0].sid;
  const rid = views.pending()[0].request.id;
  assert.equal(fake.onMessage(c, { t: 'answer', sid, requestId: rid, answer: {} }), true);
  assert.ok(!views.pending().some((p) => p.request.id === rid));
  assert.equal(views.meta(sid)?.status, 'busy');
  assert.equal(fake.onMessage(c, { t: 'send', sid }), false);
  fake.stop();
  views.stop();
});

test('fake driver: the states fixture plays one session per wired state, with its detail', () => {
  const dir = path.join(import.meta.dirname, 'fixtures', 'claude-states');
  const script = loadScript(dir);
  const views = new Views({ claudeDir: dir, clients: () => new Set(), home: script.home, pollMs: 0, watch: false });
  const fake = new FakeDriver(views, script);
  fake.start(dir);
  fake.stop();
  fake.runAll();
  const got = views.sessions() as { id: string; status: string; statusDetail: { queued?: number; retry?: { attempt: number; at: number } } }[];
  // the last has no scripted status: its subagents run, so its transcript alone reads working
  // the last two have no scripted status: f6f6's background subagents run; f7f7 is the author's mix
  assert.deepEqual(got.map((s) => s.status), ['busy', 'compacting', 'retrying', 'signedout', 'stale', 'busy', 'busy']);
  assert.ok(views.running(got[5].id).agents > 0);
  const mix = views.running(got[6].id);
  assert.equal(mix.agents, 1, 'one subagent');
  assert.equal(mix.turn, true, 'its main turn is open in another process: a foreground tool waits for its result');
  const bg = (views.sessions() as { id: string; background: { kind: string; status: string }[] }[])[6].background;
  assert.deepEqual(bg.map((b) => `${b.kind}:${b.status}`).sort(), ['monitor:running', 'shell:running']);
  assert.equal(got[0].statusDetail.queued, 1);
  assert.equal(got[2].statusDetail.retry?.attempt, 3);
  assert.ok((got[2].statusDetail.retry?.at ?? 0) > Date.now());
  views.stop();
});
