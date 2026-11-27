---
name: storyboard
description: Defines a user experience before it is built, as one self-contained HTML storyboard per experience question: the scenarios as strips of states, two or three options side by side where the choice is real, one recommended with a one-line why, a summary of the recommended design, the requirement changes it implies and the open questions for the author. The author decides; the decisions and why each option lost go into the requirements doc, and the storyboard stays as design history. Use before building a UI behaviour with real choices (status marks, icons, a flow such as choosing a folder), or when the author asks for a storyboard, mock-ups or options to compare.
---

# Storyboard

A storyboard answers one experience question before any code: what the user sees, state by state, and which of the real alternatives to build. It is one HTML page the author opens with a double-click. The author decides from it; the requirements doc records the decision; then the feature is built.

[writing-craft](../writing-craft/SKILL.md) is mandatory before writing the page's text and before reviewing it. For the visual work, load the `frontend-design` skill when it is available, and use it only to match the project's look reference, never to restyle it. Without it, copy the look reference's tokens and parts directly.

`<skill>` below is the folder holding this file. Run scripts with `/usr/bin/python3 -I`.

## When

Use it when:

- A UI behaviour has a real choice: two or more designs a reasonable person could pick, with different costs. Status marks, an icon, a picker, a flow such as starting a session in a folder.
- One behaviour has many states (empty, running, failed, huge, data gone) and nobody has drawn them yet.
- The author asks for a storyboard, mock-ups or options to compare.

Skip it for a bug fix, a change the spec already settles, or a choice with a conventional default (Cmd+Q quits, Esc closes a dialog). Build those directly.

## Inputs

Each input is needed. Ask for a missing one, one question at a time, with its default.

1. **The question,** in one line, in the author's words: "How does New session pick its folder?" Default: derive it from the request and confirm it.
2. **Look reference:** the file that defines the look (a prototype page, the app's CSS and markup) and the project's design rules (`AGENTS.md`, a visual-system section). The storyboard draws with these tokens and parts. Default: the app's CSS and markup found in the repository. With no look reference at all, the skeleton's tokens are used and the page says so.
3. **Behaviour spec:** the requirements doc sections the question touches, with their ids, and earlier decisions and design notes about it. Default: the requirements doc sections that use the question's terms.
4. **Current code** for what exists today: the screens, keys and data the scenarios start from. Default: the screens you find for the question in the code.
5. **Earlier storyboards** in the project, for the page conventions already in use. Default: `prototype/*-storyboard.html`, or none.

## Process

1. **Frame.** List the scenarios (first use, daily use, at scale, broken data, keyboard path) and, for each, whether its choice is real. Write the list in the brief, not to the author.
2. **Delegate.** Start the Builder ("Spawns" below) in the background, following the delegation rule for deliverables the user reviews in the global instructions (`instructions/global.md` in the harness, installed as `~/.claude/CLAUDE.md` or `~/.config/opencode/AGENTS.md`). Its description begins `For review: ` (for example `For review: folders storyboard`), and its whole prompt is the Builder brief from `references/brief.md`, filled in.
3. **Check** the result when it returns, before showing it:
   - Run `/usr/bin/python3 -I <skill>/scripts/shoot.py <page>` and look at both screenshots, light and dark. They go to the temp folder, never into the project.
   - Read the page cold against the rules below and `references/page.md`. Fix what fails, in place.
4. **Hand over and stop.** Tell the author what it is, where it is, how to open it ("double-click `prototype/<topic>-storyboard.html`"), and what to look at first (the summary, then the scenario with the hardest choice). Wait for the author's review. Build nothing on it yet.
5. **Record the decisions** when the author answers. In the requirements doc (through [publishing.md](../harness-common/references/publishing.md) when it lives in a document tool):
   - each answer as a dated decision, numbered as the question was asked;
   - each requirement change applied to its section, under the id the summary gave it;
   - a design note per decided question: the chosen option, then each losing option with the one line on why it lost, so it does not come back;
   - one line naming the storyboard as design history, and that the requirements doc wins where they differ.
   Then add one line at the top of the storyboard: "Decided on <date>; the requirements doc wins where they differ." Leave the mock-ups as they were.
6. **Build** from the requirements doc, not from the storyboard.

A later change of mind goes into the requirements doc as a new dated decision that says what it supersedes. The storyboard is not reworked; a new question gets a new storyboard.

## Page

The full layout and the writing of captions and options are in `references/page.md`. `references/skeleton.html` is a starting file with each block in place and invented data. The order:

1. **Title and one line** saying what question the page answers and that all content is invented.
2. **Summary:** the recommended design in bullets, the requirement changes with their ids (new ids marked "New"), the open questions for the author.
3. **The design in one picture:** the recommended design at its busiest, in one frame.
4. **One section per scenario:** a lede with the concrete situation, then the options where the choice is real, then the recommended flow as a strip of numbered states, each with what you do and what you see.
5. **Keyboard path,** when the app is key-driven: a table of each task, its keys and its count of presses.
6. **Edge cases:** empty, huge, broken or missing data, each drawn, not described.
7. **Rejected:** options considered and not drawn, one line each on why they lost.
8. **Footer:** project, topic, date, "All content is invented."

## Rules

- **One file, offline.** Inline CSS and JS, no network request, opens by double-click from the file system. Fonts are the project's bundled fonts, loaded by a relative path from the storyboard's folder; without bundled fonts, use system fonts. No web fonts from a CDN.
- **Invented data only.** Never real names, people, tickets, pull request numbers, customers, paths from the author's machine or text from real transcripts. Invent concrete, plausible data (`~/dev/demo-app`, "812 past sessions") and say so on the page.
- **Match the look reference exactly.** Copy its tokens (colours, type, spacing, radii, line widths) and draw its existing parts as they are. A storyboard proposes behaviour, not a new look: change only the element under review, and every other element keeps the app's look and placement. Draw at the sizes the app uses, with frames at the app's window size.
- **Real choices only.** Show two or three options side by side only where the choice is real. Mark exactly one "Recommended" with a one-line why; give each other option a one-line reason it loses. Where the choice is not real, show only the recommended flow.
- **One way to do each thing** in the recommendation. Two paths to the same result is a losing option, not a feature.
- **Light and dark.** The page follows the system appearance, has one button to switch, and reads `?theme=light` or `?theme=dark` for screenshots. Every frame works in both themes.
- **Shape carries meaning.** When marks or icons are part of the choice, add a greyscale row so each is told apart without colour, and a reduced-motion preview when anything moves. The system's reduced-motion setting stops every animation, as the preview does.
- **Headless checks only.** Verify with `shoot.py`: it runs `chrome-headless-shell` only, with its own temporary profile. Never launch a browser app (Google Chrome.app, Chromium.app), not even with `--headless`: on macOS it registers as an app and takes the author's focus. Without the shell, install it with `npx playwright install --only-shell`.
- **The project's own rules come first.** When `AGENTS.md` or the design rules say more (no ALL CAPS, 1px lines, motion rules), the storyboard follows them, in every option, including the losing ones.

## Where the file lives

- `prototype/<topic>-storyboard.html` next to the project's look reference, or the folder where the project keeps its design files. `<topic>` is the author's word for the question, in kebab case: `status`, `needs-you`, `folders`.
- A review of an asset (an icon, a logo) lives beside the asset, as `preview.html` in its folder, so it shows the real exported files.
- Commit it only when the user asks.

## Spawns

| Spawn | Tier | Used for |
|---|---|---|
| `general` | `strong` | the storyboard Builder |

- Models: run the tier gate in [model-tiers.md](../harness-common/references/model-tiers.md) before the spawn. On opencode, `apply-tiers` takes `--general strong`.
- The brief follows [subagents.md](../harness-common/references/subagents.md). Never give the Builder the conversation or your preferred option: it derives the options from the sources.

## State

The skill keeps no resume file ([state.md](../harness-common/references/state.md) "Single-spawn skills"):

- When the work has an ai-notes area, the `Models for this run` table and the `Next:` line go in its "State (start here)" section.
- Otherwise the gate runs in the session, and the hand-over ends with a fenced resume prompt:

```
Use the storyboard skill. Record the decisions for <project>/prototype/<topic>-storyboard.html.
```
