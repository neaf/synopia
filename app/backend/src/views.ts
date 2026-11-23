// The transcripts service: one tailer and one reducer per open session and per subagent,
// and the protocol messages that come from them (plan sections 5 and 7). It sends `session`
// meta, `agents` and `background` to every page, and `items` only to the pages viewing that
// conversation: a reset with the last WINDOW items on `view`, then upserts of changed ids.
// It also holds the status, the pending requests and the stream preview a driver sets.
import fs from 'node:fs';
import os from 'node:os';
import { Tailer, SubagentWatcher } from './tail.ts';
import type { JsonRecord } from './tail.ts';
import { Transcript, findTranscript, sessionDirOf } from './transcript.ts';
import type { Item } from './transcript.ts';
import type { Client } from './server.ts';
import type { Log } from './log.ts';
import { nullLog } from './log.ts';

export const WINDOW = 160;

export type Status = 'busy' | 'idle' | 'waiting';
export type PendingRequest = { id: string; kind: 'question' | 'permission' | 'plan'; since: number; [k: string]: unknown };
export type SessionMeta = {
  id: string; title: string; now: string; cwd: string; prs: unknown[];
  status: Status; statusAt: number; model: unknown; effort: unknown;
};

type Sub = { sid: string; agent: string | null; from: number };
type Child = { t: Transcript; tailer: Tailer };
type Live = {
  id: string; path: string | null; cwd: string; t: Transcript;
  tailer: Tailer | null; watcher: SubagentWatcher | null; children: Map<string, Child>;
  status: Status | null; statusAt: number; stream: string | null; pending: PendingRequest[];
  sent: string; needReset: boolean; resetChildren: Set<string>; queued: boolean;
};

export type ViewsOptions = {
  claudeDir: string;
  clients: () => Set<Client>;
  home?: string; // for `~` in paths; the fixtures use their own
  log?: Log;
  pollMs?: number; // passed to the tailers; 0 turns polling off (tests call check())
  watch?: boolean;
};

const tilde = (p: string, home: string): string => (home && p.startsWith(home) ? '~' + p.slice(home.length) : p);

export class Views {
  private opts: ViewsOptions;
  private home: string;
  private log: Log;
  private live = new Map<string, Live>();
  private subs = new Map<Client, Sub>();

  constructor(opts: ViewsOptions) {
    this.opts = opts;
    this.home = opts.home ?? os.homedir();
    this.log = opts.log ?? nullLog;
  }

  ids(): string[] {
    return [...this.live.keys()];
  }

  // Starts tailing a session. Its file is found under projects/*/ (a new session has none yet).
  open(id: string, init: { cwd?: string; path?: string } = {}): void {
    if (this.live.has(id)) return;
    const file = init.path ?? findTranscript(this.opts.claudeDir, id);
    const s: Live = {
      id, path: file, cwd: init.cwd ?? '', t: new Transcript({ home: this.home }),
      tailer: null, watcher: null, children: new Map(),
      status: null, statusAt: 0, stream: null, pending: [],
      sent: '', needReset: false, resetChildren: new Set(), queued: false,
    };
    this.live.set(id, s);
    this.log('views.open', { sid: id, found: Boolean(file) });
    if (!file) return;
    const tail = { pollMs: this.opts.pollMs, watch: this.opts.watch };
    s.tailer = new Tailer(file, {
      ...tail,
      onRecords: (records) => {
        if (!s.cwd) s.cwd = cwdOf(records);
        s.t.pushAll(records);
        this.queue(s);
      },
      onReset: () => {
        s.t.reset();
        s.needReset = true;
        this.queue(s);
      },
    }).start();
    s.watcher = new SubagentWatcher(sessionDirOf(file), {
      onAgent: (aid, afile) => {
        const t = new Transcript({ sidechain: true, home: this.home });
        s.t.setAgent(aid, undefined, t);
        const tailer = new Tailer(afile, {
          ...tail,
          onRecords: (records) => {
            t.pushAll(records);
            s.t.setAgent(aid, undefined); // its total, start and end changed
            this.queue(s);
          },
          onReset: () => {
            t.reset();
            s.resetChildren.add(aid);
            this.queue(s);
          },
        });
        s.children.set(aid, { t, tailer });
        tailer.start();
      },
      onMeta: (aid, meta) => {
        s.t.setAgent(aid, meta);
        this.queue(s);
      },
    }, tail).start();
  }

  close(id: string): void {
    const s = this.live.get(id);
    if (!s) return;
    this.stopOne(s);
    this.live.delete(id);
    for (const [c, sub] of this.subs) if (sub.sid === id) this.subs.delete(c);
    this.broadcast({ t: 'removed', id });
  }

  stop(): void {
    for (const s of this.live.values()) this.stopOne(s);
  }

  private stopOne(s: Live): void {
    s.tailer?.stop();
    s.watcher?.stop();
    for (const c of s.children.values()) c.tailer.stop();
  }

  // Reads what is new right now (tests and the fixture builder; live sessions rely on the timers).
  check(): void {
    for (const s of this.live.values()) {
      s.watcher?.scan();
      s.tailer?.check();
      for (const c of s.children.values()) c.tailer.check();
      this.flush(s);
    }
  }

  meta(id: string): SessionMeta | undefined {
    const s = this.live.get(id);
    return s && this.metaOf(s);
  }

  private metaOf(s: Live): SessionMeta {
    const t = s.t;
    const first = t.items.find((i) => i.k === 'you')?.text ?? '';
    let statusAt = s.statusAt;
    if (!s.status) statusAt = (t.lastTs && Date.parse(t.lastTs)) || mtimeOf(s.path) || 0;
    return {
      id: s.id,
      title: t.title || first.split('\n')[0].slice(0, 80) || 'New session',
      now: '',
      cwd: tilde(s.cwd, this.home),
      prs: t.prs,
      // From the transcript until a driver sets it: your turn. "Stopped" is read from the items by the page.
      status: s.status ?? 'idle',
      statusAt,
      model: t.requestedModel ?? null,
      effort: t.effort ?? null,
    };
  }

  // The sessions part of `hello`: meta, status, subagents, background work and the stream preview.
  sessions(): object[] {
    return [...this.live.values()].map((s) => ({
      ...this.metaOf(s), agents: s.t.agents(), background: s.t.background(), stream: s.stream,
    }));
  }

  pending(): { sid: string; request: PendingRequest }[] {
    return [...this.live.values()].flatMap((s) => s.pending.map((request) => ({ sid: s.id, request })));
  }

  // Everything one session would show, items included (the prototype fixture builder uses it).
  dump(id: string): object | undefined {
    const s = this.live.get(id);
    if (!s) return undefined;
    const v = s.t.view(WINDOW);
    return {
      ...this.metaOf(s), items: v.items, total: v.total, background: s.t.background(), stream: s.stream,
      pending: s.pending,
      agents: s.t.agents().map((a) => ({ ...a, items: s.children.get(a.id)?.t.view(WINDOW).items ?? [] })),
    };
  }

  // `view` from a page: it now watches this conversation, and gets it from the start.
  view(client: Client, sid: string, agent: string | null): void {
    const sub: Sub = { sid, agent: agent || null, from: 0 };
    this.subs.set(client, sub);
    this.sendReset(client, sub);
  }

  setStatus(sid: string, status: Status, at = Date.now()): void {
    const s = this.live.get(sid);
    if (!s) return;
    s.status = status;
    s.statusAt = at;
    this.flush(s);
  }

  setPending(sid: string, request: PendingRequest): void {
    const s = this.live.get(sid);
    if (!s) return;
    s.pending = [...s.pending.filter((r) => r.id !== request.id), request];
    this.broadcast({ t: 'pending', sid, request });
  }

  clearPending(sid: string, id: string): void {
    const s = this.live.get(sid);
    if (!s || !s.pending.some((r) => r.id === id)) return;
    s.pending = s.pending.filter((r) => r.id !== id);
    this.broadcast({ t: 'pending', sid, cleared: id });
  }

  setStream(sid: string, text: string | null): void {
    const s = this.live.get(sid);
    if (!s) return;
    s.stream = text;
    this.broadcast(text === null ? { t: 'stream', sid, clear: true } : { t: 'stream', sid, text });
  }

  toast(text: string): void {
    this.broadcast({ t: 'toast', text });
  }

  private transcriptOf(sid: string, agent: string | null): Transcript | null {
    const s = this.live.get(sid);
    if (!s) return null;
    return agent ? s.children.get(agent)?.t ?? null : s.t;
  }

  private sendReset(client: Client, sub: Sub): void {
    const t = this.transcriptOf(sub.sid, sub.agent);
    const v = t ? t.view(WINDOW) : { items: [], total: 0 };
    sub.from = v.total - v.items.length;
    client.send({ t: 'items', sid: sub.sid, agent: sub.agent, upsert: v.items, total: v.total, reset: true });
  }

  private sendUpserts(client: Client, sub: Sub, t: Transcript, changed: string[]): void {
    if (!changed.length) return;
    const ids = new Set(changed);
    const upsert: Item[] = t.items.slice(sub.from).filter((i) => ids.has(i.id));
    if (upsert.length) client.send({ t: 'items', sid: sub.sid, agent: sub.agent, upsert, total: t.total, reset: false });
  }

  // Records arrive in bursts (a tail read calls onRecords per chunk): send once, after the read.
  private queue(s: Live): void {
    if (s.queued) return;
    s.queued = true;
    queueMicrotask(() => this.flush(s));
  }

  private flush(s: Live): void {
    s.queued = false;
    if (this.live.get(s.id) !== s) return;
    const ch = s.t.takeChanges();
    const meta = this.metaOf(s);
    const key = JSON.stringify(meta);
    if (key !== s.sent) {
      s.sent = key;
      this.broadcast({ t: 'session', ...meta });
    }
    if (ch.agents.length) {
      this.broadcast({ t: 'agents', sid: s.id, upsert: ch.agents.map((id) => s.t.getAgent(id)).filter(Boolean) });
    }
    if (ch.background.length) {
      this.broadcast({ t: 'background', sid: s.id, upsert: ch.background.map((id) => s.t.getBackground(id)).filter(Boolean) });
    }
    const childChanges = new Map<string, string[]>();
    for (const [aid, c] of s.children) childChanges.set(aid, c.t.takeChanges().items);
    for (const [client, sub] of this.liveSubs()) {
      if (sub.sid !== s.id) continue;
      if (sub.agent === null) {
        if (s.needReset) this.sendReset(client, sub);
        else this.sendUpserts(client, sub, s.t, ch.items);
      } else {
        const c = s.children.get(sub.agent);
        if (!c) continue;
        if (s.resetChildren.has(sub.agent)) this.sendReset(client, sub);
        else this.sendUpserts(client, sub, c.t, childChanges.get(sub.agent) ?? []);
      }
    }
    s.needReset = false;
    s.resetChildren.clear();
  }

  // Subscriptions of pages still connected; a closed page's subscription goes.
  private liveSubs(): [Client, Sub][] {
    const clients = this.opts.clients();
    for (const c of this.subs.keys()) if (!clients.has(c)) this.subs.delete(c);
    return [...this.subs];
  }

  private broadcast(msg: object): void {
    for (const c of this.opts.clients()) c.send(msg);
  }
}

function cwdOf(records: JsonRecord[]): string {
  for (const r of records) if (typeof r.cwd === 'string' && r.cwd) return r.cwd;
  return '';
}

function mtimeOf(file: string | null): number {
  if (!file) return 0;
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}
