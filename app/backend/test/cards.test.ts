import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getEventListeners } from 'node:events';
import { Cards, DENIED, alwaysText, kindOf, sessionRules, settle } from '../src/cards.ts';
import type { CardsHooks } from '../src/cards.ts';
import { displayPath } from '../src/paths.ts';
import { ANSWERS_MAX, PLANS_MAX, normalize } from '../src/store.ts';
import { openStore } from '../src/store.ts';
import type { Asked } from '../src/cards.ts';
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';

const QUESTIONS = {
  questions: [
    { question: 'Which colors?', header: 'Colors', options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }], multiSelect: true },
    { question: 'Which size?', header: 'Size', options: [{ label: 'Small', description: '' }, { label: 'Large (Recommended)', description: '' }], multiSelect: false },
  ],
};
const asked = (toolName: string, input: Record<string, unknown>, extra: Partial<Asked> = {}): Asked => ({
  toolName, input, suggestions: [], alwaysAllowed: false, modeBefore: 'auto', ...extra,
});

test('cards: the kind of card per tool', () => {
  assert.equal(kindOf('AskUserQuestion'), 'question');
  assert.equal(kindOf('ExitPlanMode'), 'plan');
  assert.equal(kindOf('Bash'), 'permission');
  assert.equal(kindOf('mcp__x__y'), 'permission');
});

test('cards: questions go back as answers keyed by question, multi-select joined with ", ", notes as annotations', () => {
  const r = settle(asked('AskUserQuestion', QUESTIONS), { questions: [{ picks: ['Red', 'Blue'] }, { picks: ['Large (Recommended)'], note: 'fits the desk' }] });
  assert.ok(!('error' in r));
  assert.deepEqual(r.result, {
    behavior: 'allow',
    updatedInput: {
      ...QUESTIONS,
      answers: { 'Which colors?': 'Red, Blue', 'Which size?': 'Large (Recommended)' },
      annotations: { 'Which size?': { notes: 'fits the desk' } },
    },
  });
  assert.equal(r.label, null, 'the tool result shows the answer');
});

test('cards: "type your own" sends the typed text as the answer, with no note', () => {
  const r = settle(asked('AskUserQuestion', QUESTIONS), { questions: [{ own: '  Green  ', picks: ['Red'], note: 'x' }, { picks: ['Small'] }] });
  assert.ok(!('error' in r));
  const inp = (r.result as { updatedInput: Record<string, unknown> }).updatedInput;
  assert.deepEqual(inp.answers, { 'Which colors?': 'Green', 'Which size?': 'Small' });
  assert.equal(inp.annotations, undefined);
});

test('cards: a question left unanswered is refused', () => {
  const r = settle(asked('AskUserQuestion', QUESTIONS), { questions: [{ picks: ['Red'] }] });
  assert.ok('error' in r);
});

test('cards: permission Allow once, Always allow and Deny', () => {
  const input = { command: 'npm test', description: 'Run the tests' };
  const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' }] as PermissionUpdate[];
  const req = asked('Bash', input, { suggestions, alwaysAllowed: true });
  const once = settle(req, { choice: 'once' });
  assert.ok(!('error' in once));
  assert.deepEqual(once.result, { behavior: 'allow', updatedInput: input, decisionClassification: 'user_temporary' });
  assert.equal(once.label, 'Allow once');

  const always = settle(req, { choice: 'always' });
  assert.ok(!('error' in always));
  assert.deepEqual(always.result, { behavior: 'allow', updatedInput: input, updatedPermissions: suggestions, decisionClassification: 'user_permanent' });
  assert.equal(always.label, 'Always allow');
  assert.deepEqual(always.rules, [], 'a settings-file rule is the CLI\'s to keep');

  const deny = settle(req, { choice: 'deny', text: 'use the fast suite' });
  assert.ok(!('error' in deny));
  assert.deepEqual(deny.result, { behavior: 'deny', message: 'use the fast suite', decisionClassification: 'user_reject' });
  assert.equal(deny.label, 'Denied: use the fast suite');

  const bare = settle(req, { choice: 'deny' });
  assert.ok(!('error' in bare));
  assert.deepEqual(bare.result, { behavior: 'deny', message: DENIED, decisionClassification: 'user_reject' });
  assert.equal(bare.label, 'Denied');

  assert.ok('error' in settle(asked('Bash', input), { choice: 'always' }), 'no Always allow without suggestions');
  assert.ok('error' in settle(req, { choice: 'maybe' }));
});

test('cards: plan Approve returns to the mode before plan mode; Ask for changes denies with the text', () => {
  const input = { plan: '1. Do it', planFilePath: '/tmp/p.md' };
  const ok = settle(asked('ExitPlanMode', input, { modeBefore: 'auto' }), { choice: 'approve' });
  assert.ok(!('error' in ok));
  assert.deepEqual(ok.result, { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode: 'auto', destination: 'session' }], decisionClassification: 'user_temporary' });
  assert.equal(ok.label, 'Approved');
  const back = settle(asked('ExitPlanMode', input, { modeBefore: 'acceptEdits' }), { choice: 'approve' });
  assert.ok(!('error' in back));
  assert.equal((back.result as { updatedPermissions: { mode: string }[] }).updatedPermissions[0].mode, 'acceptEdits');
  const ch = settle(asked('ExitPlanMode', input), { choice: 'changes', text: 'add tests first' });
  assert.ok(!('error' in ch));
  assert.deepEqual(ch.result, { behavior: 'deny', message: 'Changes: add tests first', decisionClassification: 'user_reject' });
  assert.equal(ch.label, 'Changes: add tests first');
  assert.ok('error' in settle(asked('ExitPlanMode', input), { choice: 'changes', text: ' ' }));
});

test('cards: the Always allow text has one clause per update entry, with where and for how long', () => {
  const rule = (destination: string, behavior = 'allow') => ({ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run test:*' }], behavior, destination }) as PermissionUpdate;
  assert.equal(alwaysText([rule('localSettings')]), 'Always allow Bash(npm run test:*) in this project (.claude/settings.local.json).');
  assert.equal(alwaysText([rule('projectSettings')]), 'Always allow Bash(npm run test:*) in this project (.claude/settings.json).');
  assert.equal(alwaysText([rule('userSettings')]), 'Always allow Bash(npm run test:*) everywhere (~/.claude/settings.json).');
  assert.equal(alwaysText([rule('session')]), 'Always allow Bash(npm run test:*) for this session.');
  assert.equal(alwaysText([rule('cliArg')]), 'Always allow Bash(npm run test:*) for this run.');
  assert.equal(alwaysText([rule('session', 'deny')]), 'Always deny Bash(npm run test:*) for this session.');
  assert.equal(alwaysText([{ type: 'addRules', rules: [{ toolName: 'WebSearch' }, { toolName: 'Read', ruleContent: '//tmp/**' }], behavior: 'allow', destination: 'session' }]),
    'Always allow WebSearch, Read(//tmp/**) for this session.');
  assert.equal(alwaysText([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]), 'Switch to accept edits for this session.');
  assert.equal(alwaysText([rule('localSettings'), { type: 'setMode', mode: 'acceptEdits', destination: 'session' }, { type: 'addDirectories', directories: ['/Users/me/dev/other'], destination: 'session' }], (p) => displayPath(p, '/Users/me')),
    'Always allow Bash(npm run test:*) in this project (.claude/settings.local.json), and switch to accept edits for this session, and allow access to ~/dev/other for this session.');
  assert.equal(alwaysText([{ type: 'removeDirectories', directories: ['/tmp/a'], destination: 'session' }]), 'Remove access to /tmp/a for this session.');
  assert.equal(alwaysText([{ type: 'replaceRules', rules: [{ toolName: 'Edit' }], behavior: 'ask', destination: 'localSettings' }]), 'Always ask before Edit in this project (.claude/settings.local.json).');
  assert.equal(alwaysText([{ type: 'removeRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'userSettings' }]), 'Forget Edit everywhere (~/.claude/settings.json).');
  assert.equal(alwaysText([rule('session'), { type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '//tmp/**' }], behavior: 'allow', destination: 'session' }]),
    'Always allow Bash(npm run test:*), Read(//tmp/**) for this session.', 'neighbouring rule entries read as one clause');
  assert.equal(alwaysText([]), '');
});

test('cards: only allow rules kept for the session are stored as session rules', () => {
  assert.deepEqual(sessionRules([
    { type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '//tmp/**' }, { toolName: 'WebSearch' }], behavior: 'allow', destination: 'session' },
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow', destination: 'localSettings' },
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm' }], behavior: 'deny', destination: 'session' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  ]), ['Read(//tmp/**)', 'WebSearch']);
});

// ---------- the parked requests ----------

function cards() {
  const store = openStore(fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-cards-')), { minIntervalMs: 0 });
  const shown: string[] = [], cleared: string[] = [], counts: number[] = [];
  let drained = 0;
  const c = new Cards({
    store, sid: () => SID, show: (r) => shown.push(r.id), clear: (id) => cleared.push(id), count: (n) => counts.push(n),
    context: () => ({ cwd: '~/x', modeBefore: 'auto' }), drained: () => drained++, now: () => 1,
    tilde: (p) => displayPath(p, '/Users/me'),
  });
  return { c, store, shown, cleared, counts, get drained() { return drained; } };
}
const SID = '11111111-2222-4333-8444-555555555555';
const READ_RULE: PermissionUpdate[] = [{ type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '//tmp/**' }], behavior: 'allow', destination: 'session' }];
const opts = (id: string, signal: AbortSignal, extra: object = {}) => ({ signal, toolUseID: `tu-${id}`, requestId: id, ...extra }) as unknown as Parameters<Cards['park']>[2];

test('cards: an answered request lets go of its abort listener', async () => {
  const t = cards();
  const ac = new AbortController();
  const p = t.c.park('Bash', { command: 'ls' }, opts('rq-1', ac.signal));
  assert.equal(getEventListeners(ac.signal, 'abort').length, 1);
  assert.ok(!('error' in t.c.answer('rq-1', { choice: 'once' })));
  assert.equal((await p).behavior, 'allow');
  assert.equal(getEventListeners(ac.signal, 'abort').length, 0, 'removed with the answer');
  assert.equal(t.drained, 1, 'the last card went: held messages may go');
});

test('cards: Always allow stores the session rules; close ends the requests and forgets the rules (Q6)', async () => {
  const t = cards();
  void t.c.park('Read', { file_path: '/tmp/a' }, opts('rq-1', new AbortController().signal, { suggestions: READ_RULE }));
  t.c.answer('rq-1', { choice: 'always' });
  assert.deepEqual(t.c.rules(), ['Read(//tmp/**)']);
  const open = t.c.park('Bash', { command: 'ls' }, opts('rq-2', new AbortController().signal));
  t.c.close();
  assert.deepEqual(await open, { behavior: 'deny', message: 'Interrupted by the user', interrupt: true });
  assert.equal(t.c.rules(), undefined);
  assert.equal(SID in t.store.state.rules, false, 'gone from state.json too');
  assert.equal(t.drained, 1, 'an abort is no drain');
});

test('cards: the Always allow text shows folders with ~', () => {
  const shown: unknown[] = [];
  const hooks: CardsHooks = {
    store: cards().store, sid: () => SID, show: (r) => shown.push(r.always), clear: () => {}, count: () => {},
    context: () => ({ cwd: '~/x', modeBefore: 'auto' }), drained: () => {}, now: () => 1, tilde: (p) => displayPath(p, '/Users/me'),
  };
  const c = new Cards(hooks);
  void c.park('Read', { file_path: '/Users/me/dev/other/a' }, opts('rq-1', new AbortController().signal, {
    suggestions: [{ type: 'addDirectories', directories: ['/Users/me/dev/other'], destination: 'session' }],
  }));
  assert.deepEqual(shown, ['Allow access to ~/dev/other for this session.']);
});

test('cards: answer labels and plans keep the newest ANSWERS_MAX and PLANS_MAX', async () => {
  const t = cards();
  for (let i = 0; i < PLANS_MAX + 2; i++) t.store.state.plans[`old-${i}`] = 'p';
  for (let i = 0; i < ANSWERS_MAX; i++) t.store.state.answers[`old-${i}`] = 'Allow once';
  void t.c.park('ExitPlanMode', { plan: 'The plan' }, opts('rq-p', new AbortController().signal));
  assert.ok(!('error' in t.c.answer('rq-p', { choice: 'approve' })));
  assert.equal(Object.keys(t.store.state.answers).length, ANSWERS_MAX);
  assert.equal(t.store.state.answers['tu-rq-p'], 'Approved', 'the newest is in');
  assert.equal('old-0' in t.store.state.answers, false, 'the oldest went');
  assert.equal(Object.keys(t.store.state.plans).length, PLANS_MAX);
  assert.equal(t.store.state.plans['tu-rq-p'], 'The plan');
  // and a state.json past the caps loads with the newest only
  const big = normalize({ answers: Object.fromEntries(Array.from({ length: ANSWERS_MAX + 5 }, (_, i) => [`a${i}`, 'x'])) });
  assert.equal(Object.keys(big.answers).length, ANSWERS_MAX);
  assert.equal(Object.keys(big.answers)[0], 'a5');
});
