// Keys and modes (R9) with real key events (CDP Input), on the scripted SDK.
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

// the mode (R9.2), one indicator: in normal the box's ❯ and text at half strength, its 1px line at full, no fill or
// edge; in insert the box is a ❯ band being written: the band's fill and the blue left edge, all at full strength
await go(order[0]);
check('starts in normal mode', (await mode()) === 'normal');
// a letter that does nothing in normal mode is still taken, else WKWebView hands it to AppKit, which beeps
await ev(`window.addEventListener('keydown', e => { if (e.key === 'z' || e.key === 'b') (window.__kept ||= {})[e.key] = e.defaultPrevented; })`);
await key('z', { code: 'KeyZ', vk: 90 }); await K.b();
check('normal mode: an unbound letter and b with nothing to send are taken (no beep)', await ev('window.__kept?.z === true && window.__kept?.b === true && !document.querySelector(".composer.asking")'));
const BOX = `(() => { const b = document.querySelector('.dock .composer'), st = getComputedStyle(b), i = document.createElement('i'), cs = getComputedStyle(document.documentElement);
  const col = v => { i.style.color = cs.getPropertyValue(v); document.body.append(i); const r = getComputedStyle(i).color; i.remove(); return r; };
  return { bg: st.backgroundColor, band: col('--band'), edge: st.borderLeftColor, edgeW: st.borderLeftWidth, link: col('--link'), line: st.borderTopWidth, ring: st.boxShadow + getComputedStyle(b.closest('.dock')).boxShadow,
    dock: getComputedStyle(b.closest('.dock')).opacity, g: getComputedStyle(b.querySelector(':scope > .g')).opacity, ta: getComputedStyle(b.querySelector('textarea')).opacity }; })()`;
const boxOpacity = async () => (await ev(BOX)).ta; // the box's text: half in normal, full when it must be read
const n0 = await ev(BOX);
check('normal: ❯ and text at half strength, the box itself and its line at full, no fill, no edge, no ring', n0.g === '0.5' && n0.ta === '0.5' && n0.dock === '1' && n0.line === '1px'
  && n0.bg === 'rgba(0, 0, 0, 0)' && n0.edge === 'rgba(0, 0, 0, 0)' && n0.ring === 'nonenone', JSON.stringify(n0));
await K.i();
check('i: insert, focus in the box', (await mode()) === 'insert' && (await ev('document.activeElement.id')) === 'msg');
const i0 = await ev(BOX);
check('insert: the box is a band being written: the band\'s fill, the blue left edge, full strength, no ring', i0.g === '1' && i0.ta === '1' && i0.bg === i0.band && i0.edge === i0.link && i0.edgeW !== '0px' && i0.ring === 'nonenone', JSON.stringify(i0));
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

// Ctrl+J/K and Cmd+Shift+[ ] in sidebar order, wrapping
await K.ctrlJ(); check('Ctrl+J: next in sidebar order', (await shownId()) === order[1], await shownId());
await K.ctrlK(); check('Ctrl+K: previous', (await shownId()) === order[0]);
await K.ctrlK(); check('Ctrl+K wraps to the last', (await shownId()) === order[order.length - 1]);
await K.ctrlJ(); check('Ctrl+J wraps to the first', (await shownId()) === order[0]);
await K.next(); check('Cmd+Shift+]: next', (await shownId()) === order[1], await shownId());
await K.prev(); check('Cmd+Shift+[: previous', (await shownId()) === order[0]);
await K.i(); await K.next(); check('Cmd+Shift+] works in insert mode too', (await shownId()) === order[1]); await K.esc();
await K.prev();
await K.i(); await K.ctrlJ(); check('Ctrl+J works in insert mode too, the box keeps the focus', (await shownId()) === order[1] && (await mode()) === 'insert' && (await ev('document.activeElement.id')) === 'msg', JSON.stringify([await shownId(), order[1], await mode(), await ev('document.activeElement.id')]));
await K.ctrlK(); await K.esc();

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
await K.down();
check('card: ↓ moves the cursor as j does, the log stays', (await st()) !== s0 && (await ev(`document.getElementById('log').scrollTop`)) === top0, await st());
await K.up();
check('card: ↑ moves it back', (await st()) === s0);
await K.i();
check('card: i opens the in-place field (insert)', (await ev('document.activeElement.id')) === 'qa-own' && (await mode()) === 'insert');
await K.esc();
check('card: Esc closes the field, back to normal', (await ev('document.activeElement.id')) !== 'qa-own' && (await mode()) === 'normal');
check('card: that Esc did not ask to interrupt', !(await ev('!!document.querySelector(".composer.asking")')));
check('card: a card keeps the box fully opaque in normal mode', (await boxOpacity()) === '1');
// Enter on the last row opens its field, as i does; nothing is sent
const rows = await ev(`document.querySelectorAll('.qa-card .acc.open .o').length`);
while ((await ev('__synopia.card().oi')) < rows - 1) await K.j();
const sentQ = (await ev(`__synopia.sent('answer')`)).length;
await K.enter();
check('card: Enter on the last row opens the in-place field', (await ev('document.activeElement.id')) === 'qa-own' && (await mode()) === 'insert', await st());
await K.esc();
check('card: Esc leaves it, nothing sent', (await mode()) === 'normal' && (await ev(`__synopia.sent('answer')`)).length === sentQ);
// with an answer typed in it, Enter on the last row takes that answer instead of opening the field again
await K.i(); await sleep(100); await c.cdp("Input.insertText", { text: "my own answer" }); await K.enter(); await sleep(50); // Enter in the field saves it
const qi0 = await ev("__synopia.card().qi");
await K.enter(); await sleep(100);
check('card: Enter on a typed last row takes the answer (sends it, or moves on), the field stays shut', (await mode()) === 'normal' && (await ev('document.activeElement.id')) !== 'qa-own' && ((await ev(`__synopia.sent('answer')`)).length > sentQ || (await ev('__synopia.card()?.qi')) !== qi0), await st());
await K.ctrlJ();
check('card: Ctrl+J still switches sessions', (await shownId()) !== q);

// the interrupt prompt: any other key dismisses it, J included (no switch); Esc, Esc interrupts
const busy = await ev(`__synopia.data().find(s => s.state.status === 'busy' && !__synopia.pending(s.id).length)?.id[0]`);
await go(busy);
await K.esc();
check('busy: Esc asks to interrupt', await ev('!!document.querySelector(".composer.asking")'));
check('the prompt keeps the box fully opaque in normal mode', (await mode()) === 'normal' && (await boxOpacity()) === '1');
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

// An open the backend refuses clears what the page waits for, so a later frame of that id doesn't switch the view
const GONE = 'c0ffee00-0000-4000-8000-00000000b3b3';
await ev(`document.getElementById('open').click()`); await sleep(400);
const was = await ev('__synopia.current()');
await ev(`__synopia.inject({ t: 'recent', filter: '', sessions: [{ id: '${GONE}', title: 'Gone since', cwd: '/tmp', lastModified: Date.now() }] })`);
await K.enter();
check('Open list: a session the backend can\'t open says why', await c.until(`__synopia.acting() === 0 && /no longer in the Open list/.test(document.getElementById('toast').textContent)`), await ev(`document.getElementById('toast').textContent`));
await ev(`__synopia.inject({ t: 'session', id: '${GONE}', title: 'Gone since', cwd: '/tmp' })`); await sleep(100);
check('a frame of that id later does not switch the view', (await ev('__synopia.current()')) === was);
await ev(`__synopia.inject({ t: 'removed', id: '${GONE}' })`);

// permission and plan cards (R6.5, R6.6): Enter on a row sends it, as on a single-choice question (R6.4);
// on the last row "Deny" sends a deny, "Ask for changes" opens its field as i does
// an Enter the page acts on is preventDefault'ed, else WKWebView hands it to AppKit, which beeps
await ev(`window.addEventListener('keydown', e => { if (e.key === 'Enter') window.__enterKept = e.defaultPrevented; })`);
const kept = () => ev('window.__enterKept === true');
const answers = async () => (await ev(`__synopia.sent('answer')`)).map(m => m.answer.choice);
const cardUp = () => ev('!!document.querySelector(".qa-card")');
const perm = await ev(`__synopia.data().find(s => __synopia.pending(s.id)[0]?.kind === 'permission')?.id`);
await go(perm.slice(0, 8));
const req = (await ev(`__synopia.pending('${perm}')`))[0];
const sent0 = (await answers()).length;
await K.j();
check('permission: j reaches Always allow', (await st()) === '0:1', await st());
await K.enter();
check('permission: Enter on Always allow sends always, the Enter prevented', await kept() && await c.until(`__synopia.sent('answer').length === ${sent0 + 1}`) && (await answers())[sent0] === 'always', JSON.stringify(await answers()));
check('permission: the answered card goes', await c.until(`!__synopia.pending('${perm}').length`));
// the same request again, under ids of its own: the backend has nothing to resolve, the page sends anyway
const again = async (id) => { await ev(`__synopia.inject({ t: 'pending', sid: '${perm}', request: { ...${JSON.stringify(req)}, id: '${id}' } })`); await sleep(100); };
await again('req-permission-again');
check('permission: a fresh card starts on Allow once', await cardUp() && (await st()) === '0:0', await st());
await K.enter();
check('permission: Enter on Allow once sends once, the Enter prevented', await kept() && await c.until(`__synopia.sent('answer').length === ${sent0 + 2}`) && (await answers())[sent0 + 1] === 'once', JSON.stringify(await answers()));
await ev(`__synopia.inject({ t: 'pending', sid: '${perm}', cleared: 'req-permission-again' })`);
await again('req-permission-deny');
await K.j(); await K.j();
check('permission: j, j reaches Deny', (await st()) === '0:2', await st());
await K.enter();
const denied = () => ev(`__synopia.sent('answer').at(-1).answer`);
check('permission: Enter on Deny sends a deny with no reason, the Enter prevented', await kept() && await c.until(`__synopia.sent('answer').length === ${sent0 + 3}`) && JSON.stringify(await denied()) === '{"choice":"deny","text":""}', JSON.stringify(await denied()));
await ev(`__synopia.inject({ t: 'pending', sid: '${perm}', cleared: 'req-permission-deny' })`);
await again('req-permission-reason');
await K.j(); await K.j(); await K.i();
await c.cdp('Input.insertText', { text: 'not yet' }); await K.enter();
check('permission: a typed reason, the field closed, the cursor stays on Deny', (await mode()) === 'normal' && (await st()) === '0:2' && (await answers()).length === sent0 + 3, await st());
await K.enter();
check('permission: Enter on Deny sends that reason, the Enter prevented', await kept() && await c.until(`__synopia.sent('answer').length === ${sent0 + 4}`) && JSON.stringify(await denied()) === '{"choice":"deny","text":"not yet"}', JSON.stringify(await denied()));
await ev(`__synopia.inject({ t: 'pending', sid: '${perm}', cleared: 'req-permission-reason' })`);
const plan = await ev(`__synopia.data().find(s => __synopia.pending(s.id)[0]?.kind === 'plan')?.id`);
await go(plan.slice(0, 8));
check('plan: the card starts on Approve', await cardUp() && (await st()) === '0:0', await st());
await K.j(); await K.enter();
check('plan: Enter on Ask for changes opens its field', (await ev('document.activeElement.id')) === 'qa-own' && (await mode()) === 'insert', await st());
await K.esc();
check('plan: Esc leaves it, nothing sent', (await mode()) === 'normal' && (await answers()).length === sent0 + 4);
await K.k(); await K.enter();
check('plan: Enter on Approve sends approve, the Enter prevented', await kept() && await c.until(`__synopia.sent('answer').length === ${sent0 + 5}`) && (await answers())[sent0 + 4] === 'approve', JSON.stringify(await answers()));

// hidden sessions are skipped: drop one from the store as a close would
const hide = order[1];
await go(order[0]);
await ev(`__synopia.inject({ t: 'removed', id: __synopia.data().find(s => s.id[0] === '${hide}').id })`);
await K.ctrlJ();
check('Ctrl+J skips a session no longer shown', (await shownId()) === order[2], await shownId());

// J/K: through Main conversation and the panel's rows (subagents, forks, shells, monitors), wrapping; normal mode only
const withAgents = await ev(`__synopia.data().find(s => (s.agents || []).length >= 2)?.id`);
if (withAgents) {
  await go(withAgents.slice(0, 8));
  const n = await ev(`new Set([...document.querySelectorAll('.rail [data-agent], .rail [data-bg]')].map(e => e.dataset.agent || e.dataset.bg)).size`);
  const shown = await ev(`[...new Set([...document.querySelectorAll('.rail [data-agent], .rail [data-bg]')].map(e => e.dataset.agent || e.dataset.bg))]`);
  const seen = [];
  for (let i = 0; i <= n; i++) { await K.J(); await sleep(150); seen.push(await ev('__synopia.view()')); }
  check('J follows the panel top to bottom, then back to Main conversation', JSON.stringify(seen.slice(0, n)) === JSON.stringify(shown) && seen[n] === null, JSON.stringify([shown, seen]));
  await K.K(); await sleep(150);
  check('K from Main conversation wraps to the last one', (await ev('__synopia.view()')) === seen[n - 1]);
  await K.K(); await sleep(150);
  check('the session stays the same', (await ev('__synopia.current()')) === withAgents);
  await K.i(); await sleep(100);
  check('a subagent view has no box: i keeps normal mode (R5.12)', !(await ev('document.getElementById("msg")')) && (await ev('__synopia.mode()')) === 'normal');
  await ev('document.querySelector("[data-back-main]").click()'); await sleep(200);
  await K.i(); const v = await ev('__synopia.view()');
  await K.J(); await sleep(150);
  check('insert mode in Main conversation: J types, the conversation stays', v === null && (await ev('__synopia.view()')) === v); await K.esc();
  await ev('document.getElementById("msg").value = ""');
} else check('a fixture session with two or more subagents exists', false);
c.print(); c.close();
