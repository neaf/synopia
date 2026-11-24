// The server's frames on the fixture tree, through a real daemon's socket, equal the recorded ones in
// test/golden/: hello, items (a session and a subagent), session, pending (a request and a clear),
// agents, and the menu a hello carries once a folder's menu is read. Every frame the page got fits the
// shared schema (app/web/js/protocol.js), with no field it doesn't name.
// SYNOPIA_GOLDEN=update rewrites the files (then read the diff).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, connectPage, fixtureCopy, scripted } from './daemon-harness.ts';
import type { Msg } from './daemon-harness.ts';
import { SERVER, VERSION, problem } from '../../web/js/protocol.js';

const GOLDEN = new URL('./golden/', import.meta.url).pathname;
const S1 = '11111111-0000-4000-8000-000000000001', S2 = '22222222-0000-4000-8000-000000000002', S4 = '44444444-0000-4000-8000-000000000004';
const AGENT = 'aaaa0001', LATE = 'aaaa0005';

// Clock-relative values (a status's or a request's start, set by the script's `ago` or the run's clock), the temp
// folder and the daemon's code hash are the only parts that differ between runs.
function normal(m: Msg, claudeDir: string): unknown {
  const walk = (v: unknown, key: string): unknown => {
    if (typeof v === 'number' && (key === 'statusAt' || key === 'since')) return '<time>';
    if (typeof v === 'string' && key === 'code') return '<code>';
    if (typeof v === 'string') return v.split(claudeDir).join('<claude>');
    if (Array.isArray(v)) return v.map((x) => walk(x, ''));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(m, '');
}

function golden(name: string, got: unknown) {
  const file = join(GOLDEN, `${name}.json`);
  if (process.env.SYNOPIA_GOLDEN === 'update') {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, JSON.stringify(got, null, 2) + '\n');
    return;
  }
  assert.deepEqual(got, JSON.parse(readFileSync(file, 'utf8')), `${name} differs from test/golden/${name}.json`);
}

test('protocol: the fixture tree\'s frames equal the goldens', async (t) => {
  const claude = fixtureCopy();
  // one more scripted request, 4 s in: it arrives as a pending frame on the connected page
  const scriptFile = join(claude, 'sdk-script.json');
  const script = JSON.parse(readFileSync(scriptFile, 'utf8'));
  script.sessions[S1].steps = [{ after: 4000, ask: { id: 'req-golden-1', tool: 'Bash', toolUseId: 'toolu_golden1', input: { command: 'ls', description: 'List the folder.' } } }];
  writeFileSync(scriptFile, JSON.stringify(script));
  const d = await startDaemon([...scripted(claude), '--no-parent']);
  t.after(() => d.stop());
  await new Promise((ok) => setTimeout(ok, 1500)); // the script's first steps (streams at 300 and 600 ms) have played
  const p = await connectPage(d.info);
  t.after(() => p.close());
  const n = (m: Msg) => normal(m, claude);

  golden('hello', n(p.hello));

  p.send({ t: 'view', sid: S4, agent: null });
  golden('items-session', n(await p.next('items', (m) => m.sid === S4 && m.agent === null)));
  p.send({ t: 'view', sid: S4, agent: AGENT });
  golden('items-agent', n(await p.next('items', (m) => m.agent === AGENT)));

  // an answer: Sessions settles the request and the session works
  let at = p.frames.length;
  p.send({ t: 'answer', sid: S2, requestId: 'req-question-1', answer: { questions: [{ picks: ['Yes (recommended)'] }, { picks: ['Home', 'Docs'] }] } });
  golden('pending-cleared', n(await p.next('pending', (m) => m.sid === S2, 5000, at)));
  golden('session', n(await p.next('session', (m) => m.id === S2, 5000, at)));

  golden('pending-request', n(await p.next('pending', (m) => m.sid === S1, 10_000)));

  // a subagent's transcript grows: its agent entry goes out again
  at = p.frames.length;
  appendFileSync(join(claude, 'projects', '-tmp-fixture', S4, 'subagents', `agent-${LATE}.jsonl`), JSON.stringify({
    type: 'assistant', uuid: `${LATE}-a2`, timestamp: '2026-11-20T13:01:00.000Z', isSidechain: true, agentId: LATE, sessionId: S4,
    message: { role: 'assistant', content: [{ type: 'text', text: 'Done now.' }] },
  }) + '\n');
  golden('agents', n(await p.next('agents', (m) => m.sid === S4, 10_000, at)));

  // the menu of S1's folder, from its process: the next page's hello carries it (models, effort, commands)
  at = p.frames.length;
  p.send({ t: 'view', sid: S1, agent: null });
  const menu = await p.next('menu', () => true, 10_000, at);
  const q = await connectPage(d.info);
  t.after(() => q.close());
  const cached = (q.hello.menu as Record<string, unknown>)[menu.cwd as string];
  assert.deepEqual(cached, { commands: menu.commands, models: menu.models });
  golden('hello-menu', n(q.hello.menu as Msg));

  assert.equal(p.hello.v, VERSION);
  for (const m of [...p.frames, q.hello]) assert.equal(problem(SERVER, m, true), null, JSON.stringify(m).slice(0, 300));
  for (const s of p.hello.sessions as object[]) assert.equal(problem(SERVER, { t: 'session', ...s }, true), null, 'a hello session is a session frame');
});
