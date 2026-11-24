// Images in transcripts (R5.13): refs from user and tool-result records, sizes from image headers,
// the block read again from its record's line, and GET /api/image.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { deflateSync, crc32 } from 'node:zlib';
import { Transcript, imageSize, imageRefs, parseRef } from '../src/transcript.ts';
import { readImage } from '../src/transcripts.ts';
import { imageBlocks } from '../src/claude-jsonl.ts';
import { Tailer } from '../src/tail.ts';
import type { JsonRecord, Span } from '../src/tail.ts';
import { Transcripts } from '../src/transcripts.ts';
import { startServer } from '../src/server.ts';
import type { Client } from '../src/server.ts';

// A made-up w x h PNG, one grey.
export function png(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(t));
    return Buffer.concat([len, t, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0; // 8-bit greyscale
  const rows = Buffer.alloc((w + 1) * h, 0x99);
  for (let y = 0; y < h; y++) rows[y * (w + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const b64 = (b: Buffer) => b.toString('base64');
const img = (mediaType: string, data: string) => ({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });

test('imageSize: PNG, GIF, the three WebP headers and JPEG, from the base64 prefix', () => {
  assert.deepEqual(imageSize('image/png', b64(png(400, 100))), { w: 400, h: 100 });
  const gif = Buffer.from('GIF89a\x14\x00\x0a\x00\x00\x00\x00', 'latin1');
  assert.deepEqual(imageSize('image/gif', b64(gif)), { w: 20, h: 10 });
  const riff = (chunk: string, body: number[]) => Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP' + chunk, 'latin1'), Buffer.from(body), Buffer.alloc(16)]);
  // VP8: frame tag (3), start code (3), then 14-bit width and height
  assert.deepEqual(imageSize('image/webp', b64(riff('VP8 ', [0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, 0x90, 0x01, 0x64, 0x00]))), { w: 400, h: 100 });
  // VP8L: signature 0x2f, then 14 bits width-1, 14 bits height-1: 399 and 99
  const v = 399 | (99 << 14);
  assert.deepEqual(imageSize('image/webp', b64(riff('VP8L', [0, 0, 0, 0, 0x2f, v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]))), { w: 400, h: 100 });
  // VP8X: flags (4), then 24-bit width-1 and height-1
  assert.deepEqual(imageSize('image/webp', b64(riff('VP8X', [0, 0, 0, 0, 0, 0, 0, 0, 0x8f, 0x01, 0, 0x63, 0, 0]))), { w: 400, h: 100 });
  // JPEG: an APP1 segment first, then SOF0 (height before width)
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0x01, 0x02]), Buffer.alloc(0x100)]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x01, 0x90, 0x03]), Buffer.alloc(20)]);
  assert.deepEqual(imageSize('image/jpeg', b64(jpeg)), { w: 400, h: 100 });
  assert.equal(imageSize('image/jpeg', b64(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0, 0, 0]))), null, 'a scan before any frame header');
  assert.equal(imageSize('image/png', b64(Buffer.from('not a png at all, really not'))), null);
  assert.equal(imageSize('image/png', 'iVBORw0KGgo='), null, 'too short');
  assert.equal(imageSize('image/svg+xml', b64(png(4, 4))), null);
  assert.deepEqual(imageSize('image/png', b64(jpeg)), { w: 400, h: 100 }, 'a JPEG labelled PNG: by its bytes');
  assert.deepEqual(imageSize('image/gif', b64(png(900, 300))), { w: 900, h: 300 }, 'a PNG labelled GIF');
});

test('refs: a prompt with images and a tool result with an image, no bytes kept', () => {
  const data = b64(png(400, 100));
  const t = new Transcript({ home: '/Users/fixture' });
  t.push({ type: 'user', uuid: 'u1', timestamp: '2026-11-20T10:00:00.000Z', message: { role: 'user', content: [img('image/png', data), img('image/jpeg', 'AAAA'), { type: 'text', text: 'What is this?' }] } });
  t.push({ type: 'assistant', uuid: 'a1', timestamp: '2026-11-20T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_r', name: 'Read', input: { file_path: '/tmp/x.png' } }] } });
  t.push({ type: 'user', uuid: 'r1', timestamp: '2026-11-20T10:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_r', content: [{ type: 'text', text: 'one image' }, img('image/png', data)] }] } });
  const you = t.get('u1')!;
  assert.equal(you.images, 2);
  assert.deepEqual(you.imgs, [{ ref: 'u1:0', mediaType: 'image/png', w: 400, h: 100 }, { ref: 'u1:1', mediaType: 'image/jpeg' }]);
  const tool = t.get('toolu_r')!;
  assert.deepEqual(tool.imgs, [{ ref: 'r1:0.1', mediaType: 'image/png', w: 400, h: 100 }]);
  assert.equal(tool.out?.text, 'one image', 'the image is not in the text preview');
  assert.ok(!JSON.stringify(t.items).includes(data.slice(0, 40)), 'no base64 in the items');
  assert.equal(t.imageAt('u1:0'), null, 'no span pushed, so nothing to read');
  assert.deepEqual(imageRefs('x', imageBlocks('plain text')), []);
  assert.deepEqual(parseRef('r1:0.1'), { recordId: 'r1', path: [0, 1] });
  assert.deepEqual(parseRef('user@3:2'), { recordId: 'user@3', path: [2] });
  assert.equal(parseRef('r1'), null);
  assert.equal(parseRef('r1:0.1.2'), null);
});

const line = (o: object) => JSON.stringify(o) + '\n';
const SID = 'abcdabcd-0000-4000-8000-0000000000aa';
const PNG = png(20, 20);
function session(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-images-'));
  fs.mkdirSync(path.join(dir, 'projects', '-tmp-x'), { recursive: true });
  const file = path.join(dir, 'projects', '-tmp-x', `${SID}.jsonl`);
  fs.writeFileSync(file, line({ type: 'user', uuid: 'u1', timestamp: '2026-11-20T10:00:00.000Z', message: { role: 'user', content: [img('image/png', b64(PNG)), img('image/svg+xml', b64(Buffer.from('<svg/>'))), { type: 'text', text: 'Look' }] } })
    + line({ type: 'assistant', uuid: 'a1', timestamp: '2026-11-20T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_s', name: 'mcp__browser__screenshot', input: {} }] } })
    + line({ type: 'user', uuid: 'r1', timestamp: '2026-11-20T10:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_s', content: [img('image/png', b64(png(3000, 100)))] }] } }));
  return { dir, file };
}

test('readImage: the block read again from its line; null when gone or rewritten', async () => {
  const { file } = session();
  const recs: JsonRecord[] = [];
  const spans: Span[] = [];
  new Tailer(file, { onRecords: (r, s) => { recs.push(...r); spans.push(...s); }, pollMs: 0, watch: false, chunkBytes: 512 }).check();
  const t = new Transcript();
  t.pushAll(recs, spans);
  const at = t.imageAt('u1:0')!;
  assert.deepEqual(await readImage(file, at.span, at.recordId, at.path), { mediaType: 'image/png', data: PNG });
  const tool = t.imageAt(t.get('toolu_s')!.imgs![0].ref)!;
  assert.equal((await readImage(file, tool.span, tool.recordId, tool.path))?.data.readUInt32BE(16), 3000, 'inside the tool_result');
  assert.equal(await readImage(file, at.span, at.recordId, [2]), null, 'a text block');
  assert.equal(await readImage(file, at.span, 'u9', at.path), null, 'another record there');
  assert.equal(t.imageAt('u9:0'), null);
  fs.writeFileSync(file, line({ type: 'user', uuid: 'zz', message: { role: 'user', content: [img('image/png', b64(PNG))] } }).padEnd(at.span.length + 10, ' '));
  assert.equal(await readImage(file, at.span, at.recordId, at.path), null, 'rewritten');
  fs.rmSync(file);
  assert.equal(await readImage(file, at.span, at.recordId, at.path), null, 'gone');
});

// Real shapes (facts, 2026-11-24): a Read of an image repeats the base64 in toolUseResult.file (614 of
// 614 seen); a message with a pasted image sent during a turn is a queued_command whose prompt is blocks.
test('real shapes: a Read of a PNG, and a queued message with an image, read again from its line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-images-'));
  const file = path.join(dir, `${SID}.jsonl`);
  const data = b64(PNG);
  fs.writeFileSync(file, line({ type: 'assistant', uuid: 'a1', timestamp: '2026-11-20T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_rd', name: 'Read', input: { file_path: '/tmp/shot.png' } }] } })
    + line({ type: 'user', uuid: 'r1', timestamp: '2026-11-20T10:00:02.000Z', sourceToolAssistantUUID: 'a1',
      toolUseResult: { type: 'image', file: { base64: data, type: 'image/png', originalSize: PNG.length, dimensions: { originalWidth: 20, originalHeight: 20, displayWidth: 20, displayHeight: 20 } } },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_rd', content: [img('image/png', data)] }] } })
    + line({ type: 'attachment', uuid: 'q1', timestamp: '2026-11-20T10:00:03.000Z', isSidechain: false,
      attachment: { type: 'queued_command', commandMode: 'prompt', prompt: [{ type: 'text', text: 'And this one?' }, img('image/png', data)], imagePasteIds: [1] } }));
  try {
    const recs: JsonRecord[] = [];
    const spans: Span[] = [];
    new Tailer(file, { onRecords: (r, s) => { recs.push(...r); spans.push(...s); }, pollMs: 0, watch: false }).check();
    const t = new Transcript();
    t.pushAll(recs, spans);
    assert.deepEqual(t.get('toolu_rd')!.imgs, [{ ref: 'r1:0.0', mediaType: 'image/png', w: 20, h: 20 }]);
    const q = t.get('q1')!;
    assert.deepEqual([q.k, q.text, q.images, q.imgs], ['you', 'And this one?', 1, [{ ref: 'q1:1', mediaType: 'image/png', w: 20, h: 20 }]]);
    const at = t.imageAt('q1:1')!;
    assert.deepEqual(await readImage(file, at.span, at.recordId, at.path), { mediaType: 'image/png', data: PNG });
    assert.ok(!JSON.stringify(t.items).includes(data.slice(0, 40)), 'no base64 in the items');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const TOKEN = 'b'.repeat(64);
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-images-web-'));
fs.writeFileSync(path.join(base, 'index.html'), '<p>index</p>');
const s = session();
const transcripts = new Transcripts({ claudeDir: s.dir, home: '/Users/fixture', pollMs: 0, watch: false });
transcripts.open(SID);
const server = await startServer({ port: 0, token: TOKEN, webRoot: base, quitCheck: () => ({ running: [], background: [], counts: {}, summary: '' }), image: (sid, agent, ref) => transcripts.image(sid, agent, ref) });
after(() => { transcripts.stop(); return server.close(); });

type Res = { status: number; headers: Record<string, unknown>; body: Buffer };
const get = (q: string): Promise<Res> => new Promise((ok, fail) => {
  request({ host: '127.0.0.1', port: server.port, path: '/api/image?' + q }, (res) => {
    const parts: Buffer[] = [];
    res.on('data', (c) => parts.push(c));
    res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts) }));
  }).on('error', fail).end();
});
const q = (ref: string, token = TOKEN, sid = SID) => `token=${token}&sid=${sid}&ref=${encodeURIComponent(ref)}`;

test('GET /api/image: the bytes with their type, private cache and nosniff', async () => {
  const r = await get(q('u1:0'));
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'image/png');
  assert.equal(r.headers['cache-control'], 'private, max-age=3600');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.ok(r.body.equals(PNG));
  const tool = await get(q('r1:0.0'));
  assert.equal(tool.status, 200, 'an image in a tool result');
  assert.equal(tool.body.readUInt32BE(16), 3000);
});

test('GET /api/image: the token is required, only image types are served, an unknown ref is a 404', async () => {
  assert.equal((await get(q('u1:0', 'c'.repeat(64)))).status, 403);
  assert.equal((await get(`sid=${SID}&ref=u1:0`)).status, 403);
  const svg = await get(q('u1:1'));
  assert.equal(svg.status, 415, 'svg is not on the list');
  assert.equal(svg.headers['x-content-type-options'], 'nosniff');
  assert.equal((await get(q('u1:2'))).status, 404, 'a text block');
  assert.equal((await get(q('nope:0'))).status, 404);
  assert.equal((await get(q('garbage'))).status, 404);
  assert.equal((await get(q('u1:0', TOKEN, 'ffffffff-0000-4000-8000-000000000000'))).status, 404, 'an unknown session');
  assert.equal((await get(q('u1:0') + '&agent=nobody')).status, 404, 'an unknown subagent');
  fs.rmSync(s.file);
  assert.equal((await get(q('u1:0'))).status, 404, 'the file is gone');
});
