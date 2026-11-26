// ledger.ts (FR-ITEM-01, FR-ITEM-04): the version 1 ledger as docs/Open items.md records it, on the
// fixtures in fixtures/ledger (invented). checkout-m2.md and subagent.md are the two examples of the
// skill's references/format.md, copied as they are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, blockOf, nextId, optionsOf, fromOf, stampTime, isLedgerPath, ownedIds, ownerOf } from '../src/ledger.ts';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ledger');
const fixture = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8');
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
const HEAD = "# Open items: demo\n\n<!-- open-items v1. Kept by AI. -->\n\n";
const doc = (waiting = '', checks = '', closed = '') => `${HEAD}## Waiting on you\n\n${waiting}\n## Claude will check\n\n${checks}\n## Closed\n\n${closed}`;
const ITEM = '- [ ] Y1 · decision · Ship it?\n  - from: Claude, "S", 2026-11-26 14:02\n';

test('the format example: every open item, its fields, and the three closed shapes', () => {
  const led = parse(fixture('checkout-m2.md'));
  assert.equal(led.area, 'checkout-m2');
  assert.equal(led.version, 1);
  assert.deepEqual(led.unread, []);
  assert.deepEqual(ids(led.items), ['Y1', 'Y2', 'Y4', 'Y5', 'A1']);
  assert.deepEqual(led.items.map((i) => i.kind), ['decision', 'your task', 'default', 'decision', 'follow-up']);
  const [y1, , y4, , a1] = led.items;
  assert.equal(y1.text, 'Run `bin/schema-lint --fix` now, or look at the 14 warnings first?');
  assert.deepEqual(Object.keys(y1.fields), ['options', 'recommended', 'from']);
  assert.deepEqual(optionsOf(y1), ['Run it', 'Look first']);
  assert.deepEqual(fromOf(y1), { who: 'Claude', title: 'Ship checkout M2', at: '2026-11-26 14:02', quote: 'Should I run `bin/schema-lint --fix`' });
  assert.equal(fromOf(y4)?.quote, null);
  assert.equal(y4.text, 'Mark #812 to #815 ready in this order: #812, #814, #813, #815.', 'a colon in the text');
  assert.equal(a1.fields.watch, 'feedback-watch pr 812 813 814 815');
  assert.equal(blockOf(y1), y1.lines.join('\n'));
  assert.equal(y1.lines.length, 4);
  assert.deepEqual(led.closed.map((c) => [c.id, c.box, c.how, c.when, c.by, c.notes]), [
    ['Y3', 'x', 'answered', '2026-11-26 14:05', null, ['"Run it"', 'done: 14 entries added to the todo file']],
    ['Y6', '-', 'dropped', '2026-11-26 15:10', null, ['#818 was closed']],
    ['Y7', '>', 'superseded', '2026-11-26 15:12', 'Y5', []],
  ]);
  assert.equal(nextId(led, 'Y'), 'Y8', 'past the closed ids');
  assert.equal(nextId(led, 'A'), 'A2');
});

test('the subagent example: raised by and a review item', () => {
  const led = parse(fixture('subagent.md'));
  assert.deepEqual(led.unread, []);
  assert.deepEqual(ids(led.items), ['Y7', 'Y8']);
  assert.equal(led.items[0].fields['raised by'], 'Rebase #820 on main');
  assert.equal(led.items[0].text, 'The 2027 reduced rate is 12% on main and 15% in the #820 fixture: which is right?');
  assert.deepEqual([led.items[1].kind, led.items[1].text, led.items[1].fields.subagent], ['review', 'Review: Receipt email copy', 'Receipt email copy']);
});

test('two bad lines are listed with their numbers, and the rest is read', () => {
  const led = parse(fixture('two-bad-lines.md'));
  assert.deepEqual(led.unread.map((u) => [u.line, u.text]), [
    [9, '  - colour: forest green'],
    [13, 'and the height too, if you have the tape out'],
  ]);
  assert.deepEqual(ids(led.items), ['Y1', 'Y2', 'A1']);
  assert.deepEqual(Object.keys(led.items[0].fields), ['options', 'from'], 'the bad field is not read');
  assert.ok(led.items[0].lines.includes('  - colour: forest green'), 'but it is part of the item\'s block');
  assert.equal(led.items[1].text, 'Measure the door frame and send the width.', 'the wrapped words are not guessed into the text');
  assert.deepEqual(ids(led.closed), ['Y3']);
});

test('empty sections and blank lines anywhere', () => {
  const led = parse(fixture('empty-sections.md'));
  assert.deepEqual(led, { area: 'notes', version: 1, items: [], closed: [], unread: [] });
  assert.equal(nextId(led, 'Y'), 'Y1');
  const spaced = parse(doc('- [ ] Y1 · decision · Ship it?\n\n  - options: Yes | No\n\n  - from: Claude, "S", 2026-11-26 14:02\n'));
  assert.deepEqual(spaced.unread, []);
  assert.deepEqual(Object.keys(spaced.items[0].fields), ['options', 'from'], 'a blank line inside an item keeps its fields');
});

test('stamps with no time: read as local midnight, good to the day', () => {
  const led = parse(fixture('date-only.md'));
  assert.deepEqual(led.unread, []);
  assert.deepEqual(ids(led.items), ['Y4', 'Y5', 'A2']);
  assert.equal(fromOf(led.items[0])?.at, '2026-11-18');
  assert.equal(led.items[0].fields.state, 'later');
  assert.equal(led.items[2].fields.state, 'due');
  assert.deepEqual(led.closed.map((c) => [c.id, c.how, c.when]), [
    ['Y1', 'answered', '2026-11-16'], ['Y2', 'dropped', '2026-11-17'], ['Y3', 'superseded', '2026-11-18'], ['A1', 'went ahead', '2026-11-17 10:05'],
  ]);
  assert.deepEqual(stampTime('2026-11-18'), { ms: new Date(2026, 10, 18).getTime(), minute: false });
  assert.deepEqual(stampTime('Claude, "S", 2026-11-26 14:02'), { ms: new Date(2026, 10, 26, 14, 2).getTime(), minute: true }, 'local time, no zone');
  assert.equal(stampTime('no date'), null);
});

test('another version: the version and no items; no comment reads as version 1', () => {
  assert.deepEqual(parse(fixture('v2.md')), { area: 'rocket-club', version: 2, items: [], closed: [], unread: [] });
  const bare = parse(doc(ITEM).replace('<!-- open-items v1. Kept by AI. -->\n', ''));
  assert.equal(bare.version, null);
  assert.deepEqual(ids(bare.items), ['Y1']);
  assert.deepEqual(parse('').unread, []);
  assert.equal(parse('').area, null);
});

test('a line that breaks the grammar is never guessed from', () => {
  const unread = (text: string) => parse(text).unread.map((u) => u.why);
  const cases: [string, string, string[]][] = [
    ['not the title', '# Notes\n' + doc().slice('# Open items: demo\n'.length), ['the first line']],
    ['another comment', doc() + '<!-- a note -->\n', ['unknown comment']],
    ['unknown section', doc() + '## Later\n', ['unknown section']],
    ['a Y item under Claude will check, and its field', doc('', ITEM), ['Y1 in', 'a field of an item']],
    ['an unknown kind', doc(ITEM.replace('decision', 'question')), ["kind 'question'", 'a field of an item']],
    ['an unknown state', doc(ITEM.replace('  - from', '  - state: blocked\n  - from')), ["state 'blocked'"]],
    ['fields out of order', doc(ITEM + '  - state: due\n'), ['out of order']],
    ['a field twice', doc(ITEM + '  - from: you, "S", 2026-11-26 14:03\n'), ["field 'from' twice"]],
    ['an id twice', doc(ITEM + ITEM), ['Y1 is used twice', 'a field of an item']],
    ['an open id also closed', doc(ITEM, '', '- [x] Y1 · done 2026-11-26 15:00 · shipped\n'), ['Y1 is used twice']],
    ['a dropped line with no why', doc('', '', '- [-] Y2 · dropped 2026-11-26 15:10\n'), ['says why']],
    ['an unknown close word', doc('', '', '- [x] Y2 · closed 2026-11-26 15:10\n'), ['fit no closed shape']],
    ['superseded with no date', doc('', '', '- [>] Y2 · superseded by Y3\n'), ["want 'superseded by"]],
    ['an open line under Closed', doc('', '', ITEM), ['wrong section', 'a field of an item']],
    ['a field under a closed line', doc('', '', '- [x] Y2 · done 2026-11-26 15:10 · ok\n  - from: x\n'), ['no open item above']],
  ];
  for (const [name, text, want] of cases) {
    const got = unread(text);
    assert.equal(got.length, want.length, `${name}: ${got.join('; ')}`);
    want.forEach((w, i) => assert.ok(got[i].includes(w), `${name}: ${got[i]}`));
  }
  const dup = parse(doc(ITEM, '', '- [x] Y1 · done 2026-11-26 15:00 · shipped\n'));
  assert.deepEqual([ids(dup.items), ids(dup.closed)], [['Y1'], []], 'the first line of an id wins');
});

test('what ledger.py refuses for the whole file, and Synopia still reads', () => {
  const noFrom = parse(doc('- [ ] Y1 · decision · Ship it?\n'));
  assert.deepEqual([ids(noFrom.items), noFrom.unread], [['Y1'], []], 'an item with no from field');
  assert.equal(fromOf(noFrom.items[0]), null);
  const noClosed = parse(doc(ITEM).split('## Closed')[0]);
  assert.deepEqual([ids(noClosed.items), noClosed.unread], [['Y1'], []], 'a missing section');
  assert.equal(parse(doc('- [ ] Y01 · decision · Ship it?\n')).items[0].id, 'Y1', 'a leading zero is the same number');
});

test('blockOf: the same block for an untouched item, another for a changed one', () => {
  const before = parse(doc(ITEM + '- [ ] Y2 · your task · Read it.\n  - from: Claude, "S", 2026-11-26 14:02\n'));
  const after = parse(doc('- [ ] Y2 · your task · Read it.\n\n  - from: Claude, "S", 2026-11-26 14:02\n' + ITEM.replace('  - from', '  - state: answered\n  - answer: "Yes"\n  - from')));
  const block = (led: typeof before, id: string) => blockOf(led.items.find((i) => i.id === id)!);
  assert.equal(block(before, 'Y2'), block(after, 'Y2'), 'a move and a blank line are no change');
  assert.notEqual(block(before, 'Y1'), block(after, 'Y1'));
  assert.equal(blockOf(parse(fixture('checkout-m2.md')).closed[0]), '- [x] Y3 · answered 2026-11-26 14:05 · "Run it" · done: 14 entries added to the todo file');
});

test('the path rule: .ai-notes/<area>/open-items.md, absolute', () => {
  assert.ok(isLedgerPath('/tmp/synopia-items/shop/.ai-notes/checkout-m2/open-items.md'));
  assert.ok(isLedgerPath('/a/.ai-notes/x/../checkout-m2/open-items.md'), 'normalized');
  for (const p of [
    '.ai-notes/checkout-m2/open-items.md',
    '/tmp/shop/.ai-notes/open-items.md',
    '/tmp/shop/.ai-notes/a/b/open-items.md',
    '/tmp/shop/ai-notes/checkout-m2/open-items.md',
    '/tmp/shop/.ai-notes/checkout-m2/open-items.md.bak',
    '/tmp/shop/.ai-notes/checkout-m2/README.md',
  ]) assert.ok(!isLedgerPath(p), p);
});

test('ownedIds: the ids a brief\'s Open items line names, with commas and parentheses in the text', () => {
  assert.deepEqual(ownedIds([
    'Rebase #820 on main and keep the tests green.',
    'Open items: Y5 (keep main\'s Norway rates, answered "Main\'s"), A2 (re-run the tax specs on #818)',
    'Report one line per closed id.',
  ].join('\n')), ['Y5', 'A2']);
  assert.deepEqual(ownedIds('Open items: Y7 (the 12% (reduced) rate, or 15%?), Y8 (review), A3 (watch #821 (draft))'), ['Y7', 'Y8', 'A3']);
  assert.deepEqual(ownedIds('Do the thing.\n- **Open items:** Y2, Y3 (send the width)\nmention Y9 (not owned), Y10 here'), ['Y2', 'Y3']);
  assert.deepEqual(ownedIds('Open items: none'), []);
  assert.deepEqual(ownedIds('No list here, though Y4 (x), A1 (y) look like ids.'), []);
});

test('ownerOf: the brief that names the id, else the subagent field by name, running agents only', () => {
  const led = parse(doc(ITEM + '- [ ] Y8 · review · Review: Receipt email copy\n  - subagent: Receipt email copy\n  - from: Claude, "S", 2026-11-26 16:58\n'));
  const [y1, y8] = led.items;
  const copy = { agent: 'a1', name: 'Receipt email copy', ids: [], running: true };
  const rebase = { agent: 'a2', name: 'Rebase', ids: ['Y1', 'Y8'], running: true };
  assert.equal(ownerOf(y1, [copy, rebase]), 'a2');
  assert.equal(ownerOf(y8, [copy, rebase]), 'a2', 'the brief before the field');
  assert.equal(ownerOf(y8, [copy]), 'a1');
  assert.equal(ownerOf(y1, [copy]), null);
  assert.equal(ownerOf(y8, [copy, { ...rebase, running: false }]), null, 'a finished brief that names it: no field fallback');
  assert.equal(ownerOf(y8, [{ ...copy, running: false }]), null);
});
