// One status per session (plan section 8), from the SDK's events and the driver's own state,
// in the page's vocabulary:
//   busy       working: `session_state_changed: running`, or the driver started a turn
//   waiting    needs you: a pending canUseTool request, which wins over everything
//   idle       your turn: idle after a normal `result`, or the process isn't running
//   stopped    stopped by you: idle after a turn that ended by interrupt
//   failed     a `result` that is an error and not an interrupt, or the process failed
// The states of requirements R8.2 that come from one typed message each (sdk.d.ts):
//   signedout  signed out: an `assistant` message whose `error` is authentication_failed or
//              cloud_credential_error, a `system/api_retry` with one of those errors, or an
//              `auth_status` with an `error`. Clears when a turn starts (system/init or a send),
//              on a main-thread reply without an error (assistant or stream_event), or on an
//              `auth_status` that ends without one. Wins over everything but needs you.
//   stale      no updates: a turn runs, no card waits, and no SDK message of any kind came for
//              STALE_MS (plus the delay of a retry it announced). `keep_alive` is control traffic,
//              not an SDKMessage, so query() never yields it. Clears on the next message.
//   retrying   rate limited: `system/api_retry` with error `rate_limit` or HTTP 429 (Bedrock's
//              throttling). Clears on the next reply (assistant or stream_event), a `system/status`,
//              a retry for another error, or the turn's end.
//   compacting `system/status` with status `compacting`. Clears on a `system/status` with any
//              other status, a `system/compact_boundary`, or the turn's end.
// Background subagents and forks (requirements R8.2, 2026-11-23): with the main turn over, a
// session whose subagents or forks still run (the transcript's running rule) is working, not
// your turn; shells and monitors alone are not. When the last one finishes, the turn's outcome
// comes back, its age counted from then.
// A turn in another process (2026-11-23): with no process of Synopia's, a main turn the transcript
// shows running (Transcript.turnRunning: a tool_use without a result, or a turn opened by a prompt
// and not closed by turn_duration, stop_hook_summary or an interrupt marker, quiet for less than
// QUIET_MS) is working too. Sessions with no driver status use transcriptStatus().
// A card in another process (R6.8, 2026-11-24): with no process of Synopia's, a transcript whose
// thread (main or a running subagent's) ends on an AskUserQuestion or ExitPlanMode with no result
// (Transcript.pendingAsk) is needs you, over working; its age counts from the tool_use. It clears
// when the result lands, or once the transcript has been quiet for ASK_STALE_MS (your turn then).
// An ask our own process left behind (a crash) is not one: "Not answered".
// Plus `detail.queued` while working: messages pushed during a turn whose uuid no reply has listed
// yet in `user_message_uuid(s)`, trimmed to a result's `queued_turn_count`, emptied at the end.
// Without CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS (no `session_state_changed` seen yet), a turn
// runs from the send to its `result`. With it, `idle` is the authoritative end of a turn.
// `at` is the backend's clock when the status last changed (for stale: when the last message
// came); the caller stores it.
import type { SDKAssistantMessageError, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { PendingAsk } from './transcript.ts';

export type Status = 'busy' | 'idle' | 'waiting' | 'stopped' | 'failed' | 'signedout' | 'stale' | 'retrying' | 'compacting';
type Outcome = 'idle' | 'stopped' | 'failed';
export type ResultLike = { subtype: string; is_error?: boolean; terminal_reason?: string };
// queued: messages waiting for the running turn. retry: the attempt, its cap and when it goes (ms).
export type StatusDetail = { queued?: number; retry?: { attempt: number; max: number; at: number } };
export type StatusEntry = { status: Status; at: number; detail?: StatusDetail };

// 15 min: longer than the Bash tool's longest timeout (10 min), the longest a foreground tool
// is expected to run without a message, so a slow tool doesn't read as stale.
export const STALE_MS = 15 * 60_000;
// 30 min: an open turn by the transcript alone, with no tool waiting for its result, that hasn't
// changed for this long is your turn (its process may have crashed).
export const QUIET_MS = 30 * 60_000;
// 12 h: a question or plan in another process's transcript whose files haven't changed for this long
// is your turn, not needs you: the process that asked is long gone (Transcript.pendingAsk).
export const ASK_STALE_MS = 12 * 60 * 60_000;
// What runs by the transcript: subagents and forks, the main turn, and when it last changed (ms),
// and the question or plan it waits on (null or absent: none).
export type Running = { agents: number; turn: boolean; lastAt: number; ask?: PendingAsk | null };
export const AUTH_ERRORS: readonly SDKAssistantMessageError[] = ['authentication_failed', 'cloud_credential_error'];
export type Timer = (fn: () => void, ms: number) => () => void;
const realTimer: Timer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};
type Loose = { type: string; subtype?: string; [k: string]: unknown };

// The status a session has when its process isn't running (after a restart): a turn that was
// working or waiting when Synopia quit is your turn now. Signed out stays until the next turn.
export function restored(stored: { status?: unknown; at?: unknown } | undefined): StatusEntry | null {
  if (!stored || typeof stored.at !== 'number') return null;
  const st = stored.status;
  if (st === 'stopped' || st === 'failed' || st === 'idle' || st === 'signedout') return { status: st, at: stored.at };
  return { status: 'idle', at: stored.at };
}

export function outcomeOf(r: ResultLike): Outcome {
  if (r.terminal_reason === 'aborted_streaming' || r.terminal_reason === 'aborted_tools') return 'stopped';
  if (r.subtype !== 'success' || r.is_error) return 'failed';
  return 'idle';
}

export class SessionStatus {
  status: Status;
  at: number;
  detail: StatusDetail = {};
  private onChange: (e: StatusEntry) => void;
  private now: () => number;
  private running = false;
  private flag = false; // a session_state_changed event was seen
  private outcome: Outcome;
  private pending = 0;
  private agents = 0; // background subagents and forks running, from the transcript
  private external = false; // a main turn running in another process, from the transcript
  private ask: PendingAsk | null = null; // a question or plan waiting in another process, from the transcript
  private stopping = false; // an interrupt was sent and its result hasn't come yet
  private signedOut: boolean;
  private compacting = false;
  private retry: { attempt: number; max: number; at: number } | null = null;
  private queued: string[] = []; // uuids pushed during a turn, not yet listed by a reply
  private last: number; // when the last SDK message came (or the turn started, or a card was answered)
  private staleMs: number;
  private timer: Timer;
  private cancelStale: (() => void) | null = null;
  private resulted = false; // the running turn's result came (with the state flag, idle follows it)

  constructor(init: StatusEntry | null, onChange: (e: StatusEntry) => void, now: () => number = Date.now, opts: { staleMs?: number; timer?: Timer } = {}) {
    this.onChange = onChange;
    this.now = now;
    this.staleMs = opts.staleMs ?? STALE_MS;
    this.timer = opts.timer ?? realTimer;
    this.status = init?.status ?? 'idle';
    this.at = init?.at ?? now();
    this.last = this.at;
    this.signedOut = this.status === 'signedout';
    this.outcome = this.status === 'stopped' || this.status === 'failed' ? this.status : 'idle';
  }

  get working(): boolean {
    return this.running;
  }

  // The driver pushed a message, or a turn began (system/init comes at the start of each turn).
  turnStarted(): void {
    this.running = true;
    this.resulted = false;
    this.signedOut = false;
    this.last = this.now();
    this.update();
  }

  // The driver pushed a message: during a turn it is queued until a reply lists its uuid.
  pushed(uuid: string): void {
    if (!this.running) return;
    this.queued.push(uuid);
    this.update();
  }

  // Every message the process yields, before the caller's own handling (init, state, result).
  observe(msg: SDKMessage): void {
    const m = msg as unknown as Loose;
    this.last = this.now();
    const seen = uuidsOf(m);
    if (seen.length) this.queued = this.queued.filter((q) => !seen.includes(q));
    if (m.type === 'assistant' || m.type === 'stream_event') {
      const err = m.error as SDKAssistantMessageError | undefined;
      if (err && AUTH_ERRORS.includes(err)) this.signedOut = true;
      else if (m.parent_tool_use_id == null) this.signedOut = false;
      this.retry = null;
    } else if (m.type === 'system' && m.subtype === 'api_retry') {
      const err = m.error as SDKAssistantMessageError;
      if (AUTH_ERRORS.includes(err)) this.signedOut = true;
      this.retry = err === 'rate_limit' || m.error_status === 429
        ? { attempt: num(m.attempt), max: num(m.max_retries), at: this.last + num(m.retry_delay_ms) }
        : null;
    } else if (m.type === 'system' && m.subtype === 'status') {
      this.compacting = m.status === 'compacting';
      this.retry = null;
    } else if (m.type === 'system' && m.subtype === 'compact_boundary') {
      this.compacting = false;
    } else if (m.type === 'auth_status') {
      if (typeof m.error === 'string' && m.error) this.signedOut = true;
      else if (m.isAuthenticating === false) this.signedOut = false;
    } else if (m.type === 'result') {
      const n = m.queued_turn_count;
      if (typeof n === 'number' && n >= 0 && this.queued.length > n) this.queued = this.queued.slice(this.queued.length - n);
      this.compacting = false;
      this.retry = null;
    }
    this.update();
  }

  stateChanged(state: string): void {
    this.flag = true;
    if (state === 'running' || state === 'requires_action') {
      if (!this.running) this.resulted = false;
      this.running = true;
    } else if (state === 'idle') {
      this.turnOver();
      this.stopping = false; // an interrupt after the turn's result had nothing to stop
    }
    this.update();
  }

  // You interrupted the turn: the result that ends it is "stopped by you", whatever its subtype.
  // Not once the turn's result came (between it and idle): that turn is over, the next isn't stopped.
  interrupted(): void {
    if (this.resulted) return;
    this.stopping = true;
  }

  // The interrupt never reached the CLI: the turn's result is its own.
  interruptFailed(): void {
    this.stopping = false;
  }

  result(r: ResultLike): void {
    this.outcome = this.stopping ? 'stopped' : outcomeOf(r);
    this.stopping = false;
    this.resulted = true;
    if (!this.flag) this.turnOver();
    this.update();
  }

  // What runs by the transcript changed. `external`: the caller has no process for the session, so
  // a running main turn there is another process's. One starting makes the old outcome history.
  setRunning(r: Running, external: boolean): void {
    this.agents = r.agents;
    const turn = external && r.turn;
    if (turn && !this.external) {
      this.outcome = 'idle';
      this.signedOut = false;
    }
    this.external = turn;
    this.ask = external && r.ask ? r.ask : null;
    this.update();
  }

  setPending(n: number): void {
    this.pending = n;
    this.last = this.now(); // waiting on you is no silence
    this.update();
  }

  // The process ended: on purpose (idle timeout, close, quit) or not (failed).
  processEnded(failed: boolean): void {
    this.turnOver();
    this.pending = 0;
    if (failed) this.outcome = 'failed';
    this.update();
  }

  // A start that never happened (the folder is gone).
  failed(): void {
    this.processEnded(true);
  }

  private turnOver(): void {
    this.running = false;
    this.compacting = false;
    this.retry = null;
    this.queued = [];
  }

  // Needs you wins; then signed out; then, while a turn runs: no updates, rate limited,
  // compacting, working. After the turn: working while subagents or forks run, else the outcome.
  private update(): void {
    const now = this.now();
    const silentFor = this.staleMs + (this.retry ? Math.max(0, this.retry.at - this.last) : 0);
    const stale = this.running && this.pending === 0 && now - this.last >= silentFor;
    const next: Status = this.pending > 0 || this.ask ? 'waiting'
      : this.signedOut ? 'signedout'
        : !this.running ? (this.agents > 0 || this.external ? 'busy' : this.outcome)
          : stale ? 'stale' : this.retry ? 'retrying' : this.compacting ? 'compacting' : 'busy';
    const detail: StatusDetail = {};
    if (next === 'busy' && this.queued.length) detail.queued = this.queued.length;
    if (next === 'retrying' && this.retry) detail.retry = { ...this.retry };
    this.armStale(next, silentFor - (now - this.last));
    // another process's card: its age counts from the tool_use, a new card's from its own
    const askAt = next === 'waiting' && this.pending === 0 && this.ask ? this.ask.since || now : null;
    if (next === this.status && sameDetail(detail, this.detail) && (askAt === null || askAt === this.at)) return;
    if (askAt !== null) this.at = askAt;
    else if (next !== this.status) this.at = next === 'stale' ? this.last : now;
    this.status = next;
    this.detail = detail;
    this.onChange({ status: next, at: this.at, detail });
  }

  // One timer while a turn runs and messages may stop: it checks again when the silence would
  // reach the threshold; a message that came meanwhile only moves the next check on.
  private armStale(next: Status, left: number): void {
    const watch = this.running && this.pending === 0 && next !== 'stale' && next !== 'signedout';
    if (!watch) {
      this.cancelStale?.();
      this.cancelStale = null;
      return;
    }
    if (this.cancelStale) return;
    this.cancelStale = this.timer(() => {
      this.cancelStale = null;
      this.update();
    }, Math.max(1000, left));
  }
}

// The status of a session no driver set (the transcript alone): working while its subagents or
// forks or its main turn run, else your turn. A question or plan waiting there is needs you.
export function transcriptStatus(r: Running): Status {
  return r.ask ? 'waiting' : r.agents > 0 || r.turn ? 'busy' : 'idle';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function uuidsOf(m: Loose): string[] {
  const out = Array.isArray(m.user_message_uuids) ? m.user_message_uuids.filter((u): u is string => typeof u === 'string') : [];
  if (typeof m.user_message_uuid === 'string') out.push(m.user_message_uuid);
  return out;
}

function sameDetail(a: StatusDetail, b: StatusDetail): boolean {
  return a.queued === b.queued && a.retry?.attempt === b.retry?.attempt && a.retry?.max === b.retry?.max && a.retry?.at === b.retry?.at;
}
