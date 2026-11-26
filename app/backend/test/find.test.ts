// find.ts (R5.12e, 2026-11-26): what ⌘F searches in each item kind, case, order, offsets, and the scope of a view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { find, itemText, matchesIn, MAX_MATCHES } from '../src/find.ts';
import type { Item } from '../src/transcript.ts';
import { Transcripts } from '../src/transcripts.ts';
import { Publisher } from '../src/publisher.ts';
import type { BgOutput } from '../src/transcript.ts';

const it = (o: Partial<Item> & { id: string; k: Item['k'] }): Item => ({ ts: null, ...o });

test('itemText: the text the page renders, per kind', () => {
  assert.equal(itemText(it({ id: 'a', k: 'you', text: 'Fix the parser' })), 'Fix the parser');
  assert.equal(itemText(it({ id: 'b', k: 'claude', text: 'Done.' })), 'Done.');
  assert.equal(itemText(it({ id: 'c', k: 'tool', name: 'Bash', verb: 'Ran', obj: 'List files', input: 'ls -la', out: { text: 'notes.md\n', lines: 1, cut: false } })),
    'Bash(List files)\nls -la\nnotes.md\n');
  assert.equal(itemText(it({ id: 'd', k: 'tool', name: 'mcp__docs__search', verb: 'docs search', obj: 'tabs' })), 'docs search(tabs)');
  assert.equal(itemText(it({ id: 'e', k: 'tool', name: 'Task', verb: 'Subagent', obj: 'Draft the notes' })), 'Draft the notes');
  assert.equal(itemText(it({ id: 'f', k: 'tool', name: 'Edit', verb: 'Edited', obj: '~/x.md', answer: 'Yes, allow it' })), 'Yes, allow it\nEdit(~/x.md)');
  assert.equal(itemText(it({ id: 'g', k: 'bang', cmd: 'git status', sh: { out: 'clean\n', err: 'warn\n', exit: 0 } as never })), 'git status\nclean\n\nwarn\n');
  assert.equal(itemText(it({ id: 'h', k: 'ask', qs: [{ q: 'Which one?', opts: [['Red', 'warm'], ['Blue', 'cold']] }] as never, answer: 'Blue' })), 'Which one?\nRed\nBlue\nBlue');
  assert.equal(itemText(it({ id: 'i', k: 'report', agent: 'x', text: 'All green.' })), 'All green.');
  assert.equal(itemText(it({ id: 'j', k: 'title', title: 'Parser fix' })), 'Parser fix');
  assert.equal(itemText(it({ id: 'k', k: 'moved', cwd: '~/dev/other' })), '~/dev/other');
});

test('matchesIn: case ignored, offsets in the text, no overlaps, a length-changing lowercase', () => {
  assert.deepEqual(matchesIn('Tab tab TAB', 'tab'), [[0, 3], [4, 7], [8, 11]]);
  assert.deepEqual(matchesIn('Tab tab', 'TAB'), [[0, 3], [4, 7]], 'an uppercase query still ignores case, as the preview does');
  assert.deepEqual(matchesIn('aaaa', 'aa'), [[0, 2], [2, 4]]);
  assert.deepEqual(matchesIn('İx ix', 'ix'), [[3, 5]], '"İ" lowercases to two code units, the offsets stay the text\'s');
  assert.deepEqual(matchesIn('İx', 'i̇x'), [[0, 2]]);
  assert.deepEqual(matchesIn('abc', ''), []);
});

test('find: items in transcript order, each with its offsets, and the total', () => {
  const items = [
    it({ id: 'u1', k: 'you', text: 'Look at the Parser' }),
    it({ id: 'c1', k: 'claude', text: 'No match here.' }),
    it({ id: 't1', k: 'tool', name: 'Read', verb: 'Read', obj: '~/src/parser.ts', out: { text: 'export function parse() {}', lines: 1, cut: false } }),
    it({ id: 'c2', k: 'claude', text: 'parser, parser' }),
  ];
  const r = find({ items }, 'parse');
  assert.deepEqual(r.hits.map((h) => h.id), ['u1', 't1', 'c2']);
  assert.deepEqual(r.hits[0].at, [[12, 17]]);
  assert.deepEqual(r.hits[1].at, [[11, 16], [38, 43]]); // "Read(~/src/parser.ts)\nexport function parse() {}"
  assert.deepEqual(r.hits[2].at, [[0, 5], [8, 13]]);
  assert.equal(r.total, 5);
  assert.equal(r.more, false);
  assert.deepEqual(find({ items }, '').hits, []);
  assert.deepEqual(find(null, 'x'), { hits: [], total: 0, more: false });
});

test('find: past MAX_MATCHES the offsets stop and `more` says so', () => {
  const text = 'ab '.repeat(MAX_MATCHES + 5);
  const r = find({ items: [it({ id: 'x', k: 'claude', text }), it({ id: 'y', k: 'claude', text: 'ab' })] }, 'ab');
  assert.equal(r.total, MAX_MATCHES);
  assert.equal(r.more, true);
  assert.deepEqual(r.hits.map((h) => h.id), ['x']);
});

test('find: a shell view searches its output, plain text', () => {
  const r = find({ id: 'toolu_sh', text: '\x1b[32mok\x1b[0m build\nok test\n' }, 'OK');
  assert.deepEqual(r.hits, [{ id: 'toolu_sh', at: [[0, 2], [9, 11]] }]);
});

// The scope of a view, from the fixtures: the main conversation, a subagent's own sidechain, a shell's file and a monitor's events.
const CLAUDE = path.join(import.meta.dirname, 'fixtures', 'claude');
const AGENTS = '44444444-0000-4000-8000-000000000004';
test('findSource: the main conversation, a subagent, a shell, a monitor', async () => {
  const transcripts = new Transcripts({ claudeDir: CLAUDE, home: '/Users/fixture', pollMs: 0, watch: false });
  const publisher = new Publisher({ transcripts, clients: () => new Set(), home: '/Users/fixture', recheckMs: 0 });
  transcripts.open(AGENTS);
  await Promise.resolve();
  try {
    const main = find(await publisher.findSource(AGENTS, null), 'third test');
    assert.equal(main.total, 0, 'the main conversation has no subagent text');
    const sub = find(await publisher.findSource(AGENTS, 'aaaa0002'), 'third test');
    assert.deepEqual(sub.hits.map((h) => h.id), ['aaaa0002-a1:0']);
    assert.ok(find(await publisher.findSource(AGENTS, null), 'release notes').total > 0);
    assert.equal(find(await publisher.findSource(AGENTS, 'aaaa0002'), 'release notes').total, 0, 'a subagent view: its own sidechain only');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-find-'));
    const file = path.join(dir, 'out.txt');
    fs.writeFileSync(file, 'serving on 8080\nGET /index 200\nGET /missing 404\n');
    const outs: Record<string, BgOutput> = {
      toolu_shell: { kind: 'shell', file, events: [] },
      toolu_mon: { kind: 'monitor', file: null, events: [{ n: 0, ts: null, text: 'deploy started' }, { n: 1, ts: null, text: 'deploy done' }] },
    };
    (transcripts as unknown as { outputOf: (sid: string, id: string) => BgOutput | undefined }).outputOf = (_sid, id) => outs[id];
    const shell = find(await publisher.findSource(AGENTS, 'toolu_shell'), 'get /');
    assert.deepEqual(shell.hits, [{ id: 'toolu_shell', at: [[16, 21], [31, 36]] }]);
    const mon = find(await publisher.findSource(AGENTS, 'toolu_mon'), 'deploy');
    assert.deepEqual(mon.hits, [{ id: 'toolu_mon', at: [[0, 6], [15, 21]] }]);
    assert.equal(await publisher.findSource(AGENTS, 'nothing'), null);
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    transcripts.stop(); publisher.stop();
  }
});
