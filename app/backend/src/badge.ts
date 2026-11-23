// The Dock badge: the number of things waiting on you, from the same sources the page uses.
// Sessions that need you (a pending request, or the status `waiting`: the page's red), plus
// finished "For review: …" subagents not marked reviewed (the sidebar's "N to review").
// Only open sessions count: Views holds those and nothing else. In status.ts's precedence needs
// you wins over every other status, so `waiting` is it; signed out, no updates, rate limited,
// compacting and working (subagents running included) don't count.

export type BadgeSession = { id: string; status?: unknown; agents?: { id: string; review?: boolean; finished?: boolean }[] };
export type BadgeSource = {
  sessions: () => BadgeSession[];
  pending: () => { sid: string }[];
  reviewed: () => string[];
};

export function badgeCount(src: BadgeSource): number {
  const asking = new Set(src.pending().map((p) => p.sid));
  const reviewed = new Set(src.reviewed());
  let n = 0;
  for (const s of src.sessions()) {
    if (asking.has(s.id) || s.status === 'waiting') n++;
    for (const a of s.agents ?? []) if (a.review && a.finished && !reviewed.has(a.id)) n++;
  }
  return n;
}

export type BadgeOptions = { source: BadgeSource; emit: (n: number) => void; debounceMs?: number };

// `changed()` after anything that may move the count; `emit` runs only when it did, 300 ms after
// the last change. It starts at 0 (no badge), so a first count of 0 emits nothing.
export class Badge {
  private opts: BadgeOptions;
  private last = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: BadgeOptions) {
    this.opts = opts;
  }

  changed(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.check(), this.opts.debounceMs ?? 300);
  }

  check(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const n = badgeCount(this.opts.source);
    if (n === this.last) return;
    this.last = n;
    this.opts.emit(n);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
