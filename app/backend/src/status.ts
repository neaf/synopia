// One status per session (plan section 8), from the SDK's events and the driver's own state,
// in the page's vocabulary:
//   busy     working: `session_state_changed: running`, or the driver started a turn
//   waiting  needs you: a pending canUseTool request, which wins over running
//   idle     your turn: idle after a normal `result`, or the process isn't running
//   stopped  stopped by you: idle after a turn that ended by interrupt
//   failed   a `result` that is an error and not an interrupt, or the process failed
// Without CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS (no `session_state_changed` seen yet), a turn
// runs from the send to its `result`. With it, `idle` is the authoritative end of a turn.
// `at` is the backend's clock when the status last changed; the caller stores it.

export type Status = 'busy' | 'idle' | 'waiting' | 'stopped' | 'failed';
type Outcome = 'idle' | 'stopped' | 'failed';
export type ResultLike = { subtype: string; is_error?: boolean; terminal_reason?: string };
export type StatusEntry = { status: Status; at: number };

// The status a session has when its process isn't running (after a restart): a turn that was
// working or waiting when Synopia quit is your turn now.
export function restored(stored: { status?: unknown; at?: unknown } | undefined): StatusEntry | null {
  if (!stored || typeof stored.at !== 'number') return null;
  const st = stored.status;
  if (st === 'stopped' || st === 'failed' || st === 'idle') return { status: st, at: stored.at };
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
  private onChange: (e: StatusEntry) => void;
  private now: () => number;
  private running = false;
  private flag = false; // a session_state_changed event was seen
  private outcome: Outcome;
  private pending = 0;
  private stopping = false; // an interrupt was sent and its result hasn't come yet
  private resulted = false; // the running turn's result came (with the state flag, idle follows it)

  constructor(init: StatusEntry | null, onChange: (e: StatusEntry) => void, now: () => number = Date.now) {
    this.onChange = onChange;
    this.now = now;
    this.status = init?.status ?? 'idle';
    this.at = init?.at ?? now();
    this.outcome = this.status === 'stopped' || this.status === 'failed' ? this.status : 'idle';
  }

  get working(): boolean {
    return this.running;
  }

  // The driver pushed a message, or a turn began (system/init comes at the start of each turn).
  turnStarted(): void {
    this.running = true;
    this.resulted = false;
    this.update();
  }

  stateChanged(state: string): void {
    this.flag = true;
    if (state === 'running' || state === 'requires_action') {
      if (!this.running) this.resulted = false;
      this.running = true;
    } else if (state === 'idle') {
      this.running = false;
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
    if (!this.flag) this.running = false;
    this.update();
  }

  setPending(n: number): void {
    this.pending = n;
    this.update();
  }

  // The process ended: on purpose (idle timeout, close, quit) or not (failed).
  processEnded(failed: boolean): void {
    this.running = false;
    this.pending = 0;
    if (failed) this.outcome = 'failed';
    this.update();
  }

  // A start that never happened (the folder is gone).
  failed(): void {
    this.processEnded(true);
  }

  private update(): void {
    const next: Status = this.pending > 0 ? 'waiting' : this.running ? 'busy' : this.outcome;
    if (next === this.status) return;
    this.status = next;
    this.at = this.now();
    this.onChange({ status: next, at: this.at });
  }
}
