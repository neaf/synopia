// What the Swift shell reads from a daemon: daemon.json across a handover, and on a --no-parent daemon
// (app/dev.sh's) the first stdout line, daemon.json, GET /api/ping (its pid against daemon.json's),
// GET /api/badge, GET /api/quit-check (`summary`, the confirm's sentence) and POST /api/stop
// (daemon.json gone, no handover). A 200 is the only answer the shell reads; anything else counts as
// no answer. Each reply and daemon.json has the shape of its golden in app/shell/test/golden, which
// app/shell/test/DaemonFilesTest.swift decodes through DaemonFiles.swift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { startDaemon, api, scripted, shellDaemon, tmp, waitFor, watchDaemonJson } from './daemon-harness.ts';
import { readDaemonInfo } from '../src/daemon-files.ts';

const isInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v);

const GOLDEN = fileURLToPath(new URL('../../shell/test/golden/', import.meta.url));
const golden = (name: string) => JSON.parse(readFileSync(join(GOLDEN, name), 'utf8'));
const kind = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

// `live` has the golden's shape: the same keys, the same JSON types, arrays' items like the golden's
// first, and at a `records` key (a map such as quit-check's `background`) every value like the golden's.
function sameShape(live: unknown, gold: unknown, at = '$', records: string[] = []): void {
  assert.equal(kind(live), kind(gold), `${at}: ${kind(live)}, golden ${kind(gold)}`);
  if (Array.isArray(live) && Array.isArray(gold)) {
    if (gold.length) live.forEach((x, i) => sameShape(x, gold[0], `${at}[${i}]`, records));
  } else if (kind(live) === 'object') {
    const l = live as Record<string, unknown>, g = gold as Record<string, unknown>;
    const key = at.split('.').at(-1) as string;
    if (records.includes(key)) {
      const first = Object.values(g)[0];
      for (const [k, v] of Object.entries(l)) sameShape(v, first, `${at}.${k}`, records);
      return;
    }
    assert.deepEqual(Object.keys(l).sort(), Object.keys(g).sort(), `${at}: keys`);
    for (const k of Object.keys(g)) sameShape(l[k], g[k], `${at}.${k}`, records);
  }
}

// The fields DaemonFiles.swift's Info decodes (pid Int32, procStart, port, token, version), present in
// every daemon.json, a handover's too.
function shellFields(raw: Record<string, unknown>) {
  assert.ok(isInt(raw.pid) && (raw.pid as number) > 0 && (raw.pid as number) < 2 ** 31, 'pid: Int32');
  assert.ok(typeof raw.procStart === 'string' && raw.procStart !== '', 'procStart: a non-empty String');
  assert.ok(isInt(raw.port) && (raw.port as number) > 0 && (raw.port as number) < 65536, 'port: Int');
  assert.match(raw.token as string, /^[0-9a-f]{64}$/);
  assert.equal(typeof raw.version, 'string');
}

test('shell contract: a handover leaves daemon.json with `handover` {reason, successor} until the new daemon writes its own', async (t) => {
  // as the shell starts it (daemon.log as stdout and stderr); nothing runs, so a restart goes at once
  const d = await shellDaemon(['--claude-dir', tmp('claude')]);
  let next: number | undefined;
  t.after(async () => { if (next) try { process.kill(next, 'SIGKILL'); } catch { /* gone */ } await d.stop(); });
  const fresh = waitFor(() => { const r = readDaemonInfo(d.stateDir); return r && r.pid !== d.info.pid ? r : null; }, 20_000, 'the new daemon.json');
  const seen = watchDaemonJson(d.stateDir, fresh);
  assert.equal((await api(d.info, 'restart', { method: 'POST' })).status, 200);
  const n = await fresh;
  next = n.pid;
  const marked = (await seen).find((x) => x.handover);
  assert.ok(marked, 'the old daemon, gone, left daemon.json with a handover');
  shellFields(marked as unknown as Record<string, unknown>);
  sameShape(marked, golden('daemon-handover.json'));
  assert.equal(marked.pid, d.info.pid, 'it still names the old daemon, whose pid the shell polled');
  assert.deepEqual(marked.handover, { reason: 'restart', successor: n.pid });
  assert.equal(d.child.exitCode, 0);
  shellFields(n as unknown as Record<string, unknown>);
  assert.equal(n.handover, undefined);
  // the signal is the file alone: nothing need follow the stop line in daemon.log
  assert.equal((await (await api(n, 'ping')).json()).pid, n.pid);
  assert.equal((await api(n, 'stop', { method: 'POST' })).status, 200);
  await waitFor(() => { try { process.kill(n.pid, 0); return false; } catch { return true; } }, 10_000, 'the new daemon to stop');
});

test('shell contract: discovery, ping, badge, quit-check and stop on a --no-parent daemon', async (t) => {
  const d = await startDaemon([...scripted(), '--no-parent']);
  t.after(() => d.stop());
  let out = '', err = '';
  d.child.stdout!.on('data', (c) => { out += c; });
  d.child.stderr!.on('data', (c) => { err += c; });
  const i = d.info;

  // daemon.json: every field DaemonFiles.swift's Info decodes, 0600, and no handover while it runs
  const raw = JSON.parse(readFileSync(join(d.stateDir, 'daemon.json'), 'utf8'));
  shellFields(raw);
  sameShape(raw, golden('daemon.json'));
  assert.equal(raw.handover, undefined);
  assert.equal(statSync(join(d.stateDir, 'daemon.json')).mode & 0o777, 0o600);

  // ping: a JSON object whose pid is daemon.json's
  const ping = await api(i, 'ping');
  assert.equal(ping.status, 200);
  const p = await ping.json() as Record<string, unknown>;
  assert.equal(p.pid, raw.pid);
  assert.equal(p.ok, true);
  assert.equal(typeof p.code, 'string');
  sameShape(p, golden('ping.json'));

  // badge: {badge: Int}
  const badge = await api(i, 'badge');
  assert.equal(badge.status, 200);
  const b = await badge.json() as Record<string, unknown>;
  assert.ok(isInt(b.badge) && (b.badge as number) >= 0, JSON.stringify(b));
  sameShape(b, golden('badge.json'));

  // quit-check: the script runs four turns (three wait on cards), a monitor in 33333333 and two
  // subagents in 44444444; per-kind counts, and the sentence the shell shows after its question
  const qc = await api(i, 'quit-check');
  assert.equal(qc.status, 200);
  const q = await qc.json() as { running: string[]; background: Record<string, number>; summary: string };
  sameShape(q, golden('quit-check.json'), '$', ['background']);
  assert.deepEqual(q.running, ['22222222-0000-4000-8000-000000000002', '33333333-0000-4000-8000-000000000003', '44444444-0000-4000-8000-000000000004', '55555555-0000-4000-8000-000000000005']);
  assert.deepEqual(q.background, { monitor: 1, subagent: 2 });
  assert.equal(q.summary, '4 sessions are working and 2 subagents and 1 monitor will stop.');

  // what the shell gets as "no answer": a wrong token, GET on stop, restart under --no-parent
  assert.equal((await fetch(`http://127.0.0.1:${i.port}/api/ping?token=${'0'.repeat(64)}`)).status, 403);
  assert.equal((await api(i, 'stop')).status, 404, 'stop is POST only');
  assert.equal((await api(i, 'restart', { method: 'POST' })).status, 404, 'no restart under --no-parent');

  // stop: 200 {ok: true}, then the daemon exits 0 and its daemon.json is gone: no handover, so the
  // shell starts a daemon on its next need. The stop line on stderr is a log line, not a signal.
  const exited = once(d.child, 'exit');
  const stop = await api(i, 'stop', { method: 'POST' });
  assert.equal(stop.status, 200);
  assert.deepEqual(await stop.json(), { ok: true });
  const [code] = await exited;
  assert.equal(code, 0);
  assert.equal(existsSync(join(d.stateDir, 'daemon.json')), false);
  assert.match(err, /Synopia backend: stop \(stopAll\)\n/);

  // --no-parent: the first stdout line is {port, token} (dev.sh reads it), nothing more
  assert.deepEqual(JSON.parse(out.split('\n')[0]), { port: i.port, token: i.token });
  assert.equal(out.trim().split('\n').length, 1);
});
