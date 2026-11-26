// Transcript find (R5.12e, R9.9, 2026-11-26): the one owner of what ⌘F searches in a view. A page asks
// `find {sid, view, q}` and gets `found` with the matching items in transcript order and, per item, the
// [from, to) offsets of each match in its search text (itemText). The main conversation searches all its
// items, a subagent's view its own sidechain, a shell's, monitor's or `!` run's view its output (the last
// FIND_READ bytes of a shell's file, as its view shows at most that much). The search text of an item is
// the text the page renders for it: your prompt, Claude's text, a step's line, input and result preview,
// a `!` command and its output, a question with its options and answer, a report, a title, a folder.
// Matching ignores case, as the file preview's find does (preview.js findIn). Pure but for findSource's
// reads, which the caller does (publisher.ts).
import type { Item } from './transcript.ts';
import { plainText } from './pty.ts';

export type Hit = { id: string; at: [number, number][] };
export type Found = { hits: Hit[]; total: number; more: boolean };
// What a view searches: its items, or the plain text of its output (one hit, the view's id).
export type FindSource = { items: Item[] } | { id: string; text: string };

export const MAX_MATCHES = 10_000; // offsets past this many aren't sent; `more` says so
export const MAX_QUERY = 500;
export const FIND_READ = 4 * 1024 * 1024; // a shell's output searched: its last 4 MB, what its view can load

// A step's name as the page shows it (transcript.js toolName): the CLI's name, Agent for Task, an MCP tool's verb.
const toolName = (i: Item): string => (i.name && !i.name.startsWith('mcp__') ? (i.name === 'Task' ? 'Agent' : i.name) : i.verb || '');

// The text the page renders for one item, its parts joined by line feeds, in the order shown.
export function itemText(i: Item): string {
  const parts: (string | null | undefined)[] = [];
  switch (i.k) {
    case 'you': case 'claude': case 'report': parts.push(i.text); break;
    case 'title': parts.push(i.title); break;
    case 'moved': parts.push(i.cwd); break;
    case 'bang': parts.push(i.cmd, i.sh?.out, i.sh?.err); break;
    case 'ask':
      for (const q of i.qs || []) parts.push(q.q, ...(q.opts || []).map((o) => (Array.isArray(o) ? o[0] : String(o))));
      parts.push(i.answer);
      break;
    case 'tool':
      // a subagent's or fork's line shows its description only; another step its name and target
      parts.push(i.answer, i.name === 'Agent' || i.name === 'Task' ? i.obj : `${toolName(i)}${i.obj ? `(${i.obj})` : ''}`, i.input, i.out?.text);
      break;
  }
  return parts.filter((p): p is string => typeof p === 'string' && p !== '').join('\n');
}

// The [from, to) of each match of q in text, ignoring case, in text's own offsets. Lowercasing can change a
// length ("İ" becomes two code units): then each character is lowercased on its own and remembers where it
// came from, as preview.js findIn does; otherwise the offsets of the lowercased text are the text's.
export function matchesIn(text: string, q: string, cap = Infinity): [number, number][] {
  const out: [number, number][] = [];
  const needle = q.toLowerCase();
  if (!needle || !text) return out;
  const lo = text.toLowerCase();
  if (lo.length === text.length) {
    for (let i = lo.indexOf(needle); i >= 0 && out.length < cap; i = lo.indexOf(needle, i + needle.length)) out.push([i, i + needle.length]);
    return out;
  }
  let hay = '', pos = 0;
  const from: number[] = [], to: number[] = [];
  for (const ch of text) {
    const l = ch.toLowerCase();
    for (let k = 0; k < l.length; k++) { from.push(pos); to.push(pos + ch.length); }
    hay += l; pos += ch.length;
  }
  for (let i = hay.indexOf(needle); i >= 0 && out.length < cap; i = hay.indexOf(needle, i + needle.length)) out.push([from[i], to[i + needle.length - 1]]);
  return out;
}

// Every match in a view, in order: per item (or the output), its offsets. An empty or over-long query finds nothing.
export function find(src: FindSource | null, q: string): Found {
  const res: Found = { hits: [], total: 0, more: false };
  if (!src || !q || q.length > MAX_QUERY) return res;
  const one = (id: string, text: string): boolean => {
    const at = matchesIn(text, q, MAX_MATCHES - res.total + 1);
    if (res.total + at.length > MAX_MATCHES) { at.length = MAX_MATCHES - res.total; res.more = true; }
    if (at.length) { res.hits.push({ id, at }); res.total += at.length; }
    return !res.more;
  };
  if ('items' in src) { for (const i of src.items) if (!one(i.id, itemText(i))) break; }
  else one(src.id, plainText(src.text));
  return res;
}
