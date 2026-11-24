/* Protocol: the one schema of the WebSocket between the page and the backend, the source for every field.
   DOM-free: the page imports it (connection.js), and so does the backend (router.ts, publisher.ts and their
   tests). A frame is JSON `{t, ...}`. The backend's `hello` carries VERSION; a page whose VERSION differs
   reloads. An action carries an `id` and gets one `ack {id, ok, error}` back, to the page that sent it.

   Field types: "str", "num", "bool", "obj", "arr", "any"; a trailing "?" also takes a missing field or null. */
export const VERSION = 2;

/* page to backend */
export const PAGE = {
  /* the token, first and only once (server.ts) */
  auth: { token: "str" },
  /* requests: answered by data */
  view: { sid: "str", agent: "str?", from: "str?" },
  earlier: { sid: "str", agent: "str?", before: "str" },
  toolOutput: { sid: "str", agent: "str?", toolUseId: "str" },
  listRecent: { filter: "str?" },
  preview: { path: "str", theme: "str?" },
  open: { path: "str?", url: "str?" },
  /* state the page holds: the last one wins; sent again whole on a reconnect */
  ui: { patch: "obj" },
  /* actions: each with an id, acked */
  send: { id: "str?", sid: "str", text: "str?", images: "arr?", uuid: "str?" },
  bang: { id: "str?", sid: "str", command: "str", uuid: "str?" },
  answer: { id: "str?", sid: "str", requestId: "str", answer: "obj?" },
  interrupt: { id: "str?", sid: "str" },
  background: { id: "str?", sid: "str" },
  close: { id: "str?", sid: "str" },
  newSession: { id: "str?" },
  openSession: { id: "str?", sid: "str" },
  cancelTakeover: { id: "str?", sid: "str" },
  setModel: { id: "str?", sid: "str", model: "str", effort: "str?" },
  reviewed: { id: "str?", agentId: "str" },
  /* the sidebar's layout, which the backend owns (layout.ts): a session moves before or after another, or last
     into a group ("others" is Not in a group); a new group of a session not in a group and the one dropped on it */
  moveSession: { id: "str?", sid: "str", before: "str?", after: "str?", group: "str?" },
  newGroup: { id: "str?", sid: "str", onto: "str", group: "str", name: "str?" },
  renameGroup: { id: "str?", group: "str", name: "str" },
};

/* a send's images (FR-SES-14): PNG or JPEG, 5 MB each and 20 MB together, decoded. Base64 makes 20 MB about
   27 MB, so the frame stays under the socket's 32 MB cap (server.ts MAX_PAYLOAD), which closes the socket
   instead of answering. The page checks before it sends (composer.js), the backend again (sdk.ts imageError). */
export const IMAGE_TYPES = ["image/png", "image/jpeg"];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;

/* the page's frames that are actions: the router acks each one that has an id */
export const ACTIONS = new Set(["send", "bang", "answer", "interrupt", "background", "close", "newSession", "openSession", "cancelTakeover", "setModel", "reviewed", "moveSession", "newGroup", "renameGroup"]);

/* backend to page */
export const SERVER = {
  hello: { v: "num", code: "str", sessions: "arr", pending: "arr", layout: "obj", menu: "obj", ui: "obj?", update: "bool?" },
  /* a session's meta; `replaces` once when its id changed, with the layout that holds the new id; `{id, held}`
     alone for the messages held behind a card. hello's sessions also carry agents, background and stream. */
  session: {
    id: "str", replaces: "str?", title: "str?", name: "str?", now: "str?", cwd: "str?", prs: "arr?", state: "obj?",
    model: "any", effort: "any", ask: "obj?", outbox: "arr?", bang: "obj?", held: "arr?",
    agents: "arr?", background: "arr?", stream: "str?", layout: "obj?",
  },
  /* the sidebar's groups and order, whole, closed sessions' ids included (hidden), after any change */
  layout: { layout: "obj" },
  removed: { id: "str" },
  items: { sid: "str", agent: "str?", upsert: "arr", total: "num", reset: "bool", prepend: "bool?" },
  agents: { sid: "str", upsert: "arr" },
  background: { sid: "str", upsert: "arr" },
  pending: { sid: "str", request: "obj?", cleared: "str?" },
  stream: { sid: "str", text: "str?", clear: "bool?" },
  menu: { cwd: "str", commands: "arr", models: "arr" },
  toast: { text: "str" },
  toolOutput: { sid: "str", agent: "str?", toolUseId: "str", text: "str" },
  recent: { filter: "str", sessions: "arr", error: "bool?" },
  /* a text file's preview, or `opened` for a file the backend opened instead */
  preview: { path: "str", opened: "bool?", display: "str?", lang: "str?", html: "str?", lines: "num?", truncated: "bool?", size: "num?" },
  restore: { sid: "str", texts: "arr" },
  update: { pending: "bool" },
  ack: { id: "str", ok: "bool", error: "str?" },
};

const TYPES = {
  str: v => typeof v === "string",
  num: v => typeof v === "number" && Number.isFinite(v),
  bool: v => typeof v === "boolean",
  obj: v => !!v && typeof v === "object" && !Array.isArray(v),
  arr: v => Array.isArray(v),
  any: () => true,
};

/* What is wrong with a frame, or null when it fits. `from`: PAGE or SERVER. `strict` also refuses a
   field the schema doesn't name (the tests; at run time a field more is ignored). */
export function problem(from, msg, strict = false) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return "not an object";
  if (typeof msg.t !== "string") return "no type";
  if (!Object.hasOwn(from, msg.t)) return `unknown type ${msg.t}`;
  const fields = from[msg.t];
  for (const [k, spec] of Object.entries(fields)) {
    const opt = spec.endsWith("?"), type = opt ? spec.slice(0, -1) : spec, v = msg[k];
    if (v === undefined || v === null) { if (opt || type === "any") continue; return `${msg.t}.${k} missing`; }
    if (!TYPES[type](v)) return `${msg.t}.${k} is not ${type}`;
  }
  if (strict) for (const k of Object.keys(msg)) if (k !== "t" && !Object.hasOwn(fields, k)) return `${msg.t}.${k} not in the schema`;
  return null;
}
