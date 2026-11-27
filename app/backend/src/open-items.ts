// Open items (R3.16, FR-ITEM-01 to -04, -06): the one owner and writer of every list. One list per ledger,
// keyed by the ledger's absolute path, or `session:<sid>` while the session has named none; a session uses the
// list of the last ledger its main conversation named (transcript.ts `ledger`). The ledger file is an input,
// read through ledger.ts and merged in by each item's own lines as last read: a changed item is the agent's
// record and wins, an unchanged one keeps what Synopia holds for it (Mark reviewed). Synopia never writes the
// file in phase 2. Review items come from finished `For review: ` subagents. Kept in state.json `items`.
// Everything shown (with <name>, Closed this turn, the counts) is derived here and never stored.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parse, blockOf, fromOf, optionsOf, stampTime, ownerOf, serialize, ledgerPathOf, FIELDS } from './ledger.ts';
import type { OpenItem, ClosedItem, Prefix, Brief, Doc, SerialClosed } from './ledger.ts';
import { isProtected } from './folders.ts';
import type { Agent, LedgerFact } from './transcript.ts';
import type { Store } from './store.ts';
import type { Log } from './log.ts';
import { nullLog } from './log.ts';
import type { Exchange, ExchangeKind, ListItem, Op } from './keeper.ts';

export const MAX_LEDGER_BYTES = 256 * 1024;
export const LOOK_MS = 2000; // the size and mtime look while an open session uses a ledger
export const AGENT_CLOSED_MAX = 1000; // closed items with an agent id (and carried marks), the reviewed marks' old cap
export const CLOSED_MAX = 30; // other closed items, per list
export const DISMISSED_MAX = 200; // the texts `d` dismissed, per list
export const FRESH_MS = 60_000; // the keeper asks only about exchanges at most this much older than the daemon
export const KEEPER_CLOSED = 10; // the newest closed items the keeper's prompt lists
const REVIEW_PREFIX = /^for review:\s*/i;

// One item as Synopia holds it. `block`: its lines as last read from the file (none: Synopia's own, never in
// the file). `agent`: the subagent a review item is for. `closed`: how it closed, when (ms), and a note.
// Phase 3 (FR-ITEM-09, -10): `found`, the keeper opened it and neither you nor the agent touched it since (a
// dashed box); `mine`, Synopia changed it since the file was last read or written (the write-back writes it);
// `touched`, when the agent's record or your action last changed it (ms; a keeper op that began before loses);
// `flips`, the keeper's closes and reopens since then (a fourth is refused: closed and reopened twice); `kept`, you undid the keeper's close: it stays off the item
// until the agent touches it. A close Synopia made carries `undo`, the item as it was, and `to`, a successor.
export type Snapshot = { kind: string; text: string; fields: Record<string, string>; found?: true };
export type Held = {
  id: string; prefix: Prefix; n: number; kind: string; text: string; fields: Record<string, string>;
  source: 'agent' | 'synopia'; block?: string; agent?: string; at: number | null;
  closed?: { how: string; at: number; note: string; by: 'agent' | 'synopia'; undo?: Snapshot; to?: string };
  found?: true; mine?: true; touched?: number; flips?: number; kept?: true;
};
// `dismissed`: the texts `d` said are not items, as compared (case and spacing aside), never opened again here.
export type List = { top: Record<Prefix, number>; items: Held[]; dismissed?: string[] };
// state.json `items`: the lists, and `carried`, agent ids marked reviewed whose item is in no list (the old
// `reviewed` marks until their subagent shows again, and the closed review items of a closed session's list).
export type ItemsState = { lists: Record<string, List>; carried: string[] };

// What the page shows for one session (the `openItems` frame, FR-ITEM-05).
export type ItemView = {
  id: string; kind: string; text: string; source: 'agent' | 'synopia'; at: number | null; minute: boolean;
  state?: string; options?: string[]; recommended?: string; trigger?: string; goesAhead?: string; watch?: string;
  subagent?: string; raisedBy?: string; answer?: string; agent?: string; found?: true;
  with?: { agent: string; name: string };
  reply?: string; // the block key of the reply it came from (FR-ITEM-07): a Claude block, or a raised item's report
};
export type ClosedView = { id: string; kind: string; text: string; how: string; at: number; note: string; by: 'agent' | 'synopia'; found?: true; undo?: true };
export type View = { items: ItemView[]; checks: ItemView[]; closed: ClosedView[]; unread: number; note: string | null };
export type Counts = { review: number; waiting: number; due: number };

// What open-items.ts reads of a session's transcript (transcripts.ts).
export type ItemFacts = {
  ledgerOf(sid: string): LedgerFact | null;
  ownsOf(sid: string, toolUseId: string): string[];
  agents(sid: string): Agent[];
  lastYouAt(sid: string): number | null; // your last message (ms), for Closed this turn
  replies(sid: string): Reply[]; // the main conversation's Claude blocks and subagent reports, in transcript order
  // Phase 3: where the keeper's exchanges are (transcripts.ts exchangeKeys), the session's title for a `from`
  // field, and whether a turn of it runs (no write-back then).
  exchangeKeys?(sid: string): { you: { key: string; ms: number } | null; turn: { key: string; ms: number } | null };
  title?(sid: string): string;
  turnRunning?(sid: string): boolean;
};
// One block of the main conversation an item can come from: Claude's text (`claude`) or a subagent's report.
// `id` is the item id, which is the page's block key.
export type Reply = { id: string; k: 'claude' | 'report'; ts: string | null; text: string; agent?: string };
// What the scan for an item's reply found so far, over the first `n` replies (FR-ITEM-07).
type Link = { n: number; quote: string | null; time: string | null; report: string | null };
export type FileIo = {
  stat(p: string): Promise<{ size: number; mtimeMs: number }>;
  read(p: string): Promise<string>;
  write?(p: string, text: string): Promise<void>; // the write-back: the whole file at once (default: tmp and rename)
};
// A temporary file beside it, renamed over it, so a reader sees the old file or the new one, never half.
async function writeAtomic(p: string, text: string): Promise<void> {
  const tmp = path.join(path.dirname(p), `.open-items.md.synopia-${process.pid}.tmp`);
  let mode = 0o644;
  try { mode = (await fs.stat(p)).mode & 0o777; } catch { /* a new mode then */ }
  try {
    await fs.writeFile(tmp, text, { mode });
    await fs.rename(tmp, p);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}
const realIo: FileIo = {
  stat: (p) => fs.stat(p),
  read: (p) => fs.readFile(p, 'utf8'),
  write: writeAtomic,
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
    const snap = cleanSnapshot(c.undo);
    if (snap) h.closed.undo = snap;
    if (isStr(c.to) && ID.test(c.to)) h.closed.to = c.to;
  }
  if (v.found === true) h.found = true;
  if (v.mine === true) h.mine = true;
  if (v.kept === true) h.kept = true;
  if (isNum(v.touched)) h.touched = v.touched;
  if (isNum(v.flips)) h.flips = v.flips;
  return h;
}

function cleanSnapshot(v: unknown): Snapshot | undefined {
  if (!isObj(v) || !isStr(v.kind) || !isStr(v.text)) return undefined;
  const fields: Record<string, string> = {};
  if (isObj(v.fields)) for (const [k, x] of Object.entries(v.fields)) if (isStr(x)) fields[k] = x;
  return { kind: v.kind, text: v.text, fields, ...(v.found === true ? { found: true as const } : {}) };
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
      if (Array.isArray(l.dismissed)) out.lists[key].dismissed = l.dismissed.filter(isStr).slice(-DISMISSED_MAX);
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
  private links = new Map<string, Map<string, Link>>(); // open session -> item -> its reply scan (never stored)
  private ask: ((sid: string, kind: ExchangeKind, key: string) => void) | null;
  private startedAt: number;
  private cursors = new Map<string, { you: string | null; turn: string | null }>(); // the exchanges asked about
  private pending = new Set<string>(); // ledgers whose list Synopia changed since the file was written (FR-ITEM-11)
  private writing = new Map<string, Promise<boolean>>(); // the write-back running per ledger
  private named = new Map<string, { path: string; at: number }>(); // a ledger open_items named, until the transcript has it

  constructor(o: {
    store: Store; facts: ItemFacts; io?: FileIo; home?: string; log?: Log; now?: () => number;
    onChange?: (sids: string[]) => void; lookMs?: number;
    ask?: (sid: string, kind: ExchangeKind, key: string) => void; // the keeper (keeper.ts ask)
  }) {
    this.store = o.store;
    this.facts = o.facts;
    this.io = o.io ?? realIo;
    this.home = o.home ?? os.homedir();
    this.log = o.log ?? nullLog;
    this.now = o.now ?? Date.now;
    this.changed = o.onChange ?? (() => {});
    this.ask = o.ask ?? null;
    this.startedAt = this.now();
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
    let fact = this.facts.ledgerOf(sid);
    const named = this.named.get(sid); // open_items named a ledger the transcript may not show yet (FR-ITEM-12)
    if (named && (!fact || (Date.parse(fact.at ?? '') || 0) < named.at - 5000)) fact = { path: named.path, at: new Date(named.at).toISOString(), toolUseId: '', results: this.uses.get(sid)?.results ?? 0 };
    else if (named) this.named.delete(sid);
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
    this.askKeeper(sid);
  }

  // FR-ITEM-08: a new message of yours asks the keeper once, and so does a main turn that is over; an
  // exchange older than the daemon (a transcript read at open) asks nothing.
  private askKeeper(sid: string): void {
    const k = this.ask && this.facts.exchangeKeys?.(sid);
    if (!k) return;
    const c = this.cursors.get(sid) ?? { you: null, turn: null };
    this.cursors.set(sid, c);
    const fresh = (ms: number) => ms >= this.startedAt - FRESH_MS;
    if (k.you && k.you.key !== c.you) {
      c.you = k.you.key;
      if (fresh(k.you.ms)) this.ask!(sid, 'you', k.you.key);
    }
    if (k.turn && k.turn.key !== c.turn) {
      c.turn = k.turn.key;
      if (fresh(k.turn.ms)) this.ask!(sid, 'turn', k.turn.key);
    }
  }

  // The session closed: a `session:` list goes, its closed review items carried as marks, so a reopened session's
  // reviewed deliverables stay reviewed. A ledger's list stays (another or a reopened session may use it).
  close(sid: string): void {
    const key = `session:${sid}`;
    const l = this.state.lists[key];
    this.uses.delete(sid);
    this.links.delete(sid);
    this.cursors.delete(sid);
    this.named.delete(sid);
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
    const links = this.links.get(from);
    this.links.delete(from);
    if (links) this.links.set(to, links);
    const cur = this.cursors.get(from);
    this.cursors.delete(from);
    if (cur) this.cursors.set(to, cur);
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
    this.yours(h);
    this.after(sid);
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
    const replies = this.facts.replies(sid), was = this.links.get(sid), links = new Map<string, Link>();
    this.links.set(sid, links); // the scans of the items shown now, kept for the next view
    for (const h of l.items) {
      if (h.closed) {
        if (since !== null && h.closed.at >= since) {
          const c: ClosedView = { id: h.id, kind: h.kind, text: h.text, how: h.closed.how, at: h.closed.at, note: h.closed.note, by: h.closed.by };
          if (h.closed.by === 'synopia' && h.closed.undo) { c.undo = true; if (h.closed.undo.found) c.found = true; }
          out.closed.push(c);
        }
        continue;
      }
      const v = this.itemView(h, briefs);
      const reply = this.replyOf(sid, h, replies, was, links);
      if (reply) v.reply = reply;
      (h.prefix === 'Y' ? out.items : out.checks).push(v);
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

  // ---------- the keeper, d and Undo (FR-ITEM-08 to -10) ----------

  // The list as the keeper reads it: the open items, and the newest closed ones (to catch a wrong reopen).
  keeperList(sid: string): { open: ListItem[]; closed: ListItem[] } | null {
    if (!this.uses.has(sid)) return null;
    const l = this.listOf(sid);
    const open: ListItem[] = [], closed: ListItem[] = [];
    for (const h of l?.items ?? []) {
      const f = h.fields, i: ListItem = { id: h.id, kind: h.kind, text: h.text };
      if (h.closed) { if (h.text) closed.push({ ...i, closed: h.closed.how }); continue; }
      if (f.state) i.state = f.state;
      const options = optionsOf({ fields: f } as OpenItem);
      if (options.length) i.options = options;
      if (f.recommended) i.recommended = f.recommended;
      if (f.trigger || f['goes ahead']) i.trigger = f.trigger || f['goes ahead'];
      open.push(i);
    }
    const at = (id: string) => l!.items.find((h) => h.id === id)!.closed!.at;
    return { open, closed: closed.sort((a, b) => at(b.id) - at(a.id)).slice(0, KEEPER_CLOSED) };
  }

  // The keeper's checked ops for an exchange (keeper.ts), applied in the order you, the agent, the keeper: the
  // ledger is read first, so the agent's record of the same exchange is in; an op on an item the agent or you
  // changed since the call `began` is dropped, as are the keeper's ops on an item you undid, or one that
  // flipped twice. Each drop is logged.
  async applyOps(sid: string, ex: Exchange, ops: Op[], began: number): Promise<void> {
    const u0 = this.uses.get(sid);
    if (!u0) return;
    if (u0.path) await this.read(u0.path);
    const u = this.uses.get(sid);
    if (!u) return;
    const l = this.list(u.key); // a session with no ledger gets its `session:` list here
    const now = this.now(), drop = (op: Op, why: string) => this.log('items.keeperDropped', { sid, op: op.op, id: 'id' in op ? op.id : null, why });
    let dirty = false;
    for (const op of ops) {
      if (op.op === 'open') {
        const k = textKey(op.text);
        if (l.dismissed?.includes(k)) { drop(op, 'dismissed'); continue; }
        if (l.items.some((h) => !h.closed && textKey(h.text) === k)) { drop(op, 'already open'); continue; }
        const prefix: Prefix = op.kind === 'follow-up' ? 'A' : 'Y';
        l.top[prefix] += 1;
        const fields: Record<string, string> = {};
        if (op.options?.length) fields.options = op.options.join(' | ');
        if (op.recommended) fields.recommended = op.recommended;
        if (op.trigger) fields[op.kind === 'default' ? 'goes ahead' : 'trigger'] = op.trigger;
        if (op.raisedBy) fields['raised by'] = op.raisedBy;
        fields.from = fromField(this.facts.title?.(sid) ?? '', now, op.quote);
        l.items.push({ id: `${prefix}${l.top[prefix]}`, prefix, n: l.top[prefix], kind: op.kind, text: op.text, fields, source: 'synopia', at: now, found: true, mine: true });
        dirty = true;
        continue;
      }
      const h = l.items.find((x) => x.id === op.id);
      if (!h) { drop(op, 'gone'); continue; }
      if ((h.touched ?? 0) >= began) { drop(op, 'the agent or you came first'); continue; }
      if (h.kept) { drop(op, 'you undid the keeper here'); continue; }
      if (op.op === 'update') {
        if (h.closed || h.fields.state === op.state) { drop(op, 'closed or unchanged'); continue; }
        h.fields = withField(h.fields, 'state', op.state);
        h.mine = true;
        dirty = true;
        continue;
      }
      if ((h.flips ?? 0) >= 3) { drop(op, 'flipped twice'); this.log('items.flipping', { sid, id: h.id }); continue; }
      if (op.op === 'reopen') {
        if (!h.closed || !h.text) { drop(op, 'not closed'); continue; }
        if (h.closed.undo) this.restore(h, h.closed.undo);
        delete h.closed;
        h.flips = (h.flips ?? 0) + 1;
        h.mine = true;
        dirty = true;
        continue;
      }
      if (h.closed) { drop(op, 'closed already'); continue; }
      const said = op.src === 'you' ? `you said “${op.answer ?? op.quote}”` : `“${op.quote}”`;
      const note = op.as === 'answered' ? `you said “${op.answer ?? op.quote}”`
        : op.as === 'superseded' ? `superseded by ${op.by}`
          : `${op.as === 'done' ? 'closed' : op.as} by Synopia: ${op.why ?? said}`;
      h.closed = { how: op.as, at: now, note, by: 'synopia', undo: this.snapshot(h), ...(op.by ? { to: op.by } : {}) };
      if (op.as === 'answered' && op.answer) h.fields = withField(h.fields, 'answer', `"${op.answer}"`);
      h.flips = (h.flips ?? 0) + 1;
      h.mine = true;
      dirty = true;
    }
    if (!dirty) return;
    this.prune();
    this.store.changed();
    this.touch(u.key, sid);
    this.written(u.key);
  }

  // `d` (FR-ITEM-10): an open item that isn't a review item is not an item. It closes as dropped with Undo, and
  // its text is never opened again in this list.
  notItem(sid: string, id: string): boolean {
    const h = this.find(sid, id), l = this.listOf(sid);
    if (!h || !l || h.closed || h.kind === 'review') return false;
    h.closed = { how: 'dropped', at: this.now(), note: 'not an item: you said so', by: 'synopia', undo: this.snapshot(h) };
    l.dismissed = [...(l.dismissed ?? []).filter((t) => t !== textKey(h.text)), textKey(h.text)].slice(-DISMISSED_MAX);
    this.yours(h);
    this.after(sid);
    return true;
  }

  // Undo (FR-ITEM-10): a line under Closed this turn that Synopia closed reopens as it was; the keeper stays off
  // it until the agent touches it. False for anything else.
  undo(sid: string, id: string): boolean {
    const h = this.find(sid, id), l = this.listOf(sid);
    const youAt = this.facts.lastYouAt(sid), since = youAt === null ? null : Math.floor(youAt / 60_000) * 60_000;
    if (!h || !l || !h.closed?.undo || h.closed.by !== 'synopia' || since === null || h.closed.at < since) return false;
    this.restore(h, h.closed.undo);
    delete h.closed;
    if (l.dismissed) l.dismissed = l.dismissed.filter((t) => t !== textKey(h.text));
    this.yours(h);
    h.kept = true;
    this.after(sid);
    return true;
  }

  // ---------- the open_items tool (FR-ITEM-12) ----------

  // One call of the agent's `open_items` tool, from the main conversation of a session Synopia runs (cards.ts
  // refused a subagent's). The agent's record: a solid box, ids from the list, written to the file after the turn.
  async toolOp(sid: string, input: Record<string, unknown>, cwd = ''): Promise<{ ok: boolean; text: string }> {
    const s = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
    if (!this.uses.has(sid)) await this.sync(sid);
    if (!this.uses.has(sid)) return { ok: false, text: 'This session isn\'t open in Synopia.' };
    const given = s(input.ledger);
    if (given) {
      const abs = ledgerPathOf(given, cwd, this.home);
      if (!abs) return { ok: false, text: `${given} is not a ledger: give the absolute path of .ai-notes/<area>/open-items.md.` };
      if (this.uses.get(sid)!.key !== abs) { this.named.set(sid, { path: abs, at: this.now() }); await this.sync(sid); }
    }
    const u = this.uses.get(sid)!, l = this.list(u.key), now = this.now();
    const op = s(input.op), id = s(input.id);
    if (op === 'list') return { ok: true, text: this.listText(l) };
    if (op === 'open') {
      const kind = s(input.kind), text = s(input.text).slice(0, 300);
      if (!['decision', 'your task', 'default', 'review', 'follow-up'].includes(kind)) return { ok: false, text: 'Give a kind: decision, your task, default, review or follow-up.' };
      if (!text) return { ok: false, text: 'Give the item\'s text, one sentence.' };
      const prefix: Prefix = kind === 'follow-up' ? 'A' : 'Y';
      l.top[prefix] += 1;
      const fields: Record<string, string> = {};
      const options = Array.isArray(input.options) ? input.options.map(s).filter(Boolean).map((o) => o.replace(/\s*\|\s*/g, ' / ')) : [];
      if (options.length) fields.options = options.join(' | ');
      if (s(input.recommended)) fields.recommended = s(input.recommended);
      if (s(input.trigger)) fields[kind === 'default' ? 'goes ahead' : 'trigger'] = s(input.trigger);
      fields.from = fromField(this.facts.title?.(sid) ?? '', now, s(input.quote)).replace(/^Synopia, /, 'Claude, ');
      const h: Held = { id: `${prefix}${l.top[prefix]}`, prefix, n: l.top[prefix], kind, text, fields, source: 'agent', at: now, mine: true, touched: now };
      l.items.push(h);
      this.after(sid);
      return { ok: true, text: `Opened ${h.id}.` };
    }
    const h = l.items.find((x) => x.id === id);
    if (!h || h.closed) return { ok: false, text: `${id || 'No id'}: no open item has that id. Call op list to see them.` };
    if (op === 'update') {
      const state = s(input.state);
      if (state && !['answered', 'due', 'later'].includes(state)) return { ok: false, text: 'state is answered, due or later.' };
      if (state) h.fields = withField(h.fields, 'state', state);
      if (s(input.answer)) h.fields = withField(h.fields, 'answer', `"${s(input.answer).replace(/"/g, "'")}"`);
      if (s(input.text)) h.text = s(input.text).slice(0, 300);
      this.agents(h);
      this.after(sid);
      return { ok: true, text: `Updated ${h.id}.` };
    }
    if (op === 'close') {
      const as = s(input.as), by = s(input.by);
      if (!['done', 'went ahead', 'dropped', 'superseded', 'answered'].includes(as)) return { ok: false, text: 'as is done, went ahead, dropped, superseded or answered.' };
      if (as === 'superseded' && !l.items.some((x) => x.id === by && !x.closed)) return { ok: false, text: 'Superseded needs by: the open id that replaces it.' };
      const why = s(input.why) || (as === 'answered' && s(input.answer) ? `"${s(input.answer)}"` : '');
      h.closed = { how: as, at: now, note: as === 'superseded' ? `superseded by ${by}` : why, by: 'agent', ...(by ? { to: by } : {}) };
      this.agents(h);
      this.after(sid);
      return { ok: true, text: `Closed ${h.id}.` };
    }
    return { ok: false, text: 'op is open, update, close or list.' };
  }

  // The agent's record on an item: Synopia's marks on it go (FR-ITEM-09).
  private agents(h: Held): void {
    h.touched = this.now();
    h.mine = true;
    delete h.found; delete h.flips; delete h.kept;
  }

  // What `list` returns: the open items, then the newest 10 closed, one line each.
  private listText(l: List): string {
    const open = l.items.filter((h) => !h.closed).map((h) => `${h.id} · ${h.kind} · ${h.text}${h.fields.state ? ` (${h.fields.state})` : ''}`);
    const closed = l.items.filter((h) => h.closed).sort((a, b) => b.closed!.at - a.closed!.at).slice(0, 10).map((h) => `${h.id} · ${h.closed!.how}${h.text ? ` · ${h.text}` : ''}`);
    return [open.length ? 'Open:' : 'Nothing open.', ...open, ...(closed.length ? ['Closed lately:', ...closed] : [])].join('\n');
  }

  // Whether an open session's list holds this item, open or closed (router.ts, for Undo).
  holdsAny(sid: string, id: string): boolean {
    return !!this.find(sid, id);
  }

  private snapshot(h: Held): Snapshot {
    return { kind: h.kind, text: h.text, fields: { ...h.fields }, ...(h.found ? { found: true as const } : {}) };
  }

  private restore(h: Held, s: Snapshot): void {
    h.kind = s.kind; h.text = s.text; h.fields = { ...s.fields };
    if (s.found) h.found = true; else delete h.found;
  }

  // Your action on an item: it counts as touched (a keeper op begun before loses), and the flips start again.
  private yours(h: Held): void {
    h.touched = this.now();
    h.mine = true;
    delete h.flips;
    delete h.kept;
  }

  private after(sid: string): void {
    this.prune();
    this.store.changed();
    const key = this.uses.get(sid)!.key;
    this.touch(key, sid);
    this.written(key);
  }

  // The list changed in Synopia: the ledger is written back when it can be (FR-ITEM-11). A `session:` list never is.
  private written(key: string): void {
    if (key.startsWith('session:')) return;
    this.pending.add(key);
    void this.writeBack(key);
  }

  // ---------- the write-back (FR-ITEM-11) ----------

  // Writes the ledger from its list, when the list changed in Synopia and no session using the ledger has a turn
  // running; else it stays pending, and the 2 s look tries again. The file is read and merged first (its changes
  // win), and written only when it reads as version 1 with the comment and has no line Synopia can't read. True
  // when it wrote.
  writeBack(file: string): Promise<boolean> {
    const running = this.writing.get(file);
    if (running) return running.then(() => this.writeBack(file)); // a change during a write: written after it
    if (!this.pending.has(file) || this.busy(file)) return Promise.resolve(false);
    const w = this.writeOnce(file).finally(() => this.writing.delete(file));
    this.writing.set(file, w);
    return w;
  }

  // The write-backs running now, done (tests, and before a quit).
  async flushWrites(): Promise<void> {
    while (this.writing.size) await Promise.all([...this.writing.values()]);
  }

  private async writeOnce(file: string): Promise<boolean> {
    try {
      await this.read(file);
      const rd = this.reads.get(file), l = this.state.lists[file];
      const skip = (why: string) => { this.pending.delete(file); this.log('items.notWritten', { why }); return false; };
      if (!rd || !l) return skip('no list');
      if (rd.note) return skip(rd.note);
      if (rd.unread) return skip('unread lines');
      let text: string;
      try { text = await this.io.read(file); } catch { return skip('gone'); }
      const led = parse(text);
      const comment = text.split(/\r\n|\n|\r/).find((x) => x.startsWith('<!-- open-items v1.'));
      if (led.version !== 1 || !comment) return skip('no version 1 comment');
      if (led.unread.length) return skip('unread lines');
      const out = serialize(this.docOf(file, l, led.area ?? '', comment));
      if (out === text) { this.pending.delete(file); return false; }
      if (this.busy(file)) return false; // a turn began meanwhile: after it
      // the file changed since it was read (a terminal's turn wrote it): read it again on the next look first
      const now = await this.io.stat(file).catch(() => null);
      if (!now || now.size !== rd.size || now.mtimeMs !== rd.mtimeMs) return false;
      await (this.io.write ?? writeAtomic)(file, out);
      const back = parse(out), blocks = new Map([...back.items, ...back.closed].map((f) => [f.id, blockOf(f)]));
      for (const h of l.items) {
        const b = blocks.get(h.id);
        if (b !== undefined) { h.block = b; delete h.mine; }
      }
      try { const st = await this.io.stat(file); rd.size = st.size; rd.mtimeMs = st.mtimeMs; } catch { /* the look reads it */ }
      this.pending.delete(file);
      this.store.changed();
      this.log('items.written', { open: back.items.length, closed: back.closed.length });
      return true;
    } catch (e) {
      this.log('items.writeFailed', { error: (e as NodeJS.ErrnoException).code ?? 'error' });
      return false;
    }
  }

  // A turn of a session using the ledger runs (Synopia's process works, or the transcript shows a turn open).
  private busy(file: string): boolean {
    return this.sessionsOf(file).some((sid) => this.facts.turnRunning?.(sid) ?? false);
  }

  // The list as ledger.ts writes it: an item Synopia didn't change keeps its lines as read.
  private docOf(file: string, l: List, area: string, comment: string): Doc {
    const doc: Doc = { area, comment, open: [], closed: [] };
    const title = this.sessionsOf(file).map((sid) => this.facts.title?.(sid) ?? '').find(Boolean) ?? '';
    for (const h of l.items) {
      const lines = h.block !== undefined && !h.mine ? h.block.split('\n') : undefined;
      if (!h.closed) {
        const fields = h.fields.from ? h.fields : withField(h.fields, 'from', fromField(title, h.at ?? this.now(), ''));
        doc.open.push({ id: h.id, kind: h.kind, text: h.text, fields, ...(lines ? { lines } : {}) });
        continue;
      }
      const c = h.closed;
      const box: SerialClosed['box'] = c.how === 'dropped' ? '-' : c.how === 'superseded' ? '>' : 'x';
      const to = c.to ?? /^superseded by ([YA]\d+)/.exec(c.note)?.[1];
      if (box === '>' && !to && !lines) continue; // no successor to name: not a line the format has
      const notes = box === '>' ? [] : [c.note].filter(Boolean);
      doc.closed.push({ id: h.id, box, how: c.how, when: stampOf(c.at), notes, at: c.at, ...(to ? { by: to } : {}), ...(lines ? { lines } : {}) });
    }
    return doc;
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
    await Promise.all([...this.pending].map((p) => this.writeBack(p))); // a turn ended since: the write waits no more
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
      // changes of Synopia's not in the file yet (made before a restart, say): the write-back looks again
      if (rd.note === null && this.state.lists[file]?.items.some((h) => h.mine)) this.pending.add(file);
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
      fresh.touched = this.now(); // the agent's record: a keeper op begun before it loses (FR-ITEM-09)
      delete fresh.found; // the agent touched it: no longer only Synopia's find
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
      const h: Held = { id: f.id, prefix: f.prefix, n: f.n, kind: f.kind, text: f.text, fields: { ...f.fields }, source: 'agent', block, at: from ? stampTime(from.at)?.ms ?? null : null };
      if (from?.who === 'Synopia' && f.kind !== 'review') h.found = true; // a find of Synopia's this list didn't hold (a restore, another Mac)
      return h;
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

  // The reply an item came from (FR-ITEM-07), as the page's block key: for an item a subagent raised, that
  // subagent's latest report; else the first Claude block holding the `from` quote word for word (runs of
  // white space aside); else the last Claude block at or before the `from` minute; else none. A date-only
  // stamp names no minute, so it has no time match. The scan goes on from where the last view left it, so each
  // reply is read once per item, not once per view; a shorter transcript (a reset) scans again.
  private replyOf(sid: string, h: Held, replies: Reply[], was: Map<string, Link> | undefined, links: Map<string, Link>): string | undefined {
    const raised = h.fields['raised by'], from = h.source === 'agent' ? fromOf({ fields: h.fields } as OpenItem) : null;
    if (!raised && !from) return undefined;
    const key = `${h.id}\n${h.fields.from ?? ''}\n${raised ?? ''}`;
    let l = was?.get(key);
    if (!l || l.n > replies.length) l = { n: 0, quote: null, time: null, report: null };
    const quote = from?.quote ? squash(from.quote) : null, st = from ? stampTime(from.at) : null;
    const limit = st?.minute ? st.ms + 60_000 : null;
    const named = raised ? new Set(this.facts.agents(sid).filter((a) => nameOf(a) === raised).map((a) => a.id)) : null;
    for (let i = l.n; i < replies.length; i++) {
      const r = replies[i];
      if (r.k === 'report') {
        if (named && r.agent && named.has(r.agent)) l.report = r.id;
        continue;
      }
      if (quote && !l.quote && squash(r.text).includes(quote)) l.quote = r.id;
      const ms = r.ts ? Date.parse(r.ts) : NaN;
      if (limit !== null && ms < limit) l.time = r.id;
    }
    l.n = replies.length;
    links.set(key, l);
    return l.report ?? l.quote ?? l.time ?? undefined;
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
    if (h.found) v.found = true;
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

// An item's text as compared for a duplicate or a dismissed text: case and runs of white space aside.
export const textKey = (t: string): string => t.replace(/\s+/g, ' ').trim().toLowerCase();

// The fields with one set, in the ledger's field order (ledger.ts FIELDS).
function withField(fields: Record<string, string>, key: string, value: string): Record<string, string> {
  const all = { ...fields, [key]: value };
  return Object.fromEntries(FIELDS.filter((k) => k in all).map((k) => [k, all[k]]).concat(Object.entries(all).filter(([k]) => !FIELDS.includes(k))));
}

// A `from` field for an item Synopia found: `Synopia, "<title>", <local stamp>, "<quote>"` (docs/Open items.md).
export function fromField(title: string, ms: number, quote: string): string {
  const t = (title || 'Session').replace(/\s+/g, ' ').replace(/"/g, "'").trim();
  const q = quote.replace(/\s+/g, ' ').replace(/"/g, "'").trim().slice(0, 120);
  return `Synopia, "${t}", ${stampOf(ms)}${q ? `, "${q}"` : ''}`;
}
const pad = (n: number) => String(n).padStart(2, '0');
// A local `YYYY-MM-DD HH:MM`, as the skill writes stamps (no zone).
export function stampOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Text compared for a quote: runs of white space as one space.
const squash = (t: string): string => t.replace(/\s+/g, ' ').trim();

// A subagent's name as the ledger's `subagent` field holds it: its description without `For review: `.
export const nameOf = (a: Pick<Agent, 'description'>): string => a.description.replace(REVIEW_PREFIX, '').trim();

// The note a view carries when nothing could be read (the page words it).
export const NOTES = {
  protected: 'Synopia doesn’t read files in a folder macOS protects',
  big: 'The ledger is over 256 KB',
  version: 'Synopia can’t read this ledger’s version',
  gone: 'The ledger file is gone',
} as const;
