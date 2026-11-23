import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Menus, toCommands, toModels, unescapeHtml } from '../src/menu.ts';
import type { IdleQueryFn } from '../src/menu.ts';
import type { Client } from '../src/server.ts';
import type { ModelInfo, Options, SlashCommand } from '@anthropic-ai/claude-agent-sdk';

type Msg = { t: string; [k: string]: unknown };
const CMDS = [
  { name: 'compact', description: 'Clear history but keep a summary. Optional: &lt;instructions&gt;', argumentHint: '&lt;instructions&gt;', builtin: true },
  { name: 'review', description: 'A user command', argumentHint: '' },
  { name: 'review', description: 'Claude Code review', argumentHint: '<pr>', builtin: true },
  { name: '__hidden', description: 'internal', argumentHint: '' },
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
function idleFake(fail = false) {
  const calls: { options: Options; closed: boolean; yielded: number }[] = [];
  const fn: IdleQueryFn = ({ prompt, options }) => {
    const call = { options, closed: false, yielded: 0 };
    calls.push(call);
    void (async () => { for await (const _ of prompt) call.yielded++; })();
    return {
      supportedCommands: async () => { if (fail) throw new Error('no'); return CMDS; },
      supportedModels: async () => MODELS,
      close: () => { call.closed = true; },
    };
  };
  return { calls, fn };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-menu-'));

test('menu: descriptions are unescaped, one row per name (Claude Code\'s own wins), __ rows dropped', () => {
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
  const m = new Menus({ clients: () => new Set([a.c, b.c]), queryFn: q.fn });
  await Promise.all([m.viewed(a.c, '~/x', dir, null), m.viewed(b.c, '~/x', dir, null)]);
  assert.equal(q.calls.length, 1, 'one idle query for two views');
  assert.equal(q.calls[0].options.cwd, dir);
  assert.equal(q.calls[0].closed, true, 'closed once read');
  assert.equal(q.calls[0].yielded, 0, 'no prompt, no model call');
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
  const m = new Menus({ clients: () => new Set([a.c]), queryFn: q.fn });
  await m.viewed(a.c, '~/x', dir, null);
  const proc = { supportedCommands: async () => [{ name: 'skill-x', description: 'From the process', argumentHint: '' }] as SlashCommand[], supportedModels: async () => MODELS };
  await m.viewed(a.c, '~/x', dir, proc);
  assert.equal(q.calls.length, 1);
  assert.deepEqual((a.got.at(-1)?.commands as { name: string }[]).map((c) => c.name), ['skill-x']);
  m.commandsChanged('~/x', [{ name: 'later', description: '', argumentHint: '' }] as SlashCommand[]);
  assert.deepEqual((a.got.at(-1)?.commands as { name: string }[]).map((c) => c.name), ['later']);
  assert.equal((a.got.at(-1)?.models as unknown[]).length, 2, 'the models stay');
});

test('menu: a failed idle query or a missing folder leaves no menu, and the next view tries again', async () => {
  const dir = tmp();
  const a = client();
  const bad = idleFake(true);
  const m = new Menus({ clients: () => new Set([a.c]), queryFn: bad.fn });
  await m.viewed(a.c, '~/x', dir, null);
  assert.equal(a.got.length, 0);
  assert.equal(bad.calls[0].closed, true);
  await m.viewed(a.c, '~/x', dir, null);
  assert.equal(bad.calls.length, 2);
  await m.viewed(a.c, '~/gone', path.join(dir, 'gone'), null);
  assert.equal(bad.calls.length, 2, 'no query in a missing folder');
});

test('menu: an idle query that never answers times out and is closed', async () => {
  const dir = tmp();
  const a = client();
  let closed = false;
  const m = new Menus({
    clients: () => new Set([a.c]), timeoutMs: 20,
    queryFn: () => ({ supportedCommands: () => new Promise(() => {}), supportedModels: async () => [], close: () => { closed = true; } }),
  });
  await m.viewed(a.c, '~/x', dir, null);
  assert.equal(closed, true);
  assert.equal(a.got.length, 0);
});
