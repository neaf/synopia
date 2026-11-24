// The slash menu and the model list (plan sections 3 and 5), per folder. They come from the
// session's running process when it has one; otherwise from a cache filled once per folder by
// sdk.ts's idle probe, which makes no model call but runs the folder's SessionStart hooks. A failed
// probe waits before the next try, longer after each failure, so views don't re-run the hooks each
// time. A page gets `menu` for a folder the first time it views a session there (once per
// connection); `hello` carries the cache.
import fs from 'node:fs';
import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type { Client } from './server.ts';
import type { Log } from './log.ts';
import { nullLog } from './log.ts';
import { probeMenu, readMenu, realSdk, toCommands } from './sdk.ts';
import type { FolderMenu, MenuModel, MenuSource, Sdk } from './sdk.ts';

export type { FolderMenu, MenuCommand, MenuModel, MenuSource } from './sdk.ts';

export const PROCESS_TIMEOUT_MS = 10_000; // a running process answers at once; a hung control call ends here
export const RETRY_MS = 60_000; // the wait after a failed probe, doubled per failure in a row
export const RETRY_MAX_MS = 30 * 60_000;

export type MenusOptions = {
  clients: () => Set<Client>;
  reply: (client: Client, msg: object) => void; // publisher.ts sends it
  log?: Log;
  sdk?: Pick<Sdk, 'query'>; // tests inject a fake; the default is the SDK
  timeoutMs?: number; // the idle probe's (sdk.ts PROBE_TIMEOUT_MS)
  processTimeoutMs?: number;
  retryMs?: number;
  now?: () => number;
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
  private now: () => number;
  private cache = new Map<string, FolderMenu>(); // by the folder as the page shows it (`~/…`)
  private loading = new Map<string, Promise<FolderMenu | null>>();
  private failed = new Map<string, { at: number; n: number }>(); // failed probes in a row, by folder
  private sentTo = new WeakMap<Client, Set<string>>();
  private aborts = new Set<AbortController>(); // the idle probes running, aborted at quit
  private seed: Map<string, MenuModel[]>; // the model lists of the last launch (cacheFile)

  constructor(opts: MenusOptions) {
    this.opts = opts;
    this.log = opts.log ?? nullLog;
    this.now = opts.now ?? Date.now;
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

  // Quit: the idle probes still reading end with the backend.
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

  // A page views a session in `folder` (`abs` is the absolute path). With a running process the
  // menu comes from it (and refreshes the folder's); else from the cache, filled once by an idle
  // probe. The page gets `menu` when it hasn't got this folder's yet, or when it changed.
  async viewed(client: Client, folder: string, abs: string, proc: MenuSource | null): Promise<void> {
    if (proc) {
      try {
        this.put(folder, await readMenu(proc, this.opts.processTimeoutMs ?? PROCESS_TIMEOUT_MS));
      } catch (e) {
        this.log('menu.processFailed', { error: (e as Error)?.message === 'timeout' ? 'timeout' : 'error' });
      }
    }
    if (!this.cache.has(folder)) await this.fill(folder, abs);
    const m = this.cache.get(folder);
    const sent = this.sentTo.get(client) ?? new Set<string>();
    this.sentTo.set(client, sent);
    if (m && !sent.has(folder)) {
      sent.add(folder);
      this.opts.reply(client, { t: 'menu', cwd: folder, ...m });
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
    this.failed.delete(folder);
    if (JSON.stringify(old?.models) !== JSON.stringify(m.models)) this.save();
    if (!old || JSON.stringify(old) === JSON.stringify(m)) return;
    for (const c of this.opts.clients()) {
      if (this.sentTo.get(c)?.has(folder)) this.opts.reply(c, { t: 'menu', cwd: folder, ...m });
    }
  }

  // One idle probe per folder at a time. A failure leaves the cache empty; the next view tries
  // again once the wait after it has passed.
  private fill(folder: string, abs: string): Promise<FolderMenu | null> {
    const busy = this.loading.get(folder);
    if (busy) return busy;
    const f = this.failed.get(folder);
    if (f && this.now() - f.at < Math.min((this.opts.retryMs ?? RETRY_MS) * 2 ** (f.n - 1), RETRY_MAX_MS)) return Promise.resolve(null);
    const p = this.idle(abs).then((m) => {
      if (m === undefined) {
        const n = (this.failed.get(folder)?.n ?? 0) + 1;
        this.failed.set(folder, { at: this.now(), n });
        return null;
      }
      if (m && !this.cache.has(folder)) {
        this.cache.set(folder, m);
        this.failed.delete(folder);
        this.save();
      }
      return m;
    }).finally(() => this.loading.delete(folder));
    this.loading.set(folder, p);
    return p;
  }

  // The folder's menu, null when there is no folder (no probe ran), undefined when the probe failed.
  private async idle(abs: string): Promise<FolderMenu | null | undefined> {
    if (!isDir(abs)) return null;
    const started = this.now();
    const ac = new AbortController();
    this.aborts.add(ac);
    try {
      const m = await probeMenu((this.opts.sdk ?? realSdk).query, abs, { timeoutMs: this.opts.timeoutMs, abortController: ac });
      this.log('menu.idle', { ms: this.now() - started, commands: m.commands.length, models: m.models.length });
      return m;
    } catch (e) {
      const why = (e as Error)?.message;
      this.log('menu.idleFailed', { error: why === 'timeout' || why === 'aborted' ? why : 'error' });
      return undefined;
    } finally {
      this.aborts.delete(ac);
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
