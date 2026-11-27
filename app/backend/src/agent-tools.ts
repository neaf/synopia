// Synopia's tools for agents (R3.15, FR-SES-20): the one module that owns them. Every session Synopia
// runs gets a fresh in-process MCP server named `synopia` for its process (sdk.ts `toolServer`, through
// session.ts startOptions); the writer's call and the menu probe get none. The model and the
// transcript see a tool as `mcp__synopia__<name>` (docs/Agent SDK.md, "Synopia's tools for agents").
// A tool is one entry of TOOLS:
//   name, description, input  what the model reads (input is a zod shape)
//   card(input, folder)       how the permission card words a call (each call asks, cards.ts); none: answered
//                             with no card (allowed from the main conversation, refused from a subagent)
//   step(input)               the step's object in the transcript, after `verb`
//   run(input, caller, host)  what it does, for the session that called it
// To add a tool: write its Tool here, add it to TOOLS, and give `Host` what it needs from Sessions.
// The wording and the result text live here too, so the transcript (transcript.ts) and the card
// (cards.ts) read them from one place.
import { z } from 'zod';
import { toolServer as sdkToolServer } from './sdk.ts';
import type { ToolDef, ToolResult } from './sdk.ts';
import type { McpSdkServerConfigWithInstance, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { limit, MAX_TITLE } from './writer.ts';

export const SERVER = 'synopia';
const VERSION = '1';
export const fullName = (tool: string): string => `mcp__${SERVER}__${tool}`;

export type Started = { ok: true; sid: string } | { ok: false; error: string };
// What the tools need from the open sessions (sessions.ts gives it).
export type Host = {
  // The session Synopia runs with this id (through its aliases), or null: closed, or none of Synopia's.
  caller(id: string): { id: string; cwd: string; title: string; gone(): boolean } | null;
  // A new session in `cwd` with `prompt` as its first message, as New session and a send do (R3.3).
  // `title` ('' none) is only its first title: the writer's text until the writer writes its own.
  newSession(cwd: string, prompt: string, title: string): Started;
  // `sid` right under `caller` in the caller's group, or in a new group of the two named `group`
  // when the caller is in none (layout.ts is the owner).
  placeUnder(sid: string, caller: string, group: string): { ok: true } | { ok: false; error: string };
  // The pages hear that `caller` started `sid`: one viewing the caller switches to it (publisher.ts `started`).
  started(sid: string, caller: string): void;
  // The new session's real id once its system/init comes, else the id it has after `ms`.
  idOf(sid: string, ms: number): Promise<string>;
  // The session's open items (open-items.ts toolOp): one `open_items` call, its result's text.
  items?(caller: string, input: Record<string, unknown>): Promise<{ ok: boolean; text: string }>;
  tilde(p: string): string;
};

// How the card asks: its header, what Claude wants to do, the line it shows, the "Allow once" hint,
// and the "Always allow" text (kept as a session rule, cards.ts; until the session closes, Q6).
export type CardText = { header: string; wants: string; text: string; once: string; always: string };

type Input = Record<string, unknown>;
type Tool = {
  name: string;
  description: string;
  input: z.ZodRawShape;
  verb: string;
  card?(input: Input, folder: string): CardText;
  step(input: Input): string;
  run(input: Input, caller: string, host: Host): Promise<ToolResult>;
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const refuse = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }], isError: true });
export const firstLine = (s: string): string => s.trim().split('\n')[0].trim();
// A short title from a prompt: its first line, at most 8 words and 60 characters.
export function firstWords(s: string): string {
  const words = firstLine(s).split(/\s+/).filter(Boolean);
  const t = words.slice(0, 8).join(' ');
  if (t.length > 60) return t.slice(0, 59).trimEnd() + '…';
  return words.length > 8 ? t + '…' : t;
}
// The caller's title, cut as a written title is (writer.ts), else the prompt's first words.
const givenTitle = (input: Input): string => limit(str(input.title), MAX_TITLE);
const titleOf = (input: Input): string => givenTitle(input) || firstWords(str(input.prompt));

// ---------- start_session ----------

// How long the tool waits for the new session's id (its system/init) before it answers without one.
export const ID_WAIT_MS = 30_000;
// The result's text names the new session; the transcript reads its id back (startedFrom).
const STARTED = /^Started session ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) “/;
export const startedText = (sid: string, title: string): string => `Started session ${sid} “${title}”. It runs on its own; this session goes on.`;
export function startedFrom(result: string): string | null {
  return STARTED.exec(result)?.[1] ?? null;
}

const startSession: Tool = {
  name: 'start_session',
  description: 'Start a new Claude Code session in this session\'s folder, with `prompt` as its first message. '
    + 'Synopia shows it right under this session in the sidebar; this session goes on. The user approves each call. '
    + 'Use it to hand work over to a fresh session (for example after writing a handoff file the prompt names).',
  input: {
    prompt: z.string().describe('The new session\'s first message'),
    title: z.string().optional().describe('A short title for the new session'),
  },
  verb: 'Start session',
  card: (input, folder) => ({
    header: 'Start session',
    wants: 'start a new session',
    text: `Start a new session in ${folder} with: ${firstLine(str(input.prompt))}`,
    once: 'Starts this session now. Claude asks again next time.',
    always: 'Starts new sessions from this session without asking, until you close it.',
  }),
  step: (input) => titleOf(input),
  async run(input, callerId, host) {
    const prompt = str(input.prompt);
    if (!prompt.trim()) return refuse('The prompt is empty: give the new session its first message.');
    const caller = host.caller(callerId);
    if (!caller) return refuse('This session isn\'t one Synopia runs, so it can\'t start a session.');
    if (caller.gone()) return refuse(`The folder ${host.tilde(caller.cwd)} no longer exists.`);
    const title = titleOf(input);
    const r = host.newSession(caller.cwd, prompt, givenTitle(input));
    if (!r.ok) return refuse(r.error);
    const placed = host.placeUnder(r.sid, caller.id, caller.title);
    if (!placed.ok) return refuse(placed.error);
    host.started(r.sid, caller.id);
    const sid = await host.idOf(r.sid, ID_WAIT_MS);
    return text(startedText(sid, title));
  },
};

// ---------- open_items (R3.15, R3.16, FR-ITEM-12) ----------

export const ITEM_OPS = ['open', 'update', 'close', 'list'] as const;
export const ITEM_KINDS = ['decision', 'your task', 'default', 'review', 'follow-up'] as const;
// What a subagent reads when it calls the tool: it is refused, and told what to do instead.
export const SUBAGENT_REFUSED = 'Only the main conversation keeps the open items. Put this item in your report instead (a question for the user, or "Closed: <id> (<what was done>)"), and the main conversation records it.';

const openItems: Tool = {
  name: 'open_items',
  description: 'The session\'s open items, kept by Synopia: loose ends waiting on the user (Y ids) or on you (A ids, follow-ups). '
    + 'The list holds what waits on the user and what is stuck or would be forgotten, not a plan of what will happen: open a follow-up only when nothing else brings it back (a promise with nothing behind it, an outside event no watcher covers, a step left at a handoff, work in motion that died: open it as stuck). Never for the next step of work in motion: a running subagent\'s branch or report, a watcher or CI notification, a scheduled wakeup each bring it back. '
    + 'Record them here instead of editing the open-items ledger file; Synopia gives the ids and writes the file between turns. '
    + 'op "open": kind, text (one sentence), and for a decision its options and recommended one, for a follow-up or a default its trigger, and the quote it came from; returns the new id. '
    + 'op "update": id, and state (answered, due or later), answer, or a better text. '
    + 'op "close": id and as (done, went ahead, dropped, superseded or answered), why, and by (the id that supersedes it). '
    + 'op "list": the open items and the newest 10 closed, for you to read. Never print the list in your reply: the user sees it in Synopia. '
    + 'Give ledger (the absolute path of .ai-notes/<area>/open-items.md) when the session has none yet. Only the main conversation calls this tool; a subagent puts its items in its report.',
  input: {
    op: z.enum(ITEM_OPS).describe('What to do'),
    id: z.string().optional().describe('The item, for update and close: Y3, A1'),
    kind: z.enum(ITEM_KINDS).optional().describe('For open: who acts and how'),
    text: z.string().optional().describe('For open, or a better text on update: one sentence'),
    options: z.array(z.string()).optional().describe('For a decision: its set answers'),
    recommended: z.string().optional().describe('For a decision: the option you would pick'),
    trigger: z.string().optional().describe('For a follow-up: when to check; for a default: when it goes ahead'),
    quote: z.string().optional().describe('For open: the words it came from'),
    state: z.enum(['answered', 'due', 'later']).optional().describe('For update'),
    answer: z.string().optional().describe('For update with state answered: the user\'s answer'),
    as: z.enum(['done', 'went ahead', 'dropped', 'superseded', 'answered']).optional().describe('For close: how it closed'),
    why: z.string().optional().describe('For close: what was done, or why it was dropped'),
    by: z.string().optional().describe('For close as superseded: the id that replaces it'),
    ledger: z.string().optional().describe('The absolute path of the area\'s .ai-notes/<area>/open-items.md'),
  },
  verb: 'Open items',
  step: (input) => {
    const id = str(input.id), t = firstLine(str(input.text));
    return id && t ? `${id}: ${t}` : id || t || str(input.op);
  },
  async run(input, callerId, host) {
    if (!host.items) return refuse('Synopia can\'t keep open items here.');
    const r = await host.items(callerId, input);
    return r.ok ? text(r.text) : refuse(r.text);
  },
};

const TOOLS: Tool[] = [startSession, openItems];
const byName = new Map(TOOLS.map((t) => [fullName(t.name), t]));

// ---------- for the rest of the backend ----------

// The server for one process of the session `caller` gives (its id now: it changes at init and on a reset).
export function toolServer(host: Host, caller: () => string): Record<string, McpSdkServerConfigWithInstance> {
  const d = defs(host, caller);
  const server = sdkToolServer(SERVER, VERSION, d);
  served.set(server, d);
  return { [SERVER]: server };
}

// Test-only (the scripted SDK, app/backend/dev/scripted-sdk.ts): runs a tool of a server toolServer
// made, as the CLI calls it once canUseTool allowed it. Null when the servers hold no such tool.
const served = new WeakMap<object, ToolDef[]>();
export function callServed(servers: Record<string, unknown> | undefined, toolName: string, input: Input): Promise<ToolResult> | null {
  const [, server, name] = /^mcp__(.+?)__(.+)$/.exec(toolName) ?? [];
  const cfg = server ? servers?.[server] : undefined;
  const def = cfg && typeof cfg === 'object' ? served.get(cfg)?.find((t) => t.name === name) : undefined;
  return def ? def.run(input) : null;
}

// The definitions a server holds (the scripted SDK calls them as the CLI would, through `call`).
export function defs(host: Host, caller: () => string): ToolDef[] {
  return TOOLS.map((t) => ({
    name: t.name, description: t.description, input: t.input,
    run: async (args) => {
      try {
        return await t.run(args, caller(), host);
      } catch (e) {
        return refuse(`Synopia couldn't do it: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      }
    },
  }));
}

export const isOurs = (toolName: string): boolean => byName.has(toolName);

// The card's words for a call of one of ours, or null for another tool and for a tool with no card.
export function cardOf(toolName: string, input: Input, folder: string): CardText | null {
  return byName.get(toolName)?.card?.(input, folder) ?? null;
}

// A call of one of our tools with no card, answered at once (FR-ITEM-12): allowed from the main conversation,
// refused from a subagent (`agentID` is set only for a subagent's call, docs/Agent SDK.md, "Live run TL-2").
// Null for every other tool: it goes to a card.
export function answerOf(toolName: string, input: Input, agentID: string | undefined): PermissionResult | null {
  const t = byName.get(toolName);
  if (!t || t.card) return null;
  return agentID !== undefined ? { behavior: 'deny', message: SUBAGENT_REFUSED } : { behavior: 'allow', updatedInput: input };
}

// The step's verb and object in the transcript, or null for another tool.
export function stepOf(toolName: string, input: Input): [string, string] | null {
  const t = byName.get(toolName);
  return t ? [t.verb, t.step(input)] : null;
}

// The session a finished start_session step started, from its result text (null for anything else).
export function sessionOf(toolName: string, result: string): string | null {
  return toolName === fullName(startSession.name) ? startedFrom(result) : null;
}
