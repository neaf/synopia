// Credential refresh (R8.2, FR-STAT-02, 2026-11-26), the one owner: each folder's refresh command, the run of
// it, and what the page shows of it. A session whose model sign-in expired (status.ts signed out: an
// authentication failure the CLI retries, or a reply that failed on it) joins its folder, the git root of
// its folder, else the folder itself. With a command saved for that folder (state.json `refresh`), Synopia
// runs it once for that expiry, shared by every session of the folder: `zsh -lc <command>` in the folder,
// in one pseudo-terminal for the whole run (pty.ts), so a sign-in that prints a code, opens the browser or
// asks for Enter works. It is a run like any other (2026-11-26): its preview in the dock line, its card (runs.ts
// cardAt) with the lock, its output, input and stop in its shell view. While it waits for input (pty.ts
// InputWatch) its sessions read "Needs you, sign-in expired" again, not refreshing. Exit 0: the sessions'
// sign-in clears and the CLI's next retry takes the new credentials (it reloads them after a credential
// error); a session whose turn already failed on them resumes it once (session.ts credentialsRefreshed). A failure, or no command yet: the session needs you, and the dock
// line offers the command to save (prefilled with the folder's `awsAuthRefresh` setting, else an
// executable bin/aws-login there, else empty). Saving runs it at once; saving it empty clears it.
// The command's output is only sent to the pages, never logged nor stored. Claude Code's own
// `awsAuthRefresh` is left as it is (docs/Agent SDK.md, live run AR-1).
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PtyRun, PtyStart } from './pty.ts';
import { InputWatch, plainText } from './pty.ts';
import { cardAt } from './runs.ts';
import type { Log } from './log.ts';
import { nullLog } from './log.ts';
import { sentence } from './mcp.ts';

export const RUN_TIMEOUT_MS = 10 * 60_000; // a browser sign-in waits on you
// A sign-in that expires again this soon after a refresh that succeeded doesn't run it again (no loop).
export const AGAIN_MS = 60_000;
const OUT_CAP = 16 * 1024;

// ask: no command saved; running; failed: the last run failed (or the credentials still fail); idle: nothing.
export type Phase = 'idle' | 'ask' | 'running' | 'failed';
// `at`: when the run started (ms, 0 with none); `waiting`, `quiet`: pty.ts InputWatch's; `cardAt`: runs.ts.
export type CredsFrame = { t: 'creds'; root: string; sids: string[]; phase: Phase; command: string; output: string; error: string; at: number; waiting: boolean; quiet: boolean; cardAt: number | null };

export type CredsDeps = {
  start: PtyStart;
  commands: Record<string, string>; // state.json `refresh`, by folder
  saved: () => void; // the store writes it
  prefill: (cwd: string, root: string) => Promise<string>;
  rootOf: (cwd: string) => Promise<string>;
  send: (msg: CredsFrame) => void; // to every page
  refreshing: (sids: string[], on: boolean) => void; // their status (status.ts setRefreshing)
  refreshed: (sids: string[]) => void; // their sign-in works again (status.ts credentialsRefreshed)
  log?: Log;
  shell?: string;
  now?: () => number;
  timeoutMs?: number;
  againMs?: number; // AGAIN_MS (checks: shorter)
  promptMs?: number; // pty.ts PROMPT_QUIET_MS
  hintMs?: number; // pty.ts QUIET_HINT_MS
};

type Folder = { root: string; sids: Set<string>; phase: Phase; prefill: string; output: string; error: string; okAt: number; run: PtyRun | null; at: number; watch: InputWatch | null };

// The folder a session's credentials are refreshed for: the git root of `cwd` (a `.git` folder or file),
// else `cwd`.
export async function gitRoot(cwd: string): Promise<string> {
  for (let d = cwd; ; d = dirname(d)) {
    try {
      await stat(join(d, '.git'));
      return d;
    } catch { /* not here */ }
    if (dirname(d) === d) return cwd;
  }
}

// The first guess at a folder's command: its `awsAuthRefresh` (sdk.ts awsAuthRefreshOf), else bin/aws-login
// when the folder has it executable, else ''.
export async function guessCommand(cwd: string, root: string, awsAuthRefresh: (cwd: string) => Promise<string>): Promise<string> {
  const set = await awsAuthRefresh(cwd);
  if (set) return set;
  try {
    await access(join(root, 'bin/aws-login'), constants.X_OK);
    return 'bin/aws-login';
  } catch {
    return '';
  }
}

// What the page shows of a run's output: no escape sequences, no carriage returns, the last 16 KB.
export function screenText(s: string): string {
  const t = plainText(s);
  return t.length > OUT_CAP ? t.slice(-OUT_CAP) : t;
}

export class Creds {
  private d: CredsDeps;
  private log: Log;
  private folders = new Map<string, Folder>();
  private bySid = new Map<string, string>(); // sid -> root

  constructor(d: CredsDeps) {
    this.d = d;
    this.log = d.log ?? nullLog;
  }

  // A session's sign-in expired (`on`), or works again.
  async signedOut(sid: string, cwd: string, on: boolean): Promise<void> {
    if (!on) { this.leave(sid); return; }
    const f = await this.folderOf(sid, cwd);
    if (f.sids.has(sid) && f.phase !== 'idle') return;
    f.sids.add(sid);
    if (f.run) { if (!f.watch?.state.waiting) this.d.refreshing([sid], true); this.publish(f); return; }
    const cmd = this.d.commands[f.root];
    if (!cmd) { await this.ask(f, cwd); return; }
    if (f.phase === 'failed') { this.publish(f); return; } // waits for your Save
    if (f.okAt && this.now() - f.okAt < (this.d.againMs ?? AGAIN_MS)) {
      f.phase = 'failed';
      f.error = 'The refresh command succeeded, but the credentials still fail.';
      this.publish(f);
      return;
    }
    this.run(f, cmd);
  }

  // Save on the dock line: the folder's command, run at once; empty clears it.
  async save(sid: string, cwd: string, command: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const f = await this.folderOf(sid, cwd);
    if (f.run) return { ok: false, error: 'The refresh command is still running.' };
    const cmd = command.trim();
    f.sids.add(sid);
    if (!cmd) {
      delete this.d.commands[f.root];
      this.d.saved();
      this.log('creds.cleared', { sid });
      f.prefill = '';
      f.phase = 'ask';
      f.error = '';
      this.publish(f);
      return { ok: true };
    }
    this.d.commands[f.root] = cmd;
    this.d.saved();
    this.log('creds.saved', { sid });
    this.run(f, cmd);
    return { ok: true };
  }

  // A line typed into the running command (Enter sends it with a newline).
  input(sid: string, text: string): { ok: true } | { ok: false; error: string } {
    const f = this.runningFor(sid);
    if (!f?.run) return { ok: false, error: 'No refresh command is running.' };
    f.run.write(text.replace(/[\r\n]+/g, ' ') + '\n');
    return { ok: true };
  }

  cancel(sid: string): { ok: true } | { ok: false; error: string } {
    const f = this.runningFor(sid);
    if (!f?.run) return { ok: false, error: 'No refresh command is running.' };
    this.log('creds.cancel', { sid });
    f.run.kill();
    return { ok: true };
  }

  // The session closed.
  forget(sid: string): void {
    this.leave(sid);
  }

  // What a page that connects is sent.
  frames(): CredsFrame[] {
    return [...this.folders.values()].filter((f) => f.sids.size && f.phase !== 'idle').map((f) => this.frame(f));
  }

  stop(): void {
    for (const f of this.folders.values()) f.run?.kill();
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private runningFor(sid: string): Folder | null {
    const root = this.bySid.get(sid);
    return root ? this.folders.get(root) ?? null : null;
  }

  private async folderOf(sid: string, cwd: string): Promise<Folder> {
    const root = await this.d.rootOf(cwd);
    const was = this.bySid.get(sid);
    if (was && was !== root) this.leave(sid);
    this.bySid.set(sid, root);
    let f = this.folders.get(root);
    if (!f) this.folders.set(root, f = { root, sids: new Set(), phase: 'idle', prefill: '', output: '', error: '', okAt: 0, run: null, at: 0, watch: null });
    return f;
  }

  private async ask(f: Folder, cwd: string): Promise<void> {
    if (f.phase !== 'ask') {
      f.phase = 'ask';
      f.error = '';
      f.prefill = await this.d.prefill(cwd, f.root);
    }
    this.publish(f);
  }

  private leave(sid: string): void {
    const root = this.bySid.get(sid);
    if (!root) return;
    this.bySid.delete(sid);
    const f = this.folders.get(root);
    if (!f || !f.sids.delete(sid)) return;
    if (f.run && !f.watch?.state.waiting) this.d.refreshing([sid], false);
    if (!f.sids.size && !f.run) { f.phase = 'idle'; f.error = ''; f.output = ''; }
    this.publish(f);
  }

  private run(f: Folder, command: string): void {
    f.phase = 'running';
    f.error = '';
    f.output = '';
    let raw = '';
    f.at = this.now();
    this.log('creds.run', { sessions: f.sids.size });
    // waiting for input: needs you again (signed out), until output comes
    const watch = new InputWatch({ now: () => this.now(), promptMs: this.d.promptMs, hintMs: this.d.hintMs, onChange: (st) => {
      if (f.watch !== watch) return;
      this.d.refreshing([...f.sids], !st.waiting);
      this.publish(f);
    } });
    f.watch = watch;
    const run = this.d.start(command, {
      cwd: f.root, shell: this.d.shell, timeoutMs: this.d.timeoutMs ?? RUN_TIMEOUT_MS,
      onData: (text) => {
        watch.take('out', text); // output again: no longer waiting
        raw = (raw + text).slice(-4 * OUT_CAP);
        f.output = screenText(raw);
        this.publish(f);
      },
    });
    f.run = run;
    this.d.refreshing([...f.sids], true);
    this.publish(f);
    void run.done.then(({ code, timedOut, killed }) => {
      f.run = null;
      watch.stop();
      f.watch = null;
      const sids = [...f.sids];
      this.d.refreshing(sids, false);
      if (code === 0) {
        this.log('creds.done', { ok: true });
        f.okAt = this.now();
        f.phase = 'idle';
        f.output = '';
        this.d.refreshed(sids); // their sign-in clears: leave() takes them out
        if (!f.sids.size) f.phase = 'idle';
        this.publish(f);
        return;
      }
      this.log('creds.done', { ok: false, code: code ?? 'none', timedOut });
      const last = sentence(f.output).replace(/\.$/, '');
      f.error = timedOut ? `The refresh command didn't finish within ${Math.round((this.d.timeoutMs ?? RUN_TIMEOUT_MS) / 60_000)} minutes.`
        : code === null || killed ? 'The refresh command was stopped.'
          : `The refresh command ended with exit code ${code}${last ? `: ${last}` : ''}.`;
      f.phase = f.sids.size ? 'failed' : 'idle';
      f.output = '';
      this.publish(f);
    });
  }

  private frame(f: Folder): CredsFrame {
    const shown = f.sids.size ? f.phase : 'idle', st = f.watch?.state;
    const running = shown === 'running';
    return { t: 'creds', root: f.root, sids: [...f.sids], phase: shown, command: this.d.commands[f.root] ?? f.prefill, output: running ? f.output : '', error: f.error,
      at: running ? f.at : 0, waiting: running && Boolean(st?.waiting), quiet: running && Boolean(st?.quiet), cardAt: running ? cardAt(f.at, null, st?.waitedAt ?? null) : null };
  }

  private publish(f: Folder): void {
    this.d.send(this.frame(f));
  }
}
