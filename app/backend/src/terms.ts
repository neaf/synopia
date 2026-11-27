// The terminals of the runs Synopia holds a pseudo-terminal for (R5.13, R7.2, 2026-11-27): your `!`
// commands (bang.ts) and the credential refresh (creds.ts). The one owner of each run's raw stream: the
// bytes the pty gave, escape sequences and all, as a terminal emulator on the page draws them. The plain
// text that the transcript, the preview and Claude see is the run's own (pty.ts plainText); this keeps the
// raw stream beside it, the last RAW_KEEP characters, with how far in it the kept part begins, and hands
// what comes to the pages that show the run (publisher.ts `term` frames). It also takes the page's keys
// and size for the run's pty. A run's terminal stays after its end until KEPT_ENDED newer ones ended.
// Nothing here is logged or stored (a sign-in's output can hold a code).
export const RAW_KEEP = 512 * 1024;
export const KEPT_ENDED = 20;
export const TERM_TICK_MS = 16; // what comes is handed on at most this often
export const DEFAULT_SIZE = { cols: 100, rows: 30 };

export type TermPty = { write(data: string): void; resize(cols: number, rows: number): void };
// `from`: where `data` begins in the whole stream; `to`: its end (characters). `live`: the run runs.
export type TermPart = { id: string; data: string; from: number; to: number; live: boolean };

export class Term {
  readonly id: string;
  live = true;
  private kept = '';
  private total = 0;
  private pty: TermPty | null;
  private hub: Terms;
  private pending = '';
  private tick: NodeJS.Timeout | null = null;
  private typed = ''; // the last keys typed, for interrupted()

  constructor(id: string, pty: TermPty | null, hub: Terms) {
    this.id = id;
    this.pty = pty;
    this.hub = hub;
  }

  // what the pty wrote: the terminal's output (CRLF, escapes)
  push(chunk: string): void {
    if (!chunk) return;
    this.kept += chunk;
    this.total += chunk.length;
    if (this.kept.length > RAW_KEEP * 1.25) this.kept = this.kept.slice(-RAW_KEEP);
    this.pending += chunk;
    if (!this.tick) {
      this.tick = setTimeout(() => this.flush(), this.hub.tickMs);
      this.tick.unref?.();
    }
  }

  // a stream that isn't the terminal (stderr on its own pipe): its line ends as the terminal's
  pushLines(chunk: string): void {
    this.push(chunk.replace(/\r?\n/g, '\r\n'));
  }

  // the whole kept part, for a page that opens the view
  snapshot(): TermPart {
    this.flushNow();
    return { id: this.id, data: this.kept, from: this.total - this.kept.length, to: this.total, live: this.live };
  }

  input(data: string): boolean {
    if (!this.live || !this.pty) return false;
    this.typed = (this.typed + data).slice(-16);
    this.pty.write(data);
    return true;
  }

  resize(cols: number, rows: number): boolean {
    if (!this.live || !this.pty) return false;
    this.pty.resize(cols, rows);
    return true;
  }

  // Ctrl-C was typed last: an exit by SIGINT (130) after it reads as stopped by you
  ctrlC(): boolean {
    return this.typed.endsWith('\x03');
  }

  end(): void {
    if (!this.live) return;
    this.flushNow();
    this.live = false;
    this.pty = null;
    this.hub.ended(this);
  }

  private flushNow(): void {
    if (this.tick) { clearTimeout(this.tick); this.flush(); }
  }

  private flush(): void {
    this.tick = null;
    const data = this.pending;
    this.pending = '';
    if (data) this.hub.emit({ id: this.id, data, from: this.total - data.length, to: this.total, live: this.live });
  }
}

export class Terms {
  readonly tickMs: number;
  size = { ...DEFAULT_SIZE }; // the size a page last gave a terminal: a new run starts with it
  private terms = new Map<string, Term>();
  private ends: string[] = [];
  private listeners = new Set<(p: TermPart) => void>();

  constructor(o: { tickMs?: number } = {}) {
    this.tickMs = o.tickMs ?? TERM_TICK_MS;
  }

  // A run's terminal, from its start; one with the same id is replaced.
  open(id: string, pty: TermPty | null): Term {
    const t = new Term(id, pty, this);
    this.terms.set(id, t);
    this.ends = this.ends.filter((x) => x !== id);
    return t;
  }

  get(id: string): Term | undefined {
    return this.terms.get(id);
  }

  // a page's keys and size, for the run it shows
  input(id: string, data: string): boolean {
    return this.terms.get(id)?.input(data) ?? false;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const t = this.terms.get(id);
    if (!t?.live) return false;
    this.size = { cols, rows };
    return t.resize(cols, rows);
  }

  // what comes, for the pages (publisher.ts)
  onPart(f: (p: TermPart) => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  emit(p: TermPart): void {
    for (const f of this.listeners) f(p);
  }

  ended(t: Term): void {
    const { to } = t.snapshot();
    this.emit({ id: t.id, data: '', from: to, to, live: false });
    this.ends.push(t.id);
    while (this.ends.length > KEPT_ENDED) this.terms.delete(this.ends.shift() as string);
  }
}
