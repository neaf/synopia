// bundle.ts: the bundled agent-harness plugin read from an invented fixture (two skills, one
// `user-invocable: false`, one agent, short rules), a missing or broken one as null with one log
// line, and a real daemon started with --harness logging the bundle's counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { load } from '../src/bundle.ts';
import { scripted, startDaemon, tmp, waitFor } from './daemon-harness.ts';

const FIXTURE = new URL('./fixtures/harness', import.meta.url).pathname;

function recorder() {
  const lines: string[] = [];
  return { lines, log: (event: string, fields: Record<string, unknown> = {}) => lines.push([event, ...Object.entries(fields).map(([k, v]) => `${k}=${v}`)].join(' ')) };
}

function copy(): string {
  const dir = join(tmp('harness'), 'harness');
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

test('bundle: skill folders, plugin.json agents, the rules and their hash', async () => {
  const r = recorder();
  const b = await load(FIXTURE, r.log);
  assert.ok(b);
  assert.equal(b.dir, FIXTURE);
  assert.deepEqual(b.skills, ['greet', 'kit-common'], 'a user-invocable: false skill counts too');
  assert.deepEqual(b.agents, ['helper']);
  const rules = readFileSync(join(FIXTURE, 'instructions/global.md'), 'utf8');
  assert.equal(b.rules, rules);
  assert.equal(b.rulesHash, createHash('sha256').update(rules).digest('hex'));
  assert.deepEqual(r.lines, [`harness.loaded skills=2 agents=1 rules=${b.rulesHash.slice(0, 12)}`]);
});

test('bundle: a folder without SKILL.md is not a skill', async () => {
  const dir = copy();
  rmSync(join(dir, 'skills/greet/SKILL.md'));
  const b = await load(dir, recorder().log);
  assert.deepEqual(b?.skills, ['kit-common']);
});

test('bundle: missing or broken gives null and one harness.missing line, never a throw', async () => {
  const cases: Array<[string, (dir: string) => void, string]> = [
    ['no folder', (dir) => rmSync(dir, { recursive: true }), 'no .claude-plugin/plugin.json'],
    ['no manifest', (dir) => rmSync(join(dir, '.claude-plugin'), { recursive: true }), 'no .claude-plugin/plugin.json'],
    ['bad manifest', (dir) => writeFileSync(join(dir, '.claude-plugin/plugin.json'), '{'), 'plugin.json is not JSON'],
    ['bad agents', (dir) => writeFileSync(join(dir, '.claude-plugin/plugin.json'), '{"name":"harness","agents":"x"}'), 'plugin.json agents is not a list of paths'],
    ['agents not rendered', (dir) => rmSync(join(dir, 'build'), { recursive: true }), 'an agent plugin.json names is missing'],
    ['no skills', (dir) => rmSync(join(dir, 'skills'), { recursive: true }), 'no skills folder'],
    ['no rules', (dir) => rmSync(join(dir, 'instructions'), { recursive: true }), 'no instructions/global.md'],
  ];
  for (const [name, breakIt, reason] of cases) {
    const dir = copy();
    breakIt(dir);
    const r = recorder();
    assert.equal(await load(dir, r.log), null, name);
    assert.deepEqual(r.lines, [`harness.missing reason=${reason}`], name);
  }
});

test('a daemon started with --harness logs the bundle\'s counts; a missing one still starts', async () => {
  const d = await startDaemon([...scripted(), '--harness', FIXTURE]);
  try {
    await waitFor(() => /harness\.loaded skills=2 agents=1 /.test(d.log()), 15_000, 'harness.loaded');
  } finally {
    await d.stop();
  }
  const gone = await startDaemon([...scripted(), '--harness', join(tmp('harness'), 'none')]);
  try {
    await waitFor(() => /harness\.missing reason=/.test(gone.log()), 15_000, 'harness.missing');
  } finally {
    await gone.stop();
  }
});
