// The page's HTML builders with hostile text: nothing in a transcript, a path, a title or an id may become
// markup or an attribute. The modules load on stand-ins of the browser globals (stub-dom.js); card.js is
// still a classic script (until Phase 19), so it runs as one in a vm with the module exports it reads.
import "./stub-dom.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import * as state from "../js/state.js";
import { esc, age } from "../js/format.js";
import { md } from "../js/md.js";
import { ind } from "../js/marks.js";
import { rowHTML } from "../js/sidebar.js";
import { railHTML } from "../js/rail.js";
import { thumbsHTML } from "../js/images.js";
import { filesHTML, itemsHTML, heldHTML } from "../js/transcript.js";

const card = vm.createContext({ esc, md, ind, age, store: state.store, current: null, agentById: state.agentById, requestsOf: state.requestsOf });
vm.runInContext(readFileSync(join(import.meta.dirname, "..", "js", "card.js"), "utf8") + "\n;globalThis.P = { qaHTML, askOf };", card, { filename: "card.js" });
const { qaHTML, askOf } = card.P;

// The reviewer's payload (H1), plus an element and a single quote.
const BAD = `https://x.example/"/onmouseover=alert(document.location)//<img src=x onerror=alert(2)>'`;
const clean = (html, what) => {
  assert.ok(!html.includes('"/onmouseover'), `${what}: a quote broke out of an attribute: ${html}`);
  assert.ok(!/<img\b/.test(html), `${what}: an element was injected: ${html}`);
  assert.ok(!html.includes(`(2)>'`) && !html.includes(`(2)&gt;'`), `${what}: a raw single quote`);
};

test("markdown links and bare URLs keep a quote inside the href", () => {
  for (const src of [`See ${BAD}`, `[docs](https://x.example/"/onmouseover=alert(1)//)`, `**${BAD}**`, `\`x\` [a **b**](https://ok.example/?q="1") ${BAD}`, `- ${BAD}`, `| a |\n|---|\n| ${BAD} |`, `| ${BAD} |`, `> ${BAD}`]) {
    const html = md(src);
    clean(html, src);
    for (const [, href] of html.matchAll(/<a href="([^"]*)"/g)) assert.ok(!/[<>'"]/.test(href), `raw character in href: ${href}`);
  }
  clean(md(`${BAD}\n${BAD}\n[x](https://x.example/"/onmouseover=alert(1)//)\n${BAD}`), "line breaks");
});

test("sidebar rows, the rail, files changed, waves and cards escape their data", () => {
  const agent = { id: `a"1`, description: BAD, toolUseId: `t"1`, start: "2026-11-20T10:00:00.000Z", finished: false, items: [] };
  const s = { id: `s"1`, title: BAD, now: BAD, cwd: BAD, prs: [BAD], state: { status: "idle", since: Date.now(), detail: {}, light: "amber", tone: "amber", word: BAD, mark: "stopped", stopped: false, needsYou: null, review: 1, driven: true }, items: [], total: 0, agents: [agent],
    background: [{ toolUseId: `b"1`, taskId: `k"1`, kind: "shell", description: BAD, command: BAD, start: "2026-11-20T10:00:00.000Z", status: "running" }], stream: null, held: [BAD] };
  state.applyHello({ sessions: [s], layout: { groups: [], others: [s.id] }, pending: [] });
  const live = state.store.sessions.get(s.id);
  clean(rowHTML(live), "rowHTML");
  clean(railHTML(live, null), "railHTML");
  const patch = { file: `/tmp/"x/${BAD}`, add: 1, del: 0, created: true, abs: `/tmp/"x/${BAD}`, hunks: [{ o: 1, n: 1, lines: [`+${BAD}`] }] };
  clean(filesHTML([patch], `k"1`), "filesHTML");
  const bare = { file: `/tmp/"y/${BAD}`, add: 0, del: 0, created: false, abs: `/tmp/"y/${BAD}`, hunks: [], bare: true };
  clean(filesHTML([patch, bare], `k"2`, `2"<b>`), "filesHTML with a bare file and more");
  const items = [
    { id: `u"1`, k: "you", ts: "2026-11-20T10:00:00.000Z", text: BAD },
    { id: `t"1`, k: "tool", name: "Agent", verb: BAD, obj: BAD, state: "running", toolUseId: `t"1`, ts: "2026-11-20T10:00:01.000Z" },
    { id: `c"1`, k: "claude", ts: "2026-11-20T10:00:02.000Z", text: BAD },
    // an expanded step's command, result and "Show all" (R5.6), alone and in a group
    { id: `s"1`, k: "tool", name: "Bash", verb: BAD, obj: BAD, state: "done", input: BAD, out: { text: BAD, lines: `3"<b>`, cut: true, interrupted: true }, ts: "2026-11-20T10:00:02.100Z" },
    { id: `c"2`, k: "claude", ts: "2026-11-20T10:00:02.200Z", text: BAD },
    { id: `s"2`, k: "tool", name: "Grep", verb: BAD, obj: BAD, state: "failed", input: BAD, out: { text: BAD, lines: 1, cut: true }, ts: "2026-11-20T10:00:02.300Z" },
    { id: `s"3`, k: "tool", name: "Bash", verb: BAD, obj: BAD, state: "done", input: BAD, ts: "2026-11-20T10:00:02.400Z" },
    { id: `r"1`, k: "report", agent: `a"1`, ts: "2026-11-20T10:00:03.000Z", text: BAD },
    { id: `q"9`, k: "ask", ts: "2026-11-20T10:00:04.000Z", state: "answered", qs: [{ q: BAD, opts: [[BAD, BAD]] }], answer: `"${BAD}"="${BAD}" notes: ${BAD}` },
  ];
  for (const [key, html] of itemsHTML(items, false, live)) clean(html, `itemsHTML ${key}`);
  for (const [, html] of heldHTML(live)) clean(html, "heldHTML");
  const request = { id: `q"1`, kind: "permission", toolName: BAD, toolUseId: `t"2`, agentId: `a"1`, since: Date.now(), input: { command: BAD, description: BAD }, cwd: BAD, always: BAD };
  state.applyPending({ sid: s.id, request });
  clean(qaHTML(live, askOf(request)), "qaHTML permission");
  const question = { ...request, id: "q2", kind: "question", input: { questions: [{ question: BAD, header: BAD, options: [{ label: BAD, description: BAD }] }] } };
  clean(qaHTML(live, askOf(question)), "qaHTML question");
});

test("image thumbnails: a hostile ref, size or session stays inside its attribute", () => {
  const html = thumbsHTML([{ ref: BAD, mediaType: BAD, w: `1;background:url(${BAD})`, h: 2 }, { ref: "u1:0", w: 400, h: 100 }], BAD, BAD);
  assert.ok(!html.includes('"/onmouseover') && !html.includes(`'`), html);
  assert.equal((html.match(/<img /g) || []).length, 2, "one img per thumbnail, nothing more");
  for (const [, src] of html.matchAll(/ src="([^"]*)"/g)) assert.ok(/^\/api\/image\?token=t&amp;sid=[^"<>'&]*(&#39;)?&amp;agent=[^"<>'&]*(&#39;)?&amp;ref=[^"<>'&]*(&#39;)?$/.test(src), src);
  assert.ok(!html.includes("background:url"), "a size that is not a number is dropped");
  assert.ok(html.includes('style="--iw:400;--ih:100"'));
});
