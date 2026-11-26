// A command run in one pseudo-terminal for its whole run, with its output read live and a line typed
// into it now and then: what a sign-in flow needs (creds.ts runs a credential refresh with it), and a `!`
// command that asks for Enter (bang.ts). macOS's script(1) gives the pty. Its stdin can't be Node's own
// pipe, a socket ("tcgetattr/ioctl: Operation not supported on socket", MC-2), so `cat` copies Node's pipe
// into a real one (sh's `|`), which script takes (tcgetattr there is ENOTTY, which it allows) and writes on
// to the pty; the pty's own echo shows what was typed. Inside the pty a small /bin/sh (the session leader:
// its pid is the command's process group) writes its pid to fd 3, runs `shell -c command` (`-lc` for a
// login shell) and writes the command's exit code to fd 3; it survives a SIGTERM to the group until the
// command ends (a trap with a handler, which the command doesn't inherit), so a TERM reads as 143. A SIGKILL
// takes it too: then script's own code (the signal's number) gives 128 + it. Then Node ends cat's input.
// With `onErr`, the command's stderr goes to its own pipe (fd 4) instead of the terminal. The output is only
// handed to `onData` and `onErr`: never logged nor stored here (a sign-in's can hold a code or a URL).
// Facts: docs/Claude Code terminals.md, "A command in a pseudo-terminal".
import { spawn } from 'node:child_process';

// `code`: the command's exit code (128 + the signal's number when a signal ended it); null when it timed
// out or never ran. `killed`: kill() was called. `error`: it couldn't start (a folder that is gone).
export type PtyEnd = { code: number | null; timedOut: boolean; killed: boolean; error?: string };
export type PtyRun = {
  write(text: string): void;
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
};
export type PtyStart = (command: string, o: PtyOptions) => PtyRun;

const SCRIPT = '/usr/bin/script';
const GRACE_MS = 500; // a child left holding the pipes after the command ended doesn't hold the run open
// inside the pty: $0 shell, $1 -c or -lc, $2 the command, $3 1 when stderr goes to fd 4
// (its own stderr, such as "Terminated: 15", goes nowhere). The command runs as its child `&` with the
// terminal as stdin (fd 6: a `&` list's stdin is /dev/null otherwise), so a TERM that came while it was
// being started still reaches it: the handler passes it on, or ends with 143 when nothing started yet.
const INNER = `exec 5>&2 2>/dev/null 6<&0; trap 'if [ -n "$c" ]; then kill -TERM "$c"; else echo "exit 143" >&3; exit 143; fi' TERM; echo "pid $$" >&3;`
  + ` if [ "$3" = 1 ]; then "$0" "$1" "$2" <&6 2>&4 3>&- 4>&- 5>&- 6<&- & else "$0" "$1" "$2" <&6 2>&5 3>&- 4>&- 5>&- 6<&- & fi;`
  + ` c=$!; wait "$c"; st=$?; while kill -0 "$c"; do wait "$c"; st=$?; done; echo "exit $st" >&3`;
// $0 INNER, then its four arguments
const WRAP = `cat 3>&- 4>&- | { ${SCRIPT} -q /dev/null /bin/sh -c "$0" "$1" "$2" "$3" "$4"; echo "end $?" >&3; }`;

export const shellPty: PtyStart = (command, o) => {
  const args = [WRAP, INNER, o.shell ?? '/bin/zsh', o.login === false ? '-c' : '-lc', command, o.onErr ? '1' : '0'];
  const p = spawn('/bin/sh', ['-c', ...args], { cwd: o.cwd, env: o.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'], detached: true });
  let pid: number | null = null, exit: number | null = null, end: number | null = null;
  let timedOut = false, killed = false, over = false, error: string | undefined;
  let wanted: NodeJS.Signals | null = null; // a kill before the pty reported the group: sent once it does
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
