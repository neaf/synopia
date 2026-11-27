# Publishing

How a harness skill puts a page where its readers are. The calling skill names the page set, the default path and the source of truth. The mechanics below are the same for every skill.

## Source of truth

The calling skill says which copy wins:

| Skill | Source of truth | Publishing is |
|---|---|---|
| attack-plan-create | the drafts in `.attack-plan/<slug>/draft/` | a copy for reviewers. Reviewer edits flow back into the drafts. |
| qa-session | the published page | the page itself. The notes keep decisions and sources, never a second copy. |

## Choose the target

Ask once at intake and record the answer in the resume file.

- Markdown in the repository: the default.
- A document tool (Notion, a wiki, Confluence and the like) through a connected MCP server. Find its tools with the session's tool search, by the tool's name or "create page". Never guess tool names. With no such tool, tell the user and publish Markdown.

## Markdown

- Write to the calling skill's default path, or the folder the user named.
- Plain Markdown: tables with a header row, blockquotes for callouts, ```` ```mermaid ```` blocks for diagrams. Links between the pages are relative.
- Commit or open a pull request only when the user asks, or when the team commits docs of this kind. Otherwise the file stays uncommitted; to keep it out of `git status`, use `.git/info/exclude` ([state.md](state.md) "Private state").
- Reviewers comment in a pull request or in the file. Read those comments before the next rework.

## Document tool

1. Create the pages from the Markdown. Map the parts:
   - the first heading becomes the title;
   - blockquotes become the tool's callout block, keeping the bold labels;
   - checkboxes become the tool's to-do blocks;
   - tables become the tool's tables, with the same columns;
   - Mermaid blocks become code blocks in Mermaid.
2. Record each page's URL, and its id when the tool needs one, in the resume file.
3. Read back each page after each write. Compare with the Markdown: headings and their numbering, checkbox count, table columns, the links between pages, and no tag showing as text. Report each difference in one line.
4. Before every update, fetch the page again.
5. Prefer small anchored edits over replacing the page. Never duplicate a page as a backup.

### Notion

Before writing, read [Notion MCP](<../topics/Notion MCP.md>): its quirks and their workarounds apply to every step here.

- Creating pages: a private page with no parent, unless the user gave a parent URL. The other pages of a set are its children. `<table-of-contents />` for the table of contents, `<callout>` for callouts, `<table>` tags for tables, `<td color="blue_bg">` and the like for colored rows.
- Updating: many small `update_content` edits, anchored on unique text, rather than one `replace_content`.
- After each write: re-fetch and check as in step 3.

## Reviewer edits

- A reviewer's edit on the published page is kept. Never restore a block they removed, and keep their wording.
- Before the next rework, compare the published page with the local copy and report each reviewer edit as a change, never overwrite it silently.

## Tool quirks

A tool quirk found during a run goes into the resume file under "Tool notes", one line each. A quirk of a tool with a topic doc goes into that doc, with symptom, cause, workaround and the step it changes.

## Every target

No tracking data, no secrets, and no personal details beyond the test data the page needs.
