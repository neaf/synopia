// Perf batch for Synopia risks 1 and 2 (transcript memory). Prints numbers only, never content.
// usage: node app/backend/perf/transcripts.mjs <repo> <temp stateDir> [count]  (PERF_ONLY=1,13: ranks the Open list cannot reach)
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [, , wt, stateDir, countArg] = process.argv;
const N = Number(countArg ?? 15);
const backend = path.join(wt, 'app/backend');
const req = createRequire(path.join(backend, 'package.json'));
const WebSocket = req('ws');
const sdk = await import(req.resolve('@anthropic-ai/claude-agent-sdk'));

const all = await sdk.listSessions();
const top = all.filter((s) => s.cwd && s.fileSize).sort((a, b) => b.fileSize - a.fileSize).slice(0, N);
const ids = top.map((s) => s.sessionId);
// PERF_ONLY="1,13": measure only these ranks, opened from state.json's open list at start (the Open
// list reaches only the 50 newest per filter, so an old session can't be opened through it).
const only = (process.env.PERF_ONLY ?? '').split(',').filter(Boolean).map(Number);
const seeded = new Set(only.map((r) => top[r - 1].sessionId));
const mb = (n) => Math.round((n / 1048576) * 10) / 10;

// Writer calls off for these (a title already stored): the batch measures the transcript, not haiku.
fs.rmSync(stateDir, { recursive: true, force: true });
fs.mkdirSync(stateDir, { recursive: true });
const written = Object.fromEntries(ids.map((id) => [id, { title: 'perf', now: '', at: 1 }]));
fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({ version: 1, written, open: top.filter((x) => seeded.has(x.sessionId)).map((x) => ({ id: x.sessionId, cwd: x.cwd, openedAt: 1, closedAt: null })) }));

const child = spawn(process.execPath, ['--expose-gc', '--experimental-strip-types', '--disable-warning=ExperimentalWarning',
  'src/main.ts', '--state-dir', stateDir, '--no-parent'], { cwd: backend, stdio: ['ignore', 'pipe', 'pipe'] });
child.stderr.on('data', () => {});
let tReady = 0;
const ready = await new Promise((res) => {
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    const i = buf.indexOf('\n');
    if (i >= 0 && !tReady) { tReady = performance.now(); res(JSON.parse(buf.slice(0, i))); }
  });
});
const pid = child.pid;
const logFile = path.join(stateDir, 'backend.log');
const rssMB = () => Math.round(Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim()) / 1024);
const cpuSec = () => {
  const t = execFileSync('ps', ['-o', 'time=', '-p', String(pid)]).toString().trim(); // m:ss.cc
  const p = t.split(':').map(Number);
  return p.reduce((acc, x) => acc * 60 + x, 0);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function heap() {
  const before = fs.readFileSync(logFile, 'utf8').length;
  process.kill(pid, 'SIGUSR2');
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    const tail = fs.readFileSync(logFile, 'utf8').slice(before);
    const m = tail.match(/ memory rss=(\d+) heapUsed=(\d+) heapTotal=(\d+) external=(\d+) arrayBuffers=(\d+)/);
    if (m) return { rss: +m[1], heapUsed: +m[2], heapTotal: +m[3], external: +m[4] };
  }
  return null;
}

const origin = `http://127.0.0.1:${ready.port}`;
const ws = new WebSocket(`ws://127.0.0.1:${ready.port}/ws`, { headers: { Origin: origin }, maxPayload: 256 << 20 });
const waiters = [];
const lastAt = new Map(); // sid|agent -> {at, total}
const agents = new Map(); // sid -> Map(aid -> agent)
const bytesIn = new Map();
ws.on('message', (data) => {
  const m = JSON.parse(data.toString());
  if (m.t === 'items') {
    const k = `${m.sid}|${m.agent ?? ''}`;
    lastAt.set(k, { at: performance.now(), total: m.total });
    bytesIn.set(k, (bytesIn.get(k) ?? 0) + data.length);
  }
  if (m.t === 'agents') {
    const a = agents.get(m.sid) ?? new Map();
    for (const x of m.upsert) a.set(x.id, { ...(a.get(x.id) ?? {}), ...x });
    agents.set(m.sid, a);
  }
  for (const w of [...waiters]) if (w.test(m)) { waiters.splice(waiters.indexOf(w), 1); w.res({ m, at: performance.now(), size: data.length }); }
});
const wait = (test, ms = 120000) => new Promise((res, rej) => {
  const w = { test, res };
  waiters.push(w);
  setTimeout(() => { if (waiters.includes(w)) { waiters.splice(waiters.indexOf(w), 1); rej(new Error('timeout')); } }, ms);
});
await new Promise((r) => ws.on('open', r));
ws.send(JSON.stringify({ t: 'auth', token: ready.token }));
await wait((m) => m.t === 'hello');
const send = (o) => ws.send(JSON.stringify(o));
// Settled: no items for this key for `quiet` ms.
async function settled(k, t0, quiet = 1500) {
  for (;;) {
    await sleep(250);
    const l = lastAt.get(k);
    if (l && performance.now() - l.at > quiet) return { ms: Math.round(l.at - t0), total: l.total };
  }
}

const base = { rss: rssMB(), ...(await heap()) };
console.log(`machine RAM ${Math.round(Number(execFileSync('sysctl', ['-n', 'hw.memsize']).toString()) / 1073741824)} GB; backend idle start rss=${base.rss} heapUsed=${base.heapUsed}`);
console.log('n\tfileMB\tagents\tmainItems\tfirstItemsMs\tfirstN\tsettledMs\tagentItems\tagentFirstMs\tagentSettledMs\trssMB\theapUsedMB\texternalMB');
const rows = [];
for (let i = 0; i < top.length; i++) {
  const s = top[i];
  const id = s.sessionId;
  if (only.length && !seeded.has(id)) continue;
  let t0;
  const k = `${id}|`;
  if (seeded.has(id)) { t0 = tReady; } else {
  send({ t: 'listRecent', filter: '' });
  let rec = (await wait((m) => m.t === 'recent' && m.filter === '')).m;
  if (!rec.sessions.some((x) => x.id === id)) {
    send({ t: 'listRecent', filter: s.cwd });
    rec = (await wait((m) => m.t === 'recent' && m.filter === s.cwd)).m;
  }
  const reachable = rec.sessions.some((x) => x.id === id);
  t0 = performance.now();
  send({ t: 'openSession', id });
  try { await wait((m) => m.t === 'session' && m.id === id, 30000); } catch { console.log(`${i + 1}\tnot opened (reachable=${reachable})`); continue; }
  }
  lastAt.delete(k);
  const tv = performance.now();
  send({ t: 'view', sid: id, agent: null });
  const first = await wait((m) => m.t === 'items' && m.sid === id && !m.agent && m.reset);
  const done = await settled(k, t0);
  // its biggest subagent, by item total
  const a = [...(agents.get(id)?.values() ?? [])].sort((x, y) => (y.total ?? 0) - (x.total ?? 0))[0];
  let ar = { total: '-', first: '-', settled: '-' };
  if (a) {
    const ak = `${id}|${a.id}`;
    const ta = performance.now();
    send({ t: 'view', sid: id, agent: a.id });
    const af = await wait((m) => m.t === 'items' && m.sid === id && m.agent === a.id && m.reset);
    const as = await settled(ak, ta, 800);
    ar = { total: as.total, first: Math.round(af.at - ta), settled: as.ms };
  }
  const h = await heap();
  const row = { n: i + 1, fileMB: mb(s.fileSize), agents: agents.get(id)?.size ?? 0, items: done.total,
    first: Math.round(first.at - t0), firstView: Math.round(first.at - tv), firstN: first.m.upsert.length, settled: done.ms,
    ar, rss: rssMB(), heapUsed: h?.heapUsed, external: h?.external };
  rows.push(row);
  console.log([row.n, row.fileMB, row.agents, row.items, row.first, row.firstN, row.settled, ar.total, ar.first, ar.settled, row.rss, row.heapUsed, row.external].join('\t'));
}
const totalMB = mb(top.reduce((a, s) => a + s.fileSize, 0));
console.log(`total transcript ${totalMB} MB main files (subagent files not counted)`);
const c0 = cpuSec();
const rssSamples = [];
for (let i = 0; i < 12; i++) { await sleep(5000); rssSamples.push(rssMB()); }
const c1 = cpuSec();
const h = await heap();
console.log(`idle 60 s: cpu ${(c1 - c0).toFixed(2)} s (${(((c1 - c0) / 60) * 100).toFixed(2)} %), rss ${Math.min(...rssSamples)}-${Math.max(...rssSamples)} MB, after gc rss=${h?.rss} heapUsed=${h?.heapUsed} heapTotal=${h?.heapTotal} external=${h?.external}`);
// Children the backend started (menu idle queries), counted only.
try { console.log(`backend children now: ${execFileSync('pgrep', ['-P', String(pid)]).toString().trim().split('\n').filter(Boolean).length}`); } catch { console.log('backend children now: 0'); }
ws.close();
child.kill('SIGTERM');
await new Promise((r) => child.on('exit', r));
console.log('backend stopped');
