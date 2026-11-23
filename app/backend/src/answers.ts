// Needs you (plan section 9): a parked canUseTool request as the page's card reads it, and the
// card's answer as the SDK's PermissionResult. Pure functions, no state.
import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';

export type Kind = 'question' | 'permission' | 'plan';
export const DENIED = 'Denied by the user';

// What the page sends in `answer` (one shape per card):
//   question    {questions: [{picks: [label…], own?: text, note?: text}]}, one entry per question
//   permission  {choice: 'once' | 'always' | 'deny', text?: reason}
//   plan        {choice: 'approve' | 'changes', text?: what to change}
export type QuestionAnswer = { picks?: unknown; own?: unknown; note?: unknown };
export type CardAnswer = { questions?: QuestionAnswer[]; choice?: unknown; text?: unknown };

// The result for canUseTool, and the label your turn shows in the transcript (null when the tool
// result already says it, as for questions).
export type Settled = { result: PermissionResult; label: string | null; rules: string[] };

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

function tilde(p: string, home: string): string {
  return home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p;
}

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

// What "Always allow" remembers and for how long (R6.5): one clause per update entry.
export function alwaysText(suggestions: PermissionUpdate[], home = ''): string {
  const clauses = mergeRules(suggestions).map((u) => {
    const where = WHERE[u.destination] ?? '';
    const w = where ? ` ${where}` : '';
    if (u.type === 'addRules' || u.type === 'replaceRules') {
      const verb = u.behavior === 'deny' ? 'always deny' : u.behavior === 'ask' ? 'always ask before' : 'always allow';
      return `${verb} ${u.rules.map((r) => ruleText(r)).join(', ')}${w}`;
    }
    if (u.type === 'removeRules') return `forget ${u.rules.map((r) => ruleText(r)).join(', ')}${w}`;
    if (u.type === 'setMode') return `switch to ${MODES[u.mode] ?? u.mode}${w}`;
    if (u.type === 'addDirectories') return `allow access to ${u.directories.map((d) => tilde(d, home)).join(', ')}${w}`;
    if (u.type === 'removeDirectories') return `remove access to ${u.directories.map((d) => tilde(d, home)).join(', ')}${w}`;
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

export type Asked = {
  toolName: string;
  input: Record<string, unknown>;
  suggestions: PermissionUpdate[];
  alwaysAllowed: boolean; // suggestions exist and suppressAlwaysAllowRule isn't set
  modeBefore: string; // the mode before plan mode, for Approve
};

// The card's answer to its canUseTool result, or an error the page shows.
export function settle(req: Asked, answer: CardAnswer): Settled | { error: string } {
  const kind = kindOf(req.toolName);
  if (kind === 'question') return settleQuestion(req.input, answer);
  const choice = str(answer.choice);
  const text = str(answer.text);
  if (kind === 'plan') {
    if (choice === 'approve') {
      const mode = (req.modeBefore || 'auto') as 'auto';
      return {
        result: { behavior: 'allow', updatedInput: req.input, updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }], decisionClassification: 'user_temporary' },
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
