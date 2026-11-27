// The keeper's scripted batch (FR-ITEM-08, the plan's phase 3 check): the real keeper prompt and op checks on
// the invented exchanges of keeper-cases.json, for each model, scored against the expected ops. Opt-in, outside
// check.sh: it makes one model call per case and model. Prints numbers only, never case text.
// usage: node --experimental-strip-types app/backend/perf/keeper-batch.ts [models, default sonnet,haiku] [-v]
//   -v adds one line per case that missed: its id, the expected and the returned ops (ops and ids only).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPrompt, checkOps, parseOps, SYSTEM_PROMPT } from '../src/keeper.ts';
import type { Exchange, ListItem, Op, Segment } from '../src/keeper.ts';
import { oneShot, realSdk, writerOptions } from '../src/sdk.ts';

type Want = { op: string; id?: string; kind?: string; as?: string; state?: string };
type Case = {
  id: string; kind: 'you' | 'turn'; list: (ListItem & { closed?: boolean | string })[];
  segments: Segment[]; owned?: Record<string, string[]>; work?: string[]; expect: Want[];
};

const args = process.argv.slice(2);
const verbose = args.includes('-v');
const models = (args.find((a) => !a.startsWith('-')) ?? 'sonnet,haiku').split(',');
const cases = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'keeper-cases.json'), 'utf8')) as Case[];
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'synopia-keeper-batch-'));
const PARALLEL = 4;

const same = (w: Want, o: Op): boolean => w.op === o.op && (o.op === 'open'
  ? !w.kind || w.kind === o.kind
  : w.id === o.id && (!w.as || (o.op === 'close' && w.as === o.as)) && (!w.state || (o.op === 'update' && w.state === o.state)));
const short = (o: Want | Op) => [o.op, 'id' in o ? o.id : (o as { kind?: string }).kind, (o as { as?: string }).as ?? (o as { state?: string }).state].filter(Boolean).join(':');

async function run(model: string, c: Case) {
  const owned = c.owned ?? {};
  const segments = c.segments.map((s) => (s.src === 'report' && s.name === undefined ? { ...s, name: (s as { agent?: string }).agent ?? '' } : s))
    .map((s) => (s.src === 'report' ? { ...s, owns: owned[s.name ?? ''] ?? s.owns } : s));
  const open = c.list.filter((i) => !i.closed).map(({ closed: _, ...i }) => i);
  const closed = c.list.filter((i) => i.closed).map((i) => ({ ...i, closed: typeof i.closed === 'string' ? i.closed : 'closed' }));
  const ex: Exchange = { kind: c.kind, key: c.id, segments };
  const started = Date.now();
  const r = await oneShot(realSdk.query, buildPrompt({ open, closed }, ex, c.work ?? []), writerOptions(model, cwd, SYSTEM_PROMPT));
  const ms = Date.now() - started;
  if (r.failure) return { c, ms, failed: true, ops: [] as Op[], dropped: 0, parsed: false };
  const raw = parseOps(r.reply);
  const { ops, dropped } = raw ? checkOps(raw, { segments, open, closed }) : { ops: [], dropped: [] };
  return { c, ms, failed: false, ops, dropped: dropped.length, parsed: !!raw };
}

for (const model of models) {
  const results: Awaited<ReturnType<typeof run>>[] = [];
  for (let i = 0; i < cases.length; i += PARALLEL) results.push(...await Promise.all(cases.slice(i, i + PARALLEL).map((c) => run(model, c))));
  let want = 0, hit = 0, got = 0, extra = 0, exact = 0, quietOk = 0, quiet = 0, dropped = 0, failed = 0, unparsed = 0;
  const misses: string[] = [];
  for (const r of results) {
    if (r.failed) failed++;
    else if (!r.parsed) unparsed++;
    dropped += r.dropped;
    const left = [...r.ops];
    let h = 0;
    for (const w of r.c.expect) {
      const i = left.findIndex((o) => same(w, o));
      if (i >= 0) { h++; left.splice(i, 1); }
    }
    want += r.c.expect.length; hit += h; got += r.ops.length; extra += left.length;
    const ok = h === r.c.expect.length && left.length === 0;
    if (ok) exact++;
    if (!r.c.expect.length) { quiet++; if (!r.ops.length) quietOk++; }
    if (!ok) misses.push(`${r.c.id} want [${r.c.expect.map(short).join(' ')}] got [${r.ops.map(short).join(' ')}]`);
  }
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '-');
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`${model}: ${exact}/${results.length} cases exact; recall ${hit}/${want} (${pct(hit, want)}), precision ${hit}/${got} (${pct(hit, got)}), ${extra} extra ops; no-op cases ${quietOk}/${quiet}; ${dropped} ops dropped by the checks; ${failed} failed, ${unparsed} not JSON; median ${ms[Math.floor(ms.length / 2)]} ms`);
  if (verbose) for (const m of misses) console.log(`  ${m}`);
}
fs.rmSync(cwd, { recursive: true, force: true });
