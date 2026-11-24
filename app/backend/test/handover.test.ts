// The handover to a new daemon (daemon.ts handOver, startSuccessor), on a copy of the backend whose code
// each test changes: a new daemon that exits at once or stays silent past the wait leaves the old one
// running with a toast; an update waits while work runs, is put off when work starts while the new
// daemon loads, tries again only after the next code reading, and then hands over with daemon.json's
// `handover`. The waits are cut short by the test-only --update-read-ms and --successor-ms. The work
// is a card the test answers, so no case depends on how fast the machine is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { readDaemonInfo } from '../src/daemon-files.ts';
import { backendCopy, connectPage, shellDaemon, waitFor, fixtureCopy, scripted, api, tmp, watchDaemonJson, killAll } from './daemon-harness.ts';

const S1 = '11111111-0000-4000-8000-000000000001', S2 = '22222222-0000-4000-8000-000000000002';
const TOAST = "The new backend didn't start, so this one goes on. See daemon.log.";
const FAST = ['--update-read-ms', '200'];

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const kill = (pid: number | undefined) => { if (pid) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };
const cycleOf = (log: string, event: string) => [...log.matchAll(new RegExp(`${event.replace('.', '\\.')}[^\\n]* cycle=(\\d+)`, 'g'))].map((m) => Number(m[1]));

test('handover', { concurrency: true }, async (t) => {
  const runs: Promise<void>[] = [];
  runs.push(t.test('restart: a new daemon that exits at once leaves this one, with a toast', async () => {
    const { main } = backendCopy();
    const d = await shellDaemon(['--claude-dir', tmp('claude'), '--successor-ms', '5000'], main);
    try {
      const page = await connectPage(d.info);
      writeFileSync(main, 'process.exit(1);\n'); // the new code fails as it loads
      assert.equal((await api(d.info, 'restart', { method: 'POST' })).status, 200);
      assert.equal((await page.next('toast', () => true, 5000)).text, TOAST);
      assert.match(d.log(), /handover\.start reason=restart/);
      assert.match(d.log(), /handover\.failed reason=restart/);
      assert.doesNotMatch(d.log(), /backend\.stop/);
      assert.equal((await (await api(d.info, 'ping')).json()).pid, d.info.pid, 'the old daemon still answers');
      assert.deepEqual(readDaemonInfo(d.stateDir), d.info, 'and keeps daemon.json, with no handover');
      await page.close();
    } finally {
      await d.stop();
      killAll(d.stateDir);
    }
  }));

  runs.push(t.test('restart: a new daemon silent past the wait is ended, this one stays, with a toast', async () => {
    const { main, dir } = backendCopy();
    const d = await shellDaemon(['--claude-dir', tmp('claude'), '--successor-ms', '3000'], main);
    const pidFile = join(dir, 'successor.pid');
    try {
      const page = await connectPage(d.info);
      // the new code starts and never says it loaded
      writeFileSync(main, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
      const t0 = Date.now();
      assert.equal((await api(d.info, 'restart', { method: 'POST' })).status, 200);
      const next = Number(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8'), 5000, 'the new daemon'));
      assert.equal(alive(next), true);
      assert.equal((await page.next('toast', () => true, 5000)).text, TOAST);
      assert.ok(Date.now() - t0 >= 2900, `the toast after the wait, not ${Date.now() - t0} ms`);
      assert.match(d.log(), /handover\.failed reason=restart/);
      await waitFor(() => !alive(next), 3000, 'the silent daemon to be ended');
      assert.equal((await (await api(d.info, 'ping')).json()).pid, d.info.pid);
      await page.close();
    } finally {
      kill(existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : undefined); // its command line is the test's code
      await d.stop();
      killAll(d.stateDir);
    }
  }));

  runs.push(t.test('update: pending while work runs, put off when work starts as the new daemon loads, handed over on the next reading', async () => {
    const { main } = backendCopy();
    // the fixture with two scripted sessions: S2's process waits on a question card, so the daemon is
    // busy until it is answered (then it works 50 ms); a message to S1 starts one long turn that
    // waits on a card of its own, so the daemon is busy, whatever the load, until the test answers it
    const claude = fixtureCopy();
    const scriptFile = join(claude, 'sdk-script.json');
    const script = JSON.parse(readFileSync(scriptFile, 'utf8'));
    const s2 = script.sessions[S2];
    for (const st of s2.steps) if (st.after) st.after = 50;
    const hold = { id: 'req-hold-1', tool: 'AskUserQuestion', toolUseId: 'toolu_hold1', input: { questions: [
      { question: 'Go on?', header: 'Go', multiSelect: false, options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] } };
    const end = [{ message: { type: 'result', subtype: 'success', is_error: false, result: '', duration_ms: 1, num_turns: 1 } },
      { message: { type: 'system', subtype: 'session_state_changed', state: 'idle' } }];
    script.sessions = { [S1]: { start: true, onSend: [{ ask: hold }, ...end] }, [S2]: s2 };
    writeFileSync(scriptFile, JSON.stringify(script));
    const d = await shellDaemon([...scripted(claude), ...FAST, '--successor-ms', '5000'], main);
    try {
      const page = await connectPage(d.info);
      assert.equal(page.hello.update, false);
      // new code that loads 300 ms late, so work can start while it loads
      writeFileSync(main, 'await new Promise((ok) => setTimeout(ok, 300));\n' + readFileSync(main, 'utf8'));
      // the same new hash on two readings: pending, and the page says so
      assert.equal((await page.next('update', (m) => m.pending === true, 5000)).pending, true);
      await new Promise((ok) => setTimeout(ok, 300));
      assert.doesNotMatch(d.log(), /handover\.start/, 'not while a card waits');
      // answered: the script works 50 ms, then nothing runs and the handover starts
      page.send({ t: 'answer', sid: S2, requestId: 'req-question-1', answer: { questions: [{ picks: ['No'] }, { picks: ['Blog'] }] } });
      await waitFor(() => /handover\.start reason=update/.test(d.log()), 5000, 'handover.start');
      // work starts while the new daemon loads: put off
      page.send({ t: 'send', id: 'a1', sid: S1, text: 'One more pass over the demo notes.' });
      await waitFor(() => /handover\.deferred/.test(d.log()), 5000, 'handover.deferred');
      assert.equal(d.child.exitCode, null, 'the old daemon goes on');
      assert.deepEqual(readDaemonInfo(d.stateDir), d.info);
      await new Promise((ok) => setTimeout(ok, 300)); // readings go on while the work runs
      assert.equal(cycleOf(d.log(), 'handover.start').length, 1, 'no try while the work runs');
      // nothing runs again: after the next reading it hands over, marking daemon.json for the shell
      const exited = once(d.child, 'exit');
      const fresh = waitFor(() => { const r = readDaemonInfo(d.stateDir); return r && r.pid !== d.info.pid ? r : null; }, 10_000, 'the new daemon.json');
      page.send({ t: 'answer', sid: S1, requestId: 'req-hold-1', answer: { questions: [{ picks: ['Yes'] }] } });
      const seen = await watchDaemonJson(d.stateDir, fresh);
      const [code] = await exited;
      assert.equal(code, 0);
      const n = await fresh;
      const [deferred] = cycleOf(d.log(), 'handover.deferred'), starts = cycleOf(d.log(), 'handover.start');
      assert.equal(starts.length, 2, 'one try after the deferral, not one per idle second');
      assert.ok(starts[1] > deferred, `the retry on a new reading (deferred at ${deferred}, retried at ${starts[1]})`);
      const marked = seen.find((i) => i.handover);
      assert.ok(marked, 'daemon.json had a handover before the new daemon wrote its own');
      assert.equal(marked.pid, d.info.pid);
      assert.deepEqual(marked.handover, { reason: 'update', successor: n.pid });
      assert.equal(n.handover, undefined);
      assert.match(d.log(), /backend\.stop reason=update/);
      assert.equal((await (await api(n, 'ping')).json()).pid, n.pid);
      assert.equal((await api(n, 'stop', { method: 'POST' })).status, 200);
      await waitFor(() => !alive(n.pid), 5000, 'the new daemon to stop');
    } finally {
      await d.stop();
      killAll(d.stateDir); // each new daemon it started, waiting or running (final-tooling#B2)
    }
  }));
  await Promise.all(runs);
});
