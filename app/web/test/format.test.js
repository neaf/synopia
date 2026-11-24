// format.js: escaping, durations, clocks and the model label, in Node (the module is DOM-free).
import { test } from "node:test";
import assert from "node:assert/strict";
import { esc, took, tookLive, dur, left, live, age, until, hhmm, modelLabel } from "../js/format.js";

test("esc escapes the five characters, and null as empty", () => {
  assert.equal(esc(`<a href="x" title='y'>&</a>`), "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(0), "0");
});

test("took: seconds under a minute, then minutes, then hours", () => {
  assert.equal(took(0), "1s");
  assert.equal(took(5_000), "5s");
  assert.equal(took(29_000), "29s");
  assert.equal(took(8 * 60_000), "8m");
  assert.equal(took(72 * 60_000), "1h 12m");
});

test("tookLive: to the second under an hour", () => {
  assert.equal(tookLive(-5), "0s");
  assert.equal(tookLive(42_400), "42s");
  assert.equal(tookLive(185_000), "3m 05s");
  assert.equal(tookLive(72 * 60_000 + 9_000), "1h 12m");
});

test("dur and left count from now", () => {
  const now = Date.now();
  assert.equal(dur(now), "0 min");
  assert.equal(dur(now - 5 * 60_000), "5 min");
  assert.equal(dur(now - 130 * 60_000), "2 h 10 min");
  assert.equal(dur(now - 3 * 86_400_000), "3 d");
  assert.equal(dur(now + 60_000), "0 min");
  assert.equal(left(now + 38_200), "in 38s");
  assert.equal(left(now - 1000), "now");
});

test("the ticker's spans carry what they count from, escaped", () => {
  assert.match(live("2026-11-20T10:00:00.000Z", 42_000), /^<span data-live="2026-11-20T10:00:00.000Z">42s<\/span>$/);
  assert.match(age(Date.now() - 5 * 60_000), /^<span data-age="\d+">5 min<\/span>$/);
  assert.match(until(Date.now() + 10_400), /^<span data-until="\d+">in 10s<\/span>$/);
  assert.ok(!live(`"><b>`, 0).includes("<b>"));
});

test("hhmm follows the app's 12- or 24-hour setting", () => {
  const ts = new Date(2026, 10, 20, 14, 24).getTime();
  try {
    globalThis.SYNOPIA_CLOCK24 = true;
    assert.match(hhmm(ts), /^14.24$/);
    globalThis.SYNOPIA_CLOCK24 = false;
    assert.match(hhmm(ts), /^0?2.24\s?PM$/i);
  } finally { delete globalThis.SYNOPIA_CLOCK24; }
});

test("model ids read as names", () => {
  const cases = [
    ["claude-opus-5-5", "Claude Opus 5.5"],
    ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
    ["eu.anthropic.claude-haiku-5-5", "Claude Haiku 5.5"],
    ["us.anthropic.claude-opus-5-5-v1:0", "Claude Opus 5.5"],
    ["global.anthropic.claude-sonnet-5-5", "Claude Sonnet 5.5"],
    ["anthropic.claude-haiku-5-5", "Claude Haiku 5.5"],
    ["claude-opus-5-5[1m]", "Claude Opus 5.5 (1M context)"],
    ["eu.anthropic.claude-sonnet-5-5[1M]", "Claude Sonnet 5.5 (1M context)"],
    ["claude-haiku-4-5-20251001", "Claude Haiku 4.5"],
    ["claude-opus-4-1@20250805", "Claude Opus 4.1"],
    ["claude-3-5-sonnet-20241022", "Claude Sonnet 3.5"],
    ["claude-opus-5", "Claude Opus 5"],
    ["arn:aws:bedrock:eu-west-1:123:inference-profile/eu.anthropic.claude-opus-5-5", "Claude Opus 5.5"],
    ["haiku", "Claude Haiku"],
    ["sonnet[1m]", "Claude Sonnet (1M context)"],
  ];
  for (const [id, want] of cases) assert.equal(modelLabel(id), want, String(id));
});

test("no model id reads Default, an unknown one stays as it is", () => {
  assert.equal(modelLabel(undefined), "Default");
  assert.equal(modelLabel(""), "Default");
  assert.equal(modelLabel("gpt-x"), "gpt-x");
  assert.equal(modelLabel("my-proxy-model"), "my-proxy-model");
});
