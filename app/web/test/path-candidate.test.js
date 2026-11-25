// md.js pathCandidate (R5.9, 2026-11-25): which inline code spans are asked about as paths. DOM-free.
import { test } from "node:test";
import assert from "node:assert/strict";
import { md, pathCandidate } from "../js/md.js";

test("paths: absolute, ~/, relative with a / or an extension; a line number is dropped", () => {
  for (const [s, want] of [
    ["/tmp/demo/shots/needs-sign-in-light.png", "/tmp/demo/shots/needs-sign-in-light.png"],
    ["~/dev/demo/notes.md", "~/dev/demo/notes.md"],
    ["waiting-light.png", "waiting-light.png"],
    ["docs/Agent SDK.md", "docs/Agent SDK.md"],
    ["src/app.ts:42", "src/app.ts"],
    ["src/app.ts:42:7", "src/app.ts"],
    ["../notes.txt", "../notes.txt"],
    ["app/web", "app/web"],
    [" README.md ", "README.md"],
  ]) assert.equal(pathCandidate(s), want, s);
});

test("not paths: URLs, flags, scopes, code and plain words", () => {
  for (const s of ["https://example.com/a.png", "file:///tmp/a.txt", "mailto:a@b.c", "--dry-run", "-v", "@types/node",
    "f()", "a = b.c", "x && y/z", "ls | grep a.txt", "${HOME}/a.md", "a<b", "R5.9", "1.2.3", "e.g.", "npm", "~", "/", "//host/a",
    "~user/a.md", "git log --oneline a/b", "", "a,b.md", "obj['k'].v"]) assert.equal(pathCandidate(s), null, s);
});

test("md marks a candidate code span with data-pc, escaped; others stay plain", () => {
  assert.equal(md("Open `docs/Agent SDK.md` or `npm test`."), `<p>Open <code data-pc="docs/Agent SDK.md">docs/Agent SDK.md</code> or <code>npm test</code>.</p>`);
  assert.equal(md("`<b>/x.md`"), `<p><code>&lt;b&gt;/x.md</code></p>`);
});
