// A view switch renders once (R3.9, plan section 5): back from a subagent, the page sends `view` with
// the oldest item it had loaded (`from`), gets one reset from there to the end, asks for no earlier
// pages, and the log shows nothing until then: never the stale items or the last 160 first.
// usage: run.sh viewswitch (or node viewswitch.mjs <url> <state-dir> <claude-dir>), on the long transcript
// `earlier.mjs make` writes (run.sh does this first).
import { connect, sleep } from './cdp.mjs';

const SID = 'e0e0e0e0-0000-4000-8000-0000000000e0', AID = 'e1e1e1e1';
const [url] = process.argv.slice(2);
const c = await connect();
const { ev, check, until } = c;
await c.load(url + `#${SID.slice(0, 8)}`, `__synopia.current() === '${SID}'`);
check('loaded the last 160', await until(`__synopia.cur()?.id === '${SID}' && __synopia.cur().items.length === 160 && !__synopia.restoring()`));
for (const n of [320, 480]) {
  await ev(`document.querySelector('#log .earlier button').click()`);
  await until(`__synopia.cur().items.length === ${n}`);
}
check('two earlier pages loaded, from m120', (await ev(`__synopia.cur().items[0].id`)) === 'm120' && (await ev(`uiFrom(__synopia.current(), null)`)) === 'm120', await ev(`__synopia.cur().items[0].id`));
await ev(`document.querySelector('#conv [data-agent="${AID}"]').click()`);
check('subagent view', await until(`!__synopia.restoring() && __synopia.cur().agents.find(a => a.id === '${AID}')?.items?.length === 160`));

// Back: record what was sent and received, and every state of the log on screen.
await ev(`(() => {
  __synopia.spy();
  window.__frames = [];
  const snap = () => { const inner = document.querySelector('#log .log-inner'); if (!inner) return;
    const keys = [...inner.children].map(e => e.dataset.key).filter(k => !/^(earlier|day:|live|stream|held:)/.test(k));
    __frames.push({ n: keys.length, first: keys[0] ?? null, last: keys[keys.length - 1] ?? null }); };
  new MutationObserver(snap).observe(document.getElementById('conv'), { childList: true, subtree: true });
})()`);
await ev(`document.querySelector('#conv [data-back]').click()`);
check('back: restored, 480 items from m120', await until(`!__synopia.restoring() && __synopia.cur().items.length === 480 && __synopia.cur().items[0].id === 'm120'`));
await sleep(300);
const sent = await ev(`__synopia.sent().filter(m => m.t !== 'ui')`);
check('one view message with from m120, no earlier', JSON.stringify(sent) === JSON.stringify([{ t: 'view', sid: SID, agent: null, from: 'm120' }]), JSON.stringify(sent));
const got = await ev(`__synopia.received('items').map(m => ({ reset: !!m.reset, prepend: !!m.prepend, n: m.upsert.length, first: m.upsert[0]?.id }))`);
check('one reset of 480 items from m120', JSON.stringify(got) === JSON.stringify([{ reset: true, prepend: false, n: 480, first: 'm120' }]), JSON.stringify(got));
// the first block on screen once the log shows anything is the one it ends with, and so is the size
const frames = (await ev(`__frames`)).filter((f) => f.n > 0), end = frames[frames.length - 1];
check('the log never showed another range first', frames.length > 0 && frames.every((f) => f.first === end.first && f.n === end.n && f.last === end.last), JSON.stringify(frames.slice(0, 5)));
check('the first block is from m120', /\bm12[01]\b/.test(end?.first || ''), end?.first);
const link = () => ev(`document.querySelector('#log .earlier')?.textContent ?? null`);
check('the link: Show 120 earlier', (await link()) === 'Show 120 earlier', await link());
c.print();
c.close();
