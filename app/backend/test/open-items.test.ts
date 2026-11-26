// open-items.ts (FR-ITEM-01 to -04, -06) on a temp folder, with the transcript facts faked. Ledgers and agents
// are invented; checkout-m2.md and subagent.md are the format examples in fixtures/ledger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.ts';
import type { Store } from '../src/store.ts';
import { OpenItems, NOTES, cleanItems, AGENT_CLOSED_MAX } from '../src/open-items.ts';
import type { ItemFacts, FileIo, Reply } from '../src/open-items.ts';
import type { Agent, LedgerFact } from '../src/transcript.ts';

const FIX = path.join(import.meta.dirname, 'fixtures', 'ledger');
const fixture = (name: string) => fs.readFileSync(path.join(FIX, name), 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-items-'));
const ledgerIn = (dir: string, area = 'checkout-m2', text = fixture('checkout-m2.md')) => {
  const p = path.join(dir, 'shop', '.ai-notes', area, 'open-items.md');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
};
// a later mtime, so the 2 s look sees the change even within one clock tick
const rewrite = (p: string, text: string) => { fs.writeFileSync(p, text); const t = new Date(Date.now() + 5000); fs.utimesSync(p, t, t); };

const agent = (id: string, description: string, running = false, toolUseId: string | null = null): Agent => ({
  id, type: 'general-purpose', fork: false, description, toolUseId, model: null, depth: 1, finished: !running, running,
  review: /^for review:/i.test(description), stopped: false, waiting: false, start: '2026-11-26T15:00:00.000Z', end: '2026-11-26T15:30:00.000Z', total: 3,
});

type Fake = { ledger: Map<string, LedgerFact | null>; agents: Map<string, Agent[]>; owns: Map<string, string[]>; you: Map<string, number | null>; replies: Map<string, Reply[]> };
function fakeFacts(): { f: Fake; facts: ItemFacts } {
  const f: Fake = { ledger: new Map(), agents: new Map(), owns: new Map(), you: new Map(), replies: new Map() };
  return {
    f,
    facts: {
      ledgerOf: (sid) => f.ledger.get(sid) ?? null,
      ownsOf: (_sid, tid) => f.owns.get(tid) ?? [],
      agents: (sid) => f.agents.get(sid) ?? [],
      lastYouAt: (sid) => f.you.get(sid) ?? null,
      replies: (sid) => f.replies.get(sid) ?? [],
    },
  };
}
const fact = (p: string, at = '2026-11-26T16:00:00.000Z', results = 1): LedgerFact => ({ path: p, at, toolUseId: 'toolu_r', results });

function setup(dir = tmp(), io?: FileIo) {
  const store = openStore(path.join(dir, 'state'), { minIntervalMs: 0 });
  const { f, facts } = fakeFacts();
  const changed: string[][] = [];
  const items = new OpenItems({ store, facts, io, home: path.join(dir, 'home'), lookMs: 0, onChange: (s) => changed.push(s), now: () => Date.parse('2026-11-26T17:00:00.000Z') });
  return { dir, store, f, items, changed };
}
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

test('adopting a file: the open items, the checks, the counts', async () => {
  const { dir, f, items, changed } = setup();
  const p = ledgerIn(dir);
  f.ledger.set('s1', fact(p));
  await items.sync('s1');
  const v = items.view('s1');
  assert.deepEqual(ids(v.items), ['Y1', 'Y2', 'Y4', 'Y5']);
  assert.deepEqual(ids(v.checks), ['A1']);
  assert.deepEqual([v.unread, v.note, v.closed], [0, null, []]);
  const y1 = v.items[0];
  assert.deepEqual([y1.kind, y1.options, y1.recommended, y1.source, y1.minute], ['decision', ['Run it', 'Look first'], 'Look first', 'agent', true]);
  assert.equal(y1.at, new Date(2026, 10, 26, 14, 2).getTime(), 'from stamps are local time');
  assert.equal(v.items[2].goesAhead, 'when CI is green on all four, unless you object');
  assert.equal(v.checks[0].watch, 'feedback-watch pr 812 813 814 815');
  assert.deepEqual(items.counts('s1'), { review: 0, waiting: 4, due: 0 });
  assert.ok(changed.some((s) => s.includes('s1')));
  // Closed this turn: the closed lines stamped at or after the minute of your last message
  f.you.set('s1', new Date(2026, 10, 26, 15, 10, 40).getTime());
  assert.deepEqual(items.view('s1').closed.map((c) => [c.id, c.how, c.note]), [['Y6', 'dropped', '#818 was closed'], ['Y7', 'superseded', 'superseded by Y5']]);
});

test('Mark reviewed holds over an unchanged line and loses to a changed one', async () => {
  const { dir, f, items } = setup();
  const p = ledgerIn(dir, 'checkout-m2', fixture('subagent.md'));
  f.ledger.set('s1', fact(p));
  f.agents.set('s1', [agent('ag-r', 'For review: Receipt email copy')]);
  await items.sync('s1');
  let v = items.view('s1');
  assert.deepEqual(ids(v.items), ['Y7', 'Y8'], 'the ledger\'s review item is the agent\'s: no second one');
  assert.equal(v.items[1].agent, 'ag-r');
  assert.equal(items.reviewOpen('s1', 'ag-r'), true);
  assert.deepEqual(items.counts('s1'), { review: 1, waiting: 1, due: 0 });
  assert.equal(items.markReviewed('s1', 'Y7'), false, 'only a review item');
  assert.equal(items.markReviewed('s1', 'Y8'), true);
  assert.equal(items.markReviewed('s1', 'Y8'), false, 'once');
  assert.equal(items.reviewOpen('s1', 'ag-r'), false);
  // the agent edits another item: Y8's lines are unchanged, so the mark holds
  rewrite(p, fixture('subagent.md').replace('options: 12% | 15%', 'options: 12% | 15% | Ask Mira'));
  await items.look();
  v = items.view('s1');
  assert.deepEqual(ids(v.items), ['Y7']);
  assert.deepEqual(v.items[0].options, ['12%', '15%', 'Ask Mira']);
  // the agent changes Y8's lines: its record wins, open again
  rewrite(p, fixture('subagent.md').replace('Review: Receipt email copy', 'Review: Receipt email copy, second pass'));
  await items.look();
  v = items.view('s1');
  assert.deepEqual(ids(v.items), ['Y7', 'Y8']);
  assert.equal(v.items[1].text, 'Review: Receipt email copy, second pass');
  assert.equal(v.items[1].agent, 'ag-r', 'still tied to its subagent');
});

test('a number taken by both sides: Synopia\'s item moves past the file\'s numbers', async () => {
  const { dir, f, items } = setup();
  f.agents.set('s1', [agent('ag-a', 'For review: Pricing page copy')]);
  await items.sync('s1'); // no ledger yet: a session: list
  assert.deepEqual(items.view('s1').items.map((i) => [i.id, i.kind, i.text, i.source]), [['Y1', 'review', 'Review: Pricing page copy', 'synopia']]);
  const p = ledgerIn(dir);
  f.ledger.set('s1', fact(p));
  await items.sync('s1');
  const v = items.view('s1');
  assert.deepEqual(ids(v.items), ['Y1', 'Y2', 'Y4', 'Y5', 'Y8'], 'Y1 is the agent\'s; Synopia\'s moved past Y7, the highest closed line');
  assert.deepEqual([v.items[4].text, v.items[4].agent], ['Review: Pricing page copy', 'ag-a']);
  assert.equal(v.items[0].kind, 'decision');
  assert.ok(!('session:s1' in (items as unknown as { store: Store }).store.state.items.lists), 'the session: list joined the ledger\'s');
});

test('a review item merges with the agent\'s: the agent\'s id wins and Mark reviewed holds', async () => {
  const { dir, f, items } = setup();
  f.agents.set('s1', [agent('ag-r', 'For review: Receipt email copy')]);
  await items.sync('s1');
  assert.equal(items.markReviewed('s1', 'Y1'), true);
  const p = ledgerIn(dir, 'checkout-m2', fixture('subagent.md'));
  f.ledger.set('s1', fact(p));
  f.you.set('s1', Date.parse('2026-11-26T16:59:00.000Z'));
  await items.sync('s1');
  const v = items.view('s1');
  assert.deepEqual(ids(v.items), ['Y7']);
  assert.deepEqual(v.closed.map((c) => [c.id, c.note]), [['Y8', 'marked reviewed']], 'one item, the agent\'s Y8');
  // the next number is past Y8; Synopia's Y1 is retired with it
  f.agents.set('s1', [agent('ag-r', 'For review: Receipt email copy'), agent('ag-b', 'For review: Banner copy')]);
  await items.sync('s1');
  assert.deepEqual(items.view('s1').items.map((i) => [i.id, i.agent]), [['Y7', undefined], ['Y9', 'ag-b']]);
});

test('an item gone from the file is closed as dropped; one moved to Closed closes as the file says', async () => {
  const { dir, f, items } = setup();
  const p = ledgerIn(dir);
  f.ledger.set('s1', fact(p));
  f.you.set('s1', new Date(2026, 10, 26, 16, 0).getTime()); // stamps are local time
  await items.sync('s1');
  const text = fixture('checkout-m2.md')
    .replace(/- \[ \] Y2 · your task.*\n.*\n/, '')
    .replace(/- \[ \] Y4 · default.*\n.*\n.*\n/, '')
    .replace('## Closed\n', '## Closed\n\n- [x] Y4 · went ahead 2026-11-26 16:30 · marked ready\n');
  rewrite(p, text);
  await items.look();
  const v = items.view('s1');
  assert.deepEqual(ids(v.items), ['Y1', 'Y5']);
  assert.deepEqual(v.closed.map((c) => [c.id, c.how, c.note, c.by, c.text.slice(0, 8)]), [
    ['Y4', 'went ahead', 'marked ready', 'agent', 'Mark #81'],
    ['Y2', 'dropped', 'removed from the ledger', 'synopia', 'Answer t'],
  ]);
});

test('a list survives a restart', async () => {
  const dir = tmp();
  const p = ledgerIn(dir, 'checkout-m2', fixture('subagent.md'));
  {
    const { store, f, items } = setup(dir);
    f.ledger.set('s1', fact(p));
    f.agents.set('s1', [agent('ag-r', 'For review: Receipt email copy'), agent('ag-x', 'For review: Hero image')]);
    await items.sync('s1');
    assert.equal(items.markReviewed('s1', 'Y8'), true);
    store.close();
  }
  const { store, f, items } = setup(dir);
  f.ledger.set('s1', fact(p));
  f.agents.set('s1', [agent('ag-r', 'For review: Receipt email copy'), agent('ag-x', 'For review: Hero image')]);
  await items.sync('s1');
  assert.deepEqual(items.view('s1').items.map((i) => [i.id, i.text]), [['Y7', 'The 2027 reduced rate is 12% on main and 15% in the #820 fixture: which is right?'], ['Y9', 'Review: Hero image']]);
  assert.equal(items.reviewOpen('s1', 'ag-r'), false, 'Mark reviewed holds over the restart');
  assert.equal(store.state.items.lists[p].top.Y, 9);
});

test('the old reviewed marks become closed review items once', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state', 'state.json'), JSON.stringify({ version: 1, reviewed: ['ag-old', 'ag-gone'] }));
  const { store, f, items } = setup(dir);
  assert.deepEqual(store.state.items.carried, ['ag-old', 'ag-gone']);
  f.agents.set('s1', [agent('ag-old', 'For review: Old deliverable'), agent('ag-new', 'For review: New deliverable')]);
  await items.sync('s1');
  assert.deepEqual(items.view('s1').items.map((i) => [i.id, i.agent]), [['Y2', 'ag-new']]);
  assert.equal(items.reviewOpen('s1', 'ag-old'), false);
  assert.deepEqual(store.state.items.carried, ['ag-gone']);
  assert.deepEqual(items.counts('s1'), { review: 1, waiting: 0, due: 0 });
  // closing the session carries its closed review items again, so a reopen doesn't bring them back
  items.close('s1');
  assert.deepEqual(store.state.items.carried, ['ag-gone', 'ag-old']);
  await items.sync('s1');
  assert.equal(items.reviewOpen('s1', 'ag-old'), false);
  assert.equal(items.reviewOpen('s1', 'ag-new'), true);
  // cleanItems: a malformed entry is dropped, the carried marks capped
  const c = cleanItems({ lists: { k: { top: { Y: 2 }, items: [{ id: 'Y1', kind: 'review', text: 'x', source: 'synopia', fields: {} }, { id: 'nope' }, { id: 'Y2', kind: 'x', text: 'y', source: 'agent', closed: { how: 1 } }] } } },
    Array.from({ length: AGENT_CLOSED_MAX + 5 }, (_, i) => `a${i}`));
  assert.deepEqual(ids(c.lists.k.items), ['Y1']);
  assert.deepEqual([c.lists.k.top, c.carried.length, c.carried[0]], [{ Y: 2, A: 0 }, AGENT_CLOSED_MAX, 'a5']);
});

test('a ledger in a protected folder is not read, and the view says why', async () => {
  const dir = tmp();
  const reads: string[] = [];
  const io: FileIo = { stat: async (p) => { reads.push(p); return fs.promises.stat(p); }, read: async (p) => { reads.push(p); return fs.promises.readFile(p, 'utf8'); } };
  const { f, items } = setup(dir, io);
  const p = path.join(dir, 'home', 'Documents', 'shop', '.ai-notes', 'm2', 'open-items.md');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, fixture('checkout-m2.md'));
  f.ledger.set('s1', fact(p));
  await items.sync('s1');
  await items.look();
  assert.deepEqual(reads, []);
  assert.deepEqual([items.view('s1').items, items.view('s1').note], [[], NOTES.protected]);
});

test('a file Synopia can\'t read whole: bad lines counted, a newer version, a big file', async () => {
  const { dir, f, items } = setup();
  const p = ledgerIn(dir, 'm2', fixture('two-bad-lines.md'));
  f.ledger.set('s1', fact(p));
  await items.sync('s1');
  assert.equal(items.view('s1').unread, 2);
  rewrite(p, fixture('v2.md'));
  await items.look();
  assert.equal(items.view('s1').note, NOTES.version);
  rewrite(p, fixture('checkout-m2.md') + '\n'.repeat(300 * 1024));
  await items.look();
  assert.equal(items.view('s1').note, NOTES.big);
});

test('subagent ties, and a shared ledger counted once under the session that named it last', async () => {
  const { dir, f, items } = setup();
  const p = ledgerIn(dir);
  f.ledger.set('s1', fact(p, '2026-11-26T16:00:00.000Z'));
  f.ledger.set('s2', fact(p, '2026-11-26T16:05:00.000Z'));
  f.agents.set('s1', [agent('ag-w', 'Remove the worktrees', true, 'toolu_w')]);
  f.owns.set('toolu_w', ['Y5']);
  await items.sync('s1');
  await items.sync('s2');
  assert.deepEqual(items.view('s1').items.find((i) => i.id === 'Y5')?.with, { agent: 'ag-w', name: 'Remove the worktrees' });
  assert.equal(items.view('s2').items.find((i) => i.id === 'Y5')?.with, undefined, 'the agent is s1\'s');
  assert.deepEqual(ids(items.view('s2').items), ids(items.view('s1').items), 'both show the list');
  assert.deepEqual([items.counts('s1').waiting, items.counts('s2').waiting], [0, 4]);
  assert.deepEqual(items.sessionsOf(p).sort(), ['s1', 's2']);
  assert.equal(items.holds('s1', 'Y5'), true);
  assert.equal(items.holds('s1', 'Y6'), false, 'closed');
  items.rekey('s2', 's3');
  assert.deepEqual(items.sessionsOf(p).sort(), ['s1', 's3']);
});

test('the reply an item came from: the quote word for word, else the last reply by its minute, a raised item\'s report, none', async () => {
  const { dir, f, items } = setup();
  const p = ledgerIn(dir);
  f.ledger.set('s1', fact(p));
  const at = (h: number, m: number, s = 0) => new Date(2026, 10, 26, h, m, s).toISOString(); // the ledger's stamps are local time
  const said = (id: string, ts: string, text: string): Reply => ({ id, k: 'claude', ts, text });
  f.replies.set('s1', []);
  await items.sync('s1');
  const reply = (sid: string, id: string) => { const v = items.view(sid); return [...v.items, ...v.checks].find((i) => i.id === id)?.reply; };
  assert.equal(reply('s1', 'Y1'), undefined, 'no reply yet');
  f.replies.set('s1', [
    said('c1', at(13, 50), 'Earlier: Should I run it?'),
    said('c2', at(14, 1, 30), 'Rebased. Should I run\n  `bin/schema-lint --fix` now, or look first?'),
    said('c3', at(14, 2, 20), 'Can I remove these two worktrees? Both are merged.'),
    said('c4', at(14, 10), 'Later: Should I run `bin/schema-lint --fix` again?'),
  ]);
  assert.equal(reply('s1', 'Y1'), 'c2', 'a reply that lands later is found: the first holding the quote, white space aside');
  assert.equal(reply('s1', 'Y5'), 'c3', 'its own quote');
  assert.equal(reply('s1', 'Y2'), 'c3', 'no quote: the last reply at or before the minute 14:02');
  assert.equal(reply('s1', 'A1'), 'c3', 'a check too');
  f.replies.set('s1', [said('c4', at(14, 10), 'Later.')]);
  assert.equal(reply('s1', 'Y2'), undefined, 'a shorter transcript scans again: no reply by 14:02, none');
  // an item a subagent raised: that subagent's report
  const q = ledgerIn(dir, 'sub', fixture('subagent.md'));
  f.ledger.set('s2', fact(q));
  f.agents.set('s2', [agent('ag-r', 'Rebase #820 on main', false, 'toolu_r2')]);
  f.replies.set('s2', [said('c9', at(16, 50), 'Started it.'), { id: 'report:ag-r', k: 'report', ts: at(16, 51), text: '', agent: 'ag-r' }]);
  await items.sync('s2');
  assert.equal(reply('s2', 'Y7'), 'report:ag-r');
});
