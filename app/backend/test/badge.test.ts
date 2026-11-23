import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  assert.equal(badgeCount(source), 1, 'the finished For review subagent');

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
