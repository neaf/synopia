// HTTP for app/web/ and the WebSocket on /ws, bound to 127.0.0.1 only.
// The upgrade checks Host and Origin; the first frame must be the token.
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { Log } from './log.ts';
import { nullLog } from './log.ts';

export const MAX_PAYLOAD = 32 * 1024 * 1024;
export const AUTH_TIMEOUT_MS = 10_000;

export type Client = { send: (msg: object) => void; close: () => void };

export type ServerOptions = {
  port: number;
  token: string;
  webRoot: string;
  hello: () => object;
  quitCheck: () => { running: unknown[]; background: unknown[] };
  // GET /api/badge: the Dock badge's count, polled by the shell (R2.6).
  badge?: () => number;
  // POST /api/stop: "Stop All Work". Called once the 200 has gone out.
  onStop?: () => void;
  onMessage?: (client: Client, msg: { t: string; [k: string]: unknown }) => void;
  // GET /api/image?sid&agent&ref: one image of a transcript, decoded (views.ts); 404 when there is none.
  image?: (sid: string, agent: string | null, ref: string) => { status: number; type?: string; body?: Buffer };
  log?: Log;
};

export type Server = { port: number; origin: string; clients: Set<Client>; close: () => Promise<void> };

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// The page's Content-Security-Policy, sent on every response. Scripts from the page's own files only (no
// inline script, no eval); the socket and http to this backend's own origin; Google Fonts for the CSS and
// the font files the page loads; images from /api/image, and pasted ones as data: or object (blob:) URLs. Style attributes stay allowed
// (style-src-attr): the markup sets positions and marks with them, and they can't run script.
// index.html repeats it as a meta tag, without the port, for when the header is missing.
export function contentSecurityPolicy(origin: string): string {
  const ws = origin.replace(/^http/, 'ws');
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "style-src-attr 'unsafe-inline'",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    `connect-src 'self' ${origin} ${ws}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function tokenMatches(token: string, given: unknown): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(token);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function deny(res: ServerResponse, code: number) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`${code}\n`);
}

// Resolves a request path to a file inside root, or null. Rejects encoded
// slashes, NUL, dot segments and symlinks that point out of root.
async function resolveStatic(root: string, pathname: string): Promise<string | null> {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (rel.includes('\0') || rel.includes('\\') || /%2f|%5c/i.test(pathname)) return null;
  if (rel.split('/').some((p) => p === '..' || p === '.')) return null;
  if (rel.endsWith('/')) rel += 'index.html';
  const file = resolve(root, '.' + rel);
  if (!file.startsWith(root + sep)) return null;
  try {
    const real = await realpath(file);
    if (!real.startsWith(root + sep)) return null;
    if (!(await stat(real)).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

export async function startServer(opts: ServerOptions): Promise<Server> {
  const log = opts.log ?? nullLog;
  const root = await realpath(opts.webRoot);
  const clients = new Set<Client>();
  let host = '';
  let origin = '';
  let csp = '';

  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.host !== host) return deny(res, 403);
    const url = new URL(req.url ?? '/', origin);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', csp);

    if (url.pathname.startsWith('/api/')) {
      if (!tokenMatches(opts.token, url.searchParams.get('token'))) return deny(res, 403);
      if (req.method === 'GET' && url.pathname === '/api/ping') { // the app's liveness check of daemon.json
        res.writeHead(200, { 'Content-Type': TYPES['.json'] });
        res.end(JSON.stringify({ ok: true, pid: process.pid }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/badge' && opts.badge) {
        res.writeHead(200, { 'Content-Type': TYPES['.json'] });
        res.end(JSON.stringify({ badge: opts.badge() }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/stop' && opts.onStop) {
        const stop = opts.onStop;
        res.writeHead(200, { 'Content-Type': TYPES['.json'] });
        res.end(JSON.stringify({ ok: true }), () => stop());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/quit-check') {
        res.writeHead(200, { 'Content-Type': TYPES['.json'] });
        res.end(JSON.stringify(opts.quitCheck()));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/image' && opts.image) {
        const q = url.searchParams;
        const r = opts.image(q.get('sid') ?? '', q.get('agent') || null, q.get('ref') ?? '');
        if (r.status !== 200 || !r.type || !r.body) return deny(res, r.status === 200 ? 404 : r.status);
        res.writeHead(200, { 'Content-Type': r.type, 'Content-Length': r.body.length, 'Cache-Control': 'private, max-age=3600' });
        res.end(r.body);
        return;
      }
      return deny(res, 404);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return deny(res, 405);
    const file = await resolveStatic(root, url.pathname);
    if (!file) return deny(res, 404);
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      deny(res, 404);
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/ws' || req.headers.host !== host || req.headers.origin !== origin) {
      log('ws.refused', { reason: path !== '/ws' ? 'path' : req.headers.host !== host ? 'host' : 'origin' });
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => accept(ws));
  });

  function accept(ws: WebSocket) {
    let authed = false;
    const client: Client = {
      send(msg) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
      close() {
        ws.close();
      },
    };
    const timer = setTimeout(() => {
      if (!authed) ws.close(4001, 'auth');
    }, AUTH_TIMEOUT_MS);

    ws.on('message', (data, isBinary) => {
      let msg: unknown;
      try {
        msg = isBinary ? null : JSON.parse(data.toString());
      } catch {
        msg = null;
      }
      const m = msg as { t?: unknown; token?: unknown } | null;
      if (!authed) {
        if (!m || m.t !== 'auth' || !tokenMatches(opts.token, m.token)) {
          log('ws.authFailed');
          ws.close(4001, 'auth');
          return;
        }
        authed = true;
        clearTimeout(timer);
        clients.add(client);
        log('ws.authed', { clients: clients.size });
        client.send({ t: 'hello', ...opts.hello() });
        return;
      }
      if (!m || typeof m.t !== 'string') {
        log('ws.badFrame');
        return;
      }
      if (opts.onMessage) opts.onMessage(client, m as { t: string });
      else log('ws.unhandled', { t: m.t });
    });
    ws.on('close', (code) => {
      clearTimeout(timer);
      if (clients.delete(client)) log('ws.closed', { code });
    });
    ws.on('error', (e) => log('ws.error', { code: (e as NodeJS.ErrnoException).code ?? 'unknown' }));
  }

  await new Promise<void>((ok, fail) => {
    http.once('error', fail);
    http.listen(opts.port, '127.0.0.1', () => {
      http.off('error', fail);
      ok();
    });
  });
  const addr = http.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  host = `127.0.0.1:${port}`;
  origin = `http://${host}`;
  csp = contentSecurityPolicy(origin);
  log('server.listening', { port });

  return {
    port,
    origin,
    clients,
    close() {
      for (const c of wss.clients) c.terminate();
      return new Promise((ok) => {
        wss.close();
        http.close(() => ok());
        http.closeAllConnections();
      });
    },
  };
}
