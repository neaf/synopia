// S5-2: keys and modes (R9) with real key events (CDP Input), on the scripted SDK.
// usage: run.sh keys (or node keys.mjs <url> <state-dir>)
import { connect, sleep } from './cdp.mjs';
import { keyTable } from './helpers.mjs';
const [url] = process.argv.slice(2);
const c = await connect();
const { ev, check, key } = c;
await c.load(url);
await ev('__synopia.spy()');
const K = keyTable(key);
const shownId = () => ev('__synopia.current()?.[0]');
const mode = () => ev('document.body.dataset.mode');
const order = await ev(`[...document.querySelectorAll('#groups .row')].map(r => r.dataset.id[0]).join('')`);
const go = async (p) => { await ev(`document.querySelector('.row[data-id^="${p}"]').click()`); await ev('document.activeElement.blur()'); await sleep(300); };

// the mode ring: grey in normal, blue in insert
await go(order[0]);
check('starts in normal mode', (await mode()) === 'normal');
check('normal: grey message box, no ring', await ev(`getComputedStyle(document.querySelector('.dock')).boxShadow === 'none' && getComputedStyle(document.querySelector('.dock .composer')).backgroundColor !== 'rgb(255, 255, 255)'`));
await K.i();
check('i: insert, focus in the box', (await mode()) === 'insert' && (await ev('document.activeElement.id')) === 'msg');
const dark = process.env.SYNOPIA_CDP_THEME === 'dark'; // the ring's blue in the theme the check runs in
check('insert: blue ring', (dark ? /rgb\(68, 147, 248\)/ : /rgb\(84, 174, 255\)/).test(await ev(`getComputedStyle(document.querySelector('.dock')).boxShadow`)));
await key('x', { code: 'KeyX', vk: 88 });
check('insert: keys type', (await ev('document.getElementById("msg").value')) === 'x');
await K.esc();
check('Esc: back to normal', (await mode()) === 'normal' && (await ev('document.activeElement.id')) !== 'msg');
await K.a();
check('a: insert', (await mode()) === 'insert');
await K.J();
check('J in insert mode types', (await shownId()) === order[0] && (await ev('document.getElementById("msg").value')) === 'xJ');
await K.esc();
// `/` with a draft keeps it; with an empty box it opens the command menu
await K.slash();
check('/ with a draft: insert, draft kept, no menu', (await mode()) === 'insert' && (await ev('document.getElementById("msg").value')) === 'xJ' && (await ev('document.getElementById("slash").hidden')));
await ev('document.getElementById("msg").value = ""'); await K.esc();
await K.slash();
check('/: insert with the command menu open', (await mode()) === 'insert' && (await ev('document.getElementById("msg").value')) === '/' && !(await ev('document.getElementById("slash").hidden')));
await K.esc();
check('first Esc closes the menu, still insert', (await ev('document.getElementById("slash").hidden')) && (await mode()) === 'insert');
await K.esc();
check('second Esc: normal', (await mode()) === 'normal');
await ev('document.getElementById("msg").value = ""');

// J/K and Cmd+Shift+[ ] in sidebar order, wrapping
await K.J(); check('J: next in sidebar order', (await shownId()) === order[1], await shownId());
await K.K(); check('K: previous', (await shownId()) === order[0]);
await K.K(); check('K wraps to the last', (await shownId()) === order[order.length - 1]);
await K.J(); check('J wraps to the first', (await shownId()) === order[0]);
await K.next(); check('Cmd+Shift+]: next', (await shownId()) === order[1], await shownId());
await K.prev(); check('Cmd+Shift+[: previous', (await shownId()) === order[0]);
await K.i(); await K.next(); check('Cmd+Shift+] works in insert mode too', (await shownId()) === order[1]); await K.esc();
await K.prev();

// j/k/g/G scroll the transcript when no card waits
await c.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 420, deviceScaleFactor: 1, mobile: false });
const idle = await ev(`__synopia.data().find(s => !__synopia.pending(s.id).length && s.state.status === 'idle')?.id[0]`);
await go(idle);
await ev(`document.getElementById('log').scrollTop = 0`);
const h = await ev(`(() => { const l = document.getElementById('log'); return l.scrollHeight - l.clientHeight; })()`);
check('the transcript scrolls (fixture long enough)', h > 100, String(h));
await K.j(); await sleep(100);
check('j scrolls down', (await ev(`document.getElementById('log').scrollTop`)) > 0);
const t1 = await ev(`document.getElementById('log').scrollTop`);
await K.k(); await sleep(100);
check('k scrolls up', (await ev(`document.getElementById('log').scrollTop`)) < t1);
await K.G(); await sleep(100);
check('G: bottom', await ev(`(() => { const l = document.getElementById('log'); return l.scrollHeight - l.clientHeight - l.scrollTop < 2; })()`));
await K.g(); await sleep(100);
check('g: top', (await ev(`document.getElementById('log').scrollTop`)) === 0);

// a question card: j/k move the card cursor, not the log; i types in the card; Esc leaves it
const q = await ev(`__synopia.data().find(s => __synopia.pending(s.id)[0]?.kind === 'question')?.id[0]`);
await go(q);
const st = () => ev(`(() => { const x = __synopia.card(); return x.qi + ':' + x.oi; })()`);
const s0 = await st(), top0 = await ev(`document.getElementById('log').scrollTop`);
await K.j();
check('card: j moves the cursor', (await st()) !== s0 && (await ev(`document.getElementById('log').scrollTop`)) === top0, await st());
await K.k();
check('card: k moves it back', (await st()) === s0);
await K.i();
check('card: i opens the in-place field (insert)', (await ev('document.activeElement.id')) === 'qa-own' && (await mode()) === 'insert');
await K.esc();
check('card: Esc closes the field, back to normal', (await ev('document.activeElement.id')) !== 'qa-own' && (await mode()) === 'normal');
check('card: that Esc did not ask to interrupt', !(await ev('!!document.querySelector(".composer.asking")')));
await K.J();
check('card: J still switches sessions', (await shownId()) !== q);

// the interrupt prompt: any other key dismisses it, J included (no switch); Esc, Esc interrupts
const busy = await ev(`__synopia.data().find(s => s.state.status === 'busy' && !__synopia.pending(s.id).length)?.id[0]`);
await go(busy);
await K.esc();
check('busy: Esc asks to interrupt', await ev('!!document.querySelector(".composer.asking")'));
await K.J();
check('J under the prompt dismisses it, no switch', (await shownId()) === busy && !(await ev('!!document.querySelector(".composer.asking")')));
await K.esc(); await K.esc();
check('Esc, Esc sends interrupt', await ev(`__synopia.sent('interrupt').length > 0`));

// the Open list: its keys come first; J, Cmd+Shift+] and j don't reach the sessions
await ev(`document.getElementById('open').click()`); await sleep(400);
const before = await shownId();
await K.J(); await K.next(); await K.j();
check('Open list: J, Cmd+Shift+] and j leave the session', (await shownId()) === before && (await ev('document.getElementById("open-list")?.hidden === false')));
check('Open list: J and j typed into the filter', (await ev('document.getElementById("ol-filter").value')) === 'Jj');
await K.esc();
check('Open list: Esc closes it', !(await ev('document.getElementById("open-list")?.hidden === false')));
check('Esc that closed the Open list asked nothing', !(await ev('!!document.querySelector(".composer.asking")')));

// hidden sessions are skipped: drop one from the store as a close would
const hide = order[1];
await go(order[0]);
await ev(`__synopia.inject({ t: 'removed', id: __synopia.data().find(s => s.id[0] === '${hide}').id })`);
await K.J();
check('J skips a session no longer shown', (await shownId()) === order[2], await shownId());

// Ctrl+J / Ctrl+K: through Main conversation and the session's subagents, wrapping; normal mode only
const withAgents = await ev(`__synopia.data().find(s => (s.agents || []).length >= 2)?.id`);
if (withAgents) {
  await go(withAgents.slice(0, 8));
  const n = await ev(`new Set([...document.querySelectorAll('.rail [data-agent]')].map(e => e.dataset.agent)).size`);
  const shown = await ev(`[...new Set([...document.querySelectorAll('.rail [data-agent]')].map(e => e.dataset.agent))]`);
  const seen = [];
  for (let i = 0; i <= n; i++) { await key('j', { ctrl: true, code: 'KeyJ', vk: 74 }); await sleep(150); seen.push(await ev('__synopia.view()')); }
  check('Ctrl+J follows the panel top to bottom, then back to Main conversation', JSON.stringify(seen.slice(0, n)) === JSON.stringify(shown) && seen[n] === null, JSON.stringify([shown, seen]));
  await key('k', { ctrl: true, code: 'KeyK', vk: 75 }); await sleep(150);
  check('Ctrl+K from Main conversation wraps to the last one', (await ev('__synopia.view()')) === seen[n - 1]);
  await key('k', { ctrl: true, code: 'KeyK', vk: 75 }); await sleep(150);
  check('the session stays the same', (await ev('__synopia.current()')) === withAgents);
  await K.i(); const v = await ev('__synopia.view()');
  await key('j', { ctrl: true, code: 'KeyJ', vk: 74 }); await sleep(150);
  check('insert mode: Ctrl+J does nothing', (await ev('__synopia.view()')) === v); await K.esc();
} else check('a fixture session with two or more subagents exists', false);
c.print(); c.close();
