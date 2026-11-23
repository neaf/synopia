// CDP helpers for the page checks: connect to headless Chrome (chrome.sh), evaluate, real keys and mouse.
import { WebSocket } from '../../../backend/node_modules/ws/wrapper.mjs';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function connect(port = +(process.env.SYNOPIA_CHROME_PORT || 9334)) { // another Chrome when other checks share 9334
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));
  let n = 0; const waiting = new Map();
  const listeners = [];
  ws.on('message', (d) => { const m = JSON.parse(d); if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } else if (m.method) listeners.forEach((f) => f(m)); });
  const cdp = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result.exceptionDetails) return 'EXC ' + JSON.stringify(r.result.exceptionDetails.exception?.description); return r.result.result.value; };
  const results = [];
  const check = (name, ok, extra = '') => { results.push((ok ? 'pass' : 'FAIL') + ' ' + name + (extra && !ok ? ' ' + extra : '')); };
  // a real key press through CDP
  const key = async (k, opts = {}) => {
    const mod = (opts.meta ? 4 : 0) | (opts.shift ? 8 : 0);
    const text = k.length === 1 && !opts.meta ? k : undefined;
    const base = { key: k, code: opts.code, modifiers: mod, windowsVirtualKeyCode: opts.vk, nativeVirtualKeyCode: opts.vk };
    await cdp('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, text });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };
  const mouse = (type, x, y) => cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  const print = () => { const f = results.filter((r) => r.startsWith('FAIL')); console.log(`${results.length - f.length}/${results.length} pass`); f.forEach((x) => console.log(x)); };
  return { cdp, ev, check, results, key, mouse, print, onEvent: (f) => listeners.push(f), close: () => ws.close() };
}
