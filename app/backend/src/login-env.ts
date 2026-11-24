// The user's login environment, for a daemon the app started from Finder or the Dock (whose PATH
// is launchd's short one). Once at start, the daemon asks the user's login shell for its
// environment (`$SHELL -l -i -c`, 5 s at most) and merges an allow-list of PATH-like variables
// into its own, so every session it drives, the writer and the menu (all spread process.env) find
// node, gh, Homebrew's and asdf's tools. Only these names are read; values are never logged.
// When the shell fails, Homebrew's folders, the asdf shims and the daemon's own node folder are
// prepended to PATH instead.
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Log } from './log.ts';
import { signalGroup } from './macos.ts';

export const LOGIN_ENV_TIMEOUT_MS = 5000;
// Set once merged, so a successor daemon (which inherits it) doesn't ask again.
export const LOGIN_ENV_FLAG = 'SYNOPIA_LOGIN_ENV';

const NAMES = new Set([
  'PATH', 'MANPATH', 'ASDF_DIR', 'ASDF_DATA_DIR', 'HOMEBREW_PREFIX', 'HOMEBREW_CELLAR', 'HOMEBREW_REPOSITORY',
  'LANG', 'SSH_AUTH_SOCK', 'GOPATH', 'JAVA_HOME', 'PYENV_ROOT', 'NVM_DIR',
]);
export const allowed = (name: string) => NAMES.has(name) || /^LC_[A-Z_]+$/.test(name);

// What follows this marker is `env -0`'s output: the login shell's own start may print anything first.
const MARK = '__SYNOPIA_ENV_BEGIN__';

// The allowed variables of `env -0` output (NUL-separated NAME=value), after the marker when there is one.
export function parseEnv0(out: string): Record<string, string> {
  const at = out.indexOf(MARK + '\0');
  const body = at >= 0 ? out.slice(at + MARK.length + 1) : out;
  const vars: Record<string, string> = {};
  for (const entry of body.split('\0')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const name = entry.slice(0, eq);
    if (allowed(name)) vars[name] = entry.slice(eq + 1);
  }
  return vars;
}

const dirsOf = (p: string | undefined) => (p ?? '').split(':').filter(Boolean);

// The login variables over `env`'s: PATH is the login one, then any of the current folders it lacks.
export function mergeEnv(env: NodeJS.ProcessEnv, login: Record<string, string>): void {
  for (const [k, v] of Object.entries(login)) {
    if (k === 'PATH') {
      const dirs = dirsOf(v);
      env.PATH = [...dirs, ...dirsOf(env.PATH).filter((d) => !dirs.includes(d))].join(':');
    } else {
      env[k] = v;
    }
  }
}

// The fallback when the login shell can't be asked: these folders first, unless PATH has them.
export function fallbackPath(env: NodeJS.ProcessEnv, nodeDir: string, home = homedir()): string {
  const asdf = join(env.ASDF_DATA_DIR || join(home, '.asdf'), 'shims');
  const add = ['/opt/homebrew/bin', '/usr/local/bin', asdf, nodeDir];
  const current = dirsOf(env.PATH);
  return [...add.filter((d, i) => !current.includes(d) && add.indexOf(d) === i), ...current].join(':');
}

export type Capture = (shell: string, timeoutMs: number) => Promise<string | null>;

// The login shell's `env -0` after the marker, or null on an error, a nonzero exit or the timeout
// (its whole process group is killed then). stdin is /dev/null; stderr is dropped.
const captureShell: Capture = (shell, timeoutMs) => new Promise((done) => {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(shell, ['-l', '-i', '-c', `printf '%s\\0' ${MARK}; /usr/bin/env -0`], {
      stdio: ['ignore', 'pipe', 'ignore'], detached: true, env: process.env,
    });
  } catch {
    return done(null);
  }
  const chunks: Buffer[] = [];
  let finished = false;
  const end = (out: string | null) => { if (!finished) { finished = true; clearTimeout(timer); done(out); } };
  const timer = setTimeout(() => {
    signalGroup(child.pid as number, 'SIGKILL');
    end(null);
  }, timeoutMs);
  child.stdout?.on('data', (b: Buffer) => chunks.push(b));
  child.on('error', () => end(null));
  child.on('close', (code) => end(code === 0 ? Buffer.concat(chunks).toString('utf8') : null));
});

// Merges the login environment into `env` (process.env by default). Returns how it went, for the log.
export async function loadLoginEnv(opts: {
  env?: NodeJS.ProcessEnv; log?: Log; capture?: Capture; nodeDir?: string; timeoutMs?: number;
} = {}): Promise<'login' | 'fallback' | 'skipped'> {
  const env = opts.env ?? process.env;
  if (env[LOGIN_ENV_FLAG] === '1') return 'skipped';
  const shell = env.SHELL && env.SHELL.startsWith('/') ? env.SHELL : '/bin/zsh';
  const out = await (opts.capture ?? captureShell)(shell, opts.timeoutMs ?? LOGIN_ENV_TIMEOUT_MS);
  const vars = out === null ? {} : parseEnv0(out);
  const how = vars.PATH ? 'login' : 'fallback';
  if (how === 'login') mergeEnv(env, vars);
  else env.PATH = fallbackPath(env, opts.nodeDir ?? dirname(process.execPath));
  env[LOGIN_ENV_FLAG] = '1';
  opts.log?.('env.login', { how, vars: Object.keys(vars).length });
  return how;
}
