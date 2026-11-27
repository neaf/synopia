// The bundled agent-harness (requirements R3.17, FR-HAR-01): the one reader of the plugin folder
// `--harness` names, a copy app/build.sh put into the app or your live checkout. It gives what the
// sessions will need from it: the skill and agent names and the working rules with their hash. The
// plugin format is the SDK's; its quirks are in docs/Agent SDK.md, "Plugins and an appended system prompt".
// A missing or unreadable bundle is null and one `harness.missing` line, never a crash: sessions then
// run with no plugin, as dev.sh and the page checks always do.
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import type { Log } from './log.ts';

export type Bundle = {
  dir: string;
  skills: string[]; // the `skills/<name>/SKILL.md` folders, sorted; `user-invocable: false` ones included
  agents: string[]; // the names of the files plugin.json `agents` lists, sorted
  rules: string; // instructions/global.md
  rulesHash: string; // sha256 hex of `rules`
};

const MANIFEST = join('.claude-plugin', 'plugin.json');
const RULES = join('instructions', 'global.md');

class Missing extends Error {}

async function text(dir: string, file: string, what: string): Promise<string> {
  try {
    return await readFile(join(dir, file), 'utf8');
  } catch {
    throw new Missing(what);
  }
}

async function skillsOf(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(dir, 'skills'), { withFileTypes: true });
  } catch {
    throw new Missing('no skills folder');
  }
  const names: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      await readFile(join(dir, 'skills', e.name, 'SKILL.md'));
      names.push(e.name);
    } catch {
      // a folder without SKILL.md is not a skill
    }
  }
  return names.sort();
}

// plugin.json `agents`: paths relative to the plugin root, the files install.py --plugin renders
// into build/agents/. Each must be readable, or the render did not run.
async function agentsOf(dir: string, manifest: string): Promise<string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest);
  } catch {
    throw new Missing('plugin.json is not JSON');
  }
  const list = (parsed as { agents?: unknown } | null)?.agents ?? [];
  if (!Array.isArray(list) || !list.every((p) => typeof p === 'string')) throw new Missing('plugin.json agents is not a list of paths');
  const names: string[] = [];
  for (const p of list as string[]) {
    await text(dir, p, 'an agent plugin.json names is missing');
    names.push(basename(p, '.md'));
  }
  return names.sort();
}

export async function load(dir: string, log: Log): Promise<Bundle | null> {
  try {
    const manifest = await text(dir, MANIFEST, 'no .claude-plugin/plugin.json');
    const agents = await agentsOf(dir, manifest);
    const skills = await skillsOf(dir);
    const rules = await text(dir, RULES, 'no instructions/global.md');
    const rulesHash = createHash('sha256').update(rules).digest('hex');
    log('harness.loaded', { skills: skills.length, agents: agents.length, rules: rulesHash.slice(0, 12) });
    return { dir, skills, agents, rules, rulesHash };
  } catch (e) {
    log('harness.missing', { reason: e instanceof Missing ? e.message : 'unreadable' });
    return null;
  }
}
