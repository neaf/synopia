/* Format: escaping, clocks, durations and the model label. DOM-free (app/web/test/format.test.js runs it
   in Node). Every string that goes into HTML, as text or as an attribute, passes through esc. */
export const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/* ---------- durations ---------- */
/* a step's or a turn's length, as the CLI writes it: "5s", "8m", "1h 12m" */
export function took(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
/* a running time, to the second while under an hour: "42s", "3m 05s", "1h 12m" */
export function tookLive(ms) {
  const t = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, sec = t % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${String(sec).padStart(2, "0")}s` : `${sec}s`;
}
/* how long since a time (ms): "5 min", "2 h 10 min", "3 d" */
export function dur(ms) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} d`;
}
/* a countdown to a time (ms), the rate-limit retry: "in 38s", then "now" */
export const left = at => { const s = Math.round((at - Date.now()) / 1000); return s > 0 ? `in ${s}s` : "now"; };

/* The same three as spans the 1 s ticker keeps current (main.js), and a block's signature leaves out
   (transcript.js `still`): data-live holds the start (ISO), data-age the time (ms), data-until the end (ms). */
export const live = (startIso, ms) => `<span data-live="${esc(startIso)}">${tookLive(ms)}</span>`;
export const age = ms => `<span data-age="${esc(ms)}">${dur(ms)}</span>`;
export const until = at => `<span data-until="${esc(at)}">${esc(left(at))}</span>`;

/* ---------- clocks ---------- */
/* times follow macOS's 12- or 24-hour setting, which the app passes in as window.SYNOPIA_CLOCK24 (the web
   view's locale can't see it; docs/WKWebView and AppKit.md); without it the locale decides */
const hourOpts = () => typeof globalThis.SYNOPIA_CLOCK24 === "boolean" ? { hourCycle: globalThis.SYNOPIA_CLOCK24 ? "h23" : "h12" } : {};
export const hhmm = ts => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...hourOpts() });
export const day = ts => new Date(ts).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });

/* ---------- the model ---------- */
/* A model id as a name, until the folder's menu names it: "eu.anthropic.claude-opus-5-5[1m]" reads
   "Claude Opus 5.5 (1M context)". Region and provider prefixes, an ARN's path, a date, a Vertex `@`
   version and a Bedrock `-v1:0` go (docs/Agent SDK.md); a bare alias ("haiku") reads "Claude Haiku";
   anything else stays. */
export function modelLabel(id) {
  let s = String(id ?? "").trim(); if (!s) return "Default";
  const big = /\[1m\]$/i.test(s); s = s.replace(/\[1m\]$/i, "");
  s = s.slice(s.lastIndexOf("/") + 1).replace(/^([a-z]{2,7}\.)*anthropic\./i, "").replace(/^[a-z]{2,7}\.(?=claude-)/i, "")
    .replace(/@.*$/, "").replace(/-v\d+(:\d+)?$/i, "").replace(/-\d{8}$/, "").replace(/-latest$/i, "");
  const fam = /^(opus|sonnet|haiku)$/i.test(s) ? [s] : null;
  const m = fam ? null : /^claude-((?:[a-z]+|\d+)(?:-(?:[a-z]+|\d+))*)$/i.exec(s);
  if (!fam && !m) return String(id);
  const parts = fam || m[1].split("-"), word = parts.filter(p => !/^\d+$/.test(p)), num = parts.filter(p => /^\d+$/.test(p));
  const name = ["Claude", ...word.map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()), ...(num.length ? [num.join(".")] : [])].join(" ");
  return big ? `${name} (1M context)` : name;
}
