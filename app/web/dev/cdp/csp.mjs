// H1 on the page: the page works under its Content-Security-Policy (header and meta tag) with no CSP
// error in the console, a hostile link in a transcript renders as a plain link, and an injected inline
// handler is blocked. usage: run.sh csp (or node csp.mjs <url> <state-dir>)
import { connect, sleep } from './cdp.mjs';
const [url] = process.argv.slice(2);
const c = await connect();
const { ev, check } = c;
const logs = [];
await c.cdp('Log.enable'); await c.cdp('Runtime.enable');
c.onEvent((m) => {
  if (m.method === 'Log.entryAdded') logs.push(m.params.entry.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  if (m.method === 'Runtime.exceptionThrown') logs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
});
/* a listener added before the page's own scripts: CDP's script is not subject to the page's CSP */
await c.cdp('Page.enable');
const { identifier } = await c.cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.__csp = []; document.addEventListener('securitypolicyviolation', e => __csp.push(e.violatedDirective + ' ' + e.blockedURI));` }).then((r) => r.result);
const head = await fetch(url).then((r) => r.headers.get('content-security-policy'));
check('the page is served with a CSP header', /script-src 'self'(;|$)/.test(head || ''), String(head));
await c.cdp('Page.navigate', { url });
await sleep(2500);
check('the sidebar has its sessions', (await ev(`document.querySelectorAll('#groups .row').length`)) > 0);
check('a session view is mounted', await ev(`!!document.querySelector('#conv .c-title') && !!document.getElementById('msg')`));
check('the socket is authenticated', await ev(`store.ui.connected === true`));
check('style attributes still apply (marks spin)', await ev(`(() => { const r = document.querySelector('[style*="--d"]'); return !r || getComputedStyle(r).getPropertyValue('--d').trim() !== ''; })()`));
check('no CSP violation while loading', (await ev(`__csp.length`)) === 0, JSON.stringify(await ev(`__csp`)));
check('no CSP or script error in the console', !logs.some((l) => /Content Security Policy|Refused to|Uncaught/i.test(l)), JSON.stringify(logs));

// the reviewer's payload in a Claude message, through the real renderer into the log
const payload = 'See https://x.example/"/onmouseover=alert(document.location)// and [docs](https://x.example/"/onmouseover=alert(1)//)';
await ev(`(() => { const s = cur(); s.items.push({ id: 'csp-1', k: 'claude', ts: new Date().toISOString(), text: ${JSON.stringify(payload)} }); renderLog(); })()`);
await sleep(200);
const links = await ev(`[...document.querySelectorAll('[data-key="csp-1"] a')].map(a => ({ attrs: a.getAttributeNames(), href: a.getAttribute('href') }))`);
check('the payload renders as two links', Array.isArray(links) && links.length === 2, JSON.stringify(links));
check('no event handler attribute on them', Array.isArray(links) && links.every((l) => !l.attrs.some((n) => n.startsWith('on'))), JSON.stringify(links));
check('the quote stays inside the href', Array.isArray(links) && links.every((l) => l.href.includes('"/onmouseover')), JSON.stringify(links));

// the backstop: an inline handler that got in anyway does not run
const before = logs.length;
await ev(`(() => { window.__ran = false; const d = document.createElement('div'); d.innerHTML = '<img src="data:image/png;base64,iVBORw0KGgo=" onerror="window.__ran = true">'; document.body.append(d); })()`);
await sleep(300);
check('an injected inline handler is blocked', (await ev(`window.__ran`)) === false && (await ev(`__csp.some(v => v.startsWith('script-src'))`)), JSON.stringify(await ev(`__csp`)));
check('the block is reported as a CSP error', logs.slice(before).some((l) => /Content Security Policy/i.test(l)), JSON.stringify(logs.slice(before)));
await c.cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier });
c.print(); c.close();
