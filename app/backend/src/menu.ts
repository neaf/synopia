// The slash menu and the model list (plan sections 3 and 5): supportedCommands() and
// supportedModels(), per folder. They come from the session's running process when it has
// one; otherwise from a cache filled once per folder by an idle query() with no prompt, which
// makes no model call (it runs the folder's SessionStart hooks, which is accepted). A page gets
// `menu` for a folder the first time it views a session there (once per connection);
// `hello` carries the cache.
import fs from 'node:fs';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { ModelInfo, Options, SDKUserMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type { Client } from './server.ts';
import type { Log } from './log.ts';
import { nullLog } from './log.ts';

export type MenuCommand = { name: string; description: string; hint: string };
export type MenuModel = { value: string; resolved: string | null; name: string; description: string; effort: string[] };
export type FolderMenu = { commands: MenuCommand[]; models: MenuModel[] };
// What the menu reads from a query: the running process's, or the idle one's.
export type MenuSource = { supportedCommands(): Promise<SlashCommand[]>; supportedModels(): Promise<ModelInfo[]> };
export type IdleQuery = MenuSource & { close(): void };
export type IdleQueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => IdleQuery;

export const IDLE_TIMEOUT_MS = 30_000;

// The descriptions come HTML-escaped: `&lt;file&gt;` (docs/Agent SDK.md, "Quirk: command descriptions come HTML-escaped").
export function unescapeHtml(s: string): string {
  return s.replace(/&(lt|gt|quot|#39|apos|amp);/g, (_, e: string) => ({ lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", amp: '&' })[e] as string);
}

// One row per name, sorted by the page; a row Claude Code marks as its own wins a shared name,
// as /name runs that one. Names starting `__` are internal and left out.
export function toCommands(list: SlashCommand[]): MenuCommand[] {
  const byName = new Map<string, SlashCommand>();
  for (const c of list) {
    if (!c || typeof c.name !== 'string' || !c.name || c.name.startsWith('__')) continue;
    const had = byName.get(c.name);
    if (!had || (c.builtin && !had.builtin)) byName.set(c.name, c);
  }
  return [...byName.values()].map((c) => ({
    name: c.name, description: unescapeHtml(c.description || ''), hint: unescapeHtml(c.argumentHint || ''),
  }));
}

export function toModels(list: ModelInfo[]): MenuModel[] {
  return list.filter((m) => m && typeof m.value === 'string').map((m) => ({
    value: m.value, resolved: m.resolvedModel ?? null, name: m.displayName || m.value,
    description: unescapeHtml(m.description || ''), effort: [...(m.supportedEffortLevels ?? [])],
  }));
}

export async function readMenu(src: MenuSource): Promise<FolderMenu> {
  const [commands, models] = await Promise.all([src.supportedCommands(), src.supportedModels()]);
  return { commands: toCommands(commands ?? []), models: toModels(models ?? []) };
}

// A prompt that never yields: the process starts, answers control calls and makes no model call.
function idlePrompt(stop: Promise<void>): AsyncIterable<SDKUserMessage> {
  return { async *[Symbol.asyncIterator]() { await stop; } };
}

export type MenusOptions = {
  clients: () => Set<Client>;
  log?: Log;
  queryFn?: IdleQueryFn; // tests inject a fake; the default is the SDK's query
  timeoutMs?: number;
  // The last model list of each folder, kept across launches, so `hello` names a session's
  // model ("Haiku 5.5") before the folder's menu is read again.
  cacheFile?: string;
};

function loadModels(file: string): Map<string, MenuModel[]> {
  const out = new Map<string, MenuModel[]>();
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return out;
  }
  const models = raw && typeof raw === 'object' ? (raw as { models?: unknown }).models : null;
  if (!models || typeof models !== 'object') return out;
  for (const [folder, list] of Object.entries(models)) {
    if (!Array.isArray(list)) continue;
    const ok = list.filter((m): m is MenuModel => m && typeof m.value === 'string' && typeof m.name === 'string')
      .map((m) => ({ value: m.value, resolved: typeof m.resolved === 'string' ? m.resolved : null, name: m.name,
        description: typeof m.description === 'string' ? m.description : '', effort: Array.isArray(m.effort) ? m.effort.filter((e) => typeof e === 'string') : [] }));
    if (ok.length) out.set(folder, ok);
  }
  return out;
}

export class Menus {
  private opts: MenusOptions;
  private log: Log;
  private cache = new Map<string, FolderMenu>(); // by the folder as the page shows it (`~/…`)
  private loading = new Map<string, Promise<FolderMenu | null>>();
  private sentTo = new WeakMap<Client, Set<string>>();
  private aborts = new Set<AbortController>(); // the idle queries running, aborted at quit
  private seed: Map<string, MenuModel[]>; // the model lists of the last launch (cacheFile)

  constructor(opts: MenusOptions) {
    this.opts = opts;
    this.log = opts.log ?? nullLog;
    this.seed = opts.cacheFile ? loadModels(opts.cacheFile) : new Map();
  }

  // Keeps every folder's last model list (atomically: a temp file, then rename).
  private save(): void {
    const file = this.opts.cacheFile;
    if (!file) return;
    const models: Record<string, MenuModel[]> = Object.fromEntries(this.seed);
    for (const [folder, m] of this.cache) if (m.models.length) models[folder] = m.models;
    try {
      fs.writeFileSync(file + '.tmp', JSON.stringify({ models }));
      fs.renameSync(file + '.tmp', file);
    } catch {
      this.log('menu.saveFailed', {});
    }
  }

  // Quit: the idle queries still reading end with the backend.
  stop(): void {
    for (const ac of this.aborts) ac.abort();
    this.aborts.clear();
  }

  // For `hello`: every folder's menu so far. The page then holds them all.
  // A folder read only at a past launch has its models and no commands yet: the menu read on
  // the first view replaces it.
  all(): Record<string, FolderMenu> {
    const seeded = [...this.seed].filter(([f]) => !this.cache.has(f)).map(([f, models]) => [f, { commands: [], models }]);
    return { ...Object.fromEntries(seeded), ...Object.fromEntries(this.cache) };
  }

  get(folder: string): FolderMenu | undefined {
    return this.cache.get(folder);
  }

  // A page views a session in `folder` (`abs` is the absolute path). With a running process the
  // menu comes from it (and refreshes the folder's); else from the cache, filled once by an idle
  // query. The page gets `menu` when it hasn't got this folder's yet, or when it changed.
  async viewed(client: Client, folder: string, abs: string, proc: MenuSource | null): Promise<void> {
    if (proc) {
      try {
        this.put(folder, await readMenu(proc));
      } catch {
        this.log('menu.processFailed', {});
      }
    }
    if (!this.cache.has(folder)) await this.fill(folder, abs);
    const m = this.cache.get(folder);
    const sent = this.sentTo.get(client) ?? new Set<string>();
    this.sentTo.set(client, sent);
    if (m && !sent.has(folder)) {
      sent.add(folder);
      client.send({ t: 'menu', cwd: folder, ...m });
    }
  }

  // commands_changed from a running process: the folder's commands are replaced.
  commandsChanged(folder: string, commands: SlashCommand[]): void {
    const m = this.cache.get(folder);
    this.put(folder, { commands: toCommands(commands), models: m?.models ?? [] });
  }

  // Stores a folder's menu; pages that had the old one get the new one.
  private put(folder: string, m: FolderMenu): void {
    const old = this.cache.get(folder);
    this.cache.set(folder, m);
    if (JSON.stringify(old?.models) !== JSON.stringify(m.models)) this.save();
    if (!old || JSON.stringify(old) === JSON.stringify(m)) return;
    for (const c of this.opts.clients()) {
      if (this.sentTo.get(c)?.has(folder)) c.send({ t: 'menu', cwd: folder, ...m });
    }
  }

  // One idle query per folder at a time; a failure leaves the cache empty, so the next view tries again.
  private fill(folder: string, abs: string): Promise<FolderMenu | null> {
    const busy = this.loading.get(folder);
    if (busy) return busy;
    const p = this.idle(abs).then((m) => {
      if (m && !this.cache.has(folder)) {
        this.cache.set(folder, m);
        this.save();
      }
      return m;
    }).finally(() => this.loading.delete(folder));
    this.loading.set(folder, p);
    return p;
  }

  private async idle(abs: string): Promise<FolderMenu | null> {
    if (!isDir(abs)) return null;
    let release = () => {};
    const stop = new Promise<void>((r) => (release = r));
    const started = Date.now();
    let q: IdleQuery | null = null;
    let timer: NodeJS.Timeout | undefined;
    const ac = new AbortController();
    this.aborts.add(ac);
    try {
      q = (this.opts.queryFn ?? (sdkQuery as unknown as IdleQueryFn))({ prompt: idlePrompt(stop), options: { cwd: abs, abortController: ac } });
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error('timeout')), this.opts.timeoutMs ?? IDLE_TIMEOUT_MS);
      });
      const aborted = new Promise<never>((_, rej) => ac.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true }));
      const m = await Promise.race([readMenu(q), timeout, aborted]);
      this.log('menu.idle', { ms: Date.now() - started, commands: m.commands.length, models: m.models.length });
      return m;
    } catch (e) {
      this.log('menu.idleFailed', { error: (e as Error)?.message === 'timeout' ? 'timeout' : 'error' });
      return null;
    } finally {
      this.aborts.delete(ac);
      clearTimeout(timer);
      release();
      try { q?.close(); } catch { /* already gone */ }
    }
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
