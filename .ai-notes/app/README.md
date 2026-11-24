# Synopia app: handover

State on 2026-11-24, after the rearchitecture (branch `rearch`, worktree `~/dev/synopia-rearch`; tag `rearch-base` is the code before it).

## State

- The app is built and green: `app/check.sh --page` prints four pass lines (backend, shell, web, page with 22 suites).
- The rearchitecture split the backend into one module per job and one adapter per external system, moved every status rule to `status.ts`, made the page plain ES modules over one shared protocol schema (`app/web/js/protocol.js`, version 2, acked actions), gave the layout to the backend, replaced the `--fake` driver with a scripted SDK, put the daemon on a kernel lock and a `handover` field, and moved the Swift shell to async HTTP.
- Facts that used to live in this file (measurements, live runs, settled shapes) are in the topic docs. The old version of this file is at tag `rearch-base`; the topic docs cite it by section.

## How to run

- `(cd app/backend && npm ci)` once, then `app/build.sh` and `open build/Synopia.app`. `app/dev.sh` (or `--script`, no model calls) runs the backend for a browser.
- `app/check.sh --page` is the gate for every change. `app/web/dev/cdp/run.sh <suite>` runs one page check on chrome-headless-shell.
- The full command list is in `README.md`; the rules are in `AGENTS.md`.

## Where the docs are

- `docs/requirements.md` (behaviour), `docs/functional-requirements.md` (FR ids, decisions, known gaps), `docs/architecture.md` (modules, protocol, state.json, ownership), the six topic docs, `docs/Page checks.md`.

## What is left

- Before any push: scrub git history up to the rearchitecture's Phase 2 commit (real work data). Ask the user first.
- Merge `rearch` into `main` once the user agrees. Done 2026-11-24; history scrubbed, tag `rearch-base` kept (scrubbed) for the upgrade test.
- Everything else open is in `docs/functional-requirements.md` "Known gaps": three item-level status derivations still in the page (the backend fields they need are listed there), shell behaviours only a real window can show, and low-risk tooling and backend items.
- Checks in the real window that no automated check covers: the confirm sheets' text, a real ⌘V image, drag and drop with a trackpad, the title bar strip, the bundle swap while the app runs, the slow-daemon view.
