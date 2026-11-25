// Shared helpers for the page checks: waiting, the key table, screenshots and transcript record builders.
// No import of cdp.mjs here, so a suite's `make` mode can use the builders without a browser.
import fs from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// an exception in a page expression (cdp.mjs `ev` throws it); its message names the expression
export class PageError extends Error {
  constructor(msg, expr) { super(`page exception: ${msg} in: ${expr.replace(/\s+/g, ' ').slice(0, 120)}`); this.name = 'PageError'; }
}
// Polls `ev(expr)` until it is === true, for `ms` at most; false on a timeout. A page exception counts as
// not yet (an element not there yet), but one on the last try is rethrown, so a renamed global fails.
// Suites call it as `c.until(expr, ms)`.
export async function until(ev, expr, ms = 5000) {
  for (const end = Date.now() + ms; ;) {
    let last = null;
    try { if ((await ev(expr)) === true) return true; } catch (e) { if (!(e instanceof PageError)) throw e; last = e; }
    if (Date.now() > end) { if (last) throw last; return false; }
    await sleep(50);
  }
}

// Real key presses through `c.key`: K.j(), K.G() (with Shift), K.esc(), K.next() (Cmd-Shift-]) and so on.
const NAMED = {
  esc: ['Escape', 'Escape', 27], enter: ['Enter', 'Enter', 13], tab: ['Tab', 'Tab', 9], space: [' ', 'Space', 32],
  backspace: ['Backspace', 'Backspace', 8], slash: ['/', 'Slash', 191],
  down: ['ArrowDown', 'ArrowDown', 40], up: ['ArrowUp', 'ArrowUp', 38], right: ['ArrowRight', 'ArrowRight', 39], left: ['ArrowLeft', 'ArrowLeft', 37],
};
export function keyTable(key) {
  const K = {};
  for (const ch of 'abcdefghijklmnopqrstuvwxyz') {
    const up = ch.toUpperCase(), code = 'Key' + up, vk = up.charCodeAt(0);
    K[ch] = () => key(ch, { code, vk });
    K[up] = () => key(up, { shift: true, code, vk });
  }
  for (const [name, [k, code, vk]] of Object.entries(NAMED)) K[name] = () => key(k, { code, vk });
  K.next = () => key(']', { meta: true, shift: true, code: 'BracketRight', vk: 221 });
  K.prev = () => key('[', { meta: true, shift: true, code: 'BracketLeft', vk: 219 });
  K.ctrlJ = () => key('j', { ctrl: true, code: 'KeyJ', vk: 74 });
  K.ctrlK = () => key('k', { ctrl: true, code: 'KeyK', vk: 75 });
  K.cmdF = () => key('f', { meta: true, code: 'KeyF', vk: 70 });
  return K;
}

// The page's test API (window.__synopia, js/test-api.js): state getters, a spy on sent frames, injection.
// page(c).cur() is a copy of the shown session; inside a page expression write `__synopia.cur()`.
export const page = (c) => ({
  current: () => c.ev('__synopia.current()'), view: () => c.ev('__synopia.view()'), mode: () => c.ev('__synopia.mode()'),
  mounted: () => c.ev('__synopia.mounted()'), cur: () => c.ev('__synopia.cur()'), data: () => c.ev('__synopia.data()'),
});
// Starts recording what the page sends (from now on, the earlier record dropped); returns sent(...types),
// the frames of those types (all with none) sent since.
export async function spySent(c) {
  await c.ev('__synopia.spy()');
  return (...types) => c.ev(`__synopia.sent(${types.map((t) => JSON.stringify(t)).join(', ')})`);
}
// A server message, handed to the page as if the server sent it.
export const inject = (c, msg) => c.ev(`__synopia.inject(${JSON.stringify(msg)})`);
// Frames sent to the backend from a client of its own (the page's token, from `url`), after its hello.
// It may run before connect() arms the suite's watchdog, so it has its own: 20 s, then the check fails.
export async function serverSend(url, ...msgs) {
  const { WebSocket } = await import('../../../backend/node_modules/ws/wrapper.mjs');
  const u = new URL(url), ws = new WebSocket(`ws://${u.host}/ws`, { origin: u.origin }); // the upgrade checks Origin
  const dog = setTimeout(() => { console.log('FAIL serverSend: no hello from the backend in 20 s'); process.exit(2); }, 20_000);
  try {
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
    const hello = new Promise((r) => ws.on('message', (d) => { if (JSON.parse(d).t === 'hello') r(); }));
    ws.send(JSON.stringify({ t: 'auth', token: u.searchParams.get('token') }));
    await hello;
    for (const m of msgs) ws.send(JSON.stringify(m));
    await new Promise((r) => { ws.on('close', r); ws.close(); });
  } finally {
    clearTimeout(dog);
  }
}

// A PNG of the page, or of `clip` ({ x, y, width, height }, scale 1 unless given), written to `file`.
export async function shot(c, file, clip) {
  const r = await c.cdp('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { scale: 1, ...clip } } : {}) });
  if (!r.result) throw new Error('screenshot failed: ' + JSON.stringify(r.error));
  fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  return file;
}

// A made-up w x h RGB PNG: a hue ramp left to right, darker in a band at the centre (so a crop shows).
export function png(w, h) {
  const chunk = (type, data) => {
    const t = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(t));
    return Buffer.concat([len, t, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.alloc((3 * w + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const f = x / Math.max(1, w - 1), mid = Math.abs(x - w / 2) < w / 10 ? 0.55 : 1, o = y * (3 * w + 1) + 1 + 3 * x;
      rows[o] = (90 + 140 * f) * mid; rows[o + 1] = (170 - 60 * f + 40 * (y / h)) * mid; rows[o + 2] = (230 - 150 * f) * mid;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

// Transcript records (Claude Code JSONL, docs/Claude Code transcripts.md), one line each.
export const line = (o) => JSON.stringify(o) + '\n';
// `s` seconds into a turn that started a minute ago: fresh, so the session reads running (status.ts ages)
export const fresh = (s) => new Date(Date.now() - 60_000 + s * 1000).toISOString();
// Builders for one project folder `cwd`: rec(sid, fields), you (a prompt), said (Claude's text), tool (a tool_use).
// `ts(s)` dates a record from its second; the default is `fresh`.
export function records(cwd, ts = fresh) {
  const rec = (sid, o) => line({ cwd, sessionId: sid, ...o });
  const reply = (sid, uuid, s, content) => rec(sid, { type: 'assistant', uuid, timestamp: ts(s), message: { role: 'assistant', content } });
  return {
    rec,
    you: (sid, uuid, s, text) => rec(sid, { type: 'user', uuid, timestamp: ts(s), message: { role: 'user', content: text } }),
    said: (sid, uuid, s, text) => reply(sid, uuid, s, [{ type: 'text', text }]),
    tool: (sid, uuid, s, id, name, input) => reply(sid, uuid, s, [{ type: 'tool_use', id, name, input }]),
  };
}

// The scripted SDK's script for a check's tree: <claude-dir>/sdk-script.json (app/backend/dev/scripted-sdk.ts).
export function writeScript(claudeDir, about, sessions) {
  fs.writeFileSync(`${claudeDir}/sdk-script.json`, JSON.stringify({ about, sessions }));
}
// A step: a turn of Synopia's process that started `ago` ms before the backend.
export const running = (ago) => ({ ago, message: { type: 'system', subtype: 'session_state_changed', state: 'running' } });
// The pid file of a Claude Code in a terminal that holds `sid` (docs/Claude Code terminals.md). Under the
// scripted SDK every pid file in the tree is a live CLI that isn't Synopia's; no real process is asked.
export function terminal(claudeDir, pid, sid, cwd, status = 'idle') {
  fs.mkdirSync(`${claudeDir}/sessions`, { recursive: true });
  fs.writeFileSync(`${claudeDir}/sessions/${pid}.json`, JSON.stringify({
    pid, sessionId: sid, cwd, procStart: 'Mon Nov 23 09:00:00 2026', kind: 'interactive', entrypoint: 'cli', status, statusUpdatedAt: Date.now(),
  }));
}
