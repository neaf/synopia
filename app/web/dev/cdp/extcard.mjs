// A question or plan asked in another Claude Code process (R6.8), on the ext fixture: the row reads
// needs you, the read-only card shows the questions, their options and the quiet footer, keys and
// the message box stay the page's, a driver's session keeps "Not answered", the Dock badge counts
// them, and the card goes once the answer lands. Writes extcard-<n>.png in the state folder.
// usage: node extcard.mjs make <fixture-dir> <claude-dir>   copies the fixture, its cards 4 min old (run.sh does this)
//        node extcard.mjs <url> <state-dir> <claude-dir>
import fs from 'node:fs';
import path from 'node:path';

const Q = 'e1e1e1e1-0000-4000-8000-00000000000a', P = 'e2e2e2e2-0000-4000-8000-00000000000b', D = 'e3e3e3e3-0000-4000-8000-00000000000e';
const file = (dir, sid) => path.join(dir, 'projects', '-tmp-ext', `${sid}.jsonl`);

if (process.argv[2] === 'make') {
  const [src, dst] = process.argv.slice(3);
  fs.cpSync(src, dst, { recursive: true });
  for (const sid of [Q, P, D]) {
    const recs = fs.readFileSync(file(dst, sid), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const last = Math.max(...recs.filter((r) => r.timestamp).map((r) => Date.parse(r.timestamp)));
    const shift = Date.now() - 4 * 60_000 - last;
    for (const r of recs) if (r.timestamp) r.timestamp = new Date(Date.parse(r.timestamp) + shift).toISOString();
    fs.writeFileSync(file(dst, sid), recs.map((r) => JSON.stringify(r) + '\n').join(''));
  }
  process.exit(0);
}

const { connect, sleep } = await import('./cdp.mjs');
const [url, stateDir, claudeDir] = process.argv.slice(2);
const c = await connect();
const { ev, check, key } = c;
const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent.replace(/\\s+/g, ' ').trim() ?? ''`);
const until = async (expr, ms = 5000) => { for (let t = 0; t < ms; t += 100) { if (await ev(expr)) return true; await sleep(100); } return false; };
let n = 0;
const shot = async () => { const s = await c.cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${stateDir}/extcard-${++n}.png`, Buffer.from(s.result.data, 'base64')); };
const open = async (sid) => { await ev(`document.querySelector('.row[data-id^="${sid.slice(0, 8)}"]').click()`); await sleep(800); };
const row = (sid) => ev(`(() => { const r = document.querySelector('.row[data-id^="${sid.slice(0, 8)}"]'); return r && { state: r.dataset.state, word: r.querySelector('.r-state').textContent.trim() }; })()`);

await c.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 2, mobile: false });
await c.cdp('Page.navigate', { url });
await sleep(1000); await key('Shift', { vk: 16 }); // headless Chrome drops the first key after a load
await until(`document.querySelectorAll('#groups .row').length >= 3`);
await sleep(500);

// 1. the question: needs you over working, aged from its tool_use
for (const sid of [Q, P]) {
  const r = await row(sid);
  check(`${sid.slice(0, 4)}: row needs you`, r?.state === 'red' && /^Needs you, 4 min$/.test(r?.word), JSON.stringify(r));
}
await open(Q);
check('question: the read-only card', await ev(`!!document.querySelector('.dock .qa-card.ro')`));
const head = await text('.qa-card.ro .nd-head');
check('question: header', /^Needs you ?Claude asks 2 questions, for 4 min$/.test(head), JSON.stringify(head));
const qs = await ev(`[...document.querySelectorAll('.qa-card.ro .acc.open')].map(a => ({ hd: a.querySelector('.acc-h .hd')?.textContent, q: a.querySelector('.qt')?.textContent, radio: a.querySelectorAll('.o > .radio').length, box: a.querySelectorAll('.o > .box').length, rec: [...a.querySelectorAll('.rc-t')].map(x => x.parentElement.firstChild.textContent), d: [...a.querySelectorAll('.o > .d')].map(x => x.textContent) }))`);
check('question: both questions open, with headers', qs?.length === 2 && qs[0].hd === 'Channel' && qs[1].hd === 'Checks', JSON.stringify(qs?.map((x) => x.hd)));
check('question: single choice as radios, Recommended on Beta', qs?.[0].radio === 3 && qs[0].box === 0 && qs[0].rec.join() === 'Beta' && qs[0].q === 'Which release channel should the checklist target?', JSON.stringify(qs?.[0]));
check('question: multi-select as checkboxes, with descriptions', qs?.[1].box === 4 && qs[1].radio === 0 && qs[1].d[1] === 'Headless Chrome over CDP', JSON.stringify(qs?.[1]));
const inert = await ev(`(() => { const k = document.querySelector('.qa-card.ro'); return { focus: k.querySelectorAll('.focus, .on, .other').length, buttons: k.querySelectorAll('button, input').length, cursor: [...k.querySelectorAll('.o > .k')].map(x => x.textContent).join('') }; })()`);
check('question: no cursor, no selection, no controls', inert?.focus === 0 && inert.buttons === 0 && inert.cursor === '', JSON.stringify(inert));
const foot = await text('.qa-card.ro .nd-foot');
check('question: the quiet footer', foot === 'Asked in another Claude Code process. Answer it there.', JSON.stringify(foot));
const wait = await text('.log .waitln');
check('question: transcript line points at the other process', wait === 'Waiting for you: 2 questions from Claude, asked in another process', JSON.stringify(wait));
check('question: no working line', !(await ev(`!!document.querySelector('.liveln')`)));
await shot();

// 2. keys: j/k aren't the card's, i goes to the message box, nothing answers
const card0 = await ev(`document.querySelector('.qa-card.ro').outerHTML`);
await ev(`(() => { window.__sent = []; const o = send; send = m => { __sent.push(m); o(m); }; })()`);
await key('j', { code: 'KeyJ', vk: 74 }); await key('k', { code: 'KeyK', vk: 75 }); await key(' ', { code: 'Space', vk: 32 }); await key('Enter', { code: 'Enter', vk: 13 });
await sleep(300);
check('keys: j k Space Enter leave the card as it was', (await ev(`document.querySelector('.qa-card.ro').outerHTML`)) === card0);
check('keys: no card state, nothing sent', (await ev(`Object.keys(qstate).length === 0 && !__sent.some(m => m.t === 'answer')`)), JSON.stringify(await ev('__sent')));
await key('i', { code: 'KeyI', vk: 73 }); await sleep(200);
check('keys: i focuses the message box', (await ev(`document.activeElement?.id`)) === 'msg', JSON.stringify(await ev(`document.activeElement?.id`)));
await key('x', { code: 'KeyX', vk: 88 }); await sleep(100);
check('keys: typing goes to the box', (await ev(`document.getElementById('msg').value`)) === 'x');
await ev(`(() => { const m = document.getElementById('msg'); m.value = ''; m.dispatchEvent(new Event('input')); })()`);
await key('Escape', { code: 'Escape', vk: 27 }); await sleep(200);

// 3. the plan: its text in the transcript, the two decisions in the card
await open(P);
const ph = await text('.qa-card.ro .nd-head');
check('plan: header', /^Needs you ?Claude wrote a plan and waits for your approval, for 4 min$/.test(ph), JSON.stringify(ph));
const pr = await ev(`[...document.querySelectorAll('.qa-card.ro .o')].map(o => o.querySelector('.l').textContent + '|' + o.querySelector('.d').textContent + '|' + o.children[1].className)`);
check('plan: Approve and Ask for changes', pr?.length === 2 && pr[0].startsWith('Approve|Claude starts with step 1') && pr[1].startsWith('Ask for changes|') && pr[1].endsWith('|pen'), JSON.stringify(pr));
check('plan: the question', (await text('.qa-card.ro .qt')) === 'Approve the plan above?');
check('plan: the plan above it, in the transcript', (await ev(`[...document.querySelectorAll('.log .ln.claude')].some(x => x.textContent.includes('Move the settings into one file'))`)));
const pw = await text('.log .waitln');
check('plan: transcript line', pw === 'Waiting for you: your approval of the plan above, asked in another process', JSON.stringify(pw));
await shot();

// 4. a driver's session whose ask has no request: Not answered, as before
await open(D);
check('driver: no card', !(await ev(`!!document.querySelector('.dock .qa-card')`)));
check('driver: Not answered (Synopia quit)', (await ev(`document.querySelector('.log').textContent.includes('Not answered (Synopia quit)')`)));
check('driver: row your turn', (await row(D))?.state === 'amber', JSON.stringify(await row(D)));

// 5. the Dock badge counts the two (the shell polls GET /api/badge)
const badge = async () => { const u = new URL(url); u.pathname = '/api/badge'; return (await (await fetch(u)).json()).badge; };
check('badge: 2', (await badge()) === 2, String(await badge()));

// 6. answered in the other process: the card goes, the answer is your turn, the row works
await open(Q);
const at = new Date().toISOString();
fs.appendFileSync(file(claudeDir, Q), JSON.stringify({ type: 'user', uuid: 'x1-u3', timestamp: at, cwd: '/Users/fixture/dev/demo', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_xask1', content: 'User has answered your questions: "Which release channel should the checklist target?"="Beta", "Which checks should run before the release?"="Unit tests, Page checks". You can now continue.' }] } }) + '\n');
check('answered: the card goes', await until(`!document.querySelector('.dock .qa-card')`));
check('answered: your answer as your turn', await until(`[...document.querySelectorAll('.log .prompt')].some(p => p.textContent.includes('Beta') && p.textContent.includes('Unit tests, Page checks'))`));
check('answered: no waiting line', !(await ev(`!!document.querySelector('.log .waitln')`)));
check('answered: row working', await until(`document.querySelector('.row[data-id^="${Q.slice(0, 8)}"]')?.dataset.state === 'green'`), JSON.stringify(await row(Q)));
await sleep(800);
check('answered: badge 1', (await badge()) === 1, String(await badge()));
await shot();
c.print();
c.close();
