// Claude Code records as claude-jsonl.ts classifies them, in the shapes docs/Claude Code
// transcripts.md records (made-up content). Assistant records hold one block each, as the CLI writes them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, agentMetaOf, fileEditOf, bashEditOf, taskNotes, resultTextIn, imageIn, imageBlocks, landedBlocks, cwdOfRecords } from '../src/claude-jsonl.ts';
import type { ClaudeRecord, UserRecord, AssistantRecord, ToolUse } from '../src/claude-jsonl.ts';

const ts = '2026-11-24T10:00:00.000Z';
const user = (content: unknown, extra: object = {}): UserRecord => {
  const r = classify({ type: 'user', uuid: 'u1', timestamp: ts, message: { role: 'user', content }, ...extra });
  assert.equal(r.kind, 'user');
  return r as UserRecord;
};
const bodyOf = (text: string, extra: object = {}) => user(text, extra).body;

test('interrupt markers: a stop, and a tool you turned down', () => {
  assert.deepEqual(bodyOf('[Request interrupted by user]'), { kind: 'interrupt', interrupt: 'stop' });
  assert.deepEqual(bodyOf('[Request interrupted by user for tool use]'), { kind: 'interrupt', interrupt: 'toolUse' });
  assert.deepEqual(user([{ type: 'text', text: '[Request interrupted by user for tool use]' }]).body, { kind: 'interrupt', interrupt: 'toolUse' });
  assert.deepEqual(bodyOf('Request interrupted by user'), { kind: 'prompt' }, 'only at the start, in brackets');
});

test('tool results: error text an interrupt or a resume wrote is cut short; others are not', () => {
  const r = user([
    { type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
    { type: 'tool_result', tool_use_id: 't2', is_error: true, content: '[Tool call interrupted]' },
    { type: 'tool_result', tool_use_id: 't3', is_error: true, content: 'Exit code 1' },
    { type: 'tool_result', tool_use_id: 't4', content: '[Request interrupted by user]' },
  ]);
  assert.deepEqual(r.results.map((x) => [x.toolUseId, x.isError, x.cutShort, x.index]), [['t1', true, true, 0], ['t2', true, true, 1], ['t3', true, false, 2], ['t4', false, false, 3]]);
  assert.deepEqual(r.body, { kind: 'results' });
});

// The shape a shape-only scan found (2026-11-27): the fields sit on the user record, beside an error
// tool_result; `toolDenialUnanswered` is a string (`stream-closed`), toolUseResult a string.
test('a permission request nobody answered: toolDenialUnanswered, or the error text alone', () => {
  const aborted = {
    type: 'tool_result', tool_use_id: 'toolu_p1', is_error: true,
    content: 'Tool permission request failed: AbortError: Tool permission stream closed before response received',
  };
  const fields = {
    toolDenialKind: 'permission-rule', toolDenialUnanswered: 'stream-closed', toolUseResult: 'Error: invented',
    permissionDecision: { decision: 'reject', source: 'config', reasonType: 'other', ruleSource: 'mcpServerPolicy', reasonCode: 'invented' },
  };
  const r = user([aborted], fields);
  assert.equal(r.unanswered, 'stream-closed');
  assert.deepEqual(r.results.map((x) => [x.isError, x.cutShort]), [[true, false]], 'an error result, not an interrupt');
  assert.deepEqual(r.body, { kind: 'results' });
  assert.equal(user([aborted]).unanswered, 'unknown', 'the text alone');
  assert.equal(user([{ ...aborted, is_error: false }], fields).unanswered, '', 'only beside an error result');
  assert.equal(user([{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'Permission denied' }], { toolDenialKind: 'user-rejected' }).unanswered, '', 'a denial you gave is answered');
  assert.equal(user('Tool permission request failed: a prompt that says so').unanswered, '');
});

test('user text prefixes', () => {
  assert.deepEqual(bodyOf('<command-name>/review</command-name>\n<command-args>the changelog</command-args>'), { kind: 'command', text: '/review the changelog' });
  assert.deepEqual(bodyOf('<task-notification><tool-use-id>t1</tool-use-id></task-notification>'), { kind: 'notification' });
  assert.deepEqual(bodyOf('<system-reminder>x</system-reminder>'), { kind: 'system' });
  assert.deepEqual(bodyOf('<local-command-stdout>x</local-command-stdout>'), { kind: 'system' });
  assert.deepEqual(user([{ type: 'text', text: '<note>' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]).body, { kind: 'prompt' }, 'a `<` text with an image is a prompt');
  assert.deepEqual(bodyOf('[Image: source: /tmp/x.png]', { isMeta: true }), { kind: 'meta' });
  assert.deepEqual(bodyOf('<bash-input>ls</bash-input>'), { kind: 'bash-input', cmd: 'ls' });
  assert.deepEqual(bodyOf('<bash-stdout>a</bash-stdout><bash-stderr></bash-stderr>'), { kind: 'bash-output', out: { out: 'a', err: '', cut: false, exit: null } });
  assert.deepEqual(bodyOf('Tidy the notes.'), { kind: 'prompt' });
});

test('reports: the agent-message body after "The report follows:", indent taken off', () => {
  assert.deepEqual(bodyOf('Another Claude session sent a message.\n<agent-message from="aaaa0004">\nThe report follows:\n  # Notes\n    - nested\n</agent-message>\ntrailer', { isMeta: true }),
    { kind: 'report', agent: 'aaaa0004', text: '# Notes\n  - nested\n' });
  assert.deepEqual(bodyOf('<agent-message from="abc001">\nHello.\n</agent-message>'), { kind: 'report', agent: 'abc001', text: 'Hello.\n' });
});

test('task notifications: ids, status, summary and result; a monitor event has no tool-use id', () => {
  assert.deepEqual(taskNotes('<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>t1</tool-use-id>\n<status>killed</status>\n<summary>Stopped</summary>\n</task-notification>'
    + '<task-notification><task-id>m1</task-id><summary>Monitor event</summary><event>tick</event></task-notification>'
    + '<task-notification><task-id>a1</task-id><status>completed</status><result>Done.\n</result></task-notification>'), [
    { taskId: 'b1', toolUseId: 't1', status: 'killed', summary: 'Stopped', result: null },
    { taskId: 'm1', toolUseId: null, status: null, summary: 'Monitor event', result: null },
    { taskId: 'a1', toolUseId: null, status: 'completed', summary: null, result: 'Done.\n' },
  ]);
  assert.equal(user('<task-notification><task-id>b1</task-id></task-notification>').notes.length, 1);
  assert.equal(user('<bash-input>echo "<task-notification><task-id>x</task-id></task-notification>"</bash-input>').notes.length, 0, 'not inside a ! command');
});

test('toolUseResult: background task ids, an async Agent, edits and shell edits', () => {
  const res = (tur: object) => user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }], { toolUseResult: tur, cwd: '/Users/fixture/dev/demo' }).toolUse;
  assert.deepEqual([res({ backgroundTaskId: 'b1' })?.taskId, res({ backgroundTaskId: 'b1' })?.backgroundTaskId], ['b1', 'b1']);
  assert.equal(res({ taskId: 'm1' })?.taskId, 'm1');
  assert.deepEqual([res({ status: 'async_launched', agentId: 'a1' })?.asyncLaunched, res({ status: 'async_launched', agentId: 'a1' })?.taskId], [true, 'a1']);
  assert.equal(res({ agentId: 'a1' })?.taskId, '', 'an agent id is a task id only for an async launch');
  assert.equal(res({ stdout: '', interrupted: true })?.interrupted, true);
  assert.deepEqual(res({ filePath: '/Users/fixture/a.md', structuredPatch: [{ oldStart: 3, newStart: 3, lines: [' a', '-b', '+c'] }] })?.edit,
    { filePath: '/Users/fixture/a.md', created: false, hunks: [{ oldStart: 3, newStart: 3, lines: [' a', '-b', '+c'] }] });
  assert.deepEqual(res({ bashEditDiff: { files: [{ filePath: 'notes.md', hunks: [], created: true }], moreFiles: 2, changedFiles: ['.stamp', '/abs/x'] } })?.bashEdit,
    { files: [{ filePath: '/Users/fixture/dev/demo/notes.md', created: true, hunks: [] }], changedFiles: ['/Users/fixture/dev/demo/.stamp', '/abs/x'], moreFiles: 2 });
  assert.equal(user('text', { toolUseResult: { backgroundTaskId: 'b1' } }).toolUse, null, 'no tool_result: nothing');
});

test('fileEditOf: a Write that creates a file becomes one hunk of its content', () => {
  assert.deepEqual(fileEditOf({ type: 'create', filePath: '/x/CHANGELOG.md', content: '# Log\n\n- one\n', structuredPatch: [] }),
    { filePath: '/x/CHANGELOG.md', created: true, hunks: [{ oldStart: 0, newStart: 1, lines: ['+# Log', '+', '+- one'] }] });
  assert.equal(fileEditOf({ stdout: '' }), null);
  assert.deepEqual(bashEditOf({ files: [], moreFiles: 0, unavailable: true }, '/x'), { files: [], changedFiles: [], moreFiles: 0 });
});

test('assistant: one block per record, the records of one response share message.id', () => {
  const rec = (uuid: string, block: object) => classify({ type: 'assistant', uuid, timestamp: ts, requestedModel: 'm', message: { id: 'msg_1', role: 'assistant', content: [block] } }) as AssistantRecord;
  const think = rec('a1', { type: 'thinking', thinking: '' });
  const text = rec('a2', { type: 'text', text: 'One question.' });
  const ask = rec('a3', { type: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion', input: { questions: [{ question: 'Which?', header: 'H', multiSelect: true, options: [{ label: 'A', description: 'a' }] }] } });
  assert.deepEqual([think.kind, think.messageId, think.blocks], ['assistant', 'msg_1', [{ type: 'other', index: 0, blockType: 'thinking' }]]);
  assert.deepEqual(text.blocks, [{ type: 'text', index: 0, text: 'One question.' }]);
  assert.deepEqual((ask.blocks[0] as ToolUse).questions, [{ q: 'Which?', header: 'H', multi: true, opts: [['A', 'a']] }]);
  assert.equal(think.requestedModel, 'm');
  const bash = rec('a4', { type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'make', description: 'Build', run_in_background: true, timeout: 600000 } }).blocks[0] as ToolUse;
  assert.deepEqual([bash.background, bash.command, bash.description, bash.timeout], [true, 'make', 'Build', 600000]);
  assert.equal((classify({ type: 'assistant', uuid: 'a5', message: { content: [] } }) as AssistantRecord).messageId, '', 'no id: the reducer keys it by record');
  assert.deepEqual(landedBlocks({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'x' }] } }), { messageId: 'msg_1', types: ['text'] });
  assert.equal(landedBlocks({ type: 'assistant', isSidechain: true, message: { id: 'msg_1', content: [] } }), null, "a subagent's");
});

test('records: titles (an empty custom-title is a removal), modes, PRs, turn ends, sidechain, others', () => {
  const k = (d: object): ClaudeRecord => classify(d as Record<string, unknown>);
  assert.deepEqual(k({ type: 'custom-title', customTitle: '' }), { uuid: '', ts: null, sidechain: false, kind: 'custom-title', title: '' });
  assert.equal((k({ type: 'ai-title', aiTitle: 'Notes' }) as { title: string }).title, 'Notes');
  assert.equal((k({ type: 'permission-mode', permissionMode: 'plan' }) as { mode: string }).mode, 'plan');
  assert.equal((k({ type: 'pr-link', prNumber: 102 }) as { pr: unknown }).pr, 102);
  assert.deepEqual(k({ type: 'system', subtype: 'turn_duration', durationMs: 5000, isSidechain: true }), { uuid: '', ts: null, sidechain: true, kind: 'turn-end', by: 'turn_duration', durationMs: 5000 });
  assert.equal((k({ type: 'system', subtype: 'stop_hook_summary' }) as { durationMs: unknown }).durationMs, null);
  for (const type of ['mode', 'queue-operation', 'last-prompt', 'file-history-snapshot']) assert.equal(k({ type }).kind, 'other', type);
  assert.equal(k({ type: 'system', subtype: 'away_summary' }).kind, 'other');
});

test('queued_command attachments: a typed message, a notification, a hand-back; others open a turn only', () => {
  const q = (prompt: unknown, commandMode: string) => classify({ type: 'attachment', uuid: 'q1', timestamp: ts, attachment: { type: 'queued_command', prompt, commandMode } });
  const typed = q('and this', 'prompt');
  assert.equal(typed.kind, 'queued');
  assert.deepEqual(typed.kind === 'queued' && typed.user && [typed.user.text, typed.user.body], ['and this', { kind: 'prompt' }]);
  const img = q([{ type: 'text', text: 'Look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }], 'prompt');
  assert.deepEqual(img.kind === 'queued' && img.user?.images, [{ index: 1, mediaType: 'image/png', data: 'AAAA' }]);
  const note = q('<task-notification><task-id>b1</task-id><tool-use-id>t1</tool-use-id></task-notification>', 'task-notification');
  assert.deepEqual(note.kind === 'queued' && note.user?.body, { kind: 'notification' });
  const other = q('<system-reminder>x</system-reminder>', 'task-notification');
  assert.deepEqual([other.kind, other.kind === 'queued' && other.user], ['queued', null]);
  assert.equal(q('', 'prompt').kind, 'other', 'empty');
  assert.equal(classify({ type: 'attachment', attachment: { type: 'hook_success' } }).kind, 'other');
});

test('subagent meta, and lookups in a record read again', () => {
  assert.deepEqual(agentMetaOf({ agentType: 'Explore', description: 'Find', toolUseId: 't1', spawnDepth: 2, finished: true }),
    { agentType: 'Explore', isFork: false, description: 'Find', toolUseId: 't1', model: null, spawnDepth: 2, finished: true, stoppedByUser: false });
  assert.equal(agentMetaOf({}).finished, false, 'a missing finished is not an end');
  const rec = { uuid: 'r1', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'out' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }] } };
  assert.equal(resultTextIn(rec, 't1'), 'out');
  assert.equal(resultTextIn(rec, 't2'), null);
  assert.equal(resultTextIn(undefined, 't1'), null);
  assert.deepEqual(imageIn(rec, 'r1', [0, 1]), { mediaType: 'image/png', data: 'AAAA' });
  assert.equal(imageIn(rec, 'r2', [0, 1]), null, 'another record');
  assert.equal(imageIn(rec, 'r1', [0, 0]), null, 'a text block');
  assert.deepEqual(imageIn({ type: 'attachment', uuid: 'q1', attachment: { prompt: [{ type: 'image', source: { type: 'base64', media_type: 'image/gif', data: 'BB' } }] } }, 'q1', [0]), { mediaType: 'image/gif', data: 'BB' });
  assert.deepEqual(imageBlocks([{ type: 'image', source: { type: 'url', url: 'x' } }]), [{ index: 0, mediaType: '', data: null }]);
  assert.equal(cwdOfRecords([{ type: 'x' }, { cwd: '/a' }, { cwd: '/b' }]), '/a');
});
