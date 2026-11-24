// Checks the page scripts without a browser: each file in app/web/js parses as what index.html loads it as
// (a classic script or an ES module), every module import names a file that exists, and every file is
// loaded or imported by something, no import cycle, and no module but test-api.js writes window. Prints the
// bad files, one per line, and exits 1 if there are any.
// usage: node app/web/dev/check-web.mjs   (app/check.sh runs it for its web line)
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const web = resolve(import.meta.dirname, '..');
const html = readFileSync(join(web, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const tags = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => ({ src: /\bsrc="([^"]+)"/.exec(m[1])?.[1], module: /\btype="module"/.test(m[1]) }));
const classic = new Set(tags.filter((t) => t.src && !t.module).map((t) => join(web, t.src)));
const entries = tags.filter((t) => t.src && t.module).map((t) => join(web, t.src));
const bad = [];
const files = readdirSync(join(web, 'js')).filter((f) => f.endsWith('.js')).map((f) => join(web, 'js', f));

for (const t of tags) if (t.src && !existsSync(join(web, t.src))) bad.push(`index.html: ${t.src} does not exist`);

// the modules reachable from the entries, each parsed as a module, its relative imports resolved
const modules = new Set();
const graph = new Map(); // module -> the modules it imports
const importsOf = (src) => [...src.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm)].map((m) => m[1] ?? m[2]);
const walk = (file) => {
  if (modules.has(file)) return;
  modules.add(file);
  const src = readFileSync(file, 'utf8');
  // app/web/package.json says "type": "module", so node parses js/ files as modules
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) bad.push(`${relative(web, file)}: ${(r.stderr.match(/^\w*Error: .*$/m) || [r.stderr.trim()])[0]}`);
  graph.set(file, []);
  for (const spec of importsOf(src)) {
    if (!spec.startsWith('.')) { bad.push(`${relative(web, file)}: imports ${spec} (only relative files)`); continue; }
    const target = resolve(dirname(file), spec);
    if (!existsSync(target)) bad.push(`${relative(web, file)}: imports ${spec}, which does not exist`);
    else { graph.get(file).push(target); walk(target); }
  }
};
for (const e of entries) if (existsSync(e)) walk(e);

// no import cycles: a module that needs one the other way gets a hook (main.js wires them)
const done = new Set(), path = [];
const cycle = (file) => {
  if (done.has(file)) return;
  const at = path.indexOf(file);
  if (at >= 0) { bad.push(`import cycle: ${[...path.slice(at), file].map((f) => relative(join(web, 'js'), f)).join(' -> ')}`); return; }
  path.push(file);
  for (const t of graph.get(file) || []) cycle(t);
  path.pop(); done.add(file);
};
for (const f of graph.keys()) cycle(f);

// nothing but the test API publishes on window: the modules reach each other through imports
for (const f of modules) {
  if (f.endsWith('/test-api.js')) continue;
  if (/\b(?:window|globalThis)\.\w+\s*=[^=]|defineProperty\(\s*(?:window|globalThis)\b/.test(readFileSync(f, 'utf8'))) bad.push(`${relative(web, f)}: writes window (only test-api.js may)`);
}

for (const f of classic) {
  if (!existsSync(f)) continue;
  if (modules.has(f)) bad.push(`${relative(web, f)}: loaded as a classic script and imported as a module`);
  try { new vm.Script(readFileSync(f, 'utf8'), { filename: f }); } catch (e) { bad.push(`${relative(web, f)}: ${e.message}`); }
}
for (const f of files) if (!classic.has(f) && !modules.has(f)) bad.push(`${relative(web, f)}: neither loaded nor imported`);

for (const b of bad) console.log(b);
console.log(`${files.length} ${classic.size} ${modules.size}`);
process.exit(bad.length ? 1 : 0);
