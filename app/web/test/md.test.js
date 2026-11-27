// md.js: markdown as the CLI renders it, and the answer text of a question card, in Node (DOM-free).
import { test } from "node:test";
import assert from "node:assert/strict";
import { md, colKinds, colAlign, parseAnswers, parseNotes, linkText } from "../js/md.js";

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
    '<div class="tw"><table><thead><tr><th class="num c0">a</th><th class="short ac">b</th></tr></thead><tbody><tr><td class="num c0">1</td><td class="short ac"><code>x</code></td></tr></tbody></table></div>');
});

test("a table of separators only renders as text instead of throwing", () => {
  assert.equal(md("| --- |"), "<p>| --- |</p>");
  assert.equal(md("| --- | :-: |\n|---|---|"), "<p>| --- | :-: |<br>|---|---|</p>");
  assert.equal(md("Before\n\n| --- |\n\nAfter"), "<p>Before</p><p>| --- |</p><p>After</p>");
});

test("a data row whose first cell starts with two hyphens stays", () => {
  assert.equal(md("| flag | means |\n|---|---|\n| --force | no checks |\n| -n | dry run |"),
    '<div class="tw"><table><thead><tr><th class="c0">flag</th><th class="short">means</th></tr></thead><tbody><tr><td class="c0">--force</td><td class="short">no checks</td></tr><tr><td class="c0">-n</td><td class="short">dry run</td></tr></tbody></table></div>');
});

test("table columns: numbers with units, long text, short, the first column", () => {
  const rows = [
    ["`sidebar/projects` (recent list)", "418k + 386k", "~44 ms", "0.02%", "2026-11-18", "n/a", "Fine for now; the search half is the slow one and has its own ticket", "1.2M"],
    ["`auth/refresh`", "1.2M", "1.9 s", "4.80%", "2026-11-20", "35%", "Fine", "**8k**"],
  ];
  assert.deepEqual(colKinds(rows), ["c0", "num", "num", "num", "short", "num", "prose", "num"]);
  // one cell of text makes the column text; an empty cell doesn't; a column of dates only is not numbers
  assert.deepEqual(colKinds([["a", "65 ms", "3", "2026-11-18"], ["b", "timed out", "", "2026-11-19"]]), ["c0", "short", "num", "short"]);
  assert.deepEqual(colKinds([["10", "x"], ["[12](https://example.com/12)", "y"]]), ["num", "short"]);
  assert.deepEqual(colKinds([]), []);
});

test("table alignment: the separator row's colons, else the column's kind", () => {
  assert.deepEqual(colAlign(["---", ":--", ":-:", "--:", ":---:"]), ["", "l", "c", "r", "c"]);
  const html = md("| name | n | note |\n|:-:|:--|---:|\n| a | 3 ms | ok |");
  assert.match(html, /<td class="c0 ac">a<\/td><td class="num al">3 ms<\/td><td class="short ar">ok<\/td>/);
  assert.match(md("| name | n |\n|---|---|\n| a | 3 ms |"), /<td class="num">3 ms<\/td>/);
});

test("a question card's answers and notes, from the CLI's tool result", () => {
  const a = `User has answered your questions: "Which?"="Option A" notes: keep it short. "Then?"="B, C". Read the answers carefully and continue.`;
  assert.deepEqual(parseAnswers(a), ["Option A", "B, C"]);
  assert.deepEqual(parseNotes(a), ["keep it short", ""]);
  assert.deepEqual(parseAnswers(null), []);
});

/* a list item may start with a blank line, its content on the indented lines under it (CommonMark): a bare
   `-` before an indented sub-heading and its nested list once showed as a lone dash */
test("a list item that starts blank: a bare dash, its content indented under it", () => {
  assert.equal(md("- Merged.\n-\n  **Pushed (all signed):**\n  - one\n  - two"),
    "<ul><li>Merged.</li><li><p><b>Pushed (all signed):</b></p><ul><li>one</li><li>two</li></ul></li></ul>");
  assert.equal(md("-\n  **Pushed:**\n  - one"), "<ul><li><p><b>Pushed:</b></p><ul><li>one</li></ul></li></ul>", "as the list's first item");
  assert.equal(md("1.\n   Step one"), "<ol><li>Step one</li></ol>", "an ordered one, content one space past its marker");
});
test("a list item that starts blank, then a blank line: the item is empty and the text after it is not its", () => {
  assert.equal(md("- Merged.\n- \n\n  **Pushed:**\n\n  - one"), "<ul><li>Merged.</li><li></li></ul><p>  <b>Pushed:</b></p><ul><li>one</li></ul>");
  assert.equal(md("- a\n-\n\n- b"), "<ul><li>a</li><li></li><li>b</li></ul>", "the list goes on after an empty item");
});

/* a streamed reply is rendered at every delta, so every prefix of it must render: a table row cut before its
   closing pipe ("| a | b") once looped for ever and froze the page */
test("every prefix of a reply renders, a half-written table row as text", () => {
  const src = "Intro:\n\n| Name | Count | Note |\n|:--|--:|---|\n| `a` | 12 | short |\n| b | 3 ms | x |\n\n> quote\n- item\n  1. sub\n-\n  **Sub:**\n  - x\n\n```js\nx\n```\n#### Head\n| p | q";
  for (let n = 0; n <= src.length; n++) md(src.slice(0, n));
  assert.equal(md("text\n| a | b"), "<p>text</p><p>| a | b</p>");
  assert.equal(md("| a | b"), "<p>| a | b</p>");
});

test("linkText: a tool output's URLs are links, the rest escaped, trailing punctuation outside", () => {
  assert.equal(linkText('Open https://portal.example.test/signin?a=1&b=2. Then <retry>'),
    'Open <a href="https://portal.example.test/signin?a=1&amp;b=2" target="_blank" rel="noreferrer">https://portal.example.test/signin?a=1&amp;b=2</a>. Then &lt;retry&gt;');
  assert.equal(linkText('(see http://x.test/a)'), '(see <a href="http://x.test/a" target="_blank" rel="noreferrer">http://x.test/a</a>)');
  assert.equal(linkText('javascript:alert(1) "><img>'), 'javascript:alert(1) &quot;&gt;&lt;img&gt;');
});
