// The read-only file preview (requirements R5.9): `preview {path}` from the page gets back
// `preview {path, display, lang, html, lines, truncated, size}`, the file highlighted by `bat` (GitHub
// theme, or the dark one for `theme: "dark"`) and turned from ANSI colours into escaped HTML spans. Any regular file that looks like text
// (no NUL byte in the first 8 KB) is shown, whatever its extension or execute bit, except images and
// PDFs. Anything else gets today's `open` (the caller's fallback). bat runs through execFile,
// never a shell, on what this module read (at most 2 MB and 5,000 lines) over stdin, 5 s at most.
// Without bat the text is shown plain.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { Log } from './log.ts';
import { nullLog } from './log.ts';

export const MAX_LINES = 5000;
export const MAX_BYTES = 2 * 1024 * 1024;
export const SNIFF_BYTES = 8192;
export const BAT_TIMEOUT_MS = 5000;
const MEDIA = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);

export type PreviewPlan =
  | { ok: true; how: 'preview'; real: string; size: number }
  | { ok: true; how: 'open' } // not text: the caller opens it as `open` would
  | { ok: false; error: string };

const extOf = (p: string) => path.extname(p).toLowerCase();

// Whether the first bytes look like text: no NUL.
export function looksText(head: Buffer): boolean {
  return !head.includes(0);
}

function readHead(p: string, n: number): Buffer {
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(n);
    const got = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, got);
  } finally {
    fs.closeSync(fd);
  }
}

// What a `preview` request gets: the preview, today's `open`, or why neither.
export function planPreview(p: unknown): PreviewPlan {
  if (typeof p !== 'string' || !p) return { ok: false, error: 'Nothing to preview.' };
  if (!path.isAbsolute(p)) return { ok: false, error: `Can't open ${p}: the path is not absolute.` };
  let st: fs.Stats;
  let real: string;
  try {
    st = fs.statSync(p);
    real = fs.realpathSync(p);
  } catch {
    return { ok: false, error: `Can't open ${p}: it no longer exists.` };
  }
  // Viewing runs nothing, so any regular text file previews, scripts and executables included ("Open in
  // app" still goes through open's allow-list). Media (images, PDF) and binaries keep today's `open`.
  if (!st.isFile() || MEDIA.has(extOf(p)) || MEDIA.has(extOf(real))) return { ok: true, how: 'open' };
  let head: Buffer;
  try {
    head = readHead(real, SNIFF_BYTES);
  } catch {
    return { ok: false, error: `Can't read ${p}.` };
  }
  return looksText(head) ? { ok: true, how: 'preview', real, size: st.size } : { ok: true, how: 'open' };
}

// The text to show: at most MAX_BYTES (cut at the last newline) and MAX_LINES lines.
export function capText(buf: Buffer, size: number): { text: string; lines: number; truncated: boolean } {
  let truncated = size > buf.length;
  let b = buf;
  if (truncated) {
    const nl = b.lastIndexOf(0x0a);
    if (nl > 0) b = b.subarray(0, nl + 1);
  }
  let text = b.toString('utf8');
  let lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop(); // the final newline is not a line
  if (lines.length > MAX_LINES) {
    lines = lines.slice(0, MAX_LINES);
    truncated = true;
  }
  text = lines.join('\n');
  return { text, lines: lines.length, truncated };
}

/* ---------- ANSI SGR to HTML ---------- */
const ESC_HTML: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC_HTML[c]);
const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('');
export type Theme = 'light' | 'dark';
export const themeOf = (v: unknown): Theme => (v === 'dark' ? 'dark' : 'light');
// bat has no GitHub Dark theme. Coldark-Dark is the closest of its own (`bat --list-themes`): GitHub Dark's
// blues and purples, and the only one whose every colour, comments included, keeps about 4.3:1 or more on the dark panel
export const BAT_THEME: Record<Theme, string> = { light: 'GitHub', dark: 'Coldark-Dark' };
// The 16 basic colours, as GitHub's light and dark palettes draw them.
const BASIC: Record<Theme, string[]> = {
  light: ['#24292f', '#cf222e', '#116329', '#4d2d00', '#0969da', '#8250df', '#1b7c83', '#6e7781',
    '#57606a', '#a40e26', '#1a7f37', '#633c01', '#218bff', '#a475f9', '#3192aa', '#8c959f'],
  dark: ['#8b949e', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#b1bac4',
    '#9198a1', '#ffa198', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#f0f6fc'],
};
export function color256(n: number, theme: Theme = 'light'): string {
  if (n < 16) return BASIC[theme][n];
  if (n < 232) {
    const v = n - 16, steps = [0, 95, 135, 175, 215, 255];
    return hex(steps[Math.floor(v / 36)], steps[Math.floor(v / 6) % 6], steps[v % 6]);
  }
  const g = 8 + (n - 232) * 10;
  return hex(g, g, g);
}

type Sgr = { fg: string | null; bold: boolean; italic: boolean; underline: boolean };
const plain = (): Sgr => ({ fg: null, bold: false, italic: false, underline: false });

function applySgr(st: Sgr, params: number[], theme: Theme): Sgr {
  const s = { ...st };
  const ps = params.length ? params : [0];
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (p === 0) Object.assign(s, plain());
    else if (p === 1) s.bold = true;
    else if (p === 3) s.italic = true;
    else if (p === 4) s.underline = true;
    else if (p === 22) s.bold = false;
    else if (p === 23) s.italic = false;
    else if (p === 24) s.underline = false;
    else if (p >= 30 && p <= 37) s.fg = BASIC[theme][p - 30];
    else if (p >= 90 && p <= 97) s.fg = BASIC[theme][p - 90 + 8];
    else if (p === 39) s.fg = null;
    else if (p === 38 || p === 48) { // extended colour; the background is not drawn
      let c: string | null = null;
      if (ps[i + 1] === 5) { c = color256(ps[i + 2] ?? 0, theme); i += 2; }
      else if (ps[i + 1] === 2) { c = hex(ps[i + 2] ?? 0, ps[i + 3] ?? 0, ps[i + 4] ?? 0); i += 4; }
      if (p === 38 && c) s.fg = c;
    }
  }
  return s;
}

function styleOf(s: Sgr): string {
  const parts: string[] = [];
  if (s.fg) parts.push(`color:${s.fg}`);
  if (s.bold) parts.push('font-weight:700');
  if (s.italic) parts.push('font-style:italic');
  if (s.underline) parts.push('text-decoration:underline');
  return parts.join(';');
}

// One HTML line per text line ('\n'-joined): every span closes at the end of its line, so the page can
// split on '\n'. Text is escaped; styles are only the colours and weights built above.
export function ansiToHtml(input: string, theme: Theme = 'light'): string {
  const out: string[] = [];
  let st = plain();
  let runs: [string, string][] = []; // [style, text] on this line; neighbours with one style merge
  const flush = () => {
    out.push(runs.map(([css, t]) => (css ? `<span style="${css}">${escapeHtml(t)}</span>` : escapeHtml(t))).join(''));
    runs = [];
  };
  const re = /\x1b\[([0-9;]*)([A-Za-z])/g;
  const emit = (text: string) => {
    if (!text) return;
    text.split('\n').forEach((t, k) => {
      if (k > 0) flush();
      if (!t) return;
      const css = styleOf(st), prev = runs[runs.length - 1];
      if (prev && prev[0] === css) prev[1] += t; else runs.push([css, t]);
    });
  };
  let last = 0;
  for (let m = re.exec(input); m; m = re.exec(input)) {
    emit(input.slice(last, m.index));
    last = re.lastIndex;
    if (m[2] === 'm') st = applySgr(st, m[1] === '' ? [] : m[1].split(';').map((x) => Number(x) || 0), theme);
  }
  // other escape sequences are dropped, and so are stray control characters
  emit(input.slice(last).replace(/\x1b/g, ''));
  flush();
  return out.join('\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

/* ---------- bat ---------- */
export type Bat = { file: string; langs: Map<string, string> } | null;
export type RunBat = (file: string, args: string[], input: string, done: (err: Error | null, out: string) => void) => void;

// COLORTERM=truecolor always: bat's colours (24-bit, which ansiToHtml maps exactly) don't depend on
// the environment the daemon started in.
export const batEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => ({ ...env, COLORTERM: 'truecolor' });

const runBat: RunBat = (file, args, input, done) => {
  const child = execFile(file, args, { shell: false, timeout: BAT_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8', env: batEnv() },
    (err, stdout) => done(err, String(stdout)));
  child.stdin?.on('error', () => {}); // bat gone early: its exit reports it
  child.stdin?.end(input);
};

// bat on PATH, then Homebrew's folders (an app started from the Dock has a short PATH), or null.
export function findBat(env: NodeJS.ProcessEnv = process.env, extra = ['/opt/homebrew/bin', '/usr/local/bin']): string | null {
  const dirs = [...(env.PATH ?? '').split(':').filter(Boolean), ...extra];
  for (const d of dirs) {
    const f = path.join(d, 'bat');
    try {
      fs.accessSync(f, fs.constants.X_OK);
      if (fs.statSync(f).isFile()) return f;
    } catch { /* next */ }
  }
  return null;
}

// "Name:ext,ext" lines of `bat --list-languages`, keyed by lower-case extension or file name.
export function parseLanguages(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of text.split('\n')) {
    const i = l.lastIndexOf(':');
    if (i <= 0) continue;
    const name = l.slice(0, i);
    for (const k of l.slice(i + 1).split(',')) if (k && !k.includes('*') && !m.has(k.toLowerCase())) m.set(k.toLowerCase(), name);
  }
  return m;
}

// Finds bat and reads its language names once, at startup.
export function loadBat(opts: { log?: Log; file?: string | null } = {}): Promise<Bat> {
  const log = opts.log ?? nullLog;
  const file = opts.file === undefined ? findBat() : opts.file;
  if (!file) { log('preview.noBat', {}); return Promise.resolve(null); }
  return new Promise((resolve) => {
    execFile(file, ['--no-config', '--list-languages', '--color=never'], { shell: false, timeout: BAT_TIMEOUT_MS, encoding: 'utf8' }, (err, out) => {
      if (err) { log('preview.noBat', {}); resolve(null); return; }
      resolve({ file, langs: parseLanguages(String(out)) });
    });
  });
}

export function langOf(p: string, bat: Bat): string {
  const base = path.basename(p).toLowerCase(), ext = extOf(p).slice(1);
  return bat?.langs.get(base) ?? (ext ? bat?.langs.get(ext) : undefined) ?? 'Plain text';
}

export function batArgs(p: string, truncated: boolean, theme: Theme = 'light'): string[] {
  return ['--no-config', '--color=always', `--theme=${BAT_THEME[theme]}`, '--style=plain', '--paging=never', '--wrap=never',
    ...(truncated ? [`--line-range=:${MAX_LINES}`] : []), `--file-name=${path.basename(p)}`, '-'];
}

export type PreviewReply = { t: 'preview'; path: string; display: string; lang: string; html: string; lines: number; truncated: boolean; size: number };
export type PreviewOpened = { t: 'preview'; path: string; opened: true };

// Reads, caps and highlights a planned file. Plain escaped text when bat is missing, fails or times out.
export function render(
  p: string, real: string, size: number,
  opts: { bat: Bat; theme?: Theme; display?: (p: string) => string; run?: RunBat; log?: Log },
): Promise<PreviewReply> {
  const log = opts.log ?? nullLog;
  const fd = fs.openSync(real, 'r');
  let buf: Buffer;
  try {
    buf = Buffer.alloc(Math.min(size, MAX_BYTES));
    buf = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0));
  } finally {
    fs.closeSync(fd);
  }
  const { text, lines, truncated } = capText(buf, size);
  const base = { t: 'preview' as const, path: p, display: opts.display ? opts.display(p) : p, lang: langOf(p, opts.bat), lines, truncated, size };
  const plainReply = (): PreviewReply => ({ ...base, html: escapeHtml(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '') });
  if (!opts.bat) return Promise.resolve(plainReply());
  const bat = opts.bat;
  return new Promise((resolve) => {
    (opts.run ?? runBat)(bat.file, batArgs(p, truncated, opts.theme), text, (err, out) => {
      if (err) { log('preview.batFailed', { killed: Boolean((err as { killed?: boolean }).killed) }); resolve(plainReply()); return; }
      resolve({ ...base, html: ansiToHtml(out.replace(/\n$/, ''), opts.theme) });
    });
  });
}

// The `preview` message: a preview reply; a file that isn't text is opened as `open` would, and the reply
// says so (`opened`), so the page stops waiting for it (seams#B8); or a toast.
export async function previewFile(
  p: unknown,
  opts: { bat: Bat; theme?: Theme; display?: (p: string) => string; run?: RunBat; log?: Log; open: (p: string) => void; reply: (msg: PreviewReply | PreviewOpened) => void; toast: (text: string) => void },
): Promise<void> {
  const log = opts.log ?? nullLog;
  const plan = planPreview(p);
  if (!plan.ok) { log('preview.refused', {}); opts.toast(plan.error); return; }
  if (plan.how === 'open') { log('preview.open', {}); opts.open(p as string); opts.reply({ t: 'preview', path: p as string, opened: true }); return; }
  try {
    const r = await render(p as string, plan.real, plan.size, opts);
    log('preview', { lines: r.lines, truncated: r.truncated, bat: Boolean(opts.bat) });
    opts.reply(r);
  } catch {
    log('preview.failed', {});
    opts.toast(`Can't read ${p}.`);
  }
}
