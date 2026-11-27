// Task output (R7.2): what a background shell or monitor printed, for its view. A shell's output is its
// output file, the bytes the command wrote (escape sequences included; the page shows it as plain
// text), read here by byte range; where the file is comes from the transcript (claude-jsonl.ts
// OUTPUT_FILE, docs/Claude Code transcripts.md#background-output). A monitor's output is its events,
// which the transcript holds (transcript.ts `outputOf`); this module only cuts them into windows.
// Pure apart from the file reads.
import fs from 'node:fs/promises';
import type { OutEvent } from './transcript.ts';

export const OUTPUT_WINDOW = 64 * 1024; // the bytes a shell's view gets, and an earlier page of them
export const EVENT_WINDOW = 500; // the events a monitor's view gets, and an earlier page of them
const MAX_READ = 4 * 1024 * 1024; // the most one reset reads, whatever the page had loaded

// A part of the output: its text, its range [from, to) and the whole length, in bytes for a shell and
// in event numbers for a monitor.
export type OutputPart = { text: string; from: number; to: number; total: number };

// The file's size, or -1 when it can't be read (gone: the system clears its temporary folder).
export async function outputSize(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size;
  } catch {
    return -1;
  }
}

// Bytes [from, to) of the file. The end goes back to a whole UTF-8 character (the rest comes with
// the next read); with `whole`, a part that starts inside the file starts after its first line break,
// so it shows whole lines. Null when the file can't be read.
export async function readOutput(file: string, from: number, to: number, whole = false): Promise<OutputPart | null> {
  let h: fs.FileHandle | null = null;
  try {
    h = await fs.open(file, 'r');
    const size = (await h.stat()).size;
    const end = Math.min(Math.max(0, to), size), start = Math.min(Math.max(0, from), end);
    const buf = Buffer.alloc(end - start);
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await h.read(buf, got, buf.length - got, start + got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    let a = 0, b = utf8End(buf.subarray(0, got));
    if (whole && start > 0) {
      const nl = buf.subarray(0, b).indexOf(10);
      if (nl >= 0) a = nl + 1;
    }
    return { text: buf.subarray(a, b).toString('utf8'), from: start + a, to: start + b, total: size };
  } catch {
    return null;
  } finally {
    await h?.close().catch(() => {});
  }
}

// The window a shell's view opens with: the last OUTPUT_WINDOW bytes, or from `from` (what the page
// had loaded before a reload) when that is earlier, at most MAX_READ.
export async function outputTail(file: string, from: number | null = null): Promise<OutputPart | null> {
  const size = await outputSize(file);
  if (size < 0) return null;
  const start = Math.max(size - MAX_READ, Math.min(from ?? Infinity, size - OUTPUT_WINDOW), 0);
  return readOutput(file, start, size, start > 0 && start !== from);
}

// The OUTPUT_WINDOW bytes before `before`, in whole lines.
export function outputBefore(file: string, before: number): Promise<OutputPart | null> {
  const start = Math.max(0, before - OUTPUT_WINDOW);
  return readOutput(file, start, before, start > 0);
}

// A monitor's events as one text, an event a line (an event can hold several).
function eventPart(list: OutEvent[], total: number, from: number): OutputPart {
  return { text: list.map((e) => e.text).join('\n'), from: list[0]?.n ?? from, to: list.length ? list[list.length - 1].n + 1 : from, total };
}
const totalOf = (events: OutEvent[]) => (events.length ? events[events.length - 1].n + 1 : 0);

// The last EVENT_WINDOW events, or from event `from` when that is earlier.
export function eventTail(events: OutEvent[], from: number | null = null): OutputPart {
  const total = totalOf(events), start = Math.min(from ?? Infinity, total - EVENT_WINDOW);
  return eventPart(events.filter((e) => e.n >= start), total, Math.max(0, start));
}

// The events from `from` on (what came since the page's last part).
export function eventsFrom(events: OutEvent[], from: number): OutputPart {
  return eventPart(events.filter((e) => e.n >= from), totalOf(events), from);
}

// The EVENT_WINDOW events before event `before`.
export function eventsBefore(events: OutEvent[], before: number): OutputPart {
  const list = events.filter((e) => e.n < before && e.n >= before - EVENT_WINDOW);
  return eventPart(list, totalOf(events), list[0]?.n ?? before);
}

// How many bytes at the end of `buf` belong to a UTF-8 character cut short: the end before them.
function utf8End(buf: Buffer): number {
  const n = buf.length;
  for (let back = 1; back <= Math.min(3, n); back++) {
    const c = buf[n - back];
    if ((c & 0xc0) === 0x80) continue; // a continuation byte: look further back
    const need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1;
    return need > back ? n - back : n;
  }
  return n;
}
