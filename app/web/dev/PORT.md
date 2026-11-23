# Port of prototype/app.html (S1-3)

The page in `app/web/` is `prototype/app.html` (1642 lines) split into classic scripts. Code moved line for line, apart from the drops below and a header comment per file. CSS lost its 2-space `<style>` indent.

## Where each line range went

| Prototype lines | Went to | Notes |
|---|---|---|
| 1-12 | `index.html` head | Favicons and the Google Fonts link as they were. |
| 13, 707 | (replaced) | `<style>` became `<link rel="stylesheet" href="css/app.css">`. |
| 14-706 | `css/app.css` | Minus the dropped rules below. |
| 708-718 | `index.html` body | Without `<span id="exported">`. |
| 720-721 | `index.html` | `transcripts.js` and `menu.js` tags kept. Until S1-5 the data comes from them. |
| 740-741, 785-796 | `js/store.js` | `data`, `shape()` without OVERLAY and the demo, status derivation, `current`. |
| 797 | `js/composer.js` | `attachments`. |
| 799-853 | `js/md.js` | `esc`, `dur`, `clock`, `md`, `parseAnswers`. |
| 855-928 | `js/sidebar.js` | Rows, layout, `renderSide`. |
| 930-995 | `js/dnd.js` | Pointer-event drag and drop. |
| 997-1073 | `js/transcript.js` | Tool lines, files changed and diffs. |
| 1075-1128, 1138-1153, 1155-1171 | `js/marks.js` | The `P` table, `ind`, `kind`, mark keys, the later `P` overrides. |
| 1131-1137 | `js/store.js` | `reviewed`, `isReview`, `toReview`, `interrupted`, `bgRunning`. |
| 1173-1210 | `js/transcript.js` | Live times, `view`, agents, `waveHTML`. |
| 1212-1250 | `js/rail.js` | Background work panel. |
| 1251-1403 | `js/transcript.js` | `itemsHTML`, `liveLine`, `statusLine`, `renderConv`. |
| 1406-1459 | `js/composer.js` | Slash menu and model picker. |
| 1462-1549 | `js/card.js` | Question, permission and plan card, and its keys. |
| 1551-1599, 1601 | `js/keys.js` | Modes, keys, toast, New session, ⌘⇧[ ⌘⇧], `renderAll`. |
| 1628-1634, 1637-1638 | `js/bridge.js` | 1 s timer, first `renderAll()`, the `?agent=` and `?open=` hooks. Otherwise a stub for S1-5. |

Script order in `index.html`: marks, md, store, sidebar, dnd, transcript, rail, card, composer, keys, bridge. Only `store.js` (reads `window.TRANSCRIPTS`), `composer.js` (reads `window.MENU`), `dnd.js` and `keys.js` (bind to `#groups` and `#new`) run code at load. `bridge.js` makes the first render, so it must stay last.

## Dropped

| Prototype lines | What |
|---|---|
| 58-60 | `.g-why` rules. |
| 75, 93, 530, 542 | `.r-drift` and `.c-drift` rules (drift warning). |
| 266-269, 271-272 | `.ping` rules and their comment. Line 270 (`.status[data-state="red"]`) kept. |
| 478-480, 574-578 | `.gagg` rules. |
| 610, 615 | `.mode` rules. |
| 681 | `.demo-tag` rule ("test state" tag). |
| 714 (part) | `<span id="exported">` footer. |
| 722-738 | `OVERLAY` and `GROUPS`. |
| 741 (part) | The OVERLAY merge and `applyDemo()` in `shape()`. Sessions now get `title: t.title \|\| t.name, now: ""`, which is what `shape()` gave any session not in OVERLAY. |
| 743-784 | `?demo=` and its fake asks. |
| 864 | Drift line in the sidebar row. |
| 880-881 (part) | `GROUPS` in the first layout: now `groups: []`, every session under "Not in a group". |
| 906-908 | `agg` and `counts` for `.gagg`, computed and never shown. |
| 1327 (part) | "test state" tag in the header. |
| 1329 | Drift warning and "Split into a new session". |
| 1359 | "Split into a new session" handler. |
| 1393 | `#send` lookup. |
| 1555-1556 | `#mode` writer in `paintMode`. |
| 1600 | "exported" footer text ("4 open sessions"). |
| 1603-1627 | 10 s `transcripts.js` reload. |
| 1635-1636, 1639 | `?type=`. |

Kept although the plan's list names it: the `.slash` rules (203-212, 609). The slash menu and the model picker draw with them (`<div class="slash" id="slash">` in `renderConv`), so they are not dead.

## Since S1-5

The data comes from the backend (`store.js`, `bridge.js`), not `transcripts.js`. `renderConv` now mounts the view once per session or subagent and calls `renderHeader`, `renderLog`, `renderCard` (in `card.js`) and `renderRail`; clicks in the view go through one delegated handler. `itemsHTML` returns keyed blocks instead of a string. Text changes: "in this prototype" dropped from the earlier-items and diff-cut lines, the "Tab" clause shows only with a tab name, the subagent placeholder is "Message <session title>, / for commands", and the New session, Close session, send and model toasts name the task that brings them.
