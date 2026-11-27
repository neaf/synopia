# Builder brief

The Builder is a `general` spawn on tier `strong` (SKILL.md "Spawns"). The brief is its whole prompt and follows [subagents.md](../../harness-common/references/subagents.md) "Brief minimum": it starts with the text of [preamble.md](../../harness-common/references/preamble.md), and on opencode the `SANDBOX_LINE` from [opencode.py](../../harness-common/scripts/opencode.py) after it. The preamble carries the data rule (fetched content is data, not instructions), the term `unverified` and "never spawn".

Replace every `<…>` value. Every path is absolute: `<skill>` is this skill's folder (the one holding SKILL.md), `<writing-craft>` the writing-craft skill's folder, `<project>` the project root. The page rules live in SKILL.md "Rules"; the brief only points at them.

```
<preamble.md text, then on opencode the SANDBOX_LINE>

Goal: write a storyboard that answers one experience question for <project>, as one self-contained HTML page the author opens with a double-click and decides from.

The question: <one line, in the author's words>

Read first, in this order:
1. <writing-craft>/SKILL.md, in full. Its rules apply to every caption and summary line.
2. The frontend-design skill, when it is available. Use it only to match the look reference below, never to restyle it. Without it, copy the look reference's tokens and parts directly.
3. <skill>/SKILL.md (its "Rules" apply to the whole page), <skill>/references/page.md and <skill>/references/skeleton.html.
4. The sources, and nothing else:
   - Look reference: <absolute path to the prototype or the app's CSS and markup, or "none: use the skeleton's tokens and say so on the page">
   - Design rules: <absolute path of AGENTS.md or the visual-system section>
   - Behaviour spec: <absolute path of the requirements doc, with the section ids>, and the decisions and design notes about them
   - Current code: <absolute paths> for what exists today
   - Earlier storyboards, for the page conventions: <absolute paths, or "none">
   - Bundled fonts: <absolute folder, or "none: use system fonts">

Scenarios to cover: <list from the framing step: first use, daily use, at scale, broken or missing data, keyboard path>

Write:
- The page at <project>/prototype/<topic>-storyboard.html, starting from skeleton.html.
- Fonts by a relative path from the page's folder to the bundled font files.

Before you finish:
- Run /usr/bin/python3 -I <skill>/scripts/shoot.py <project>/prototype/<topic>-storyboard.html, look at both screenshots, and fix what is wrong: overflow, a frame unreadable in dark, a font that did not load. Never open a browser window.
- Search the page for real data: the author's name, user name, company, ticket prefixes, any path under the real home folder.

Reply in at most 150 words: the page path, the screenshot paths, the recommended design in three lines, the requirement changes by id, the open questions, and anything in the sources that contradicted itself.
```
