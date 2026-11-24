// One fake of the SDK surface sdk.ts consumes (query and listSessions), for every backend test.
// Each query() call is recorded: its options, the user messages it read, and its control calls.
// The test drives the process's output with emit() and end(). The process ends when its input
// closes (after `exitDelay`), when close() is called, or when its abortController aborts.
import type { ModelInfo, Options, SDKMessage, SDKSessionInfo, SDKUserMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn, Sdk } from '../../src/sdk.ts';

// An async-iterable channel: the fake CLI's output.
export function channel<T>() {
  const buf: T[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  let fail: Error | null = null;
  return {
    push(m: T) { if (done) return; buf.push(m); wake?.(); wake = null; },
    end(err?: Error) { if (done) return; done = true; fail = err ?? null; wake?.(); wake = null; },
    get ended() { return done; },
    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
      while (true) {
        while (buf.length) yield buf.shift() as T;
        if (fail) throw fail;
        if (done) return;
        await new Promise<void>((r) => (wake = r));
      }
    },
  };
}

export type FakeCall = {
  options: Options;
  inputs: SDKUserMessage[];
  out: ReturnType<typeof channel<SDKMessage>>;
  closed: boolean;
  interrupts: unknown[]; // the argument of each interrupt() call
  reply: { still_queued: string[]; cancelled?: string[] } | undefined; // what interrupt() returns
  controls: [string, unknown][]; // setModel, applyFlagSettings, backgroundTasks
  exitDelay?: number; // ms between the input closing and the process ending
  background?: boolean | Error; // what backgroundTasks() returns or throws (default true)
};

export type FakeOptions = {
  // Each user message the process reads; the writer's fake replies here.
  onInput?: (call: FakeCall, m: SDKUserMessage) => void | Promise<void>;
  // The menu calls; without them the query has no supportedCommands/supportedModels.
  commands?: () => Promise<SlashCommand[]>;
  models?: () => Promise<ModelInfo[]>;
  sessions?: SDKSessionInfo[]; // what listSessions() gives
  events?: string[]; // 'start', 'interrupt' and 'close' are pushed here, in order
};

export const emit = (c: FakeCall, m: object) => c.out.push(m as SDKMessage);

// A result message, `success` with `reply` as its text, else the given subtype.
export const result = (reply: string, subtype = 'success', extra: object = {}) =>
  ({ type: 'result', subtype, is_error: subtype !== 'success', ...(subtype === 'success' ? { result: reply } : { errors: [] }), ...extra }) as unknown as SDKMessage;

export function fakeQuery(o: FakeOptions = {}) {
  const calls: FakeCall[] = [];
  const fn: QueryFn = ({ prompt, options }) => {
    const out = channel<SDKMessage>();
    const call: FakeCall = { options, inputs: [], out, closed: false, interrupts: [], reply: { still_queued: [] }, controls: [] };
    calls.push(call);
    o.events?.push('start');
    options.abortController?.signal.addEventListener('abort', () => out.end(new Error('aborted')), { once: true });
    void (async () => {
      for await (const m of prompt) {
        call.inputs.push(m);
        await o.onInput?.(call, m);
      }
      if (call.exitDelay) await new Promise((r) => setTimeout(r, call.exitDelay));
      out.end(); // the input closed: the process ends after its turn
    })();
    return Object.assign(out, {
      close: () => { call.closed = true; o.events?.push('close'); out.end(); },
      interrupt: async (req?: { cancelQueued?: boolean }) => { call.interrupts.push(req); o.events?.push('interrupt'); return call.reply; },
      setModel: async (m?: string) => { call.controls.push(['setModel', m]); },
      applyFlagSettings: async (x: unknown) => { call.controls.push(['applyFlagSettings', x]); },
      backgroundTasks: async (id?: string) => {
        call.controls.push(['backgroundTasks', id]);
        if (call.background instanceof Error) throw call.background;
        return call.background ?? true;
      },
      ...(o.commands && o.models ? { supportedCommands: o.commands, supportedModels: o.models } : {}),
    });
  };
  const sdk: Sdk = { query: fn, listSessions: async () => o.sessions ?? [] };
  return { calls, fn, sdk };
}
