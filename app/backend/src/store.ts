// state.json: the open sessions, the layout, reviewed marks, models, session
// rules, written text, settings and the page's ui state. Loaded once, kept in memory, and written
// atomically (temp file, then rename) at most once per second.
import { chmodSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Log } from './log.ts';
import { nullLog } from './log.ts';
import { normalizeUi } from './ui-state.ts';
import type { UiState } from './ui-state.ts';
import { cleanLayout } from './layout.ts';
import type { Layout } from './layout.ts';

export type OpenEntry = { id: string; cwd: string; openedAt: number; closedAt: number | null };
// `newSessionCwd`: the folder of new sessions when set (else newSessionFolder's default).
// `model`: the model of new sessions when set (else the CLI's default).
export type Settings = { newSessionCwd?: string; writerModel: string; model?: string };

// The subagents marked reviewed (R10.2), newest last: the oldest go past this many.
export const REVIEWED_MAX = 1000;
// The answer labels and answered plans kept, newest last: the oldest go past these.
// They label tool items of open or reopened sessions; a plan can be long.
export const ANSWERS_MAX = 2000;
export const PLANS_MAX = 100;

// Sets `rec[key]` as the newest entry and drops the oldest past `max` (key order is insertion order).
export function capRecord<T>(rec: Record<string, T>, key: string, value: T, max: number): void {
  delete rec[key];
  rec[key] = value;
  const keys = Object.keys(rec);
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) delete rec[k];
}
const newest = <T>(rec: Record<string, T>, max: number): Record<string, T> => Object.fromEntries(Object.entries(rec).slice(-max));

export type State = {
  version: 1;
  open: OpenEntry[];
  layout: Layout;
  reviewed: string[];
  models: Record<string, { model: string; effort?: string | null }>;
  rules: Record<string, string[]>;
  answers: Record<string, string>;
  // The plan text each answered plan card showed, per ExitPlanMode tool use.
  plans: Record<string, string>;
  status: Record<string, { status: string; at: number }>;
  // When each session's last process ended (ms), so its background work then reads as stopped.
  ended: Record<string, number>;
  // That end was a process failure, so a tool left without a result reads as failed.
  endedFailed: Record<string, boolean>;
  // `history`: the titles the writer gave, oldest first (at most 50), for the transcript's title items.
  written: Record<string, { title?: string; now?: string; at: number; history?: { title: string; at: number }[] }>;
  settings: Settings;
  // The page's UI state, restored after a reload, a crash or a quit (ui-state.ts).
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
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
// A map section of state.json: each entry through `clean`, those it returns undefined for dropped.
function entries<T>(v: unknown, clean: (x: unknown) => T | undefined): Record<string, T> {
  const out: Record<string, T> = {};
  if (!isObj(v)) return out;
  for (const [k, x] of Object.entries(v)) {
    const c = clean(x);
    if (c !== undefined) out[k] = c;
  }
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
  // Each entry checked: a wrong-shaped one is dropped, not passed on.
  s.models = entries(raw.models, (v) => isObj(v) && typeof v.model === 'string'
    ? { model: v.model, ...(typeof v.effort === 'string' || v.effort === null ? { effort: v.effort } : {}) } : undefined);
  s.rules = entries(raw.rules, (v) => (isStrArr(v) ? [...v] : undefined));
  s.answers = newest(entries(raw.answers, (v) => (typeof v === 'string' ? v : undefined)), ANSWERS_MAX);
  s.plans = newest(entries(raw.plans, (v) => (typeof v === 'string' ? v : undefined)), PLANS_MAX);
  s.status = entries(raw.status, (v) => (isObj(v) && typeof v.status === 'string' && isNum(v.at) ? { status: v.status, at: v.at } : undefined));
  s.ended = entries(raw.ended, (v) => (isNum(v) ? v : undefined));
  s.endedFailed = entries(raw.endedFailed, (v) => (typeof v === 'boolean' ? v : undefined));
  s.written = entries(raw.written, (v) => {
    if (!isObj(v) || !isNum(v.at)) return undefined;
    const w: State['written'][string] = { at: v.at };
    if (typeof v.title === 'string') w.title = v.title;
    if (typeof v.now === 'string') w.now = v.now;
    if (v.history !== undefined) {
      w.history = Array.isArray(v.history) ? v.history.filter((h): h is { title: string; at: number } => isObj(h) && typeof h.title === 'string' && isNum(h.at)) : [];
    }
    return w;
  });
  s.ui = normalizeUi(raw.ui);
  if (isObj(raw.settings)) {
    const st = raw.settings;
    if (typeof st.newSessionCwd === 'string' && st.newSessionCwd) s.settings.newSessionCwd = st.newSessionCwd;
    if (typeof st.writerModel === 'string') s.settings.writerModel = st.writerModel;
    if (typeof st.model === 'string' && st.model) s.settings.model = st.model;
  }
  return s;
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
  let failedWith: string | null = null; // the last write's error code, logged once until a write works

  function arm() {
    if (timer) return;
    const wait = Math.max(0, lastWrite + minInterval - Date.now());
    timer = setTimeout(write, wait);
  }

  // A failed write keeps the state dirty and tries again after the interval.
  function write() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty) return;
    lastWrite = Date.now();
    try {
      writeFileSync(tmp, JSON.stringify(store.state, null, 2) + '\n', { mode: 0o600 });
      chmodSync(tmp, 0o600); // the mode above is masked by the umask (docs/macOS.md#file-modes)
      renameSync(tmp, path);
      dirty = false;
      if (failedWith) log('store.writeOk');
      failedWith = null;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? 'unknown';
      if (code !== failedWith) log('store.writeFailed', { code });
      failedWith = code;
      try { unlinkSync(tmp); } catch { /* ignore */ }
      arm();
    }
  }

  const store: Store = {
    state,
    path,
    changed() {
      dirty = true;
      arm();
    },
    flush: write,
    // The last write, synchronous (a stop or a crash exit); no retry is left armed.
    close() {
      write();
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
  return store;
}

// "Mark reviewed" (R10.2): the marks in state.json `reviewed`, with a set to look them up.
export class ReviewedMarks {
  private store: Store;
  private set: Set<string>;

  constructor(store: Store) {
    this.store = store;
    this.set = new Set(store.state.reviewed);
  }

  has(agentId: string): boolean {
    return this.set.has(agentId);
  }

  // Stores the mark; false when it was there already. The oldest go past REVIEWED_MAX.
  mark(agentId: string): boolean {
    if (this.set.has(agentId)) return false;
    this.store.state.reviewed = [...this.store.state.reviewed, agentId].slice(-REVIEWED_MAX);
    this.set = new Set(this.store.state.reviewed);
    this.store.changed();
    return true;
  }
}
