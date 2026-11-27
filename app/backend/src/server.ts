// HTTP for app/web/ (from disk, or the daemon's copy read at start) and the WebSocket on /ws, bound to 127.0.0.1 only.
// The upgrade checks Host and Origin; the first frame must be the token. No routing here: each
// later frame goes to onMessage (router.ts), and the hello to onAuthed (publisher.ts).
// A page that doesn't read its socket (asleep, hung) gets no more stream previews once SEND_SOFT bytes
// wait for it, and is cut off at SEND_HARD; it reconnects and its hello has everything.
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
import type { QuitCheck } from './status.ts';

export const MAX_PAYLOAD = 32 * 1024 * 1024;
export const AUTH_TIMEOUT_MS = 10_000;
export const SEND_SOFT = 1024 * 1024;
export const SEND_HARD = 64 * 1024 * 1024;
const CLOSE_WAIT_MS = 1000;

// `buffered`: the bytes sent to it that its socket hasn't taken yet.
export type Client = { send: (msg: object) => void; close: () => void; buffered: () => number };

export type ServerOptions = {
  port: number;
  token: string;
  webRoot: string;
  // The page files under webRoot as the daemon read them at start (daemon.ts `PageFiles`), served in
  // place of webRoot's: a page always meets the daemon of its own code. Without it each request reads webRoot.
  page?: ReadonlyMap<string, Buffer>;
  // A page's token was taken: its hello goes out (publisher.ts).
  onAuthed?: (client: Client) => void;
  // GET /api/quit-check: what Stop All Work and Restart Backend ask with (status.ts quitSummary).
  quitCheck: () => QuitCheck;
  // GET /api/badge: the Dock badge's count, polled by the shell (R2.6).
  badge?: () => number;
  // POST /api/stop: "Stop All Work". Called once the 200 has gone out.
  onStop?: () => void;
  // POST /api/restart: "Restart Backend Now…", a handover to a new daemon. Called once the 200 has gone out.
  onRestart?: () => void;
  // More of GET /api/ping's answer: the daemon's code version.
  ping?: () => object;
  onMessage?: (client: Client, msg: { t: string; [k: string]: unknown }) => void;
  // GET /api/image?sid&agent&ref: one image of a transcript, decoded (transcripts.ts); 404 when there is none.
  image?: (sid: string, agent: string | null, ref: string) => Promise<{ status: number; type?: string; body?: Buffer }>;
  log?: Log;
  // The backpressure limits, in bytes (tests set small ones).
  sendSoft?: number;
  sendHard?: number;
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
  '.ttf': 'font/ttf',
};

// The page's Content-Security-Policy, sent on every response. Scripts, styles and fonts from the page's
// own files only (no inline script, no eval; the fonts are bundled in app/web/fonts); the socket and http
// to this backend's own origin; images from /api/image, and pasted ones as data: or object (blob:) URLs.
// Style attributes stay allowed (style-src-attr): the markup sets positions and marks with them, and they
// can't run script. The page is only ever served from here, so index.html has no meta copy.
export function contentSecurityPolicy(origin: string): string {
  const ws = origin.replace(/^http/, 'ws');
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "font-src 'self'",
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

// Resolves a request path to a path inside root, or null. Rejects encoded
// slashes, NUL and dot segments.
function staticPath(root: string, pathname: string): string | null {
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
  return file.startsWith(root + sep) ? file : null;
}

// The file on disk for a request path, or null; also rejects symlinks that point out of root.
async function resolveStatic(root: string, pathname: string): Promise<string | null> {
  const file = staticPath(root, pathname);
  if (!file) return null;
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
  let closing = false;
  const soft = opts.sendSoft ?? SEND_SOFT, hard = opts.sendHard ?? SEND_HARD;

  // A request handler that throws answers 500 and is logged; the daemon goes on (NFR-07).
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    serve(req, res).catch((e) => {
      log('http.failed', { error: String((e as Error)?.name ?? 'error') });
      if (!res.headersSent) deny(res, 500);
      else res.destroy();
    });
  });
  // Socket errors after listen, and requests Node can't parse: logged, never thrown.
  http.on('error', (e) => log('http.error', { code: (e as NodeJS.ErrnoException).code ?? 'unknown' }));
  http.on('clientError', (e, socket) => {
    log('http.clientError', { code: (e as NodeJS.ErrnoException).code ?? 'unknown' });
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    else socket.destroy();
  });

  async function serve(req: IncomingMessage, res: ServerResponse) {
    if (req.headers.host !== host) return deny(res, 403);
    const url = new URL(req.url ?? '/', origin);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', csp);

    if (url.pathname.startsWith('/api/')) {
      if (!tokenMatches(opts.token, url.searchParams.get('token'))) return deny(res, 403);
      if (req.method === 'GET' && url.pathname === '/api/ping') { // the app's liveness check of daemon.json
        res.writeHead(200, { 'Content-Type': TYPES['.json'] });
        res.end(JSON.stringify({ ok: true, pid: process.pid, ...opts.ping?.() }));
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
      if (req.method === 'POST' && url.pathname === '/api/restart' && opts.onRestart) {
        const restart = opts.onRestart;
        res.writeHead(200, { 'Content-Type': TYPES['.json'] });
        res.end(JSON.stringify({ ok: true }), () => restart());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/quit-check') {
        res.writeHead(200, { 'Content-Type': TYPES['.json'] });
        res.end(JSON.stringify(opts.quitCheck()));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/image' && opts.image) {
        const q = url.searchParams;
        const r = await opts.image(q.get('sid') ?? '', q.get('agent') || null, q.get('ref') ?? '');
        if (r.status !== 200 || !r.type || !r.body) return deny(res, r.status === 200 ? 404 : r.status);
        res.writeHead(200, { 'Content-Type': r.type, 'Content-Length': r.body.length, 'Cache-Control': 'private, max-age=3600' });
        res.end(r.body);
        return;
      }
      return deny(res, 404);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return deny(res, 405);
    const page = opts.page;
    let file: string | null, body: Buffer | undefined;
    if (page) {
      file = staticPath(root, url.pathname);
      body = file === null ? undefined : page.get(file.slice(root.length + 1));
    } else {
      file = await resolveStatic(root, url.pathname);
      body = file === null ? undefined : await readFile(file).catch(() => undefined);
    }
    if (!file || !body) return deny(res, 404);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '').split('?')[0];
    if (closing) { // shutting down: no new page
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (path !== '/ws' || req.headers.host !== host || req.headers.origin !== origin) {
      log('ws.refused', { reason: path !== '/ws' ? 'path' : req.headers.host !== host ? 'host' : 'origin' });
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => accept(ws));
  });

  function accept(ws: WebSocket) {
    let authed = false, dropped = 0;
    const client: Client = {
      send(msg) {
        if (ws.readyState !== ws.OPEN) return;
        const waiting = ws.bufferedAmount;
        if (waiting > hard) {
          log('ws.slow', { buffered: waiting, dropped });
          ws.terminate();
          return;
        }
        // a stream preview is only the newest text: the next one, or the record, replaces it
        if (waiting > soft && (msg as { t?: unknown; text?: unknown }).t === 'stream' && typeof (msg as { text?: unknown }).text === 'string') {
          if (dropped++ === 0) log('ws.behind', { buffered: waiting });
          return;
        }
        if (waiting <= soft) dropped = 0;
        ws.send(JSON.stringify(msg));
      },
      close() {
        ws.close();
      },
      buffered: () => ws.bufferedAmount,
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
        opts.onAuthed?.(client);
        return;
      }
      if (!m || typeof m.t !== 'string') {
        log('ws.badFrame');
        return;
      }
      if (closing || !opts.onMessage) return;
      try {
        opts.onMessage(client, m as { t: string });
      } catch (e) { // router.ts catches its own; this is the last guard (NFR-07)
        log('ws.failed', { t: m.t, error: String((e as Error)?.name ?? 'error') });
      }
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
    // Stops taking pages and frames; each page gets a close frame after what was sent to it (an
    // action's ack included), and is cut off after CLOSE_WAIT_MS.
    async close() {
      closing = true;
      const open = [...wss.clients];
      for (const c of open) c.close(1001, 'stopping');
      const gone = Promise.all(open.map((c) => (c.readyState === c.CLOSED ? null : new Promise((ok) => c.once('close', ok)))));
      await Promise.race([gone, new Promise((ok) => setTimeout(ok, CLOSE_WAIT_MS).unref())]);
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((ok) => {
        wss.close();
        http.close(() => ok());
        http.closeAllConnections();
      });
    },
  };
}
