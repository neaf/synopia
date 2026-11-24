// What the Swift shell reads from a daemon, on a --no-parent daemon (app/dev.sh's): the first stdout line,
// daemon.json (Backend.swift Info), GET /api/ping (its pid against daemon.json's), GET /api/badge
// (an Int), GET /api/quit-check (AppDelegate.swift QuitCheck: running [String], background [{kind}]),
// POST /api/stop and the stop line on stderr (daemon.log, Backend.lastLogLine). A 200 is the only answer
// the shell reads; anything else counts as no answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { startDaemon, api, FIXTURES } from './daemon-harness.ts';

const isInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v);

test('shell contract: discovery, ping, badge, quit-check and stop on a --no-parent daemon', async (t) => {
  const d = await startDaemon(['--fake', '--claude-dir', FIXTURES, '--no-parent']);
  t.after(() => d.stop());
  let out = '', err = '';
  d.child.stdout!.on('data', (c) => { out += c; });
  d.child.stderr!.on('data', (c) => { err += c; });
  const i = d.info;

  // daemon.json: every field Backend.swift's Info decodes, 0600
  const raw = JSON.parse(readFileSync(join(d.stateDir, 'daemon.json'), 'utf8'));
  assert.ok(isInt(raw.pid) && raw.pid > 0 && raw.pid < 2 ** 31, 'pid: Int32');
  assert.ok(typeof raw.procStart === 'string' && raw.procStart !== '', 'procStart: a non-empty String');
  assert.ok(isInt(raw.port) && raw.port > 0 && raw.port < 65536, 'port: Int');
  assert.match(raw.token, /^[0-9a-f]{64}$/);
  assert.equal(typeof raw.version, 'string');
  assert.equal(statSync(join(d.stateDir, 'daemon.json')).mode & 0o777, 0o600);

  // ping: a JSON object whose pid is daemon.json's
  const ping = await api(i, 'ping');
  assert.equal(ping.status, 200);
  const p = await ping.json() as Record<string, unknown>;
  assert.equal(p.pid, raw.pid);
  assert.equal(p.ok, true);
  assert.equal(typeof p.code, 'string');

  // badge: {badge: Int}
  const badge = await api(i, 'badge');
  assert.equal(badge.status, 200);
  const b = await badge.json() as Record<string, unknown>;
  assert.ok(isInt(b.badge) && (b.badge as number) >= 0, JSON.stringify(b));

  // quit-check: running [String], background [{kind: String}] (empty here: --fake runs no process)
  const qc = await api(i, 'quit-check');
  assert.equal(qc.status, 200);
  const q = await qc.json() as { running: unknown[]; background: { kind: unknown }[] };
  assert.ok(Array.isArray(q.running) && q.running.every((x) => typeof x === 'string'));
  assert.ok(Array.isArray(q.background) && q.background.every((x) => typeof x.kind === 'string'));
  assert.deepEqual(q, { running: [], background: [] });

  // what the shell gets as "no answer": a wrong token, GET on stop, restart under --no-parent
  assert.equal((await fetch(`http://127.0.0.1:${i.port}/api/ping?token=${'0'.repeat(64)}`)).status, 403);
  assert.equal((await api(i, 'stop')).status, 404, 'stop is POST only');
  assert.equal((await api(i, 'restart', { method: 'POST' })).status, 404, 'no restart under --no-parent');

  // stop: 200 {ok: true}, then the daemon exits 0, its daemon.json gone, the stop line last on stderr
  const exited = once(d.child, 'exit');
  const stop = await api(i, 'stop', { method: 'POST' });
  assert.equal(stop.status, 200);
  assert.deepEqual(await stop.json(), { ok: true });
  const [code] = await exited;
  assert.equal(code, 0);
  assert.equal(existsSync(join(d.stateDir, 'daemon.json')), false);
  assert.match(err.trim().split('\n').pop() ?? '', /^\d{4}-\d\d-\d\dT[\d:.]+Z Synopia backend: stop \(stopAll\)$/);

  // --no-parent: the first stdout line is {port, token} (dev.sh reads it), nothing more
  assert.deepEqual(JSON.parse(out.split('\n')[0]), { port: i.port, token: i.token });
  assert.equal(out.trim().split('\n').length, 1);
});
