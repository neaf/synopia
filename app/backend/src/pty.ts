// A command run in one pseudo-terminal for its whole run, with its output read live and a line typed
// into it now and then: what a sign-in flow needs (creds.ts runs a credential refresh with it). macOS's
// script(1) gives the pty. Its stdin can't be Node's own pipe, a socket ("tcgetattr/ioctl: Operation not
// supported on socket", MC-2), so `cat` copies Node's pipe into a real one (sh's `|`), which script takes
// (tcgetattr there is ENOTTY, which it allows) and writes on to the pty; the pty's own echo shows what was
// typed. script's exit code comes back on fd 3, then Node ends cat's input. The child runs in its own
// process group, killed whole on a kill or at the timeout. The output is only handed to `onData`: never
// logged nor stored here (a sign-in's can hold a code or a URL). Facts: docs/Claude Code terminals.md,
// "A command in a pseudo-terminal".
import { spawn } from 'node:child_process';

export type PtyEnd = { code: number | null; timedOut: boolean };
export type PtyRun = { write(text: string): void; kill(): void; done: Promise<PtyEnd> };
// `shell -lc command` in `cwd`: a login shell's PATH and profile, as in a terminal.
export type PtyStart = (command: string, o: { cwd: string; onData: (text: string) => void; timeoutMs: number; shell?: string }) => PtyRun;

const SCRIPT = '/usr/bin/script';
const WRAP = `cat | { ${SCRIPT} -q /dev/null "$0" -lc "$1" 3>&-; echo $? >&3; }`;

export const shellPty: PtyStart = (command, o) => {
  const p = spawn('/bin/sh', ['-c', WRAP, o.shell ?? '/bin/zsh', command], { cwd: o.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], detached: true });
  let code: number | null = null, timedOut = false, over = false;
  const kill = () => { if (over) return; try { process.kill(-(p.pid as number), 'SIGTERM'); } catch { /* gone */ } };
  const timer = setTimeout(() => { timedOut = true; kill(); }, o.timeoutMs);
  timer.unref?.();
  p.stdin.on('error', () => { /* cat is gone */ });
  p.stdout.setEncoding('utf8').on('data', (d: string) => o.onData(d));
  p.stderr.setEncoding('utf8').on('data', (d: string) => o.onData(d));
  const status = p.stdio[3] as NodeJS.ReadableStream;
  status.setEncoding('utf8');
  status.on('data', (d: string) => { const n = Number(String(d).trim()); if (Number.isInteger(n)) code = n; p.stdin.end(); });
  const done = new Promise<PtyEnd>((resolve) => {
    p.on('error', () => { /* close follows */ });
    p.on('close', () => { over = true; clearTimeout(timer); resolve({ code: timedOut ? null : code, timedOut }); });
  });
  return {
    write: (text) => { if (!over && p.stdin.writable) p.stdin.write(text); },
    kill,
    done,
  };
};
