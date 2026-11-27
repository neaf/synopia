// Folders for New session and "Continue in a folder" (R3.3, R3.11, R3.13, NFR-13): the only module that
// reads your folders for the folder list, and the one place that writes one.
// - knownFolders: where sessions ran, from Synopia's open list and listSessions(). No disk read.
// - complete: one readdir of the folder typed so far, on Tab. Never recursive, never ahead of you.
// - check: is a named path gone? One stat each, only for paths the page names (rows on screen, the row
//   chosen, the path typed). A path inside a folder macOS protects is checked only when chosen, since a
//   stat there can bring a privacy prompt.
// - create: mkdir -p of the one path typed on the create row. Synopia's only write to your folders.
// Paths come from the page as it shows them (`~/dev/x`, `/tmp/x`); `expand` turns them into absolute ones.
import fs from 'node:fs';
import path from 'node:path';
import { displayPath } from './paths.ts';

// The folders macOS asks about before an app may read them, under home and beside it.
export const PROTECTED_HOME = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Movies', 'Library'];
export const PROTECTED_ROOTS = ['/Volumes'];
export const MAX_NAMES = 500; // a completion lists at most this many child folders

// The disk calls this module makes, injectable so a test can count them.
export type FolderIo = {
  readdir: (p: string) => Promise<fs.Dirent[]>;
  stat: (p: string) => Promise<fs.Stats>;
  mkdir: (p: string) => Promise<unknown>;
};
export const realIo: FolderIo = {
  readdir: (p) => fs.promises.readdir(p, { withFileTypes: true }),
  stat: (p) => fs.promises.stat(p),
  mkdir: (p) => fs.promises.mkdir(p, { recursive: true }),
};

export type Known = { path: string; sessions: number; lastUsed: number };
export type Completion = { path: string; names: string[]; error?: string };
export type FolderState = { path: string; gone: boolean };

const under = (p: string, dir: string) => p === dir || p.startsWith(dir + '/');

// A page path to an absolute one: `~` and `~/…` under home, anything else must be absolute already.
// null for a relative path (there's no folder it could mean).
export function expand(p: string, home: string): string | null {
  const s = p.trim();
  if (s === '~') return home;
  if (s.startsWith('~/')) return path.resolve(home, s.slice(2));
  if (s.startsWith('/')) return path.resolve(s);
  return null;
}

// Inside a folder macOS protects (R3.13): its stat waits until you choose the row.
export function isProtected(abs: string, home: string): boolean {
  return PROTECTED_HOME.some((d) => under(abs, path.join(home, d))) || PROTECTED_ROOTS.some((d) => under(abs, d));
}

// The folders Synopia knows, newest first, with how many sessions ran there and when it was last used.
// From Synopia's open list (`openedAt`) and listSessions() (`lastModified`), a session counted once. Home is
// always in it, last when no session ran there. No folder is read: these are only paths.
export function knownFolders(
  open: { id: string; cwd: string; openedAt: number }[],
  listed: { sessionId: string; cwd?: string; lastModified: number }[],
  home: string,
): Known[] {
  const by = new Map<string, { ids: Set<string>; last: number }>();
  const add = (id: string, cwd: string | undefined, at: number) => {
    if (!cwd) return;
    const key = displayPath(cwd, home);
    let f = by.get(key);
    if (!f) by.set(key, f = { ids: new Set(), last: 0 });
    f.ids.add(id);
    f.last = Math.max(f.last, at || 0);
  };
  for (const s of listed) add(s.sessionId, s.cwd, s.lastModified);
  for (const e of open) add(e.id, e.cwd, e.openedAt);
  const out = [...by].map(([p, f]) => ({ path: p, sessions: f.ids.size, lastUsed: f.last }))
    .sort((a, b) => b.lastUsed - a.lastUsed || a.path.localeCompare(b.path));
  if (!by.has('~')) out.push({ path: '~', sessions: 0, lastUsed: 0 });
  return out;
}

export class Folders {
  private home: string;
  private io: FolderIo;
  private pretend: (abs: string) => boolean;
  // `pretend`: folders taken as there without a stat (the scripted SDK's made-up home, dev and checks only)
  constructor(home: string, io: FolderIo = realIo, pretend: (abs: string) => boolean = () => false) {
    this.home = home;
    this.io = io;
    this.pretend = pretend;
  }

  expand(p: string): string | null {
    return expand(p, this.home);
  }

  // Tab on a typed path: the direct child folders of the folder typed so far (the text up to its last
  // `/`), by one readdir. Files and symlinks aren't listed (telling a symlink's target would be a stat
  // each). `path` in the reply is that folder as the page wrote it.
  async complete(typed: string): Promise<Completion> {
    const cut = typed.lastIndexOf('/');
    const dir = cut < 0 ? typed : typed.slice(0, cut + 1);
    const abs = this.expand(dir === '' ? '/' : dir);
    if (!abs) return { path: dir, names: [], error: 'Type a path that starts with ~ or /.' };
    try {
      const ents = await this.io.readdir(abs);
      const names = ents.filter((e) => e.isDirectory()).map((e) => e.name).sort((a, b) => a.localeCompare(b)).slice(0, MAX_NAMES);
      return { path: dir, names };
    } catch {
      return { path: dir, names: [], error: `There's no folder ${dir} to list.` };
    }
  }

  // Which of the named paths are gone. Inside a protected folder only when `chosen`; others are left out
  // of the reply. One stat per path.
  async check(paths: string[], chosen = false): Promise<FolderState[]> {
    const out: FolderState[] = [];
    for (const p of paths.slice(0, 200)) {
      const abs = this.expand(p);
      if (!abs || (!chosen && isProtected(abs, this.home))) continue;
      out.push({ path: p, gone: !(await this.isDir(abs)) });
    }
    return out;
  }

  async isDir(abs: string): Promise<boolean> {
    if (this.pretend(abs)) return true;
    try {
      return (await this.io.stat(abs)).isDirectory();
    } catch {
      return false;
    }
  }

  // The folder a new or continued session starts in: absolute, and there (made first with `create`). An
  // error to show otherwise.
  async ready(p: string, create: boolean): Promise<{ abs: string } | { error: string }> {
    const abs = this.expand(p);
    if (!abs) return { error: 'Type a folder that starts with ~ or /.' };
    if (create) {
      try {
        await this.io.mkdir(abs); // mkdir -p: this path and the folders above it that are missing, nothing else
      } catch {
        return { error: `Synopia couldn't create the folder ${p}.` };
      }
    }
    return (await this.isDir(abs)) ? { abs } : { error: `There's no folder ${p}.` };
  }
}
