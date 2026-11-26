// Bash mode (R5.13, 2026-11-24; a terminal, 2026-11-26), as `!` in the Claude Code CLI: a command typed
// after `!` runs in the session's folder through the user's shell (`$SHELL -c <command>`, the daemon's env,
// which login-env.ts merged at start), never interpolated into another shell string. It runs in one
// pseudo-terminal for its whole run (pty.ts), so it sees a terminal (isatty) and can read a line typed into
// it (input(): "Press Enter" works), with stderr on its own pipe as before. TERM=dumb and PAGER=cat, so
// `git log` and the like print and end instead of waiting in a pager. Its output streams to the page as
// plain text (pty.ts plainText: no escape sequences, the pty's CRLF as LF), capped at 30,000 characters
// (the Bash tool's default). Its shell view stops it (Esc, Esc there, 2026-11-26): SIGTERM to its own process
// group, SIGKILL 3 s later. It waits for input by pty.ts InputWatch's rule (live run IN-1), and gets its panel
// card by runs.ts cardAt. The
// command and its output then go to the session in the CLI's format (`<bash-input>`, `<bash-stdout>`,
// `<bash-stderr>`), as user messages with `shouldQuery: false` (sdk.d.ts SDKUserMessage.shouldQuery:
// appended to the transcript without a turn, merged into the next user message that queries).
import { groupAlive } from './macos.ts';
import { InputWatch, plainText, shellPty } from './pty.ts';
import type { PtyRun, PtyStart } from './pty.ts';
import { cardAt } from './runs.ts';

export const BANG_CAP = 30_000;
export const KILL_AFTER_MS = 3000;
export const BANG_TICK_MS = 100; // the page gets the output at most this often while it runs

// One run, as the page shows it until its records land in the transcript. `exit`: the shell's exit
// code (128 + the signal's number when a signal ended it); null while it runs. `end`: when it ended (ms).
// `waiting`: it waits for input now (pty.ts InputWatch: a prompt-shaped last line, quiet); `quiet`: no
// output for a while without such a line, so it may wait (a hint only); `waitedAt`: when it first waited.
// `cardAt`: when its panel card shows (runs.ts), null for none.
export type BangRun = {
  id: string; cmd: string; out: string; err: string; cut: boolean;
  running: boolean; exit: number | null; interrupted: boolean; at: number; end: number | null;
  waiting: boolean; quiet: boolean; waitedAt: number | null; cardAt: number | null;
  error?: string; // it couldn't start, or couldn't go to Claude
};

export type BangOptions = {
  id: string;
  cmd: string;
  cwd: string;
  env?: NodeJS.ProcessEnv; // default: the daemon's (with the login env merged)
  shell?: string; // default: $SHELL, else /bin/zsh
  cap?: number;
  killAfterMs?: number;
  tickMs?: number;
  promptMs?: number; // pty.ts PROMPT_QUIET_MS
  hintMs?: number; // pty.ts QUIET_HINT_MS
  now?: () => number;
  start?: PtyStart; // default: pty.ts shellPty
  onUpdate: (run: BangRun) => void; // throttled while it runs
  onDone: (run: BangRun) => void;
};

export class Bang {
  readonly run: BangRun;
  private pty: PtyRun | null = null;
  private opts: BangOptions;
  private tick: NodeJS.Timeout | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private watch: InputWatch | null = null;
  private finished = false;
  private raw = { out: '', err: '' }; // what the pty gave, before plainText and the cap
  private full = false; // the cap was reached: nothing more is kept

  constructor(opts: BangOptions) {
    this.opts = opts;
    const at = this.now();
    this.run = { id: opts.id, cmd: opts.cmd, out: '', err: '', cut: false, running: true, exit: null, interrupted: false, at, end: null, waiting: false, quiet: false, waitedAt: null, cardAt: cardAt(at, null) };
    const env = { ...(opts.env ?? process.env), TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat' };
    const shell = opts.shell || env.SHELL || '/bin/zsh';
    try {
      this.pty = (opts.start ?? shellPty)(opts.cmd, { cwd: opts.cwd, env, shell, login: false, onData: (d) => this.take('out', d), onErr: (d) => this.take('err', d) });
    } catch (e) {
      // spawn throws for some arguments (a NUL byte in the command): the caller hears it after this
      // constructor returns, as for any other end, never from inside it
      queueMicrotask(() => this.fail(e));
      return;
    }
    this.watch = new InputWatch({ now: () => this.now(), promptMs: opts.promptMs, hintMs: opts.hintMs, onChange: (st) => {
      if (this.finished) return;
      Object.assign(this.run, st);
      this.run.cardAt = cardAt(this.run.at, null, st.waitedAt);
      this.opts.onUpdate(this.run);
    } });
    void this.pty.done.then((end) => {
      if (end.error) { this.fail(end.error); return; }
      this.run.exit = end.code;
      this.finish();
    });
  }

  // A line typed into it (Enter sends it with a newline; an empty one is just the newline).
  input(text: string): boolean {
    if (this.finished || !this.pty) return false;
    this.pty.write(text.replace(/[\r\n]+/g, ' ') + '\n');
    return true;
  }

  // Esc, Esc in its shell view: SIGTERM to its process group, SIGKILL if it is still there after 3 s.
  kill(): void {
    if (this.finished || !this.pty) return;
    this.run.interrupted = true;
    const pty = this.pty;
    pty.kill('SIGTERM');
    if (this.killTimer) return;
    this.killTimer = setTimeout(() => { this.killTimer = null; const g = pty.group(); if (g === null || groupAlive(g)) pty.kill('SIGKILL'); }, this.opts.killAfterMs ?? KILL_AFTER_MS); // the group may outlive the shell
    this.killTimer.unref?.();
  }

  // The cap the output is cut at, in characters (code points).
  get cap(): number {
    return this.opts.cap ?? BANG_CAP;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  // The output as plain text (pty.ts plainText, the one place the pty's CRLF and escapes go), out and err
  // together cut at the cap by code point (a cut never splits a surrogate pair).
  private take(which: 'out' | 'err', d: string): void {
    if (this.finished) return;
    this.watch?.take(which, d);
    if (this.full) { this.run.cut = true; return; }
    this.raw[which] += d;
    const out = [...plainText(this.raw.out)], err = [...plainText(this.raw.err)];
    if (out.length + err.length > this.cap || this.raw.out.length + this.raw.err.length > 8 * this.cap) {
      this.full = true;
      this.run.cut = true;
      const keepOut = Math.min(out.length, this.cap);
      this.run.out = out.slice(0, keepOut).join('');
      this.run.err = err.slice(0, Math.max(0, this.cap - keepOut)).join('');
    } else {
      this.run.out = out.join('');
      this.run.err = err.join('');
    }
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
    if (this.tick) clearTimeout(this.tick);
    this.watch?.stop();
    // The SIGKILL stays armed only while something of the group lives (a child that ignored SIGTERM):
    // once the group is empty its id can be reused, and that group must get no signal.
    const g = this.pty?.group() ?? null;
    if (this.killTimer && !(g !== null && groupAlive(g))) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    this.run.running = false;
    this.run.waiting = false;
    this.run.quiet = false;
    this.run.end = this.now();
    this.run.cardAt = cardAt(this.run.at, this.run.end, this.run.waitedAt);
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
