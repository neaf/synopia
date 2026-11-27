// The scripted check behind docs/Agent SDK.md "A `!` command's end as a turn" (R5.13, 2026-11-27): a `!`
// command's input and output sent as one querying user message (`client_composed: true`), idle and during a
// running Bash. Opt-in, outside check.sh: real haiku calls. usage: node app/backend/perf/bang-turn.mjs <repo>.
// Prints shapes only (keys, types, counts); deletes its own session files after, under
// ~/.claude/projects/-private-tmp-synopia-bangcheck, and reads nothing else there.
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, realpathSync, readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const [, , wt] = process.argv;
const req = createRequire(path.join(wt, 'app/backend/package.json'));
const { query } = await import(req.resolve('@anthropic-ai/claude-agent-sdk'));
const D = '/tmp/synopia-bangcheck';
mkdirSync(D, { recursive: true });
const RD = realpathSync(D);
const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const project = path.join(projects, RD.replace(/[^A-Za-z0-9]/g, '-'));

function queue() {
  const buf = []; let wake = null, done = false;
  return {
    push(m) { buf.push(m); wake?.(); wake = null; }, end() { done = true; wake?.(); wake = null; },
    async *[Symbol.asyncIterator]() { while (true) { while (buf.length) yield buf.shift(); if (done) return; await new Promise((r) => (wake = r)); } },
  };
}
const msg = (text, extra = {}) => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid: randomUUID(), ...extra });
const BANG = '<bash-input>echo fig</bash-input>\n<bash-stdout>fig\n</bash-stdout><bash-stderr></bash-stderr>';

// Runs one process: `first` goes in at once; `during` once a Bash tool_use shows (null: none). Ends after `results` results.
async function run(first, during, results) {
  const q = queue(); q.push(first);
  const it = query({ prompt: q, options: { model: 'haiku', cwd: D, allowedTools: ['Bash'], ...(first.resume ? { resume: first.resume } : {}) } });
  const out = { inits: 0, results: [], replied: 0, statusUuids: [], resultUuids: [], sid: null, error: null, pushedDuring: false };
  const timer = setTimeout(() => { q.end(); try { it.close?.(); } catch {} }, 120000);
  try {
    for await (const m of it) {
      if (m.type === 'system' && m.subtype === 'init') { out.inits++; out.sid = m.session_id; }
      if (m.type === 'system' && m.subtype === 'status' && Array.isArray(m.user_message_uuids)) out.statusUuids.push(...m.user_message_uuids);
      if (m.type === 'assistant') {
        out.replied++;
        if (during && !out.pushedDuring && m.message.content.some((b) => b.type === 'tool_use' && b.name === 'Bash')) { q.push(during); out.pushedDuring = true; }
      }
      if (m.type === 'result') {
        out.results.push({ subtype: m.subtype, queued_turn_count: m.queued_turn_count });
        if (Array.isArray(m.user_message_uuids)) out.resultUuids.push(...m.user_message_uuids);
        if (out.results.length >= results) q.end();
        else if (out.results.length === 1) setTimeout(() => q.end(), 20000).unref(); // folded into the same turn: no second result
      }
    }
  } catch (e) { out.error = String(e?.message || e).slice(0, 200); }
  clearTimeout(timer);
  return out;
}

// The records that hold the bang text, as shapes.
function records(sid, uuid, sent) {
  const lines = readFileSync(path.join(project, `${sid}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return lines.filter((r) => JSON.stringify(r).includes('echo fig')).map((r) => {
    const c = r.message?.content ?? r.attachment?.prompt;
    return {
      type: r.type, sub: r.attachment?.type ?? r.operation ?? null, keys: Object.keys(r).sort().join(','),
      attachmentKeys: r.attachment ? Object.keys(r.attachment).sort().join(',') : undefined,
      content: typeof c === 'string' ? (c === sent ? 'string, as sent' : `string, other (${c.length})`) : Array.isArray(c) ? `blocks ${c.map((b) => b.type).join('+')}` : typeof c,
      ownUuid: r.uuid === uuid, sourceUuid: r.attachment?.source_uuid === uuid || r.sourceUuid === uuid || undefined,
      isMeta: r.isMeta, queueTranscriptOnly: r.queueTranscriptOnly, promptSource: r.promptSource,
    };
  });
}

try {
  const idle = msg(BANG, { client_composed: true });
  const a = await run(idle, null, 1);
  console.log('idle:', JSON.stringify({ ...a, sid: undefined, listed: a.resultUuids.includes(idle.uuid) || a.statusUuids.includes(idle.uuid) }));
  console.log('idle records:', JSON.stringify(records(a.sid, idle.uuid, idle.message.content)));

  const turn = msg('Run the shell command `sleep 4` with the Bash tool, then reply with just OK.');
  const during = msg(BANG.replace('echo fig', 'echo fig2').replace('fig\n', 'fig2\n'), { client_composed: true });
  const b = await run(turn, during, 2);
  console.log('during:', JSON.stringify({ ...b, sid: undefined, statusUuids: b.statusUuids.includes(during.uuid), resultUuids: b.resultUuids.includes(during.uuid) }));
  console.log('during records:', JSON.stringify(records(b.sid, during.uuid, during.message.content)));
} finally {
  rmSync(D, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
}
