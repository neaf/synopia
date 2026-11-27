// The Claude Agent SDK adapter: the only value import of @anthropic-ai/claude-agent-sdk. Every
// option Synopia passes, every control call and every untyped extension sits here, with the facts
// in docs/Agent SDK.md. The rest of the backend imports SDK types only.
// - A session's process (SessionProcess): one `query()` fed by an async-iterable input queue, so
//   messages pushed before system/init and during a turn reach the CLI in order. Its stderr is kept
//   in memory (the last 20 lines) for the failure toast, never logged.
// - The menu: commands and models from a running process or an idle probe, filtered and unescaped.
// - The writer's one-shot call, and listSessions().
// - The content of a message you send, with its `[Image #N]` tags and images.
// - Synopia's in-process tool server for its sessions (agent-tools.ts defines the tools).
// - The MCP control calls (mcpServerStatus, reconnectMcpServer, toggleMcpServer) of a process or of an
//   idle probe, and the path of the bundled CLI that mcp.ts runs `claude mcp login|logout` with.
// - A folder's `awsAuthRefresh` setting (resolveSettings), creds.ts's first guess at its refresh command.
// `query` and `listSessions` are injectable as one Sdk pair: tests pass a fake, dev a script.
import { query as sdkQuery, listSessions as sdkListSessions, createSdkMcpServer, tool as sdkTool, resolveSettings } from '@anthropic-ai/claude-agent-sdk';
import type {
  CanUseTool, EffortLevel, ListSessionsOptions, McpSdkServerConfigWithInstance, McpServerStatus, ModelInfo, Options, PermissionUpdate,
  SDKControlInterruptResponse, SDKMessage, SDKSessionInfo, SDKUserMessage, SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import type { ZodRawShape } from 'zod';
import { createRequire } from 'node:module';
import { MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES, IMAGE_TYPES } from '../../web/js/protocol.js';

// The part of the SDK's Query that Synopia uses. `interrupt` takes `{cancelQueued}`, which the
// typings don't list (docs/Agent SDK.md, "Quirk: interrupt() takes no argument in the typings").
// The control calls are optional so a fake can leave out what a test doesn't need.
export type QueryLike = AsyncIterable<SDKMessage> & {
  close?: () => void;
  interrupt?: (req?: { cancelQueued?: boolean }) => Promise<SDKControlInterruptResponse | undefined>;
  supportedCommands?: () => Promise<SlashCommand[]>;
  supportedModels?: () => Promise<ModelInfo[]>;
  setModel?: (model?: string) => Promise<void>;
  applyFlagSettings?: (settings: { effortLevel?: EffortLevel | null }) => Promise<void>;
  backgroundTasks?: (toolUseId?: string) => Promise<boolean>;
  stopTask?: (taskId: string) => Promise<void>;
  mcpServerStatus?: () => Promise<McpServerStatus[]>;
  reconnectMcpServer?: (name: string) => Promise<void>;
  toggleMcpServer?: (name: string, enabled: boolean) => Promise<void>;
};
export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => QueryLike;
export type ListFn = (opts?: ListSessionsOptions) => Promise<SDKSessionInfo[]>;
export type Sdk = { query: QueryFn; listSessions: ListFn };
export type Content = SDKUserMessage['message']['content'];

// The real SDK. The cast is the untyped `interrupt({cancelQueued})` of QueryLike.
export const realSdk: Sdk = { query: sdkQuery as unknown as QueryFn, listSessions: sdkListSessions };

// docs/Agent SDK.md, "State events need an undocumented flag".
export const STATE_FLAG = 'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS';
export const STDERR_LINES = 20;
export const CANCEL_QUEUED = 'interrupt_cancel_queued_v1';
const KEEP_SENT = 100; // texts kept by uuid, so cancelled messages can go back to the box
export const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

// ---------- a session's process ----------

export type StartOptions = {
  cwd: string;
  resume?: string;
  // With resume: a new session id with the whole history, in `cwd` (a gone folder's session continued
  // elsewhere, docs/Agent SDK.md "Resume and fork in another folder").
  fork?: boolean;
  model?: string;
  effort?: string;
  plan?: boolean; // the session's last permission-mode record is `plan`
  allowedTools?: string[];
  // Synopia's tools for agents (agent-tools.ts): a fresh server per process, by its key in mcpServers.
  mcpServers?: Record<string, McpSdkServerConfigWithInstance>;
  // A new session's title (Options.title: the CLI writes it as the session's custom-title record).
  title?: string;
};

export type ProcessEvents = {
  onMessage: (m: SDKMessage) => void;
  // The message stream ended: `error` is null for a clean end. `ended` says whether end() or close() asked for it.
  onExit: (error: Error | null, ended: boolean) => void;
  // Parks the request until its card is answered or its signal aborts (cards.ts). Never null.
  canUseTool: CanUseTool;
  // A message went into the input queue (status.ts counts the ones sent during a turn as queued).
  onPush?: (uuid: string) => void;
  // onMessage or onExit threw: the stream reads on (one odd message doesn't end a live session).
  onError?: (where: 'message' | 'exit', e: unknown, m?: SDKMessage) => void;
};

// A message that goes back to the message box: its text and the pasted images it carried.
export type Returned = { text: string; images: Image[] };
// What an interrupt did: the messages it cancelled (they go back to the message box) and how many
// of our queued messages still run, as the SDK lists them.
// `bangs`: the `!` command turns it cancelled (pushBang), their texts and uuids.
export type InterruptResult = { cancelQueued: boolean; restored: Returned[]; stillQueued: number; bangs?: { text: string; uuid: string }[] };

// The menu calls of a query: a running process's, or the idle probe's.
export type MenuSource = { supportedCommands(): Promise<SlashCommand[]>; supportedModels(): Promise<ModelInfo[]> };

// Control calls need streaming input, so the prompt is always this queue (docs/Agent SDK.md,
// "Streaming input and control calls").
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private buf: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private done = false;

  push(m: SDKUserMessage): void {
    if (this.done) return;
    this.buf.push(m);
    this.wake?.();
    this.wake = null;
  }

  end(): void {
    this.done = true;
    this.wake?.();
    this.wake = null;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.buf.length) yield this.buf.shift() as SDKUserMessage;
      if (this.done) return;
      await new Promise<void>((r) => (this.wake = r));
    }
  }
}

export function userMessage(content: Content, uuid: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, uuid: uuid as SDKUserMessage['uuid'] };
}

// The start options (docs/Agent SDK.md, "Options Synopia passes"): permissionMode unset so your own
// setting applies, except plan; settingSources at its default; `env` replaces the environment, so
// the state flag goes on top of the inherited one. bashEditDiffEnabled: without it an SDK-driven
// CLI writes no `bashEditDiff` (docs/Claude Code transcripts.md).
export function buildOptions(o: StartOptions, canUseTool: CanUseTool, stderr: (data: string) => void): Options {
  const opts: Options = {
    cwd: o.cwd,
    canUseTool,
    includePartialMessages: true,
    perTaskStopAffordance: true,
    settings: { bashEditDiffEnabled: true },
    env: { ...process.env, [STATE_FLAG]: '1' },
    stderr,
  };
  if (o.resume) opts.resume = o.resume;
  if (o.resume && o.fork) opts.forkSession = true;
  if (o.model) opts.model = o.model;
  if (o.effort && EFFORTS.includes(o.effort)) opts.effort = o.effort as EffortLevel;
  if (o.plan) opts.permissionMode = 'plan';
  if (o.allowedTools?.length) opts.allowedTools = [...o.allowedTools];
  if (o.mcpServers && Object.keys(o.mcpServers).length) opts.mcpServers = { ...o.mcpServers };
  if (o.title && !o.resume) opts.title = o.title;
  return opts;
}

export class SessionProcess {
  readonly input = new InputQueue();
  private q: QueryLike;
  private events: ProcessEvents;
  private stderr: string[] = [];
  private partial = '';
  private ended = false;
  private sent = new Map<string, Returned>();
  private bangSent = new Map<string, string>(); // pushBang's texts by uuid, so a cancelled one still goes to Claude
  capabilities: string[] = []; // from system/init
  done = false;

  constructor(start: StartOptions, events: ProcessEvents, queryFn: QueryFn = realSdk.query) {
    this.events = events;
    const options = buildOptions(start, (name, input, o) => this.events.canUseTool(name, input, o), (d) => this.keepStderr(d));
    this.q = queryFn({ prompt: this.input, options });
    void this.read();
  }

  // `images`: the pasted images the content carries, as the page sent them (an interrupt gives them back).
  // `now`: f, f with nothing queued (R9.8): `priority: 'now'` with a human origin, so the CLI moves
  // what can go to the background, or interrupts the reply (docs/Agent SDK.md, "Sending queued messages now").
  push(content: Content, uuid: string, images: Image[] = [], now = false): void {
    const text = typeof content === 'string' ? content
      : content.map((b) => (b.type === 'text' ? b.text : '')).filter(Boolean).join('\n');
    this.sent.set(uuid, { text, images });
    if (this.sent.size > KEEP_SENT) this.sent.delete(this.sent.keys().next().value as string);
    this.input.push(now ? { ...userMessage(content, uuid), priority: 'now', origin: { kind: 'human' } } : userMessage(content, uuid));
    this.events.onPush?.(uuid);
  }

  // Bash mode (R5.13, 2026-11-27): a `!` command's input and output as one message that starts a turn,
  // or waits in the running one's queue as your message does (counted as queued). `client_composed`: the
  // CLI takes its text as written, with no `@path` expansion and no slash command (docs/Agent SDK.md, "A
  // `!` command's end as a turn"). An interrupt hands a cancelled one back in `bangs`, never to the box.
  pushBang(text: string, uuid: string): void {
    this.bangSent.set(uuid, text);
    if (this.bangSent.size > KEEP_SENT) this.bangSent.delete(this.bangSent.keys().next().value as string);
    this.input.push({ ...userMessage(text, uuid), client_composed: true });
    this.events.onPush?.(uuid);
  }

  // Context for Claude that starts no turn (docs/Agent SDK.md, "Streaming input and control calls":
  // `shouldQuery: false`). Not counted as queued, and an interrupt has nothing of it to give back.
  pushQuiet(text: string, uuid: string): void {
    this.input.push({ ...userMessage(text, uuid), shouldQuery: false });
  }

  // Interrupts the foreground turn (perTaskStopAffordance spares background work). With the
  // capability, queued messages are cancelled too and their texts come back
  // (docs/Agent SDK.md, "Quirk: interrupt() takes no argument in the typings").
  async interrupt(): Promise<InterruptResult> {
    const cancelQueued = this.capabilities.includes(CANCEL_QUEUED);
    const r = await this.q.interrupt?.(cancelQueued ? { cancelQueued: true } : undefined);
    const restored = (r?.cancelled ?? []).map((u) => this.sent.get(u)).filter((m): m is Returned => Boolean(m && (m.text.trim() || m.images.length)));
    const bangs = (r?.cancelled ?? []).flatMap((u) => { const text = this.bangSent.get(u); return text === undefined ? [] : [{ text, uuid: u }]; });
    return { cancelQueued, restored, stillQueued: (r?.still_queued ?? []).filter((u) => this.sent.has(u)).length, ...(bangs.length ? { bangs } : {}) };
  }

  // f, f with messages queued and nothing that can move (R9.8): the plain interrupt, without
  // cancelQueued, so the queued messages stay and run next, in order (docs/Agent SDK.md, "Sending
  // queued messages now").
  async interruptKeepingQueue(): Promise<void> {
    if (this.done || !this.q.interrupt) throw new Error('no running process');
    await this.q.interrupt();
  }

  // Its input is closed (end or close): a push is dropped, so the caller waits for the exit.
  get ending(): boolean {
    return this.ended;
  }

  // Lets the process end once its turn is over (the input closes).
  end(): void {
    this.ended = true;
    this.input.end();
  }

  // Ends it now (quit).
  close(): void {
    this.ended = true;
    this.input.end();
    try {
      this.q.close?.();
    } catch {
      /* already gone */
    }
  }

  stderrTail(): string[] {
    return this.partial ? [...this.stderr, this.partial].slice(-STDERR_LINES) : [...this.stderr];
  }

  private keepStderr(data: string): void {
    const lines = (this.partial + data).split('\n');
    this.partial = lines.pop() ?? '';
    for (const l of lines) if (l.trim()) this.stderr.push(l);
    if (this.stderr.length > STDERR_LINES) this.stderr.splice(0, this.stderr.length - STDERR_LINES);
  }

  private async read(): Promise<void> {
    let error: Error | null = null;
    try {
      for await (const m of this.q) {
        const s = m as { type: string; subtype?: string; capabilities?: unknown };
        if (s.type === 'system' && s.subtype === 'init' && Array.isArray(s.capabilities)) {
          this.capabilities = s.capabilities.filter((c): c is string => typeof c === 'string');
        }
        try {
          this.events.onMessage(m);
        } catch (e) {
          this.events.onError?.('message', e, m);
        }
      }
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
    }
    this.done = true;
    this.input.end();
    try {
      this.events.onExit(error, this.ended);
    } catch (e) {
      this.events.onError?.('exit', e);
    }
  }

  // The slash menu and the model list from this process, while it runs.
  menuSource(): MenuSource | null {
    const q = this.q;
    if (this.done || !q.supportedCommands || !q.supportedModels) return null;
    return { supportedCommands: () => (q.supportedCommands as () => Promise<SlashCommand[]>)(), supportedModels: () => (q.supportedModels as () => Promise<ModelInfo[]>)() };
  }

  // The MCP control calls of this process, while it runs (mcp.ts).
  mcpControl(): McpControl | null {
    return this.done ? null : mcpControlOf(this.q);
  }

  // The model for the next responses (undefined: the default), and the effort (null: the model's
  // default), through the typed setModel and applyFlagSettings.
  async setModel(model: string | undefined): Promise<void> {
    if (this.done || !this.q.setModel) throw new Error('no running process');
    await this.q.setModel(model);
  }

  async setEffort(effort: string | null): Promise<void> {
    if (this.done || !this.q.applyFlagSettings) throw new Error('no running process');
    await this.q.applyFlagSettings({ effortLevel: effort && EFFORTS.includes(effort) ? effort as EffortLevel : null });
  }

  // b, b (R9): every foreground Bash and subagent in flight goes to the background, as Ctrl+B does
  // in the terminal (the typed Query.backgroundTasks, no tool use id). f, f (R9.8) passes one main
  // step's tool use id, which moves only that step (false: it matched no foreground task). Throws
  // when the session has background tasks turned off (docs/Agent SDK.md, "backgroundTasks() and the 2 s gap").
  async backgroundTasks(toolUseId?: string): Promise<boolean> {
    if (this.done || !this.q.backgroundTasks) throw new Error('no running process');
    return toolUseId ? this.q.backgroundTasks(toolUseId) : this.q.backgroundTasks();
  }

  // Esc, Esc in a background shell's or monitor's shell view (R9.4, 2026-11-26): the typed Query.stopTask.
  // Its task_notification `stopped` follows at once (docs/Agent SDK.md, "stopTask").
  async stopTask(taskId: string): Promise<void> {
    if (this.done || !this.q.stopTask) throw new Error('no running process');
    await this.q.stopTask(taskId);
  }
}

// Plan approval: the allow result sets the mode back to the one before plan mode, as approving
// ExitPlanMode doesn't (docs/Agent SDK.md, "Quirk: plan approval needs an explicit mode").
export function planApproval(modeBefore: string): PermissionUpdate[] {
  return [{ type: 'setMode', mode: (modeBefore || 'auto') as 'auto', destination: 'session' }];
}

// ---------- Synopia's tools for agents ----------

// One tool as agent-tools.ts defines it: the model reads `description` and `input` (a zod shape).
export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
export type ToolDef = {
  name: string; description: string; input: ZodRawShape;
  run: (args: Record<string, unknown>) => Promise<ToolResult>;
};

// The in-process MCP server (docs/Agent SDK.md, "Synopia's tools for agents"): the model sees each tool
// as `mcp__<name>__<tool>`, with its full schema from the first turn (`alwaysLoad`, no tool search).
// Every tool is `always_ask` with `destructiveHint`, so each call reaches canUseTool (the card):
// neither an allow rule nor auto mode's classifier approves it in Synopia's place. Live run TL-1.
export function toolServer(name: string, version: string, tools: ToolDef[]): McpSdkServerConfigWithInstance {
  const srv = createSdkMcpServer({
    name, version, alwaysLoad: true,
    tools: tools.map((t) => sdkTool(t.name, t.description, t.input, (args) => t.run(args as Record<string, unknown>), { annotations: { destructiveHint: true } })),
  });
  return { ...srv, tools: tools.map((t) => ({ name: t.name, permission_policy: 'always_ask' as const })) };
}

// ---------- the menu ----------

export type MenuCommand = { name: string; description: string; hint: string };
export type MenuModel = { value: string; resolved: string | null; name: string; description: string; effort: string[] };
export type FolderMenu = { commands: MenuCommand[]; models: MenuModel[] };

export const PROBE_TIMEOUT_MS = 30_000;

// Commands that are listed but can't run in a session Synopia drives (docs/Agent SDK.md,
// "Command and model list shapes"): `__` names are internal, workflow-launch-exec runs server-side only.
const HIDDEN_COMMANDS = new Set(['workflow-launch-exec']);

// The descriptions come HTML-escaped: `&lt;file&gt;` (docs/Agent SDK.md, "Quirk: command descriptions come HTML-escaped").
export function unescapeHtml(s: string): string {
  return s.replace(/&(lt|gt|quot|#39|apos|amp);/g, (_, e: string) => ({ lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", amp: '&' })[e] as string);
}

// One row per name, sorted by the page; a row Claude Code marks as its own wins a shared name,
// as /name runs that one. Internal and server-only names are left out.
export function toCommands(list: SlashCommand[]): MenuCommand[] {
  const byName = new Map<string, SlashCommand>();
  for (const c of list) {
    if (!c || typeof c.name !== 'string' || !c.name || c.name.startsWith('__') || HIDDEN_COMMANDS.has(c.name)) continue;
    const had = byName.get(c.name);
    if (!had || (c.builtin && !had.builtin)) byName.set(c.name, c);
  }
  return [...byName.values()].map((c) => ({
    name: c.name, description: unescapeHtml(c.description || ''), hint: unescapeHtml(c.argumentHint || ''),
  }));
}

export function toModels(list: ModelInfo[]): MenuModel[] {
  return list.filter((m) => m && typeof m.value === 'string').map((m) => ({
    value: m.value, resolved: m.resolvedModel ?? null, name: m.displayName || m.value,
    description: unescapeHtml(m.description || ''), effort: [...(m.supportedEffortLevels ?? [])],
  }));
}

// Rejects with Error('timeout') after `timeoutMs`, or Error('aborted') when `signal` aborts.
export async function readMenu(src: MenuSource, timeoutMs: number, signal?: AbortSignal): Promise<FolderMenu> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort = () => {};
  const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), timeoutMs); });
  const aborted = new Promise<never>((_, rej) => {
    onAbort = () => rej(new Error('aborted'));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const [commands, models] = await Promise.race([Promise.all([src.supportedCommands(), src.supportedModels()]), timeout, aborted]);
    return { commands: toCommands(commands ?? []), models: toModels(models ?? []) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// A prompt that never yields: the process starts, answers control calls and makes no model call.
function idlePrompt(stop: Promise<void>): AsyncIterable<SDKUserMessage> {
  return { async *[Symbol.asyncIterator]() { await stop; } };
}

// The menu of a folder with no running process: one idle query, closed once read or on timeout
// (docs/Agent SDK.md, "Menu: commands and models"). It runs the folder's SessionStart hooks.
export async function probeMenu(query: QueryFn, cwd: string, opts: { timeoutMs?: number; abortController: AbortController }): Promise<FolderMenu> {
  let release = () => {};
  const stop = new Promise<void>((r) => (release = r));
  let q: QueryLike | null = null;
  try {
    q = query({ prompt: idlePrompt(stop), options: { cwd, abortController: opts.abortController } });
    if (!q.supportedCommands || !q.supportedModels) throw new Error('no menu calls');
    return await readMenu(q as MenuSource, opts.timeoutMs ?? PROBE_TIMEOUT_MS, opts.abortController.signal);
  } finally {
    release();
    try { q?.close?.(); } catch { /* already gone */ }
  }
}

// ---------- MCP servers (mcp.ts; docs/Agent SDK.md, "MCP servers: status, sign-in") ----------

export type McpControl = {
  mcpServerStatus(): Promise<McpServerStatus[]>;
  reconnectMcpServer(name: string): Promise<void>;
  toggleMcpServer(name: string, enabled: boolean): Promise<void>;
};

export function mcpControlOf(q: QueryLike): McpControl | null {
  const { mcpServerStatus, reconnectMcpServer, toggleMcpServer } = q;
  if (!mcpServerStatus || !reconnectMcpServer || !toggleMcpServer) return null;
  return {
    mcpServerStatus: () => mcpServerStatus.call(q),
    reconnectMcpServer: (name) => reconnectMcpServer.call(q, name),
    toggleMcpServer: (name, on) => toggleMcpServer.call(q, name, on),
  };
}

// The MCP servers of a folder with no running process: one idle query, as the menu probe's, open
// until close(). It runs the folder's SessionStart hooks.
export function mcpProbe(query: QueryFn, cwd: string): { control: McpControl | null; close: () => void } {
  let release = () => {};
  const stop = new Promise<void>((r) => (release = r));
  const abortController = new AbortController();
  const q = query({ prompt: idlePrompt(stop), options: { cwd, abortController } });
  void (async () => { try { for await (const _ of q) { /* an idle query yields nothing to read */ } } catch { /* closed */ } })();
  return { control: mcpControlOf(q), close: () => { release(); try { q.close?.(); } catch { /* already gone */ } abortController.abort(); } };
}

// The CLI the SDK runs, from its platform package (the SDK's optional dependency for this
// machine), for `claude mcp login|logout`. Null when it isn't installed.
export function bundledCli(): string | null {
  try {
    return createRequire(import.meta.url).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);
  } catch {
    return null;
  }
}

// ---------- a folder's awsAuthRefresh ----------

// The `awsAuthRefresh` the CLI would read in `cwd` from the user, project and local settings files only
// (resolveSettings, the CLI's own merge; `sources` low to high, so the last that sets it wins), or ''.
// Managed and flag settings aren't asked: the value only prefills the line you confirm (creds.ts).
export async function awsAuthRefreshOf(cwd: string): Promise<string> {
  try {
    const r = await resolveSettings({ cwd, settingSources: ['user', 'project', 'local'] });
    let v = '';
    for (const src of r.sources) {
      if (src.source !== 'user' && src.source !== 'project' && src.source !== 'local') continue;
      const x = (src.settings as { awsAuthRefresh?: unknown }).awsAuthRefresh;
      if (typeof x === 'string' && x.trim()) v = x.trim();
    }
    return v;
  } catch {
    return '';
  }
}

// ---------- the writer's one-shot call ----------

// Nothing the call could act with, and nothing written to disk (docs/Agent SDK.md, "The writer's isolated call").
export function writerOptions(model: string, cwd: string, systemPrompt: string): Options {
  return {
    model,
    maxTurns: 1,
    tools: [],
    mcpServers: {},
    strictMcpConfig: true,
    permissionMode: 'dontAsk',
    settings: { disableAllHooks: true },
    systemPrompt,
    verbatimPrompts: true, // no @path expansion, slash commands or CLAUDE.md attachments
    persistSession: false,
    includeHookEvents: true, // so a hook that still runs (a managed one) shows in the log
    cwd,
  };
}

// What a one-shot call gave: the reply of a successful result, else `failure` names why: the
// result's subtype (`error_during_execution`, …), `error` for a success flagged is_error, or
// `noResult`. `apiError` is the last assistant message's error (authentication_failed, …).
// `hooks`: the events of hooks that still ran.
export type OneShot = { reply: string; failure: string | null; apiError: string | null; hooks: string[] };

async function* one(text: string): AsyncGenerator<SDKUserMessage> {
  yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

// Throws when the stream throws (an abort included).
export async function oneShot(query: QueryFn, text: string, options: Options): Promise<OneShot> {
  const out: OneShot = { reply: '', failure: 'noResult', apiError: null, hooks: [] };
  for await (const m of query({ prompt: one(text), options })) {
    if (m.type === 'system' && m.subtype === 'hook_started') out.hooks.push(String(m.hook_event));
    if (m.type === 'assistant' && m.error) out.apiError = String(m.error);
    if (m.type === 'result') {
      const ok = m.subtype === 'success' && !m.is_error;
      out.reply = m.subtype === 'success' && ok ? m.result : '';
      out.failure = ok ? null : m.subtype === 'success' ? 'error' : m.subtype;
    }
  }
  return out;
}

// ---------- the content of a message you send ----------

export type Image = { mediaType: string; data: string; n?: number };

// the caps (each image, and all of one message together) are the page's too (protocol.js)
export { MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES, IMAGE_TYPES };
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

// Why these images can't be sent, or null. The page sends base64 from a data URL: empty or broken
// data is refused here, before the CLI would fail the whole message.
export function imageError(images: Image[]): string | null {
  let total = 0;
  for (const im of images) {
    if (!IMAGE_TYPES.includes(im.mediaType)) return 'Only PNG and JPEG images can be sent.';
    if (!im.data || im.data.length % 4 !== 0 || !BASE64.test(im.data)) return 'An image is empty or damaged. Paste it again.';
    const bytes = Buffer.byteLength(im.data, 'base64');
    if (bytes > MAX_IMAGE_BYTES) return 'An image is over 5 MB. Send a smaller one.';
    total += bytes;
  }
  if (total > MAX_TOTAL_IMAGE_BYTES) return `These images are ${Math.ceil(total / 1048576)} MB together, over ${MAX_TOTAL_IMAGE_BYTES / 1048576} MB. Send fewer at a time.`;
  return null;
}

const tagOf = (n: number) => `[Image #${n}]`;

// The images of `images` that `content` (userContent's) carries: an image whose tag was deleted isn't.
export function imagesIn(content: Content, images: Image[]): Image[] {
  if (typeof content === 'string') return [];
  const sent = new Set(content.flatMap((b) => (b.type === 'image' && b.source.type === 'base64' ? [b.source.data] : [])));
  return images.filter((im) => sent.has(im.data));
}

// The text and the pasted images (R5.13), in the shape the Claude Code CLI writes for a prompt with
// pasted images: one text block with an `[Image #N]` tag at the caret of each paste, then the images
// in the order their tags appear (docs/Claude Code transcripts.md). An image whose tag is no longer
// in the text was deleted with it and is not sent; an image without a number (sent by an older page)
// goes after the tagged ones.
export function userContent(text: string, images: Image[]): Content {
  const at = new Map<Image, number>();
  for (const im of images) {
    const n = im.n;
    if (n === undefined) { at.set(im, text.length); continue; }
    if (!Number.isInteger(n) || n < 1) continue;
    const i = text.indexOf(tagOf(n));
    if (i >= 0 && ![...at.values()].includes(i)) at.set(im, i); // one image per tag
  }
  const sent = images.filter((im) => at.has(im)).sort((a, b) => (at.get(a) as number) - (at.get(b) as number));
  if (!sent.length) return text;
  return [
    ...(text.trim() ? [{ type: 'text' as const, text }] : []),
    ...sent.map((im) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: im.mediaType as 'image/png', data: im.data } })),
  ];
}
