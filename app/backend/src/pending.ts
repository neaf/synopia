// Needs you (plan section 9): canUseTool parks each request here until the card answers it or
// its signal aborts (an interrupt, the process ending). One NeedsYou per session; several
// requests at once (parallel subagents) are kept in arrival order, and the card shows the
// oldest. Messages you send while a card waits are held behind it and pushed once the last
// card is answered (plan section 6), or go back to the message box if the turn ends first.
import type { CanUseTool, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { alwaysText, kindOf, settle } from './answers.ts';
import type { Asked, CardAnswer, Settled } from './answers.ts';
import type { PendingRequest } from './views.ts';

type Options = Parameters<CanUseTool>[2];
type Parked = { request: PendingRequest; asked: Asked; toolUseId: string; resolve: (r: PermissionResult) => void };
export type Held = { content: unknown; uuid: string; text: string };

export const INTERRUPTED = 'Interrupted by the user';
const MAX_INPUT_TEXT = 4000; // a Write's content and the like: the card shows the path, not the body

export type NeedsYouHooks = {
  show: (request: PendingRequest) => void; // `pending` with the request
  clear: (id: string) => void; // `pending` with `cleared`
  count: (n: number) => void; // the status: needs you while n > 0
  held: (texts: string[]) => void; // the "Queued until you answer the card above" lines
  context: () => { cwd: string; modeBefore: string }; // the session's folder (with ~) and the mode before plan mode
  now?: () => number;
};

export class NeedsYou {
  private list: Parked[] = [];
  private queue: Held[] = [];
  private hooks: NeedsYouHooks;

  constructor(hooks: NeedsYouHooks) {
    this.hooks = hooks;
  }

  get size(): number {
    return this.list.length;
  }

  requests(): PendingRequest[] {
    return this.list.map((p) => p.request);
  }

  // canUseTool: never returns null; the promise settles when you answer or the signal aborts.
  park(toolName: string, input: Record<string, unknown>, options: Options): Promise<PermissionResult> {
    const o = options as Options & Record<string, unknown>;
    const suggestions = (Array.isArray(options.suggestions) ? options.suggestions : []) as PermissionUpdate[];
    const ctx = this.hooks.context();
    const alwaysAllowed = suggestions.length > 0 && !options.suppressAlwaysAllowRule;
    const kind = kindOf(toolName);
    const request: PendingRequest = {
      id: options.requestId || options.toolUseID,
      kind,
      since: (this.hooks.now ?? Date.now)(),
      toolName,
      toolUseId: options.toolUseID,
      agentId: options.agentID ?? null,
      input: clipInput(input),
      cwd: ctx.cwd,
      description: typeof o.description === 'string' ? o.description : '',
      title: typeof o.title === 'string' ? o.title : '',
      decisionReason: typeof o.decisionReason === 'string' ? o.decisionReason : '',
      defaultToNo: options.defaultToNo === true,
      suppressAlwaysAllowRule: options.suppressAlwaysAllowRule === true,
      suggestions,
      always: alwaysAllowed ? alwaysText(suggestions) : null,
    };
    const asked: Asked = { toolName, input, suggestions, alwaysAllowed, modeBefore: ctx.modeBefore };
    return new Promise<PermissionResult>((resolve) => {
      const parked: Parked = { request, asked, toolUseId: options.toolUseID, resolve };
      if (options.signal?.aborted) {
        resolve({ behavior: 'deny', message: INTERRUPTED, interrupt: true });
        return;
      }
      options.signal?.addEventListener('abort', () => this.drop(parked, { behavior: 'deny', message: INTERRUPTED, interrupt: true }), { once: true });
      this.list.push(parked);
      this.hooks.show(request);
      this.hooks.count(this.list.length);
    });
  }

  // The card's answer: settles the request, or says why it can't.
  answer(id: string, answer: CardAnswer): (Settled & { toolUseId: string }) | { error: string } {
    const p = this.list.find((x) => x.request.id === id);
    if (!p) return { error: 'That request is no longer waiting.' };
    const s = settle(p.asked, answer && typeof answer === 'object' ? answer : {});
    if ('error' in s) return s;
    this.drop(p, s.result);
    return { ...s, toolUseId: p.toolUseId };
  }

  // Every request ends (an interrupt the CLI didn't signal, the process ending).
  abortAll(): void {
    for (const p of [...this.list]) this.drop(p, { behavior: 'deny', message: INTERRUPTED, interrupt: true });
  }

  // A message sent while a card waits.
  hold(h: Held): void {
    this.queue.push(h);
    this.hooks.held(this.queue.map((x) => x.text));
  }

  // The held messages, emptied: pushed once no card waits, or restored when the turn ends.
  takeHeld(): Held[] {
    const out = this.queue;
    this.queue = [];
    if (out.length) this.hooks.held([]);
    return out;
  }

  private drop(p: Parked, result: PermissionResult): void {
    const i = this.list.indexOf(p);
    if (i === -1) return;
    this.list.splice(i, 1);
    p.resolve(result);
    this.hooks.clear(p.request.id);
    this.hooks.count(this.list.length);
  }
}

function clipInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = typeof v === 'string' && v.length > MAX_INPUT_TEXT && k !== 'plan' ? v.slice(0, MAX_INPUT_TEXT) + '…' : v;
  }
  return out;
}
