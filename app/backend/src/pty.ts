// A command run in one pseudo-terminal for its whole run, its output read live and what you type sent to
// it as typed: a terminal (R5.13, R7.2, 2026-11-27). creds.ts runs the credential refresh with it, bang.ts
// your `!` commands. macOS's script(1) gives the pty. Its stdin can't be Node's own pipe, a socket
// ("tcgetattr/ioctl: Operation not supported on socket", MC-2), so `cat` copies Node's pipe into a real one
// (sh's `|`), which script takes (tcgetattr there is ENOTTY, which it allows) and writes on to the pty; the
// pty's line discipline then does what a terminal does with it (its echo, Ctrl-C as SIGINT to the
// foreground group, Backspace). Inside the pty a small /bin/sh (the session leader) names the terminal, sets
// its size and turns on job control, so the command runs in a process group of its own, the terminal's
// foreground group: Ctrl-C reaches it, a kill goes to it, and the sh lives on to write the command's exit
// code to fd 3. Then Node ends cat's input. resize() sets the terminal's size on its device (stty -f), and
// the kernel sends the command SIGWINCH. With `onErr`, the command's stderr goes to its own pipe (fd 4)
// instead of the terminal. The output is only handed to `onData` and `onErr`: never logged nor stored here
// (a sign-in's can hold a code or a URL). Facts: docs/Claude Code terminals.md, "A command in a pseudo-terminal".
import { execFile, spawn } from 'node:child_process';

// `code`: the command's exit code (128 + the signal's number when a signal ended it); null when it timed
// out or never ran. `killed`: kill() was called. `error`: it couldn't start (a folder that is gone).
export type PtyEnd = { code: number | null; timedOut: boolean; killed: boolean; error?: string };
export type PtyRun = {
  write(text: string): void; // to the terminal as typed: "\x03" is Ctrl-C, "\r" Enter
  resize(cols: number, rows: number): void; // the terminal's size: the command gets SIGWINCH
  kill(signal?: NodeJS.Signals): void; // to the command's process group (SIGTERM by default)
  group(): number | null; // that group's id, once the pty reported it
  done: Promise<PtyEnd>;
};
export type PtyOptions = {
  cwd: string;
  onData: (text: string) => void; // the terminal: stdout (and stderr without onErr), the echo of what was typed
  onErr?: (text: string) => void; // stderr apart, not a terminal
  timeoutMs?: number; // none by default
  shell?: string; // default /bin/zsh
  login?: boolean; // `-lc` (default) or `-c`
  env?: NodeJS.ProcessEnv; // default: the daemon's
  cols?: number; rows?: number; // the terminal's size at the start (default: script's, 0 x 0)
};
export type PtyStart = (command: string, o: PtyOptions) => PtyRun;

const SCRIPT = '/usr/bin/script';
const STTY = '/bin/stty';
const GRACE_MS = 500; // a child left holding the pipes after the command ended doesn't hold the run open
// The command's start: a sh that writes the group's id ($1) to fd 3 once it runs, then execs the command,
// its stderr to fd 4 (its own pipe) or 5 (the terminal).
const LEAD = (fd: 4 | 5) => `echo "pid $1" >&3; shift; exec "$@" 2>&${fd} 3>&- 4>&- 5>&-`;
// Inside the pty, the session leader and so the terminal's foreground group: $0 shell, $1 -c or -lc, $2 the
// command, $3 1 when stderr goes to fd 4, $4 $5 rows and cols (0: left as script made them). Its own stderr
// goes nowhere. `tty` names the terminal (resize sets the size there). Ctrl-Z is off: a stopped command
// would hold the run with nothing to resume it. The command runs in the foreground, not as a `&` list,
// which ignores SIGINT (POSIX, with job control off), so Ctrl-C reaches it. The sh traps INT and TERM
// with a handler, which the command doesn't inherit: it outlives either and writes the command's exit
// code. The group's id comes from the command's own start, so a kill sent once it is known reaches the
// command (one that came before is held until then).
const INNER = `exec 5>&2 2>/dev/null; trap : INT TERM; echo "tty $(tty)" >&3; if [ "$4" -gt 0 ] && [ "$5" -gt 0 ]; then ${STTY} rows "$4" cols "$5"; fi; ${STTY} susp undef;`
  + ` if [ "$3" = 1 ]; then /bin/sh -c '${LEAD(4)}' sh "$$" "$0" "$1" "$2"; else /bin/sh -c '${LEAD(5)}' sh "$$" "$0" "$1" "$2"; fi; echo "exit $?" >&3`;
// $0 INNER, then its six arguments
const WRAP = `cat 3>&- 4>&- | { ${SCRIPT} -q /dev/null /bin/sh -c "$0" "$1" "$2" "$3" "$4" "$5" "$6"; echo "end $?" >&3; }`;
const dim = (n: number | undefined): number => (Number.isInteger(n) && (n as number) > 0 && (n as number) < 10_000 ? n as number : 0);

export const shellPty: PtyStart = (command, o) => {
  const args = [WRAP, INNER, o.shell ?? '/bin/zsh', o.login === false ? '-c' : '-lc', command, o.onErr ? '1' : '0', String(dim(o.rows)), String(dim(o.cols))];
  const p = spawn('/bin/sh', ['-c', ...args], { cwd: o.cwd, env: o.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'], detached: true });
  let pid: number | null = null, exit: number | null = null, end: number | null = null, tty: string | null = null;
  let timedOut = false, killed = false, over = false, error: string | undefined;
  let wanted: NodeJS.Signals | null = null; // a kill before the pty reported the group: sent once it does
  let size: [number, number] | null = null, sizing = false; // a size asked before the terminal was named, or while one was set
  let resolve!: (e: PtyEnd) => void;
  const done = new Promise<PtyEnd>((r) => { resolve = r; });
  let grace: NodeJS.Timeout | null = null;
  const timer = o.timeoutMs ? setTimeout(() => { timedOut = true; kill('SIGTERM'); }, o.timeoutMs) : null;
  timer?.unref?.();
  const finish = () => {
    if (over) return;
    over = true;
    if (timer) clearTimeout(timer);
    if (grace) clearTimeout(grace);
    // no exit line: a signal took the inner sh too, and script's code is the signal's number
    const code = timedOut || error ? null : exit ?? (end === null ? null : end > 0 && end < 64 ? 128 + end : end);
    resolve(error ? { code, timedOut, killed, error } : { code, timedOut, killed });
  };
  function kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (over) return;
    killed = killed || !timedOut;
    if (pid === null) { wanted = signal; return; }
    try { process.kill(-pid, signal); } catch { /* gone */ }
  }
  // One size at a time on the terminal's device; the last one asked meanwhile follows.
  function sizeNow(): void {
    if (over || !tty || !size || sizing) return;
    const [cols, rows] = size;
    size = null;
    sizing = true;
    execFile(STTY, ['-f', tty, 'rows', String(rows), 'cols', String(cols)], () => { sizing = false; sizeNow(); });
  }
  p.on('error', (e) => { error = String(e?.message ?? e); });
  p.stdin.on('error', () => { /* cat is gone */ });
  p.stdout.setEncoding('utf8').on('data', (d: string) => o.onData(d));
  p.stderr.setEncoding('utf8').on('data', (d: string) => o.onData(d)); // script's own complaints
  const err = p.stdio[4] as NodeJS.ReadableStream;
  err.setEncoding('utf8');
  err.on('data', (d: string) => (o.onErr ?? o.onData)(d));
  const status = p.stdio[3] as NodeJS.ReadableStream;
  status.setEncoding('utf8');
  let line = '';
  status.on('data', (d: string) => {
    line += d;
    for (let i = line.indexOf('\n'); i >= 0; i = line.indexOf('\n')) {
      const [word, n] = line.slice(0, i).trim().split(' ');
      line = line.slice(i + 1);
      if (word === 'tty') { if (/^\/dev\/tty\w+$/.test(n ?? '')) { tty = n; sizeNow(); } continue; }
      const v = Number(n);
      if (!Number.isInteger(v)) continue;
      if (word === 'pid') { pid = v; if (wanted) kill(wanted); }
      else if (word === 'exit') exit = v;
      else if (word === 'end') {
        end = v;
        p.stdin.end();
        grace = setTimeout(finish, GRACE_MS);
      }
    }
  });
  p.on('close', finish);
  return {
    write: (text) => { if (!over && p.stdin.writable) p.stdin.write(text); },
    resize: (cols, rows) => {
      if (!dim(cols) || !dim(rows)) return;
      size = [cols, rows];
      sizeNow();
    },
    kill,
    group: () => pid,
    done,
  };
};

// A pty's output as plain text, the one place its terminal quirks go: escape sequences (colours, cursor
// moves, titles) out, the pty's CRLF as LF, a line a carriage return rewrote (a progress bar) as it ended,
// other control characters and script's `^D` out.
export function plainText(s: string): string {
  return s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r+\n/g, '\n').replace(/[^\n]*\r(?!\n|$)/g, '').replace(/\r$/, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\^D/g, '');
}

// ---------- waits for input (R5.13, R8.2; live run IN-1, 2026-11-26) ----------
// No signal says a command blocks reading its terminal: `ps` shows the same state (S+) and wait channel (-)
// for `read` as for `sleep`, `curl` or a timer (docs/Claude Code terminals.md, "Waits for input", IN-1).
// Silence alone isn't one either: at any quiet time from 1 to 15 s most silent commands that don't wait
// (a build, a slow spec, a download) read as waiting. What IN-1 found reliable is the prompt's shape: the
// last line written, by the stream written last (Python writes input()'s prompt to stderr), is left open
// and ends in `:`, `?` or `>` ("Password: ", "Continue? [y/N] ", "> "), or names Enter or a yes/no choice
// ("Press Enter when done"), and nothing came for PROMPT_QUIET_MS. Then the run waits for input (needs
// you) until output comes again. A run quiet for QUIET_HINT_MS without such a line only may wait: a quiet
// hint, never needs you.
export const PROMPT_QUIET_MS = 1000;
export const QUIET_HINT_MS = 10_000;
const TAIL_KEEP = 2048;

export function looksLikePrompt(text: string): boolean {
  const t = plainText(text);
  const open = t !== '' && !t.endsWith('\n');
  const last = t.replace(/\n+$/, '').split('\n').pop() ?? '';
  if (/\b(?:press|hit) (?:enter|return|any key)\b|[[(](?:y\/n|yes\/no)[\])]/i.test(last)) return true;
  return open && /[:?>]\s*$/.test(last);
}

export type InputState = { waiting: boolean; quiet: boolean; waitedAt: number | null };
export type InputWatchOptions = { promptMs?: number; hintMs?: number; now?: () => number; onChange: (s: InputState) => void };

// Watches one run's output for the rule above. take() each chunk as it comes; stop() at its end.
export class InputWatch {
  readonly state: InputState = { waiting: false, quiet: false, waitedAt: null };
  private o: InputWatchOptions;
  private tails = { out: '', err: '' };
  private last: 'out' | 'err' = 'out';
  private promptTimer: NodeJS.Timeout | null = null;
  private hintTimer: NodeJS.Timeout | null = null;
  private over = false;

  constructor(o: InputWatchOptions) {
    this.o = o;
    this.arm();
  }

  take(stream: 'out' | 'err', chunk: string): void {
    if (this.over) return;
    this.tails[stream] = (this.tails[stream] + chunk).slice(-TAIL_KEEP);
    this.last = stream;
    const was = this.state.waiting || this.state.quiet;
    this.state.waiting = false;
    this.state.quiet = false;
    this.arm();
    if (was) this.o.onChange(this.state);
  }

  stop(): void {
    this.over = true;
    for (const t of [this.promptTimer, this.hintTimer]) if (t) clearTimeout(t);
    this.state.waiting = false;
    this.state.quiet = false;
  }

  private arm(): void {
    for (const t of [this.promptTimer, this.hintTimer]) if (t) clearTimeout(t);
    this.promptTimer = setTimeout(() => {
      this.promptTimer = null;
      if (this.over || !looksLikePrompt(this.tails[this.last])) return;
      this.state.waiting = true;
      this.state.quiet = false;
      this.state.waitedAt ??= (this.o.now ?? Date.now)();
      this.o.onChange(this.state);
    }, this.o.promptMs ?? PROMPT_QUIET_MS);
    this.hintTimer = setTimeout(() => {
      this.hintTimer = null;
      if (this.over || this.state.waiting) return;
      this.state.quiet = true;
      this.o.onChange(this.state);
    }, this.o.hintMs ?? QUIET_HINT_MS);
    this.promptTimer.unref?.();
    this.hintTimer.unref?.();
  }
}
