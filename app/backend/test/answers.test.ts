import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DENIED, alwaysText, kindOf, sessionRules, settle } from '../src/answers.ts';
import type { Asked } from '../src/answers.ts';
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

test('answers: the kind of card per tool', () => {
  assert.equal(kindOf('AskUserQuestion'), 'question');
  assert.equal(kindOf('ExitPlanMode'), 'plan');
  assert.equal(kindOf('Bash'), 'permission');
  assert.equal(kindOf('mcp__x__y'), 'permission');
});

test('answers: questions go back as answers keyed by question, multi-select joined with ", ", notes as annotations', () => {
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

test('answers: "type your own" sends the typed text as the answer, with no note', () => {
  const r = settle(asked('AskUserQuestion', QUESTIONS), { questions: [{ own: '  Green  ', picks: ['Red'], note: 'x' }, { picks: ['Small'] }] });
  assert.ok(!('error' in r));
  const inp = (r.result as { updatedInput: Record<string, unknown> }).updatedInput;
  assert.deepEqual(inp.answers, { 'Which colors?': 'Green', 'Which size?': 'Small' });
  assert.equal(inp.annotations, undefined);
});

test('answers: a question left unanswered is refused', () => {
  const r = settle(asked('AskUserQuestion', QUESTIONS), { questions: [{ picks: ['Red'] }] });
  assert.ok('error' in r);
});

test('answers: permission Allow once, Always allow and Deny', () => {
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

test('answers: plan Approve returns to the mode before plan mode; Ask for changes denies with the text', () => {
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

test('answers: the Always allow text has one clause per update entry, with where and for how long', () => {
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
  assert.equal(alwaysText([rule('localSettings'), { type: 'setMode', mode: 'acceptEdits', destination: 'session' }, { type: 'addDirectories', directories: ['/Users/me/dev/other'], destination: 'session' }], '/Users/me'),
    'Always allow Bash(npm run test:*) in this project (.claude/settings.local.json), and switch to accept edits for this session, and allow access to ~/dev/other for this session.');
  assert.equal(alwaysText([{ type: 'removeDirectories', directories: ['/tmp/a'], destination: 'session' }]), 'Remove access to /tmp/a for this session.');
  assert.equal(alwaysText([{ type: 'replaceRules', rules: [{ toolName: 'Edit' }], behavior: 'ask', destination: 'localSettings' }]), 'Always ask before Edit in this project (.claude/settings.local.json).');
  assert.equal(alwaysText([{ type: 'removeRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'userSettings' }]), 'Forget Edit everywhere (~/.claude/settings.json).');
  assert.equal(alwaysText([]), '');
});

test('answers: only allow rules kept for the session are stored as session rules', () => {
  assert.deepEqual(sessionRules([
    { type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '//tmp/**' }, { toolName: 'WebSearch' }], behavior: 'allow', destination: 'session' },
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow', destination: 'localSettings' },
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm' }], behavior: 'deny', destination: 'session' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  ]), ['Read(//tmp/**)', 'WebSearch']);
});
