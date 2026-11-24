import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Badge, badgeCount } from '../src/badge.ts';
import { Views } from '../src/views.ts';
import type { BadgeSession, BadgeSource } from '../src/badge.ts';
import type { Client } from '../src/server.ts';

const CLAUDE = path.join(import.meta.dirname, 'fixtures', 'claude');
const IDLE = '11111111-0000-4000-8000-000000000001';
const ASKS = '22222222-0000-4000-8000-000000000002';
const AGENTS = '44444444-0000-4000-8000-000000000004';
const REVIEW = 'aaaa0004'; // "For review: Draft the demo release notes", finished in the fixture

function setup() {
  // A question in a transcript whose file is 12 hours quiet is your turn (status.ts ASK_STALE_MS): the
  // fixture's records are older, so its file counts as just changed, whenever it was checked out.
  const now = new Date();
  fs.utimesSync(path.join(CLAUDE, 'projects', '-tmp-fixture', `${ASKS}.jsonl`), now, now);
  const reviewed: string[] = [];
  let badge: Badge | null = null;
  const views = new Views({ claudeDir: CLAUDE, clients: () => new Set<Client>(), home: '/Users/fixture', pollMs: 0, watch: false, onChange: () => badge?.changed() });
  const source: BadgeSource = { sessions: () => views.sessions() as BadgeSession[], pending: () => views.pending(), reviewed: () => reviewed };
  const emitted: number[] = [];
  badge = new Badge({ source, emit: (n) => emitted.push(n), debounceMs: 20 });
  return { views, source, reviewed, emitted, badge };
}
const settle = () => new Promise((r) => setTimeout(r, 60));

test('badge: needs-you sessions and deliverables to review, open sessions only', async () => {
  const { views, source, reviewed } = setup();
  views.open(IDLE);
  views.open(ASKS);
  views.open(AGENTS);
  await Promise.resolve();
  // its transcript ends on a question with no answer and no driver set a status: another process asks (R6.8)
  assert.equal(badgeCount(source), 2, 'the finished For review subagent and the question the transcript waits on');
  views.setStatus(ASKS, 'busy');
  assert.equal(badgeCount(source), 1, 'the driver says working: only the For review subagent');

  views.setPending(ASKS, { id: 'q1', kind: 'question', since: 1 });
  assert.equal(badgeCount(source), 2, 'a pending request');
  views.setStatus(ASKS, 'waiting');
  assert.equal(badgeCount(source), 2, 'one session counts once');
  views.setStatus(IDLE, 'waiting');
  assert.equal(badgeCount(source), 3, 'the status waiting alone');

  reviewed.push(REVIEW);
  assert.equal(badgeCount(source), 2, 'marked reviewed drops it');
  reviewed.length = 0;

  views.close(AGENTS);
  views.close(ASKS);
  assert.equal(badgeCount(source), 1, 'closed sessions are left out');
  views.stop();
});

test('badge: emits only when the count changes, debounced', async () => {
  const { views, reviewed, emitted, badge } = setup();
  views.open(IDLE);
  views.open(AGENTS);
  await settle();
  assert.deepEqual(emitted, [1]);

  views.setStatus(IDLE, 'busy');
  views.setStatus(IDLE, 'idle');
  await settle();
  assert.deepEqual(emitted, [1], 'no emit for a change that leaves the count');

  views.setPending(IDLE, { id: 'p1', kind: 'permission', since: 1 });
  views.setPending(IDLE, { id: 'p2', kind: 'permission', since: 2 });
  views.clearPending(IDLE, 'p1');
  await settle();
  assert.deepEqual(emitted, [1, 2], 'one emit for a burst');

  reviewed.push(REVIEW);
  badge.changed();
  views.clearPending(IDLE, 'p2');
  await settle();
  assert.deepEqual(emitted, [1, 2, 0], 'back to 0');
  badge.changed();
  await settle();
  assert.deepEqual(emitted, [1, 2, 0], 'no duplicate');
  badge.stop();
  views.stop();
});

test('badge: only needs you counts among the statuses; signed out and the turn states do not', () => {
  const sessions: BadgeSession[] = ['waiting', 'signedout', 'stale', 'retrying', 'compacting', 'busy', 'failed', 'idle'].map((status, i) => ({ id: `s${i}`, status }));
  assert.equal(badgeCount({ sessions: () => sessions, pending: () => [], reviewed: () => [] }), 1);
  assert.equal(badgeCount({ sessions: () => sessions, pending: () => [{ sid: 's1' }], reviewed: () => [] }), 2, 'a request on a signed-out session still needs you');
});

test('badge: a session whose turn runs in another process, with nothing pending, does not count', () => {
  const dir = path.join(import.meta.dirname, 'fixtures', 'claude-states');
  const views = new Views({ claudeDir: dir, clients: () => new Set<Client>(), home: '/Users/fixture', pollMs: 0, watch: false });
  views.open('f7f7f7f7-0000-4000-8000-000000000007');
  views.check();
  assert.equal((views.sessions() as BadgeSession[])[0].status, 'busy');
  assert.equal(badgeCount({ sessions: () => views.sessions() as BadgeSession[], pending: () => views.pending(), reviewed: () => [] }), 0);
  views.stop();
});

test('badge: a question or plan another process asks counts, with its ask for the page, until its result lands (R6.8)', () => {
  const src = path.join(import.meta.dirname, 'fixtures', 'claude-ext');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-ext-'));
  fs.cpSync(src, dir, { recursive: true });
  const views = new Views({ claudeDir: dir, clients: () => new Set<Client>(), home: '/Users/fixture', pollMs: 0, watch: false });
  const Q = 'e1e1e1e1-0000-4000-8000-00000000000a', P = 'e2e2e2e2-0000-4000-8000-00000000000b';
  views.open(Q);
  views.open(P);
  views.check();
  const count = () => badgeCount({ sessions: () => views.sessions() as BadgeSession[], pending: () => views.pending(), reviewed: () => [] });
  const q = views.meta(Q);
  assert.equal(q?.status, 'waiting', 'needs you, though the turn runs by the transcript');
  assert.equal(q?.statusAt, Date.parse('2026-11-24T09:00:40.000Z'), 'aged from the tool_use');
  assert.deepEqual([q?.ask?.kind, q?.ask?.qs?.length, q?.ask?.qs?.[1].multi], ['question', 2, true]);
  assert.deepEqual([views.meta(P)?.status, views.meta(P)?.ask?.kind, views.meta(P)?.ask?.plan?.startsWith('## Move')], ['waiting', 'plan', true]);
  assert.equal(count(), 2);
  views.setPending(P, { id: 'r1', kind: 'plan', since: 1 });
  views.setStatus(P, 'waiting');
  assert.equal(views.meta(P)?.ask, null, 'a request of ours is the card: no read-only one');
  const file = path.join(dir, 'projects', '-tmp-ext', `${Q}.jsonl`);
  fs.appendFileSync(file, JSON.stringify({ type: 'user', uuid: 'x1-u3', timestamp: '2026-11-24T09:02:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_xask1', content: 'User has answered your questions: "Which release channel should the checklist target?"="Beta". You can now continue.' }] } }) + '\n');
  views.check();
  assert.deepEqual([views.meta(Q)?.status, views.meta(Q)?.ask], ['busy', null], 'answered there: the turn goes on');
  assert.equal(count(), 1);
  views.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});
