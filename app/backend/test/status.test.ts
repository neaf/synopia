import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStatus, outcomeOf, restored } from '../src/status.ts';
import type { StatusEntry } from '../src/status.ts';

function tracker(init: StatusEntry | null = null) {
  let t = 1000;
  const seen: string[] = [];
  const s = new SessionStatus(init, (e) => seen.push(e.status), () => (t += 1000));
  return { s, seen };
}

const ok = { subtype: 'success', is_error: false, terminal_reason: 'completed' };
const aborted = { subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' };
const apiError = { subtype: 'error_during_execution', is_error: true, terminal_reason: 'api_error' };

test('status: working from the state flag, your turn on idle after a normal result', () => {
  const { s, seen } = tracker();
  s.stateChanged('running');
  assert.equal(s.status, 'busy');
  s.result(ok);
  assert.equal(s.status, 'busy', 'with the flag, idle ends the turn, not result');
  s.stateChanged('idle');
  assert.equal(s.status, 'idle');
  assert.deepEqual(seen, ['busy', 'idle']);
});

test('status: the driver starting a turn is working', () => {
  const { s } = tracker();
  s.turnStarted();
  assert.equal(s.status, 'busy');
  assert.equal(s.working, true);
});

test('status: a pending request is needs you, and wins over running', () => {
  const { s } = tracker();
  s.stateChanged('running');
  s.setPending(2);
  assert.equal(s.status, 'waiting');
  s.stateChanged('requires_action');
  assert.equal(s.status, 'waiting');
  s.setPending(1);
  assert.equal(s.status, 'waiting');
  s.setPending(0);
  assert.equal(s.status, 'busy');
});

test('status: stopped by you after an interrupted turn', () => {
  const { s } = tracker();
  s.stateChanged('running');
  s.result(aborted);
  s.stateChanged('idle');
  assert.equal(s.status, 'stopped');
});

test('status: failed on an error result that is not an interrupt, and when the process fails', () => {
  const a = tracker().s;
  a.stateChanged('running');
  a.result(apiError);
  a.stateChanged('idle');
  assert.equal(a.status, 'failed');
  assert.equal(outcomeOf({ subtype: 'success', is_error: true }), 'failed');

  const b = tracker().s;
  b.turnStarted();
  b.processEnded(true);
  assert.equal(b.status, 'failed');
  b.turnStarted();
  assert.equal(b.status, 'busy', 'the next message tries again');
});

test('status: your turn when the process ends on purpose, and after a restart', () => {
  const { s } = tracker();
  s.turnStarted();
  s.setPending(1);
  s.processEnded(false);
  assert.equal(s.status, 'idle');
  assert.deepEqual(restored({ status: 'busy', at: 5 }), { status: 'idle', at: 5 });
  assert.deepEqual(restored({ status: 'waiting', at: 6 }), { status: 'idle', at: 6 });
  assert.deepEqual(restored({ status: 'stopped', at: 7 }), { status: 'stopped', at: 7 });
  assert.equal(restored(undefined), null);
  const r = tracker({ status: 'failed', at: 7 }).s;
  assert.equal(r.status, 'failed');
  assert.equal(r.at, 7, 'the stored age is kept');
});

test('status: without the state flag, working runs from the send to the result', () => {
  const { s, seen } = tracker();
  s.turnStarted();
  assert.equal(s.status, 'busy');
  s.result(ok);
  assert.equal(s.status, 'idle');
  s.turnStarted();
  s.result(aborted);
  assert.equal(s.status, 'stopped');
  s.turnStarted();
  s.result(apiError);
  assert.equal(s.status, 'failed');
  assert.deepEqual(seen, ['busy', 'idle', 'busy', 'stopped', 'busy', 'failed']);
});

test('status: at changes only with the status', () => {
  const { s } = tracker();
  s.turnStarted();
  const at = s.at;
  s.turnStarted();
  s.stateChanged('running');
  assert.equal(s.at, at);
});
