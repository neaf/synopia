// The content of a message you send (R5.13): the text and the pasted images, in the shape the
// Claude Code CLI writes for a prompt with pasted images. The CLI puts an `[Image #N]` tag at the
// caret for each paste and sends one text block, the tags kept in it, followed by the images in
// the order their tags appear. An image whose tag is no longer in the text was deleted with it and
// is not sent; an image without a number (sent by an older page) goes after the tagged ones.
import type { Content } from './driver.ts';

export type Image = { mediaType: string; data: string; n?: number };

export const tagOf = (n: number) => `[Image #${n}]`;

export function userContent(text: string, images: Image[]): Content {
  const at = new Map<Image, number>();
  for (const im of images) {
    const n = im.n;
    if (n === undefined) { at.set(im, text.length); continue; }
    if (!Number.isInteger(n) || n < 1) continue;
    const i = text.indexOf(tagOf(n));
    if (i >= 0 && ![...at.values()].includes(i)) at.set(im, i); // one image per tag
  }
  const sent = images.filter((im) => at.has(im)).sort((a, b) => (at.get(a) as number) - (at.get(b) as number));
  if (!sent.length) return text;
  return [
    ...(text.trim() ? [{ type: 'text' as const, text }] : []),
    ...sent.map((im) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: im.mediaType as 'image/png', data: im.data } })),
  ];
}
