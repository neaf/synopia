// The SDK adapter (sdk.ts): the options it passes, the untyped extensions, the menu probe, the
// writer's one-shot call and the content of a sent message. All over the shared fake query.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANCEL_QUEUED, STATE_FLAG, SessionProcess, buildOptions, imageError, oneShot, planApproval, probeMenu, readMenu, userContent, writerOptions,
} from '../src/sdk.ts';
import type { ModelInfo, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { emit, fakeQuery, result } from './support/fake-query.ts';

const tick = () => new Promise((r) => setTimeout(r, 5));
const noAsk = async () => ({ behavior: 'deny' as const, message: 'no' });

// ---------- start options and the process ----------

test('sdk: start options leave permissionMode to your settings, add the state flag on top of the environment', () => {
  const o = buildOptions({ cwd: '/w' }, noAsk, () => {});
  assert.equal(o.permissionMode, undefined);
  assert.equal(o.settingSources, undefined);
  assert.equal((o.env as Record<string, string>)[STATE_FLAG], '1');
  assert.equal((o.env as Record<string, string>).PATH, process.env.PATH, 'env replaces the environment, so it is spread first');
  assert.equal(o.perTaskStopAffordance, true);
  assert.equal(o.includePartialMessages, true);
  assert.deepEqual(o.settings, { bashEditDiffEnabled: true });
  const p = buildOptions({ cwd: '/w', resume: 'r', model: 'haiku', effort: 'bogus', plan: true, allowedTools: ['Bash(ls)'] }, noAsk, () => {});
  assert.deepEqual([p.resume, p.model, p.effort, p.permissionMode, p.allowedTools], ['r', 'haiku', undefined, 'plan', ['Bash(ls)']]);
  assert.equal(buildOptions({ cwd: '/w', effort: 'high' }, noAsk, () => {}).effort, 'high');
});

test('sdk: interrupt passes cancelQueued only with the capability, and maps the receipt to our texts', async () => {
  const q = fakeQuery();
  const exits: unknown[] = [];
  const p = new SessionProcess({ cwd: '/w' }, { onMessage: () => {}, onExit: (e, ended) => exits.push([e, ended]), canUseTool: noAsk }, q.fn);
  p.push('first', 'u1');
  p.push([{ type: 'text', text: 'second' }], 'u2');
  const png = { mediaType: 'image/png', data: 'iVBORw0K' };
  p.push([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.data } }], 'u3', [png]);
  let r = await p.interrupt();
  assert.deepEqual(q.calls[0].interrupts, [undefined], 'a plain interrupt without the capability');
  assert.equal(r.cancelQueued, false);
  emit(q.calls[0], { type: 'system', subtype: 'init', session_id: 's', capabilities: [CANCEL_QUEUED, 7] });
  await tick();
  assert.deepEqual(p.capabilities, [CANCEL_QUEUED]);
  q.calls[0].reply = { still_queued: ['u1', 'not-ours'], cancelled: ['u2', 'u3', 'unknown'] };
  r = await p.interrupt();
  assert.deepEqual(q.calls[0].interrupts[1], { cancelQueued: true });
  // an image-only message comes back with its image
  assert.deepEqual(r, { cancelQueued: true, restored: [{ text: 'second', images: [] }, { text: '', images: [png] }], stillQueued: 1 });
  p.close();
  await tick();
  assert.deepEqual(exits, [[null, true]]);
});

test('sdk: bash mode context goes as shouldQuery:false; stderr keeps the last lines; model and effort through the typed calls', async () => {
  const q = fakeQuery();
  const p = new SessionProcess({ cwd: '/w' }, { onMessage: () => {}, onExit: () => {}, canUseTool: noAsk }, q.fn);
  p.pushQuiet('<bash-input>ls</bash-input>', 'b1');
  await tick();
  assert.equal(q.calls[0].inputs[0].shouldQuery, false);
  const stderr = q.calls[0].options.stderr as (d: string) => void;
  for (let i = 0; i < 30; i++) stderr(`line ${i}\n`);
  stderr('partial');
  assert.equal(p.stderrTail().length, 20);
  assert.equal(p.stderrTail().at(-1), 'partial');
  await p.setModel(undefined);
  await p.setEffort('max');
  await p.setEffort('bogus');
  assert.deepEqual(q.calls[0].controls, [['setModel', undefined], ['applyFlagSettings', { effortLevel: 'max' }], ['applyFlagSettings', { effortLevel: null }]]);
  assert.equal(await p.backgroundTasks(), true);
  assert.equal(p.menuSource(), null, 'this fake has no menu calls');
  p.close();
  await tick();
  await assert.rejects(p.setModel('haiku'), /no running process/);
});

test('sdk: plan approval sets the mode before plan mode back, auto when unknown', () => {
  assert.deepEqual(planApproval('acceptEdits'), [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
  assert.deepEqual(planApproval(''), [{ type: 'setMode', mode: 'auto', destination: 'session' }]);
});

// ---------- the menu ----------

const MODELS = [{ value: 'haiku', displayName: 'Haiku', description: 'Fast' }] as ModelInfo[];
const CMDS = [{ name: 'compact', description: '&lt;x&gt;', argumentHint: '' }, { name: 'workflow-launch-exec', description: 'server only', argumentHint: '' }] as SlashCommand[];

test('sdk: the idle probe reads the menu with a prompt that never yields, then closes', async () => {
  const q = fakeQuery({ commands: async () => CMDS, models: async () => MODELS });
  const m = await probeMenu(q.fn, '/w', { abortController: new AbortController() });
  assert.deepEqual(m.commands.map((c) => [c.name, c.description]), [['compact', '<x>']], 'workflow-launch-exec runs server-side only');
  assert.deepEqual(m.models.map((x) => x.value), ['haiku']);
  assert.equal(q.calls[0].inputs.length, 0);
  assert.equal(q.calls[0].closed, true);
  await assert.rejects(probeMenu(fakeQuery().fn, '/w', { abortController: new AbortController() }), /no menu calls/);
});

test('sdk: readMenu times out, and aborts with its signal', async () => {
  const hung = { supportedCommands: () => new Promise<SlashCommand[]>(() => {}), supportedModels: async () => MODELS };
  await assert.rejects(readMenu(hung, 10), /timeout/);
  const ac = new AbortController();
  const r = readMenu(hung, 10_000, ac.signal);
  ac.abort();
  await assert.rejects(r, /aborted/);
});

// ---------- the writer's call ----------

test('sdk: the writer call has nothing to act with and saves nothing', () => {
  const o = writerOptions('haiku', '/state/writer', 'prompt');
  assert.deepEqual([o.maxTurns, o.tools, o.mcpServers, o.strictMcpConfig, o.permissionMode, o.settings, o.persistSession, o.systemPrompt, o.cwd],
    [1, [], {}, true, 'dontAsk', { disableAllHooks: true }, false, 'prompt', '/state/writer']);
});

test('sdk: a one-shot call tells a reply from an error result', async () => {
  const ok = fakeQuery({ onInput: (c) => { emit(c, { type: 'system', subtype: 'hook_started', hook_event: 'SessionStart' }); emit(c, result('{"title":"t"}')); } });
  assert.deepEqual(await oneShot(ok.fn, 'hi', {}), { reply: '{"title":"t"}', failure: null, apiError: null, hooks: ['SessionStart'] });
  assert.equal(ok.calls[0].inputs[0].message.content, 'hi');
  const limited = fakeQuery({ onInput: (c) => { emit(c, { type: 'assistant', error: 'rate_limit', message: { content: [] } }); emit(c, result('', 'error_during_execution')); } });
  assert.deepEqual(await oneShot(limited.fn, 'hi', {}), { reply: '', failure: 'error_during_execution', apiError: 'rate_limit', hooks: [] });
  const flagged = fakeQuery({ onInput: (c) => emit(c, result('API Error: 403', 'success', { is_error: true })) });
  assert.equal((await oneShot(flagged.fn, 'hi', {})).failure, 'error');
  assert.equal((await oneShot(fakeQuery().fn, 'hi', {})).failure, 'noResult');
});

// ---------- the content of a sent message (from content.test.ts) ----------

const im = (n: number | undefined, data = `d${n}`, mediaType = 'image/png') => ({ mediaType, data, ...(n === undefined ? {} : { n }) });
const shape = (c: ReturnType<typeof userContent>) => typeof c === 'string' ? c
  : c.map((b) => b.type === 'text' ? `text:${b.text}` : b.type === 'image' && b.source.type === 'base64' ? `image:${b.source.data}:${b.source.media_type}` : b.type);

test('content: no images is the plain text', () => {
  assert.equal(userContent('hello', []), 'hello');
});

test('content: one text block with the tags kept, then the image block', () => {
  const c = userContent('left [Image #1] right', [im(1)]);
  assert.deepEqual(c, [
    { type: 'text', text: 'left [Image #1] right' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'd1' } },
  ]);
});

test('content: several images go in the order of their tags in the text, not of pasting', () => {
  const c = userContent('a [Image #3] b [Image #1] c [Image #2]', [im(1), im(2, 'd2', 'image/jpeg'), im(3)]);
  assert.deepEqual(shape(c), ['text:a [Image #3] b [Image #1] c [Image #2]', 'image:d3:image/png', 'image:d1:image/png', 'image:d2:image/jpeg']);
});

test('content: a tag at the start or the end; the text block still comes first', () => {
  assert.deepEqual(shape(userContent('[Image #1] what is this', [im(1)])), ['text:[Image #1] what is this', 'image:d1:image/png']);
  assert.deepEqual(shape(userContent('compare [Image #1]', [im(1)])), ['text:compare [Image #1]', 'image:d1:image/png']);
  assert.deepEqual(shape(userContent('[Image #2][Image #1]', [im(1), im(2)])), ['text:[Image #2][Image #1]', 'image:d2:image/png', 'image:d1:image/png']);
});

test('content: an image whose tag is gone from the text is not sent', () => {
  assert.deepEqual(shape(userContent('only [Image #2]', [im(1), im(2)])), ['text:only [Image #2]', 'image:d2:image/png']);
  assert.equal(userContent('no tags left', [im(1)]), 'no tags left', 'no image left: the plain text');
  assert.equal(userContent('[Image #10]', [im(1)]), '[Image #10]', '#1 is not inside #10');
  assert.deepEqual(shape(userContent('twice [Image #1] [Image #1]', [im(1), { ...im(1), data: 'other' }])), ['text:twice [Image #1] [Image #1]', 'image:d1:image/png'], 'one image per tag');
  assert.equal(userContent('[Image #0]', [im(0)]), '[Image #0]', 'a number below 1 is no tag');
});

test('content: an image without a number (an older page) goes after the tagged ones', () => {
  assert.deepEqual(shape(userContent('x [Image #1]', [im(undefined, 'old'), im(1)])), ['text:x [Image #1]', 'image:d1:image/png', 'image:old:image/png']);
  assert.deepEqual(shape(userContent('', [im(undefined, 'old')])), ['image:old:image/png'], 'images only: no empty text block');
});

test('content: empty or broken image data is refused, as are other types and images over 5 MB', () => {
  const png = Buffer.from('png').toString('base64');
  assert.equal(imageError([{ mediaType: 'image/png', data: png }, { mediaType: 'image/jpeg', data: png }]), null);
  assert.match(String(imageError([{ mediaType: 'image/png', data: '' }])), /empty or damaged/);
  assert.match(String(imageError([{ mediaType: 'image/png', data: 'not base64!' }])), /empty or damaged/);
  assert.match(String(imageError([{ mediaType: 'image/png', data: 'abc' }])), /empty or damaged/, 'a length that is no base64');
  assert.match(String(imageError([{ mediaType: 'image/gif', data: png }])), /PNG and JPEG/);
  assert.match(String(imageError([{ mediaType: 'image/png', data: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') }])), /over 5 MB/);
});
