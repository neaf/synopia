// The page's HTML builders (app/web/js) with hostile text: nothing in a transcript, a path, a title or an id
// may become markup or an attribute. The scripts run in a vm with a stub document, as one classic script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const JS = join(import.meta.dirname, '..', '..', 'web', 'js');
const FILES = ['marks.js', 'md.js', 'store.js', 'sidebar.js', 'transcript.js', 'rail.js', 'card.js'];

function page() {
  const el = (): Record<string, unknown> => ({ addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], classList: { toggle() {}, add() {}, remove() {} }, dataset: {}, style: {} });
  const document = { getElementById: el, querySelector: el, querySelectorAll: () => [], addEventListener() {}, body: { dataset: {} } };
  const ctx = vm.createContext({ document, window: {}, location: { search: '', hash: '' }, CSS: { escape: (s: string) => s }, console });
  const names = ['md', 'esc', 'rowHTML', 'railHTML', 'filesHTML', 'itemsHTML', 'qaHTML', 'askOf', 'store', 'syncData', 'heldHTML'];
  vm.runInContext(FILES.map((f) => readFileSync(join(JS, f), 'utf8')).join('\n;\n') + `\n;globalThis.P = { ${names.join(', ')} };`, ctx);
  return (ctx as unknown as { P: Record<string, (...a: unknown[]) => string> & { store: { sessions: Map<string, unknown>; pending: Map<string, unknown> } } }).P;
}

// The reviewer's payload (H1), plus an element and a single quote.
const BAD = `https://x.example/"/onmouseover=alert(document.location)//<img src=x onerror=alert(2)>'`;
const clean = (html: string, what: string) => {
  assert.ok(!html.includes('"/onmouseover'), `${what}: a quote broke out of an attribute: ${html}`);
  assert.ok(!/<img\b/.test(html), `${what}: an element was injected: ${html}`);
  assert.ok(!html.includes(`(2)>'`) && !html.includes(`(2)&gt;'`), `${what}: a raw single quote`);
};

test('esc escapes the five characters', () => {
  assert.equal(page().esc(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
});

test('markdown links and bare URLs keep a quote inside the href', () => {
  const { md } = page();
  for (const src of [`See ${BAD}`, `[docs](https://x.example/"/onmouseover=alert(1)//)`, `**${BAD}**`, `\`x\` [a **b**](https://ok.example/?q="1") ${BAD}`, `- ${BAD}`, `| a |\n|---|\n| ${BAD} |`, `> ${BAD}`]) {
    const html = md(src);
    clean(html, src);
    for (const [, href] of html.matchAll(/<a href="([^"]*)"/g)) assert.ok(!/[<>'"]/.test(href), `raw character in href: ${href}`);
  }
});

test('markdown still renders links, code and bold', () => {
  const { md } = page();
  assert.equal(md('Read `a<b` and **this**: https://example.com/a?b=1&c=2.'),
    '<p>Read <code>a&lt;b</code> and <b>this</b>: <a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noreferrer">https://example.com/a?b=1&amp;c=2</a>.</p>');
  assert.equal(md('[the docs](https://example.com/x)'), '<p><a href="https://example.com/x" target="_blank" rel="noreferrer">the docs</a></p>');
  assert.equal(md('`https://example.com/in-code`'), '<p><code><a href="https://example.com/in-code" target="_blank" rel="noreferrer">https://example.com/in-code</a></code></p>');
});

test('sidebar rows, the rail, files changed, waves and cards escape their data', () => {
  const P = page();
  const agent = { id: `a"1`, description: BAD, toolUseId: `t"1`, start: '2026-11-20T10:00:00.000Z', finished: false, items: [] };
  const s = { id: `s"1`, title: BAD, now: BAD, cwd: BAD, prs: [BAD], status: 'idle', statusAt: Date.now(), items: [], total: 0, agents: [agent],
    background: [{ toolUseId: `b"1`, taskId: `k"1`, kind: 'shell', description: BAD, command: BAD, start: '2026-11-20T10:00:00.000Z', status: 'running' }], stream: null, held: [BAD] };
  P.store.sessions.set(s.id, s); P.syncData();
  clean(P.rowHTML(s), 'rowHTML');
  clean(P.railHTML(s, null), 'railHTML');
  const patch = { file: `/tmp/"x/${BAD}`, add: 1, del: 0, created: true, abs: `/tmp/"x/${BAD}`, hunks: [{ o: 1, n: 1, lines: [`+${BAD}`] }] };
  clean(P.filesHTML([patch], `k"1`), 'filesHTML');
  const items = [
    { id: `u"1`, k: 'you', ts: '2026-11-20T10:00:00.000Z', text: BAD },
    { id: `t"1`, k: 'tool', name: 'Agent', verb: BAD, obj: BAD, state: 'running', toolUseId: `t"1`, ts: '2026-11-20T10:00:01.000Z' },
    { id: `c"1`, k: 'claude', ts: '2026-11-20T10:00:02.000Z', text: BAD },
    { id: `r"1`, k: 'report', agent: `a"1`, ts: '2026-11-20T10:00:03.000Z', text: BAD },
  ];
  for (const [key, html] of P.itemsHTML(items, false, s) as unknown as [string, string][]) clean(html, `itemsHTML ${key}`);
  for (const [, html] of P.heldHTML(s) as unknown as [string, string][]) clean(html, 'heldHTML');
  const request = { id: `q"1`, kind: 'permission', toolName: BAD, toolUseId: `t"2`, agentId: `a"1`, since: Date.now(), input: { command: BAD, description: BAD }, cwd: BAD, always: BAD };
  P.store.pending.set(s.id, [request]);
  clean(P.qaHTML(s, P.askOf(request)), 'qaHTML permission');
  const question = { ...request, id: 'q2', kind: 'question', input: { questions: [{ question: BAD, header: BAD, options: [{ label: BAD, description: BAD }] }] } };
  clean(P.qaHTML(s, P.askOf(question)), 'qaHTML question');
});
