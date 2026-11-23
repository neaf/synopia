import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planOpen, openTarget, OPEN } from '../src/open.ts';

const dir = mkdtempSync(join(tmpdir(), 'synopia-open-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, mode = 0o644): string => {
  const p = join(dir, name);
  writeFileSync(p, 'x');
  chmodSync(p, mode);
  return p;
};

test('open: a plain file is opened', () => {
  const txt = file('notes.txt');
  assert.deepEqual(planOpen({ path: txt }), { ok: true, how: 'open', args: [txt] });
  const html = file('report.html');
  assert.deepEqual(planOpen({ path: html }), { ok: true, how: 'open', args: [html] });
});

test('open: scripts, executables and app bundles are revealed, not opened', () => {
  const sh = file('run.sh');
  assert.deepEqual(planOpen({ path: sh }), { ok: true, how: 'reveal', args: ['-R', sh] });
  const bin = file('tool', 0o755);
  assert.deepEqual(planOpen({ path: bin }), { ok: true, how: 'reveal', args: ['-R', bin] });
  const app = join(dir, 'Thing.app');
  mkdirSync(app);
  assert.deepEqual(planOpen({ path: app }), { ok: true, how: 'reveal', args: ['-R', app] });
  for (const ext of ['.command', '.pkg', '.dmg', '.workflow', '.terminal', '.tool']) {
    const p = file('x' + ext);
    assert.equal((planOpen({ path: p }) as { how: string }).how, 'reveal', ext);
  }
  // a plain folder (execute bit set, as every folder) opens
  const folder = join(dir, 'folder');
  mkdirSync(folder);
  assert.equal((planOpen({ path: folder }) as { how: string }).how, 'open');
});

test('open: relative or missing paths and non-http URLs are refused', () => {
  assert.equal(planOpen({ path: 'notes.txt' }).ok, false);
  assert.equal(planOpen({ path: join(dir, 'gone.txt') }).ok, false);
  assert.equal(planOpen({}).ok, false);
  assert.equal(planOpen({ url: 'file:///etc/passwd' }).ok, false);
  assert.equal(planOpen({ url: 'javascript:alert(1)' }).ok, false);
  assert.equal(planOpen({ url: 'not a url' }).ok, false);
  assert.deepEqual(planOpen({ url: 'https://example.com/a b' }), { ok: true, how: 'url', args: ['https://example.com/a%20b'] });
});

test('openTarget runs /usr/bin/open with argv only, and dry-run runs nothing', () => {
  const calls: [string, string[]][] = [];
  const exec = (f: string, a: string[], done: (e: Error | null) => void) => { calls.push([f, a]); done(null); };
  const sh = file('dry.sh');
  openTarget({ path: sh }, { exec });
  assert.deepEqual(calls, [[OPEN, ['-R', sh]]]);
  const events: string[] = [];
  const plan = openTarget({ path: sh }, { exec, dryRun: true, log: (e, f) => events.push(`${e} ${f?.how}`) });
  assert.equal(calls.length, 1);
  assert.deepEqual([plan.ok && plan.how, events], ['reveal', ['open reveal']]);
  const errors: string[] = [];
  openTarget({ path: 'relative' }, { exec, onError: (t) => errors.push(t) });
  assert.equal(calls.length, 1);
  assert.equal(errors.length, 1);
});
