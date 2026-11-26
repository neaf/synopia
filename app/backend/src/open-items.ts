// Open items (R3.16, FR-ITEM-01 to -04, -06): the one owner and writer of every list. One list per ledger,
// keyed by the ledger's absolute path, or `session:<sid>` while the session has named none; a session uses the
// list of the last ledger its main conversation named (transcript.ts `ledger`). The ledger file is an input,
// read through ledger.ts and merged in by each item's own lines as last read: a changed item is the agent's
// record and wins, an unchanged one keeps what Synopia holds for it (Mark reviewed). Synopia never writes the
// file in phase 2. Review items come from finished `For review: ` subagents. Kept in state.json `items`.
// Everything shown (with <name>, Closed this turn, the counts) is derived here and never stored.
import fs from 'node:fs/promises';
import os from 'node:os';
import { parse, blockOf, fromOf, optionsOf, stampTime, ownerOf } from './ledger.ts';
import type { OpenItem, ClosedItem, Prefix, Brief } from './ledger.ts';
import { isProtected } from './folders.ts';
import type { Agent, LedgerFact } from './transcript.ts';
import type { Store } from './store.ts';
import type { Log } from './log.ts';
import { nullLog } from './log.ts';

export const MAX_LEDGER_BYTES = 256 * 1024;
export const LOOK_MS = 2000; // the size and mtime look while an open session uses a ledger
export const AGENT_CLOSED_MAX = 1000; // closed items with an agent id (and carried marks), the reviewed marks' old cap
export const CLOSED_MAX = 30; // other closed items, per list
const REVIEW_PREFIX = /^for review:\s*/i;

// One item as Synopia holds it. `block`: its lines as last read from the file (none: Synopia's own, never in
// the file). `agent`: the subagent a review item is for. `closed`: how it closed, when (ms), and a note.
export type Held = {
  id: string; prefix: Prefix; n: number; kind: string; text: string; fields: Record<string, string>;
  source: 'agent' | 'synopia'; block?: string; agent?: string; at: number | null;
  closed?: { how: string; at: number; note: string; by: 'agent' | 'synopia' };
};
export type List = { top: Record<Prefix, number>; items: Held[] };
// state.json `items`: the lists, and `carried`, agent ids marked reviewed whose item is in no list (the old
// `reviewed` marks until their subagent shows again, and the closed review items of a closed session's list).
export type ItemsState = { lists: Record<string, List>; carried: string[] };

// What the page shows for one session (the `openItems` frame, FR-ITEM-05).
export type ItemView = {
  id: string; kind: string; text: string; source: 'agent' | 'synopia'; at: number | null; minute: boolean;
  state?: string; options?: string[]; recommended?: string; trigger?: string; goesAhead?: string; watch?: string;
  subagent?: string; raisedBy?: string; answer?: string; agent?: string;
  with?: { agent: string; name: string };
};
export type ClosedView = { id: string; kind: string; text: string; how: string; at: number; note: string; by: 'agent' | 'synopia' };
export type View = { items: ItemView[]; checks: ItemView[]; closed: ClosedView[]; unread: number; note: string | null };
export type Counts = { review: number; waiting: number; due: number };

// What open-items.ts reads of a session's transcript (transcripts.ts).
export type ItemFacts = {
  ledgerOf(sid: string): LedgerFact | null;
  ownsOf(sid: string, toolUseId: string): string[];
  agents(sid: string): Agent[];
  lastYouAt(sid: string): number | null; // your last message (ms), for Closed this turn
};
export type FileIo = {
  stat(p: string): Promise<{ size: number; mtimeMs: number }>;
  read(p: string): Promise<string>;
};
const realIo: FileIo = {
  stat: (p) => fs.stat(p),
  read: (p) => fs.readFile(p, 'utf8'),
};

// ---------- state.json `items` ----------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const ID = /^([YA])(\d+)$/;

function cleanHeld(v: unknown): Held | undefined {
  if (!isObj(v) || !isStr(v.id) || !isStr(v.kind) || !isStr(v.text)) return undefined;
  const m = ID.exec(v.id);
  if (!m || (v.source !== 'agent' && v.source !== 'synopia')) return undefined;
  const fields: Record<string, string> = {};
  if (isObj(v.fields)) for (const [k, x] of Object.entries(v.fields)) if (isStr(x)) fields[k] = x;
  const h: Held = { id: v.id, prefix: m[1] as Prefix, n: Number(m[2]), kind: v.kind, text: v.text, fields, source: v.source, at: isNum(v.at) ? v.at : null };
  if (isStr(v.block)) h.block = v.block;
  if (isStr(v.agent) && v.agent) h.agent = v.agent;
  const c = v.closed;
  if (c !== undefined) {
    if (!isObj(c) || !isStr(c.how) || !isNum(c.at) || !isStr(c.note) || (c.by !== 'agent' && c.by !== 'synopia')) return undefined;
    h.closed = { how: c.how, at: c.at, note: c.note, by: c.by };
  }
  return h;
}

// Every list and entry checked on load (store.ts normalize); a wrong one is dropped. The old `reviewed` marks
// are carried over once, then the field is gone.
export function cleanItems(raw: unknown, reviewed: unknown): ItemsState {
  const out: ItemsState = { lists: {}, carried: [] };
  if (isObj(raw) && isObj(raw.lists)) {
    for (const [key, l] of Object.entries(raw.lists)) {
      if (!isObj(l) || !Array.isArray(l.items)) continue;
      const items: Held[] = [];
      for (const x of l.items) {
        const h = cleanHeld(x);
        if (h && !items.some((i) => i.id === h.id)) items.push(h);
      }
      const top = isObj(l.top) ? l.top : {};
      out.lists[key] = { top: { Y: isNum(top.Y) ? top.Y : 0, A: isNum(top.A) ? top.A : 0 }, items };
    }
  }
  if (isObj(raw) && Array.isArray(raw.carried)) out.carried = raw.carried.filter(isStr);
  if (Array.isArray(reviewed)) for (const a of reviewed) if (isStr(a) && !out.carried.includes(a)) out.carried.push(a);
  out.carried = out.carried.slice(-AGENT_CLOSED_MAX);
  return out;
}

// ---------- the owner ----------

type Use = { key: string; at: number; results: number; path: string | null };
type Read = { size: number; mtimeMs: number; unread: number; note: keyof typeof NOTES | null; busy: Promise<void> | null; again: boolean };

export class OpenItems {
  private store: Store;
  private facts: ItemFacts;
  private io: FileIo;
  private home: string;
  private log: Log;
  private now: () => number;
  private changed: (sids: string[]) => void;
  private uses = new Map<string, Use>(); // open session -> the list it uses
  private reads = new Map<string, Read>(); // ledger path -> its last read
  private timer: NodeJS.Timeout | null = null;

  constructor(o: {
    store: Store; facts: ItemFacts; io?: FileIo; home?: string; log?: Log; now?: () => number;
    onChange?: (sids: string[]) => void; lookMs?: number;
  }) {
    this.store = o.store;
    this.facts = o.facts;
    this.io = o.io ?? realIo;
    this.home = o.home ?? os.homedir();
    this.log = o.log ?? nullLog;
    this.now = o.now ?? Date.now;
    this.changed = o.onChange ?? (() => {});
    const ms = o.lookMs ?? LOOK_MS;
    if (ms > 0) {
      this.timer = setInterval(() => { void this.look(); }, ms);
      this.timer.unref();
    }
  }

  private get state(): ItemsState { return this.store.state.items; }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // The session's transcript changed (or it opened): which list it uses, its review items, and a read of the
  // ledger when the transcript shows a new tool result for it (before the review items, so a ledger's own review
  // item ties to its subagent first).
  async sync(sid: string): Promise<void> {
    const fact = this.facts.ledgerOf(sid);
    const key = fact ? fact.path : `session:${sid}`;
    const prev = this.uses.get(sid);
    const use: Use = { key, at: fact?.at ? Date.parse(fact.at) || 0 : 0, results: fact?.results ?? 0, path: fact?.path ?? null };
    this.uses.set(sid, use);
    let dirty = false;
    if (fact) dirty = this.adoptSessionList(sid, key) || dirty;
    const reread = !!fact && (!prev || prev.key !== key || prev.results !== use.results || !this.reads.has(key));
    if (reread) await this.read(key);
    if (this.uses.get(sid)?.key !== key) return; // closed or moved on meanwhile
    dirty = this.openReviews(sid, key) || dirty;
    if (dirty || !prev || prev.key !== key) this.touch(key, sid);
  }

  // The session closed: a `session:` list goes, its closed review items carried as marks, so a reopened session's
  // reviewed deliverables stay reviewed. A ledger's list stays (another or a reopened session may use it).
  close(sid: string): void {
    const key = `session:${sid}`;
    const l = this.state.lists[key];
    this.uses.delete(sid);
    if (l) {
      for (const h of l.items) if (h.agent && h.closed) this.carry(h.agent);
      delete this.state.lists[key];
      this.store.changed();
    }
    this.forgetUnused();
  }

  // The session's id changed (sessions.ts rekey): its `session:` list moves with it.
  rekey(from: string, to: string): void {
    const l = this.state.lists[`session:${from}`];
    if (l) {
      delete this.state.lists[`session:${from}`];
      this.state.lists[`session:${to}`] = l;
      this.store.changed();
    }
    const u = this.uses.get(from);
    this.uses.delete(from);
    if (u) this.uses.set(to, u.key === `session:${from}` ? { ...u, key: `session:${to}` } : u);
  }

  // Whether an open session's list holds this open item (router.ts refuses others).
  holds(sid: string, id: string): boolean {
    const h = this.find(sid, id);
    return !!h && !h.closed;
  }

  // Mark reviewed (R10.2): closes a review item as done, "marked reviewed", now. False when there is no such open
  // review item in the session's list.
  markReviewed(sid: string, id: string): boolean {
    const h = this.find(sid, id);
    if (!h || h.closed || h.kind !== 'review') return false;
    h.closed = { how: 'done', at: this.now(), note: 'marked reviewed', by: 'synopia' };
    this.prune();
    this.touch(this.uses.get(sid)!.key, sid);
    return true;
  }

  // Whether a subagent has an open review item (publisher.ts `agents[].review`).
  reviewOpen(sid: string, agentId: string): boolean {
    const l = this.listOf(sid);
    return !!l?.items.some((h) => h.agent === agentId && h.kind === 'review' && !h.closed);
  }

  // The open sessions that use the list `key`.
  sessionsOf(key: string): string[] {
    return [...this.uses].filter(([, u]) => u.key === key).map(([sid]) => sid);
  }

  // What the page shows for the session (FR-ITEM-05).
  view(sid: string): View {
    const u = this.uses.get(sid);
    const l = this.listOf(sid);
    const rd = u?.path ? this.reads.get(u.path) : undefined;
    const out: View = { items: [], checks: [], closed: [], unread: rd?.unread ?? 0, note: rd?.note ? NOTES[rd.note] : null };
    if (!l) return out;
    const briefs = this.briefs(sid);
    const youAt = this.facts.lastYouAt(sid);
    const since = youAt === null ? null : Math.floor(youAt / 60_000) * 60_000;
    for (const h of l.items) {
      if (h.closed) {
        if (since !== null && h.closed.at >= since) out.closed.push({ id: h.id, kind: h.kind, text: h.text, how: h.closed.how, at: h.closed.at, note: h.closed.note, by: h.closed.by });
        continue;
      }
      (h.prefix === 'Y' ? out.items : out.checks).push(this.itemView(h, briefs));
    }
    out.closed.sort((a, b) => a.at - b.at);
    return out;
  }

  // The session's numbers (FR-ITEM-06): open review items; open Y items, review apart, not answered and not
  // `later`; A items that are due. A shared ledger counts once, under the session that named it last.
  counts(sid: string): Counts {
    const zero = { review: 0, waiting: 0, due: 0 };
    const u = this.uses.get(sid);
    const l = this.listOf(sid);
    if (!u || !l || this.counter(u.key) !== sid) return zero;
    for (const h of l.items) {
      if (h.closed) continue;
      if (h.kind === 'review') zero.review++;
      else if (h.prefix === 'Y' && h.fields.state !== 'answered' && h.fields.state !== 'later') zero.waiting++;
      else if (h.prefix === 'A' && h.fields.state === 'due') zero.due++;
    }
    return zero;
  }

  // ---------- reading the ledger ----------

  // The 2 s look at size and mtime of every ledger an open session uses.
  async look(): Promise<void> {
    const paths = new Set([...this.uses.values()].map((u) => u.path).filter((p): p is string => !!p));
    await Promise.all([...paths].map(async (p) => {
      const rd = this.reads.get(p);
      if (!rd || rd.busy || rd.note === 'protected') return;
      let st: { size: number; mtimeMs: number } | null = null;
      try { st = await this.io.stat(p); } catch { st = null; }
      if (!st ? rd.note !== 'gone' : st.size !== rd.size || st.mtimeMs !== rd.mtimeMs) await this.read(p);
    }));
  }

  // Reads the ledger and merges it into its list. One read per file at a time; a read asked for during one runs
  // after it, and its promise is the running one's.
  read(file: string): Promise<void> {
    let rd = this.reads.get(file);
    if (!rd) this.reads.set(file, rd = { size: -1, mtimeMs: -1, unread: 0, note: null, busy: null, again: false });
    if (rd.busy) { rd.again = true; return rd.busy; }
    const r = rd;
    r.busy = (async () => {
      try {
        do {
          r.again = false;
          await this.readOnce(file, r);
        } while (r.again);
      } finally {
        r.busy = null;
      }
    })();
    return r.busy;
  }

  private async readOnce(file: string, rd: Read): Promise<void> {
    const before = JSON.stringify([rd.unread, rd.note]);
    let text: string | null = null;
    if (isProtected(file, this.home)) rd.note = 'protected';
    else {
      try {
        const st = await this.io.stat(file);
        rd.size = st.size; rd.mtimeMs = st.mtimeMs;
        if (st.size > MAX_LEDGER_BYTES) rd.note = 'big';
        else text = await this.io.read(file);
      } catch {
        rd.size = -1; rd.mtimeMs = -1;
        rd.note = 'gone';
      }
    }
    let dirty = false;
    if (text !== null) {
      const led = parse(text);
      rd.unread = led.unread.length;
      rd.note = led.version !== null && led.version !== 1 ? 'version' : null;
      if (rd.note === null) dirty = this.merge(file, led.items, led.closed);
    } else rd.unread = 0;
    if (dirty || JSON.stringify([rd.unread, rd.note]) !== before) this.touch(file);
  }

  // The merge (FR-ITEM-02), against each item's lines as last read. True when the list changed.
  private merge(key: string, open: OpenItem[], closed: ClosedItem[]): boolean {
    const l = this.list(key);
    const before = JSON.stringify(l);
    const inFile = new Set<string>();
    for (const f of [...open, ...closed]) {
      inFile.add(f.id);
      l.top[f.prefix] = Math.max(l.top[f.prefix], f.n);
    }
    for (const f of [...open, ...closed]) {
      const block = blockOf(f);
      let h = l.items.find((x) => x.id === f.id);
      // Synopia's own review item for the same subagent merges with the agent's: the agent's id wins, Synopia's
      // number is retired, and Mark reviewed holds over the merge.
      const twin = h?.block === undefined ? l.items.find((x) => x.block === undefined && this.sameReview(x, f)) : undefined;
      if (twin) {
        const held = this.fromFile(f, block);
        held.agent = twin.agent;
        if (twin.closed && !held.closed) held.closed = twin.closed;
        l.items.splice(l.items.indexOf(twin), 1);
        if (h && h !== twin) this.renumber(l, h);
        l.items.push(held);
        continue;
      }
      // Synopia's own item holds the number the agent used: Synopia's moves to the next free one (design rule 2).
      if (h && h.block === undefined) { this.renumber(l, h); h = undefined; }
      if (!h) { l.items.push(this.fromFile(f, block)); continue; }
      if (h.block === block) continue; // unchanged: not a record, Synopia's state stays
      const fresh = this.fromFile(f, block);
      if (h.agent) fresh.agent = h.agent;
      if (fresh.closed && !fresh.text) Object.assign(fresh, { kind: h.kind, text: h.text, fields: h.fields, at: h.at }); // a closed line has no text
      l.items[l.items.indexOf(h)] = fresh; // the agent's record wins
    }
    for (const h of l.items) {
      if (h.block === undefined || h.closed || inFile.has(h.id)) continue;
      h.closed = { how: 'dropped', at: this.now(), note: 'removed from the ledger', by: 'synopia' };
      this.log('items.dropped', { id: h.id });
    }
    // file order first, then Synopia's own items
    const order = new Map([...open, ...closed].map((f, i) => [f.id, i]));
    l.items.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
    for (const h of l.items) this.attachAgent(key, h);
    this.prune();
    const changed = JSON.stringify(l) !== before;
    if (changed) this.store.changed();
    return changed;
  }

  private fromFile(f: OpenItem | ClosedItem, block: string): Held {
    if ('kind' in f) {
      const from = fromOf(f);
      return { id: f.id, prefix: f.prefix, n: f.n, kind: f.kind, text: f.text, fields: { ...f.fields }, source: 'agent', block, at: from ? stampTime(from.at)?.ms ?? null : null };
    }
    const when = stampTime(f.when)?.ms ?? this.now();
    const note = f.how === 'superseded' ? `superseded by ${f.by}` : f.notes.join(' · ');
    return { id: f.id, prefix: f.prefix, n: f.n, kind: '', text: '', fields: {}, source: 'agent', block, at: null, closed: { how: f.how, at: when, note, by: 'agent' } };
  }

  // A review item from the file and Synopia's review item for the same subagent (by the `subagent` field).
  private sameReview(h: Held, f: OpenItem | ClosedItem): boolean {
    return h.kind === 'review' && !!h.agent && 'kind' in f && f.kind === 'review' && !!f.fields.subagent && f.fields.subagent === h.fields.subagent;
  }

  private renumber(l: List, h: Held): void {
    const old = h.id;
    l.top[h.prefix] += 1;
    h.n = l.top[h.prefix];
    h.id = `${h.prefix}${h.n}`;
    this.log('items.renumbered', { from: old, to: h.id });
  }

  // A file's review item with no agent id takes the agent id of a subagent of a session using this list whose
  // name its `subagent` field holds, and no other item has.
  private attachAgent(key: string, h: Held): void {
    if (h.kind !== 'review' || h.agent || !h.fields.subagent) return;
    for (const sid of this.sessionsOf(key)) {
      const a = this.facts.agents(sid).find((x) => x.review && nameOf(x) === h.fields.subagent && !this.hasAgent(x.id));
      if (!a) continue;
      h.agent = a.id;
      if (this.uncarry(a.id) && !h.closed) h.closed = { how: 'done', at: this.now(), note: 'marked reviewed', by: 'synopia' };
      return;
    }
  }

  // ---------- review items ----------

  // Opens `Review: <name>` for each finished `For review: ` subagent that no item carries (FR-ITEM-03): closed
  // at once when its mark was carried over.
  private openReviews(sid: string, key: string): boolean {
    let dirty = false;
    for (const a of this.facts.agents(sid)) {
      if (!a.review || a.running || this.hasAgent(a.id)) continue;
      const l = this.list(key);
      const name = nameOf(a);
      // the agent's own review item, not tied yet
      const own = l.items.find((h) => h.kind === 'review' && !h.agent && h.fields.subagent === name);
      if (own) {
        own.agent = a.id;
        if (this.uncarry(a.id) && !own.closed) own.closed = { how: 'done', at: this.now(), note: 'marked reviewed', by: 'synopia' };
        dirty = true;
        continue;
      }
      l.top.Y += 1;
      const at = a.end ? Date.parse(a.end) || this.now() : this.now();
      const h: Held = { id: `Y${l.top.Y}`, prefix: 'Y', n: l.top.Y, kind: 'review', text: `Review: ${name}`, fields: { subagent: name }, source: 'synopia', agent: a.id, at };
      if (this.uncarry(a.id)) h.closed = { how: 'done', at, note: 'marked reviewed', by: 'synopia' };
      l.items.push(h);
      dirty = true;
    }
    if (dirty) { this.prune(); this.store.changed(); }
    return dirty;
  }

  // The session named its first ledger: its `session:` list's items join the ledger's, renumbered past it.
  private adoptSessionList(sid: string, key: string): boolean {
    const own = this.state.lists[`session:${sid}`];
    if (!own) return false;
    const l = this.list(key);
    for (const h of own.items) {
      if (l.items.some((x) => x.id === h.id)) this.renumber(l, h);
      else l.top[h.prefix] = Math.max(l.top[h.prefix], h.n);
      l.items.push(h);
    }
    delete this.state.lists[`session:${sid}`];
    this.store.changed();
    return true;
  }

  private hasAgent(agentId: string): boolean {
    return Object.values(this.state.lists).some((l) => l.items.some((h) => h.agent === agentId));
  }

  // A carried mark of this subagent, taken (its item now carries it): true when there was one.
  private uncarry(agentId: string): boolean {
    const i = this.state.carried.indexOf(agentId);
    if (i >= 0) this.state.carried.splice(i, 1);
    return i >= 0;
  }

  private carry(agentId: string): void {
    if (!this.state.carried.includes(agentId)) this.state.carried.push(agentId);
  }

  // The caps: closed items with an agent id and the carried marks, the newest AGENT_CLOSED_MAX together; other
  // closed items the newest CLOSED_MAX per list.
  private prune(): void {
    const agentClosed: { l: List; h: Held }[] = [];
    for (const l of Object.values(this.state.lists)) {
      const plain = l.items.filter((h) => h.closed && !h.agent).sort((a, b) => a.closed!.at - b.closed!.at);
      const drop = new Set(plain.slice(0, Math.max(0, plain.length - CLOSED_MAX)));
      if (drop.size) l.items = l.items.filter((h) => !drop.has(h));
      for (const h of l.items) if (h.closed && h.agent) agentClosed.push({ l, h });
    }
    let over = agentClosed.length + this.state.carried.length - AGENT_CLOSED_MAX;
    if (over <= 0) return;
    const fromCarried = Math.min(over, this.state.carried.length);
    this.state.carried.splice(0, fromCarried);
    over -= fromCarried;
    agentClosed.sort((a, b) => a.h.closed!.at - b.h.closed!.at);
    for (const { l, h } of agentClosed.slice(0, over)) l.items = l.items.filter((x) => x !== h);
  }

  // ---------- helpers ----------

  private list(key: string): List {
    return this.state.lists[key] ??= { top: { Y: 0, A: 0 }, items: [] };
  }

  private listOf(sid: string): List | undefined {
    const u = this.uses.get(sid);
    return u ? this.state.lists[u.key] : undefined;
  }

  private find(sid: string, id: string): Held | undefined {
    return this.listOf(sid)?.items.find((h) => h.id === id);
  }

  // The session that counts a list: the one that named its ledger last.
  private counter(key: string): string | null {
    let best: [string, number] | null = null;
    for (const [sid, u] of this.uses) if (u.key === key && (!best || u.at > best[1])) best = [sid, u.at];
    return best?.[0] ?? null;
  }

  private briefs(sid: string): Brief[] {
    return this.facts.agents(sid).map((a) => ({ agent: a.id, name: nameOf(a), ids: a.toolUseId ? this.facts.ownsOf(sid, a.toolUseId) : [], running: a.running }));
  }

  private itemView(h: Held, briefs: Brief[]): ItemView {
    const f = h.fields;
    const v: ItemView = { id: h.id, kind: h.kind, text: h.text, source: h.source, at: h.at, minute: true };
    const from = h.source === 'agent' ? fromOf({ fields: f } as OpenItem) : null;
    if (from) v.minute = stampTime(from.at)?.minute ?? true;
    if (f.state) v.state = f.state;
    const options = optionsOf({ fields: f } as OpenItem);
    if (options.length) v.options = options;
    if (f.recommended) v.recommended = f.recommended;
    if (f.trigger) v.trigger = f.trigger;
    if (f['goes ahead']) v.goesAhead = f['goes ahead'];
    if (f.watch) v.watch = f.watch;
    if (f.subagent) v.subagent = f.subagent;
    if (f['raised by']) v.raisedBy = f['raised by'];
    if (f.answer) v.answer = f.answer;
    if (h.agent) v.agent = h.agent;
    const owner = ownerOf({ id: h.id, fields: f } as OpenItem, briefs);
    if (owner) v.with = { agent: owner, name: briefs.find((b) => b.agent === owner)!.name };
    return v;
  }

  // Tells the sessions using the list that it changed.
  private touch(key: string, also?: string): void {
    const sids = new Set(this.sessionsOf(key));
    if (also) sids.add(also);
    if (sids.size) this.changed([...sids]);
  }

  private forgetUnused(): void {
    const used = new Set([...this.uses.values()].map((u) => u.path));
    for (const p of this.reads.keys()) if (!used.has(p)) this.reads.delete(p);
  }
}

// A subagent's name as the ledger's `subagent` field holds it: its description without `For review: `.
export const nameOf = (a: Pick<Agent, 'description'>): string => a.description.replace(REVIEW_PREFIX, '').trim();

// The note a view carries when nothing could be read (the page words it).
export const NOTES = {
  protected: 'Synopia doesn’t read files in a folder macOS protects',
  big: 'The ledger is over 256 KB',
  version: 'Synopia can’t read this ledger’s version',
  gone: 'The ledger file is gone',
} as const;
