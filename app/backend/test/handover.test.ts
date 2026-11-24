// The handover to a new daemon (main.ts handOver, daemon.ts startSuccessor), on a copy of the backend whose
// code each test changes: a new daemon that exits at once or stays silent for 20 s leaves the old one
// running with a toast; an update waits while work runs, is put off when work starts while the new daemon
// loads, and goes once nothing runs. A characterization of the current lifecycle. About 35 s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDaemonInfo } from '../src/daemon.ts';
import { startDaemon, connectPage, waitFor, fixtureCopy, scripted, api, tmp } from './daemon-harness.ts';
import type { Daemon } from './daemon-harness.ts';

const BACKEND = new URL('..', import.meta.url).pathname;
const WEB = new URL('../../web', import.meta.url).pathname;
const S1 = '11111111-0000-4000-8000-000000000001', S2 = '22222222-0000-4000-8000-000000000002';
const TOAST = "The new backend didn't start, so this one goes on. See daemon.log.";

// app/backend/{src, dev, package.json, package-lock.json, node_modules} and app/web, as main.ts finds them
function backendCopy(): { main: string; dir: string } {
  const app = join(tmp('handover'), 'app'), dir = join(app, 'backend');
  mkdirSync(dir, { recursive: true });
  for (const d of ['src', 'dev']) cpSync(join(BACKEND, d), join(dir, d), { recursive: true });
  for (const f of ['package.json', 'package-lock.json']) cpSync(join(BACKEND, f), join(dir, f));
  symlinkSync(join(BACKEND, 'node_modules'), join(dir, 'node_modules'));
  symlinkSync(WEB, join(app, 'web'));
  return { main: join(dir, 'src', 'main.ts'), dir };
}

// as the shell starts it: stdout and stderr are <state>/daemon.log, where the new daemon's go too
async function daemonOf(main: string, args: string[]): Promise<Daemon & { daemonLog: () => string }> {
  const stateDir = tmp('state'), file = join(stateDir, 'daemon.log');
  const fd = openSync(file, 'a');
  const d = await startDaemon(args, { stateDir, main, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  return { ...d, daemonLog: () => readFileSync(file, 'utf8') };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const kill = (pid: number | undefined) => { if (pid) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };

test('handover', { concurrency: true }, async (t) => {
  const runs: Promise<void>[] = [];
  runs.push(t.test('restart: a new daemon that exits at once leaves this one, with a toast', async () => {
    const { main } = backendCopy();
    const d = await daemonOf(main, ['--claude-dir', tmp('claude')]);
    try {
      const page = await connectPage(d.info);
      writeFileSync(main, 'process.exit(1);\n'); // the new code fails as it loads
      assert.equal((await api(d.info, 'restart', { method: 'POST' })).status, 200);
      assert.equal((await page.next('toast', () => true, 15_000)).text, TOAST);
      assert.match(d.log(), /handover\.start reason=restart/);
      assert.match(d.log(), /handover\.failed reason=restart/);
      assert.doesNotMatch(d.log(), /backend\.stop/);
      assert.equal((await (await api(d.info, 'ping')).json()).pid, d.info.pid, 'the old daemon still answers');
      assert.equal(readDaemonInfo(d.stateDir)?.pid, d.info.pid, 'and keeps daemon.json');
      await page.close();
    } finally { await d.stop(); }
  }));

  runs.push(t.test('restart: a new daemon silent for 20 s is ended, this one stays, with a toast', async () => {
    const { main, dir } = backendCopy();
    const d = await daemonOf(main, ['--claude-dir', tmp('claude')]);
    const pidFile = join(dir, 'successor.pid');
    try {
      const page = await connectPage(d.info);
      // the new code starts and never says it loaded
      writeFileSync(main, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
      const t0 = Date.now();
      assert.equal((await api(d.info, 'restart', { method: 'POST' })).status, 200);
      const next = Number(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8'), 10_000, 'the new daemon'));
      assert.equal(alive(next), true);
      assert.equal((await page.next('toast', () => true, 30_000)).text, TOAST);
      assert.ok(Date.now() - t0 >= 19_000, `the toast after the 20 s wait, not ${Date.now() - t0} ms`);
      assert.match(d.log(), /handover\.failed reason=restart/);
      await waitFor(() => !alive(next), 5000, 'the silent daemon to be ended');
      assert.equal((await (await api(d.info, 'ping')).json()).pid, d.info.pid);
      await page.close();
    } finally {
      kill(existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : undefined);
      await d.stop();
    }
  }));

  runs.push(t.test('update: pending while work runs, put off when work starts as the new daemon loads, then handed over', async () => {
    const { main } = backendCopy();
    // the fixture with two scripted sessions: S1's process waits idle, S2's waits on a question card,
    // so the daemon is busy until it is answered; a message that starts a turn is worked on for 3 s
    const claude = fixtureCopy();
    const scriptFile = join(claude, 'sdk-script.json');
    const script = JSON.parse(readFileSync(scriptFile, 'utf8'));
    script.sessions = { [S1]: { start: true }, [S2]: script.sessions[S2] };
    writeFileSync(scriptFile, JSON.stringify(script));
    const d = await daemonOf(main, scripted(claude));
    let next: number | undefined;
    try {
      const page = await connectPage(d.info);
      assert.equal(page.hello.update, false);
      // new code that loads 1.5 s late, so work can start while it loads
      writeFileSync(main, 'await new Promise((ok) => setTimeout(ok, 1500));\n' + readFileSync(main, 'utf8'));
      // the same new hash on two 10 s reads: pending, and the page says so
      assert.equal((await page.next('update', (m) => m.pending === true, 30_000)).pending, true);
      await new Promise((ok) => setTimeout(ok, 1500));
      assert.doesNotMatch(d.log(), /handover\.start/, 'not while a card waits');
      // answered: the script works 3 s, then nothing runs and the handover starts
      page.send({ t: 'answer', sid: S2, requestId: 'req-question-1', answer: { questions: [{ picks: ['No'] }, { picks: ['Blog'] }] } });
      await waitFor(() => /handover\.start reason=update/.test(d.log()), 15_000, 'handover.start');
      // work starts while the new daemon loads (a message to S1 every 300 ms, each turn 3 s): put off
      const work = setInterval(() => page.send({ t: 'send', sid: S1, text: 'One more pass over the demo notes.' }), 300);
      try { await waitFor(() => /handover\.deferred/.test(d.log()), 20_000, 'handover.deferred'); } finally { clearInterval(work); }
      assert.equal(d.child.exitCode, null, 'the old daemon goes on');
      assert.equal(readDaemonInfo(d.stateDir)?.pid, d.info.pid);
      // nothing runs again: the next try hands over
      await waitFor(() => d.child.exitCode !== null, 30_000, 'the old daemon to hand over and exit');
      assert.equal(d.child.exitCode, 0);
      const n = await waitFor(() => { const r = readDaemonInfo(d.stateDir); return r && r.pid !== d.info.pid ? r : null; }, 20_000, 'the new daemon.json');
      next = n.pid;
      assert.match(d.daemonLog(), /Synopia backend: stop \(update\)\n/);
      assert.match(d.log(), /backend\.stop reason=update/);
      assert.equal((await (await api(n, 'ping')).json()).pid, n.pid);
      assert.equal((await api(n, 'stop', { method: 'POST' })).status, 200);
      await waitFor(() => !alive(n.pid), 10_000, 'the new daemon to stop');
    } finally {
      kill(next);
      await d.stop();
    }
  }));
  await Promise.all(runs);
});
