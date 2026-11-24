// Dark mode (requirements section 11) on the fixture tree: with nothing stored the page follows the system's
// appearance, live; the switch in the sidebar footer picks the other theme, is stored with the UI state
// (state.json ui.theme) and survives a reload whatever the system says; Alt-click follows the system again.
// In dark mode no container keeps a light background (computed backgrounds of the key containers, then of
// every sizeable element), lines stay 1px, nothing transitions, and the preview asks bat's dark theme.
// usage: run.sh dark (or node dark.mjs <url> <state-dir>); writes dark-<theme>-<n>.png in the state folder
import fs from 'node:fs';
import path from 'node:path';
import { connect, sleep } from './cdp.mjs';

const [url, stateDir] = process.argv.slice(2);
const c = await connect();
const { ev, check, until } = c;
await c.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
const system = (v) => c.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: v }] });
const theme = () => ev(`document.documentElement.dataset.theme`);
const stateFile = path.join(stateDir, 'state.json');
const stored = () => { if (!fs.existsSync(stateFile)) return null; try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')).ui?.theme ?? null; } catch { return 'unread'; } };
const storedIs = async (v) => { for (let t = 0; t < 40; t++) { if (stored() === v) return true; await sleep(100); } return false; };
const label = () => ev(`(b => b.getAttribute('aria-label') + '|' + b.title + '|' + getComputedStyle(b.querySelector('.moon')).display + '|' + getComputedStyle(b.querySelector('.sun')).display)(document.getElementById('theme'))`);
// a real click on the switch, with Alt for "follow the system"
const clickSwitch = async (alt) => {
  const r = await ev(`(r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 }))(document.getElementById('theme').getBoundingClientRect())`);
  const m = alt ? 1 : 0;
  for (const type of ['mousePressed', 'mouseReleased']) await c.cdp('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, modifiers: m });
  await sleep(100);
};

/* ---------- following the system, live, with nothing stored ---------- */
await system('light');
await c.load(url);
check('nothing stored: the system is light, the page is light', (await theme()) === 'light' && stored() === null, `${await theme()} ${stored()}`);
check('in light mode the switch is a moon labelled Dark mode', (await label()) === 'Dark mode|Dark mode|block|none', await label());
await system('dark');
check('the system turns dark: the page follows at once, without a reload', await until(`document.documentElement.dataset.theme === 'dark'`, 1000), await theme());
check('in dark mode the switch is a sun labelled Light mode', (await label()) === 'Light mode|Light mode|none|block', await label());
check('the switch has no border and no background', await ev(`(s => s.borderTopWidth === '0px' && s.backgroundColor === 'rgba(0, 0, 0, 0)')(getComputedStyle(document.getElementById('theme')))`));
check('the switch sits at the left of Open session and New session', await ev(`(() => { const t = document.getElementById('theme').getBoundingClientRect(), o = document.getElementById('open').getBoundingClientRect(); return t.right <= o.left && Math.abs((t.top + t.bottom) - (o.top + o.bottom)) < 2; })()`));

/* ---------- a choice sticks: stored, and kept over a reload against the system ---------- */
await clickSwitch(false);
check('a click picks light while the system is dark', (await theme()) === 'light');
check('the choice is stored with the UI state (state.json ui.theme)', await storedIs('light'), String(stored()));
check('a chosen theme says how to follow the system again', (await label()).startsWith('Dark mode|Dark mode (Alt-click follows the system)'), await label());
await ev(`localStorage.clear()`); // the stored UI state alone brings it back
await c.load(url);
check('after a reload the stored light stays, though the system is dark', (await theme()) === 'light', await theme());
await system('light'); await system('dark');
check('a chosen theme ignores the system changing', (await theme()) === 'light');
await clickSwitch(true);
check('Alt-click follows the system again (dark), and clears the stored choice', (await theme()) === 'dark' && (await storedIs(null)), `${await theme()} ${stored()}`);
await clickSwitch(false); await clickSwitch(false);
check('two clicks: light, then dark, stored', (await theme()) === 'dark' && (await storedIs('dark')), `${await theme()} ${stored()}`);
await system('light');
await c.load(url);
check('after a reload the stored dark stays, though the system is light', (await theme()) === 'dark', await theme());

/* ---------- the look in dark mode ---------- */
const shots = [];
const shot = async (name) => { const f = `${stateDir}/dark-${await theme()}-${name}.png`; fs.writeFileSync(f, Buffer.from((await c.cdp('Page.captureScreenshot', { format: 'png' })).result.data, 'base64')); shots.push(f); };
// the luminance of every sizeable element's own opaque background; marks, tags and controls are drawn on purpose
const LIGHT = `(() => {
  const lum = (s) => { const m = s.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(',').map(Number); if (a < .5) return null;
    return [r, g, b].map((v) => v / 255).map((v) => (v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)).reduce((t, v, i) => t + v * [.2126, .7152, .0722][i], 0); };
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.ind, .kind, .btn.primary, .o.on, .theme-btn, svg, img')) continue;
    const r = el.getBoundingClientRect(); if (r.width < 24 || r.height < 12) continue;
    const l = lum(getComputedStyle(el).backgroundColor);
    if (l !== null && l > .12) out.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + [...el.classList].join('.')) + ' ' + getComputedStyle(el).backgroundColor);
  }
  return out.slice(0, 8);
})()`;
const KEY = ['body', '.side', '.conv', '.panel', '.log', '.dock', '.dock .status', '.composer', '.rail', '.main-row', '.card', '.md pre', '.ln.files .diff', '.dl.a', '.dl.d', '.dl .no', '.prompt', '.toast',
  '.open-list', '.ol-panel', '.ol-it[aria-selected="true"]', '.slash', '.slash .it[aria-selected="true"]', '.preview', '.pv-panel', '.pl .no', '.viewer', '.nd-head', '.qo', '.o', '.row[aria-current="true"]'];
const keyBgs = () => ev(`(${JSON.stringify(KEY)}).flatMap(s => [...document.querySelectorAll(s)].slice(0, 3).map(e => [s, getComputedStyle(e).backgroundColor])).filter(([, b]) => b !== 'rgba(0, 0, 0, 0)')`);
const lightKeys = (list) => list.filter(([, b]) => { const [r, g, bl] = b.match(/[\d.]+/g).map(Number); return (r + g + bl) / 3 > 110; });
const failed = [];
const sample = async (where) => {
  const keys = await keyBgs(), bad = [...lightKeys(keys).map(([s, b]) => `${s} ${b}`), ...(await LIGHTER())];
  if (bad.length) failed.push(`${where}: ${bad.join(', ')}`);
  return keys.length;
};
const LIGHTER = () => ev(LIGHT);
let sampled = 0;
// every session of the fixture tree: working with a subagent wave, files changed, a needs-you card
const sids = await ev(`[...document.querySelectorAll('#groups .row')].map(r => r.dataset.id)`);
for (const sid of sids) {
  await ev(`document.querySelector('#groups .row[data-id="${sid}"]').click()`);
  await sleep(700);
  // every diff open, so its rows and gutters are sampled
  await ev(`document.querySelectorAll('#log .frow .fc[aria-expanded="false"]').forEach(b => b.click())`);
  await sleep(150);
  sampled += await sample(sid.slice(0, 8));
  await shot(sid.slice(0, 8));
}
// the slash menu and the model picker, the Open list, a toast, the image viewer, the file preview
await ev(`(() => { const t = document.getElementById('msg'); t.focus(); t.value = '/'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await sleep(300);
check('the slash menu opens', await ev(`!!document.querySelector('.slash:not([hidden]) .it')`));
sampled += await sample('slash menu'); await shot('slash');
await ev(`(() => { const t = document.getElementById('msg'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); t.blur(); })()`);
await ev(`document.getElementById('open').click()`); await sleep(400);
check('the Open list opens', await ev(`document.getElementById('open-list')?.hidden === false`));
sampled += await sample('Open list'); await shot('open-list');

await c.key('Escape', { code: 'Escape', vk: 27 }); // the filter has focus: Esc closes the list
check('Esc closes the Open list', (await ev(`__synopia.openList().shown`)) === false);
await ev(`__synopia.inject({ t: 'toast', text: 'A toast in dark mode' })`); await sleep(100);
sampled += await sample('toast');
const img = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#4493F8"/></svg>');
// a thumbnail of its own, clicked: the page opens the viewer on any .thumb[data-full-src] (images.js)
await ev(`(() => { document.body.insertAdjacentHTML('beforeend', '<div class="thumbs" id="dk-thumbs"><button class="thumb" data-full-src="${img}"></button></div>'); document.querySelector('#dk-thumbs .thumb').click(); })()`); await sleep(300);
check('the image viewer opens', await ev(`!!document.querySelector('.viewer')`));
sampled += await sample('viewer'); await shot('viewer');
await c.key('Escape', { code: 'Escape', vk: 27 }); await ev(`document.getElementById('dk-thumbs').remove()`); await sleep(200);
check('Esc closes the image viewer', await ev(`!document.querySelector('.viewer')`));
check('enough key containers sampled in dark mode', sampled >= 40, String(sampled));
check('no element keeps a light background in dark mode', !failed.length, failed.slice(0, 6).join(' | '));

/* the preview asks bat's dark theme (the page's half: the request carries the theme) */
await ev(`document.querySelector('#groups .row[data-id^="11111111"]').click()`); await sleep(700); // the session with files changed
const sent = await ev(`(() => { __synopia.spy();
  const a = document.querySelector('#log a.fp[data-path], #log [data-path]');
  if (!a) return 'no link';
  a.click();
  return __synopia.sent('preview')[0] || 'none'; })()`);
check('a preview request carries the dark theme', sent && sent.theme === 'dark', JSON.stringify(sent));

/* lines stay 1px; nothing transitions, so the switch is instant */
check('panel and diff lines stay 1px', await ev(`[...document.querySelectorAll('.panel, .diff, .main-row')].every(e => getComputedStyle(e).borderTopWidth === '1px')`));
check('no transition on the page', await ev(`[...document.querySelectorAll('body, body *')].every(e => { const s = getComputedStyle(e); return s.transitionDuration.split(',').every(d => parseFloat(d) === 0); })`));
// the switch back is instant: the canvas is light in the same frame
await ev(`document.getElementById('theme').click()`); // dark now: the switch picks light
check('the switch is instant: light at once', await ev(`getComputedStyle(document.body).backgroundColor === 'rgb(237, 239, 242)'`));
// the same states in light, for the side-by-side review
for (const sid of sids) { await ev(`document.querySelector('#groups .row[data-id="${sid}"]').click()`); await sleep(500); await shot(sid.slice(0, 8)); }
await ev(`document.getElementById('open').click()`); await sleep(300); await shot('open-list');
await c.key('Escape', { code: 'Escape', vk: 27 });
await clickSwitch(true); // follows the system again
console.log('shots: ' + shots.length + ' in ' + stateDir);
c.print();
c.close();
