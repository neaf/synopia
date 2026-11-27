// One status per session (FR-STAT-02), from the SDK's events and the session's own state,
// in the page's vocabulary:
//   busy       working: `session_state_changed: running`, or the session started a turn
//   waiting    needs you: a pending canUseTool request, which wins over everything
//   idle       your turn: idle after a normal `result`, or the process isn't running
//   stopped    stopped by you: idle after a turn that ended by interrupt
//   failed     a `result` that is an error and not an interrupt, or the process failed
// The states of requirements R8.2 that come from one typed message each (sdk.d.ts):
//   signedout  needs you, sign-in expired (2026-11-26): an `assistant` message whose `error` is
//              authentication_failed or cloud_credential_error, a `system/api_retry` that is an
//              authentication failure (isAuthFailure), or an `auth_status` with an `error`. Clears when
//              a turn starts (system/init or a send), on a main-thread reply without an error
//              (assistant or stream_event), on an `auth_status` that ends without one, or when the
//              folder's credential refresh command succeeded (creds.ts). Wins over everything but a card.
//   refreshing signed out while the folder's credential refresh command runs (creds.ts setRefreshing).
//   stale      no updates: a turn runs, no card waits, and no SDK message of any kind came for
//              STALE_MS (plus the delay of a retry it announced). `keep_alive` is control traffic,
//              not an SDKMessage, so query() never yields it. Clears on the next message.
//   retrying   `system/api_retry`, whatever its error (2026-11-26): its attempt, cap and delay, and the
//              CLI's sentence for it (the transcript's system/api_error, Running.apiError), else one worded
//              from the documented `error` and `error_status` (retrySentence). Clears on the next reply
//              (assistant or stream_event), a `system/status`, or the turn's end.
//   compacting `system/status` with status `compacting`. Clears on a `system/status` with any
//              other status, a `system/compact_boundary`, or the turn's end.
// Background work (requirements R8.2, 2026-11-26; was working while subagents ran, 2026-11-23): with the
// main turn over the session is your turn, whatever still runs in the background (subagents, forks,
// shells, monitors). Working, with its moving mark, means the main turn itself runs: motion means an
// agent is doing something. The panel's Main conversation card and the sidebar's sub-lines show what runs.
// A turn in another process (2026-11-23): with no process of Synopia's, a main turn the transcript
// shows running (Transcript.turnRunning: a tool_use without a result, or a turn opened by a prompt
// and not closed by turn_duration, stop_hook_summary or an interrupt marker, quiet for less than
// QUIET_MS) is working too. Sessions with no status of our process use transcriptStatus().
// A permission request nobody answered (claude-jsonl.ts `unanswered`: the process that asked went
// away) closes the turn in the transcript, so it is your turn at once (2026-11-27).
// No process at all (2026-11-27): once the pid files are read (cli-terminals.ts `free`: no live
// Claude Code outside Synopia has the session open) and no process of ours runs it, session.ts marks
// the transcript's process ended as of its last record (Transcript.processEnded). A tool cut off
// mid-way, the open turn, an ask, subagents, shells and monitors then read ended, so the session is
// your turn at once, not working for QUIET_MS or for ever. Before the first scan nothing is known and
// the rules above stand.
// A card in another process (R6.8, 2026-11-24): with no process of Synopia's, a transcript whose
// thread (main or a running subagent's) ends on an AskUserQuestion or ExitPlanMode with no result
// (Transcript.pendingAsk) is needs you, over working; its age counts from the tool_use. It clears
// when the result lands, or once the transcript has been quiet for ASK_STALE_MS (your turn then).
// An ask our own process left behind (a crash) is not one: "Not answered".
// A terminal (R3.2, 2026-11-24): `detail.terminal` is the pid of the terminal's Claude Code that holds
// the session (cli-terminals.ts), whatever the status, and `detail.takeover` says a message of yours waits
// for it (`waiting`: it runs a turn or waits on you) or is taking it back (`taking`).
// Plus `detail.queued` while working: messages pushed during a turn whose uuid no reply has listed
// yet in `user_message_uuid(s)`, trimmed to a result's `queued_turn_count`, emptied at the end.
// A main turn runs from the send (or its `system/init`) to its `result`. The state flag
// (CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS) doesn't move that end: the CLI stays `running` and sends `idle`
// only once its background tasks ended too (docs/Agent SDK.md, "Session state and background tasks"), so
// after the result a `running` or `requires_action` of that same run opens no turn; `system/init` or a
// send does. Only a result whose `queued_turn_count` says more of your messages follow keeps the turn
// running, with the flag, till their turns end or `idle` comes.
// `at` is the backend's clock when the status last changed (for stale: when the last message
// came); the caller stores it.
import type { SDKAssistantMessageError, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Item, PendingAsk } from './transcript.ts';

export type Status = 'busy' | 'idle' | 'waiting' | 'stopped' | 'failed' | 'signedout' | 'refreshing' | 'stale' | 'retrying' | 'compacting';
type Outcome = 'idle' | 'stopped' | 'failed';
// text: the result's `result` string, the failure's sentence when it is an error.
// queued: its `queued_turn_count`, your sends that still run as turns after it.
export type ResultLike = { subtype: string; is_error?: boolean; terminal_reason?: string; text?: string; queued?: number };
// queued: messages waiting for the running turn. retry: the attempt, its cap, when it goes (ms) and why.
// error: the sentence of a failed turn, or of the expired sign-in.
export type Takeover = 'waiting' | 'taking';
// external: the status is another process's, read from the transcript (its main turn, or its question
// or plan), not Synopia's own process's: publisher.ts sends the session as not `driven`.
export type Retry = { attempt: number; max: number; at: number; text: string };
export type StatusDetail = { queued?: number; retry?: Retry; error?: string; terminal?: number; takeover?: Takeover; external?: true };
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
// apiError: the request the CLI retries now, by the transcript (its system/api_error), or none.
export type ApiError = { text: string; status: number | null; credential: boolean };
export type Running = { agents: number; turn: boolean; lastAt: number; ask?: PendingAsk | null; apiError?: ApiError | null };
export const AUTH_ERRORS: readonly SDKAssistantMessageError[] = ['authentication_failed', 'cloud_credential_error'];

// Whether a retried request failed on its sign-in or credentials (2026-11-26), the one place that decides:
// the documented `error` (authentication_failed, cloud_credential_error) or `error_status` (401, 403) of the
// `system/api_retry` first; then the transcript's `isCloudCredentialError`; the sentence only as a fallback,
// when the error says nothing more (`unknown`, no HTTP status).
const AUTH_TEXT = /\b(security token|token|credentials?|sign-?in|session)\b[^.]*\b(expired|invalid|not valid|could not be (loaded|found|resolved))\b|\bexpired\b[^.]*\b(token|credentials?)\b|\bcould not load (aws )?credentials\b/i;
export function isAuthFailure(error: unknown, status: unknown, api?: ApiError | null): boolean {
  if (AUTH_ERRORS.includes(error as SDKAssistantMessageError)) return true;
  if (status === 401 || status === 403) return true;
  if (api?.credential || api?.status === 401 || api?.status === 403) return true;
  return (error === 'unknown' || error == null) && (status == null) && Boolean(api?.text && AUTH_TEXT.test(api.text));
}

// The sentence of a retry when the transcript has none (yet): from the documented fields alone.
const RETRY_WHY: Partial<Record<SDKAssistantMessageError, string>> = {
  rate_limit: 'Rate limited', overloaded: 'The API is overloaded', server_error: 'The API had a server error',
  authentication_failed: 'The sign-in was refused', cloud_credential_error: 'The model\'s credentials failed',
  billing_error: 'A billing error', model_not_found: 'The model wasn\'t found', invalid_request: 'The request was refused',
};
export function retrySentence(error: unknown, status: unknown): string {
  const why = RETRY_WHY[error as SDKAssistantMessageError] ?? (status == null ? 'The connection failed' : 'The request failed');
  return typeof status === 'number' ? `${why} (HTTP ${status})` : why;
}

// One sentence of a result's text, for the failed status (at most 300 characters).
export function failureSentence(text: unknown): string {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
}
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
  if (st === 'refreshing') return { status: 'signedout', at: stored.at }; // its refresh ended with the old process
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
  private external = false; // a main turn running in another process, from the transcript
  private ask: PendingAsk | null = null; // a question or plan waiting in another process, from the transcript
  private stopping = false; // an interrupt was sent and its result hasn't come yet
  private hurrying = false; // f, f interrupted the turn so its queued messages run now: no Stop
  private signedOut: boolean;
  private compacting = false;
  private retry: { attempt: number; max: number; at: number; error: unknown; status: unknown } | null = null;
  private apiError: ApiError | null = null; // the transcript's sentence for the request the CLI retries
  private refreshing = false; // the folder's credential refresh command runs (creds.ts)
  private errorText = ''; // the sentence of the failed turn or the expired sign-in
  private queued: string[] = []; // uuids pushed during a turn, not yet listed by a reply
  private last: number; // when the last SDK message came (or the turn started, or a card was answered)
  private staleMs: number;
  private timer: Timer;
  private cancelStale: (() => void) | null = null;
  private resulted = false; // the main turn's result came and no turn started since (idle may come much later)
  private terminal = 0; // the pid of a terminal's CLI that holds the session, 0 for none
  private takeover: Takeover | null = null;

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

  // Messages pushed during the turn that no reply has listed yet (f, f sends them now, R9.8).
  get queuedCount(): number {
    return this.queued.length;
  }

  // Another process runs the main turn, or asks its question, by the transcript (no process of ours).
  get externalTurn(): boolean {
    return this.external || this.ask !== null;
  }

  // The session pushed a message, or a turn began (system/init comes at the start of each turn).
  turnStarted(): void {
    this.running = true;
    this.resulted = false;
    this.signedOut = false;
    this.errorText = '';
    this.last = this.now();
    this.update();
  }

  // The session pushed a message: during a turn it is queued until a reply lists its uuid.
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
      if (err && AUTH_ERRORS.includes(err)) {
        if (!this.signedOut || !this.errorText) this.errorText = this.retryText();
        this.signedOut = true;
      } else if (m.parent_tool_use_id == null) this.signedOut = false;
      this.retry = null;
    } else if (m.type === 'system' && m.subtype === 'api_retry') {
      this.retry = { attempt: num(m.attempt), max: num(m.max_retries), at: this.last + num(m.retry_delay_ms), error: m.error, status: m.error_status };
      if (isAuthFailure(m.error, m.error_status, this.apiError)) this.signedOut = true;
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
      if (!this.resulted) this.running = true; // after the result it is background work, not the main turn
    } else if (state === 'idle') {
      this.turnOver();
      this.resulted = false;
      this.stopping = false; // an interrupt after the turn's result had nothing to stop
      this.hurrying = false;
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
    this.hurrying = false;
  }

  // f, f interrupted the turn so the queued messages run next (R9.8): its aborted result is no Stop
  // and no failure, the next turn follows. Not once the turn's result came.
  hurried(): void {
    if (this.resulted) return;
    this.hurrying = true;
  }

  result(r: ResultLike): void {
    this.outcome = this.stopping ? 'stopped' : this.hurrying ? 'idle' : outcomeOf(r);
    if (this.outcome === 'failed' && r.text) this.errorText = failureSentence(r.text) || this.errorText;
    this.stopping = false;
    this.hurrying = false;
    this.resulted = true;
    if (!this.flag || !(r.queued && r.queued > 0)) this.turnOver();
    this.update();
  }

  // What runs by the transcript changed. `external`: the caller has no process for the session, so
  // a running main turn there is another process's. One starting makes the old outcome history.
  setRunning(r: Running, external: boolean): void {
    this.apiError = r.apiError ?? null;
    // the sentence can tell an authentication failure the retry's fields didn't (isAuthFailure's fallback)
    if (this.retry && this.running && isAuthFailure(this.retry.error, this.retry.status, this.apiError)) this.signedOut = true;
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

  // The folder's credential refresh command runs, or no longer (creds.ts).
  setRefreshing(on: boolean): void {
    this.refreshing = on;
    this.update();
  }

  // The folder's credential refresh command succeeded: the CLI's next retry takes the new credentials.
  // True when the latest main turn had already ended failed on them (its retries ran out): session.ts
  // resumes it once (R8.2, 2026-11-26). A turn still retrying gives false: its next retry goes through.
  credentialsRefreshed(): boolean {
    if (!this.signedOut) return false;
    const failed = !this.running && this.outcome === 'failed';
    this.signedOut = false;
    this.update();
    return failed;
  }

  // Signed out (needs you, sign-in expired, or refreshing): creds.ts runs the folder's command for it.
  get signedOutNow(): boolean {
    return this.signedOut;
  }

  // A terminal's CLI holds the session (its pid), or no longer (0).
  setTerminal(pid: number): void {
    this.terminal = pid > 0 ? pid : 0;
    this.update();
  }

  // A message waits to take the session back from the terminal, or no longer (null).
  setTakeover(t: Takeover | null): void {
    this.takeover = t;
    this.update();
  }

  // The process ended: on purpose (idle timeout, close, quit) or not (failed).
  processEnded(failed: boolean): void {
    this.turnOver();
    this.resulted = false;
    this.pending = 0;
    if (failed) this.outcome = 'failed';
    this.update();
  }

  // A start that never happened (the folder is gone).
  failed(): void {
    this.processEnded(true);
  }

  // The retry's sentence: the CLI's own (the transcript), else one from the documented fields.
  private retryText(): string {
    if (!this.retry) return this.apiError?.text ?? '';
    return this.apiError?.text || retrySentence(this.retry.error, this.retry.status);
  }

  private turnOver(): void {
    this.running = false;
    this.compacting = false;
    this.retry = null;
    this.queued = [];
  }

  // Needs you wins; then signed out; then, while a turn runs: no updates, rate limited,
  // compacting, working. After the turn: the outcome (a turn in another process is working).
  private update(): void {
    const now = this.now();
    const silentFor = this.staleMs + (this.retry ? Math.max(0, this.retry.at - this.last) : 0);
    const stale = this.running && this.pending === 0 && now - this.last >= silentFor;
    const next: Status = this.pending > 0 || this.ask ? 'waiting'
      : this.signedOut ? (this.refreshing ? 'refreshing' : 'signedout')
        : !this.running ? (this.external ? 'busy' : this.outcome)
          : stale ? 'stale' : this.retry ? 'retrying' : this.compacting ? 'compacting' : 'busy';
    const detail: StatusDetail = {};
    if (next === 'busy' && this.queued.length) detail.queued = this.queued.length;
    if (next === 'retrying' && this.retry) detail.retry = { attempt: this.retry.attempt, max: this.retry.max, at: this.retry.at, text: this.retryText() };
    const why = this.signedOut && this.retry ? this.retryText() : this.errorText;
    if ((next === 'signedout' || next === 'refreshing' || next === 'failed') && why) detail.error = why;
    if (this.terminal) detail.terminal = this.terminal;
    if (this.takeover) detail.takeover = this.takeover;
    if (!this.running && this.pending === 0 && (this.ask || this.external)) detail.external = true;
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
    const watch = this.running && this.pending === 0 && next !== 'stale' && next !== 'signedout' && next !== 'refreshing';
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

// Whether a turn runs that a message sent now queues behind (R5.5).
export function queuesBehind(s: Status): boolean {
  return s === 'busy' || s === 'retrying' || s === 'compacting';
}

// The status of a session no process of ours set (the transcript alone): working while its main turn
// runs, else your turn (background work aside, 2026-11-26). A question or plan waiting there is needs you.
export function transcriptStatus(r: Running): Status {
  return r.ask ? 'waiting' : r.turn ? 'busy' : 'idle';
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
  return a.queued === b.queued && a.terminal === b.terminal && a.takeover === b.takeover && a.external === b.external && a.error === b.error && a.retry?.attempt === b.retry?.attempt && a.retry?.max === b.retry?.max && a.retry?.at === b.retry?.at && a.retry?.text === b.retry?.text;
}

// ---------- what the page shows: the one derivation ----------
// The page renders `session.state` and decides nothing about status itself.
//   light    red: needs you (signed out too). green: a turn runs, interruptible (working, compacting,
//            retrying, no updates), or the credentials are being refreshed. amber: your turn (idle,
//            stopped, failed).
//   tone     the state word's colour: red for needs you, amber for retrying, grey for no updates, else the light.
//   word     "Needs you", "Working", "Your turn", "Stopped", "Failed", or the turn's phase
//            ("No updates", "Retrying, attempt 4 of 10", "Compacting", "Refreshing credentials…").
//            "Needs you, blocked": your turn after a main turn with a step denied and not retried
//            (blockedLast), or after a subagent run with one (blockedSubagent). "Needs you, sign-in expired": signed out (2026-11-26). "Needs you, a command waits
//            for input": your `!` command waits for input (bang.ts, pty.ts InputWatch; R8.2, 2026-11-26).
//   mark     the session mark's key (marks.js).
//   stopped  stopped by you: the status `stopped`, or your turn after an Esc Esc interrupt the
//            transcript shows (the latest item is a `stop` interrupt marker, claude-jsonl.ts
//            `Interrupt`; a turned-down tool is not one).
//   needsYou what the session waits on: the oldest request's kind, or the question or plan
//            another process asks, `signin`, `input` or `blocked`; null when it waits on nothing.
//   review   finished "For review: …" subagents not marked reviewed (R10.1).
//   driven   the status comes from Synopia's own process: not the transcript alone (`external`),
//            nor a terminal that holds the session. Only then are Esc Esc, b b and bash mode offered.
export type Light = 'red' | 'amber' | 'green';
export type Needs = 'question' | 'permission' | 'plan' | 'blocked' | 'signin' | 'input';
export type SessionState = {
  status: Status; since: number; detail: StatusDetail;
  light: Light; tone: Light | 'grey'; word: string; mark: string;
  stopped: boolean; needsYou: Needs | null; review: number; driven: boolean;
};
export type StateFacts = {
  pending: Needs[]; // the session's requests' kinds, oldest first
  ask: { kind: 'question' | 'plan' } | null; // a card another process waits on
  interrupted: boolean; // the latest item (titles aside) is a `stop` interrupt marker
  blocked: boolean; // the latest main turn, or a subagent run that ended since your last message, has a denied step not redone (blockedLast, blockedSubagent)
  input?: boolean; // your running `!` command waits for input (bang.ts BangRun.waiting)
  review: number;
  driven: boolean;
};

const LIGHT: Record<Status, Light> = {
  waiting: 'red', signedout: 'red', busy: 'green', compacting: 'green', retrying: 'green', stale: 'green', refreshing: 'green',
  idle: 'amber', stopped: 'amber', failed: 'amber',
};
const PHASE: Partial<Record<Status, { word: string; mark: string }>> = {
  stale: { word: 'No updates', mark: 'stale' },
  retrying: { word: 'Retrying', mark: 'ratelimit' },
  compacting: { word: 'Compacting', mark: 'compact' },
  refreshing: { word: 'Refreshing credentials…', mark: 'work' },
};
const NEEDS_WORD: Partial<Record<Needs, string>> = { blocked: 'Needs you, blocked', signin: 'Needs you, sign-in expired', input: 'Needs you, a command waits for input' };
// "Retrying, attempt 4 of 10"
const retryWord = (r: Retry | undefined): string => !r || !r.attempt ? 'Retrying' : `Retrying, attempt ${r.attempt}${r.max ? ` of ${r.max}` : ''}`;

export function sessionState(e: { status: Status; at: number; detail?: StatusDetail }, f: StateFacts): SessionState {
  const status = e.status, detail = e.detail ?? {};
  // your turn after a turn whose step was blocked or denied: Claude can't go on without you
  const blocked = status === 'idle' && f.blocked && !f.interrupted;
  const needsYou: Needs | null = f.pending[0] ?? (status === 'waiting' ? (f.ask?.kind ?? 'permission') : status === 'signedout' ? 'signin' : f.input ? 'input' : blocked ? 'blocked' : null);
  const light: Light = needsYou ? 'red' : LIGHT[status];
  const phase = light === 'red' ? undefined : PHASE[status];
  const stopped = light === 'amber' && !phase && status !== 'failed' && (status === 'stopped' || f.interrupted);
  const word = phase ? (status === 'retrying' ? retryWord(detail.retry) : phase.word) : light === 'red' ? (NEEDS_WORD[needsYou as Needs] ?? 'Needs you') : light === 'green' ? 'Working'
    : status === 'failed' ? 'Failed' : stopped ? 'Stopped' : 'Your turn';
  const tone: Light | 'grey' = light === 'red' ? 'red' : status === 'retrying' ? 'amber' : status === 'stale' ? 'grey' : light;
  // your turn shows the grey square, whether or not background work runs
  const mark = light === 'red' ? 'pause' : phase ? phase.mark : light === 'green' ? (detail.queued ? 'queued' : 'work')
    : status === 'failed' ? 'failed' : 'stopped';
  return { status, since: e.at, detail, light, tone, word, mark, stopped, needsYou, review: f.review, driven: f.driven };
}

// Blocked (R8.2, FR-STAT-02): the latest main turn (from your last message, a `!` command or a message a
// turn took in) has a step auto mode blocked or a permission denied (tool state `denied`), with no later
// step of the same tool and input that ran. Read once the turn is over: sessionState applies it to your
// turn only, so it shows for sessions Synopia runs and terminal ones alike, and a new message clears it.
export function blockedLast(items: Item[]): boolean {
  const from = turnFrom(items);
  return unredone(items.slice(from).filter((it) => it.k === 'tool')).length > 0;
}

// Where the latest main turn starts in `items`: your last message, a `!` command or a resumed turn.
function turnFrom(items: Item[]): number {
  let from = items.length;
  while (from > 0) {
    const it = items[from - 1];
    if ((it.k === 'you' && !it.turnedDown && !it.interrupted) || it.k === 'bang' || it.k === 'resumed') break;
    from--;
  }
  return from;
}

// When the latest main turn started (turnFrom), in ms; null when no message opened one.
export function turnStartMs(items: Item[]): number | null {
  const from = turnFrom(items);
  return from > 0 ? msOf(items[from - 1].ts) : null;
}

// The denied steps (auto mode blocked them, or a permission was denied) that no later step of the same
// tool and input redid.
function unredone(steps: Item[]): Item[] {
  return steps.filter((d, i) => d.state === 'denied' && !steps.slice(i + 1).some((it) => it.state === 'done' && it.name === d.name && it.input === d.input));
}

// Blocked in a subagent (R8.2, FR-STAT-02, 2026-11-26): the same rule for a subagent's thread. `steps`:
// its transcript's items; `ends`: when each of its runs ended and whether it was stopped (Transcript
// runEnds); `since`: when your last message opened the main turn (turnStartMs). A step denied after
// `since` that no later step of its thread redid, in a run that ended (not stopped), blocks: Claude
// can't go on without you. Your next message clears it; so does that subagent, resumed, redoing it.
export function blockedSubagent(steps: Item[], ends: { at: number; stopped: boolean }[], since: number | null): boolean {
  if (!ends.some((e) => since === null || e.at > since)) return false;
  const tools = steps.filter((it) => it.k === 'tool' && (since === null || (msOf(it.ts) ?? -Infinity) > since));
  return unredone(tools).some((d) => {
    const at = msOf(d.ts) ?? -Infinity;
    const end = ends.find((e) => e.at >= at);
    return end !== undefined && !end.stopped;
  });
}

const msOf = (ts: string | null | undefined): number | null => {
  const ms = ts ? Date.parse(ts) : NaN;
  return Number.isNaN(ms) ? null : ms;
};

// What a session adds to the Dock badge (R2.6): 1 while it needs you, plus its deliverables to review.
// No updates, retrying, compacting, refreshing and working don't count; signed out needs you (2026-11-26).
export const badgeOf = (s: SessionState): number => (s.needsYou ? 1 : 0) + s.review;

// The Dock badge's count, kept as sessions change: the shell polls it every 2 s and nothing is rebuilt
// per poll. `onChange` runs when the total moves (the `badge` log line).
export class BadgeCounter {
  private per = new Map<string, number>();
  private total = 0;
  private onChange: (n: number) => void;

  constructor(onChange: (n: number) => void = () => {}) {
    this.onChange = onChange;
  }

  get count(): number {
    return this.total;
  }

  set(sid: string, n: number): void {
    const was = this.per.get(sid) ?? 0;
    if (n > 0) this.per.set(sid, n);
    else this.per.delete(sid);
    if (n === was) return;
    this.total += n - was;
    this.onChange(this.total);
  }

  // A closed session no longer counts.
  drop(sid: string): void {
    this.set(sid, 0);
  }
}

// GET /api/quit-check, what "Stop All Work…" and "Restart Backend Now…" ask with (FR-PLAT-06): the
// running turns, the background work (one `{sid, kind}` each), `counts` per kind, and `summary`, the
// alert's sentence after its question ("2 sessions are working and 1 background shell will stop."),
// empty when nothing runs. The shell shows `summary` as it is and knows no kind: a new kind is counted
// and named here. `background` keeps the list shape of the daemons before `summary`: a shell of that
// time still decodes it and asks first (docs/Daemon files.md).
export type QuitCheck = { running: string[]; background: { sid: string; kind: string }[]; counts: Record<string, number>; summary: string };

const KIND_WORDS: Record<string, [string, string]> = {
  subagent: ['subagent', 'subagents'],
  shell: ['background shell', 'background shells'],
  monitor: ['monitor', 'monitors'],
};

export function quitSummary(q: { running: string[]; background: { sid: string; kind: string }[] }): QuitCheck {
  const counts: Record<string, number> = {};
  for (const { kind } of q.background) counts[kind] = (counts[kind] ?? 0) + 1;
  const kinds = [...Object.keys(KIND_WORDS).filter((k) => counts[k]), ...Object.keys(counts).filter((k) => !KIND_WORDS[k]).sort()];
  const work = kinds.map((k) => {
    const n = counts[k];
    const [one, many] = KIND_WORDS[k] ?? [`background ${k}`, `background ${k}s`];
    return `${n} ${n === 1 ? one : many}`;
  });
  const n = q.running.length;
  const turns = n === 0 ? '' : n === 1 ? '1 session is working' : `${n} sessions are working`;
  const list = work.length > 1 ? `${work.slice(0, -1).join(', ')} and ${work.at(-1)}` : (work[0] ?? '');
  const summary = turns && list ? `${turns} and ${list} will stop.` : turns ? `${turns} and will stop.` : list ? `${list} will stop.` : '';
  return { running: q.running, background: q.background.map(({ sid, kind }) => ({ sid, kind })), counts, summary };
}
