// The sidebar's layout (FR-SIDE-03..05): groups and the order inside them, the user's own (no
// sorting). This module is its only writer. The page sends intents (`moveSession`, `newGroup`,
// `renameGroup`, router.ts resolves their ids first, so a late one with an old id still lands); the
// open list adds and renames ids (sessions.ts); a session another one started goes right under it
// (`placeUnder`, agent-tools.ts); every change goes whole to every page as `layout`.
// A closed session keeps its place, hidden, so reopening it puts it back where it was. A rename
// (a new session's real id, a reset) is not sent alone: it goes with the `session` frame that
// carries `replaces` (publisher.ts), so a page never sees the layout and the session disagree.
import { randomUUID } from 'node:crypto';
import type { OpenEntry, Store } from './store.ts';

export type Group = { id: string; name: string; ids: string[] };
export type Layout = { groups: Group[]; others: string[] };
// Where a moved session goes: before or after a session, or last in a group ("others" is Not in a group).
export type Place = { before: string } | { after: string } | { group: string };
export type Result = { ok: true } | { ok: false; error: string };

export const OTHERS = 'others';
export const NEW_GROUP = 'New group';
const NAME_MAX = 200;
const GROUP_ID = /^[A-Za-z0-9_-]{1,64}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

// A stored or sent layout as data: anything malformed becomes empty.
export function cleanLayout(v: unknown): Layout {
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

const copy = (l: Layout): Layout => ({ groups: l.groups.map((g) => ({ ...g, ids: [...g.ids] })), others: [...l.others] });
const without = (l: Layout, id: string): Layout => ({
  groups: l.groups.map((g) => ({ ...g, ids: g.ids.filter((x) => x !== id) })), others: l.others.filter((x) => x !== id),
});
const listOf = (l: Layout, id: string): string[] | null =>
  l.groups.find((g) => g.ids.includes(id))?.ids ?? (l.others.includes(id) ? l.others : null);
// A group goes only when it holds no id at all, hidden ones included.
const dropEmpty = (l: Layout): Layout => ({ groups: l.groups.filter((g) => g.ids.length > 0), others: l.others });

// The layout against the open list (plus the new sessions not stored yet):
// - ids are kept only for known sessions, each once (first place wins);
// - closed ids stay where they are, hidden;
// - open ids found nowhere go last under Not in a group;
// - a group with no ids at all goes.
export function reconcile(layout: Layout, open: OpenEntry[]): Layout {
  const known = new Set(open.map((e) => e.id));
  const seen = new Set<string>();
  const take = (ids: string[]) => ids.filter((id) => {
    if (!known.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const l = cleanLayout(layout);
  const groups = l.groups.map((g) => ({ id: g.id, name: g.name, ids: take(g.ids) }));
  const others = take(l.others);
  for (const e of open) {
    if (seen.has(e.id) || e.closedAt !== null) continue;
    seen.add(e.id);
    others.push(e.id);
  }
  return dropEmpty({ groups, others });
}

// `id` taken out of its place and put at `to`. A string is why it can't be done.
export function moveSession(layout: Layout, id: string, to: Place): Layout | string {
  if (('before' in to && to.before === id) || ('after' in to && to.after === id)) return copy(layout);
  const out = without(layout, id);
  if ('group' in to) {
    const list = to.group === OTHERS ? out.others : out.groups.find((g) => g.id === to.group)?.ids;
    if (!list) return 'That group is gone.';
    list.push(id);
  } else {
    const target = 'before' in to ? to.before : to.after;
    const list = listOf(out, target);
    if (!list) return "That session isn't in the sidebar any more.";
    list.splice(list.indexOf(target) + ('before' in to ? 0 : 1), 0, id);
  }
  return dropEmpty(out);
}

// A new group of `onto` (a session not in a group) and `id`, last among the groups.
export function newGroup(layout: Layout, id: string, onto: string, group: string, name = NEW_GROUP): Layout | string {
  if (id === onto) return 'A group needs two sessions.';
  if (!GROUP_ID.test(group) || group === OTHERS || layout.groups.some((g) => g.id === group)) return 'That group id is taken.';
  const out = without(layout, id);
  const at = out.others.indexOf(onto);
  if (at === -1) return 'Only a session not in a group makes a new group.';
  out.others.splice(at, 1);
  out.groups.push({ id: group, name: name.trim().slice(0, NAME_MAX) || NEW_GROUP, ids: [onto, id] });
  return dropEmpty(out);
}

export function renameGroup(layout: Layout, group: string, name: string): Layout | string {
  const n = name.trim().slice(0, NAME_MAX);
  if (!n) return 'A group needs a name.';
  const out = copy(layout), g = out.groups.find((x) => x.id === group);
  if (!g) return 'That group is gone.';
  g.name = n;
  return out;
}

// A session a session started (agent-tools.ts start_session, R3.15): `id` right under `caller` in the
// caller's group, or, when the caller is in none, a new group `group` of the two named after the
// caller (last among the groups, as a drop makes one).
export function placeUnder(layout: Layout, id: string, caller: string, group: string, name: string): Layout | string {
  if (id === caller) return 'A session can\'t start itself.';
  const inGroup = layout.groups.some((g) => g.ids.includes(caller));
  if (inGroup) return moveSession(layout, id, { after: caller });
  if (!layout.others.includes(caller)) return "That session isn't in the sidebar any more.";
  return newGroup(layout, id, caller, group, name);
}

// A session's id changed: it keeps its place (or goes last under Not in a group when it had none).
export function renameId(layout: Layout, old: string, id: string): Layout {
  const swap = (ids: string[]) => ids.map((x) => (x === old ? id : x));
  const out: Layout = { groups: layout.groups.map((g) => ({ ...g, ids: swap(g.ids) })), others: swap(layout.others) };
  if (!listOf(out, id)) out.others.push(id);
  return out;
}

export type LayoutsOptions = {
  store: Store;
  // The ids the layout may hold: the open list and the new sessions not stored yet (sessions.ts).
  entries: () => OpenEntry[];
  // To every page (publisher.ts `layout`).
  publish: (layout: Layout) => void;
};

// The owner: state.json's `layout` section, kept reconciled, written only here.
export class Layouts {
  private o: LayoutsOptions;

  constructor(opts: LayoutsOptions) {
    this.o = opts;
  }

  get(): Layout {
    return this.o.store.state.layout;
  }

  // ---------- the page's intents (ids resolved by the router) ----------

  move(id: string, to: Place): Result {
    if (!this.placed(id)) return { ok: false, error: "That session isn't open any more." };
    return this.apply(moveSession(this.get(), id, to));
  }

  newGroup(id: string, onto: string, group: string, name?: string): Result {
    if (!this.placed(id) || !this.placed(onto)) return { ok: false, error: "That session isn't open any more." };
    return this.apply(newGroup(this.get(), id, onto, group, name));
  }

  renameGroup(group: string, name: string): Result {
    return this.apply(renameGroup(this.get(), group, name));
  }

  // ---------- Synopia's tools for agents ----------

  // A started session goes right under the session that started it (placeUnder); a new group gets
  // an id no group has.
  placeUnder(id: string, caller: string, name: string): Result {
    if (!this.placed(id) || !this.placed(caller)) return { ok: false, error: "That session isn't open any more." };
    let group = '';
    do group = `g${randomUUID().slice(0, 8)}`; while (this.get().groups.some((g) => g.id === group));
    return this.apply(placeUnder(this.get(), id, caller, group, name));
  }

  // ---------- the open list ----------

  // After the open list changed (start, a new or reopened session): every open id has a place.
  sync(): void {
    this.set(this.get(), true);
  }

  // A session's id changed. Not sent alone: the `session` frame with `replaces` carries the layout.
  rename(old: string, id: string): void {
    this.set(renameId(this.get(), old, id), false);
  }

  private placed(id: string): boolean {
    return this.o.entries().some((e) => e.id === id && e.closedAt === null);
  }

  private apply(next: Layout | string): Result {
    if (typeof next === 'string') return { ok: false, error: next };
    this.set(next, true);
    return { ok: true };
  }

  private set(next: Layout, publish: boolean): void {
    const l = reconcile(next, this.o.entries());
    if (JSON.stringify(l) === JSON.stringify(this.get())) return;
    this.o.store.state.layout = l;
    this.o.store.changed();
    if (publish) this.o.publish(l);
  }
}
