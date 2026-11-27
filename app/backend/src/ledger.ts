// The open-items ledger, `.ai-notes/<area>/open-items.md` (docs/Open items.md, FR-ITEM-01, FR-ITEM-04):
// its version 1 line shapes, the path rule, and the brief's `Open items:` line. The format belongs to the
// agent-harness open-items skill (its references/format.md and scripts/ledger.py); this is the only
// Synopia code that knows its shape. Unlike `ledger.py check`, one bad line doesn't fail the file: it is
// listed in `unread` and never guessed from, and the rest is read. Pure: no I/O.
import path from 'node:path';

export type Prefix = 'Y' | 'A';
// ' ' open; 'x' answered, done or went ahead; '-' dropped; '>' superseded.
export type Box = ' ' | 'x' | '-' | '>';

export type OpenItem = {
  id: string; prefix: Prefix; n: number; box: ' ';
  kind: string; text: string;
  fields: Record<string, string>;   // in file order, read fields only
  line: number;                     // 1-based
  lines: string[];                  // the item's own lines as written (item line and field lines)
};
export type ClosedItem = {
  id: string; prefix: Prefix; n: number; box: Exclude<Box, ' '>;
  how: 'answered' | 'done' | 'went ahead' | 'dropped' | 'superseded';
  when: string;                     // the stamp as written, 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM'
  by: string | null;                // the superseding id
  notes: string[];                  // the ' · ' parts after the head (and after the date of a superseded line)
  line: number;
  lines: string[];
};
export type Unread = { line: number; text: string; why: string };
export type Ledger = {
  area: string | null;              // null: no title line
  version: number | null;           // null: no version comment (read as version 1, as ledger.py does)
  items: OpenItem[];
  closed: ClosedItem[];
  unread: Unread[];
};

export const VERSION = 1;
export const WAITING = 'Waiting on you', CHECKS = 'Claude will check', CLOSED = 'Closed';
const SECTIONS = [WAITING, CHECKS, CLOSED];
export const Y_KINDS = ['decision', 'your task', 'default', 'review'];
export const A_KINDS = ['follow-up'];
export const FIELDS = ['state', 'options', 'recommended', 'trigger', 'goes ahead', 'watch', 'subagent', 'raised by', 'answer', 'from'];
export const STATES = ['answered', 'due', 'later'];
const SEP = ' · ';
const DATE = String.raw`\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?`;
const TITLE = /^# Open items: (\S.*)$/;
const VERSION_COMMENT = /^<!-- open-items v(\d+)\./;
const HEADING = /^## (.+)$/;
const OPEN = new RegExp(String.raw`^- \[ \] ([YA])(\d+) · ([a-z][a-z -]*?) · (\S.*)$`);
const CLOSED_LINE = /^- \[([x>-])\] ([YA])(\d+) · (.+)$/;
const FIELD = /^ {2}- ([a-z ]+): (\S.*)$/;
const CLOSE_HEAD: Record<string, RegExp> = {
  x: new RegExp(`^(answered|done|went ahead) (${DATE})$`),
  '-': new RegExp(`^(dropped) (${DATE})$`),
  '>': /^(superseded) by ([YA]\d+)$/,
};
const STAMP = new RegExp(DATE);
const STAMP_ONLY = new RegExp(`^${DATE}$`);

// Lines as `ledger.py` splits them, minus the Unicode separators Python's splitlines also breaks on.
const linesOf = (text: string): string[] => text.split(/\r\n|\n|\r/);

export function parse(text: string): Ledger {
  const led: Ledger = { area: null, version: null, items: [], closed: [], unread: [] };
  const lines = linesOf(text);
  const seen = new Set<string>();
  const sections: string[] = [];
  let section: string | null = null;
  let titled = false;
  // The open item the next field lines belong to; `lost` when they belong to a line Synopia can't read.
  let current: OpenItem | 'lost' | null = null;
  const bad = (line: number, why: string) => led.unread.push({ line, text: lines[line - 1], why });

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], number = i + 1;
    if (!line.trim()) continue;
    if (!titled) {
      titled = true;
      const t = TITLE.exec(line);
      if (t) led.area = t[1];
      else bad(number, "the first line must be '# Open items: <area>'");
      continue;
    }
    if (line.startsWith('<!--')) {
      const v = VERSION_COMMENT.exec(line);
      if (!v) { bad(number, "unknown comment: want '<!-- open-items v1. ...'"); continue; }
      if (led.version === null) led.version = Number(v[1]);
      if (led.version !== VERSION) return { ...led, items: [], closed: [], unread: [] };
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      const name = h[1];
      if (!SECTIONS.includes(name)) bad(number, `unknown section '${name}'`);
      else if (sections.includes(name)) bad(number, `section '${name}' twice`);
      else if (sections.length && SECTIONS.indexOf(name) < SECTIONS.indexOf(sections[sections.length - 1])) bad(number, `section '${name}' out of order`);
      sections.push(name);
      section = name;
      current = null;
      continue;
    }
    const f = FIELD.exec(line);
    if (f) {
      if (current === null) { bad(number, 'a field with no open item above it'); continue; }
      if (current === 'lost') { bad(number, 'a field of an item Synopia can\'t read'); continue; }
      current.lines.push(line);
      const [, key, value] = f;
      const keys = Object.keys(current.fields);
      if (!FIELDS.includes(key)) bad(number, `unknown field '${key}'`);
      else if (key in current.fields) bad(number, `field '${key}' twice`);
      else if (keys.length && FIELDS.indexOf(key) < FIELDS.indexOf(keys[keys.length - 1])) bad(number, `field '${key}' out of order`);
      else if (key === 'state' && !STATES.includes(value)) bad(number, `state '${value}'`);
      else current.fields[key] = value;
      continue;
    }
    current = null;
    const o = OPEN.exec(line), c = CLOSED_LINE.exec(line);
    const lose = (why: string) => { bad(number, why); current = o ? 'lost' : null; };
    const dup = (id: string): boolean => {
      if (!seen.has(id)) { seen.add(id); return false; }
      lose(`${id} is used twice`);
      return true;
    };
    if (o && (section === WAITING || section === CHECKS)) {
      const prefix = o[1] as Prefix, n = Number(o[2]), kind = o[3], id = `${prefix}${n}`;
      if ((prefix === 'Y') !== (section === WAITING)) { lose(`${id} in '${section}'`); continue; }
      if (!(prefix === 'Y' ? Y_KINDS : A_KINDS).includes(kind)) { lose(`kind '${kind}' for a ${prefix} item`); continue; }
      if (dup(id)) continue;
      const item: OpenItem = { id, prefix, n, box: ' ', kind, text: o[4], fields: {}, line: number, lines: [line] };
      led.items.push(item);
      current = item;
    } else if (c && section === CLOSED) {
      const box = c[1] as ClosedItem['box'], prefix = c[2] as Prefix, n = Number(c[3]), id = `${prefix}${n}`;
      const parts = c[4].split(SEP);
      const head = CLOSE_HEAD[box].exec(parts[0]);
      if (!head) { lose(`[${box}] ${id}: the words after the id fit no closed shape`); continue; }
      if (box === '-' && parts.length < 2) { lose(`${id}: a dropped line says why`); continue; }
      if (box === '>' && (parts.length < 2 || !STAMP_ONLY.test(parts[1]))) { lose(`${id}: want 'superseded by <id> · <date>'`); continue; }
      if (dup(id)) continue;
      const superseded = box === '>';
      led.closed.push({
        id, prefix, n, box, how: head[1] as ClosedItem['how'],
        when: superseded ? parts[1] : head[2], by: superseded ? head[2] : null,
        notes: parts.slice(superseded ? 2 : 1), line: number, lines: [line],
      });
    } else if (o || c) {
      lose(`an item line in the wrong section ('${section ?? 'none'}')`);
    } else {
      lose("a line that fits no shape (an item's text never wraps)");
    }
  }
  return led;
}

// An item's own lines, as written. Two reads of the file give the same block for an item the agent
// didn't touch (blank lines and other items' moves don't count).
export const blockOf = (item: OpenItem | ClosedItem): string => item.lines.join('\n');

// The next free number of a prefix: past every open and closed id, never reused.
export function nextId(led: Ledger, prefix: Prefix): string {
  const ns = [...led.items, ...led.closed].filter((i) => i.prefix === prefix).map((i) => i.n);
  return `${prefix}${Math.max(0, ...ns) + 1}`;
}

// The `options` field split into its set answers.
export const optionsOf = (item: OpenItem): string[] => (item.fields.options ? item.fields.options.split(' | ') : []);

// The `from` field: who, the session's title, the stamp, and the quote it came from. null when it has
// another shape (the item is still read).
export type From = { who: string; title: string; at: string; quote: string | null };
const FROM = new RegExp(`^([^,]+), "(.*?)", (${DATE})(?:, "(.*)")?$`);
export function fromOf(item: OpenItem): From | null {
  const m = FROM.exec(item.fields.from ?? '');
  return m ? { who: m[1], title: m[2], at: m[3], quote: m[4] ?? null } : null;
}

// A stamp as local time (the ledger writes no zone). `minute` is false for a date with no time, which
// reads as that day's midnight, so an age from it is good to the day only.
export function stampTime(text: string): { ms: number; minute: boolean } | null {
  const m = STAMP.exec(text);
  if (!m) return null;
  const [d, t] = m[0].split(' ');
  const [y, mo, day] = d.split('-').map(Number);
  const [h, mi] = t ? t.split(':').map(Number) : [0, 0];
  const ms = new Date(y, mo - 1, day, h, mi).getTime();
  return Number.isNaN(ms) ? null : { ms, minute: Boolean(t) };
}

// The path rule: `<anything>/.ai-notes/<area>/open-items.md`, absolute.
export function isLedgerPath(abs: string): boolean {
  if (!path.isAbsolute(abs)) return false;
  const parts = path.normalize(abs).split('/');
  const n = parts.length;
  return n >= 4 && parts[n - 1] === 'open-items.md' && parts[n - 3] === '.ai-notes' && parts[n - 2] !== '';
}

// A path a tool named, as an absolute ledger path, or null: relative to the record's `cwd`, `~/` to `home`.
export function ledgerPathOf(p: string, cwd: string, home: string): string | null {
  const abs = p.startsWith('~/') ? path.join(home, p.slice(2)) : path.isAbsolute(p) ? p : cwd ? path.resolve(cwd, p) : '';
  return abs && isLedgerPath(abs) ? path.normalize(abs) : null;
}

// The last ledger a Bash command names (`python3 ledger.py check .ai-notes/m2/open-items.md`), or null. A
// word is cut at spaces, quotes and shell operators; only a word ending in `open-items.md` is tried.
const COMMAND_PATH = /[^\s'"`;|&<>()=]*open-items\.md(?![^\s'"`;|&<>()])/g;
export function ledgerPathIn(command: string, cwd: string, home: string): string | null {
  let last: string | null = null;
  for (const m of command.matchAll(COMMAND_PATH)) last = ledgerPathOf(m[0], cwd, home) ?? last;
  return last;
}

// The ids a subagent's brief owns, from its `Open items: Y5 (…), A2 (…)` line. An id starts the list,
// follows `), `, or follows a bare id and `, `. The text in parentheses may hold commas and parentheses.
const BRIEF_LINE = /^\s*(?:[-*] )?(?:\*\*)?Open items:(?:\*\*)?\s*(.*)$/;
const ID_AT = /^([YA])(\d+)\b/;
export function ownedIds(prompt: string): string[] {
  const out: string[] = [];
  for (const line of linesOf(prompt)) {
    const m = BRIEF_LINE.exec(line);
    if (!m) continue;
    let rest = m[1];
    for (let t = ID_AT.exec(rest); t; t = ID_AT.exec(rest)) {
      const id = `${t[1]}${Number(t[2])}`;
      if (!out.includes(id)) out.push(id);
      rest = rest.slice(t[0].length);
      if (rest.startsWith(', ')) { rest = rest.slice(2); continue; }
      const next = rest.search(/\), [YA]\d+\b/);
      if (!/^\s*\(/.test(rest) || next < 0) break;
      rest = rest.slice(next + 3);
    }
  }
  return out;
}

// Which running subagent an open item is with (FR-ITEM-04): the agent whose brief names its id, while it
// runs; an item no brief names falls back to the running agent whose name is its `subagent` field.
// `agents` are every subagent of the session with a brief, in start order.
export type Brief = { agent: string; name: string; ids: string[]; running: boolean };
export function ownerOf(item: OpenItem, agents: Brief[]): string | null {
  const named = agents.filter((a) => a.ids.includes(item.id));
  if (named.length) return named.findLast((a) => a.running)?.agent ?? null;
  const field = item.fields.subagent;
  return field ? (agents.find((a) => a.running && a.name === field)?.agent ?? null) : null;
}

// ---------- writing (FR-ITEM-11) ----------

// One item to write: an open one, or a closed line. `lines`: the item's lines as last read, written as they
// are when Synopia didn't change it (the agent's own wording stays). `at`: when a closed item closed (ms), for
// which closed lines are kept.
export type SerialOpen = { id: string; kind: string; text: string; fields: Record<string, string>; lines?: string[] };
export type SerialClosed = {
  id: string; box: Exclude<Box, ' '>; how: string; when: string; notes: string[]; by?: string; at: number; lines?: string[];
};
export type Doc = { area: string; comment: string; open: SerialOpen[]; closed: SerialClosed[] };
export const CLOSED_KEPT = 30;
export const COMMENT = "<!-- open-items v1. Kept by AI: the open-items skill, and Synopia when it runs the session. Don't edit by hand; say it in the session instead. -->";

// One line of text as a value: no line break, no leading space (a field is `key: \S.*`).
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const idParts = (id: string): [Prefix, number] => [id[0] as Prefix, Number(id.slice(1))];

// The whole file, in the version 1 shapes `ledger.py check` accepts: the title, the version comment as the file
// had it, the three sections always, and under Closed the newest CLOSED_KEPT closed lines plus the highest id of
// each prefix (ledger.py prune's rule), oldest first. An open item keeps its place in `open`.
export function serialize(doc: Doc): string {
  const section = (prefix: Prefix): string[] => {
    const lines = doc.open.filter((i) => idParts(i.id)[0] === prefix).flatMap(openLines);
    return lines.length ? [...lines, ''] : [];
  };
  const top: Record<Prefix, number> = { Y: 0, A: 0 };
  for (const i of [...doc.open, ...doc.closed]) { const [p, n] = idParts(i.id); top[p] = Math.max(top[p], n); }
  const newest = new Set([...doc.closed].sort((a, b) => b.at - a.at).slice(0, CLOSED_KEPT));
  const kept = doc.closed.filter((c) => { const [p, n] = idParts(c.id); return newest.has(c) || n === top[p]; });
  kept.sort((a, b) => a.at - b.at);
  const out = [
    `# Open items: ${oneLine(doc.area) || 'notes'}`, '',
    VERSION_COMMENT.test(doc.comment) ? doc.comment : COMMENT, '',
    `## ${WAITING}`, '', ...section('Y'),
    `## ${CHECKS}`, '', ...section('A'),
    `## ${CLOSED}`, '', ...kept.flatMap(closedLines),
  ];
  return out.join('\n').replace(/\n+$/, '') + '\n';
}

function openLines(i: SerialOpen): string[] {
  if (i.lines?.length) return i.lines;
  const lines = [`- [ ] ${i.id}${SEP}${oneLine(i.kind)}${SEP}${oneLine(i.text) || '(no text)'}`];
  for (const k of FIELDS) {
    const v = i.fields[k] !== undefined ? oneLine(i.fields[k]) : '';
    if (v && (k !== 'state' || STATES.includes(v))) lines.push(`  - ${k}: ${v}`);
  }
  return lines;
}

function closedLines(c: SerialClosed): string[] {
  if (c.lines?.length) return c.lines;
  const when = STAMP.exec(c.when)?.[0] ?? c.when;
  const notes = c.notes.map((n) => oneLine(n).split(SEP).join(' - ')).filter(Boolean);
  const rest = notes.map((n) => SEP + n).join('');
  if (c.box === '>') return [`- [>] ${c.id}${SEP}superseded by ${c.by}${SEP}${when}${rest}`];
  if (c.box === '-') return [`- [-] ${c.id}${SEP}dropped ${when}${notes.length ? rest : `${SEP}no longer needed`}`];
  return [`- [x] ${c.id}${SEP}${c.how} ${when}${rest}`];
}
