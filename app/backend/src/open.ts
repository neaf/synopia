// Opens files and URLs for the page (plan sections 2 and 12): `/usr/bin/open` through execFile,
// never a shell. Paths must be absolute and exist; URLs must be http or https. Anything that
// would run something (an app bundle, a script, an installer, a file with an execute bit) is
// revealed in Finder with `open -R`, not opened.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { Log } from './log.ts';
import { nullLog } from './log.ts';

export const OPEN = '/usr/bin/open';
export const REVEAL_EXT = ['.app', '.command', '.terminal', '.tool', '.sh', '.pkg', '.dmg', '.workflow'];

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
  try {
    st = fs.statSync(p);
  } catch {
    return { ok: false, error: `Can't open ${p}: it no longer exists.` };
  }
  const ext = path.extname(p.replace(/\/+$/, '')).toLowerCase();
  const runs = REVEAL_EXT.includes(ext) || (st.isFile() && (st.mode & 0o111) !== 0);
  return runs ? { ok: true, how: 'reveal', args: ['-R', p] } : { ok: true, how: 'open', args: [p] };
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
