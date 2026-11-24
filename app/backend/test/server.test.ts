import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startServer, MAX_PAYLOAD } from '../src/server.ts';
import type { Server } from '../src/server.ts';

const TOKEN = 'a'.repeat(64);
const base = mkdtempSync(join(tmpdir(), 'synopia-server-'));
const webRoot = join(base, 'web');
mkdirSync(join(webRoot, 'css'), { recursive: true });
writeFileSync(join(webRoot, 'index.html'), '<p>index</p>');
writeFileSync(join(webRoot, 'css', 'app.css'), 'body{}');
writeFileSync(join(base, 'secret.txt'), 'SECRET');

let server: Server;
before(async () => {
  server = await startServer({
    port: 0,
    token: TOKEN,
    webRoot,
    hello: () => ({ sessions: [], layout: { groups: [], others: [] }, reviewed: ['r1'], menu: {}, settings: { writerModel: 'haiku' }, pending: [] }),
    quitCheck: () => ({ running: [], background: [] }),
  });
});
after(() => server.close());

type Res = { status: number; body: string };
function get(path: string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port: server.port, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => ok({ status: res.statusCode ?? 0, body }));
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
  assert.match(dir('style-src'), /fonts\.googleapis\.com/);
  assert.match(dir('font-src'), /fonts\.gstatic\.com/);
});

test('the real page has no inline script and repeats the CSP as a meta tag', () => {
  const web = join(import.meta.dirname, '..', '..', 'web');
  for (const f of ['index.html']) {
    const html = readFileSync(join(web, f), 'utf8');
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), `${f}: inline script`);
    assert.ok(!/<style/i.test(html), `${f}: inline style element`);
    assert.ok(!/\son[a-z]+=/i.test(html), `${f}: inline handler`);
  }
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(readFileSync(join(web, 'index.html'), 'utf8'));
  assert.ok(meta && meta[1].includes("script-src 'self';") && meta[1].includes("default-src 'self'"));
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

test('hello after auth', async () => {
  const ws = connect();
  await once(ws, 'open');
  ws.send(JSON.stringify({ t: 'auth', token: TOKEN }));
  const [data] = await once(ws, 'message');
  const hello = JSON.parse(String(data));
  assert.equal(hello.t, 'hello');
  assert.deepEqual(hello.sessions, []);
  assert.deepEqual(hello.pending, []);
  assert.deepEqual(hello.reviewed, ['r1']);
  assert.deepEqual(hello.layout, { groups: [], others: [] });
  assert.equal(hello.settings.writerModel, 'haiku');
  ws.close();
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
