// Claude Code records as claude-jsonl.ts classifies them, in the shapes docs/Claude Code
// transcripts.md records (made-up content). Assistant records hold one block each, as the CLI writes them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, agentMetaOf, fileEditOf, inputEditOf, bashEditOf, taskNotes, resultTextIn, imageIn, imageBlocks, landedBlocks, cwdOfRecords, movedContext } from '../src/claude-jsonl.ts';
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

// docs/Claude Code transcripts.md#denied-tool-calls: one user record per denied call (invented text).
test('tool results: a call auto mode blocked, or you turned down at a terminal, is a denial; a hook block or a failure is not', () => {
  const blocked = (kind: string | undefined, content: string, isError = true) => user([{ type: 'tool_result', tool_use_id: 't1', is_error: isError, content }], kind ? { toolDenialKind: kind } : {}).results[0].denial;
  assert.equal(blocked('automode-blocked', 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: invented.'), 'auto');
  assert.equal(blocked(undefined, 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: invented.'), 'auto', 'by its prefix alone');
  assert.equal(blocked('user-rejected', "The user doesn't want to proceed with this tool use."), 'you');
  assert.equal(blocked('permission-rule', '<tool_use_error>PreToolUse:Bash hook error: invented</tool_use_error>'), null, 'a hook or rule block');
  assert.equal(blocked(undefined, 'Exit code 1'), null, 'a plain failure');
  assert.equal(blocked('automode-blocked', 'ok', false), null, 'only an error result');
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

test('user text prefixes', () => {
  assert.deepEqual(bodyOf('<command-name>/review</command-name>\n<command-args>the changelog</command-args>'), { kind: 'command', text: '/review the changelog' });
  assert.deepEqual(bodyOf('<task-notification><tool-use-id>t1</tool-use-id></task-notification>'), { kind: 'notification' });
  assert.deepEqual(bodyOf('<system-reminder>x</system-reminder>'), { kind: 'system' });
  assert.deepEqual(bodyOf('<local-command-stdout>x</local-command-stdout>'), { kind: 'system' });
  assert.deepEqual(user([{ type: 'text', text: '<note>' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]).body, { kind: 'prompt' }, 'a `<` text with an image is a prompt');
  assert.deepEqual(bodyOf('[Image: source: /tmp/x.png]', { isMeta: true }), { kind: 'meta' });
  assert.deepEqual(bodyOf('<bash-input>ls</bash-input>'), { kind: 'bash-input', runs: [{ cmd: 'ls', out: null }], rest: '', then: null });
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
    { taskId: 'b1', toolUseId: 't1', status: 'killed', summary: 'Stopped', result: null, event: null, outputFile: null, waiting: false },
    { taskId: 'm1', toolUseId: null, status: null, summary: 'Monitor event', result: null, event: 'tick', outputFile: null, waiting: false },
    { taskId: 'a1', toolUseId: null, status: 'completed', summary: null, result: 'Done.\n', event: null, outputFile: null, waiting: false },
  ]);
  assert.equal(user('<task-notification><task-id>b1</task-id></task-notification>').notes.length, 1);
  assert.equal(user('<bash-input>echo "<task-notification><task-id>x</task-id></task-notification>"</bash-input>').notes.length, 0, 'not inside a ! command');
});

// docs/Claude Code transcripts.md "A subagent waiting on its own background work" (shape scan 2026-11-26, invented text)
test('a subagent waiting on its own background work: a completed notification that is not its end; a shell result names its task id', () => {
  const [w] = taskNotes('<task-notification>\n<task-id>a1b2c3</task-id>\n<tool-use-id>t9</tool-use-id>\n<output-file>/tmp/t/a1b2c3.output</output-file>\n<status>completed</status>\n'
    + '<summary>Agent "Run the bench" is waiting on its own background work</summary>\n<note>made up</note>\n<result>The bench runs.</result>\n<usage><duration_ms>1</duration_ms></usage>\n</task-notification>');
  assert.deepEqual([w.status, w.waiting, w.result], ['completed', true, 'The bench runs.']);
  const [f] = taskNotes('<task-notification><task-id>a1b2c3</task-id><status>completed</status><summary>Agent "Run the bench" finished</summary></task-notification>');
  assert.equal(f.waiting, false);
  const id = (text: string, isError = false) => user([{ type: 'tool_result', tool_use_id: 't1', content: text, is_error: isError }]).results[0].taskId;
  assert.equal(id('Command running in background with ID: bx7k2. Output is being written to: /tmp/t/bx7k2.output. You will be notified.'), 'bx7k2');
  assert.equal(id('Monitor started (task m4q9z, expires in 30m unless the source ends first).'), 'm4q9z');
  assert.equal(id('Command was moved to the background (ID: b3) so that a message can reach you.'), 'b3');
  assert.equal(id('Command running in background with ID: bx7k2.', true), '', 'not an error');
  assert.equal(id('total 8'), '');
});

test('background output (docs/Claude Code transcripts.md#background-output): the file a shell result names, an end notification\'s, a monitor event\'s lines', () => {
  const res = (text: string) => user([{ type: 'tool_result', tool_use_id: 't1', content: text }]).results[0].outputFile;
  assert.equal(res('Command running in background with ID: b1x2y3z4w. Output is being written to: /private/tmp/claude-501/-tmp-demo/s1/tasks/b1x2y3z4w.output You will be notified when it completes.'),
    '/private/tmp/claude-501/-tmp-demo/s1/tasks/b1x2y3z4w.output');
  assert.equal(res('Command was manually backgrounded by user with ID: b2. Output is being written to: /tmp/claude-501/x/tasks/b2.output'), '/tmp/claude-501/x/tasks/b2.output');
  assert.equal(res('Command was moved to the background (ID: b3) so that a message that arrived while it was running can reach you; it was not interrupted. Output is being written to: /tmp/t/b3.output\nYou will be notified.'), '/tmp/t/b3.output');
  assert.equal(res('Monitor started (task m1, expires in 30m unless the source ends first).'), '', 'a monitor result names no file');
  assert.equal(res('Output is being written to: relative/b4.output'), '', 'only an absolute path');
  const [end] = taskNotes('<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>t1</tool-use-id>\n<output-file>/tmp/t/b1.output</output-file>\n<status>completed</status>\n<summary>Background command "x" completed (exit code 0)</summary>\n</task-notification>');
  assert.equal(end.outputFile, '/tmp/t/b1.output');
  const [ev] = taskNotes('<task-notification>\n<task-id>m1</task-id>\n<summary>Monitor event: "Watch the log"</summary>\n<event>line one\nline two</event>\n</task-notification>');
  assert.equal(ev.event, 'line one\nline two');
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

test('the moved context line (R3.11): Synopia\'s own, read back as "Continued in" with its folder', () => {
  const text = movedContext('~/dev/a "b"', '/Users/demo/dev/a "b"', '~/dev/gone');
  assert.match(text, /^<synopia-moved to="~\/dev\/a &quot;b&quot;">This session continues in \/Users\/demo\/dev\/a "b"\. Its folder ~\/dev\/gone no longer exists/);
  assert.deepEqual(bodyOf(text), { kind: 'moved', to: '~/dev/a "b"' });
  assert.deepEqual(bodyOf('<synopia-other>x</synopia-other>'), { kind: 'system' });
});

test('inputEditOf: an Edit or Write from its input, for a subagent result with no toolUseResult', () => {
  // common first and last lines stay context; the hunk has no line numbers
  assert.deepEqual(inputEditOf('Edit', { file_path: '/Users/fixture/dev/demo.feature/src/a.ts', old_string: 'one\ntwo\nthree\n', new_string: 'one\n2\n2b\nthree\n', replace_all: false }),
    { filePath: '/Users/fixture/dev/demo.feature/src/a.ts', created: false, hunks: [{ oldStart: 0, newStart: 0, lines: [' one', '-two', '+2', '+2b', ' three'] }], unnumbered: true });
  assert.deepEqual(inputEditOf('Edit', { file_path: '/x/a', old_string: 'a', new_string: 'a\nb' })!.hunks[0].lines, [' a', '+b']);
  assert.deepEqual(inputEditOf('Write', { file_path: '/x/b.md', content: '# B\n\nbody\n' }),
    { filePath: '/x/b.md', created: false, hunks: [{ oldStart: 0, newStart: 1, lines: ['+# B', '+', '+body'] }] });
  assert.equal(inputEditOf('Read', { file_path: '/x/a' }), null);
  assert.equal(inputEditOf('Edit', { old_string: 'a', new_string: 'b' }), null);
});

test('classify: a retried request (system/api_error): the sentence the CLI shows (formatted, else message), its HTTP status, a credential error', () => {
  const r = classify({ type: 'system', subtype: 'api_error', level: 'error', source: 'request_retry', uuid: 'e1', timestamp: ts, retryInMs: 3000, retryAttempt: 4, maxRetries: 10,
    error: { message: 'Request failed.', formatted: 'The security token included in the request is expired', status: 403, connection: null, isNetworkDown: false, rateLimits: {}, noResponse: null } });
  assert.deepEqual(r, { uuid: 'e1', ts, sidechain: false, kind: 'api-error', text: 'The security token included in the request is expired', status: 403, credential: false });
  const c = classify({ type: 'system', subtype: 'api_error', error: { message: 'Failed to resolve AWS credentials.', isCloudCredentialError: true } });
  assert.deepEqual(c, { uuid: '', ts: null, sidechain: false, kind: 'api-error', text: 'Failed to resolve AWS credentials.', status: null, credential: true });
});
