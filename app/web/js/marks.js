/* Marks: status and kind indicators (split from prototype/app.html). */
/* ---------- status marks and kind tags (from status-storyboard.html) ---------- */
  const RL = '<svg viewBox="0 0 12 12" class="rl"><circle cx="6" cy="6" r="4.9" fill="none" stroke-width="2" pathLength="24" stroke-dasharray="3.6 2.4"/></svg>';
  const P = {
    work: ['', '<i class="arc"></i>'],
    tooldual: ['', '<i class="arc dual"></i>'],
    workslow: ['', '<i class="arc slow"></i>'],
    fork: ['', '<i class="arc fork"></i>'],
    startgrey: ['', '<i class="arc grey"></i>'],
    queued: ['', '<i class="arc"></i><i class="qdot"></i>'],
    queuedside: ['wide', '<i class="arc mini"></i><i class="qdot"></i>'],
    compact: ['', '<i class="cr"></i><i class="cr"></i><i class="cr"></i>'],
    pause: ['v-seesaw', '<span class="bars"><i></i><i></i></span>'],
    pausemeter: ['v-meter', '<span class="bars"><i></i><i></i></span>'],
    pauseescal: ['v-escal', '<span class="bars"><i></i><i></i></span>'],
    pauseslide: ['v-slide', '<span class="bars"><i></i><i></i></span>'],
    pauserot: ['v-rot', '<span class="bars"><i></i><i></i></span>'],
    pauseq: ['v-seesaw', '<span class="bars"><i></i><i></i></span><i class="qdot" style="transform:translate(.42em,.38em);width:.3em;height:.3em;background:var(--red)"></i>'],
    yourturn: ['', '<i class="dot"></i>'],
    caret: ['', '<i class="caret"></i>'],
    hring: ['', '<i class="hring"></i>'],
    idlebg: ['', '<i class="dot sm"></i><i class="orb"><i></i></i>'],
    idlebgside: ['wide', '<i class="dot" style="width:.56em;height:.56em"></i><i class="arc mini"></i>'],
    stopped: ['', '<i class="sq"></i>'],
    stoppedo: ['', '<i class="sqo"></i>'],
    failed: ['', '<i class="sq red"></i>'],
    failedmarch: ['', '<svg viewBox="0 0 12 12"><rect x="3" y="3" width="6" height="6" rx=".8" fill="#CF222E"/><rect x="1" y="1" width="10" height="10" fill="none" stroke="#CF222E" stroke-width="1.3" pathLength="40" stroke-dasharray="2.5 2.5" class="march-r"/></svg>'],
    failedspin: ['', '<i class="sq red spin"></i>'],
    stale: ['', '<i class="arc frozen"></i>'],
    staledash: ['', '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.9" fill="none" stroke="#8C959F" stroke-width="1.7" pathLength="24" stroke-dasharray="2 4"/></svg>'],
    creds: ['', '<i class="lock"><i class="sh"></i><i class="bd"></i></i>'],
    ratelimit: ['', RL],
    hourglass: ['', '<i class="hg"></i>'],
    countdown: ['', '<svg viewBox="0 0 12 12" class="cd"><circle cx="6" cy="6" r="4.9" fill="none" stroke="#F5E0A0" stroke-width="2"/><circle class="run" cx="6" cy="6" r="4.9" fill="none" stroke="#9A6700" stroke-width="2" pathLength="24" stroke-dasharray="24 24" transform="rotate(-90 6 6)"/></svg>'],
    finished: ['', '<i class="chk"></i>'],
    finishedring: ['', '<i class="ring-thin"></i><i class="chk sm"></i>'],
    closed: ['', '<i class="hring faint"></i>'],
    none: ['', '<i class="none"></i>'],
    monitor: ['', '<i class="radar"><i class="sweep"></i></i>'],
    k_sub: ['', '<i class="sat"><i></i></i>'],
    k_fork: ['', '<i class="arc k2"></i>'],
    k_shell: ['', '<i class="rbar"></i>'],
    k_mon: ['', '<i class="radar"><i class="sweep"></i></i>'],
    done: ['', '<i class="chk"></i>'],
    timeout: ['', '<i class="sqo amber"></i>'],
    timeoutfill: ['', '<i class="sq amber"></i>'],
    review: ['', '<i class="badge"></i><i class="badge-chk"></i>'],
    reviewflag: ['', '<i class="flag"></i>'],
    reviewring: ['', '<i class="ring-blue"></i><i class="chk sm bluechk"></i>']
  };
  const ind = (k, size) => { const p = P[k]; if (!p) throw new Error("no indicator " + k);
    return `<span class="ind ${p[0]}" role="img" aria-hidden="true"${size ? ` style="font-size:${size}px"` : ""}>${p[1]}</span>`; };
  const KG = { sub: ["subagent"], fork: ["fork"], shell: ["shell"], mon: ["monitor"] };
  /* kind tag: the still version of the kind's own mark plus its name (no person or eye glyphs) */
  const kind = (k, glyphOnly) => `<span class="kind kd-${k}${glyphOnly ? " g" : ""}"${glyphOnly ? ` title="${KG[k][0]}" aria-label="${KG[k][0]}" role="img"` : ""}>${ind("s_" + k)}${glyphOnly ? "" : KG[k][0]}</span>`;

/* which mark each thing shows */
function sessionMarkKey(s) {
  const st = stateOf(s);
  if (st === "red") return "pause";
  /* the storyboard's states (status.ts says what drives each): lock, frozen grey arc, amber dashes turning back, rings shrinking */
  const phase = { signedout: "creds", stale: "stale", retrying: "ratelimit", compacting: "compact" }[s.status];
  if (phase) return phase;
  if (st === "green") return s.statusDetail?.queued ? "queued" : "work";
  if (s.status === "failed") return "failed";
  return "stopped"; // your turn: Claude stopped and waits for you (grey square), whether or not background work runs
}
const sessionMark = s => ind(sessionMarkKey(s));
const kindKey = x => x.agent ? (x.agent.fork ? "fork" : "sub") : x.bg ? (x.bg.kind === "monitor" ? "mon" : "shell") : "sub";
function bgMarkKey(x) {
  if (x.running) return "k_" + kindKey(x);
  if (x.agent && isReview(x.agent) && !reviewed.has(x.agent.id)) return "review";
  if (x.failed) return "failed";
  if (x.st === "timed out") return "timeout";
  if (x.st === "stopped" || x.st === "killed") return "stopped";
  return "done";
}


  /* chosen kind marks (kind-storyboard.html + user picks): agent ring with a core, subagent one dot in orbit,
     fork two dots parting, shell >_ with a bouncing underscore, monitor radar */
  P.work = ['', '<svg class="k" viewBox="0 0 12 12" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8" stroke="var(--mk-C6E9D0)" stroke-width="1.8"/><circle cx="6" cy="6" r="4.8" stroke="var(--mk-1A7F37)" stroke-width="1.8" pathLength="4" stroke-dasharray="1.6 2.4" class="rot" style="--d:.9s"/><circle cx="6" cy="6" r="1.8" fill="var(--mk-1A7F37)"/></svg>'];
  P.k_sub = ['', '<svg class="k" viewBox="0 0 12 12" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="4.4" stroke="var(--mk-7CC48F)" stroke-width="1.6"/><g class="rot" style="--d:1.4s"><circle cx="6" cy="1.6" r="1.8" fill="var(--mk-1A7F37)"/></g></svg>'];
  P.k_fork = ['', '<svg class="k" viewBox="0 0 12 12" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="4.4" stroke="var(--mk-E2D6F8)" stroke-width="1.4"/><g class="rot" style="--d:2.4s"><circle cx="6" cy="10.4" r="1.6" fill="var(--mk-8250DF)" transform="rotate(-50 6 6)"/></g><g class="rot rev" style="--d:2.4s"><circle cx="6" cy="10.4" r="1.6" fill="var(--mk-8250DF)" transform="rotate(50 6 6)"/></g></svg>'];
  P.k_shell = ['', '<svg class="k" viewBox="0 0 12 12" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.8 3.2 5 6 1.8 8.8" stroke="var(--mk-0B7A82)" stroke-width="1.8"/><line x1="6.4" y1="9.5" x2="10.6" y2="9.5" stroke="var(--mk-B6E0E3)" stroke-width="1.9"/><line x1="6.4" y1="9.5" x2="10.6" y2="9.5" stroke="var(--mk-0B7A82)" stroke-width="1.9" class="bounce"/></svg>'];
  /* working with your message queued: the same turning arc, its centre in your blue (status storyboard) */
  P.queued = ['', P.work[1].replace('<circle cx="6" cy="6" r="1.8" fill="var(--mk-1A7F37)"/>', '<circle cx="6" cy="6" r="1.8" fill="var(--mk-0550AE)"/>')];
  /* squares as SVG so they stay square at every size */
  P.stopped = ['', '<svg class="k" viewBox="0 0 12 12" aria-hidden="true"><rect x="2.3" y="2.3" width="7.4" height="7.4" rx="1.1" fill="var(--ink-3)"/></svg>'];
  P.failed = ['', '<svg class="k" viewBox="0 0 12 12" aria-hidden="true"><rect x="2.3" y="2.3" width="7.4" height="7.4" rx="1.1" fill="var(--red)"/></svg>'];
  P.timeout = ['', '<svg class="k" viewBox="0 0 12 12" aria-hidden="true"><rect x="2.4" y="2.4" width="7.2" height="7.2" rx="1" fill="none" stroke="var(--amber)" stroke-width="1" vector-effect="non-scaling-stroke"/></svg>'];
  /* still versions, for finished work in Past */
  P.s_agent = ['', '<svg class="k" viewBox="0 0 12 12" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8" stroke="var(--mk-1A7F37)" stroke-width="1.8"/><circle cx="6" cy="6" r="1.8" fill="var(--mk-1A7F37)"/></svg>'];
  P.s_sub = ['', '<svg class="k" viewBox="0 0 12 12" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="4.4" stroke="var(--mk-7CC48F)" stroke-width="1.6"/><circle cx="6" cy="1.6" r="1.8" fill="var(--mk-1A7F37)"/></svg>'];
  P.s_fork = ['', '<svg class="k" viewBox="0 0 12 12" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="4.4" stroke="var(--mk-E2D6F8)" stroke-width="1.4"/><circle cx="2.9" cy="2.9" r="1.6" fill="var(--mk-8250DF)"/><circle cx="9.1" cy="2.9" r="1.6" fill="var(--mk-8250DF)"/></svg>'];
  P.s_shell = ['', '<svg class="k" viewBox="0 0 12 12" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.8 3.2 5 6 1.8 8.8" stroke="var(--mk-0B7A82)" stroke-width="1.8"/><line x1="6.4" y1="9.5" x2="10.6" y2="9.5" stroke="var(--mk-0B7A82)" stroke-width="1.9"/></svg>'];
  P.s_mon = ['', '<svg class="k" viewBox="0 0 12 12" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="4.8" stroke="var(--mk-0E6BA8)" stroke-width="1.4"/><line x1="6" y1="6" x2="6" y2="2.6" stroke="var(--mk-0E6BA8)" stroke-width="1.6"/></svg>'];
