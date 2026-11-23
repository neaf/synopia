# Checking the page without real data

The page gets its data from the backend over `/ws`. To see it without real sessions, run the backend with the fake driver:

```sh
app/dev.sh --fake                 # prints "Open in Chrome: http://127.0.0.1:4717/?token=…"
```

`--fake` serves every session in the backend fixture tree (`app/backend/test/fixtures/claude/projects/`, made up) and plays `app/backend/test/fixtures/claude/fake-script.json`: a question with a multi-select (`#22222222`), a permission with an "Always allow" suggestion (`#33333333`), a plan (`#55555555`), a working session with subagents and a stream preview (`#44444444`), and a session with diffs (`#11111111`). The script also holds the menu (models and slash commands). Pass `--claude-dir <dir>` to use another tree with its own `fake-script.json`. The hooks `?agent=<id>` (open a subagent) and `&open=1` (expand the last diff) still work.

## Compare the port with the prototype

```sh
app/web/dev/compare.sh            # writes /tmp/synopia-compare/shots/<state>-proto.png and <state>-port.png
```

It starts `dev.sh --fake` with a temp state folder for the port, builds `transcripts.js` and `menu.js` for a temp copy of `prototype/app.html` from the same fixtures (`build-proto-fixture.ts`, through the backend's own reader and the page's `card.js`), and takes headless Chrome screenshots at 1280x820 with reduced motion. States: waiting (question card), permission, plan, busy (subagent wave), diff, agent (subagent view). It never touches `prototype/transcripts.js`.

Expected differences, all deliberate:
- the "N open sessions" footer (dropped in S1-3);
- no "Tab “…”" clause in the header, since Synopia knows no terminal tabs;
- "… N earlier items not shown" and "diff cut at 400 lines" without "in this prototype" (so a cut diff is a little narrower);
- the subagent view's placeholder says "Message <session title>", not "… about this subagent".
