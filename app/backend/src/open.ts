// Opens files and URLs for the page: `/usr/bin/open` through execFile,
// never a shell. Paths must be absolute and exist; URLs must be http or https. Only documents,
// media and source code (OPEN_EXT, on a regular file without an execute bit, by its own name and by
// its real path's) open with their default app. Everything else, folders and bundles included, is
// revealed in Finder with `open -R`. An allow-list, because a deny-list misses things that run or
// install (.fileloc, .jar, .webloc, .prefPane, .mobileconfig, …).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { Log } from './log.ts';
import { nullLog } from './log.ts';

export const OPEN = '/usr/bin/open';
// Left out on purpose: .py (the Python Launcher runs it), shell and AppleScript files, and names
// without an extension.
export const OPEN_EXT = new Set([
  'txt', 'md', 'markdown', 'html', 'htm', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'csv', 'tsv', 'json', 'jsonl', 'log',
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'css', 'scss', 'less', 'swift', 'go', 'rs', 'c', 'h', 'cc', 'cpp', 'hpp',
  'm', 'mm', 'java', 'kt', 'kts', 'scala', 'rb', 'php', 'lua', 'sql', 'graphql', 'proto', 'yaml', 'yml', 'toml', 'ini', 'xml',
  'diff', 'patch', 'tex', 'rst', 'vue', 'svelte',
].map((e) => '.' + e));
const opensAsDocument = (p: string) => OPEN_EXT.has(path.extname(p.replace(/\/+$/, '')).toLowerCase());

export type OpenRequest = { path?: unknown; url?: unknown };
export type OpenPlan =
  | { ok: true; how: 'open' | 'reveal' | 'url'; args: string[] }
  | { ok: false; error: string };
export type Exec = (file: string, args: string[], done: (err: Error | null) => void) => void;

// What `open` would run for a request, or why it won't.
export function planOpen(req: OpenRequest): OpenPlan {
  if (typeof req.url === 'string') {
    let u: URL;
    try {
      u = new URL(req.url);
    } catch {
      return { ok: false, error: 'That link is not a valid address.' };
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'Only http and https links open from Synopia.' };
    return { ok: true, how: 'url', args: [u.href] };
  }
  if (typeof req.path !== 'string' || !req.path) return { ok: false, error: 'Nothing to open.' };
  const p = req.path;
  if (!path.isAbsolute(p)) return { ok: false, error: `Can't open ${p}: the path is not absolute.` };
  let st: fs.Stats;
  let real: string;
  try {
    st = fs.statSync(p);
    real = fs.realpathSync(p);
  } catch {
    return { ok: false, error: `Can't open ${p}: it no longer exists.` };
  }
  // a link named notes.txt that points at a .fileloc opens the .fileloc: both names must be documents
  const doc = st.isFile() && (st.mode & 0o111) === 0 && opensAsDocument(p) && opensAsDocument(real);
  return doc ? { ok: true, how: 'open', args: [p] } : { ok: true, how: 'reveal', args: ['-R', p] };
}

const run: Exec = (file, args, done) => {
  execFile(file, args, { shell: false, timeout: 10000 }, (err) => done(err));
};

// Plans and runs it. With dryRun, only logs which branch it took.
export function openTarget(
  req: OpenRequest,
  opts: { exec?: Exec; dryRun?: boolean; log?: Log; onError?: (text: string) => void } = {},
): OpenPlan {
  const log = opts.log ?? nullLog;
  const plan = planOpen(req);
  if (!plan.ok) {
    log('open.refused', {});
    opts.onError?.(plan.error);
    return plan;
  }
  log('open', { how: plan.how, dry: Boolean(opts.dryRun) });
  if (opts.dryRun) return plan;
  (opts.exec ?? run)(OPEN, plan.args, (err) => {
    if (err) {
      log('open.failed', { how: plan.how });
      opts.onError?.('macOS could not open it.');
    }
  });
  return plan;
}
