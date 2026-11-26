// A run's panel card (R7.1, FR-BG-01, 2026-11-26) for a run you or Synopia started: your `!` commands and the
// credential refresh. A run gets its card CARD_AFTER_MS after it starts, or as soon as it waits for input
// (pty.ts InputWatch); one that ended sooner, never having waited, gets none, and no Past line either. `cardAt`
// is that moment (ms), or null for none: the page shows the card once its clock passes it, so no timer here.
// Claude's background shells and monitors have their card from their start and its foreground Bash none (the
// page's rail.js, 2026-11-26), so they carry no `cardAt`.
export const CARD_AFTER_MS = 3000;

export function cardAt(start: number | null, end: number | null, waitedAt: number | null = null): number | null {
  if (start === null || !Number.isFinite(start)) return null;
  const due = start + CARD_AFTER_MS;
  if (waitedAt !== null && (end === null || waitedAt <= end)) return Math.min(due, waitedAt);
  if (end !== null && end < due) return null;
  return due;
}
