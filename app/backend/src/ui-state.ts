// The page's UI state (requirements R3.9): what was on screen, so a reload, a crash or a quit comes back
// to it exactly. The page sends `ui {patch}` (debounced); it is kept in state.json `ui` and returned in
// `hello`. Pasted images of a draft are files under <state-dir>/drafts/<sid>/, at most 5 MB each and
// 20 MB per session, removed when the draft no longer lists them (a send clears it). Per-session data
// is pruned when the session closes and moves with it when its id changes. Nothing here is broadcast:
// the last page to write wins.
import fs from 'node:fs';
import path from 'node:path';
import type { Store } from './store.ts';

export const DRAFT_IMAGE_MAX = 5 * 1024 * 1024;
export const DRAFT_SESSION_MAX = 20 * 1024 * 1024;
const BLOB_MAX = 64 * 1024; // a card's state, as JSON
const TEXT_MAX = 1024 * 1024; // a draft's text
const LIST_MAX = 2000;

// where a view was: a block and the pixels into it, `bottom` when it was at its end (then the last block on
// screen); `seen`, the furthest item you saw (its block's key, "run@<offset>" in a shell's output) and `seenAt`
// when you last had it on screen (ms); `newAt`, the item the "New since" line sits above and the time it shows (R5.12d)
export type Anchor = { id?: string; off?: number; bottom?: true; seen?: string; seenAt?: number; newAt?: { id: string; at: number } };
export type DraftImage = { id: string; mediaType: string; size: number; n?: number }; // n: its [Image #n] tag in the text
export type Draft = { text: string; cursor: [number, number]; images: DraftImage[] };
export type UiSession = {
  scroll?: Record<string, Anchor>; // per view: "" for the main conversation, else the agent id
  earlier?: Record<string, string>; // per view: the oldest item id loaded
  steps?: string[]; // "<agent>|<item id>"
  diffs?: string[]; // "<agent>|<diff id>"
  folds?: string[]; // "<agent>|<block key>#<n>"
  draft?: Draft;
  cards?: Record<string, unknown>; // per request id
};
export type UiState = {
  current?: string | null;
  view?: string | null;
  mode?: 'normal' | 'insert';
  openBg?: string | null;
  openList?: { filter: string } | null;
  waitingList?: { filter: string } | null; // the Waiting on you list (R9.10)
  folderList?: { filter: string; sid: string | null } | null; // the folder list (R3.3), and the session it continues (R3.11)
  preview?: { path: string; scroll: number; find: string } | null;
  viewer?: { srcs: string[]; froms?: string[]; i: number } | null;
  theme?: 'light' | 'dark' | null; // the page's theme choice; null follows the system
  sessions: Record<string, UiSession>;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length <= max;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
// A session id or an image id used as a file name: no separators, no dots only.
const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const IMAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg' };

const strList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => str(x, 1024)).slice(0, LIST_MAX) : undefined;
const strMap = (v: unknown): Record<string, string> | undefined => {
  if (!isObj(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) if (str(k, 256) && str(x, 1024)) out[k] = x;
  return out;
};
const blob = (v: unknown): unknown => {
  if (v === undefined) return undefined;
  try {
    const s = JSON.stringify(v);
    return s !== undefined && s.length <= BLOB_MAX ? JSON.parse(s) : undefined;
  } catch {
    return undefined;
  }
};
function anchorOf(v: unknown): Anchor | undefined {
  if (!isObj(v)) return undefined;
  const out: Anchor = {};
  if (v.bottom === true) out.bottom = true;
  if (str(v.id, 1024) && num(v.off)) { out.id = v.id; out.off = Math.round(v.off); }
  if (!out.bottom && out.id === undefined) return undefined;
  if (str(v.seen, 1024)) out.seen = v.seen;
  if (num(v.seenAt)) out.seenAt = Math.round(v.seenAt);
  if (isObj(v.newAt) && str(v.newAt.id, 1024) && num(v.newAt.at)) out.newAt = { id: v.newAt.id, at: Math.round(v.newAt.at) };
  return out;
}

// One session's fields, each checked; unknown fields are dropped. The draft's images are taken as
// stored (no data): drafts with data go through patchUi.
function cleanSession(v: unknown): UiSession {
  const out: UiSession = {};
  if (!isObj(v)) return out;
  if (isObj(v.scroll)) {
    const sc: Record<string, Anchor> = {};
    for (const [k, a] of Object.entries(v.scroll)) { const x = anchorOf(a); if (x && str(k, 256)) sc[k] = x; }
    out.scroll = sc;
  }
  const e = strMap(v.earlier); if (e) out.earlier = e;
  for (const k of ['steps', 'diffs', 'folds'] as const) { const l = strList(v[k]); if (l) out[k] = l; }
  const d = draftOf(v.draft); if (d) out.draft = d;
  if (isObj(v.cards)) {
    const cards: Record<string, unknown> = {};
    for (const [k, c] of Object.entries(v.cards)) { const b = blob(c); if (b !== undefined && str(k, 256)) cards[k] = b; }
    out.cards = cards;
  }
  return out;
}
function draftOf(v: unknown): Draft | undefined {
  if (!isObj(v) || !str(v.text, TEXT_MAX)) return undefined;
  const c = Array.isArray(v.cursor) && num(v.cursor[0]) && num(v.cursor[1]) ? [v.cursor[0], v.cursor[1]] as [number, number] : [v.text.length, v.text.length] as [number, number];
  const images = Array.isArray(v.images)
    ? v.images.filter((im): im is DraftImage => isObj(im) && str(im.id) && IMAGE_ID.test(im.id) && str(im.mediaType) && im.mediaType in EXT)
      .map((im) => ({ id: im.id, mediaType: im.mediaType, size: num(im.size) ? im.size : 0, ...(num(im.n) && Number.isInteger(im.n) && im.n > 0 ? { n: im.n } : {}) }))
    : [];
  return { text: v.text, cursor: c, images };
}

function cleanTop(v: Record<string, unknown>, out: UiState): void {
  if ('current' in v) out.current = str(v.current, 256) ? v.current : null;
  if ('view' in v) out.view = str(v.view, 256) ? v.view : null;
  if (v.mode === 'normal' || v.mode === 'insert') out.mode = v.mode;
  if ('theme' in v) out.theme = v.theme === 'light' || v.theme === 'dark' ? v.theme : null;
  if ('openBg' in v) out.openBg = str(v.openBg, 256) ? v.openBg : null;
  if ('openList' in v) out.openList = isObj(v.openList) && str(v.openList.filter, 1024) ? { filter: v.openList.filter } : null;
  if ('waitingList' in v) out.waitingList = isObj(v.waitingList) && str(v.waitingList.filter, 1024) ? { filter: v.waitingList.filter } : null;
  if ('folderList' in v) {
    const f = v.folderList;
    out.folderList = isObj(f) && str(f.filter, 1024) ? { filter: f.filter, sid: str(f.sid, 256) ? f.sid : null } : null;
  }
  if ('preview' in v) {
    const p = v.preview;
    out.preview = isObj(p) && str(p.path) ? { path: p.path, scroll: num(p.scroll) ? Math.max(0, Math.round(p.scroll)) : 0, find: str(p.find, 1024) ? p.find : '' } : null;
  }
  if ('viewer' in v) {
    const x = v.viewer;
    const srcs = isObj(x) ? (strList(x.srcs) ?? []).filter((s) => s.startsWith('/api/image?')).slice(0, 100) : [];
    // froms: the source each image names in the viewer (a file path, "your message"), by position
    const froms = isObj(x) ? (strList(x.froms) ?? []).slice(0, srcs.length) : [];
    out.viewer = isObj(x) && srcs.length ? { srcs, froms, i: num(x.i) ? Math.min(srcs.length - 1, Math.max(0, Math.round(x.i))) : 0 } : null;
  }
}

// The stored ui of a state file: every field checked, the rest dropped.
export function normalizeUi(raw: unknown): UiState {
  const out: UiState = { sessions: {} };
  if (!isObj(raw)) return out;
  cleanTop(raw, out);
  if (isObj(raw.sessions)) {
    for (const [sid, s] of Object.entries(raw.sessions)) if (SAFE_ID.test(sid)) out.sessions[sid] = cleanSession(s);
  }
  return out;
}

const draftsDir = (store: Store, sid: string) => path.join(path.dirname(store.path), 'drafts', sid);
const imageFile = (store: Store, sid: string, im: { id: string; mediaType: string }) =>
  path.join(draftsDir(store, sid), `${im.id}.${EXT[im.mediaType]}`);

export type PatchOptions = {
  resolve?: (sid: string) => string; // an id the page may still hold, to the session's current one
  known?: (sid: string) => boolean; // an open session: data for any other is dropped
  toast?: (text: string) => void;
};

// Merges a page's patch: a top-level field replaces the stored one; `sessions` merges per session and
// per field, `null` removing a field (or, for a session, all of its data). A draft's image with `data`
// (base64 PNG or JPEG) is written to its file; an image the draft no longer lists loses its file.
export function patchUi(store: Store, patch: unknown, opts: PatchOptions = {}): void {
  if (!isObj(patch)) return;
  const ui = store.state.ui;
  cleanTop(patch, ui);
  if (isObj(patch.sessions)) {
    for (const [raw, v] of Object.entries(patch.sessions)) {
      const sid = opts.resolve ? opts.resolve(raw) : raw;
      if (!SAFE_ID.test(sid)) continue;
      if (v === null) { dropSession(store, sid); continue; }
      if (!isObj(v) || (opts.known && !opts.known(sid))) continue;
      const cur = ui.sessions[sid] ?? {};
      const clean = cleanSession(v);
      for (const k of Object.keys(v)) {
        if (k === 'draft') continue;
        if (v[k] === null) delete (cur as Record<string, unknown>)[k];
        else if (k in clean) (cur as Record<string, unknown>)[k] = (clean as Record<string, unknown>)[k];
      }
      if ('draft' in v) {
        const d = v.draft === null ? undefined : draftOf(v.draft);
        const kept = d ? writeImages(store, sid, d, cur.draft, v.draft as Record<string, unknown>, opts.toast) : [];
        dropImages(store, sid, cur.draft, kept);
        if (d && (d.text || kept.length)) cur.draft = { ...d, images: kept };
        else delete cur.draft;
      }
      if (Object.keys(cur).length) ui.sessions[sid] = cur; else dropSession(store, sid);
    }
  }
  store.changed();
}

// The draft's images as stored after the patch: those already on disk, and the new ones written
// within the caps. A refused one is left out, with a toast.
function writeImages(store: Store, sid: string, d: Draft, was: Draft | undefined, raw: Record<string, unknown>, toast?: (t: string) => void): DraftImage[] {
  const had = new Map((was?.images ?? []).map((im) => [im.id, im]));
  const rawImages = Array.isArray(raw.images) ? raw.images : [];
  const kept: DraftImage[] = [];
  let total = 0;
  for (const im of d.images) {
    const old = had.get(im.id);
    if (old) { kept.push(im.n ? { ...old, n: im.n } : old); total += old.size; continue; }
    const data = (rawImages.find((x) => isObj(x) && x.id === im.id) as Record<string, unknown> | undefined)?.data;
    if (typeof data !== 'string') continue; // listed without its bytes and not stored: nothing to keep
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > DRAFT_IMAGE_MAX) { toast?.("A pasted image is over 5 MB, so it isn't kept with the draft."); continue; }
    if (total + bytes.length > DRAFT_SESSION_MAX) { toast?.('The pasted images are over 20 MB, so the last one isn\'t kept with the draft.'); continue; }
    try {
      fs.mkdirSync(draftsDir(store, sid), { recursive: true, mode: 0o700 });
      fs.writeFileSync(imageFile(store, sid, im), bytes, { mode: 0o600 });
    } catch {
      toast?.("Synopia couldn't keep a pasted image with the draft.");
      continue;
    }
    total += bytes.length;
    kept.push({ id: im.id, mediaType: im.mediaType, size: bytes.length, ...(im.n ? { n: im.n } : {}) });
  }
  return kept;
}
function dropImages(store: Store, sid: string, was: Draft | undefined, kept: DraftImage[]): void {
  const keep = new Set(kept.map((im) => im.id));
  for (const im of was?.images ?? []) if (!keep.has(im.id)) fs.rmSync(imageFile(store, sid, im), { force: true });
  if (!kept.length) fs.rmSync(draftsDir(store, sid), { recursive: true, force: true });
}

// A session's ui data and its draft images go; `current` and `view` stay, so a session whose last
// field emptied (a draft sent, the last step folded) is still the one on screen.
function dropSession(store: Store, sid: string): boolean {
  const had = sid in store.state.ui.sessions;
  delete store.state.ui.sessions[sid];
  if (SAFE_ID.test(sid)) fs.rmSync(draftsDir(store, sid), { recursive: true, force: true });
  return had;
}

// A closed session: its ui data and its draft images go, and it is no longer the one on screen.
export function pruneUi(store: Store, sid: string): void {
  const ui = store.state.ui;
  let had = dropSession(store, sid);
  if (ui.current === sid) { ui.current = null; ui.view = null; had = true; }
  if (had) store.changed();
}

// At start: the ui data and draft images of every session that isn't open go, and a `current`
// that isn't open is no longer the one on screen.
export function pruneUiTo(store: Store, open: (sid: string) => boolean): void {
  const ui = store.state.ui;
  let had = false;
  for (const sid of Object.keys(ui.sessions)) if (!open(sid)) had = dropSession(store, sid) || had;
  if (ui.current && !open(ui.current)) { ui.current = null; ui.view = null; had = true; }
  let folders: string[] = [];
  try {
    folders = fs.readdirSync(path.join(path.dirname(store.path), 'drafts'));
  } catch { /* no drafts yet */ }
  for (const sid of folders) if (SAFE_ID.test(sid) && !(sid in ui.sessions)) fs.rmSync(draftsDir(store, sid), { recursive: true, force: true });
  if (had) store.changed();
}

// The session's id changed (a new session's real id, a /clear): its ui data and draft move with it.
export function rekeyUi(store: Store, oldId: string, newId: string): void {
  const ui = store.state.ui;
  if (ui.current === oldId) ui.current = newId;
  const s = ui.sessions[oldId];
  if (!s || !SAFE_ID.test(oldId) || !SAFE_ID.test(newId)) { store.changed(); return; }
  delete ui.sessions[oldId];
  ui.sessions[newId] = s;
  const from = draftsDir(store, oldId), to = draftsDir(store, newId);
  if (fs.existsSync(from)) {
    fs.rmSync(to, { recursive: true, force: true });
    try { fs.renameSync(from, to); } catch { delete s.draft; }
  }
  store.changed();
}

// GET /api/image with ref `draft:<id>`: a draft's pasted image, for its thumbnail after a restore.
export async function draftImage(store: Store, sid: string, ref: string): Promise<{ status: 200; type: string; body: Buffer } | { status: 404 }> {
  const id = ref.startsWith('draft:') ? ref.slice(6) : '';
  const im = store.state.ui.sessions[sid]?.draft?.images.find((x) => x.id === id);
  if (!im || !SAFE_ID.test(sid)) return { status: 404 };
  try {
    return { status: 200, type: im.mediaType, body: await fs.promises.readFile(imageFile(store, sid, im)) };
  } catch {
    return { status: 404 };
  }
}
