// Builds the prototype's data files from the backend fixture tree, for compare.sh:
// transcripts.js (window.TRANSCRIPTS, the shape export_transcripts.py writes) and menu.js (window.MENU).
// It reads the fixtures through the same Views and fake script the port gets under --fake, and turns
// the pending requests into ask items with the page's own card.js, so both sides show the same state.
// Usage: node --experimental-strip-types build-proto-fixture.ts <claude-dir> <out-dir>
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { Views } from '../../backend/src/views.ts';
import { FakeDriver, fixtureSessions, loadScript } from '../../backend/src/fake-driver.ts';

const [claudeDir, outDir] = process.argv.slice(2);
if (!claudeDir || !outDir) {
  process.stderr.write('usage: build-proto-fixture.ts <claude-dir> <out-dir>\n');
  process.exit(2);
}

const js = path.join(import.meta.dirname, '..', 'js');
const page = vm.createContext({});
for (const f of ['md.js', 'card.js']) vm.runInContext(fs.readFileSync(path.join(js, f), 'utf8'), page, { filename: f });
const withPending = vm.runInContext('withPending', page) as (items: object[], requests: object[]) => object[];

const script = loadScript(claudeDir);
const views = new Views({ claudeDir, clients: () => new Set(), home: script.home, pollMs: 0, watch: false });
for (const s of fixtureSessions(claudeDir)) views.open(s.id, { path: s.path });
new FakeDriver(views, script).runAll();

type Dump = { items: object[]; pending: object[]; stream: string | null; [k: string]: unknown };
const sessions = views.ids().map((id) => {
  const { items, pending, stream, ...rest } = views.dump(id) as Dump;
  const all = withPending(items, pending);
  if (stream) all.push({ id: 'stream', k: 'claude', ts: new Date().toISOString(), text: stream });
  return { ...rest, name: '', items: all };
});
views.stop();

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'transcripts.js'),
  `// Built from the backend fixtures by build-proto-fixture.ts. Made up.\nwindow.EXPORTED_AT = ${Date.now()};\nwindow.TRANSCRIPTS = ${JSON.stringify(sessions, null, 1)};\n`);
fs.writeFileSync(path.join(outDir, 'menu.js'),
  `// From the fake script's menu. Made up.\nwindow.MENU = ${JSON.stringify(script.menu ?? { models: [], commands: [] }, null, 1)};\n`);
process.stdout.write(`build-proto-fixture: ${sessions.length} sessions\n`);
