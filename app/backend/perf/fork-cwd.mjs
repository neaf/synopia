// The scripted check behind docs/Agent SDK.md "Resume and fork in another folder" (decision 8, 2026-11-25):
// can a session continue with another cwd than it was made in? Opt-in, outside check.sh: one real haiku call.
// usage: node app/backend/perf/fork-cwd.mjs <repo>. Prints shapes only; deletes its own session files after,
// under ~/.claude/projects/-private-tmp-synopia-cwdcheck-a and -b, and reads nothing else there.
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const [, , wt] = process.argv;
const req = createRequire(path.join(wt, 'app/backend/package.json'));
const { query, getSessionMessages, listSessions } = await import(req.resolve('@anthropic-ai/claude-agent-sdk'));
const A = '/tmp/synopia-cwdcheck-a', B = '/tmp/synopia-cwdcheck-b';
mkdirSync(A, { recursive: true }); mkdirSync(B, { recursive: true });
const RA = realpathSync(A), RB = realpathSync(B);
const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const projectOf = (real) => path.join(projects, real.replace(/[^A-Za-z0-9]/g, '-'));

function queue() {
  const buf = []; let wake = null, done = false;
  return {
    push(m) { buf.push(m); wake?.(); wake = null; }, end() { done = true; wake?.(); wake = null; },
    async *[Symbol.asyncIterator]() { while (true) { while (buf.length) yield buf.shift(); if (done) return; await new Promise((r) => (wake = r)); } },
  };
}
const msg = (text, quiet) => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid: randomUUID(), ...(quiet ? { shouldQuery: false } : {}) });

async function run(options, text, quiet, waitMs = 8000) {
  const q = queue(); q.push(msg(text, quiet));
  const it = query({ prompt: q, options: { model: 'haiku', ...options } });
  const out = { init: null, result: null, error: null, replied: false };
  const timer = setTimeout(() => { q.end(); try { it.close?.(); } catch {} }, waitMs);
  try {
    for await (const m of it) {
      if (m.type === 'system' && m.subtype === 'init') out.init = { session_id: m.session_id, cwd: m.cwd };
      if (m.type === 'assistant') out.replied = true;
      if (m.type === 'result') { out.result = m.subtype; q.end(); }
    }
  } catch (e) { out.error = String(e?.message || e).slice(0, 200); }
  clearTimeout(timer);
  return out;
}
const has = async (sid, dir, word) => {
  try { const ms = await getSessionMessages(sid, { dir }); return { messages: ms.length, history: JSON.stringify(ms).includes(word) }; }
  catch (e) { return { error: String(e.message).slice(0, 120) }; }
};
const listed = async (dir) => (await listSessions({ dir, includeWorktrees: false })).map((s) => ({ id: s.sessionId.slice(0, 8), cwd: s.cwd }));

try {
  const made = await run({ cwd: A }, 'The code word is PLUM. Reply with just OK.', false, 90000); // the one model call
  const S = made.init?.session_id;
  console.log('made in A:', JSON.stringify({ ...made, init: made.init && { cwd: made.init.cwd } }));
  if (!S) process.exit(1);
  rmSync(A, { recursive: true, force: true }); // A is gone now, as in the real case
  const resumed = await run({ cwd: B, resume: S }, 'Context: now in folder B.', true);
  console.log('resume in B:', JSON.stringify({ sameId: resumed.init?.session_id === S, cwd: resumed.init?.cwd, result: resumed.result, replied: resumed.replied, error: resumed.error }));
  const forked = await run({ cwd: B, resume: S, forkSession: true }, 'Context: forked into folder B.', true);
  const F = forked.init?.session_id;
  console.log('fork in B:', JSON.stringify({ newId: Boolean(F) && F !== S, cwd: forked.init?.cwd, result: forked.result, replied: forked.replied, error: forked.error }));
  console.log('old id, A project:', JSON.stringify(await has(S, RA, 'now in folder B')), 'old id, B project:', JSON.stringify(await has(S, RB, 'PLUM')));
  if (F) console.log('fork, B project:', JSON.stringify(await has(F, RB, 'PLUM')), 'fork, A project:', JSON.stringify(await has(F, RA, 'PLUM')));
  console.log('listSessions B:', JSON.stringify(await listed(RB)), 'A:', JSON.stringify(await listed(RA)));
} finally {
  for (const d of [A, B]) rmSync(d, { recursive: true, force: true });
  for (const r of [RA, RB]) rmSync(projectOf(r), { recursive: true, force: true });
}
