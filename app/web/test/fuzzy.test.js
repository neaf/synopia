// js/fuzzy.js, the one matcher (R3.14): nota's scores and ranking on the storyboard's invented data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { match, rank, marked } from "../js/fuzzy.js";

test("letters in order, gaps allowed, case and accents aside", () => {
  assert.deepEqual(match("dmapp", "~/dev/demo-app"), { score: 115, at: [6, 8, 11, 12, 13] });
  assert.ok(match("CAFE", "Café menu"));
  assert.equal(match("ppa", "~/dev/demo-app"), null, "in order only");
  assert.deepEqual(match("", "anything"), { score: 0, at: [] });
});

test("word starts rank first: nots finds ~/dev/notes before ~/work/release-notes", () => {
  const rows = ["~/work/release-notes", "~/dev/notes", "~/dev/scratch"];
  assert.deepEqual(rank(rows, "nots", r => r).map(h => h.row), ["~/dev/notes", "~/work/release-notes"]);
});

test("every word must match, in any order, and the scores add up", () => {
  const rows = ["Invoice export: CSV columns ~/work/web-shop", "Billing page: currency rounding ~/work/web-shop"];
  assert.deepEqual(rank(rows, "csv invoice", r => r).map(h => h.row), [rows[0]]);
  assert.equal(rank(rows, "invoice csv", r => r)[0].score, match("invoice", rows[0]).score + match("csv", rows[0]).score);
});

test("a tie keeps the list's order, or goes to more matched letters in the title", () => {
  const tie = [{ t: "zz api", f: "x" }, { t: "zz", f: "api" }];
  const byTitle = rank(tie, "api", r => `${r.t} ${r.f}`, r => [...r.t].length);
  assert.equal(byTitle[0].score, byTitle[1].score);
  assert.deepEqual(byTitle.map(h => h.row.t), ["zz api", "zz"]);
  assert.deepEqual(rank([...tie].reverse(), "api", r => `${r.t} ${r.f}`).map(h => h.row.t), ["zz", "zz api"], "no title rule: list order");
});

test("marked: escaped text, matched runs in one <b class=\"m\">, from an offset", () => {
  assert.equal(marked("a<b>c", [0, 1]), '<b class="m">a&lt;</b>b&gt;c');
  assert.equal(marked("web-shop", [12, 13], 10), 'we<b class="m">b-</b>shop');
  assert.equal(marked("plain", []), "plain");
});
