// Paths as the page shows them. The CLI and listSessions() give real paths, so on macOS a folder
// under /tmp reads /private/tmp/…, and a home folder reached through a link reads its target. Both
// map back (the real path of /tmp to /tmp, the real path of home to home), then home becomes `~`,
// so a folder reads the same in the header, the Open list, files changed and the cards.
import fs from 'node:fs';

const real = new Map<string, string>();
function realOf(p: string): string {
  let r = real.get(p);
  if (r === undefined) {
    try {
      r = fs.realpathSync(p);
    } catch {
      r = p;
    }
    real.set(p, r);
  }
  return r;
}

// [from, to] prefixes, longest first: the real paths back to the ones you know, then home to `~`.
function rules(home: string): [string, string][] {
  const out: [string, string][] = [];
  const tmp = realOf('/tmp');
  if (tmp !== '/tmp') out.push([tmp, '/tmp']);
  if (home) {
    const rh = realOf(home);
    if (rh !== home) out.push([rh, '~']);
    out.push([home, '~']);
  }
  return out.sort((a, b) => b[0].length - a[0].length);
}

const under = (p: string, dir: string) => p === dir || p.startsWith(dir + '/');

// One path: its start mapped.
export function displayPath(p: string, home: string): string {
  let out = p;
  for (const [from, to] of rules(home)) {
    if (under(out, from)) out = to + out.slice(from.length);
  }
  return out;
}

// Paths inside a text (a tool line's object, a command): every occurrence that starts a path. A
// path starts the text or follows a space, a quote, a bracket or a shell operator, so a URL
// (`https://host/Users/x`) or a longer path (`/mnt/private/tmp`) stays as it is.
export function displayIn(text: string, home: string): string {
  let out = text;
  for (const [from, to] of rules(home)) {
    out = out.replace(new RegExp('(?<=^|[\\s"\'`(\\[{=<>,;|&])' + escapeRe(from) + '(?=/|$|[\\s"\'`)\\]])', 'g'), to);
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Whether `p` is a folder now (a session's, the menu probe's).
export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
