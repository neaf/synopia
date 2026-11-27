import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStatus, transcriptStatus, outcomeOf, restored, sessionState, badgeOf, BadgeCounter, quitSummary, blockedLast, blockedSubagent } from '../src/status.ts';
import type { StatusEntry, StateFacts, Status, StatusDetail } from '../src/status.ts';
import { Transcripts } from '../src/transcripts.ts';
import { Publisher } from '../src/publisher.ts';
import type { Client } from '../src/server.ts';
import type { Item } from '../src/transcript.ts';

function tracker(init: StatusEntry | null = null) {
  let t = 1000;
  const seen: string[] = [];
  const s = new SessionStatus(init, (e) => seen.push(e.status), () => (t += 1000));
  return { s, seen };
}

const ok = { subtype: 'success', is_error: false, terminal_reason: 'completed' };
const aborted = { subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' };
const apiError = { subtype: 'error_during_execution', is_error: true, terminal_reason: 'api_error' };

test('status: working from the state flag, your turn at a normal result; idle changes nothing', () => {
  const { s, seen } = tracker();
  s.stateChanged('running');
  assert.equal(s.status, 'busy');
  s.result(ok);
  assert.equal(s.status, 'idle', 'the result ends the main turn, with the flag too');
  s.stateChanged('idle');
  assert.equal(s.status, 'idle');
  assert.deepEqual(seen, ['busy', 'idle']);
});

// docs/Agent SDK.md, "Session state and background tasks": with a background task running the CLI sends
// no idle after the main turn's result, only once the task and the turn its notification starts ended.
test('status: a background task keeps the state running past the result: still your turn', () => {
  const { s, seen } = tracker();
  s.stateChanged('running');
  s.turnStarted(); // system/init
  s.result(ok);
  assert.equal(s.status, 'idle', 'the main turn is over while the background subagent runs');
  assert.equal(s.working, false, 'nothing to interrupt');
  s.stateChanged('running');
  s.stateChanged('requires_action');
  assert.equal(s.status, 'idle', 'a state event of the same run opens no turn');
  s.turnStarted(); // the task's notification starts a turn: system/init
  assert.equal(s.status, 'busy');
  s.result(ok);
  assert.equal(s.status, 'idle');
  s.stateChanged('idle');
  s.stateChanged('running');
  assert.equal(s.status, 'busy', 'after idle, running is the next turn');
  assert.deepEqual(seen, ['busy', 'idle', 'busy', 'idle', 'busy']);
});

test('status: a result with your messages still queued keeps working until their turn ends', () => {
  const { s } = tracker();
  s.stateChanged('running');
  s.turnStarted();
  s.result({ ...ok, queued: 1 });
  assert.equal(s.status, 'busy', 'one more turn of yours follows');
  s.turnStarted();
  s.result({ ...ok, queued: 0 });
  assert.equal(s.status, 'idle');
  const n = tracker().s;
  n.turnStarted();
  n.result({ ...ok, queued: 1 });
  assert.equal(n.status, 'idle', 'without the flag no idle would end it: the result does');
});

test('status: a turn our process starts is working', () => {
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

test('status: an authentication retry is signed out, by its error, its HTTP status, or its sentence as the fallback', () => {
  const bedrock = { type: 'system', subtype: 'api_retry', attempt: 4, max_retries: 10, retry_delay_ms: 3000, error_status: 403, error: 'unknown' };
  const { s, msg } = clocked();
  s.stateChanged('running');
  msg(bedrock);
  assert.equal(s.status, 'signedout', 'HTTP 403');
  s.setRunning({ agents: 0, turn: false, lastAt: 0, apiError: { text: 'The security token included in the request is expired', status: 403, credential: false } }, false);
  assert.equal(s.detail.error, 'The security token included in the request is expired', "the CLI's sentence");
  const b = clocked();
  b.s.stateChanged('running');
  b.msg({ ...bedrock, error_status: null });
  assert.equal(b.s.status, 'retrying', 'an unknown error with no status');
  b.s.setRunning({ agents: 0, turn: false, lastAt: 0, apiError: { text: 'The security token included in the request is expired', status: null, credential: false } }, false);
  assert.equal(b.s.status, 'signedout', 'the sentence decides when the fields say nothing');
  const c = clocked();
  c.s.stateChanged('running');
  c.msg({ ...bedrock, error_status: null, error: 'cloud_credential_error' });
  assert.equal(c.s.status, 'signedout', 'the documented error (live run AR-1)');
  assert.equal(c.s.detail.error, "The model's credentials failed");
  const d = clocked();
  d.s.stateChanged('running');
  d.msg({ ...bedrock, error_status: 529, error: 'overloaded' });
  d.s.setRunning({ agents: 0, turn: false, lastAt: 0, apiError: { text: 'Overloaded; the token budget expired', status: 529, credential: false } }, false);
  assert.equal(d.s.status, 'retrying', 'the sentence is no fallback once the fields say what failed');
});

test('status: refreshing while the folder\'s refresh command runs; its success clears signed out', () => {
  const { s, msg } = clocked();
  s.stateChanged('running');
  msg({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 3000, error_status: 401, error: 'authentication_failed' });
  assert.equal(s.signedOutNow, true);
  s.setRefreshing(true);
  assert.equal(s.status, 'refreshing');
  s.setRefreshing(false);
  assert.equal(s.status, 'signedout', 'it failed');
  s.setRefreshing(true);
  s.setRefreshing(false);
  s.credentialsRefreshed();
  assert.equal(s.status, 'retrying', 'back to the turn: the CLI retries with the new credentials');
  msg(reply);
  assert.equal(s.status, 'busy');
});

test('status: retries that ran out fail the turn with its sentence', () => {
  const { s, msg } = clocked();
  s.stateChanged('running');
  msg({ type: 'system', subtype: 'api_retry', attempt: 10, max_retries: 10, retry_delay_ms: 3000, error_status: 503, error: 'server_error' });
  msg({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 503 Service Unavailable' });
  s.result({ subtype: 'success', is_error: true, text: 'API Error: 503 Service Unavailable' });
  s.stateChanged('idle');
  assert.equal(s.status, 'failed');
  assert.deepEqual(s.detail, { error: 'API Error: 503 Service Unavailable' });
  s.turnStarted();
  assert.deepEqual(s.detail, {}, 'a new turn drops it');
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

test('status: retrying on every retried request, with its attempt, countdown and sentence; cleared by the next reply', () => {
  const { s, seen, clock, msg } = clocked();
  s.stateChanged('running');
  msg(throttled);
  assert.equal(s.status, 'retrying');
  assert.deepEqual(seen.at(-1)?.detail, { retry: { attempt: 3, max: 10, at: clock.t + 38_000, text: 'Rate limited (HTTP 429)' } });
  msg({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 500, error: 'server_error' });
  assert.equal(s.status, 'retrying', 'a server error is retried too (2026-11-26)');
  assert.equal(s.detail.retry?.text, 'The API had a server error (HTTP 500)');
  s.setRunning({ agents: 0, turn: false, lastAt: 0, apiError: { text: 'Internal server error', status: 500, credential: false } }, false);
  assert.equal(s.detail.retry?.text, 'Internal server error', "the CLI's own sentence, from the transcript");
  msg({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 500, error_status: null, error: 'unknown' });
  s.setRunning({ agents: 0, turn: false, lastAt: 0 }, false);
  assert.equal(s.detail.retry?.text, 'The connection failed', 'no HTTP status, no sentence yet');
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

// R8.2, 2026-11-26: motion means the main turn runs; background work alone is your turn (the panel shows it).
test('status: running subagents or forks leave a finished turn your turn; needs you still wins', () => {
  const { s } = clocked();
  s.stateChanged('running');
  s.result(ok);
  s.setRunning({ agents: 2, turn: false, lastAt: 0 }, false);
  s.stateChanged('idle');
  assert.equal(s.status, 'idle', 'the main turn is over, two subagents run: your turn');
  assert.equal(s.working, false, 'no turn to interrupt');
  s.setPending(1);
  assert.equal(s.status, 'waiting', 'needs you still wins');
  s.setPending(0);
  s.setRunning({ agents: 0, turn: false, lastAt: 0 }, false);
  assert.equal(s.status, 'idle');
});

test('status: subagents of a session with no process leave its outcome; its transcript alone reads your turn', () => {
  const { s } = clocked({ status: 'failed', at: 5 });
  s.setRunning({ agents: 1, turn: false, lastAt: 0 }, false);
  assert.equal(s.status, 'failed');
  assert.equal(transcriptStatus({ agents: 1, turn: false, lastAt: 0 }), 'idle', 'a session no process of ours set reads its transcript: the main turn is over');
  assert.equal(transcriptStatus({ agents: 1, turn: true, lastAt: 0 }), 'busy');
});

test('status: a main turn another process runs is working; ours or none is not; needs you still wins', () => {
  const { s } = clocked({ status: 'stopped', at: 5 });
  const turn = { agents: 0, turn: true, lastAt: 9 };
  s.setRunning(turn, false);
  assert.equal(s.status, 'stopped', 'with our own process the open turn is ours, not counted');
  s.setRunning(turn, true);
  assert.equal(s.status, 'busy');
  assert.equal(s.working, false, 'nothing of ours to interrupt');
  s.setPending(1);
  assert.equal(s.status, 'waiting');
  s.setPending(0);
  s.setRunning({ ...turn, turn: false }, true);
  assert.equal(s.status, 'idle', 'the old stopped is history once another process ran a turn');
  assert.equal(transcriptStatus(turn), 'busy');
});

test('status: a question another process asks is needs you over working, aged from its tool_use; its result clears it', () => {
  const { s, seen, clock } = clocked({ status: 'idle', at: 5 });
  const ask = { kind: 'question' as const, toolUseId: 'toolu_q1', agentId: null, since: clock.t - 120_000 };
  const asking = { agents: 0, turn: true, lastAt: clock.t, ask };
  s.setRunning(asking, false);
  assert.notEqual(s.status, 'waiting', 'our own process left it (or drives it): no card of ours waits, "Not answered"');
  s.setRunning(asking, true);
  assert.equal(s.status, 'waiting', 'the open turn would say working; the question wins');
  assert.equal(seen.at(-1)?.at, clock.t - 120_000, 'its age counts from the tool_use');
  clock.t += 60_000;
  s.setRunning({ ...asking, ask: { ...ask, toolUseId: 'toolu_q2', since: clock.t } }, true);
  assert.equal(seen.at(-1)?.at, clock.t, 'a new question counts from its own tool_use');
  s.setRunning({ ...asking, ask: null }, true);
  assert.equal(s.status, 'busy', 'answered there: the turn goes on');
  s.setRunning({ agents: 1, turn: false, lastAt: clock.t, ask: { ...ask, kind: 'plan', agentId: 'ag1' } }, true);
  assert.equal(s.status, 'waiting', "a subagent's plan too");
  assert.equal(transcriptStatus(asking), 'waiting', 'a session no process of ours set reads it from its transcript');
  assert.equal(transcriptStatus({ ...asking, ask: null }), 'busy');
});

// ---------- sessionState: what the page shows ----------
const facts = (f: Partial<StateFacts> = {}): StateFacts => ({ pending: [], ask: null, interrupted: false, blocked: false, review: 0, driven: true, ...f });
const show = (status: Status, f: Partial<StateFacts> = {}, detail: StatusDetail = {}) => {
  const st = sessionState({ status, at: 7, detail }, facts(f));
  return [st.light, st.tone, st.word, st.mark];
};

test('state: each status has its light, tone, word and mark (R8.2)', () => {
  assert.deepEqual(show('busy'), ['green', 'green', 'Working', 'work']);
  assert.deepEqual(show('busy', {}, { queued: 2 }), ['green', 'green', 'Working', 'queued']);
  assert.deepEqual(show('compacting'), ['green', 'green', 'Compacting', 'compact']);
  assert.deepEqual(show('retrying'), ['green', 'amber', 'Retrying', 'ratelimit']);
  assert.deepEqual(show('retrying', {}, { retry: { attempt: 4, max: 10, at: 0, text: 'x' } }), ['green', 'amber', 'Retrying, attempt 4 of 10', 'ratelimit']);
  assert.deepEqual(show('stale'), ['green', 'grey', 'No updates', 'stale']);
  assert.deepEqual(show('signedout'), ['red', 'red', 'Needs you, sign-in expired', 'pause']);
  assert.deepEqual(show('refreshing'), ['green', 'green', 'Refreshing credentials…', 'work']);
  assert.deepEqual(show('idle'), ['amber', 'amber', 'Your turn', 'stopped']);
  assert.deepEqual(show('stopped'), ['amber', 'amber', 'Stopped', 'stopped']);
  assert.deepEqual(show('failed'), ['amber', 'amber', 'Failed', 'failed']);
  assert.deepEqual(show('waiting'), ['red', 'red', 'Needs you', 'pause']);
  const st = sessionState({ status: 'idle', at: 7, detail: { terminal: 9 } }, facts({ driven: false }));
  assert.deepEqual([st.status, st.since, st.detail, st.driven], ['idle', 7, { terminal: 9 }, false]);
});

test('state: needs you wins, with what it waits on (R6.1)', () => {
  assert.deepEqual(show('signedout', { pending: ['permission'] }), ['red', 'red', 'Needs you', 'pause'], 'a request on a signed-out session');
  assert.deepEqual(show('busy', { pending: ['permission'] }), ['red', 'red', 'Needs you', 'pause']);
  const need = (status: Status, f: Partial<StateFacts>) => sessionState({ status, at: 0 }, facts(f)).needsYou;
  assert.equal(need('waiting', { pending: ['plan', 'question'] }), 'plan', 'the oldest request');
  assert.equal(need('waiting', { ask: { kind: 'question' } }), 'question', 'another process asks (R6.8)');
  assert.equal(need('waiting', {}), 'permission');
  assert.equal(need('busy', { ask: { kind: 'plan' } }), null, 'an ask is passed only while it is why the session waits');
});

test('state: stopped by you is the stop marker on your turn, not a turned-down tool', () => {
  assert.deepEqual(show('idle', { interrupted: true }), ['amber', 'amber', 'Stopped', 'stopped']);
  assert.equal(sessionState({ status: 'idle', at: 0 }, facts({ interrupted: true })).stopped, true);
  assert.equal(sessionState({ status: 'stopped', at: 0 }, facts()).stopped, true);
  assert.equal(sessionState({ status: 'idle', at: 0 }, facts()).stopped, false);
  assert.deepEqual(show('failed', { interrupted: true }), ['amber', 'amber', 'Failed', 'failed'], 'a failed turn says so');
  assert.deepEqual(show('busy', { interrupted: true }), ['green', 'green', 'Working', 'work'], 'a new turn runs');
  assert.deepEqual(show('signedout', { interrupted: true }), ['red', 'red', 'Needs you, sign-in expired', 'pause']);
});

test('state: your turn after a blocked step is needs you, blocked (R8.2)', () => {
  assert.deepEqual(show('idle', { blocked: true }), ['red', 'red', 'Needs you, blocked', 'pause']);
  assert.equal(sessionState({ status: 'idle', at: 0 }, facts({ blocked: true })).needsYou, 'blocked');
  assert.equal(badgeOf(sessionState({ status: 'idle', at: 0 }, facts({ blocked: true }))), 1);
  assert.deepEqual(show('busy', { blocked: true }), ['green', 'green', 'Working', 'work'], 'while the turn runs');
  assert.deepEqual(show('failed', { blocked: true }), ['amber', 'amber', 'Failed', 'failed']);
  assert.deepEqual(show('idle', { blocked: true, interrupted: true }), ['amber', 'amber', 'Stopped', 'stopped'], 'you stopped it');
  assert.deepEqual(show('waiting', { blocked: true, pending: ['question'] }), ['red', 'red', 'Needs you', 'pause'], 'a card says what it waits on');
});

test('blockedLast: a denied step in the latest turn, not retried, blocks it; your next message clears it', () => {
  let n = 0;
  const you = (extra: Partial<Item> = {}): Item => ({ id: `y${n++}`, k: 'you', ts: null, text: 'go', ...extra });
  const step = (state: string, input = 'git push', name = 'Bash'): Item => ({ id: `s${n++}`, k: 'tool', ts: null, name, input, state });
  const claude: Item = { id: 'c', k: 'claude', ts: null, text: 'I need you to run it.' };
  assert.equal(blockedLast([you(), step('done', 'ls'), step('denied'), claude]), true);
  assert.equal(blockedLast([you(), step('denied'), step('done'), claude]), false, 'retried and ran');
  assert.equal(blockedLast([you(), step('denied'), step('done', 'git status'), claude]), true, 'another command ran');
  assert.equal(blockedLast([you(), step('denied'), claude, you()]), false, 'you wrote since');
  assert.equal(blockedLast([you(), step('denied'), claude, { id: 'b', k: 'bang', ts: null, cmd: 'git push' }]), false, 'you ran a command');
  assert.equal(blockedLast([you(), step('denied'), you({ turnedDown: true }), claude]), true, 'a turned-down marker is not your message');
  assert.equal(blockedLast([you(), step('failed'), claude]), false);
});

test('blockedSubagent: a subagent run that ended after a denied step it did not redo blocks; your message, a stop or a redo clears it', () => {
  let n = 0;
  const at = (s: number) => `2026-11-24T09:00:${String(s).padStart(2, '0')}.000Z`;
  const step = (s: number, state: string, input = 'npm run migrate'): Item => ({ id: `s${n++}`, k: 'tool', ts: at(s), name: 'Bash', input, state });
  const end = (s: number, stopped = false) => ({ at: Date.parse(at(s)), stopped });
  assert.equal(blockedSubagent([step(10, 'denied'), step(20, 'done', 'ls')], [end(30)], null), true);
  assert.equal(blockedSubagent([step(10, 'denied')], [], null), false, 'still in its first run: it may redo it');
  assert.equal(blockedSubagent([step(10, 'denied')], [end(30)], Date.parse(at(40))), false, 'you wrote since');
  assert.equal(blockedSubagent([step(10, 'denied')], [end(30, true)], null), false, 'that run was stopped');
  assert.equal(blockedSubagent([step(10, 'denied'), step(45, 'done')], [end(30)], null), false, 'resumed, it redid the step');
  assert.equal(blockedSubagent([step(10, 'denied'), step(45, 'running', 'ls')], [end(30)], null), true, 'resumed, the step not redone yet');
  assert.equal(blockedSubagent([step(10, 'failed')], [end(30)], null), false);
});

test('state: the badge share is needs you plus the deliverables to review (R2.6)', () => {
  const of = (status: Status, f: Partial<StateFacts> = {}) => badgeOf(sessionState({ status, at: 0 }, facts(f)));
  assert.deepEqual((['waiting', 'signedout', 'refreshing', 'stale', 'retrying', 'compacting', 'busy', 'failed', 'idle', 'stopped'] as Status[]).map((s) => of(s)), [1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(of('signedout', { pending: ['question'] }), 1);
  assert.equal(of('busy', { review: 2 }), 2);
  assert.equal(of('waiting', { review: 1 }), 2);
});

test('badge counter: the total moves as sessions change, and says so only when it moves', () => {
  const seen: number[] = [];
  const b = new BadgeCounter((n) => seen.push(n));
  b.set('a', 1);
  b.set('b', 2);
  b.set('a', 1);
  assert.equal(b.count, 3);
  b.drop('b');
  b.drop('b');
  b.set('c', 0);
  assert.equal(b.count, 1);
  b.set('a', 0);
  assert.deepEqual(seen, [1, 3, 1, 0]);
});

// ---------- the badge through the publisher: open sessions only, nothing rebuilt per read ----------
const CLAUDE = path.join(import.meta.dirname, 'fixtures', 'claude');
const IDLE = '11111111-0000-4000-8000-000000000001';
const ASKS = '22222222-0000-4000-8000-000000000002';
const AGENTS = '44444444-0000-4000-8000-000000000004';
const REVIEW = 'aaaa0004'; // "For review: Draft the demo release notes", finished in the fixture
const tick = () => new Promise((r) => setImmediate(r));

function badgeReading(claudeDir = CLAUDE, reviewed: Set<string> = new Set()) {
  const badge = new BadgeCounter();
  const transcripts = new Transcripts({ claudeDir, home: '/Users/fixture', pollMs: 0, watch: false });
  const publisher = new Publisher({ transcripts, clients: () => new Set<Client>(), home: '/Users/fixture', recheckMs: 0, badge, reviewed: (id) => reviewed.has(id) });
  return { badge, transcripts, publisher, reviewed };
}

test('badge: needs-you sessions and deliverables to review, open sessions only', async () => {
  // A question in a transcript whose file is 12 hours quiet is your turn (ASK_STALE_MS): the fixture's
  // records are older, so its file counts as just changed, whenever it was checked out.
  const now = new Date();
  fs.utimesSync(path.join(CLAUDE, 'projects', '-tmp-fixture', `${ASKS}.jsonl`), now, now);
  const { transcripts, publisher, badge, reviewed } = badgeReading();
  transcripts.open(IDLE);
  transcripts.open(ASKS);
  transcripts.open(AGENTS);
  await tick();
  // its transcript ends on a question with no answer and no process of ours set a status: another process asks (R6.8)
  assert.equal(badge.count, 2, 'the finished For review subagent and the question the transcript waits on');
  publisher.setStatus(ASKS, 'busy');
  assert.equal(badge.count, 1, 'our process says working: only the For review subagent');

  publisher.setPending(ASKS, { id: 'q1', kind: 'question', since: 1 });
  await tick();
  assert.equal(badge.count, 2, 'a pending request');
  publisher.setStatus(ASKS, 'waiting');
  assert.equal(badge.count, 2, 'one session counts once');
  publisher.setStatus(IDLE, 'waiting');
  assert.equal(badge.count, 3, 'the status waiting alone');

  reviewed.add(REVIEW);
  publisher.reviewed(REVIEW);
  assert.equal(badge.count, 2, 'marked reviewed drops it');
  assert.equal(publisher.meta(AGENTS)?.state.review, 0);

  transcripts.close(AGENTS);
  transcripts.close(ASKS);
  assert.equal(badge.count, 1, 'closed sessions are left out');
  transcripts.stop(); publisher.stop();
});

test('badge: a session whose turn runs in another process, with nothing pending, does not count', () => {
  const { transcripts, publisher, badge } = badgeReading(path.join(import.meta.dirname, 'fixtures', 'claude-states'));
  transcripts.open('f7f7f7f7-0000-4000-8000-000000000007');
  transcripts.poll();
  const st = publisher.meta('f7f7f7f7-0000-4000-8000-000000000007')!.state;
  assert.deepEqual([st.status, st.word, st.driven, st.detail.external], ['busy', 'Working', false, undefined]);
  assert.equal(badge.count, 0);
  transcripts.stop(); publisher.stop();
});

test('badge: a question or plan another process asks counts, with its ask for the page, until its result lands (R6.8)', () => {
  const src = path.join(import.meta.dirname, 'fixtures', 'claude-ext');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-ext-'));
  fs.cpSync(src, dir, { recursive: true });
  const { transcripts, publisher, badge } = badgeReading(dir);
  const Q = 'e1e1e1e1-0000-4000-8000-00000000000a', P = 'e2e2e2e2-0000-4000-8000-00000000000b';
  transcripts.open(Q);
  transcripts.open(P);
  transcripts.poll();
  const q = publisher.meta(Q);
  assert.deepEqual([q?.state.status, q?.state.needsYou, q?.state.word], ['waiting', 'question', 'Needs you'], 'needs you, though the turn runs by the transcript');
  assert.equal(q?.state.since, Date.parse('2026-11-24T09:00:40.000Z'), 'aged from the tool_use');
  assert.deepEqual([q?.ask?.kind, q?.ask?.qs?.length, q?.ask?.qs?.[1].multi], ['question', 2, true]);
  assert.deepEqual([publisher.meta(P)?.state.needsYou, publisher.meta(P)?.ask?.kind, publisher.meta(P)?.ask?.plan?.startsWith('## Move')], ['plan', 'plan', true]);
  assert.equal(badge.count, 2);
  publisher.setPending(P, { id: 'r1', kind: 'plan', since: 1 });
  publisher.setStatus(P, 'waiting');
  assert.equal(publisher.meta(P)?.ask, null, 'a request of ours is the card: no read-only one');
  const file = path.join(dir, 'projects', '-tmp-ext', `${Q}.jsonl`);
  // dated now: a turn quiet for STALE_MS reads as ended, so a fixed date fails once it is 15 minutes old
  fs.appendFileSync(file, JSON.stringify({ type: 'user', uuid: 'x1-u3', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_xask1', content: 'User has answered your questions: "Which release channel should the checklist target?"="Beta". You can now continue.' }] } }) + '\n');
  transcripts.poll();
  assert.deepEqual([publisher.meta(Q)?.state.status, publisher.meta(Q)?.ask], ['busy', null], 'answered there: the turn goes on');
  assert.equal(badge.count, 1);
  transcripts.stop(); publisher.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('quitSummary: counts per kind and the alert sentence, a kind it has no words for too', () => {
  assert.deepEqual(quitSummary({ running: [], background: [] }), { running: [], background: [], counts: {}, summary: '' });
  const bg = (...kinds: string[]) => kinds.map((kind) => ({ sid: 's', kind }));
  // `background` keeps the older daemons' list, so a shell of that time still asks
  assert.deepEqual(quitSummary({ running: ['a', 'b'], background: bg('shell') }),
    { running: ['a', 'b'], background: [{ sid: 's', kind: 'shell' }], counts: { shell: 1 }, summary: '2 sessions are working and 1 background shell will stop.' });
  assert.equal(quitSummary({ running: ['a'], background: [] }).summary, '1 session is working and will stop.');
  assert.equal(quitSummary({ running: [], background: bg('monitor', 'subagent', 'subagent', 'shell', 'shell') }).summary,
    '2 subagents, 2 background shells and 1 monitor will stop.');
  // a new kind: counted and named, so the confirm still shows
  const q = quitSummary({ running: [], background: bg('task') });
  assert.deepEqual(q.counts, { task: 1 });
  assert.equal(q.summary, '1 background task will stop.');
});
