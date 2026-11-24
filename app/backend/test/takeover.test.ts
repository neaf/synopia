// The terminal take-over (R3.2, 2026-11-24): Synopia yields to a terminal, and takes a session
// back from one, with fake terminals (cli-terminals.ts) and a fake CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Views } from '../src/views.ts';
import { Sessions } from '../src/sessions.ts';
import type { TerminalSource } from '../src/sessions.ts';
import type { QueryFn } from '../src/driver.ts';
import type { Terminal } from '../src/cli-terminals.ts';
import { openStore } from '../src/store.ts';
import type { Client } from '../src/server.ts';
import type { Options, SDKMessage, SDKSessionInfo, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

type Msg = { t: string; [k: string]: unknown };
const tick = () => new Promise((r) => setTimeout(r, 5));
const SID = '11111111-2222-4333-8444-555555555555';

function channel<T>() {
  const buf: T[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  return {
    push(m: T) { buf.push(m); wake?.(); wake = null; },
    end() { done = true; wake?.(); wake = null; },
    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
      while (true) {
        while (buf.length) yield buf.shift() as T;
        if (done) return;
        await new Promise<void>((r) => (wake = r));
      }
    },
  };
}
type Call = { options: Options; inputs: SDKUserMessage[]; out: ReturnType<typeof channel<SDKMessage>>; closed: boolean; interrupts: number };
function fakeQuery(events: string[]) {
  const calls: Call[] = [];
  const fn: QueryFn = ({ prompt, options }) => {
    const out = channel<SDKMessage>();
    const call: Call = { options, inputs: [], out, closed: false, interrupts: 0 };
    calls.push(call);
    events.push('start');
    void (async () => { for await (const m of prompt) call.inputs.push(m); out.end(); })();
    return Object.assign(out, {
      close: () => { call.closed = true; events.push('close'); out.end(); },
      interrupt: async () => { call.interrupts++; events.push('interrupt'); return { still_queued: [] }; },
    });
  };
  return { calls, fn };
}

// A registry whose terminals the test sets. `fresh` answers the last check before acting.
function fakeRegistry(events: string[]) {
  const held = new Map<string, Terminal>();
  const listeners: (() => void)[] = [];
  const r = {
    fresh: null as ((sid: string) => Terminal | null) | null,
    endOk: true,
    ends: [] as { pid: number; note: string; sid: string }[],
    gate: null as Promise<void> | null,
    set(t: Terminal | null, sid = SID) {
      if (t) held.set(sid, t); else held.delete(sid);
      for (const fn of listeners) fn();
    },
    source: {
      holder: (sid) => held.get(sid) ?? null,
      recheck: (sid) => { events.push('recheck'); return r.fresh ? r.fresh(sid) : held.get(sid) ?? null; },
      onChange: (fn) => { listeners.push(fn); },
      end: async (t, note, sid) => {
        events.push('end');
        r.ends.push({ pid: t.pid, note, sid });
        if (r.gate) await r.gate;
        if (!r.endOk) return false;
        held.delete(sid);
        return true;
      },
    } as TerminalSource,
  };
  return r;
}
const term = (status: string, pid = 54166): Terminal => ({ pid, sessionId: SID, procStart: 'Tue Nov 24 10:02:03 2026', cwd: '/tmp/x', status, statusUpdatedAt: 1 });

function setup(opts: { terminal?: Terminal | null; past?: SDKSessionInfo[] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-takeover-'));
  const claudeDir = path.join(root, 'claude');
  const cwd = path.join(root, 'scratch');
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const got: Msg[] = [];
  const c: Client = { send: (m) => got.push(JSON.parse(JSON.stringify(m))), close: () => {} };
  const store = openStore(path.join(root, 'state'), { minIntervalMs: 0 });
  store.state.open.push({ id: SID, cwd, openedAt: 1, closedAt: null });
  const views = new Views({ claudeDir, clients: () => new Set([c]), home: root, pollMs: 0, watch: false });
  const events: string[] = [];
  const q = fakeQuery(events);
  const reg = fakeRegistry(events);
  if (opts.terminal) reg.set(opts.terminal);
  const sessions = new Sessions({ store, views, queryFn: q.fn, listFn: async () => opts.past ?? [], home: root, registry: reg.source });
  sessions.start();
  const last = () => [...got].reverse().find((m) => m.t === 'session' && m.id === SID) as { status: string; statusDetail: Record<string, unknown> } | undefined;
  const take = (t: string) => { const out = got.filter((m) => m.t === t); got.length = 0; return out; };
  return { sessions, q, reg, events, last, take, store };
}

test('takeover: an idle terminal: the last check, the end (with the note), then the resume and the message', async () => {
  const { sessions, q, reg, events, last } = setup({ terminal: term('idle') });
  assert.equal(last()?.statusDetail.terminal, 54166, 'read-only, with its pid');
  assert.equal(sessions.send(SID, 'hello').ok, true);
  await tick();
  assert.deepEqual(events, ['recheck', 'end', 'recheck', 'start'], 'checked again right before acting, and before the start');
  assert.match(reg.ends[0].note, new RegExp(`^Synopia took over this session at \\d\\d:\\d\\d\\. To continue here instead: claude --resume ${SID}\\n$`));
  assert.equal(q.calls[0].options.resume, SID);
  assert.equal(q.calls[0].inputs.length, 1);
  assert.equal(q.calls[0].inputs[0].message.content, 'hello');
  const s = last();
  assert.equal(s?.status, 'busy');
  assert.equal(s?.statusDetail.terminal, undefined);
  assert.equal(s?.statusDetail.takeover, undefined, 'the mark clears with the turn started: the page clears the box');
});

test('takeover: a busy terminal: the message waits, and goes once it is idle', async () => {
  const { sessions, q, reg, last } = setup({ terminal: term('busy') });
  assert.equal(sessions.send(SID, 'first').ok, true);
  assert.equal(last()?.statusDetail.takeover, 'waiting');
  reg.set(term('waiting'));
  await tick();
  assert.equal(reg.ends.length, 0, 'not while it waits on you');
  assert.equal(sessions.send(SID, 'second').ok, true, 'a newer message replaces it');
  reg.set(term('idle'));
  await tick();
  assert.equal(reg.ends.length, 1);
  assert.equal(q.calls.length, 1);
  assert.deepEqual(q.calls[0].inputs.map((m) => m.message.content), ['second']);
});

test('takeover: an edit or Esc cancels the wait', async () => {
  const { sessions, q, reg, last } = setup({ terminal: term('busy') });
  sessions.send(SID, 'hello');
  sessions.cancelTakeover(SID);
  assert.equal(last()?.statusDetail.takeover, undefined);
  assert.equal(last()?.statusDetail.terminal, 54166);
  reg.set(term('idle'));
  await tick();
  assert.equal(reg.ends.length, 0);
  assert.equal(q.calls.length, 0);
});

test('takeover: the race: the CLI is busy at the last check, so it waits again', async () => {
  const { sessions, q, reg, last } = setup({ terminal: term('idle') });
  reg.fresh = () => term('busy');
  sessions.send(SID, 'hello');
  await tick();
  assert.equal(reg.ends.length, 0, 'never ended');
  assert.equal(last()?.statusDetail.takeover, 'waiting');
  reg.fresh = null;
  reg.set(term('idle'));
  await tick();
  assert.equal(reg.ends.length, 1);
  assert.equal(q.calls.length, 1);
});

test("takeover: a CLI that won't exit keeps your message in the box, with a toast", async () => {
  const { sessions, q, reg, last, take } = setup({ terminal: term('idle') });
  reg.endOk = false;
  take('toast');
  sessions.send(SID, 'hello');
  await tick();
  assert.equal(q.calls.length, 0);
  assert.equal(last()?.statusDetail.takeover, undefined);
  assert.equal(last()?.statusDetail.terminal, 54166, 'still the terminal’s');
  assert.match(String(take('toast')[0]?.text), /didn't exit.*still in the box/);
});

test('takeover: the CLI exits by itself while the message waits: it goes', async () => {
  const { sessions, q, reg } = setup({ terminal: term('busy') });
  sessions.send(SID, 'hello');
  reg.set(null);
  await tick();
  assert.equal(reg.ends.length, 0, 'nothing to end');
  assert.equal(q.calls.length, 1);
  assert.equal(q.calls[0].inputs[0].message.content, 'hello');
});

test('yield: a terminal appears: the turn is interrupted, the process ends, read-only, then Synopia’s again', async () => {
  const { sessions, q, reg, events, last } = setup();
  sessions.send(SID, 'working');
  await tick();
  assert.equal(q.calls.length, 1);
  events.length = 0;
  reg.set(term('busy'));
  await tick();
  assert.deepEqual(events, ['interrupt', 'close'], 'interrupt, then end');
  assert.equal(last()?.statusDetail.terminal, 54166);
  assert.notEqual(last()?.status, 'failed', 'a yield is no failure');
  // while it holds the session, a message waits instead of reaching a process
  sessions.send(SID, 'mine');
  assert.equal(q.calls.length, 1);
  sessions.cancelTakeover(SID);
  reg.set(null);
  await tick();
  assert.equal(last()?.statusDetail.terminal, undefined, 'its own again');
  assert.equal(q.calls.length, 1, 'quietly: nothing starts');
});

test('yield: an idle process just ends (no interrupt)', async () => {
  const { sessions, q, reg, events } = setup();
  sessions.send(SID, 'x');
  await tick();
  q.calls[0].out.push({ type: 'result', subtype: 'success', is_error: false } as unknown as SDKMessage);
  await tick();
  events.length = 0;
  reg.set(term('idle'));
  await tick();
  assert.deepEqual(events, ['close']);
});

test('one writer: a start the last check refuses keeps the message', async () => {
  const { sessions, q, reg, take } = setup();
  reg.fresh = () => term('busy', 777); // the scan hadn't seen it yet
  take('restore');
  const r = sessions.send(SID, 'hello');
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /terminal holds this session \(pid 777\)/);
  assert.equal(q.calls.length, 0);
  assert.deepEqual(take('restore').map((m) => m.texts), [['hello']], 'back in the box');
});

test('the Open list marks a session a terminal holds', async () => {
  const other = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const { sessions, reg } = setup({ past: [{ sessionId: other, summary: 'x', lastModified: 5, cwd: '/tmp', fileSize: 1 } as SDKSessionInfo] });
  reg.set({ ...term('idle', 999), sessionId: other }, other);
  const rows = await sessions.listRecent();
  assert.equal(rows[0].terminal, 999);
});
