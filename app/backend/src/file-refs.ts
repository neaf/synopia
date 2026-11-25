// File paths named in Claude's replies (R5.9, 2026-11-25): the page finds inline code spans that look like
// paths (md.js pathCandidate) and asks once per render with `resolvePaths {sid, paths}`. Each is resolved
// against the session's folder (relative) or home (`~/…`), one stat each, and the answer is only whether it
// is there and whether it is a file or a folder: `pathState {sid, states: [{p, path, kind}]}`, `kind` null
// when it isn't (or is inside a folder macOS protects, unless the session works there: a stat there can bring
// a privacy prompt, folders.ts isProtected). Nothing is read or opened here: a ⌘-click goes through the
// `preview` and `open` requests and their checks. The one read is an image the page shows in its viewer
// (`GET /api/image` with ref `file:<abs>`): only a regular file this resolver answered as a file for that
// session, with an image extension on its name and its real path, at most MAX_IMAGE bytes, whose bytes are a
// served image type.
import fs from 'node:fs';
import path from 'node:path';
import { isProtected } from './folders.ts';
import { SERVED_IMAGE_TYPES } from './transcript.ts';

export const MAX_PATHS = 200; // one request's candidates
export const MAX_LEN = 1024;
export const MAX_IMAGE = 20 * 1024 * 1024;
const KNOWN_MAX = 2000; // files answered per session, for the image check
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

export type Kind = 'file' | 'folder';
export type PathState = { p: string; path: string | null; kind: Kind | null };
export type Stat = (p: string) => Promise<fs.Stats>;

// A candidate to an absolute path: `~/…` under home, `/…` as is, anything else under cwd. null when
// there's nothing it could mean.
export function absOf(p: string, cwd: string, home: string): string | null {
  if (typeof p !== 'string' || !p || p.length > MAX_LEN || p.includes('\0')) return null;
  if (p === '~' || p.startsWith('~/')) return home ? path.resolve(home, p.slice(2)) : null;
  if (p.startsWith('/')) return path.resolve(p);
  return cwd && path.isAbsolute(cwd) ? path.resolve(cwd, p) : null;
}

// The image type of the first bytes, or null.
export function sniffImage(b: Buffer): string | null {
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export class FileRefs {
  private known = new Map<string, Set<string>>(); // sid -> absolute paths answered as files
  private o: { home: string; stat?: Stat };
  constructor(o: { home: string; stat?: Stat }) { this.o = o; }

  async resolve(sid: string, cwd: string, paths: unknown[]): Promise<PathState[]> {
    const stat = this.o.stat ?? ((p: string) => fs.promises.stat(p));
    const out: PathState[] = [];
    const seen = new Set<string>();
    for (const p of paths) {
      if (out.length >= MAX_PATHS) break;
      if (typeof p !== 'string' || seen.has(p)) continue;
      seen.add(p);
      const abs = absOf(p, cwd, this.o.home);
      if (!abs || (isProtected(abs, this.o.home) && !isProtected(cwd, this.o.home))) { out.push({ p, path: null, kind: null }); continue; }
      let kind: Kind | null = null;
      try {
        const st = await stat(abs);
        kind = st.isFile() ? 'file' : st.isDirectory() ? 'folder' : null;
      } catch { /* missing */ }
      if (kind === 'file') this.remember(sid, abs);
      out.push({ p, path: kind ? abs : null, kind });
    }
    return out;
  }

  private remember(sid: string, abs: string) {
    let s = this.known.get(sid);
    if (!s) this.known.set(sid, (s = new Set()));
    s.delete(abs); s.add(abs);
    if (s.size > KNOWN_MAX) s.delete(s.values().next().value as string);
  }

  forget(sid: string) { this.known.delete(sid); }

  // GET /api/image with ref `file:<abs>`: the image, or 404 (not one this session's paths named) or 415.
  async image(sid: string, ref: string): Promise<{ status: 200; type: string; body: Buffer } | { status: 404 | 415 }> {
    const abs = ref.slice('file:'.length);
    if (!path.isAbsolute(abs) || !this.known.get(sid)?.has(abs)) return { status: 404 };
    try {
      const st = await fs.promises.stat(abs);
      const real = await fs.promises.realpath(abs);
      if (!st.isFile() || st.size > MAX_IMAGE) return { status: 404 };
      if (!IMAGE_EXT.has(path.extname(abs).toLowerCase()) || !IMAGE_EXT.has(path.extname(real).toLowerCase())) return { status: 415 };
      const body = await fs.promises.readFile(real);
      const type = sniffImage(body);
      if (!type || !SERVED_IMAGE_TYPES.includes(type)) return { status: 415 };
      return { status: 200, type, body };
    } catch {
      return { status: 404 };
    }
  }
}
