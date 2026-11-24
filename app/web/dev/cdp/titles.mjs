// Title changes in the transcript (R5.12c), on a made-up fixture with the fake driver.
// usage: node titles.mjs make <claude-dir>   writes the fixture and a state.json beside it (run.sh does this first)
//        node titles.mjs <url> <state-dir> <claude-dir>
// The fixture has two ai-title records, a written title (state.json history) equal to the second but
// for case and spaces, and a rename by you (custom-title). Checks: two "Retitled" lines, the second
// "by you", none for the first title; each in place, after its turn's "Worked for" line and before the
// next prompt; quiet like a day separator (no gutter mark); the same after a reload and after a
// backend restart. Writes titles-log.png.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const S = 'd1d1d1d1-0000-4000-8000-0000000000d1';
const line = (o) => JSON.stringify(o) + '\n';
const t0 = Date.now() - 30 * 60_000;
const ts = (s) => new Date(t0 + s * 1000).toISOString();
const rec = (o) => line({ cwd: '/tmp/synopia-titles', sessionId: S, ...o });
const you = (uuid, s, text) => rec({ type: 'user', uuid, timestamp: ts(s), message: { role: 'user', content: text } });
const said = (uuid, s, text) => rec({ type: 'assistant', uuid, timestamp: ts(s), message: { role: 'assistant', content: [{ type: 'text', text }] } });
const done = (s) => rec({ type: 'system', subtype: 'turn_duration', timestamp: ts(s), durationMs: 4000 });

if (process.argv[2] === 'make') {
  const claudeDir = process.argv[3];
  const dir = path.join(claudeDir, 'projects', '-tmp-synopia-titles');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${S}.jsonl`),
    you('u1', 0, 'Draft the demo notes.')
    + rec({ type: 'ai-title', aiTitle: 'Demo notes' }) // the first title: it only names the session
    + said('a1', 4, 'Drafted them.') + done(4)
    + rec({ type: 'ai-title', aiTitle: 'Draft and check the demo notes' })
    + you('u2', 20, 'Now check the links.')
    + said('a2', 30, 'Links checked.') + done(30)
    + rec({ type: 'custom-title', customTitle: 'Demo notes, links checked' })
    + you('u3', 60, 'Thanks.')
    + said('a3', 64, 'Done.') + done(64));
  fs.writeFileSync(path.join(claudeDir, 'fake-script.json'), JSON.stringify({ about: 'titles.mjs: made up', steps: [{ at: 0, sid: S, status: 'idle', ago: 60000 }] }));
  // the writer's history: the second title again, case and spaces aside, during the second turn
  fs.writeFileSync(path.join(path.dirname(claudeDir), 'state.json'), JSON.stringify({ version: 1, written: { [S]: { title: 'draft and check the  demo notes', now: 'Your turn', at: t0 + 25_000, history: [{ title: 'draft and check the  demo notes', at: t0 + 25_000 }] } } }));
  process.exit(0);
}

const { connect, sleep } = await import('./cdp.mjs');
const [url0, stateDir, claudeDir] = process.argv.slice(2);
const here = path.dirname(new URL(import.meta.url).pathname);
const c = await connect();
const { ev, check } = c;
let url = url0;
const load = () => c.load(`${url}#${S.slice(0, 8)}`, `current === '${S}' && cur().items.length > 0 && !!document.querySelector('#log .retitle')`);
async function restart() {
  const pid = +fs.readFileSync(path.join(stateDir, 'pid'), 'utf8');
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 50; i++) { try { process.kill(pid, 0); await sleep(100); } catch { break; } }
  execFileSync(path.join(here, 'backend.sh'), [new URL(url0).port, stateDir, '--fake', '--claude-dir', claudeDir], { stdio: ['ignore', 'pipe', 'inherit'] });
  url = fs.readFileSync(path.join(stateDir, 'url'), 'utf8').trim();
}
const WANT = ['Retitled “Draft and check the demo notes”', 'Retitled “Demo notes, links checked” by you'];
// each line with the blocks around it: the turn's "Worked for" line before, the next prompt after
const around = () => ev(`JSON.stringify([...document.querySelectorAll('#log .retitle')].map(e => [e.previousElementSibling?.dataset.key, e.textContent, e.nextElementSibling?.dataset.key]))`);
const placed = JSON.stringify([['done:u1', WANT[0], 'you:u2'], ['done:u2', WANT[1], 'you:u3']]);

async function round(name) {
  const got = await around();
  check(`${name}: two Retitled lines, in place`, got === placed, got);
}
await load();
await round('first view');
const look = await ev(`(() => { const e = document.querySelector('#log .retitle'), d = getComputedStyle(e), t = getComputedStyle(e.querySelector('.t'));
  return { gutter: !!e.querySelector('.g'), line: d.color, upper: d.textTransform, title: t.color }; })()`);
check('quiet: no gutter mark, no capitals, the title a step darker', !look.gutter && look.upper === 'none' && look.title !== look.line, JSON.stringify(look));
check('the header keeps the rename', (await ev(`document.querySelector('.c-head')?.textContent || ''`)).includes('Demo notes, links checked'));
await ev(`document.querySelector('#log .retitle').scrollIntoView({ block: 'center' })`);
await sleep(200);
const clip = await ev(`(() => { const r = document.getElementById('log').getBoundingClientRect(); return { x: r.left, y: r.top, width: Math.min(900, r.width), height: Math.min(700, r.height), scale: 1 }; })()`);
fs.writeFileSync(path.join(stateDir, 'titles-log.png'), Buffer.from((await c.cdp('Page.captureScreenshot', { format: 'png', clip })).result.data, 'base64'));
await load();
await round('after a reload');
await restart();
await load();
await round('after a backend restart');
c.print();
c.close();
