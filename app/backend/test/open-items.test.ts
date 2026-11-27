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
  await items.flushWrites(); // phase 3: the mark is written back between turns (FR-ITEM-11)
  assert.match(fs.readFileSync(p, 'utf8'), /^- \[x\] Y8 · done \d{4}-\d\d-\d\d \d\d:\d\d · marked reviewed$/m);
  // the agent edits another item: Y8's lines are unchanged, so the mark holds
  rewrite(p, fs.readFileSync(p, 'utf8').replace('options: 12% | 15%', 'options: 12% | 15% | Ask Mira'));
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

// ---------- phase 3: the keeper, d and Undo (FR-ITEM-08 to -10) ----------

type Keys = { you: { key: string; ms: number } | null; turn: { key: string; ms: number } | null };
function keeperSetup(dir = tmp()) {
  const store = openStore(path.join(dir, 'state'), { minIntervalMs: 0 });
  const { f, facts } = fakeFacts();
  const keys = new Map<string, Keys>();
  const asked: string[] = [];
  const running = { on: false };
  let now = Date.parse('2026-11-26T17:00:00.000Z');
  const items = new OpenItems({
    store, home: path.join(dir, 'home'), lookMs: 0, now: () => now,
    facts: { ...facts, exchangeKeys: (sid) => keys.get(sid) ?? { you: null, turn: null }, title: () => 'Ship "checkout" M2', turnRunning: () => running.on },
    ask: (sid, kind, key) => asked.push(`${sid} ${kind} ${key}`),
  });
  return { dir, store, f, items, keys, asked, running, tick: (ms: number) => { now += ms; return now; }, get now() { return now; } };
}
const ex = (text: string, src: 'you' | 'claude' = 'you') => ({ kind: src === 'you' ? 'you' as const : 'turn' as const, key: 'k', segments: [{ src, text }] });

test('the keeper is asked once per message and once per ended turn, never about what came before the daemon', async () => {
  const k = keeperSetup();
  const t0 = k.now;
  k.keys.set('s1', { you: { key: 'u0', ms: t0 - 3_600_000 }, turn: { key: 'u0:c0', ms: t0 - 3_500_000 } });
  await k.items.sync('s1');
  assert.deepEqual(k.asked, [], 'history read at open asks nothing');
  k.keys.set('s1', { you: { key: 'u1', ms: t0 + 1000 }, turn: null });
  await k.items.sync('s1');
  await k.items.sync('s1');
  k.keys.set('s1', { you: { key: 'u1', ms: t0 + 1000 }, turn: { key: 'u1:c3', ms: t0 + 9000 } });
  await k.items.sync('s1');
  assert.deepEqual(k.asked, ['s1 you u1', 's1 turn u1:c3']);
});

test('keeper ops: found items with a dashed box and a from field, closes with Undo, the order you, agent, keeper', async () => {
  const k = keeperSetup();
  const p = ledgerIn(k.dir);
  k.f.ledger.set('s1', fact(p));
  await k.items.sync('s1');
  k.f.you.set('s1', k.now);
  const began = k.tick(1000);
  await k.items.applyOps('s1', ex('Y1 run it. Can I remove the worktrees? Can I remove the worktrees?'), [
    { op: 'close', id: 'Y1', as: 'answered', answer: 'Run it', quote: 'Y1 run it', src: 'you' },
    { op: 'open', kind: 'decision', text: 'Can I remove the worktrees?', options: ['Yes', 'Keep them'], quote: 'Can I remove the worktrees?', src: 'claude' },
    { op: 'open', kind: 'decision', text: 'can I  remove the worktrees?', quote: 'Can I remove the worktrees?', src: 'claude' },
  ], began);
  const v = k.items.view('s1');
  const found = v.items.find((i) => i.id === 'Y8')!;
  assert.ok(found, 'the next number past every open and closed id (Y7 closed in the file)');
  assert.deepEqual([found.found, found.source, found.options], [true, 'synopia', ['Yes', 'Keep them']]);
  assert.equal(v.items.filter((i) => /^can i remove the worktrees\?$/i.test(i.text)).length, 1, 'a duplicate text is dropped');
  assert.deepEqual(v.closed.map((c) => [c.id, c.how, c.note, c.by, c.undo]), [['Y1', 'answered', 'you said “Run it”', 'synopia', true]]);
  assert.match(k.store.state.items.lists[p].items.find((h) => h.id === 'Y8')!.fields.from, /^Synopia, "Ship 'checkout' M2", 2026-11-26 \d\d:\d\d, "Can I remove the worktrees\?"$/);
  // an op begun before the agent changed the item loses
  const old = k.now - 10_000;
  rewrite(p, fixture('checkout-m2.md').replace('Answer the 2 review threads', 'Answer the 3 review threads'));
  await k.items.read(p);
  await k.items.applyOps('s1', ex('done with the threads'), [{ op: 'close', id: 'Y2', as: 'done', quote: 'done with the threads', src: 'you' }], old);
  assert.ok(k.items.view('s1').items.some((i) => i.id === 'Y2'), 'the agent came first');
});

test('d says not an item, never opened again; Undo reopens for one turn and keeps the keeper off', async () => {
  const k = keeperSetup();
  k.f.you.set('s1', k.now);
  await k.items.sync('s1'); // no ledger: a session list, Synopia's only
  await k.items.applyOps('s1', ex('Should the tax table be cached?', 'claude'), [
    { op: 'open', kind: 'decision', text: 'Should the tax table be cached?', quote: 'Should the tax table be cached?', src: 'claude' },
  ], k.tick(1000));
  assert.deepEqual(ids(k.items.view('s1').items), ['Y1']);
  assert.ok(k.items.notItem('s1', 'Y1'));
  assert.deepEqual(k.items.view('s1').closed.map((c) => [c.id, c.how, c.note, c.undo, c.found]), [['Y1', 'dropped', 'not an item: you said so', true, true]]);
  await k.items.applyOps('s1', ex('Should the tax table be cached?', 'claude'), [
    { op: 'open', kind: 'decision', text: 'Should the  TAX table be cached?', quote: 'Should the tax table be cached?', src: 'claude' },
  ], k.tick(1000));
  assert.deepEqual(ids(k.items.view('s1').items), [], 'a dismissed text stays gone');
  assert.ok(k.items.undo('s1', 'Y1'));
  const back = k.items.view('s1').items[0];
  assert.deepEqual([back.id, back.found], ['Y1', true]);
  await k.items.applyOps('s1', ex('drop it'), [{ op: 'close', id: 'Y1', as: 'dropped', quote: 'drop it', src: 'you' }], k.tick(1000));
  assert.deepEqual(ids(k.items.view('s1').items), ['Y1'], 'after Undo the keeper stays off it');
  assert.equal(k.items.undo('s1', 'Y1'), false, 'not closed');
  assert.equal(k.items.notItem('s1', 'Y9'), false);
});

test('an item the keeper closed and reopened twice stays as it is; Undo lasts one turn', async () => {
  const k = keeperSetup();
  k.f.you.set('s1', k.now);
  await k.items.sync('s1');
  await k.items.applyOps('s1', ex('I will review it tonight'), [{ op: 'open', kind: 'your task', text: 'Review the receipt copy tonight.', quote: 'I will review it tonight', src: 'you' }], k.tick(1000));
  const close = () => k.items.applyOps('s1', ex('done'), [{ op: 'close', id: 'Y1', as: 'done', quote: 'done', src: 'you' }], k.tick(1000));
  const reopen = () => k.items.applyOps('s1', ex('not done'), [{ op: 'reopen', id: 'Y1', quote: 'not done', src: 'you' }], k.tick(1000));
  await close(); await reopen();
  await close();
  assert.equal(k.items.view('s1').items.length, 0);
  await reopen();
  assert.equal(k.items.view('s1').items.length, 0, 'the third flip is refused');
  k.f.you.set('s1', k.tick(120_000)); // your next message: the close is no longer this turn's
  assert.equal(k.items.undo('s1', 'Y1'), false);
  assert.equal(k.items.view('s1').closed.length, 0);
});

test('the keeper\'s list: open items with their fields, the newest closed ones', async () => {
  const k = keeperSetup();
  const p = ledgerIn(k.dir);
  k.f.ledger.set('s1', fact(p));
  await k.items.sync('s1');
  const l = k.items.keeperList('s1')!;
  assert.deepEqual(l.open.map((i) => i.id), ['Y1', 'Y2', 'Y4', 'Y5', 'A1']);
  assert.deepEqual(l.open[0].options, ['Run it', 'Look first']);
  assert.equal(l.open[2].trigger, 'when CI is green on all four, unless you object');
  assert.equal(k.items.keeperList('nope'), null);
});

const LEDGER_PY = path.join(os.homedir(), 'dev', 'agent-harness', 'skills', 'open-items', 'scripts', 'ledger.py');
test('the write-back: only between turns, the file read first, what ledger.py accepts; found stays found', async () => {
  const k = keeperSetup();
  const p = ledgerIn(k.dir);
  k.f.ledger.set('s1', fact(p));
  await k.items.sync('s1');
  k.running.on = true;
  await k.items.applyOps('s1', ex('Can I remove the two worktrees?', 'claude'), [
    { op: 'open', kind: 'decision', text: 'Can I remove the two worktrees?', options: ['Yes', 'Keep them'], quote: 'Can I remove the two worktrees?', src: 'claude' },
    { op: 'close', id: 'Y2', as: 'done', quote: 'the two worktrees', src: 'claude' },
  ], k.tick(1000));
  await k.items.flushWrites();
  assert.equal(fs.readFileSync(p, 'utf8'), fixture('checkout-m2.md'), 'not during a turn');
  // the agent edits the file meanwhile: read and merged before the write
  rewrite(p, fixture('checkout-m2.md').replace('Re-check #820, which', 'Re-check #820 and #821, which'));
  k.running.on = false;
  await k.items.look();
  await k.items.flushWrites();
  const text = fs.readFileSync(p, 'utf8');
  assert.match(text, /^- \[ \] Y8 · decision · Can I remove the two worktrees\?\n {2}- options: Yes \| Keep them\n {2}- from: Synopia, "Ship 'checkout' M2", 2026-11-26 \d\d:\d\d, "Can I remove the two worktrees\?"$/m);
  assert.match(text, /^- \[x\] Y2 · done \d{4}-\d\d-\d\d \d\d:\d\d · closed by Synopia: “the two worktrees”$/m);
  assert.match(text, /Re-check #820 and #821/, 'the agent\'s change kept');
  assert.ok(text.includes(fixture('checkout-m2.md').split('\n').slice(6, 10).join('\n')), 'an unchanged item keeps its lines');
  if (fs.existsSync(LEDGER_PY)) {
    const { execFileSync } = await import('node:child_process');
    assert.match(execFileSync('/usr/bin/python3', ['-I', LEDGER_PY, 'check', p], { encoding: 'utf8' }), /^ok: /);
  }
  // read back: unchanged, so still Synopia's find and still closed by Synopia
  await k.items.read(p);
  const v = k.items.view('s1');
  assert.equal(v.items.find((i) => i.id === 'Y8')?.found, true);
  assert.ok(!v.items.some((i) => i.id === 'Y2'));
  assert.equal(await k.items.writeBack(p), false, 'nothing more to write');
});

test('the write-back leaves alone a file with no version comment, or with a line Synopia can\'t read', async () => {
  for (const text of [fixture('checkout-m2.md').replace(/^<!--.*-->$/m, ''), fixture('two-bad-lines.md')]) {
    const k = keeperSetup();
    const p = ledgerIn(k.dir, 'checkout-m2', text);
    k.f.ledger.set('s1', fact(p));
    await k.items.sync('s1');
    const open = k.items.view('s1').items.find((i) => i.kind !== 'review')!;
    assert.ok(k.items.notItem('s1', open.id));
    await k.items.flushWrites();
    assert.equal(fs.readFileSync(p, 'utf8'), text);
  }
});
