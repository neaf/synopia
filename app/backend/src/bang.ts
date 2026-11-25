// Bash mode (R5.13, 2026-11-24), as `!` in the Claude Code CLI: a command typed after `!` runs in
// the session's folder through the user's login shell (`$SHELL -c <command>`, the daemon's env,
// which login-env.ts merged at start), never interpolated into another shell string. Its output
// streams to the page, capped at 30,000 characters (the Bash tool's default). Esc, Esc ends it:
// SIGTERM to its own process group, SIGKILL 3 s later. The command and its output then go to the
// session in the CLI's format (`<bash-input>`, `<bash-stdout>`, `<bash-stderr>`), as user messages
// with `shouldQuery: false` (sdk.d.ts SDKUserMessage.shouldQuery: appended to the transcript
// without a turn, merged into the next user message that queries).
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { groupAlive, signalGroup } from './macos.ts';

export const BANG_CAP = 30_000;
export const KILL_AFTER_MS = 3000;
export const BANG_TICK_MS = 100; // the page gets the output at most this often while it runs
const CLOSE_GRACE_MS = 500; // a child left holding the pipes after the shell exited doesn't hold the run open

// One run, as the page shows it until its records land in the transcript. `exit`: the shell's exit
// code (128 + the signal's number when a signal ended it); null while it runs.
export type BangRun = {
  id: string; cmd: string; out: string; err: string; cut: boolean;
  running: boolean; exit: number | null; interrupted: boolean; at: number;
  error?: string; // it couldn't start, or couldn't go to Claude
};

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

export type BangOptions = {
  id: string;
  cmd: string;
  cwd: string;
  env?: NodeJS.ProcessEnv; // default: the daemon's (with the login env merged)
  shell?: string; // default: $SHELL, else /bin/zsh
  cap?: number;
  killAfterMs?: number;
  tickMs?: number;
  now?: () => number;
  onUpdate: (run: BangRun) => void; // throttled while it runs
  onDone: (run: BangRun) => void;
};

export class Bang {
  readonly run: BangRun;
  private child: ChildProcess | null = null;
  private opts: BangOptions;
  private tick: NodeJS.Timeout | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private grace: NodeJS.Timeout | null = null;
  private finished = false;
  private used = 0; // code points kept in out and err together

  constructor(opts: BangOptions) {
    this.opts = opts;
    this.run = { id: opts.id, cmd: opts.cmd, out: '', err: '', cut: false, running: true, exit: null, interrupted: false, at: (opts.now ?? Date.now)() };
    const env = opts.env ?? process.env;
    const shell = opts.shell || env.SHELL || '/bin/zsh';
    let child: ChildProcess;
    try {
      // detached: its own process group, so the interrupt reaches what it started and nothing else
      child = spawn(shell, ['-c', opts.cmd], { cwd: opts.cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      // spawn throws for some arguments (a NUL byte in the command): the caller hears it after this
      // constructor returns, as for any other end, never from inside it
      queueMicrotask(() => this.fail(e));
      return;
    }
    this.child = child;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => this.take('out', d));
    child.stderr?.on('data', (d: string) => this.take('err', d));
    child.on('error', (e) => this.fail(e));
    child.on('exit', (code, signal) => {
      this.run.exit = code ?? (signal ? 128 + (SIGNALS[signal] ?? 0) : null);
      this.grace = setTimeout(() => this.finish(), CLOSE_GRACE_MS);
    });
    child.on('close', () => this.finish());
  }

  // Esc, Esc: SIGTERM to its process group, SIGKILL if it is still there after 3 s.
  kill(): void {
    if (this.finished || !this.child?.pid) return;
    this.run.interrupted = true;
    const pid = this.child.pid;
    signalGroup(pid, 'SIGTERM');
    this.killTimer = setTimeout(() => signalGroup(pid, 'SIGKILL'), this.opts.killAfterMs ?? KILL_AFTER_MS); // the group may outlive the shell
    this.killTimer.unref?.();
  }

  // The cap the output is cut at, in characters (code points).
  get cap(): number {
    return this.opts.cap ?? BANG_CAP;
  }

  private take(which: 'out' | 'err', d: string): void {
    const room = this.cap - this.used;
    if (room <= 0) { this.run.cut = true; return; }
    const chars = [...d]; // by code point: a cut never splits a surrogate pair
    if (chars.length > room) { d = chars.slice(0, room).join(''); this.run.cut = true; }
    this.used += Math.min(chars.length, room);
    this.run[which] += d;
    if (!this.tick) this.tick = setTimeout(() => { this.tick = null; if (!this.finished) this.opts.onUpdate(this.run); }, this.opts.tickMs ?? BANG_TICK_MS);
  }

  private fail(e: unknown): void {
    if (this.finished) return;
    this.run.error = `The command couldn't start: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
    this.finish();
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    for (const t of [this.tick, this.grace]) if (t) clearTimeout(t);
    // The SIGKILL stays armed only while something of the group lives (a child that ignored SIGTERM):
    // once the group is empty its id can be reused, and that group must get no signal.
    if (this.killTimer && !(this.child?.pid && groupAlive(this.child.pid))) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    this.run.running = false;
    this.opts.onDone(this.run);
  }
}

// ---------- the CLI's format ----------

export const bashInput = (cmd: string): string => `<bash-input>${cmd}</bash-input>`;

// The output record. A cut output, and a non-zero exit (or the interrupt that ended it), end the
// stderr with a line each, so Claude reads them as the page shows them (parseBashOutput takes them off).
// `cap`: the run's cap (Bang.cap).
export function bashOutput(run: Pick<BangRun, 'out' | 'err' | 'cut' | 'exit'> & { interrupted?: boolean }, cap = BANG_CAP): string {
  const tail: string[] = [];
  if (run.cut) tail.push(`[Output cut at ${cap.toLocaleString('en-US')} characters]`);
  if (run.interrupted) tail.push(`Interrupted by the user, exit code ${run.exit ?? '?'}`);
  else if (run.exit !== null && run.exit !== 0) tail.push(`Exit code ${run.exit}`);
  const err = tail.length ? [run.err.replace(/\n$/, ''), ...tail].filter(Boolean).join('\n') : run.err;
  return `<bash-stdout>${run.out}</bash-stdout><bash-stderr>${err}</bash-stderr>`;
}

// One user record's `!` commands, as the CLI writes them (docs/Claude Code transcripts.md, "Bash mode
// records"): the CLI joins the `shouldQuery: false` messages it holds into one record with "\n", so a
// record can hold a command and its output, several commands, and the next prompt after them. `runs`:
// the commands in order, each with its output when the record holds it; `rest`: the text after them
// (a prompt, or ''). Null when the text doesn't start with a command.
export type BashRun = { cmd: string; out: BashOutput | null };
const RUN = /^<bash-input>([\s\S]*?)<\/bash-input>\s*(?:<bash-stdout>([\s\S]*?)<\/bash-stdout>\s*<bash-stderr>([\s\S]*?)<\/bash-stderr>\s*)?/;
export function splitBash(text: string): { runs: BashRun[]; rest: string } | null {
  const runs: BashRun[] = [];
  let rest = text;
  for (let m = RUN.exec(rest); m; m = RUN.exec(rest)) {
    runs.push({ cmd: m[1], out: m[2] === undefined ? null : parseBashOutput(`<bash-stdout>${m[2]}</bash-stdout><bash-stderr>${m[3]}</bash-stderr>`) });
    rest = rest.slice(m[0].length);
  }
  if (!runs.length) return null;
  // An output that holds the tags' own text: then the record is one command and its output, read whole.
  if (/<\/bash-(?:stdout|stderr|input)>/.test(rest)) {
    const one = /^<bash-input>([\s\S]*?)<\/bash-input>\s*(<bash-stdout>[\s\S]*)$/.exec(text);
    const out = one ? parseBashOutput(one[2]) : null;
    if (one && out) return { runs: [{ cmd: one[1], out }], rest: '' };
    const cmd = parseBashInput(text);
    if (cmd !== null) return { runs: [{ cmd, out: null }], rest: '' };
  }
  return { runs, rest };
}

export function parseBashInput(text: string): string | null {
  const m = /^<bash-input>([\s\S]*)<\/bash-input>\s*$/.exec(text);
  return m ? m[1] : null;
}

export type BashOutput = { out: string; err: string; cut: boolean; exit: number | null; interrupted?: boolean };

export function parseBashOutput(text: string): BashOutput | null {
  const m = /^<bash-stdout>([\s\S]*)<\/bash-stdout>\s*<bash-stderr>([\s\S]*)<\/bash-stderr>\s*$/.exec(text);
  if (!m) return null;
  let err = m[2], exit: number | null = null, cut = false, interrupted = false;
  const ex = /(?:^|\n)(Interrupted by the user, exit code|Exit code) (\d+)$/.exec(err);
  if (ex) { exit = Number(ex[2]); interrupted = ex[1] !== 'Exit code'; err = err.slice(0, ex.index); }
  const ct = /(?:^|\n)\[Output cut at [\d,]+ characters\]$/.exec(err);
  if (ct) { cut = true; err = err.slice(0, ct.index); }
  return interrupted ? { out: m[1], err, cut, exit, interrupted } : { out: m[1], err, cut, exit };
}
