// S5-2: keys and modes (R9) with real key events (CDP Input), on the fake driver.
// usage: run.sh keys (or node keys.mjs <url> <state-dir>)
import { connect, sleep } from './cdp.mjs';
const [url] = process.argv.slice(2);
const c = await connect();
const { ev, check, key } = c;
await c.load(url);
await ev(`(() => { window.__sent = []; const o = send; send = m => { __sent.push(m); o(m); }; })()`);
const K = {
  J: () => key('J', { shift: true, code: 'KeyJ', vk: 74 }), Kk: () => key('K', { shift: true, code: 'KeyK', vk: 75 }),
  j: () => key('j', { code: 'KeyJ', vk: 74 }), k: () => key('k', { code: 'KeyK', vk: 75 }),
  g: () => key('g', { code: 'KeyG', vk: 71 }), G: () => key('G', { shift: true, code: 'KeyG', vk: 71 }),
  i: () => key('i', { code: 'KeyI', vk: 73 }), a: () => key('a', { code: 'KeyA', vk: 65 }),
  slash: () => key('/', { code: 'Slash', vk: 191 }), esc: () => key('Escape', { code: 'Escape', vk: 27 }),
  next: () => key(']', { meta: true, shift: true, code: 'BracketRight', vk: 221 }),
  prev: () => key('[', { meta: true, shift: true, code: 'BracketLeft', vk: 219 }),
};
const cur = () => ev('current?.[0]');
const mode = () => ev('document.body.dataset.mode');
const order = await ev(`KEYS.map(x => x[0]).join('')`);
const go = async (p) => { await ev(`document.querySelector('.row[data-id^="${p}"]').click()`); await ev('document.activeElement.blur()'); await sleep(300); };

// the mode ring: grey in normal, blue in insert
await go(order[0]);
check('starts in normal mode', (await mode()) === 'normal');
check('normal: grey message box, no ring', await ev(`getComputedStyle(document.querySelector('.dock')).boxShadow === 'none' && getComputedStyle(document.querySelector('.dock .composer')).backgroundColor !== 'rgb(255, 255, 255)'`));
await K.i();
check('i: insert, focus in the box', (await mode()) === 'insert' && (await ev('document.activeElement.id')) === 'msg');
check('insert: blue ring', /rgb\(84, 174, 255\)/.test(await ev(`getComputedStyle(document.querySelector('.dock')).boxShadow`)));
await key('x', { code: 'KeyX', vk: 88 });
check('insert: keys type', (await ev('document.getElementById("msg").value')) === 'x');
await K.esc();
check('Esc: back to normal', (await mode()) === 'normal' && (await ev('document.activeElement.id')) !== 'msg');
await K.a();
check('a: insert', (await mode()) === 'insert');
await K.J();
check('J in insert mode types', (await cur()) === order[0] && (await ev('document.getElementById("msg").value')) === 'xJ');
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
await K.J(); check('J: next in sidebar order', (await cur()) === order[1], await cur());
await K.Kk(); check('K: previous', (await cur()) === order[0]);
await K.Kk(); check('K wraps to the last', (await cur()) === order[order.length - 1]);
await K.J(); check('J wraps to the first', (await cur()) === order[0]);
await K.next(); check('Cmd+Shift+]: next', (await cur()) === order[1], await cur());
await K.prev(); check('Cmd+Shift+[: previous', (await cur()) === order[0]);
await K.i(); await K.next(); check('Cmd+Shift+] works in insert mode too', (await cur()) === order[1]); await K.esc();
await K.prev();

// j/k/g/G scroll the transcript when no card waits
await c.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 420, deviceScaleFactor: 1, mobile: false });
const idle = await ev(`data.find(s => !pending(s) && s.status === 'idle')?.id[0]`);
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
const q = await ev(`data.find(s => requestsOf(s)[0]?.kind === 'question')?.id[0]`);
await go(q);
const st = () => ev(`(() => { const s = cur(), a = pendingAsk(s), x = qs(s, a); return x.qi + ':' + x.oi; })()`);
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
check('card: J still switches sessions', (await cur()) !== q);

// the interrupt prompt: any other key dismisses it, J included (no switch); Esc, Esc interrupts
const busy = await ev(`data.find(s => s.status === 'busy' && !pending(s))?.id[0]`);
await go(busy);
await K.esc();
check('busy: Esc asks to interrupt', await ev('!!document.querySelector(".composer.asking")'));
await K.J();
check('J under the prompt dismisses it, no switch', (await cur()) === busy && !(await ev('!!document.querySelector(".composer.asking")')));
await K.esc(); await K.esc();
check('Esc, Esc sends interrupt', await ev(`__sent.some(m => m.t === 'interrupt')`));

// the Open list: its keys come first; J, Cmd+Shift+] and j don't reach the sessions
await ev(`document.getElementById('open').click()`); await sleep(400);
const before = await cur();
await K.J(); await K.next(); await K.j();
check('Open list: J, Cmd+Shift+] and j leave the session', (await cur()) === before && (await ev('openListShown()')));
check('Open list: J and j typed into the filter', (await ev('document.getElementById("ol-filter").value')) === 'Jj');
await K.esc();
check('Open list: Esc closes it', !(await ev('openListShown()')));
check('Esc that closed the Open list asked nothing', !(await ev('!!document.querySelector(".composer.asking")')));

// hidden sessions are skipped: drop one from the store as a close would
const hide = order[1];
await go(order[0]);
await ev(`(() => { applyRemoved({ id: data.find(s => s.id[0] === '${hide}').id }); renderSide(); })()`);
await K.J();
check('J skips a session no longer shown', (await cur()) === order[2], await cur());
c.print(); c.close();
