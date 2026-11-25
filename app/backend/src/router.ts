// Page to server (FR-PLAT-15, NFR-07): one handler per frame type. Each frame is checked against the
// shared schema (app/web/js/protocol.js), an id the page holds is resolved once, and one module acts.
// An action (protocol.js ACTIONS) with an `id` gets one `ack {id, ok, error}`, to the page that sent it,
// once it is done: the page shows `error` and keeps what it had (Q9). A handler that throws is logged
// (`router.failed`) and acked `ok: false`; the daemon goes on serving. Once stopped (a shutdown or a
// handover), every action is refused with an ack, and an action still running is acked at once.
import { ACTIONS, PAGE, problem } from '../../web/js/protocol.js';
import type { Client } from './server.ts';
import type { Sessions } from './sessions.ts';
import type { Session, SendResult } from './session.ts';
import type { Publisher } from './publisher.ts';
import type { Transcripts } from './transcripts.ts';
import type { Menus } from './menu.ts';
import type { Store, ReviewedMarks } from './store.ts';
import type { Place, Result as LayoutResult } from './layout.ts';
import type { CardAnswer } from './cards.ts';
import type { Image } from './sdk.ts';
import type { Bat } from './preview.ts';
import { previewFile, themeOf } from './preview.ts';
import { openTarget } from './open.ts';
import { patchUi } from './ui-state.ts';
import { displayPath } from './paths.ts';
import type { Log } from './log.ts';
import { nullLog } from './log.ts';

export const STOPPING = 'Synopia is restarting, so that wasn\'t done. Do it again in a moment.';
export const FAILED = 'Something went wrong in Synopia, so that wasn\'t done. backend.log has the details.';
export const UNREADABLE = 'Synopia couldn\'t read that message from the page.';
const GONE: SendResult = { ok: false, error: "That session isn't open any more." };
const NO_AGENT = "That subagent isn't in an open session any more.";

export type RouterOptions = {
  sessions: Sessions;
  transcripts: Transcripts;
  publisher: Publisher;
  menus: Menus;
  store: Store;
  marks: ReviewedMarks;
  bat: Promise<Bat>;
  home: string;
  log?: Log;
  dryRun?: boolean; // `open` logs and opens nothing (checks)
};

type Msg = { t: string; [k: string]: unknown };
type Result = SendResult | LayoutResult | void;
type Handler = (client: Client, m: Msg) => Result | Promise<Result>;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
// moveSession's one target: before or after a session, or last in a group
function placeOf(m: Msg, resolve: (id: string) => string): Place | null {
  const before = str(m.before), after = str(m.after), group = str(m.group);
  if ([before, after, group].filter((x) => x !== null).length !== 1) return null;
  return before !== null ? { before: resolve(before) } : after !== null ? { after: resolve(after) } : { group: group as string };
}

export class Router {
  private o: RouterOptions;
  private log: Log;
  private stopped = false;
  private running = new Map<Client, Set<string>>(); // action ids not acked yet, per page
  private handlers: Record<string, Handler>;

  constructor(opts: RouterOptions) {
    this.o = opts;
    this.log = opts.log ?? nullLog;
    this.handlers = this.table();
  }

  // One frame from an authenticated page (server.ts).
  handle(client: Client, m: Msg): void {
    const action = ACTIONS.has(m.t), id = action ? str(m.id) : null;
    if (this.stopped) {
      if (id) this.ack(client, id, { ok: false, error: STOPPING });
      return;
    }
    const handler = Object.hasOwn(this.handlers, m.t) ? this.handlers[m.t] : undefined;
    const bad = handler ? problem(PAGE, m) : `unknown type ${m.t}`;
    if (!handler || bad) {
      this.log(handler ? 'router.invalid' : 'router.unknown', { t: m.t, problem: bad });
      if (id) this.ack(client, id, { ok: false, error: UNREADABLE });
      return;
    }
    let r: Result | Promise<Result>;
    try {
      r = handler(client, m);
    } catch (e) {
      this.failed(client, m.t, id, e);
      return;
    }
    if (!(r instanceof Promise)) {
      if (id) this.ack(client, id, r);
      return;
    }
    if (id) this.begin(client, id);
    r.then(
      (res) => { if (id && this.end(client, id)) this.ack(client, id, res); },
      (e) => { this.failed(client, m.t, id && this.end(client, id) ? id : null, e); },
    );
  }

  // Shutdown: no frame acts any more; the actions still running are acked now, as not done.
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const [client, ids] of this.running) for (const id of ids) this.ack(client, id, { ok: false, error: STOPPING });
    this.running.clear();
  }

  private failed(client: Client, t: string, id: string | null, e: unknown): void {
    this.log('router.failed', { t, error: String((e as Error)?.name ?? 'error') }); // the name only: a message can hold what the page sent
    if (id) this.ack(client, id, { ok: false, error: FAILED });
  }

  private ack(client: Client, id: string, r: Result): void {
    this.o.publisher.reply(client, r && !r.ok ? { t: 'ack', id, ok: false, error: r.error } : { t: 'ack', id, ok: true });
  }

  private begin(client: Client, id: string): void {
    let ids = this.running.get(client);
    if (!ids) this.running.set(client, ids = new Set());
    ids.add(id);
  }

  // false when it was acked already (by stop)
  private end(client: Client, id: string): boolean {
    const ids = this.running.get(client);
    if (!ids?.delete(id)) return false;
    if (!ids.size) this.running.delete(client);
    return true;
  }

  // The open session an id names (through its aliases), and what to answer when there is none.
  private act<T>(sid: unknown, f: (s: Session) => T): T | SendResult {
    const s = this.o.sessions.get(String(sid));
    return s ? f(s) : GONE;
  }

  private table(): Record<string, Handler> {
    const { sessions, transcripts, publisher, menus, store, marks, log } = { ...this.o, log: this.log };
    const toastTo = (client: Client) => (text: string) => publisher.toast(text, client);
    const agent = (m: Msg) => str(m.agent);
    return {
      // ---------- requests ----------
      view: (client, m) => {
        const sid = sessions.resolve(m.sid as string);
        void publisher.view(client, sid, agent(m), str(m.from), str(m.bg));
        if (!agent(m) && !str(m.bg)) sessions.get(sid)?.checkFolder(); // the session you chose: its folder gone or not (R3.11)
        const folder = publisher.meta(sid)?.cwd, s = sessions.get(sid);
        if (folder && s) void menus.viewed(client, folder, s.cwd, s.menuSource());
      },
      earlier: (client, m) => { publisher.earlier(client, sessions.resolve(m.sid as string), agent(m), m.before as string); },
      earlierOutput: (client, m) => publisher.earlierOutput(client, sessions.resolve(m.sid as string), m.bg as string, m.before as number),
      toolOutput: async (client, m) => { await publisher.toolOutput(client, sessions.resolve(m.sid as string), agent(m), m.toolUseId as string); },
      listRecent: (client, m) => {
        const filter = str(m.filter) ?? '';
        return sessions.searchRecent(filter).then(
          (r) => publisher.reply(client, { t: 'recent', filter, sessions: r.rows, total: r.total, folders: r.folders, matched: r.matched }),
          (e) => {
            log('sessions.listFailed', { error: String((e as Error)?.name ?? 'error') });
            publisher.reply(client, { t: 'recent', filter, sessions: [], error: true });
          },
        );
      },
      // the folder list (R3.3, R3.13): known folders (no disk read), one folder's children on Tab, gone checks
      listFolders: (client) => sessions.listFolders().then(
        (rows) => publisher.reply(client, { t: 'folders', rows }),
        (e) => {
          log('sessions.foldersFailed', { error: String((e as Error)?.name ?? 'error') });
          publisher.reply(client, { t: 'folders', rows: [], error: true });
        },
      ),
      completeFolder: (client, m) => sessions.folders.complete(m.path as string).then((r) => publisher.reply(client, { t: 'completion', ...r })),
      checkFolders: (client, m) => sessions.folders.check((m.paths as unknown[]).filter((x): x is string => typeof x === 'string'), m.chosen === true)
        .then((states) => publisher.reply(client, { t: 'folderState', states })),
      // a text file's read-only preview; anything else opens as `open` does, and the page hears it did
      preview: (client, m) => this.o.bat.then((bat) => previewFile(m.path, {
        bat, theme: themeOf(m.theme), log, display: (p) => displayPath(p, this.o.home), reply: (r) => publisher.reply(client, r), toast: toastTo(client),
        open: (p) => openTarget({ path: p }, { dryRun: this.o.dryRun, log, onError: toastTo(client) }),
      })),
      open: (client, m) => { openTarget({ path: m.path, url: m.url }, { dryRun: this.o.dryRun, log, onError: toastTo(client) }); },
      // ---------- state the page holds ----------
      // the page's UI state (R3.9): stored, returned in hello, never broadcast
      ui: (client, m) => { patchUi(store, m.patch, { resolve: (id) => sessions.resolve(id), known: (id) => transcripts.has(id), toast: toastTo(client) }); },
      // ---------- actions ----------
      // shown at once, queued while a turn runs (session.ts)
      send: (client, m) => this.act(m.sid, (s) => {
        const images = ((m.images ?? []) as Image[]).filter((im) => im && typeof im.mediaType === 'string' && typeof im.data === 'string');
        return s.send(str(m.text) ?? '', images, str(m.uuid) ?? undefined, client);
      }),
      bang: (client, m) => this.act(m.sid, (s) => s.runBang(m.command as string, str(m.uuid) ?? undefined, client)), // bash mode (R5.13)
      answer: (_client, m) => this.act(m.sid, (s) => s.answer(m.requestId as string, (m.answer ?? {}) as CardAnswer)),
      interrupt: (client, m) => this.act(m.sid, (s) => s.interrupt(client)),
      background: (_client, m) => this.act(m.sid, (s) => s.background()), // b, b (R9): an error only when nothing moved
      setModel: (_client, m) => this.act(m.sid, (s) => s.setModel(m.model as string, str(m.effort) || null)),
      cancelTakeover: (_client, m) => this.act(m.sid, (s) => s.cancelTakeover()),
      close: (_client, m) => sessions.close(m.sid as string),
      newSession: (_client, m) => sessions.newSessionIn(m.cwd as string, m.create === true),
      continueSession: (_client, m) => sessions.continueSession(m.sid as string, m.cwd as string, m.create === true),
      openSession: (_client, m) => sessions.openSession(m.sid as string)
        .catch((): SendResult => ({ ok: false, error: "Synopia couldn't read the list of past sessions." })),
      // a mark only for a subagent an open session has: an unknown id would be stored for nothing;
      // the 1000 newest marks are kept (store.ts REVIEWED_MAX)
      reviewed: (_client, m) => {
        const id = m.agentId as string;
        if (!transcripts.ids().some((sid) => transcripts.get(sid)?.getAgent(id))) return { ok: false, error: NO_AGENT };
        if (marks.mark(id)) publisher.reviewed(id);
      },
      // the sidebar's layout (layout.ts): every session id through its aliases, so an intent sent
      // before a new session got its real id still moves that session
      moveSession: (_client, m) => {
        const to = placeOf(m, (id) => sessions.resolve(id));
        return to ? sessions.layout.move(sessions.resolve(m.sid as string), to) : { ok: false, error: UNREADABLE };
      },
      newGroup: (_client, m) => sessions.layout.newGroup(sessions.resolve(m.sid as string), sessions.resolve(m.onto as string), m.group as string, str(m.name) ?? undefined),
      renameGroup: (_client, m) => sessions.layout.renameGroup(m.group as string, m.name as string),
    };
  }
}
