// state.json: the open sessions, the layout, reviewed marks, models, session
// rules, written text, settings and the page's ui state. Loaded once, kept in memory, and written
// atomically (temp file, then rename) at most once per second.
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Log } from './log.ts';
import { nullLog } from './log.ts';
import { normalizeUi } from './ui.ts';
import type { UiState } from './ui.ts';

export type OpenEntry = { id: string; cwd: string; openedAt: number; closedAt: number | null };
export type Group = { id: string; name: string; ids: string[] };
export type Layout = { groups: Group[]; others: string[] };
// `newSessionCwd`: the folder of new sessions when set (else newSessionFolder's default).
// `model`: the model of new sessions when set (else the CLI's default).
export type Settings = { newSessionCwd?: string; writerModel: string; model?: string };

// The subagents marked reviewed (R10.2), newest last: the oldest go past this many (backend-core#B5).
export const REVIEWED_MAX = 1000;

export type State = {
  version: 1;
  open: OpenEntry[];
  layout: Layout;
  reviewed: string[];
  models: Record<string, { model: string; effort?: string }>;
  rules: Record<string, string[]>;
  answers: Record<string, string>;
  // Final: the plan text each answered plan card showed, per ExitPlanMode tool use.
  plans: Record<string, string>;
  status: Record<string, { status: string; at: number }>;
  // Slice 5: when each session's last process ended (ms), so its background work then reads as stopped.
  ended: Record<string, number>;
  // Final: that end was a process failure, so a tool left without a result reads as failed.
  endedFailed: Record<string, boolean>;
  // `history`: the titles the writer gave, oldest first (at most 50), for the transcript's title items.
  written: Record<string, { title?: string; now?: string; at: number; history?: { title: string; at: number }[] }>;
  settings: Settings;
  // The page's UI state, restored after a reload, a crash or a quit (ui.ts).
  ui: UiState;
};

export function defaultState(): State {
  return {
    version: 1,
    open: [],
    layout: { groups: [], others: [] },
    reviewed: [],
    models: {},
    rules: {},
    answers: {},
    plans: {},
    status: {},
    written: {},
    ended: {},
    endedFailed: {},
    settings: { writerModel: 'haiku' },
    ui: { sessions: {} },
  };
}

// The folder a new session opens in (R3.3): the stored setting, else the folder of the most
// recently opened session, else the home folder.
export function newSessionFolder(state: State): string {
  if (state.settings.newSessionCwd) return state.settings.newSessionCwd;
  let last: OpenEntry | null = null;
  for (const e of state.open) if (!last || e.openedAt > last.openedAt) last = e;
  return last ? last.cwd : '~';
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function cleanLayout(v: unknown): Layout {
  const out: Layout = { groups: [], others: [] };
  if (!isObj(v)) return out;
  if (Array.isArray(v.groups)) {
    for (const g of v.groups) {
      if (isObj(g) && typeof g.id === 'string' && typeof g.name === 'string' && isStrArr(g.ids)) {
        out.groups.push({ id: g.id, name: g.name, ids: [...g.ids] });
      }
    }
  }
  if (isStrArr(v.others)) out.others = [...v.others];
  return out;
}

// Fills every missing or malformed top-level field with its default, so a
// state file from an older or partial write still loads.
export function normalize(raw: unknown): State {
  const s = defaultState();
  if (!isObj(raw)) return s;
  if (Array.isArray(raw.open)) {
    s.open = raw.open.filter(
      (e): e is OpenEntry => isObj(e) && typeof e.id === 'string' && typeof e.cwd === 'string',
    ).map((e) => ({
      id: e.id,
      cwd: e.cwd,
      openedAt: typeof e.openedAt === 'number' ? e.openedAt : 0,
      closedAt: typeof e.closedAt === 'number' ? e.closedAt : null,
    }));
  }
  s.layout = cleanLayout(raw.layout);
  if (isStrArr(raw.reviewed)) s.reviewed = raw.reviewed.slice(-REVIEWED_MAX);
  for (const k of ['models', 'rules', 'answers', 'plans', 'status', 'written', 'ended', 'endedFailed'] as const) {
    if (isObj(raw[k])) (s as Record<string, unknown>)[k] = raw[k];
  }
  for (const w of Object.values(s.written)) {
    if (!isObj(w) || w.history === undefined) continue;
    w.history = Array.isArray(w.history) ? w.history.filter((h) => isObj(h) && typeof h.title === 'string' && typeof h.at === 'number') : [];
  }
  s.ui = normalizeUi(raw.ui);
  if (isObj(raw.settings)) {
    const st = raw.settings;
    if (typeof st.newSessionCwd === 'string' && st.newSessionCwd) s.settings.newSessionCwd = st.newSessionCwd;
    if (typeof st.writerModel === 'string') s.settings.writerModel = st.writerModel;
    if (typeof st.model === 'string' && st.model) s.settings.model = st.model;
  }
  return s;
}

// Reconciles a layout sent by the page with the stored one (section 11):
// - ids are kept only for sessions in `open`, each once (first place wins);
// - closed ids the page doesn't show stay in their stored group, hidden, at
//   their place after the id that preceded them, so a reopened session
//   keeps its place;
// - open ids found nowhere go to "Not in a group" (`others`);
// - a group is dropped only when it has no ids at all, hidden ones included.
export function reconcileLayout(incoming: Layout, stored: Layout, open: OpenEntry[]): Layout {
  const closed = new Set(open.filter((e) => e.closedAt !== null).map((e) => e.id));
  const known = new Set(open.map((e) => e.id));
  const seen = new Set<string>();
  const take = (ids: string[]) =>
    ids.filter((id) => {
      if (!known.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });

  const inc = cleanLayout(incoming);
  const groups: Group[] = inc.groups.map((g) => ({ id: g.id, name: g.name, ids: take(g.ids) }));
  const others = take(inc.others);

  // Put back hidden (closed) ids the page left out, where they were stored.
  const restore = (target: string[], storedIds: string[]) => {
    storedIds.forEach((id, i) => {
      if (!closed.has(id) || seen.has(id)) return;
      seen.add(id);
      let at = 0;
      for (let j = i - 1; j >= 0; j--) {
        const k = target.indexOf(storedIds[j]);
        if (k !== -1) { at = k + 1; break; }
      }
      target.splice(at, 0, id);
    });
  };
  for (const sg of stored.groups) {
    let g = groups.find((x) => x.id === sg.id);
    if (!g && sg.ids.some((id) => closed.has(id) && !seen.has(id))) {
      g = { id: sg.id, name: sg.name, ids: [] };
      groups.push(g);
    }
    if (g) restore(g.ids, sg.ids);
  }
  restore(others, stored.others);

  for (const e of open) {
    if (!seen.has(e.id) && e.closedAt === null) {
      seen.add(e.id);
      others.push(e.id);
    }
  }
  return { groups: groups.filter((g) => g.ids.length > 0), others };
}

export type Store = {
  state: State;
  path: string;
  changed: () => void;
  flush: () => void;
  close: () => void;
};

export function openStore(stateDir: string, opts: { log?: Log; minIntervalMs?: number } = {}): Store {
  const log = opts.log ?? nullLog;
  const minInterval = opts.minIntervalMs ?? 1000;
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, 'state.json');
  const tmp = join(stateDir, `state.json.tmp-${process.pid}`);

  let state = defaultState();
  try {
    state = normalize(JSON.parse(readFileSync(path, 'utf8')));
    log('store.loaded');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      log('store.new');
    } else {
      // Unreadable or not JSON: keep it aside rather than overwrite it.
      const aside = `${path}.bad-${Date.now()}`;
      try { renameSync(path, aside); } catch { /* ignore */ }
      log('store.bad', { code: code ?? 'parse' });
    }
  }

  let timer: NodeJS.Timeout | null = null;
  let lastWrite = 0;
  let dirty = false;

  function write() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty) return;
    dirty = false;
    lastWrite = Date.now();
    try {
      writeFileSync(tmp, JSON.stringify(store.state, null, 2) + '\n', { mode: 0o600 });
      renameSync(tmp, path);
    } catch (e) {
      log('store.writeFailed', { code: (e as NodeJS.ErrnoException).code ?? 'unknown' });
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  const store: Store = {
    state,
    path,
    changed() {
      dirty = true;
      if (timer) return;
      const wait = Math.max(0, lastWrite + minInterval - Date.now());
      timer = setTimeout(write, wait);
    },
    flush: write,
    close() {
      write();
    },
  };
  return store;
}
