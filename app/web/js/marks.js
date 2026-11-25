/* Marks: the status and kind marks, one table, each mark drawn one way (requirements R8.3; the look is
   prototype/app.html's). Running marks turn linearly forever, one cycle per --mark-period (a monitor's per
   --mark-watch); each kind has a still version for finished work (s_*). Colours come from the --mk-*
   variables, which the sidebar and dark mode set brighter (app.css, dark.css). */
const RL = '<svg viewBox="0 0 12 12" class="rl"><circle cx="6" cy="6" r="4.9" fill="none" stroke-width="2" pathLength="24" stroke-dasharray="3.6 2.4"/></svg>';
const SVG = '<svg class="k" viewBox="0 0 12 12" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const WORK = SVG + '<circle cx="6" cy="6" r="4.8" stroke="var(--mk-C6E9D0)" stroke-width="1.8"/><circle cx="6" cy="6" r="4.8" stroke="var(--mk-1A7F37)" stroke-width="1.8" pathLength="4" stroke-dasharray="1.6 2.4" class="rot" style="--d:var(--mark-period)"/><circle cx="6" cy="6" r="1.8" fill="var(--mk-1A7F37)"/></svg>';
/* key -> [extra class on the box, markup] */
export const MARKS = {
  /* a session's state (status.ts sessionState `mark`) */
  work: ['', WORK],
  /* working with your message queued: the same turning arc, its centre in your blue */
  queued: ['', WORK.replace('<circle cx="6" cy="6" r="1.8" fill="var(--mk-1A7F37)"/>', '<circle cx="6" cy="6" r="1.8" fill="var(--mk-0550AE)"/>')],
  /* a message of yours that waits in the queue (R5.5): a still clock in your blue, in place of `❯`; it waits, it doesn't run */
  waiting: ['', SVG + '<circle cx="6" cy="6" r="4.8" stroke="var(--mk-0550AE)" stroke-width="1.4"/><path d="M6 3.3V6l1.9 1.3" stroke="var(--mk-0550AE)" stroke-width="1.4"/></svg>'],
  compact: ['', '<i class="cr"></i><i class="cr"></i><i class="cr"></i>'],
  pause: ['v-seesaw', '<span class="bars"><i></i><i></i></span>'],
  creds: ['', '<i class="lock"><i class="sh"></i><i class="bd"></i></i>'],
  stale: ['', '<i class="arc frozen"></i>'],
  ratelimit: ['', RL],
  /* squares as SVG so they stay square at every size */
  stopped: ['', '<svg class="k" viewBox="0 0 12 12" aria-hidden="true"><rect x="2.3" y="2.3" width="7.4" height="7.4" rx="1.1" fill="var(--ink-3)"/></svg>'],
  failed: ['', '<svg class="k" viewBox="0 0 12 12" aria-hidden="true"><rect x="2.3" y="2.3" width="7.4" height="7.4" rx="1.1" fill="var(--red)"/></svg>'],
  timeout: ['', '<svg class="k" viewBox="0 0 12 12" aria-hidden="true"><rect x="2.4" y="2.4" width="7.2" height="7.2" rx="1" fill="none" stroke="var(--amber)" stroke-width="1" vector-effect="non-scaling-stroke"/></svg>'],
  done: ['', '<i class="chk"></i>'],
  review: ['', '<i class="badge"></i><i class="badge-chk"></i>'],
  /* kinds, running: a subagent's dot in orbit, a fork's two dots parting, a shell's >_ with the underscore
     stretching, a monitor's radar hand sweeping */
  k_sub: ['', SVG + '<circle cx="6" cy="6" r="4.4" stroke="var(--mk-7CC48F)" stroke-width="1.6"/><g class="rot" style="--d:var(--mark-period)"><circle cx="6" cy="1.6" r="1.8" fill="var(--mk-1A7F37)"/></g></svg>'],
  k_fork: ['', SVG + '<circle cx="6" cy="6" r="4.4" stroke="var(--mk-E2D6F8)" stroke-width="1.4"/><g class="rot" style="--d:var(--mark-period)"><circle cx="6" cy="10.4" r="1.6" fill="var(--mk-8250DF)" transform="rotate(-50 6 6)"/></g><g class="rot rev" style="--d:var(--mark-period)"><circle cx="6" cy="10.4" r="1.6" fill="var(--mk-8250DF)" transform="rotate(50 6 6)"/></g></svg>'],
  k_shell: ['', SVG + '<path d="M1.8 3.2 5 6 1.8 8.8" stroke="var(--mk-0B7A82)" stroke-width="1.8"/><line x1="6.4" y1="9.5" x2="10.6" y2="9.5" stroke="var(--mk-B6E0E3)" stroke-width="1.9"/><line x1="6.4" y1="9.5" x2="10.6" y2="9.5" stroke="var(--mk-0B7A82)" stroke-width="1.9" class="bounce"/></svg>'],
  k_mon: ['', SVG + '<circle cx="6" cy="6" r="4.8" stroke="var(--mk-0E6BA8)" stroke-width="1.4"/><g class="rot" style="--d:var(--mark-watch)"><path d="M6 6H1.9A4.1 4.1 0 0 1 6 1.9Z" fill="var(--mk-0E6BA8)" fill-opacity=".28" stroke="none"/><line x1="6" y1="6" x2="6" y2="2.6" stroke="var(--mk-0E6BA8)" stroke-width="1.6"/></g></svg>'],
  /* kinds, still: finished work */
  s_agent: ['', SVG + '<circle cx="6" cy="6" r="4.8" stroke="var(--mk-1A7F37)" stroke-width="1.8"/><circle cx="6" cy="6" r="1.8" fill="var(--mk-1A7F37)"/></svg>'],
  s_sub: ['', SVG + '<circle cx="6" cy="6" r="4.4" stroke="var(--mk-7CC48F)" stroke-width="1.6"/><circle cx="6" cy="1.6" r="1.8" fill="var(--mk-1A7F37)"/></svg>'],
  s_fork: ['', SVG + '<circle cx="6" cy="6" r="4.4" stroke="var(--mk-E2D6F8)" stroke-width="1.4"/><circle cx="2.9" cy="2.9" r="1.6" fill="var(--mk-8250DF)"/><circle cx="9.1" cy="2.9" r="1.6" fill="var(--mk-8250DF)"/></svg>'],
  s_shell: ['', SVG + '<path d="M1.8 3.2 5 6 1.8 8.8" stroke="var(--mk-0B7A82)" stroke-width="1.8"/><line x1="6.4" y1="9.5" x2="10.6" y2="9.5" stroke="var(--mk-0B7A82)" stroke-width="1.9"/></svg>'],
  s_mon: ['', SVG + '<circle cx="6" cy="6" r="4.8" stroke="var(--mk-0E6BA8)" stroke-width="1.4"/><line x1="6" y1="6" x2="6" y2="2.6" stroke="var(--mk-0E6BA8)" stroke-width="1.6"/></svg>'],
};
export const ind = (k, size) => {
  const p = MARKS[k]; if (!p) throw new Error("no indicator " + k);
  return `<span class="ind ${p[0]}" role="img" aria-hidden="true"${size ? ` style="font-size:${size}px"` : ""}>${p[1]}</span>`;
};
export const KG = { sub: ["subagent"], fork: ["fork"], shell: ["shell"], mon: ["monitor"] };
/* kind tag: the still version of the kind's own mark plus its name (no person or eye glyphs) */
export const kind = (k, glyphOnly) => `<span class="kind kd-${k}${glyphOnly ? " g" : ""}"${glyphOnly ? ` title="${KG[k][0]}" aria-label="${KG[k][0]}" role="img"` : ""}>${ind("s_" + k)}${glyphOnly ? "" : KG[k][0]}</span>`;

/* which mark each thing shows: a session's comes with its state (status.ts sessionState) */
export const sessionMark = s => ind(s.state.mark);
export const kindKey = x => x.agent ? (x.agent.fork ? "fork" : "sub") : x.bg ? (x.bg.kind === "monitor" ? "mon" : "shell") : "sub";
export function bgMarkKey(x) {
  if (x.running) return "k_" + kindKey(x);
  if (x.agent && x.agent.review) return "review"; // a finished deliverable not marked reviewed (the backend's flag)
  if (x.failed) return "failed";
  if (x.st === "timed out") return "timeout";
  if (x.st === "stopped" || x.st === "killed") return "stopped";
  return "done";
}

/* Every running mark keeps its phase when the page rebuilds it (docs/WKWebView and AppKit.md). A rebuilt
   element's CSS animation starts from zero, so each mark animation's startTime is pinned to the document
   timeline's origin: its phase depends only on the clock, a rebuilt mark continues where it was, and all
   marks turn in step. Only mark animations (inside .ind) are touched; layout tweens keep their own timing. */
function syncMarks() {
  for (const a of document.getAnimations()) {
    const t = a.effect && a.effect.target;
    if (!(a instanceof CSSAnimation) || !t || !t.closest || !t.closest(".ind")) continue;
    if (a.startTime !== 0) a.startTime = 0;
  }
}
let syncQueued = false;
new MutationObserver(() => {
  if (syncQueued) return;
  syncQueued = true;
  requestAnimationFrame(() => { syncQueued = false; syncMarks(); });
}).observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener("animationstart", () => syncMarks(), true); // a mark created any other way, too
