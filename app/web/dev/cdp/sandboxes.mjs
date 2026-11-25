// The made-up sessions' sandbox folders under /tmp, made as a real session's folder is there (a missing one reads
// "Folder gone", R3.11). run.sh runs it on each check's fixture tree, except the folders check, which keeps its
// gone folder gone. Folders under the script's made-up home (/Users/fixture) need nothing: the scripted SDK
// counts them as there.
// usage: node sandboxes.mjs <claude-dir>
import fs from 'node:fs';
import path from 'node:path';

const projects = path.join(process.argv[2], 'projects'), dirs = new Set();
for (const d of fs.existsSync(projects) ? fs.readdirSync(projects) : []) {
  for (const f of fs.readdirSync(path.join(projects, d)).filter((x) => x.endsWith('.jsonl'))) {
    for (const m of fs.readFileSync(path.join(projects, d, f), 'utf8').matchAll(/"cwd":"(\/tmp\/[^"]+)"/g)) dirs.add(m[1]);
  }
}
for (const d of dirs) fs.mkdirSync(d, { recursive: true });
