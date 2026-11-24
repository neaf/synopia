// md.js: markdown as the CLI renders it, and the answer text of a question card, in Node (DOM-free).
import { test } from "node:test";
import assert from "node:assert/strict";
import { md, parseAnswers, parseNotes } from "../js/md.js";

const A = url => `<a href="${url}" target="_blank" rel="noreferrer">`;

test("links, code and bold", () => {
  assert.equal(md("Read `a<b` and **this**: https://example.com/a?b=1&c=2."),
    `<p>Read <code>a&lt;b</code> and <b>this</b>: ${A("https://example.com/a?b=1&amp;c=2")}https://example.com/a?b=1&amp;c=2</a>.</p>`);
  assert.equal(md("[the docs](https://example.com/x)"), `<p>${A("https://example.com/x")}the docs</a></p>`);
  assert.equal(md("`https://example.com/in-code`"), `<p><code>${A("https://example.com/in-code")}https://example.com/in-code</a></code></p>`);
  // bold holding code spans, as Claude writes "**`b`, `b`:** sends …"
  assert.equal(md("**`b`, `b`:** sends"), "<p><b><code>b</code>, <code>b</code>:</b> sends</p>");
  assert.equal(md("**see `a<b`**"), "<p><b>see <code>a&lt;b</code></b></p>");
  assert.equal(md("[Image #2] here"), '<p><span class="img-tag">[Image #2]</span> here</p>');
});

test("a single newline is a line break, a blank line a paragraph, as in the CLI", () => {
  assert.equal(md("Roses are red,\nviolets are blue.\n\nThe end."), "<p>Roses are red,<br>violets are blue.</p><p>The end.</p>");
  assert.equal(md("> one\n> two"), "<blockquote>one<br>two</blockquote>");
  assert.equal(md("**bold\nacross** a break"), "<p><b>bold<br>across</b> a break</p>");
  assert.equal(md("a <b>\nhttps://example.com/x\n`c<d`"),
    `<p>a &lt;b&gt;<br>${A("https://example.com/x")}https://example.com/x</a><br><code>c&lt;d</code></p>`);
  assert.equal(md("```\na\nb\n```"), "<pre><code>a\nb</code></pre>");
  assert.ok(!md("| a |\n|---|\n| b |").includes("<br>"));
});

test("headings and lists: nested content, numbering kept across blank lines, a written start", () => {
  assert.equal(md("## Title"), "<h4>Title</h4>");
  const src = "1. **Counts** (`x.rb`). Main issue.\n   - `a` counts files.\n   - `b` counts more.\n\n   So it's wrong.\n\n2. **Checks** outside.\n\n3. **Small one.**";
  const html = md(src);
  assert.equal((html.match(/<ol/g) || []).length, 1, "one list, not one per point");
  assert.equal((html.match(/<ol>/g) || []).length, 1, "it starts at 1");
  assert.match(html, /<li><p><b>Counts<\/b>[\s\S]*<ul><li><code>a<\/code> counts files.<\/li><li><code>b<\/code> counts more.<\/li><\/ul><p>So it&#39;s wrong.<\/p><\/li><li><b>Checks<\/b> outside.<\/li><li><b>Small one.<\/b><\/li><\/ol>/);
  assert.equal(md("4. four\n5. five"), '<ol start="4"><li>four</li><li>five</li></ol>');
  assert.equal(md("- a\n- b\n  more of b\n- c"), "<ul><li>a</li><li>b<br>more of b</li><li>c</li></ul>");
});

test("tables: a head, a body, the separator row dropped", () => {
  assert.equal(md("| a | b |\n|---|:-:|\n| 1 | `x` |"),
    "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td><code>x</code></td></tr></tbody></table>");
});

test("web-ui#B2: a table of separators only renders as text instead of throwing", () => {
  assert.equal(md("| --- |"), "<p>| --- |</p>");
  assert.equal(md("| --- | :-: |\n|---|---|"), "<p>| --- | :-: |<br>|---|---|</p>");
  assert.equal(md("Before\n\n| --- |\n\nAfter"), "<p>Before</p><p>| --- |</p><p>After</p>");
});

test("web-ui#B2: a data row whose first cell starts with two hyphens stays", () => {
  assert.equal(md("| flag | means |\n|---|---|\n| --force | no checks |\n| -n | dry run |"),
    "<table><thead><tr><th>flag</th><th>means</th></tr></thead><tbody><tr><td>--force</td><td>no checks</td></tr><tr><td>-n</td><td>dry run</td></tr></tbody></table>");
});

test("a question card's answers and notes, from the CLI's tool result", () => {
  const a = `User has answered your questions: "Which?"="Option A" notes: keep it short. "Then?"="B, C". Read the answers carefully and continue.`;
  assert.deepEqual(parseAnswers(a), ["Option A", "B, C"]);
  assert.deepEqual(parseNotes(a), ["keep it short", ""]);
  assert.deepEqual(parseAnswers(null), []);
});
