import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStatus, agentsStatus, outcomeOf, restored } from '../src/status.ts';
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

// The states of R8.2 from typed messages (status.ts). A clock the test moves, and a fake timer.
function clocked(init: StatusEntry | null = null) {
  const clock = { t: 1_000_000 };
  const timers: { fn: () => void; live: boolean }[] = [];
  const seen: StatusEntry[] = [];
  const s = new SessionStatus(init, (e) => seen.push(e), () => clock.t, {
    staleMs: 60_000,
    timer: (fn) => {
      const x = { fn, live: true };
      timers.push(x);
      return () => { x.live = false; };
    },
  });
  const fire = () => { for (const x of timers.splice(0)) if (x.live) x.fn(); };
  const msg = (m: object) => s.observe(m as never);
  return { s, seen, clock, fire, msg };
}
const authError = { type: 'assistant', parent_tool_use_id: null, error: 'cloud_credential_error', message: { content: [] } };
const reply = { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } };
const throttled = { type: 'system', subtype: 'api_retry', attempt: 3, max_retries: 10, retry_delay_ms: 38_000, error_status: 429, error: 'rate_limit' };

test('status: signed out on a credential error, over failed; cleared by the next turn or a good reply', () => {
  const { s, msg } = clocked();
  s.stateChanged('running');
  msg(authError);
  assert.equal(s.status, 'signedout', 'shows while the turn ends');
  s.result(apiError);
  s.stateChanged('idle');
  assert.equal(s.status, 'signedout', 'wins over failed');
  s.turnStarted();
  assert.equal(s.status, 'busy', 'a new turn tries again');
  msg({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 1000, error_status: 401, error: 'authentication_failed' });
  assert.equal(s.status, 'signedout');
  msg({ ...reply, parent_tool_use_id: 'toolu_sub' });
  assert.equal(s.status, 'signedout', "a subagent's reply doesn't clear it");
  msg(reply);
  assert.equal(s.status, 'busy', 'the request got through');
  msg({ type: 'auth_status', isAuthenticating: false, output: [], error: 'expired' });
  assert.equal(s.status, 'signedout');
  msg({ type: 'auth_status', isAuthenticating: false, output: [] });
  assert.equal(s.status, 'busy');
});

test('status: needs you wins over signed out and every turn state', () => {
  const { s, msg } = clocked();
  s.stateChanged('running');
  msg(authError);
  s.setPending(1);
  assert.equal(s.status, 'waiting');
  s.setPending(0);
  assert.equal(s.status, 'signedout');
  const b = clocked();
  b.s.stateChanged('running');
  b.msg(throttled);
  b.s.setPending(1);
  assert.equal(b.s.status, 'waiting');
  b.s.setPending(0);
  assert.equal(b.s.status, 'retrying');
});

test('status: a restart keeps signed out, and the next turn clears it', () => {
  assert.deepEqual(restored({ status: 'signedout', at: 9 }), { status: 'signedout', at: 9 });
  assert.deepEqual(restored({ status: 'compacting', at: 9 }), { status: 'idle', at: 9 });
  const { s } = clocked({ status: 'signedout', at: 9 });
  assert.equal(s.status, 'signedout');
  s.turnStarted();
  assert.equal(s.status, 'busy');
});

test('status: rate limited on a throttled retry, with its countdown; cleared by the next reply', () => {
  const { s, seen, clock, msg } = clocked();
  s.stateChanged('running');
  msg(throttled);
  assert.equal(s.status, 'retrying');
  assert.deepEqual(seen.at(-1)?.detail, { retry: { attempt: 3, max: 10, at: clock.t + 38_000 } });
  msg({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 500, error: 'server_error' });
  assert.equal(s.status, 'busy', 'a server error retry is not rate limited');
  msg(throttled);
  msg({ type: 'assistant', parent_tool_use_id: null, message: { content: [] } });
  assert.equal(s.status, 'busy');
  msg(throttled);
  s.result(apiError);
  s.stateChanged('idle');
  assert.equal(s.status, 'failed', 'the turn ended on it');
});

test('status: compacting from system/status, cleared by the next status, the boundary or the turn end', () => {
  const { s, msg } = clocked();
  s.stateChanged('running');
  msg({ type: 'system', subtype: 'status', status: 'compacting' });
  assert.equal(s.status, 'compacting');
  msg({ type: 'system', subtype: 'status', status: null, compact_result: 'success' });
  assert.equal(s.status, 'busy');
  msg({ type: 'system', subtype: 'status', status: 'compacting' });
  msg({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 1 } });
  assert.equal(s.status, 'busy');
  msg({ type: 'system', subtype: 'status', status: 'compacting' });
  msg(throttled);
  assert.equal(s.status, 'retrying', 'a throttled request while compacting reads rate limited');
  s.stateChanged('idle');
  assert.equal(s.status, 'idle');
});

test('status: no updates after the threshold of silence in a running turn; any message clears it', () => {
  const { s, seen, clock, fire, msg } = clocked();
  s.stateChanged('running');
  const lastAt = clock.t;
  clock.t += 59_000;
  fire();
  assert.equal(s.status, 'busy', 'under the threshold');
  clock.t += 2_000;
  fire();
  assert.equal(s.status, 'stale');
  assert.equal(seen.at(-1)?.at, lastAt, 'its age counts from the last message');
  msg({ type: 'tool_progress', tool_use_id: 't', tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: 70 });
  assert.equal(s.status, 'busy');
  s.setPending(1);
  clock.t += 120_000;
  fire();
  assert.equal(s.status, 'waiting', 'a card waiting on you is no silence');
  s.setPending(0);
  s.stateChanged('idle');
  clock.t += 120_000;
  fire();
  assert.equal(s.status, 'idle', 'between turns silence is normal');
});

test('status: no updates waits out an announced retry delay first', () => {
  const { s, clock, fire, msg } = clocked();
  s.stateChanged('running');
  msg({ ...throttled, retry_delay_ms: 30_000 });
  clock.t += 70_000;
  fire();
  assert.equal(s.status, 'retrying');
  clock.t += 25_000;
  fire();
  assert.equal(s.status, 'stale');
});

test('status: a message sent during a turn is queued until a reply lists its uuid', () => {
  const { s, seen, msg } = clocked();
  s.pushed('u-first');
  s.turnStarted();
  assert.equal(seen.at(-1)?.detail?.queued, undefined, 'the message that starts a turn is not queued');
  s.pushed('u-2');
  s.pushed('u-3');
  assert.deepEqual(seen.at(-1)?.detail, { queued: 2 });
  msg({ ...reply, user_message_uuid: 'u-2', user_message_uuids: ['u-2'] });
  assert.deepEqual(s.detail, { queued: 1 });
  msg({ type: 'result', subtype: 'success', is_error: false, queued_turn_count: 0 });
  assert.deepEqual(s.detail, {}, 'the result says none is left');
  s.pushed('u-4');
  s.setPending(1);
  assert.deepEqual(s.detail, {}, 'needs you shows no queued count');
  s.setPending(0);
  assert.deepEqual(s.detail, { queued: 1 });
  s.stateChanged('idle');
  assert.deepEqual(s.detail, {}, 'the turn end empties it');
});

test('status: running subagents or forks keep a finished turn working; your turn comes back, aged from then', () => {
  const { s, seen, clock } = clocked();
  s.stateChanged('running');
  s.result(ok);
  s.setAgents(2);
  s.stateChanged('idle');
  assert.equal(s.status, 'busy', 'the main turn is over, two subagents run');
  assert.equal(s.working, false, 'no turn to interrupt');
  s.setPending(1);
  assert.equal(s.status, 'waiting', 'needs you still wins');
  s.setPending(0);
  s.setAgents(1);
  assert.equal(s.status, 'busy');
  clock.t += 300_000;
  s.setAgents(0);
  assert.equal(s.status, 'idle');
  assert.equal(seen.at(-1)?.at, clock.t, 'aged from when the last one finished');
});

test('status: subagents of a session with no process make it working; a failed turn comes back as failed', () => {
  const { s } = clocked({ status: 'failed', at: 5 });
  s.setAgents(1);
  assert.equal(s.status, 'busy');
  s.setAgents(0);
  assert.equal(s.status, 'failed');
  assert.equal(agentsStatus(1), 'busy', 'a session no driver set reads its transcript');
  assert.equal(agentsStatus(0), 'idle');
});
