// Builds the prototype's data files from the backend fixture tree, for compare.sh:
// transcripts.js (window.TRANSCRIPTS, the shape prototype/app.html reads) and menu.js (window.MENU).
// It runs the fixtures through the same Transcripts, Publisher, Sessions and scripted SDK the port gets under
// `dev.sh --script` (on a temp copy and a temp state folder), and turns the pending requests into ask
// items with the page's own card.js, so both sides show the same state.
// Usage: node --experimental-strip-types build-proto-fixture.ts <claude-dir> <out-dir>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Transcripts } from '../../backend/src/transcripts.ts';
import { Publisher } from '../../backend/src/publisher.ts';
import { Sessions } from '../../backend/src/sessions.ts';
import { openStore } from '../../backend/src/store.ts';
import { toCommands, toModels } from '../../backend/src/sdk.ts';
import { openScripted, SCRIPT_FILE } from '../../backend/dev/scripted-sdk.ts';
import type { SessionState } from '../../backend/src/status.ts';
import type { Client } from '../../backend/src/server.ts';

const [src, outDir] = process.argv.slice(2);
if (!src || !outDir) {
  process.stderr.write('usage: build-proto-fixture.ts <claude-dir> <out-dir>\n');
  process.exit(2);
}

const js = path.join(import.meta.dirname, '..', 'js');
const page = vm.createContext({});
for (const f of ['md.js', 'card.js']) vm.runInContext(fs.readFileSync(path.join(js, f), 'utf8'), page, { filename: f });
const withPending = vm.runInContext('withPending', page) as (items: object[], requests: object[]) => object[];

// the script writes to its transcripts as a CLI would: a copy
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-proto-'));
const claudeDir = path.join(tmp, 'claude'), stateDir = path.join(tmp, 'state');
fs.cpSync(src, claudeDir, { recursive: true });
const scripted = openScripted({ file: path.join(claudeDir, SCRIPT_FILE), claudeDir, stateDir });
const store = openStore(stateDir);
const transcripts = new Transcripts({
  claudeDir, home: scripted.home, pollMs: 0, watch: false,
  written: (sid) => store.state.written[sid], answerOf: (id) => store.state.answers[id], planOf: (id) => store.state.plans[id],
});
// One page that views each conversation in turn: its `items` resets are what the prototype shows.
const got: { t: string; [k: string]: unknown }[] = [];
const viewer: Client = { send: (m) => got.push(m as { t: string }), close: () => {} };
const publisher = new Publisher({ transcripts, clients: () => new Set([viewer]), home: scripted.home, recheckMs: 0, written: (sid) => store.state.written[sid] });
const sessions = new Sessions({ store, transcripts, publisher, sdk: scripted.sdk, home: scripted.home, now: scripted.clock.now, timer: scripted.clock.timer });
sessions.start();
scripted.attach(sessions);
await scripted.whenPlayed(); // every step at load: the cards wait, the stream preview is whole
transcripts.poll();

// The last WINDOW items of a conversation, as a page that views it gets them.
const viewed = (sid: string, agent: string | null): { upsert: object[]; total: number } => {
  got.length = 0;
  publisher.view(viewer, sid, agent);
  return got.find((m) => m.t === 'items') as unknown as { upsert: object[]; total: number };
};
type Hello = { id: string; agents: { id: string }[]; stream: string | null; held: unknown; state: SessionState; [k: string]: unknown };
const sessionsOut = (publisher.sessions() as Hello[]).map(({ stream, held: _held, state, agents, ...meta }) => {
  const { upsert: items, total } = viewed(meta.id, null);
  const pending = publisher.pending().filter((p) => p.sid === meta.id).map((p) => p.request);
  const rest = { ...meta, total, agents: agents.map((a) => ({ ...a, items: viewed(meta.id, a.id).upsert })) };
  const all = withPending(items, pending);
  if (stream) all.push({ id: 'stream', k: 'claude', ts: new Date().toISOString(), text: stream });
  // the prototype reads the status and its age as fields of their own
  return { ...rest, status: state.status, statusAt: state.since, name: '', items: all };
});
sessions.stop();
publisher.stop();
transcripts.stop();
store.close();
fs.rmSync(tmp, { recursive: true, force: true });

const menu = scripted.script.menu;
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'transcripts.js'),
  `// Built from the backend fixtures by build-proto-fixture.ts. Made up.\nwindow.EXPORTED_AT = ${Date.now()};\nwindow.TRANSCRIPTS = ${JSON.stringify(sessionsOut, null, 1)};\n`);
fs.writeFileSync(path.join(outDir, 'menu.js'),
  `// From the script's menu. Made up.\nwindow.MENU = ${JSON.stringify({ models: toModels(menu?.models ?? []), commands: toCommands(menu?.commands ?? []) }, null, 1)};\n`);
process.stdout.write(`build-proto-fixture: ${sessionsOut.length} sessions\n`);
process.exit(0);
