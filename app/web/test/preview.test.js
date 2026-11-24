// preview.js find: matches ignore case and land on the text shown (web-ui#B5).
import "./stub-dom.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { findIn } from "../js/preview.js";

const hits = (text, needle) => findIn(text, needle).map(([a, b]) => text.slice(a, b));

test("every match, case ignored, not overlapping", () => {
  assert.deepEqual(findIn("Foo foo FOO", "foo"), [[0, 3], [4, 7], [8, 11]]);
  assert.deepEqual(findIn("aaaa", "aa"), [[0, 2], [2, 4]]);
  assert.deepEqual(findIn("abc", ""), []);
  assert.deepEqual(findIn("abc", "x"), []);
});

test("web-ui#B5: a character whose lowercase is longer doesn't shift later matches", () => {
  // "İ" (U+0130) lowercases to two code units ("i" and a combining dot)
  assert.deepEqual(findIn("İ abc abc", "abc"), [[2, 5], [6, 9]]);
  assert.deepEqual(hits("İstanbul, then Bar", "bar"), ["Bar"]);
  // a match that takes only part of such a character covers all of it
  assert.deepEqual(hits("xİy", "xi"), ["xİ"]);
});

test("characters outside the BMP keep their offsets", () => {
  assert.deepEqual(hits("😀 Find 😀 find", "find"), ["Find", "find"]);
});
