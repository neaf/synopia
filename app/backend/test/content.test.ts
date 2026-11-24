// The content of a sent message (R5.13): the text with its [Image #N] tags, then the images in tag order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userContent } from '../src/content.ts';

const im = (n: number | undefined, data = `d${n}`, mediaType = 'image/png') => ({ mediaType, data, ...(n === undefined ? {} : { n }) });
const shape = (c: ReturnType<typeof userContent>) => typeof c === 'string' ? c
  : c.map((b) => b.type === 'text' ? `text:${b.text}` : b.type === 'image' && b.source.type === 'base64' ? `image:${b.source.data}:${b.source.media_type}` : b.type);

test('content: no images is the plain text', () => {
  assert.equal(userContent('hello', []), 'hello');
});

test('content: one text block with the tags kept, then the image block', () => {
  const c = userContent('left [Image #1] right', [im(1)]);
  assert.deepEqual(c, [
    { type: 'text', text: 'left [Image #1] right' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'd1' } },
  ]);
});

test('content: several images go in the order of their tags in the text, not of pasting', () => {
  const c = userContent('a [Image #3] b [Image #1] c [Image #2]', [im(1), im(2, 'd2', 'image/jpeg'), im(3)]);
  assert.deepEqual(shape(c), ['text:a [Image #3] b [Image #1] c [Image #2]', 'image:d3:image/png', 'image:d1:image/png', 'image:d2:image/jpeg']);
});

test('content: a tag at the start or the end; the text block still comes first', () => {
  assert.deepEqual(shape(userContent('[Image #1] what is this', [im(1)])), ['text:[Image #1] what is this', 'image:d1:image/png']);
  assert.deepEqual(shape(userContent('compare [Image #1]', [im(1)])), ['text:compare [Image #1]', 'image:d1:image/png']);
  assert.deepEqual(shape(userContent('[Image #2][Image #1]', [im(1), im(2)])), ['text:[Image #2][Image #1]', 'image:d2:image/png', 'image:d1:image/png']);
});

test('content: an image whose tag is gone from the text is not sent', () => {
  assert.deepEqual(shape(userContent('only [Image #2]', [im(1), im(2)])), ['text:only [Image #2]', 'image:d2:image/png']);
  assert.equal(userContent('no tags left', [im(1)]), 'no tags left', 'no image left: the plain text');
  assert.equal(userContent('[Image #10]', [im(1)]), '[Image #10]', '#1 is not inside #10');
  assert.deepEqual(shape(userContent('twice [Image #1] [Image #1]', [im(1), { ...im(1), data: 'other' }])), ['text:twice [Image #1] [Image #1]', 'image:d1:image/png'], 'one image per tag');
  assert.equal(userContent('[Image #0]', [im(0)]), '[Image #0]', 'a number below 1 is no tag');
});

test('content: an image without a number (an older page) goes after the tagged ones', () => {
  assert.deepEqual(shape(userContent('x [Image #1]', [im(undefined, 'old'), im(1)])), ['text:x [Image #1]', 'image:d1:image/png', 'image:old:image/png']);
  assert.deepEqual(shape(userContent('', [im(undefined, 'old')])), ['image:old:image/png'], 'images only: no empty text block');
});
