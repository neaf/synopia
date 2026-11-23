// Risk 1: memory of the CLI processes. Five new scratch sessions on haiku, one short message each.
// usage: node app/backend/perf/processes.mjs <repo> <temp stateDir> <idleMs>. Prints numbers only.
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [, , wt, stateDir, idleArg] = process.argv;
const idleMs = Number(idleArg);
const backend = path.join(wt, 'app/backend');
const WebSocket = createRequire(path.join(backend, 'package.json'))('ws');
const scratch = '/tmp/synopia-scratch/perf';
fs.mkdirSync(scratch, { recursive: true });
fs.rmSync(stateDir, { recursive: true, force: true });
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({ version: 1, settings: { newSessionCwd: scratch, writerModel: 'haiku', model: 'haiku' } }));

const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning',
  'src/main.ts', '--state-dir', stateDir, '--no-parent', '--idle-ms', String(idleMs)], { cwd: backend, stdio: ['ignore', 'pipe', 'pipe'] });
child.stderr.on('data', () => {});
const ready = await new Promise((res) => {
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) res(JSON.parse(buf.slice(0, i))); });
});
const pid = child.pid;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = () => {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,comm=']).toString().trim().split('\n');
  return out.map((l) => l.trim().split(/\s+/)).map(([p, pp, rss, ...c]) => ({ pid: +p, ppid: +pp, rss: +rss, comm: c.join(' ') }));
};
function tree() {
  const all = ps();
  const kids = all.filter((p) => p.ppid === pid);
  return kids.map((k) => {
    const desc = [];
    const walk = (q) => { for (const p of all) if (p.ppid === q) { desc.push(p); walk(p.pid); } };
    walk(k.pid);
    return { pid: k.pid, name: path.basename(k.comm), rssMB: Math.round(k.rss / 1024), treeMB: Math.round((k.rss + desc.reduce((a, d) => a + d.rss, 0)) / 1024), desc: desc.length };
  });
}
const backendRss = () => Math.round(Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim()) / 1024);

const ws = new WebSocket(`ws://127.0.0.1:${ready.port}/ws`, { headers: { Origin: `http://127.0.0.1:${ready.port}` } });
const status = new Map(); const replaced = new Map(); const placeholders = [];
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.t === 'session') {
    if (m.replaces) replaced.set(m.replaces, m.id);
    else if (!status.has(m.id) && ![...replaced.values()].includes(m.id) && m.title === 'New session') placeholders.push(m.id);
    if (m.status) status.set(m.id, m.status);
  }
  if (m.t === 'toast') console.log('toast received');
});
await new Promise((r) => ws.on('open', r));
const send = (o) => ws.send(JSON.stringify(o));
send({ t: 'auth', token: ready.token });
await sleep(500);
const t0 = Date.now();
for (let i = 0; i < 5; i++) {
  const before = placeholders.length;
  send({ t: 'newSession' });
  while (placeholders.length === before) await sleep(50);
  send({ t: 'send', sid: placeholders[before], text: `Reply with the single word ok${i}.`, uuid: randomUUID() });
}
// Wait until every session has its id and is idle again.
const real = () => placeholders.map((p) => replaced.get(p));
for (let i = 0; i < 240; i++) {
  await sleep(500);
  if (real().every((id) => id && status.get(id) === 'idle')) break;
}
const turnsDone = Date.now();
console.log(`5 turns done in ${Math.round((turnsDone - t0) / 1000)} s; ids ${real().filter(Boolean).length}/5; statuses ${real().map((id) => status.get(id)).join(',')}`);
// Idle between turns: samples every 5 s until the idle end (writer calls come and go meanwhile).
const samples = [];
const end = turnsDone + idleMs + 30000;
while (Date.now() < end) {
  const t = tree();
  samples.push({ at: Math.round((Date.now() - turnsDone) / 1000), t, backend: backendRss() });
  await sleep(5000);
}
for (const s of samples) {
  const claude = s.t.filter((k) => k.name === 'claude');
  console.log(`+${s.at}s children=${s.t.length} claude=${claude.length} rss=[${claude.map((k) => k.rssMB).join(',')}] tree=[${claude.map((k) => k.treeMB).join(',')}] total=${claude.reduce((a, k) => a + k.treeMB, 0)} MB backend=${s.backend} MB`);
}
const names = new Set(samples.flatMap((s) => s.t.map((k) => k.name)));
console.log(`child names seen: ${[...names].join(',')}`);
const idleEnds = fs.readFileSync(path.join(stateDir, 'backend.log'), 'utf8').split('\n').filter((l) => l.includes('driver.idleEnd')).length;
console.log(`driver.idleEnd lines: ${idleEnds}`);
ws.close();
child.kill('SIGTERM');
await new Promise((r) => child.on('exit', r));
console.log('backend stopped');
