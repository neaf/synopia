# Notion MCP

Facts about writing Notion pages through the Notion MCP server's tools (`fetch`, `create`, `update_content`, `replace_content`, comments), directly or through a gateway that fronts several MCP servers. No script talks to Notion; the orchestrator calls the tools.

Every fact here comes from earlier projects and was not checked in this repo: all are `unverified`. Source: the Notion section of `skills/attack-plan-create/references/publishing.md` at tag `rearch-base`.

Used by: `skills/harness-common/references/publishing.md`, section "Notion", which every harness skill publishes through. Each quirk's code location is the publishing step that applies its workaround, or none when the step only links this doc.

## Tools and sessions

| Fact | Source |
|---|---|
| A gateway lists its servers; Notion has to be turned on, then its tools are found by searching with the server's prefix. | `unverified` |
| `update_content` replies with only `{page_id}` when every `old_str` matched. A miss comes back as `warnings: no_match`. | `unverified` |
| Table cells take a background color, `<td color="blue_bg">`. A colored row also gives a unique anchor when several rows share the same text. | `unverified` |
| Notion keeps a page history, so a duplicate page is not needed as a backup. | `unverified` |

## Quirks

### Session expiry

- Symptom: a write fails partway through a long publish.
- Cause: MCP sessions expire. `unverified`.
- Workaround: probe the tools again right before a long write.
- Code: none. `publishing.md` "Notion" links this doc; the orchestrator applies the workaround from here.

### Page too large to create

- Symptom: the create call refuses the page.
- Cause: a size limit on one call; the limit is unknown. `unverified`.
- Workaround: create the page with its first sections, then append each next section in order.
- Code: none. `publishing.md` "Notion" links this doc; the orchestrator applies the workaround from here.

### Quote at the top swallows the page

- Symptom: the page renders as one quote block.
- Cause: a `>` quote as the first block. `unverified`.
- Workaround: use `<callout>` for scope and evidence callouts.
- Code: `publishing.md` "Notion", "Creating pages".

### Tables come back as pipe rows

- Symptom: a table written as `<table header-row="true"><tr><td>…</td></tr></table>` comes back as pipe rows on the next fetch.
- Cause: fetch returns simple tables in pipe form. The write did not fail. `unverified`.
- Workaround: write tables with `<table>` tags, never pipe rows. When reading pipe rows back, do not split them naively: empty cells shift the columns.
- Code: `publishing.md` "Notion", "Creating pages".

### Nested list indentation changes

- Symptom: nested list items come back indented with two spaces.
- Cause: fetch normalizes the indentation. `unverified`.
- Workaround: indent nested items with tabs when writing. Compare structure, not whitespace, when reading back.
- Code: none. `publishing.md` "Notion" links this doc; the orchestrator applies the workaround from here.

### `+ ` at the start of a cell becomes a bullet

- Symptom: a table cell that starts with `+ ` shows a bullet.
- Cause: the text is read as a list item. `unverified`.
- Workaround: after writing, scan the fetched page for ` • ` and fix the cells.
- Code: `publishing.md` "Notion", "After each write" (the re-fetch); the ` • ` scan is from here.

### One stray backtick collapses the page

- Symptom: the whole page turns into one block.
- Cause: an unbalanced backtick opens a code span that never closes. `unverified`.
- Workaround: check that backticks are balanced before every write.
- Code: none. `publishing.md` "Notion" links this doc; the orchestrator applies the workaround from here.

### `old_str` with a mention does not match

- Symptom: `update_content` returns `warnings: no_match`.
- Cause: an `old_str` that contains a `<mention …>` tag often does not match the stored text. `unverified`.
- Workaround: anchor on the text around the mention.
- Code: `publishing.md` "Notion", "Updating" (anchored edits); anchoring around a mention is from here.

### Bold text with inline code is split

- Symptom: a search for the written string misses an edit that did land.
- Cause: bold text containing inline code is split into several runs on save. `unverified`.
- Workaround: verify by re-fetching the section, not by searching for the exact string.
- Code: `publishing.md` "Notion", "After each write".

### Replacing text drops comment anchors

- Symptom: comment threads detach from the text after an update.
- Cause: replacing text drops the `discussion-urls` spans that attach threads. `unverified`.
- Workaround: fetch with discussions first, then wrap the new text in the same discussion URLs. Prefer many small anchored `update_content` edits over `replace_content`; they keep mentions, tables and threads.
- Code: `publishing.md` "Notion", "Updating" (small anchored edits); the `discussion-urls` wrap is from here.

### Gateway firewall blocks some calls

- Symptom: a gateway rejects a call.
- Cause: its firewall blocks scripts with regex lookbehinds or other unusual patterns. `unverified`.
- Workaround: split the work into smaller, simpler calls.
- Code: none. `publishing.md` "Notion" links this doc; the orchestrator applies the workaround from here.
