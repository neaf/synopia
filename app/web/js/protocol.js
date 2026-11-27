/* Protocol: the one schema of the WebSocket between the page and the backend, the source for every field.
   DOM-free: the page imports it (connection.js), and so does the backend (router.ts, publisher.ts and their
   tests). A frame is JSON `{t, ...}`. The backend's `hello` carries VERSION; a page whose VERSION differs
   waits for a daemon of its own version (connection.js). An action carries an `id` and gets one
   `ack {id, ok, error}` back, to the page that sent it.

   Field types: "str", "num", "bool", "obj", "arr", "any"; a trailing "?" also takes a missing field or null. */
export const VERSION = 4;

/* page to backend */
export const PAGE = {
  /* the token, first and only once (server.ts) */
  auth: { token: "str" },
  /* requests: answered by data */
  /* a conversation (agent null for the main one), or a background shell's or monitor's output (bg, its tool use id;
     from: where the output the page had loaded began) */
  view: { sid: "str", agent: "str?", from: "str?", bg: "str?" },
  earlier: { sid: "str", agent: "str?", before: "str" },
  earlierOutput: { sid: "str", bg: "str", before: "num" },
  toolOutput: { sid: "str", agent: "str?", toolUseId: "str" },
  /* ⌘F in the transcript (R5.12e): the matches of q in the whole view (view: a subagent's, shell's or monitor's id, null
     for the main conversation); seq comes back in `found` */
  find: { sid: "str", view: "str?", q: "str", seq: "num?" },
  listRecent: { filter: "str?" },
  /* the folder list (R3.3, R3.13): the known folders; one folder's child folders, on Tab; whether named paths are
     gone (a path inside a protected folder only when `chosen`) */
  listFolders: {},
  completeFolder: { path: "str" },
  checkFolders: { paths: "arr", chosen: "bool?" },
  preview: { path: "str", theme: "str?" },
  open: { path: "str?", url: "str?" },
  /* inline-code paths in a reply (R5.9, path-links.js): resolved against the session's folder and home, answered by `pathState` */
  resolvePaths: { sid: "str", paths: "arr" },
  /* /mcp (R5.15): the session's MCP servers, read now; answered by `mcp` */
  mcp: { sid: "str" },
  /* state the page holds: the last one wins; sent again whole on a reconnect */
  ui: { patch: "obj" },
  /* actions: each with an id, acked */
  send: { id: "str?", sid: "str", text: "str?", images: "arr?", uuid: "str?" },
  bang: { id: "str?", sid: "str", command: "str", uuid: "str?" },
  answer: { id: "str?", sid: "str", requestId: "str", answer: "obj?" },
  interrupt: { id: "str?", sid: "str" },
  background: { id: "str?", sid: "str" },
  /* f, f (R9.8): send the queued messages now; `draft` the box's message as a send's {text, images, uuid}, if any */
  sendNow: { id: "str?", sid: "str", draft: "obj?" },
  close: { id: "str?", sid: "str" },
  /* a folder as the page shows it (`~/…` or absolute); `create`: mkdir -p it first, the create row's */
  newSession: { id: "str?", cwd: "str", create: "bool?" },
  continueSession: { id: "str?", sid: "str", cwd: "str", create: "bool?" },
  openSession: { id: "str?", sid: "str" },
  cancelTakeover: { id: "str?", sid: "str" },
  setModel: { id: "str?", sid: "str", model: "str", effort: "str?" },
  /* an open item of the session's list (open-items.ts, FR-ITEM-03, -10): act "reviewed" is Mark reviewed on a review
     item, "notItem" is `d` on an open item that isn't a review item, "undo" reopens a line Synopia closed this turn;
     refused for an item no open session's list holds */
  item: { id: "str?", sid: "str", item: "str", act: "str" },
  /* the sidebar's layout, which the backend owns (layout.ts): a session moves before or after another, or last
     into a group ("others" is Not in a group); a new group of a session not in a group and the one dropped on it */
  moveSession: { id: "str?", sid: "str", before: "str?", after: "str?", group: "str?" },
  newGroup: { id: "str?", sid: "str", onto: "str", group: "str", name: "str?" },
  renameGroup: { id: "str?", group: "str", name: "str" },
  /* /mcp (R5.15): one server's action: login, logout, reconnect, enable, disable, or cancel (kills a running sign-in) (mcp.ts); its outcome comes as `mcp` */
  mcpAction: { id: "str?", sid: "str", name: "str", action: "str" },
  /* the credential refresh of the session's folder (creds.ts, 2026-11-26): save its command and run it now (empty
     clears it), a line typed into the running command, or stop it; what follows comes as `creds` */
  credsSave: { id: "str?", sid: "str", command: "str" },
  credsInput: { id: "str?", sid: "str", text: "str" },
  bangInput: { id: "str?", sid: "str", text: "str" },
  /* Esc, Esc in a run's shell view (R9.4, 2026-11-26): stop your `!` command, or Claude's background shell or monitor (stopTask), by its id */
  bangStop: { id: "str?", sid: "str", bg: "str" },
  stopTask: { id: "str?", sid: "str", bg: "str" },
  credsCancel: { id: "str?", sid: "str" },
};

/* a send's images (FR-SES-14): PNG or JPEG, 5 MB each and 20 MB together, decoded. Base64 makes 20 MB about
   27 MB, so the frame stays under the socket's 32 MB cap (server.ts MAX_PAYLOAD), which closes the socket
   instead of answering. The page checks before it sends (composer.js), the backend again (sdk.ts imageError). */
export const IMAGE_TYPES = ["image/png", "image/jpeg"];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;

/* the page's frames that are actions: the router acks each one that has an id */
export const ACTIONS = new Set(["send", "bang", "bangInput", "answer", "interrupt", "background", "sendNow", "close", "newSession", "continueSession", "openSession", "cancelTakeover", "setModel", "item", "moveSession", "newGroup", "renameGroup", "mcpAction", "credsSave", "credsInput", "credsCancel", "bangStop", "stopTask"]);

/* backend to page */
export const SERVER = {
  hello: { v: "num", code: "str", sessions: "arr", pending: "arr", layout: "obj", menu: "obj", ui: "obj?", update: "bool?" },
  /* a session's meta; `replaces` once when its id changed, with the layout that holds the new id; `{id, held}`
     alone for the messages held behind a card. hello's sessions also carry agents, background, stream and openItems
     (the `openItems` frame's fields). */
  session: {
    id: "str", replaces: "str?", title: "str?", name: "str?", now: "str?", cwd: "str?", prs: "arr?", state: "obj?",
    model: "any", effort: "any", ask: "obj?", outbox: "arr?", bang: "obj?", bangs: "arr?", held: "arr?",
    agents: "arr?", background: "arr?", stream: "str?", openItems: "obj?", layout: "obj?", gone: "bool?",
  },
  /* a session started another (Synopia's start_session tool, R3.15): a page viewing `from` shows `sid` */
  started: { sid: "str", from: "str" },
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
  /* the answer to `find` (find.ts): hits [{id, at: [[from, to], …]}] in transcript order (id an item's, or the view's for
     a shell's output), the offsets in that item's search text; total matches, more when past 10,000 */
  found: { sid: "str", view: "str?", q: "str", seq: "num?", hits: "arr", total: "num", more: "bool?" },
  /* a shown shell's or monitor's output (R7.2): a part [from, to) of total, in bytes for a shell, in events for a
     monitor; a reset, the part before what the page has (prepend), else what came after it. lost: "unnamed" (no
     output file named) or "gone" (it can't be read) */
  output: { sid: "str", bg: "str", text: "str", err: "str?", from: "num", to: "num", total: "num", reset: "bool?", prepend: "bool?", lost: "str?" },
  /* the Open list: at most 50 rows, and the totals: past sessions, their folders, how many match the filter */
  recent: { filter: "str", sessions: "arr", total: "num?", folders: "num?", matched: "num?", error: "bool?" },
  /* the known folders ({path, sessions, lastUsed}), newest first */
  folders: { rows: "arr", error: "bool?" },
  /* the child folders of `path`, the folder typed so far */
  completion: { path: "str", names: "arr", error: "str?" },
  /* per path asked: {path, gone} */
  folderState: { states: "arr" },
  /* per path asked: {p, path, kind}; path the absolute one and kind "file" or "folder" when it is there, both null when not */
  pathState: { sid: "str", states: "arr" },
  /* a text file's preview, or `opened` for a file the backend opened instead */
  preview: { path: "str", opened: "bool?", display: "str?", lang: "str?", html: "str?", lines: "num?", truncated: "bool?", size: "num?" },
  /* messages that didn't go, back in the box: their texts, and the pasted images they carried ({mediaType, data, n?}) */
  restore: { sid: "str", texts: "arr", images: "arr?" },
  update: { pending: "bool" },
  /* /mcp (R5.15), to every page, whole: the session's servers ({name, status, kind, scope, signIn, reconnect, busy}),
     the last action's error (one sentence), a note instead of the list (a terminal holds it), and `reading` while asked */
  mcp: { sid: "str", servers: "arr", error: "str?", note: "str?", reading: "bool?" },
  /* the credential refresh of a folder (creds.ts, 2026-11-26), to every page, whole: the sessions whose sign-in
     expired there, `phase` (ask: no command saved; running; failed; idle: nothing to show), the command saved
     (or the guess to confirm), the running command's output so far (16 KB at most), the last failure's sentence */
  creds: { root: "str", sids: "arr", phase: "str", command: "str", output: "str", error: "str" },
  /* the session's open items (open-items.ts, FR-ITEM-05), to every page, whole on each change: `items` the open Y items
     (review items among them, kind "review", with the subagent's `agent` id), `checks` the open A items, `closed` the
     items closed this turn, `unread` the ledger lines Synopia can't read, `note` why nothing could be read */
  openItems: { sid: "str", items: "arr", checks: "arr", closed: "arr", unread: "num", note: "str?" },
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
