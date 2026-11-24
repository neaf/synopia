// The Claude Agent SDK adapter: the only value import of @anthropic-ai/claude-agent-sdk. Every
// option Synopia passes, every control call and every untyped extension sits here, with the facts
// in docs/Agent SDK.md. The rest of the backend imports SDK types only.
// - A session's process (SessionProcess): one `query()` fed by an async-iterable input queue, so
//   messages pushed before system/init and during a turn reach the CLI in order. Its stderr is kept
//   in memory (the last 20 lines) for the failure toast, never logged.
// - The menu: commands and models from a running process or an idle probe, filtered and unescaped.
// - The writer's one-shot call, and listSessions().
// - The content of a message you send, with its `[Image #N]` tags and images.
// `query` and `listSessions` are injectable as one Sdk pair: tests pass a fake, dev a script.
import { query as sdkQuery, listSessions as sdkListSessions } from '@anthropic-ai/claude-agent-sdk';
import type {
  CanUseTool, EffortLevel, ListSessionsOptions, ModelInfo, Options, PermissionUpdate, SDKControlInterruptResponse,
  SDKMessage, SDKSessionInfo, SDKUserMessage, SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';

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
  model?: string;
  effort?: string;
  plan?: boolean; // the session's last permission-mode record is `plan`
  allowedTools?: string[];
};

export type ProcessEvents = {
  onMessage: (m: SDKMessage) => void;
  // The message stream ended: `error` is null for a clean end. `ended` says whether end() or close() asked for it.
  onExit: (error: Error | null, ended: boolean) => void;
  // Parks the request until its card is answered or its signal aborts (pending.ts). Never null.
  canUseTool: CanUseTool;
  // A message went into the input queue (status.ts counts the ones sent during a turn as queued).
  onPush?: (uuid: string) => void;
};

// What an interrupt did: the texts of the messages it cancelled (they go back to the message
// box) and how many of our queued messages still run, as the SDK lists them.
export type InterruptResult = { cancelQueued: boolean; restored: string[]; stillQueued: number };

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
  if (o.model) opts.model = o.model;
  if (o.effort && EFFORTS.includes(o.effort)) opts.effort = o.effort as EffortLevel;
  if (o.plan) opts.permissionMode = 'plan';
  if (o.allowedTools?.length) opts.allowedTools = [...o.allowedTools];
  return opts;
}

export class SessionProcess {
  readonly input = new InputQueue();
  private q: QueryLike;
  private events: ProcessEvents;
  private stderr: string[] = [];
  private partial = '';
  private ended = false;
  private sent = new Map<string, string>();
  capabilities: string[] = []; // from system/init
  done = false;

  constructor(start: StartOptions, events: ProcessEvents, queryFn: QueryFn = realSdk.query) {
    this.events = events;
    const options = buildOptions(start, (name, input, o) => this.events.canUseTool(name, input, o), (d) => this.keepStderr(d));
    this.q = queryFn({ prompt: this.input, options });
    void this.read();
  }

  push(content: Content, uuid: string): void {
    const text = typeof content === 'string' ? content
      : content.map((b) => (b.type === 'text' ? b.text : '')).filter(Boolean).join('\n');
    this.sent.set(uuid, text);
    if (this.sent.size > KEEP_SENT) this.sent.delete(this.sent.keys().next().value as string);
    this.input.push(userMessage(content, uuid));
    this.events.onPush?.(uuid);
  }

  // Bash mode (bang.ts): context for Claude that starts no turn (docs/Agent SDK.md, "Streaming input
  // and control calls": `shouldQuery: false`). Not counted as queued, and an interrupt has nothing
  // of it to give back.
  pushQuiet(text: string, uuid: string): void {
    this.input.push({ ...userMessage(text, uuid), shouldQuery: false });
  }

  // Interrupts the foreground turn (perTaskStopAffordance spares background work). With the
  // capability, queued messages are cancelled too and their texts come back
  // (docs/Agent SDK.md, "Quirk: interrupt() takes no argument in the typings").
  async interrupt(): Promise<InterruptResult> {
    const cancelQueued = this.capabilities.includes(CANCEL_QUEUED);
    const r = await this.q.interrupt?.(cancelQueued ? { cancelQueued: true } : undefined);
    const restored = (r?.cancelled ?? []).map((u) => this.sent.get(u) ?? '').filter((t) => t.trim());
    return { cancelQueued, restored, stillQueued: (r?.still_queued ?? []).filter((u) => this.sent.has(u)).length };
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
        this.events.onMessage(m);
      }
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
    }
    this.done = true;
    this.input.end();
    this.events.onExit(error, this.ended);
  }

  // The slash menu and the model list from this process, while it runs.
  menuSource(): MenuSource | null {
    const q = this.q;
    if (this.done || !q.supportedCommands || !q.supportedModels) return null;
    return { supportedCommands: () => (q.supportedCommands as () => Promise<SlashCommand[]>)(), supportedModels: () => (q.supportedModels as () => Promise<ModelInfo[]>)() };
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
  // in the terminal (the typed Query.backgroundTasks, no tool use id). Throws when the session has
  // background tasks turned off (docs/Agent SDK.md, "backgroundTasks() and the 2 s gap").
  async backgroundTasks(): Promise<boolean> {
    if (this.done || !this.q.backgroundTasks) throw new Error('no running process');
    return this.q.backgroundTasks();
  }
}

// Plan approval: the allow result sets the mode back to the one before plan mode, as approving
// ExitPlanMode doesn't (docs/Agent SDK.md, "Quirk: plan approval needs an explicit mode").
export function planApproval(modeBefore: string): PermissionUpdate[] {
  return [{ type: 'setMode', mode: (modeBefore || 'auto') as 'auto', destination: 'session' }];
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

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_TYPES = ['image/png', 'image/jpeg'];
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

// Why these images can't be sent, or null. The page sends base64 from a data URL: empty or broken
// data is refused here, before the CLI would fail the whole message.
export function imageError(images: Image[]): string | null {
  for (const im of images) {
    if (!IMAGE_TYPES.includes(im.mediaType)) return 'Only PNG and JPEG images can be sent.';
    if (!im.data || im.data.length % 4 !== 0 || !BASE64.test(im.data)) return 'An image is empty or damaged. Paste it again.';
    if (Buffer.byteLength(im.data, 'base64') > MAX_IMAGE_BYTES) return 'An image is over 5 MB. Send a smaller one.';
  }
  return null;
}

const tagOf = (n: number) => `[Image #${n}]`;

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
