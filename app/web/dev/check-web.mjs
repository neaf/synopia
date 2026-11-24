// Checks the page scripts without a browser: each file in app/web/js parses as what index.html loads it as
// (a classic script or an ES module), every module import names a file that exists, and every file is
// loaded or imported by something. Prints the bad files, one per line, and exits 1 if there are any.
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
const importsOf = (src) => [...src.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm)].map((m) => m[1] ?? m[2]);
const walk = (file) => {
  if (modules.has(file)) return;
  modules.add(file);
  const src = readFileSync(file, 'utf8');
  // app/web/package.json says "type": "module", so node parses js/ files as modules
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) bad.push(`${relative(web, file)}: ${(r.stderr.match(/^\w*Error: .*$/m) || [r.stderr.trim()])[0]}`);
  for (const spec of importsOf(src)) {
    if (!spec.startsWith('.')) { bad.push(`${relative(web, file)}: imports ${spec} (only relative files)`); continue; }
    const target = resolve(dirname(file), spec);
    if (!existsSync(target)) bad.push(`${relative(web, file)}: imports ${spec}, which does not exist`);
    else walk(target);
  }
};
for (const e of entries) if (existsSync(e)) walk(e);

for (const f of classic) {
  if (!existsSync(f)) continue;
  if (modules.has(f)) bad.push(`${relative(web, f)}: loaded as a classic script and imported as a module`);
  try { new vm.Script(readFileSync(f, 'utf8'), { filename: f }); } catch (e) { bad.push(`${relative(web, f)}: ${e.message}`); }
}
for (const f of files) if (!classic.has(f) && !modules.has(f)) bad.push(`${relative(web, f)}: neither loaded nor imported`);

for (const b of bad) console.log(b);
console.log(`${files.length} ${classic.size} ${modules.size}`);
process.exit(bad.length ? 1 : 0);
