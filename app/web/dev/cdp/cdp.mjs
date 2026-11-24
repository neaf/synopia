// CDP helpers for the page checks: connect to the headless Chrome run.sh started, load the page and wait
// until it is ready, evaluate, real keys and mouse.
import { WebSocket } from '../../../backend/node_modules/ws/wrapper.mjs';
import { sleep, PageError, until as poll } from './helpers.mjs';
export { sleep };

// counts the page's socket messages by type, before the page's own handler sees them (a listener added
// in the constructor runs before the onmessage the page sets later); not subject to the page's CSP
const SEEN = `window.__synSeen = {}; (() => { const W = window.WebSocket;
  window.WebSocket = class extends W { constructor(...a) { super(...a); this.addEventListener('message', (e) => { try { const t = JSON.parse(e.data).t; __synSeen[t] = (__synSeen[t] || 0) + 1; } catch {} }); } }; })();`;
// ready: the first hello applied, the sidebar rendered, the current view mounted with its first items, no
// ui restore in flight, and the window visible and focused
const READY = `typeof __synSeen === 'object' && __synSeen.hello >= 1 && typeof store === 'object' && store.ui.connected && uiLoaded && !uiRestoring
  && !!document.querySelector('#groups .row') && !!document.getElementById('msg') && (!current || (!!mounted && __synSeen.items >= 1))
  && document.visibilityState === 'visible' && document.hasFocus()`;

export async function connect(port = +process.env.SYNOPIA_CHROME_PORT) {
  if (!port) throw new Error('no SYNOPIA_CHROME_PORT: run the check with app/web/dev/cdp/run.sh <name>');
  // a whole check never hangs: run.sh's table shows the timeout
  setTimeout(() => { console.log('FAIL the check timed out after 180 s'); process.exit(2); }, 180_000).unref();
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  let n = 0; const waiting = new Map();
  const listeners = [];
  ws.on('message', (d) => { const m = JSON.parse(d); if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } else if (m.method) listeners.forEach((f) => f(m)); });
  ws.on('close', () => { for (const [id, r] of waiting) { waiting.delete(id); r({ error: { message: 'CDP closed' } }); } });
  let cdp = (method, params = {}) => new Promise((r) => {
    const id = ++n; const t = setTimeout(() => { if (waiting.delete(id)) r({ error: { message: method + ' timed out' } }); }, 30_000);
    waiting.set(id, (m) => { clearTimeout(t); r(m); }); ws.send(JSON.stringify({ id, method, params }));
  });
  // ev throws on a page exception or a failed evaluate, so a renamed global fails its check
  const ev = async (expr) => {
    const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    const err = !r.result ? r.error?.message : r.result.exceptionDetails && (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    if (err) throw new PageError(String(err).split('\n')[0], expr);
    return r.result.result.value;
  };
  // helpers.mjs `until`: === true, a page exception on the last try is rethrown
  function until(expr, ms) { return poll(ev, expr, ms); }
  // a page that reports hidden or unfocused gets no animation frames, and each mouse event waits ~5 s
  await cdp('Page.enable');
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp('Page.bringToFront');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: SEEN });
  // SYNOPIA_CDP_THEME=dark (or light): the system appearance the page sees, so any check runs in either theme;
  // kept when a check sets its own media features (reduced motion)
  const theme = process.env.SYNOPIA_CDP_THEME;
  if (theme) {
    const set = cdp;
    cdp = (method, params = {}) => method !== 'Emulation.setEmulatedMedia' || (params.features || []).some((f) => f.name === 'prefers-color-scheme') ? set(method, params)
      : set(method, { ...params, features: [...(params.features || []), { name: 'prefers-color-scheme', value: theme }] });
    await cdp('Emulation.setEmulatedMedia', { features: [] });
  }
  const results = [];
  // passes only on true: a truthy string or number is a failure, so every check states what it expects
  const check = (name, ok, extra = '') => {
    const pass = ok === true;
    const got = pass || typeof ok === 'boolean' ? '' : ` (got ${typeof ok} ${JSON.stringify(ok)?.slice(0, 80)})`;
    results.push((pass ? 'pass' : 'FAIL') + ' ' + name + got + (extra && !pass ? ' ' + extra : ''));
  };
  // a throw anywhere in the check (ev on a page exception, among others) fails it with what was counted so far
  const crash = (e) => { results.push('FAIL the check threw: ' + (e?.message || String(e))); print(); process.exit(1); };
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
  // headless Chrome can drop the first key after a load: before the first key on each document, send a
  // no-op Shift until the page sees one
  const raw = async (k, opts = {}) => {
    const mod = (opts.alt ? 1 : 0) | (opts.ctrl ? 2 : 0) | (opts.meta ? 4 : 0) | (opts.shift ? 8 : 0);
    const text = k.length === 1 && !opts.meta ? k : undefined;
    const base = { key: k, code: opts.code, modifiers: mod, windowsVirtualKeyCode: opts.vk, nativeVirtualKeyCode: opts.vk };
    await cdp('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, text });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };
  const prime = async () => {
    if ((await ev(`window.__synKeys === true`)) === true) return true;
    await ev(`window.__synKeys || (window.__synKeys = 'armed', window.addEventListener('keydown', () => { window.__synKeys = true; }, { capture: true, once: true }), 1)`);
    for (let i = 0; i < 20; i++) {
      await cdp('Page.bringToFront');
      await raw('Shift', { code: 'ShiftLeft', vk: 16 });
      if (await until(`window.__synKeys === true`, 250)) return true;
    }
    return false;
  };
  // a real key press through CDP
  const key = async (k, opts = {}) => { if (!(await prime())) check('the page takes keys', false, 'no keydown after 20 no-op keys'); await raw(k, opts); };
  // navigate and wait for the ready signal (above); `extra` is an expression the check also needs true
  const load = async (url, extra = 'true', ms = 15_000) => {
    await cdp('Page.bringToFront');
    await cdp('Page.navigate', { url });
    let ok, threw = '';
    try { ok = await until(`(${READY}) && (${extra})`, ms); } catch (e) { ok = false; threw = e.message + ' '; }
    if (!ok) check('the page is ready after load', false, threw + JSON.stringify(await ev(`({ seen: typeof __synSeen === 'object' ? __synSeen : null, connected: typeof store === 'object' && store.ui.connected,
      rows: document.querySelectorAll('#groups .row').length, mounted: typeof mounted === 'undefined' ? 'undefined' : mounted, restoring: typeof uiRestoring === 'undefined' ? 'undefined' : !!uiRestoring,
      visible: document.visibilityState, focus: document.hasFocus() })`)));
    else await prime();
    return ok;
  };
  const mouse = (type, x, y) => cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  // a check that recorded nothing fails: "0/0 pass" is never a pass
  const print = () => {
    if (!results.length) results.push('FAIL no checks ran');
    const f = results.filter((r) => r.startsWith('FAIL'));
    console.log(`${results.length - f.length}/${results.length} pass`); f.forEach((x) => console.log(x));
    if (f.length) process.exitCode = 1;
  };
  return { cdp, ev, until, check, results, key, load, mouse, print, onEvent: (f) => listeners.push(f), close: () => ws.close() };
}
