// The one-time upgrade, for real (opt-in, slow: about 30 s; not in check.sh). Run: app/backend/test/upgrade.sh
// A daemon of the `rearch-base` code (git archive into a temp folder, its node_modules a link to this
// tree's) runs on a temp state folder in its fake mode, as the shell started it. Then its checkout
// changes to this tree's code (app/backend/src, app/backend/dev, app/web), as a pull would. The old
// daemon's update check must hand over to the new code: one daemon after, the new daemon.json
// fields, /api/ping answering, the quit check an old shell decodes, and state.json kept.
// Prints one pass or fail line; exits nonzero on a failure. Kills every daemon it started.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] ?? 'rearch-base';
const APP = fileURLToPath(new URL('../../', import.meta.url));
const REPO = join(APP, '..');
const root = mkdtempSync(join(tmpdir(), 'synopia-upgrade-'));
const old = join(root, 'checkout'), stateDir = join(root, 'state'), claudeDir = join(root, 'claude');
const SID = '9a9a9a9a-0000-4000-8000-000000000001';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readJson = (f: string): Record<string, unknown> | null => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// Every node process whose command line names this run's state folder.
const daemons = (): number[] => execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' })
  .split('\n').filter((l) => l.includes(stateDir) && l.includes('main.ts')).map((l) => Number(l.trim().split(/\s+/)[0]));
async function until<T>(what: string, ms: number, f: () => T | null | undefined | false): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(100);
  }
}
const api = (i: Record<string, unknown>, path: string) => fetch(`http://127.0.0.1:${i.port}/api/${path}?token=${i.token}`);
function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(what);
}

let failed: unknown = null;
try {
  // The old checkout: the base tag's app/, its node_modules this tree's (package-lock.json is the same).
  mkdirSync(old);
  execFileSync('sh', ['-c', `git -C "$1" archive "$2" app | tar -x -C "$3"`, 'sh', REPO, BASE, old]);
  const oldBackend = join(old, 'app', 'backend');
  check(readFileSync(join(oldBackend, 'package-lock.json'), 'utf8') === readFileSync(join(APP, 'backend', 'package-lock.json'), 'utf8'),
    'package-lock.json differs from the base: the linked node_modules would not be its own');
  symlinkSync(join(APP, 'backend', 'node_modules'), join(oldBackend, 'node_modules'));

  // A state folder with something to keep, and an empty claude folder (the fake mode runs nothing).
  mkdirSync(join(claudeDir, 'projects'), { recursive: true });
  mkdirSync(stateDir, { mode: 0o700 });
  const seeded = {
    version: 1,
    open: [{ id: SID, cwd: root, openedAt: 1, closedAt: null }],
    layout: { groups: [{ id: 'g1', name: 'Kept', ids: [SID] }], others: [] },
    reviewed: ['agent-kept'],
    models: { [SID]: { model: 'haiku', effort: null } },
    settings: { writerModel: 'haiku' },
  };
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify(seeded));

  // The old daemon as the old shell started it: detached, stdout and stderr on daemon.log.
  const logFd = openSync(join(stateDir, 'daemon.log'), 'a', 0o600);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', join(oldBackend, 'src', 'main.ts'),
    '--state-dir', stateDir, '--fake', '--claude-dir', claudeDir], { detached: true, stdio: ['ignore', logFd, logFd] });
  closeSync(logFd);
  child.unref();
  const before = await until('the old daemon.json', 20_000, () => {
    const i = readJson(join(stateDir, 'daemon.json'));
    return i && i.pid === child.pid ? i : null;
  });
  check(!('v' in before), 'the base daemon.json has no `v`: is this the old code?');
  check((await (await api(before, 'ping')).json() as { pid?: number }).pid === child.pid, 'the old daemon answers /api/ping');

  // The checkout moves to this tree's code.
  for (const [from, to] of [['backend/src', 'backend/src'], ['backend/dev', 'backend/dev'], ['web', 'web']]) {
    rmSync(join(old, 'app', to), { recursive: true, force: true });
    cpSync(join(APP, from), join(old, 'app', to), { recursive: true });
  }

  // Two code readings 10 s apart, then the handover: the new daemon writes its own daemon.json.
  const after = await until('the new daemon.json', 60_000, () => {
    const i = readJson(join(stateDir, 'daemon.json'));
    return i && i.pid !== child.pid && typeof i.v === 'number' && alive(i.pid as number) ? i : null;
  });
  await until('the old daemon gone', 10_000, () => !alive(child.pid as number));
  check(typeof after.code === 'string' && /^[0-9a-f]{16}$/.test(after.code as string), 'daemon.json `code`');
  check(after.code !== before.code, 'a new code hash');
  check(after.v === 2, `daemon.json v ${after.v}`);
  check(!('handover' in after), 'the new daemon wrote its own daemon.json');
  const ping = await (await api(after, 'ping')).json() as { pid?: number; v?: number; code?: string };
  check(ping.pid === after.pid && ping.v === 2 && ping.code === after.code, `ping ${JSON.stringify(ping)}`);
  await sleep(1500); // a second daemon would be starting by now
  const running = daemons();
  check(running.length === 1 && running[0] === after.pid, `one daemon after: ${running.join(', ') || 'none'}`);
  // An old shell, still open, decodes running: [String] and background: [{kind}] before it stops work.
  const qc = await (await api(after, 'quit-check')).json() as { running?: unknown; background?: unknown; summary?: unknown };
  check(Array.isArray(qc.running) && Array.isArray(qc.background) && typeof qc.summary === 'string', `quit-check ${JSON.stringify(qc)}`);
  const st = readJson(join(stateDir, 'state.json')) as typeof seeded | null;
  check(st?.open.some((e) => e.id === SID && e.cwd === root), 'state.json keeps the open list');
  check(st?.layout.groups.some((g) => g.name === 'Kept' && g.ids.includes(SID)), 'state.json keeps the layout');
  check(st?.reviewed.includes('agent-kept'), 'state.json keeps the reviewed marks');
  check(st?.models[SID]?.model === 'haiku', 'state.json keeps the model choice');
  const log = readFileSync(join(stateDir, 'daemon.log'), 'utf8');
  check(log.trimEnd().split('\n').at(-1)?.endsWith('stop (update)'), 'daemon.log ends with the old stop line (the old shell reads it)');
  check((await fetch(`http://127.0.0.1:${after.port}/api/stop?token=${after.token}`, { method: 'POST' })).ok, 'stop');
  await until('the new daemon gone', 10_000, () => !alive(after.pid as number));
} catch (e) {
  failed = e;
}
for (const pid of daemons()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
if (failed) {
  console.log(`upgrade: fail (${(failed as Error).message ?? failed})`);
  console.log(`  kept for a look: ${root}`);
  process.exit(1);
}
rmSync(root, { recursive: true, force: true });
console.log(`upgrade: pass (${BASE} daemon handed over to this tree's code)`);
