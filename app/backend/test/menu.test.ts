import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Menus } from '../src/menu.ts';
import { toCommands, toModels, unescapeHtml } from '../src/sdk.ts';
import type { Client } from '../src/server.ts';
import type { ModelInfo, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { fakeQuery } from './support/fake-query.ts';

type Msg = { t: string; [k: string]: unknown };
const CMDS = [
  { name: 'compact', description: 'Clear history but keep a summary. Optional: &lt;instructions&gt;', argumentHint: '&lt;instructions&gt;', builtin: true },
  { name: 'review', description: 'A user command', argumentHint: '' },
  { name: 'review', description: 'Claude Code review', argumentHint: '<pr>', builtin: true },
  { name: '__hidden', description: 'internal', argumentHint: '' },
  { name: 'workflow-launch-exec', description: 'Launch a workflow (server-launched sessions only)', argumentHint: '' },
] as SlashCommand[];
const MODELS = [
  { value: 'default', displayName: 'Default', description: 'Use the default model (currently X)', supportedEffortLevels: ['low', 'high'] },
  { value: 'haiku', resolvedModel: 'claude-haiku-9', displayName: 'Haiku', description: 'Fast' },
] as ModelInfo[];

function client() {
  const got: Msg[] = [];
  const c: Client = { send: (m) => got.push(JSON.parse(JSON.stringify(m))), close: () => {} };
  return { c, got };
}
// The idle probe's process: the shared fake with the menu calls.
const idleFake = (commands: () => Promise<SlashCommand[]> = async () => CMDS) => fakeQuery({ commands, models: async () => MODELS });
const fail = async (): Promise<SlashCommand[]> => { throw new Error('no'); };
const never = () => new Promise<SlashCommand[]>(() => {});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-menu-'));

test('menu: descriptions are unescaped, one row per name (Claude Code\'s own wins), __ and server-only rows dropped', () => {
  assert.equal(unescapeHtml('&lt;a&gt; &amp;lt; &quot;x&quot; &#39;y&#39;'), '<a> &lt; "x" \'y\'');
  assert.deepEqual(toCommands(CMDS), [
    { name: 'compact', description: 'Clear history but keep a summary. Optional: <instructions>', hint: '<instructions>' },
    { name: 'review', description: 'Claude Code review', hint: '<pr>' },
  ]);
  assert.deepEqual(toModels(MODELS), [
    { value: 'default', resolved: null, name: 'Default', description: 'Use the default model (currently X)', effort: ['low', 'high'] },
    { value: 'haiku', resolved: 'claude-haiku-9', name: 'Haiku', description: 'Fast', effort: [] },
  ]);
});

test('menu: one idle query per folder fills the cache; each page gets the folder once', async () => {
  const dir = tmp();
  const a = client(), b = client();
  const q = idleFake();
  const m = new Menus({ reply: (c, m) => c.send(m), clients: () => new Set([a.c, b.c]), sdk: q.sdk });
  await Promise.all([m.viewed(a.c, '~/x', dir, null), m.viewed(b.c, '~/x', dir, null)]);
  assert.equal(q.calls.length, 1, 'one idle query for two views');
  assert.equal(q.calls[0].options.cwd, dir);
  assert.equal(q.calls[0].closed, true, 'closed once read');
  assert.equal(q.calls[0].inputs.length, 0, 'no prompt, no model call');
  assert.deepEqual(a.got.map((x) => [x.t, x.cwd]), [['menu', '~/x']]);
  assert.equal(b.got.length, 1);
  await m.viewed(a.c, '~/x', dir, null);
  assert.equal(a.got.length, 1, 'not sent again');
  assert.equal(q.calls.length, 1, 'cached');
  assert.deepEqual(Object.keys(m.all()), ['~/x'], 'hello carries the cache');
});

test('menu: a running process gives the menu, and pages that had the folder get a change', async () => {
  const dir = tmp();
  const a = client();
  const q = idleFake();
  const m = new Menus({ reply: (c, m) => c.send(m), clients: () => new Set([a.c]), sdk: q.sdk });
  await m.viewed(a.c, '~/x', dir, null);
  const proc = { supportedCommands: async () => [{ name: 'skill-x', description: 'From the process', argumentHint: '' }] as SlashCommand[], supportedModels: async () => MODELS };
  await m.viewed(a.c, '~/x', dir, proc);
  assert.equal(q.calls.length, 1);
  assert.deepEqual((a.got.at(-1)?.commands as { name: string }[]).map((c) => c.name), ['skill-x']);
  m.commandsChanged('~/x', [{ name: 'later', description: '', argumentHint: '' }] as SlashCommand[]);
  assert.deepEqual((a.got.at(-1)?.commands as { name: string }[]).map((c) => c.name), ['later']);
  assert.equal((a.got.at(-1)?.models as unknown[]).length, 2, 'the models stay');
});

test('menu: a running process that never answers times out, and the idle probe fills the menu (sessions-sdk#B7)', async () => {
  const dir = tmp();
  const a = client();
  const q = idleFake();
  const logs: string[] = [];
  const m = new Menus({ reply: (c, m) => c.send(m), clients: () => new Set([a.c]), sdk: q.sdk, processTimeoutMs: 20, log: (e, f) => logs.push(`${e} ${JSON.stringify(f)}`) });
  const hung = { supportedCommands: never, supportedModels: async () => MODELS };
  const t0 = Date.now();
  await m.viewed(a.c, '~/x', dir, hung);
  assert.ok(Date.now() - t0 < 1000, 'the view goes on');
  assert.ok(logs.includes('menu.processFailed {"error":"timeout"}'), logs.join('\n'));
  assert.equal(q.calls.length, 1, 'the idle probe ran instead');
  assert.deepEqual(a.got.map((x) => x.t), ['menu']);
});

test('menu: a failed probe waits before the next try, longer after each failure (sessions-sdk#B8)', async () => {
  const dir = tmp();
  const a = client();
  let now = 0;
  let broken = true;
  const bad = idleFake(async () => (broken ? fail() : CMDS));
  const m = new Menus({ reply: (c, m) => c.send(m), clients: () => new Set([a.c]), sdk: bad.sdk, retryMs: 1000, now: () => now });
  await m.viewed(a.c, '~/x', dir, null);
  assert.equal(a.got.length, 0);
  assert.equal(bad.calls[0].closed, true);
  await m.viewed(a.c, '~/x', dir, null);
  now = 999;
  await m.viewed(a.c, '~/x', dir, null);
  assert.equal(bad.calls.length, 1, 'no new probe (and no hooks) within the wait');
  now = 1000;
  await m.viewed(a.c, '~/x', dir, null);
  assert.equal(bad.calls.length, 2, 'tried again after it');
  now = 2999;
  await m.viewed(a.c, '~/x', dir, null);
  assert.equal(bad.calls.length, 2, 'the second wait is twice as long');
  now = 3000;
  broken = false;
  await m.viewed(a.c, '~/x', dir, null);
  assert.equal(bad.calls.length, 3);
  assert.deepEqual(a.got.map((x) => x.t), ['menu'], 'a success fills it');
  await m.viewed(a.c, '~/gone', path.join(dir, 'gone'), null);
  assert.equal(bad.calls.length, 3, 'no query in a missing folder');
});

test('menu: an idle query that never answers times out and is closed', async () => {
  const dir = tmp();
  const a = client();
  const q = idleFake(never);
  const m = new Menus({ reply: (c, m) => c.send(m), clients: () => new Set([a.c]), timeoutMs: 20, sdk: q.sdk });
  await m.viewed(a.c, '~/x', dir, null);
  assert.equal(q.calls[0].closed, true);
  assert.equal(a.got.length, 0);
});

test('menu: stop aborts an idle query that is still reading (L8)', async () => {
  const dir = tmp();
  const a = client();
  const q = idleFake(never);
  const m = new Menus({ reply: (c, m) => c.send(m), clients: () => new Set([a.c]), sdk: q.sdk });
  const viewed = m.viewed(a.c, '~/x', dir, null);
  await new Promise((r) => setTimeout(r, 5));
  m.stop();
  await viewed;
  assert.equal(q.calls[0].options.abortController?.signal.aborted, true);
  assert.equal(q.calls[0].closed, true);
});

test('menu: the model lists are kept across launches, so hello names the model at once', async () => {
  const dir = tmp();
  const cacheFile = path.join(tmp(), 'menu-cache.json');
  const a = client();
  const first = new Menus({ reply: (c, m) => c.send(m), clients: () => new Set([a.c]), sdk: idleFake().sdk, cacheFile });
  await first.viewed(a.c, '~/x', dir, null);
  // the next launch, before any view
  const q = idleFake();
  const next = new Menus({ reply: (c, m) => c.send(m), clients: () => new Set([a.c]), sdk: q.sdk, cacheFile });
  const hello = next.all()['~/x'];
  assert.deepEqual(hello.models.map((m) => [m.value, m.name, m.resolved]), [['default', 'Default', null], ['haiku', 'Haiku', 'claude-haiku-9']]);
  assert.deepEqual(hello.commands, [], 'commands come with the first view');
  a.got.length = 0;
  await next.viewed(a.c, '~/x', dir, null);
  assert.equal(q.calls.length, 1, 'the folder is still read on its first view');
  assert.equal((a.got[0].commands as unknown[]).length, 2);
  // a broken cache file is ignored
  fs.writeFileSync(cacheFile, '{nope');
  assert.deepEqual(new Menus({ reply: (c, m) => c.send(m), clients: () => new Set(), cacheFile }).all(), {});
});
