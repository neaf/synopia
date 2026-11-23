// The session driver (plan section 6): one SDK `query()` per active session, fed by an
// async-iterable input queue (as in spike/chat.ts), so messages pushed before system/init
// and during a turn reach the CLI in order. The only module that imports the SDK's `query`.
// The process's stderr is kept in memory (the last 20 lines) for the failure toast, never logged.
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, EffortLevel, Options, PermissionResult, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export type QueryLike = AsyncIterable<SDKMessage> & { close?: () => void };
export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => QueryLike;
export type Content = SDKUserMessage['message']['content'];

export const STATE_FLAG = 'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS';
export const DENY_MESSAGE = "Synopia can't answer this yet. Ask in plain text instead.";
export const STDERR_LINES = 20;
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
  onDenied: (toolName: string) => void;
};

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

// Until slice 3 answers cards, every canUseTool call is refused with a message the model reads,
// so a session never hangs on a question nobody can answer.
export function denyAll(onDenied: (toolName: string) => void): CanUseTool {
  return async (toolName): Promise<PermissionResult> => {
    onDenied(toolName);
    return { behavior: 'deny', message: DENY_MESSAGE };
  };
}

// The options of section 6: permissionMode unset (your own setting applies) except plan,
// settingSources at its default, the state flag added to the inherited environment.
export function buildOptions(o: StartOptions, canUseTool: CanUseTool, stderr: (data: string) => void): Options {
  const opts: Options = {
    cwd: o.cwd,
    canUseTool,
    includePartialMessages: true,
    perTaskStopAffordance: true,
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
  done = false;

  constructor(start: StartOptions, events: ProcessEvents, queryFn: QueryFn = sdkQuery as QueryFn) {
    this.events = events;
    const options = buildOptions(start, denyAll((name) => this.events.onDenied(name)), (d) => this.keepStderr(d));
    this.q = queryFn({ prompt: this.input, options });
    void this.read();
  }

  push(content: Content, uuid: string): void {
    this.input.push(userMessage(content, uuid));
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
      for await (const m of this.q) this.events.onMessage(m);
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
    }
    this.done = true;
    this.input.end();
    this.events.onExit(error, this.ended);
  }
}
