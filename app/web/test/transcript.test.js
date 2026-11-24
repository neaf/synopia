// transcript.js: a block's signature and how a turn ends in the log, on stand-ins of the browser globals.
import "./stub-dom.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { itemsHTML, filesHTML } from "../js/transcript.js";
import { live, age, until, still } from "../js/format.js";

test("web-ui#B6: the ticking spans don't change a block's signature, other text does", () => {
  const at = Date.now() + 38_000;
  const block = left => `<div class="ln liveln"><b>Working</b> <span class="dim">Retrying <span data-until="${at}">${left}</span>, attempt 2</span></div>`;
  assert.equal(still(block("in 38s")), still(block("in 37s")));
  assert.equal(still(block("in 1s")), still(block("now")));
  assert.equal(still(`<p>${until(at)}</p>`), still(`<p>${until(at).replace(/in \d+s/, "now")}</p>`));
  assert.equal(still(`<p>${live("2026-11-20T10:00:00.000Z", 1000)}</p>`), still(`<p>${live("2026-11-20T10:00:00.000Z", 61_000)}</p>`));
  assert.equal(still(`<p>${age(Date.now())}</p>`), still(`<p>${age(Date.now()).replace("0 min", "1 min")}</p>`));
  assert.notEqual(still(block("in 38s").replace("attempt 2", "attempt 3")), still(block("in 38s")));
  assert.notEqual(still(`<span data-until="${at}">in 3s</span>`), still(`<span data-until="${at + 1}">in 3s</span>`));
});

const s = { id: "s1", items: [], agents: [], background: [], state: { light: "amber", driven: false } };
const keys = out => out.map(([k]) => k.replace(/:.*/, ""));
const text = out => out.map(([, h]) => h).join("");

test("a finished turn ends with its Worked for line", () => {
  const items = [
    { id: "u1", k: "you", ts: "2026-11-20T14:24:00.000Z", text: "Go" },
    { id: "c1", k: "claude", ts: "2026-11-20T14:24:05.000Z", text: "Done." },
  ];
  const out = itemsHTML(items, false, s);
  assert.deepEqual(keys(out), ["day", "you", "c1", "done"]);
  assert.match(text(out), /Worked for 5s, done /);
  assert.deepEqual(keys(itemsHTML(items, true, s)), ["day", "you", "c1"], "no Worked for while it runs");
});

test("FR-NEED-02: a turn waiting for you ends with Files changed, then one Waiting for you line, no Worked for", () => {
  const patch = { file: "~/dev/app/a.txt", abs: "/Users/fixture/dev/app/a.txt", add: 1, del: 0, hunks: [{ o: 1, n: 1, lines: ["+a"] }] };
  const items = [
    { id: "u1", k: "you", ts: "2026-11-20T14:24:00.000Z", text: "Go" },
    { id: "t1", k: "tool", name: "Edit", verb: "Edited", obj: "a.txt", state: "done", patch, ts: "2026-11-20T14:24:02.000Z" },
    { id: "q1", k: "ask", ts: "2026-11-20T14:24:03.000Z", state: "pending", qs: [{ q: "Which?", opts: [["A", ""]] }], request: { toolName: "AskUserQuestion" } },
  ];
  const out = itemsHTML(items, false, s);
  assert.deepEqual(keys(out), ["day", "you", "run", "files", "wait"]);
  assert.equal((text(out).match(/Waiting for you/g) || []).length, 1);
  assert.ok(!text(out).includes("Worked for"));
});

test("FR-NEED-09: a question left without a request after Synopia's process ended reads Not answered", () => {
  const items = [
    { id: "u1", k: "you", ts: "2026-11-20T14:24:00.000Z", text: "Go" },
    { id: "q1", k: "ask", ts: "2026-11-20T14:24:03.000Z", state: "pending", qs: [{ q: "Which?", opts: [["A", ""]] }] },
  ];
  const out = itemsHTML(items, false, s);
  assert.deepEqual(keys(out).slice(-2), ["q1", "na"]);
  assert.match(text(out), /Not answered \(Synopia quit\)/);
});

test("files changed group by repo and align their counts", () => {
  const p = (file, add, del) => ({ file, abs: file.replace("~", "/Users/fixture"), add, del, hunks: [{ o: 1, n: 1, lines: ["+x"] }] });
  const html = filesHTML([p("~/dev/app/src/a.ts", 3, 1), p("~/dev/app/b.ts", 1, 0), p("~/dev/lib/c.ts", 0, 2)], "k");
  assert.deepEqual([...html.matchAll(/<div class="root">([^<]*)<\/div>/g)].map(m => m[1]), ["~/dev/app", "~/dev/lib"]);
  assert.match(html, /3 files, click one to see the diff/);
  assert.match(html, /<span class="add">\+3<\/span> <span class="del">−1<\/span>/);
});
