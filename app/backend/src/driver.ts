// The session driver (plan section 6): one SDK `query()` per active session, fed by an
// async-iterable input queue (as in spike/chat.ts), so messages pushed before system/init
// and during a turn reach the CLI in order. The only module that imports the SDK's `query`.
// The process's stderr is kept in memory (the last 20 lines) for the failure toast, never logged.
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, EffortLevel, ModelInfo, Options, SDKControlInterruptResponse, SDKMessage, SDKUserMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk';

// The typed interrupt() takes no argument. On a CLI advertising CANCEL_QUEUED the driver passes
// {cancelQueued: true} (plan section 6), which the typings don't list: see .ai-notes "Facts to check".
export type QueryLike = AsyncIterable<SDKMessage> & {
  close?: () => void;
  interrupt?: (req?: { cancelQueued?: boolean }) => Promise<SDKControlInterruptResponse | undefined>;
  // Slice 5: the menu and the model of a running process (the typed Query methods).
  supportedCommands?: () => Promise<SlashCommand[]>;
  supportedModels?: () => Promise<ModelInfo[]>;
  setModel?: (model?: string) => Promise<void>;
  applyFlagSettings?: (settings: { effortLevel?: EffortLevel | null }) => Promise<void>;
  backgroundTasks?: (toolUseId?: string) => Promise<boolean>;
};
export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => QueryLike;
export type Content = SDKUserMessage['message']['content'];

export const STATE_FLAG = 'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS';
export const STDERR_LINES = 20;
export const CANCEL_QUEUED = 'interrupt_cancel_queued_v1';
const KEEP_SENT = 100; // texts kept by uuid, so cancelled messages can go back to the box
export const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

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

// The options of section 6: permissionMode unset (your own setting applies) except plan,
// settingSources at its default, the state flag added to the inherited environment.
// bashEditDiffEnabled: without it an SDK-driven CLI writes no `bashEditDiff` (files a shell command
// changed, for "Files changed"); it is off by default and only a flag setting turns it on everywhere.
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

  constructor(start: StartOptions, events: ProcessEvents, queryFn: QueryFn = sdkQuery as QueryFn) {
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

  // Interrupts the foreground turn (perTaskStopAffordance spares background work). With the
  // capability, queued messages are cancelled too and their texts come back.
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

  // Slice 5: the slash menu and the model list from this process, while it runs.
  menuSource(): { supportedCommands(): Promise<SlashCommand[]>; supportedModels(): Promise<ModelInfo[]> } | null {
    const q = this.q;
    if (this.done || !q.supportedCommands || !q.supportedModels) return null;
    return { supportedCommands: () => (q.supportedCommands as () => Promise<SlashCommand[]>)(), supportedModels: () => (q.supportedModels as () => Promise<ModelInfo[]>)() };
  }

  // Slice 5: the model for the next responses (undefined: the default), and the effort
  // (null: the model's default), through the typed setModel and applyFlagSettings.
  async setModel(model: string | undefined): Promise<void> {
    if (this.done || !this.q.setModel) throw new Error('no running process');
    await this.q.setModel(model);
  }

  async setEffort(effort: string | null): Promise<void> {
    if (this.done || !this.q.applyFlagSettings) throw new Error('no running process');
    await this.q.applyFlagSettings({ effortLevel: effort && EFFORTS.includes(effort) ? effort as EffortLevel : null });
  }

  // Slice 4: stops one background subagent, shell or monitor (the typed Query.stopTask). A
  // task_notification with status stopped follows, and lands in the transcript.
  async stopTask(taskId: string): Promise<void> {
    const q = this.q as QueryLike & { stopTask?: (id: string) => Promise<void> };
    if (this.done || !q.stopTask) throw new Error('no running process');
    await q.stopTask(taskId);
  }

  // b, b (R9): every foreground Bash and subagent in flight goes to the background, as Ctrl+B does
  // in the terminal (the typed Query.backgroundTasks, no tool use id). Throws when the session has
  // background tasks turned off.
  async backgroundTasks(): Promise<boolean> {
    if (this.done || !this.q.backgroundTasks) throw new Error('no running process');
    return this.q.backgroundTasks();
  }
}
