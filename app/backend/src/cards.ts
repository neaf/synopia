// Needs-you cards (FR-NEED-05..07): canUseTool parks each request here until the card answers it or
// its signal aborts (an interrupt, the process ending). One Cards per session; several requests at
// once (parallel subagents) are kept in arrival order, and the card shows the oldest. The answer
// becomes the SDK's PermissionResult. "Always allow" rules kept for the session are stored in
// state.json `rules` and passed back as allowedTools on resume; they go when the session closes
// (Q6), so reopening asks again.
import type { CanUseTool, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { planApproval } from './sdk.ts';
import { capRecord, ANSWERS_MAX, PLANS_MAX } from './store.ts';
import type { Store } from './store.ts';

export type Kind = 'question' | 'permission' | 'plan';
export type PendingRequest = { id: string; kind: Kind; since: number; [k: string]: unknown };
export const DENIED = 'Denied by the user';
const INTERRUPTED = 'Interrupted by the user';
// A request that ends without an answer (an interrupt, the process ending).
const interrupted = (): PermissionResult => ({ behavior: 'deny', message: INTERRUPTED, interrupt: true });
const MAX_INPUT_TEXT = 4000; // a Write's content and the like: the card shows the path, not the body

// What the page sends in `answer` (one shape per card):
//   question    {questions: [{picks: [label…], own?: text, note?: text}]}, one entry per question
//   permission  {choice: 'once' | 'always' | 'deny', text?: reason}
//   plan        {choice: 'approve' | 'changes', text?: what to change}
export type QuestionAnswer = { picks?: unknown; own?: unknown; note?: unknown };
export type CardAnswer = { questions?: QuestionAnswer[]; choice?: unknown; text?: unknown };

// The result for canUseTool, and the label your turn shows in the transcript (null when the tool
// result already says it, as for questions).
export type Settled = { result: PermissionResult; label: string | null; rules: string[] };

export type Asked = {
  toolName: string;
  input: Record<string, unknown>;
  suggestions: PermissionUpdate[];
  alwaysAllowed: boolean; // suggestions exist and suppressAlwaysAllowRule isn't set
  modeBefore: string; // the mode before plan mode, for Approve
};

type Options = Parameters<CanUseTool>[2];
type Parked = { request: PendingRequest; asked: Asked; toolUseId: string; resolve: (r: PermissionResult) => void; off: () => void };

export type CardsHooks = {
  store: Store;
  sid: () => string; // the session's id now (it changes at init and on a reset)
  show: (request: PendingRequest) => void; // `pending` with the request
  clear: (id: string) => void; // `pending` with `cleared`
  count: (n: number) => void; // the status: needs you while n > 0
  context: () => { cwd: string; modeBefore: string }; // the session's folder (with ~) and the mode before plan mode
  tilde?: (p: string) => string; // a path as the card shows it (paths.ts displayPath)
  // The last request ended by an answer or its own signal (a stopped subagent, a cancelled tool):
  // messages held behind it may go. Not called from abortAll.
  drained: () => void;
  now: () => number;
};

export class Cards {
  private list: Parked[] = [];
  private aborting = false;
  private hooks: CardsHooks;

  constructor(hooks: CardsHooks) {
    this.hooks = hooks;
  }

  get size(): number {
    return this.list.length;
  }

  // canUseTool: never returns null; the promise settles when you answer or the signal aborts.
  park(toolName: string, input: Record<string, unknown>, options: Options): Promise<PermissionResult> {
    const o = options as Options & Record<string, unknown>;
    const suggestions = (Array.isArray(options.suggestions) ? options.suggestions : []) as PermissionUpdate[];
    const ctx = this.hooks.context();
    const alwaysAllowed = suggestions.length > 0 && !options.suppressAlwaysAllowRule;
    const request: PendingRequest = {
      id: options.requestId || options.toolUseID,
      kind: kindOf(toolName),
      since: this.hooks.now(),
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
      always: alwaysAllowed ? alwaysText(suggestions, this.hooks.tilde) : null,
    };
    const asked: Asked = { toolName, input, suggestions, alwaysAllowed, modeBefore: ctx.modeBefore };
    return new Promise<PermissionResult>((resolve) => {
      const signal = options.signal;
      if (signal?.aborted) { resolve(interrupted()); return; }
      const parked: Parked = { request, asked, toolUseId: options.toolUseID, resolve, off: () => {} };
      const onAbort = () => this.drop(parked, interrupted());
      signal?.addEventListener('abort', onAbort, { once: true });
      parked.off = () => signal?.removeEventListener('abort', onAbort); // answered: the signal keeps no hold on it
      this.list.push(parked);
      this.hooks.show(request);
      this.hooks.count(this.list.length);
    });
  }

  // The card's answer: settles the request and stores what it remembers (session rules, the label
  // your turn shows, the plan the card showed), or says why it can't.
  answer(id: string, answer: CardAnswer): Settled | { error: string } {
    const p = this.list.find((x) => x.request.id === id);
    if (!p) return { error: 'That request is no longer waiting.' };
    const s = settle(p.asked, answer && typeof answer === 'object' ? answer : {});
    if ('error' in s) return s;
    const st = this.hooks.store.state, sid = this.hooks.sid();
    if (s.rules.length) st.rules[sid] = [...new Set([...(st.rules[sid] ?? []), ...s.rules])];
    // the newest ANSWERS_MAX labels and PLANS_MAX plans are kept
    if (s.label) capRecord(st.answers, p.toolUseId, s.label, ANSWERS_MAX);
    // the plan you answered, as the card showed it (the JSONL's ExitPlanMode input can be older)
    if (p.asked.toolName === 'ExitPlanMode' && typeof p.asked.input.plan === 'string') capRecord(st.plans, p.toolUseId, p.asked.input.plan, PLANS_MAX);
    this.hooks.store.changed();
    this.drop(p, s.result);
    return s;
  }

  // The session rules "Always allow" stored, for allowedTools at the next start.
  rules(): string[] | undefined {
    return this.hooks.store.state.rules[this.hooks.sid()];
  }

  // Every request ends (an interrupt the CLI didn't signal, the process ending).
  abortAll(): void {
    this.aborting = true;
    try {
      for (const p of [...this.list]) this.drop(p, interrupted());
    } finally {
      this.aborting = false;
    }
  }

  // The session closes: its requests end and its session rules go (Q6: "for this session").
  close(): void {
    this.abortAll();
    const st = this.hooks.store.state, sid = this.hooks.sid();
    if (sid in st.rules) {
      delete st.rules[sid];
      this.hooks.store.changed();
    }
  }

  private drop(p: Parked, result: PermissionResult): void {
    const i = this.list.indexOf(p);
    if (i === -1) return;
    this.list.splice(i, 1);
    p.off();
    p.resolve(result);
    this.hooks.clear(p.request.id);
    this.hooks.count(this.list.length);
    if (!this.list.length && !this.aborting) this.hooks.drained();
  }
}

function clipInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = typeof v === 'string' && v.length > MAX_INPUT_TEXT && k !== 'plan' ? v.slice(0, MAX_INPUT_TEXT) + '…' : v;
  }
  return out;
}

// ---------- the answer as a PermissionResult (pure) ----------

export function kindOf(toolName: string): Kind {
  if (toolName === 'AskUserQuestion') return 'question';
  if (toolName === 'ExitPlanMode') return 'plan';
  return 'permission';
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const WHERE: Record<string, string> = {
  session: 'for this session',
  localSettings: 'in this project (.claude/settings.local.json)',
  projectSettings: 'in this project (.claude/settings.json)',
  userSettings: 'everywhere (~/.claude/settings.json)',
  cliArg: 'for this run',
};
const MODES: Record<string, string> = {
  acceptEdits: 'accept edits', auto: 'auto mode', default: 'ask before each action', plan: 'plan mode',
  dontAsk: "don't ask", bypassPermissions: 'bypass permissions',
};

type Rule = { toolName: string; ruleContent?: string };
export const ruleText = (r: Rule): string => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName);

// Neighbouring addRules entries with the same behaviour and place read as one clause (the CLI
// suggests a path and its /private realpath as two entries).
function mergeRules(suggestions: PermissionUpdate[]): PermissionUpdate[] {
  const out: PermissionUpdate[] = [];
  for (const u of suggestions) {
    const prev = out[out.length - 1];
    if (u.type === 'addRules' && prev?.type === 'addRules' && prev.behavior === u.behavior && prev.destination === u.destination) {
      out[out.length - 1] = { ...prev, rules: [...prev.rules, ...u.rules] };
    } else out.push(u);
  }
  return out;
}

// What "Always allow" remembers and for how long (R6.5): one clause per update entry. `tilde` shows
// a folder as the card does (`~/…`).
export function alwaysText(suggestions: PermissionUpdate[], tilde: (p: string) => string = (p) => p): string {
  const clauses = mergeRules(suggestions).map((u) => {
    const where = WHERE[u.destination] ?? '';
    const w = where ? ` ${where}` : '';
    if (u.type === 'addRules' || u.type === 'replaceRules') {
      const verb = u.behavior === 'deny' ? 'always deny' : u.behavior === 'ask' ? 'always ask before' : 'always allow';
      return `${verb} ${u.rules.map((r) => ruleText(r)).join(', ')}${w}`;
    }
    if (u.type === 'removeRules') return `forget ${u.rules.map((r) => ruleText(r)).join(', ')}${w}`;
    if (u.type === 'setMode') return `switch to ${MODES[u.mode] ?? u.mode}${w}`;
    if (u.type === 'addDirectories') return `allow access to ${u.directories.map(tilde).join(', ')}${w}`;
    if (u.type === 'removeDirectories') return `remove access to ${u.directories.map(tilde).join(', ')}${w}`;
    return '';
  }).filter(Boolean);
  if (!clauses.length) return '';
  const s = clauses.map((c, i) => (i ? `and ${c}` : c)).join(', ');
  return s[0].toUpperCase() + s.slice(1) + '.';
}

// The session rules an "Always allow" adds: Synopia stores them and passes them back as
// allowedTools on resume, so "for this session" holds until you close it.
export function sessionRules(suggestions: PermissionUpdate[]): string[] {
  return suggestions.flatMap((u) => (u.type === 'addRules' && u.behavior === 'allow' && u.destination === 'session' ? u.rules.map(ruleText) : []));
}

// The card's answer to its canUseTool result, or an error the page shows.
export function settle(req: Asked, answer: CardAnswer): Settled | { error: string } {
  const kind = kindOf(req.toolName);
  if (kind === 'question') return settleQuestion(req.input, answer);
  const choice = str(answer.choice);
  const text = str(answer.text);
  if (kind === 'plan') {
    if (choice === 'approve') {
      return {
        result: { behavior: 'allow', updatedInput: req.input, updatedPermissions: planApproval(req.modeBefore), decisionClassification: 'user_temporary' },
        label: 'Approved', rules: [],
      };
    }
    if (choice === 'changes') {
      if (!text) return { error: 'Say what should change.' };
      return { result: { behavior: 'deny', message: `Changes: ${text}`, decisionClassification: 'user_reject' }, label: `Changes: ${text}`, rules: [] };
    }
    return { error: 'Approve the plan or ask for changes.' };
  }
  if (choice === 'once') return { result: { behavior: 'allow', updatedInput: req.input, decisionClassification: 'user_temporary' }, label: 'Allow once', rules: [] };
  if (choice === 'always') {
    if (!req.alwaysAllowed) return { error: 'This request has no "Always allow".' };
    return {
      result: { behavior: 'allow', updatedInput: req.input, updatedPermissions: req.suggestions, decisionClassification: 'user_permanent' },
      label: 'Always allow', rules: sessionRules(req.suggestions),
    };
  }
  if (choice === 'deny') {
    return { result: { behavior: 'deny', message: text || DENIED, decisionClassification: 'user_reject' }, label: text ? `Denied: ${text}` : 'Denied', rules: [] };
  }
  return { error: 'Choose Allow once, Always allow or Deny.' };
}

// AskUserQuestion: answers keyed by the question text, a multi-select answer as the labels joined
// with ", " (S3-1: Claude reads it verbatim), your own text instead when typed, notes as annotations.
function settleQuestion(input: Record<string, unknown>, answer: CardAnswer): Settled | { error: string } {
  const qs = Array.isArray(input.questions) ? input.questions as { question?: unknown }[] : [];
  const given = Array.isArray(answer.questions) ? answer.questions : [];
  const answers: Record<string, string> = {};
  const annotations: Record<string, { notes: string }> = {};
  for (let i = 0; i < qs.length; i++) {
    const q = typeof qs[i]?.question === 'string' ? qs[i].question as string : '';
    const a = given[i] ?? {};
    const picks = Array.isArray(a.picks) ? a.picks.filter((p): p is string => typeof p === 'string' && p !== '') : [];
    const value = str(a.own) || picks.join(', ');
    if (!value) return { error: 'Answer every question first.' };
    answers[q] = value;
    const note = str(a.note);
    if (note && !str(a.own)) annotations[q] = { notes: note };
  }
  const updatedInput: Record<string, unknown> = { ...input, answers };
  if (Object.keys(annotations).length) updatedInput.annotations = annotations;
  return { result: { behavior: 'allow', updatedInput }, label: null, rules: [] };
}
