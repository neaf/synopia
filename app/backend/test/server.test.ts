import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { request } from 'node:http';
import { connect as tcp } from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startServer, MAX_PAYLOAD } from '../src/server.ts';
import type { Client, Server } from '../src/server.ts';

const TOKEN = 'a'.repeat(64);
const base = mkdtempSync(join(tmpdir(), 'synopia-server-'));
const webRoot = join(base, 'web');
mkdirSync(join(webRoot, 'css'), { recursive: true });
writeFileSync(join(webRoot, 'index.html'), '<p>index</p>');
writeFileSync(join(webRoot, 'css', 'app.css'), 'body{}');
mkdirSync(join(webRoot, 'fonts'));
writeFileSync(join(webRoot, 'fonts', 'a.woff2'), 'wOF2');
writeFileSync(join(webRoot, 'fonts', 'a.ttf'), 'true');
writeFileSync(join(base, 'secret.txt'), 'SECRET');

let server: Server;
const lines: string[] = [];
const SOFT = 64 * 1024, HARD = 1024 * 1024;
before(async () => {
  server = await startServer({
    port: 0,
    token: TOKEN,
    webRoot,
    onAuthed: (c) => c.send({ t: 'hello', sessions: [] }),
    quitCheck: () => ({ running: [], background: [] }),
    onMessage: (c, m) => { if (m.t === 'throw') throw new Error('boom'); c.send({ t: 'echo', of: m.t }); },
    log: (event, fields) => lines.push(`${event} ${JSON.stringify(fields ?? {})}`),
    sendSoft: SOFT,
    sendHard: HARD,
  });
});
after(() => server.close());

type Res = { status: number; body: string };
function get(path: string, headers: Record<string, string> = {}): Promise<Res & { type: string }> {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port: server.port, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => ok({ status: res.statusCode ?? 0, body, type: String(res.headers['content-type'] ?? '') }));
    });
    req.on('error', fail);
    req.end();
  });
}

// A raw upgrade request, so Host and Origin can be anything.
function upgrade(headers: Record<string, string>): Promise<number> {
  return new Promise((ok, fail) => {
    const req = request({
      host: '127.0.0.1',
      port: server.port,
      path: '/ws',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
        ...headers,
      },
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      ok(res.statusCode ?? 101);
    });
    req.on('response', (res) => {
      res.resume();
      ok(res.statusCode ?? 0);
    });
    req.on('error', fail);
    req.end();
  });
}

function connect(): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { origin: server.origin });
}

function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((ok) => ws.on('close', (code) => ok(code)));
}

test('serves the page', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.equal(res.body, '<p>index</p>');
  assert.equal((await get('/css/app.css')).body, 'body{}');
  assert.equal((await get('/nope.js')).status, 404);
});

test('serves the bundled fonts with their font types', async () => {
  assert.equal((await get('/fonts/a.woff2')).type, 'font/woff2');
  assert.equal((await get('/fonts/a.ttf')).type, 'font/ttf');
});

test('every response carries the strict CSP, naming its own origin', async () => {
  const csp = await new Promise<string>((ok, fail) => {
    request({ host: '127.0.0.1', port: server.port, path: '/' }, (res) => {
      res.resume();
      ok(String(res.headers['content-security-policy'] ?? ''));
    }).on('error', fail).end();
  });
  const dir = (name: string) => csp.split('; ').find((d) => d.startsWith(name + ' ')) ?? '';
  assert.equal(dir('default-src'), "default-src 'self'");
  assert.equal(dir('script-src'), "script-src 'self'");
  assert.ok(!/unsafe-(inline|eval)/.test(dir('script-src')));
  assert.equal(dir('connect-src'), `connect-src 'self' ${server.origin} ws://127.0.0.1:${server.port}`);
  assert.equal(dir('img-src'), "img-src 'self' data: blob:");
  assert.equal(dir('style-src'), "style-src 'self'");
  assert.equal(dir('font-src'), "font-src 'self'");
});

test('the real page has no inline script, no meta CSP and no other host', () => {
  const web = join(import.meta.dirname, '..', '..', 'web');
  for (const f of ['index.html']) {
    const html = readFileSync(join(web, f), 'utf8');
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), `${f}: inline script`);
    assert.ok(!/<style/i.test(html), `${f}: inline style element`);
    assert.ok(!/\son[a-z]+=/i.test(html), `${f}: inline handler`);
  }
  const html = readFileSync(join(web, 'index.html'), 'utf8');
  assert.ok(!/http-equiv="Content-Security-Policy"/i.test(html), 'a meta CSP would have to repeat the header');
  assert.ok(!/https?:\/\//.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'index.html loads nothing from another host');
  assert.match(html, /<script type="module" src="js\/main\.js"><\/script>/);
});

test('every font app.css names is bundled, with its license beside it', () => {
  const web = join(import.meta.dirname, '..', '..', 'web');
  const css = readFileSync(join(web, 'css', 'app.css'), 'utf8');
  const urls = [...css.matchAll(/url\("\.\.\/(fonts\/[^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(urls.length >= 5, String(urls));
  for (const u of urls) {
    assert.ok(existsSync(join(web, u)), u);
    assert.ok(existsSync(join(web, dirname(u), 'OFL.txt')), `${u}: no OFL.txt beside it`);
  }
});

test('path traversal is refused', async () => {
  for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/css/..%2f..%2fsecret.txt', '/..%5csecret.txt', '/%2e%2e%2fsecret.txt', '/css/%00.css']) {
    const res = await get(p);
    assert.notEqual(res.status, 200, p);
    assert.ok(!res.body.includes('SECRET'), p);
  }
});

test('a wrong Host is refused for http', async () => {
  assert.equal((await get('/', { Host: `localhost:${server.port}` })).status, 403);
  assert.equal((await get('/', { Host: 'evil.example' })).status, 403);
});

test('quit-check needs the token', async () => {
  assert.equal((await get('/api/quit-check')).status, 403);
  assert.equal((await get('/api/quit-check?token=wrong')).status, 403);
  const res = await get(`/api/quit-check?token=${TOKEN}`);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { running: [], background: [] });
});

test('the upgrade checks Host and Origin', async () => {
  const host = `127.0.0.1:${server.port}`;
  assert.equal(await upgrade({ Host: host, Origin: server.origin }), 101);
  assert.equal(await upgrade({ Host: `localhost:${server.port}`, Origin: server.origin }), 403, 'wrong Host');
  assert.equal(await upgrade({ Host: 'rebind.example', Origin: 'http://rebind.example' }), 403, 'DNS rebinding');
  assert.equal(await upgrade({ Host: host, Origin: 'https://evil.example' }), 403, 'wrong Origin');
  assert.equal(await upgrade({ Host: host }), 403, 'no Origin');
});

test('a wrong token closes the socket without hello', async () => {
  const ws = connect();
  const got: string[] = [];
  ws.on('message', (d) => got.push(String(d)));
  await once(ws, 'open');
  ws.send(JSON.stringify({ t: 'auth', token: 'b'.repeat(64) }));
  assert.equal(await closeCode(ws), 4001);
  assert.deepEqual(got, []);
});

test('a first frame that is not auth closes the socket', async () => {
  const ws = connect();
  await once(ws, 'open');
  ws.send(JSON.stringify({ t: 'view', sid: 'x' }));
  assert.equal(await closeCode(ws), 4001);
});

// an authenticated page whose frames are collected
async function page() {
  const ws = connect(), got: { t: string; [k: string]: unknown }[] = [];
  ws.on('message', (d) => got.push(JSON.parse(String(d))));
  await once(ws, 'open');
  ws.send(JSON.stringify({ t: 'auth', token: TOKEN }));
  await waitUntil(() => got.length > 0);
  return { ws, got, client: [...server.clients].at(-1) as Client };
}
async function waitUntil(ok: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('after auth the hello comes from onAuthed (publisher.ts), then each frame goes to onMessage', async () => {
  const { ws, got } = await page();
  assert.deepEqual(got[0], { t: 'hello', sessions: [] });
  ws.send(JSON.stringify({ t: 'view' }));
  await waitUntil(() => got.length === 2);
  assert.deepEqual(got[1], { t: 'echo', of: 'view' });
  ws.close();
});

test('a handler that throws is logged, and the socket and server go on (NFR-07)', async () => {
  const { ws, got } = await page();
  ws.send(JSON.stringify({ t: 'throw' }));
  ws.send(JSON.stringify({ t: 'after' }));
  await waitUntil(() => got.some((m) => m.of === 'after'));
  assert.ok(lines.some((l) => l.startsWith('ws.failed') && l.includes('"t":"throw"')), lines.join('\n'));
  ws.close();
});

test('a page that doesn\'t read: stream previews are dropped past the soft limit, other frames kept, and it is cut off past the hard one (backend-core#B6)', async () => {
  const { ws, got, client } = await page();
  (ws as unknown as { _socket: { pause(): void; resume(): void } })._socket.pause();
  const big = 'x'.repeat(16 * 1024);
  for (let i = 0; i < 4000 && client.buffered() <= SOFT; i++) client.send({ t: 'toast', text: big });
  assert.ok(client.buffered() > SOFT, `buffered ${client.buffered()}`);
  client.send({ t: 'stream', sid: 's', text: 'dropped' });
  client.send({ t: 'stream', sid: 's', clear: true });
  client.send({ t: 'toast', text: 'kept' });
  (ws as unknown as { _socket: { resume(): void } })._socket.resume();
  await waitUntil(() => got.some((m) => m.text === 'kept'));
  assert.equal(got.some((m) => m.t === 'stream' && m.text === 'dropped'), false, 'the preview text went');
  assert.equal(got.some((m) => m.t === 'stream' && m.clear === true), true, 'the clear did not');
  assert.ok(lines.some((l) => l.startsWith('ws.behind')));
  // past the hard limit the page is cut off (it reconnects, and its hello has everything)
  (ws as unknown as { _socket: { pause(): void } })._socket.pause();
  const closed = once(ws, 'close');
  for (let i = 0; i < 4000 && ws.readyState === ws.OPEN && server.clients.has(client); i++) {
    client.send({ t: 'toast', text: big });
    if (client.buffered() > HARD) { client.send({ t: 'toast', text: 'one more' }); break; }
  }
  (ws as unknown as { _socket: { resume(): void } })._socket.resume();
  await closed;
  assert.ok(lines.some((l) => l.startsWith('ws.slow')), lines.join('\n'));
});

test('a request Node can\'t parse gets 400 and a log line; the server goes on (backend-core#B7)', async () => {
  const sock = tcp(server.port, '127.0.0.1');
  await once(sock, 'connect');
  let reply = '';
  sock.on('data', (d) => (reply += d));
  sock.write('NOT HTTP AT ALL\r\n\r\n');
  await once(sock, 'close');
  assert.match(reply, /^HTTP\/1\.1 400 /);
  assert.ok(lines.some((l) => l.startsWith('http.clientError')));
  assert.equal((await get('/')).status, 200);
});

test('an oversized frame closes the socket', async () => {
  const ws = connect();
  await once(ws, 'open');
  ws.send(JSON.stringify({ t: 'auth', token: TOKEN }));
  await once(ws, 'message');
  const done = closeCode(ws);
  ws.send(Buffer.alloc(MAX_PAYLOAD + 1, 0x20));
  assert.equal(await done, 1009);
});

test('an oversized frame before auth closes the socket', async () => {
  const ws = connect();
  await once(ws, 'open');
  const done = closeCode(ws);
  ws.send(Buffer.alloc(MAX_PAYLOAD + 1, 0x20));
  assert.equal(await done, 1009);
});

test('close: a page gets what was sent to it, then a close frame; a frame after it reaches nothing (seams#B5)', async () => {
  const seen: string[] = [];
  const s2 = await startServer({
    port: 0, token: TOKEN, webRoot, quitCheck: () => ({ running: [], background: [] }),
    onAuthed: (c) => c.send({ t: 'hello' }),
    onMessage: (_c, m) => { seen.push(m.t); },
  });
  const ws = new WebSocket(`ws://127.0.0.1:${s2.port}/ws`, { origin: s2.origin });
  const got: string[] = [];
  ws.on('message', (d) => got.push(JSON.parse(String(d)).t));
  await once(ws, 'open');
  ws.send(JSON.stringify({ t: 'auth', token: TOKEN }));
  await waitUntil(() => got.length === 1);
  const closed = closeCode(ws);
  for (const c of s2.clients) c.send({ t: 'ack' });
  const stopping = s2.close();
  ws.send(JSON.stringify({ t: 'late' }));
  await stopping;
  assert.equal(await closed, 1001);
  assert.deepEqual(got, ['hello', 'ack']);
  assert.deepEqual(seen, []);
});
