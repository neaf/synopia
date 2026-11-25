// /mcp (R5.15): the MCP servers of a session Synopia runs, and what you can do to one: sign in,
// sign out, reconnect, enable or disable. The backend owns the panel's state: each session's rows,
// the action that runs on a server, and the last action's error, sent whole as one `mcp` frame to
// every page (protocol.js). The status and the control calls come from the session's process, or,
// while none runs, from an idle probe in its folder (sdk.ts mcpProbe), closed after a quiet while.
// Sign-in and sign-out run the bundled CLI's `claude mcp login|logout <name>` in the session's
// folder, as server config can be project-scoped; a sign-in opens your browser and ends when its
// flow does. Facts: docs/Agent SDK.md, "MCP servers: status, sign-in" (live run MC-1), and
// docs/Claude Code terminals.md, "claude mcp login and logout".
import { spawn } from 'node:child_process';
import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk';
import type { McpControl } from './sdk.ts';
import { bundledCli } from './sdk.ts';
import type { Log } from './log.ts';
import { nullLog } from './log.ts';

export const LOGIN_TIMEOUT_MS = 5 * 60_000; // the browser flow; the CLI waits for it
export const CLI_TIMEOUT_MS = 30_000; // logout
export const PROBE_IDLE_MS = 3 * 60_000; // a probe closes this long after the panel last asked
export const SETTLE_MS = 500; // the next read while a server connects, or the first read came back empty
export const SETTLE_TRIES = 20;
const OUT_CAP = 64 * 1024;

export const TERMINAL_NOTE = 'A terminal holds this session. Type /mcp in that terminal to manage its MCP servers.';
export const NO_CONTROL = 'Synopia couldn\'t read the MCP servers of this session.';

export type Action = 'login' | 'logout' | 'reconnect' | 'enable' | 'disable';
export const MCP_ACTIONS: readonly Action[] = ['login', 'logout', 'reconnect', 'enable', 'disable'];
export type Kind = 'http' | 'sse' | 'ws' | 'stdio' | 'sdk' | 'claudeai-proxy' | 'other';
// What the page shows of one server: `signIn` for the kinds `claude mcp login` takes (HTTP, SSE, a
// claude.ai connector); `reconnect` not for an in-process server or a disabled one (MC-1).
export type McpRow = { name: string; status: McpServerStatus['status']; kind: Kind; scope: string | null; signIn: boolean; reconnect: boolean; busy: Action | null };

export type RunResult = { code: number | null; stdout: string; stderr: string; timedOut?: boolean };
export type McpRunner = (args: string[], o: { cwd: string; timeoutMs: number; signal: AbortSignal }) => Promise<RunResult>;
export type McpTarget = { id: string; cwd: string; terminal: boolean; control(): McpControl | null };
export type ProbeFn = (cwd: string) => { control: McpControl | null; close: () => void };
export type Result = { ok: true } | { ok: false; error: string };

export type McpDeps = {
  runner: McpRunner;
  probe: ProbeFn;
  send: (msg: object) => void; // to every page (publisher.broadcast)
  log?: Log;
  settleMs?: number;
  loginTimeoutMs?: number;
  probeIdleMs?: number;
};

type Panel = {
  rows: McpRow[];
  busy: Map<string, Action>;
  error: string | null;
  note: string | null;
  reading: boolean;
  probe: { control: McpControl | null; close: () => void } | null;
  probeCwd: string;
  idle: NodeJS.Timeout | null;
  fresh: boolean; // the source is new: an empty first answer is read again (MC-1)
  seq: number;
};

const REMOTE: readonly Kind[] = ['http', 'sse', 'claudeai-proxy'];

export function kindOf(s: McpServerStatus): Kind {
  if (s.source === 'sdk') return 'sdk';
  const c = s.config as { type?: string; command?: string } | undefined;
  const t = c?.type ?? (c?.command ? 'stdio' : undefined);
  return t === 'http' || t === 'sse' || t === 'ws' || t === 'stdio' || t === 'sdk' || t === 'claudeai-proxy' ? t : 'other';
}

export function rowOf(s: McpServerStatus, busy: Action | null = null): McpRow {
  const kind = kindOf(s);
  return { name: s.name, status: s.status, kind, scope: s.scope ?? null, signIn: REMOTE.includes(kind), reconnect: kind !== 'sdk' && s.status !== 'disabled', busy };
}

// One sentence from what a CLI or a control call said: its last line, the first sentence of it.
export function sentence(text: string): string {
  const lines = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines.pop() ?? '';
  const m = /^(.+?[.!?])(\s|$)/.exec(last);
  const s = (m ? m[1] : last).slice(0, 200);
  return s && !/[.!?]$/.test(s) ? s + '.' : s;
}

const VERB: Record<Action, string> = { login: 'Sign-in to', logout: 'Sign-out from', reconnect: 'Reconnecting', enable: 'Enabling', disable: 'Disabling' };
const failed = (a: Action, name: string, why: string) => `${VERB[a]} ${name} failed${why ? `: ${why.replace(/\.$/, '')}` : ''}.`;

export class Mcp {
  private d: McpDeps;
  private log: Log;
  private panels = new Map<string, Panel>();
  private aborts = new Set<AbortController>();

  constructor(d: McpDeps) {
    this.d = d;
    this.log = d.log ?? nullLog;
  }

  // The page opened the panel, or asks again: the rows, read now.
  async list(t: McpTarget): Promise<void> {
    const p = this.panel(t.id);
    if (t.terminal) { p.note = TERMINAL_NOTE; p.rows = []; this.publish(t.id); return; }
    p.note = null;
    p.error = null;
    await this.refresh(t, p);
  }

  // One action on one server. The ack is ok once it ran (its error shows in the panel); a refusal
  // (a terminal holds it, the server is busy) is the ack's error.
  async act(t: McpTarget, name: string, action: Action): Promise<Result> {
    if (t.terminal) return { ok: false, error: TERMINAL_NOTE };
    if (!MCP_ACTIONS.includes(action)) return { ok: false, error: 'Synopia doesn\'t know that MCP action.' };
    const p = this.panel(t.id);
    if (p.busy.has(name)) return { ok: false, error: `${name} is still busy. Wait for it to finish.` };
    p.busy.set(name, action);
    p.error = null;
    p.note = null;
    this.publish(t.id);
    this.log('mcp.action', { sid: t.id, action });
    try {
      p.error = await this.run(t, p, name, action);
    } catch (e) {
      p.error = failed(action, name, sentence(String((e as Error)?.message ?? e)));
    } finally {
      p.busy.delete(name);
    }
    if (p.error) this.log('mcp.failed', { sid: t.id, action });
    await this.refresh(t, p);
    return { ok: true };
  }

  // The session closed: its probe and panel go.
  forget(sid: string): void {
    const p = this.panels.get(sid);
    if (!p) return;
    this.closeProbe(p);
    this.panels.delete(sid);
  }

  stop(): void {
    for (const a of this.aborts) a.abort();
    for (const sid of [...this.panels.keys()]) this.forget(sid);
  }

  // what the page is sent
  frame(sid: string): object {
    const p = this.panel(sid);
    return { t: 'mcp', sid, servers: p.rows.map((r) => ({ ...r, busy: p.busy.get(r.name) ?? null })), error: p.error, note: p.note, reading: p.reading };
  }

  private publish(sid: string): void {
    this.d.send(this.frame(sid));
  }

  private panel(sid: string): Panel {
    let p = this.panels.get(sid);
    if (!p) this.panels.set(sid, p = { rows: [], busy: new Map(), error: null, note: null, reading: false, probe: null, probeCwd: '', idle: null, fresh: true, seq: 0 });
    return p;
  }

  // The session's own process, else this panel's probe in its folder.
  private control(t: McpTarget, p: Panel): McpControl | null {
    const own = t.control();
    if (own) {
      if (p.probe) { this.closeProbe(p); p.fresh = true; }
      return own;
    }
    if (!p.probe || p.probeCwd !== t.cwd) {
      this.closeProbe(p);
      p.probe = this.d.probe(t.cwd);
      p.probeCwd = t.cwd;
      p.fresh = true;
    }
    if (p.idle) clearTimeout(p.idle);
    p.idle = setTimeout(() => { p.idle = null; this.closeProbe(p); }, this.d.probeIdleMs ?? PROBE_IDLE_MS);
    p.idle.unref?.();
    return p.probe.control;
  }

  private closeProbe(p: Panel): void {
    if (p.idle) clearTimeout(p.idle);
    p.idle = null;
    p.probe?.close();
    p.probe = null;
  }

  // Reads the status; again while a server connects, or while a fresh source answers with none yet.
  private async refresh(t: McpTarget, p: Panel): Promise<void> {
    const seq = ++p.seq;
    p.reading = true;
    this.publish(t.id);
    const ms = this.d.settleMs ?? SETTLE_MS;
    for (let i = 0; i < SETTLE_TRIES; i++) {
      const c = this.control(t, p);
      if (!c) { p.error = NO_CONTROL; break; }
      let list: McpServerStatus[];
      try {
        list = await c.mcpServerStatus();
      } catch {
        p.error = NO_CONTROL;
        break;
      }
      if (seq !== p.seq) return; // a newer read runs
      const waitMore = (p.fresh && !list.length) || list.some((s) => s.status === 'pending');
      if (list.length) p.fresh = false;
      p.rows = list.filter((s) => s && typeof s.name === 'string').map((s) => rowOf(s)).sort((a, b) => a.name.localeCompare(b.name));
      if (!waitMore || i === SETTLE_TRIES - 1) break;
      this.publish(t.id);
      await new Promise((r) => setTimeout(r, ms));
      if (seq !== p.seq) return;
    }
    p.fresh = false;
    p.reading = false;
    this.publish(t.id);
  }

  // The action; its error sentence, or null.
  private async run(t: McpTarget, p: Panel, name: string, action: Action): Promise<string | null> {
    if (action === 'login' || action === 'logout') {
      const r = await this.cli(['mcp', action, name], t.cwd, action === 'login' ? this.d.loginTimeoutMs ?? LOGIN_TIMEOUT_MS : CLI_TIMEOUT_MS);
      if (r.timedOut) return action === 'login' ? `The sign-in to ${name} didn't finish within ${Math.round((this.d.loginTimeoutMs ?? LOGIN_TIMEOUT_MS) / 60_000)} minutes.` : failed(action, name, 'the CLI didn\'t answer');
      if (r.code !== 0) return failed(action, name, sentence(r.stderr || r.stdout) || `the CLI ended with code ${r.code}`);
      // the running session picks the new credentials up on a reconnect (logout too: it drops the old ones)
      const c = this.control(t, p);
      try {
        await c?.reconnectMcpServer(name);
      } catch (e) {
        if (action === 'login') return `Signed in, but ${name} didn't reconnect: ${sentence(String((e as Error)?.message ?? e)).replace(/\.$/, '')}.`;
      }
      return null;
    }
    const c = this.control(t, p);
    if (!c) return NO_CONTROL;
    if (action === 'reconnect') await c.reconnectMcpServer(name);
    else await c.toggleMcpServer(name, action === 'enable');
    return null;
  }

  private async cli(args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
    const ac = new AbortController();
    this.aborts.add(ac);
    try {
      return await this.d.runner(args, { cwd, timeoutMs, signal: ac.signal });
    } finally {
      this.aborts.delete(ac);
    }
  }
}

// The real runner: the bundled CLI, no TTY (stdin closed), its output kept in memory for the
// error sentence and never logged. Killed at the timeout or on abort.
export const cliRunner: McpRunner = (args, o) => new Promise((resolve) => {
  const cli = bundledCli();
  if (!cli) { resolve({ code: 127, stdout: '', stderr: 'Synopia can\'t find the Claude Code CLI that came with the Agent SDK.' }); return; }
  let stdout = '', stderr = '', timedOut = false;
  const p = spawn(cli, args, { cwd: o.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => { if (stdout.length < OUT_CAP) stdout += d; });
  p.stderr.on('data', (d) => { if (stderr.length < OUT_CAP) stderr += d; });
  const kill = () => { try { p.kill('SIGTERM'); } catch { /* gone */ } };
  const timer = setTimeout(() => { timedOut = true; kill(); }, o.timeoutMs);
  o.signal.addEventListener('abort', kill, { once: true });
  p.on('error', (e) => { stderr += String(e.message); });
  p.on('close', (code) => { clearTimeout(timer); o.signal.removeEventListener('abort', kill); resolve({ code, stdout, stderr, timedOut }); });
});
