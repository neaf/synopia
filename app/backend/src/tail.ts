// Byte-offset tailing of one JSONL file, and a watcher for a session's subagents folder.
// Plan section 7: read from the last offset, keep the partial last line, skip bad JSON,
// reset on a shrink, an inode change or a same-size rewrite, triggered by fs.watch plus a poll.
import fs from 'node:fs';
import path from 'node:path';

export type JsonRecord = Record<string, unknown>;

export type TailOptions = {
  onRecords: (records: JsonRecord[]) => void;
  onReset?: () => void;
  pollMs?: number; // default 1000; 0 turns the timer off (tests call check())
  watch?: boolean; // default true
  chunkBytes?: number;
};

const NL = 0x0a;

export class Tailer {
  readonly path: string;
  offset = 0;
  skipped = 0;
  private opts: TailOptions;
  private partial: Buffer | null = null;
  private ino = -1;
  private size = -1;
  private mtimeMs = -1;
  private timer: NodeJS.Timeout | null = null;
  private watchers: fs.FSWatcher[] = [];
  private watchedIno = -1;

  constructor(file: string, opts: TailOptions) {
    this.path = file;
    this.opts = opts;
  }

  start(): this {
    this.check();
    const pollMs = this.opts.pollMs ?? 1000;
    if (pollMs > 0) {
      this.timer = setInterval(() => this.check(), pollMs);
      this.timer.unref();
    }
    if (this.opts.watch ?? true) this.arm();
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }

  // Reads whatever is new. Returns true when it read bytes or reset.
  check(): boolean {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.path);
    } catch {
      return false; // not there (yet, or mid-replace): the next trigger tries again
    }
    let changed = false;
    const rewritten = st.ino !== this.ino || st.size < this.offset ||
      (st.size === this.offset && st.size === this.size && st.mtimeMs !== this.mtimeMs);
    if (this.ino !== -1 && rewritten) {
      this.resetState();
      this.opts.onReset?.();
      changed = true;
    }
    this.ino = st.ino;
    if (st.size === this.offset && !rewritten) return changed;
    let fd: number;
    try {
      fd = fs.openSync(this.path, 'r');
    } catch {
      return changed;
    }
    try {
      const chunk = Buffer.allocUnsafe(this.opts.chunkBytes ?? 4 << 20);
      for (;;) {
        const n = fs.readSync(fd, chunk, 0, chunk.length, this.offset);
        if (n > 0) {
          this.offset += n;
          this.feed(chunk, n);
          changed = true;
          continue;
        }
        const now = fs.fstatSync(fd);
        if (now.size > this.offset) continue; // written while we read
        this.size = now.size;
        this.mtimeMs = now.mtimeMs;
        this.ino = now.ino;
        break;
      }
    } finally {
      fs.closeSync(fd);
    }
    if (this.watchers.length && this.ino !== this.watchedIno) this.arm();
    return changed;
  }

  private resetState(): void {
    this.offset = 0;
    this.partial = null;
    this.size = -1;
    this.mtimeMs = -1;
  }

  private feed(chunk: Buffer, n: number): void {
    const out: JsonRecord[] = [];
    let start = 0;
    const buf = chunk;
    const end = n;
    if (this.partial) {
      const nl = chunk.indexOf(NL);
      if (nl === -1 || nl >= n) {
        this.partial = Buffer.concat([this.partial, chunk.subarray(0, n)]);
        return;
      }
      this.parse(Buffer.concat([this.partial, chunk.subarray(0, nl)]), 0, this.partial.length + nl, out);
      this.partial = null;
      start = nl + 1;
    }
    for (;;) {
      const nl = buf.indexOf(NL, start);
      if (nl === -1 || nl >= end) break;
      this.parse(buf, start, nl, out);
      start = nl + 1;
    }
    if (start < end) this.partial = Buffer.from(buf.subarray(start, end));
    if (out.length) this.opts.onRecords(out);
  }

  private parse(buf: Buffer, start: number, end: number, out: JsonRecord[]): void {
    if (end <= start) return;
    const text = buf.toString('utf8', start, end);
    if (!text.trim()) return;
    try {
      const v = JSON.parse(text);
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v);
      else this.skipped++;
    } catch {
      this.skipped++;
    }
  }

  private arm(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    const onEvent = () => this.check();
    for (const target of [this.path, path.dirname(this.path)]) {
      try {
        const w = fs.watch(target, { persistent: false }, onEvent);
        w.on('error', () => {});
        this.watchers.push(w);
      } catch {
        // missing file: the folder watch and the poll pick it up
      }
    }
    this.watchedIno = this.ino;
  }
}

export type SubagentEvents = {
  onAgent: (agentId: string, file: string) => void;
  onMeta: (agentId: string, meta: JsonRecord) => void;
};

// Watches `<session>/subagents/`, which may be created after the session starts.
// Reports each `agent-<id>.jsonl` once and each `agent-<id>.meta.json` whenever it changes.
export class SubagentWatcher {
  readonly sessionDir: string;
  readonly dir: string;
  private events: SubagentEvents;
  private pollMs: number;
  private useWatch: boolean;
  private seen = new Set<string>();
  private metaStamp = new Map<string, string>();
  private watched = new Map<string, fs.FSWatcher>();
  private timer: NodeJS.Timeout | null = null;

  constructor(sessionDir: string, events: SubagentEvents, opts: { pollMs?: number; watch?: boolean } = {}) {
    this.sessionDir = sessionDir;
    this.dir = path.join(sessionDir, 'subagents');
    this.events = events;
    this.pollMs = opts.pollMs ?? 1000;
    this.useWatch = opts.watch ?? true;
  }

  start(): this {
    this.scan();
    if (this.pollMs > 0) {
      this.timer = setInterval(() => this.scan(), this.pollMs);
      this.timer.unref();
    }
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const w of this.watched.values()) w.close();
    this.watched.clear();
  }

  scan(): void {
    if (this.useWatch) {
      this.watch(this.sessionDir);
      this.watch(this.dir);
    }
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      let m = /^agent-(.+)\.meta\.json$/.exec(name);
      if (m) {
        this.readMeta(m[1], path.join(this.dir, name));
        continue;
      }
      m = /^agent-(.+)\.jsonl$/.exec(name);
      if (m && !this.seen.has(m[1])) {
        this.seen.add(m[1]);
        this.events.onAgent(m[1], path.join(this.dir, name));
      }
    }
  }

  private readMeta(id: string, file: string): void {
    let stamp: string;
    try {
      const st = fs.statSync(file);
      stamp = `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      return;
    }
    if (this.metaStamp.get(id) === stamp) return;
    let meta: unknown;
    try {
      meta = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return; // half written: the next scan tries again
    }
    this.metaStamp.set(id, stamp);
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) this.events.onMeta(id, meta as JsonRecord);
  }

  private watch(dir: string): void {
    if (this.watched.has(dir)) return;
    try {
      const w = fs.watch(dir, { persistent: false }, () => this.scan());
      w.on('error', () => {
        w.close();
        this.watched.delete(dir);
      });
      this.watched.set(dir, w);
    } catch {
      // not created yet
    }
  }
}
