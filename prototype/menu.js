// The shape supportedModels() and supportedCommands() return (docs/Agent SDK.md, "Menu"); the user skills are invented.
window.MENU = {
 "models": [
  {
   "value": "default",
   "name": "Default",
   "description": "Use the default model (currently Claude Opus 5.5 (Default))",
   "effort": [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
   ]
  },
  {
   "value": "opusplan",
   "name": "Opus Plan Mode",
   "description": "Use Opus in plan mode, Sonnet otherwise",
   "effort": [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
   ]
  },
  {
   "value": "eu.anthropic.claude-opus-5-5",
   "name": "Claude Opus 5.5 (Default)",
   "description": "[Expensive] Latest, strongest coding agent, the best for high complexity design and conception tasks.",
   "effort": [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
   ]
  },
  {
   "value": "eu.anthropic.claude-opus-5",
   "name": "Claude Opus 5",
   "description": "[Expensive] Great for high complexity tasks. Verbose, overeager and a weak orchestrator.",
   "effort": [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
   ]
  },
  {
   "value": "eu.anthropic.claude-opus-4-8",
   "name": "Claude Opus 4.8",
   "description": "[Expensive] Great for high complexity tasks and planning. Great at orchestrating many subagents and very thorough.",
   "effort": [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
   ]
  },
  {
   "value": "eu.anthropic.claude-opus-4-6-v1",
   "name": "Claude Opus 4.6",
   "description": "[Expensive] Very stable, predictable, and good for high complexity tasks.",
   "effort": [
    "low",
    "medium",
    "high",
    "max"
   ]
  },
  {
   "value": "eu.anthropic.claude-sonnet-5-5",
   "name": "Claude Sonnet 5.5",
   "description": "Fastest and most recent coding agent, a great daily driver for most tasks.",
   "effort": [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
   ]
  },
  {
   "value": "eu.anthropic.claude-sonnet-5",
   "name": "Claude Sonnet 5",
   "description": "Strong coding agent, but less token efficient.",
   "effort": [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
   ]
  },
  {
   "value": "eu.anthropic.claude-sonnet-4-6",
   "name": "Claude Sonnet 4.6 (Default)",
   "description": "Most stable, battle tested model for day to day work.",
   "effort": [
    "low",
    "medium",
    "high",
    "max"
   ]
  },
  {
   "value": "eu.anthropic.claude-haiku-5-5",
   "name": "Claude Haiku 5.5",
   "description": "Fastest and cheapest. Great for well defined tasks and classification.",
   "effort": [
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
   ]
  },
  {
   "value": "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
   "name": "Claude Haiku 4.5",
   "description": "Fast and cheap. Good for simple and narrow tasks.",
   "effort": []
  }
 ],
 "commands": [
  {
   "name": "notes",
   "description": "Keep project notes as markdown files in `notes/<area>/`, so work can be split across sessions and picked up later without the conversation history. Use when a task spans several sessions. (user)",
   "hint": ""
  },
  {
   "name": "plan-create",
   "description": "Create a project plan with its milestones, one section at a time, each reviewed by fresh subagents and approved by the author, down to tasks that become PRs. Use when starting or resuming a plan. (user)",
   "hint": "[product doc, tracker project or existing plan URL (optional)]"
  },
  {
   "name": "plan-milestone-execute",
   "description": "Execute one plan milestone as stacked draft PRs, one fresh subagent per PR: check the input is ready, follow CI and reviews, QA on a review app. Use when a planned milestone is ready to build. (user)",
   "hint": "[anything you have: plan link, milestone, design doc, notes (optional)]"
  },
  {
   "name": "plan-milestone-design",
   "description": "Write the design document of one plan milestone with write-spec, pinned to main and earlier milestone PRs, and attach it to the plan. Use when an approved milestone needs its spec before it is built. (user)",
   "hint": "[anything you have: plan link, milestone, notes (optional)]"
  },
  {
   "name": "question-me",
   "description": "Ask the user rounds of questions on a plan, design or idea, each with a recommended answer, until no decision is left open. Use when the user wants to test their thinking. (user)",
   "hint": ""
  },
  {
   "name": "clarify-plan",
   "description": "Ask the user to clarify a vague request, then write a plan. Use when the prompt is short or ambiguous and the user wants to think before building. (user)",
   "hint": ""
  },
  {
   "name": "write-spec",
   "description": "Write an HTML spec for a feature or bug before the code exists. Use when writing or reviewing a spec, design doc or bug report from a prompt, ticket, doc or pull request. (user)",
   "hint": "[a prompt, a link, ticket, doc, or PR] [output folder (optional)]"
  },
  {
   "name": "tracker-project-creator",
   "description": "name: tracker-project-creator (user)",
   "hint": ""
  },
  {
   "name": "tracker-plan-sync",
   "description": "name: tracker-plan-sync (user)",
   "hint": ""
  },
  {
   "name": "code-tour",
   "description": "Walk through an unfamiliar codebase module by module and write a short tour for the next reader. Use when onboarding to a project. (user)",
   "hint": ""
  },
  {
   "name": "design-explore",
   "description": "Explore technical options for a feature from product docs, designs and earlier PRs, one section at a time, reviewed before the next. (user)",
   "hint": ""
  },
  {
   "name": "deep-research",
   "description": "Deep research harness — fan-out web searches, fetch sources, adversarially verify claims, synthesize a cited report. (dynamic workflow)",
   "hint": ""
  },
  {
   "name": "frontend-design:frontend-design",
   "description": "(frontend-design) Guidance for distinctive, intentional visual design when building new UI or reshaping an existing one. Helps with aesthetic direction, typography, and making choices that don't read as templated defaults.",
   "hint": ""
  },
  {
   "name": "dataviz",
   "description": "Use this skill whenever you are about to create ANY chart, graph, plot, dashboard, or data visualization, in ANY output medium — an HTML or React artifact, inline SVG, plotting code in any library (matplotlib, plotly, d3, Recharts, …), an image/PNG you will render and upload, or a chart shared into Slack. Read it BEFORE writing the first line of chart code, choosing chart colors, building a stat tile / meter / KPI row, or laying out a dashboard. When the destination is a first-party document connector (host-designated, never self-described) that renders live charts, hand it the rows (inline, or as an uploaded data file the chart cites) rather than a rendered PNG/SVG — a picture of a chart loses hover, data inspection and per-value comments. Produces visualizations that read as one system — elegant, accessible, consistent in light and dark — using a brand-neutral placeholder palette you swap for your own. Teaches a design-system-agnostic method: a form heuristic, a color formula with a runnable validator, mark specs, and interaction rules. A validated default palette is documented in `references/palette.md` — swap that file's values for your brand's. Triggers on: \"chart\", \"graph\", \"plot\", \"data viz\", \"visualization\", \"dashboard\", \"analytics\", \"visualize data\", \"categorical colors\", \"sequential / diverging palette\", \"stat tile\", \"sparkline\", \"heatmap\", \"legend\", \"axis\", \"tooltip\", \"chart colors\", \"color by series\".",
   "hint": ""
  },
  {
   "name": "update-config",
   "description": "Use this skill to configure the Claude Code harness via settings.json. Automated behaviors (\"from now on when X\", \"each time X\", \"whenever X\", \"before/after X\") require hooks configured in settings.json - the harness executes these, not Claude, so memory/preferences cannot fulfill them. Also use for: permissions (\"allow X\", \"add permission\", \"move permission to\"), env vars (\"set X=Y\"), hook troubleshooting, or any changes to settings.json/settings.local.json files. Examples: \"allow npm commands\", \"add bq permission to global settings\", \"move permission to user settings\", \"set DEBUG=true\", \"when claude stops show X\". For simple settings like theme/model, suggest the /config command.",
   "hint": ""
  },
  {
   "name": "verify",
   "description": "Verify that a code change actually does what it's supposed to by exercising it end-to-end and observing behavior — drive the affected flow, not just tests or typecheck. Run before committing nontrivial changes; bootstraps this repo's project verify skill if none exists yet. Don't invoke it on a diff that only touches tests, docs, or other code with no runtime surface to drive (a change to product source always has one) — there's nothing to observe.",
   "hint": ""
  },
  {
   "name": "debug",
   "description": "Enable debug logging for this session and help diagnose issues",
   "hint": "[issue description]"
  },
  {
   "name": "code-review",
   "description": "Review the current diff, or a PR number/branch/path target, for correctness bugs (plus broken CLAUDE.md rules and cleanups where the model's recipe covers them; see /simplify) at the effort level given first, before any target (low|medium|high|xhigh|max: from few high-confidence findings to many, some uncertain); with no level given, it reuses the level you typed last. Pass --comment to post findings as inline PR comments, or --fix to apply them to the working tree after the review. Pass --max-findings <n> to report up to n findings, or --max-findings all for every finding. The choice stays until you pass --max-findings default.",
   "hint": "[low|medium|high|xhigh|max] [--fix] [--comment] [<pr#>|<branch>|<path>] [--max-findings <n>|all]"
  },
  {
   "name": "simplify",
   "description": "Review the changed code for reuse, simplification, efficiency, and altitude cleanups, then apply the fixes. Quality only — it does not hunt for bugs; use /code-review for that.",
   "hint": "[<target>]"
  },
  {
   "name": "batch",
   "description": "Research and plan a large-scale change, then execute it in parallel across 5–30 isolated worktree agents that each open a PR.",
   "hint": "<instruction>"
  },
  {
   "name": "fewer-permission-prompts",
   "description": "Scan your transcripts for common read-only Bash and MCP tool calls, then add a prioritized allowlist to project .claude/settings.json to reduce permission prompts.",
   "hint": ""
  },
  {
   "name": "doctor",
   "description": "Health-check the user's Claude Code setup and fix issues: diagnose installation health — what the `claude doctor` terminal diagnostics cover — from local data (duplicate or leftover installs, PATH, unparseable settings files, broken or colliding agent definitions, skills whose frontmatter fails to parse); find unused skills, MCP servers, and plugins versus their context cost and disable dead weight; deduplicate local CLAUDE.md files against checked-in ones; trim checked-in CLAUDE.md files by cutting content a session could derive from the codebase (directory layouts, tech-stack lists, architecture overviews) while keeping gotchas, rationale, and non-standard conventions; migrate always-loaded CLAUDE.md guidance into lazy skills and nested CLAUDE.md files; flag slow hooks and context-heavy extensions; check the installed version is current; make auto mode the default permission mode; and pre-approve frequently denied read-only commands. Use when the user asks for a doctor run, checkup, audit, tune-up, or cleanup of their Claude Code setup or configuration.",
   "hint": "[prompt-audit [<path>]]"
  },
  {
   "name": "loop",
   "description": "Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo). Omit the interval to let the model self-pace.",
   "hint": "[interval] [prompt]"
  },
  {
   "name": "claude-api",
   "description": "Reference for the Claude API / Anthropic SDK — model ids, pricing, params, streaming, tool use, MCP, agents, caching, token counting, model migration.\nTRIGGER — read FIRST, before you answer, run a command or open a file (already started? read it now); don't skip because it \"looks like a one-liner\" — whenever: the prompt names Claude/Anthropic in any form (Claude, Anthropic, Fable, Opus, Sonnet, Haiku, `anthropic`, `@anthropic-ai`, `claude-*`, `us.anthropic.*`, `[1m]`); the user asks about an LLM (pricing/model choice/limits/caching) — never answer from memory; OR the task is LLM-shaped with provider unstated (agent/MCP/tool-definition/multi-agent/RAG/LLM-judge/computer-use; generate/summarize/extract/classify/rewrite/converse over NL; debugging refusals/cutoffs/streaming/tool-calls/tokens).\nSKIP only when another provider is being worked on (overrides all triggers): OpenAI/GPT/Gemini/Llama/Mistral/Cohere/Ollama named in the query; OR `grep -rE 'openai|langchain_openai|google.generativeai|genai|mistralai|cohere|ollama'` over the project hits (run this grep FIRST if no provider named — don't Read the file; if nothing hits, load this skill).",
   "hint": ""
  },
  {
   "name": "workflow-authoring",
   "description": "Reference for writing a Workflow tool script (script API and gotchas, resume, quality patterns, worked examples). Load before authoring a script for a workflow the user already opted into; it does not itself authorize running one.",
   "hint": ""
  },
  {
   "name": "run",
   "description": "Launch and drive this project's app to see a change working. Use when asked to run, start, or screenshot the app, or to confirm a change works in the real app (not just tests). First looks for a project skill that already covers launching the app; otherwise falls back to built-in patterns per project type (CLI, server, TUI, Electron, browser-driven, library).",
   "hint": ""
  },
  {
   "name": "run-skill-generator",
   "description": "Author or improve the run-<unit> skill - a per-project skill that tells agents how to build, launch, and drive this project's app. Use when the user asks to set up the project, get it running, write run instructions, or verify build/run steps work from a clean environment.",
   "hint": ""
  },
  {
   "name": "plugin-authoring",
   "description": "Make a mod: a change to Claude's own interface or behaviour, such as a theme, a panel or pane that stays beside the chat and updates, a band, status line, toast, slash command, or hook on tool calls. Use to make, change or debug a mod or its hooks module.",
   "hint": ""
  },
  {
   "name": "agents",
   "description": "(removed) Ask Claude to create/manage subagents, or edit .claude/agents/",
   "hint": ""
  },
  {
   "name": "auto-mode-setup",
   "description": "Teach auto mode about your environment, plus optional rule tweaks",
   "hint": "[--request-id <uuid>] (--wizard posture=… scope=… depth=… --propose | --expect-sha256 <64-hex> --apply-file <path>)"
  },
  {
   "name": "autocompact",
   "description": "Set how full the context gets before auto-summarizing",
   "hint": "[auto|<tokens>]"
  },
  {
   "name": "clear",
   "description": "Start a new session with empty context; loops carry over, and the old one stays in /resume",
   "hint": "[name]"
  },
  {
   "name": "color",
   "description": "Set the prompt bar color for this session",
   "hint": "[red|blue|green|yellow|purple|orange|pink|cyan|default]"
  },
  {
   "name": "compact",
   "description": "Free up context by summarizing the conversation so far",
   "hint": "<optional custom summarization instructions>"
  },
  {
   "name": "config",
   "description": "Set a setting by key",
   "hint": "key=value"
  },
  {
   "name": "output-style",
   "description": "List output styles or switch to one",
   "hint": "[style]"
  },
  {
   "name": "context",
   "description": "Show current context usage",
   "hint": ""
  },
  {
   "name": "effort",
   "description": "Set the model's effort level",
   "hint": "<low|medium|high|xhigh|max|auto|ultracode [on|off]>"
  },
  {
   "name": "fast",
   "description": "Toggle fast mode (Opus 5.5)",
   "hint": "[on|off]"
  },
  {
   "name": "focus",
   "description": "Toggle focus view: just your prompt, summary, and response",
   "hint": "[on|off]"
  },
  {
   "name": "heapdump",
   "description": "Dump the JS heap to the Desktop; on Linux with no Desktop folder, the home directory",
   "hint": ""
  },
  {
   "name": "init",
   "description": "Initialize a new CLAUDE.md file with codebase documentation",
   "hint": ""
  },
  {
   "name": "mcp",
   "description": "Manage MCP servers",
   "hint": "[reconnect|enable|disable [<server>|all]]"
  },
  {
   "name": "model",
   "description": "Set the AI model for Claude Code",
   "hint": "<model>"
  },
  {
   "name": "__remote-workflow",
   "description": "Run the workflow script delivered in this session environment (server-launched sessions only)",
   "hint": ""
  },
  {
   "name": "workflow-launch-exec",
   "description": "Execute a server-launched workflow handoff (workflow_launch event sessions only)",
   "hint": ""
  },
  {
   "name": "reload-plugins",
   "description": "Activate pending plugin changes in the current session",
   "hint": "[--force]"
  },
  {
   "name": "reload-skills",
   "description": "Pick up skills added or changed on disk during this session",
   "hint": ""
  },
  {
   "name": "rename",
   "description": "Rename the current conversation",
   "hint": "[name]"
  },
  {
   "name": "security-review",
   "description": "Complete a security review of the pending changes on the current branch",
   "hint": ""
  },
  {
   "name": "usage",
   "description": "Show session cost, plan usage, and what's contributing to your limits",
   "hint": ""
  },
  {
   "name": "insights",
   "description": "Generate a report analyzing your Claude Code sessions",
   "hint": ""
  },
  {
   "name": "recap",
   "description": "Generate a one-line session recap now",
   "hint": ""
  },
  {
   "name": "goal",
   "description": "Set a goal — keep working until the condition is met",
   "hint": ""
  },
  {
   "name": "list-agents",
   "description": "List subagents, teammates, and other Claude sessions you can message",
   "hint": ""
  },
  {
   "name": "team-onboarding",
   "description": "Help teammates ramp on Claude Code with a guide from your usage",
   "hint": ""
  }
 ]
};
