/* Md: markdown as the Claude Code CLI renders it (requirements R5.10), and the answer text of a question
   card. DOM-free (app/web/test/md.test.js runs it in Node). */
import { esc } from "./format.js";

/* back from esc, for a URL found in escaped text that is escaped again as an attribute */
const unesc = s => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");

/* Plain text as HTML with its bare http(s) URLs as links (a tool's output, R5.6: a sign-in link an MCP server
   returns opens in the browser; transcript.js sends a click as `open`). Trailing punctuation stays outside. */
export function linkText(text) {
  return esc(text).replace(/(^|[\s(>"'])(https?:\/\/[^\s<]+?)([.,;:!?)]*(?=\s|<|$))/g, (m, pre, url, tail) => `${pre}<a href="${esc(unesc(url))}" target="_blank" rel="noreferrer">${url}</a>${tail}`);
}

/* Whether an inline code span names a file or folder (R5.9, 2026-11-25): the path to resolve, or null. A path is
   absolute (`/…`), under home (`~/…`), or relative with a `/` or a file extension; a trailing `:12` or `:12:3`
   line number is dropped. Not a path: a URL or other scheme, a flag (`-x`), an npm scope (`@a/b`), anything with
   shell or code characters, a call (`f()`), and a dotted name with nothing after a dot but letters and digits that
   start with a digit (`R5.9`, `1.2.3`). The backend says which ones are there (file-refs.ts); only those open. */
const PATH_EXT = /[^/.\s][^/]*\.[A-Za-z][A-Za-z0-9_-]{0,11}$/;
export function pathCandidate(text) {
  let s = String(text ?? "").trim();
  if (!s || s.length > 1024 || /[\s]{2}|[\n\t`<>|"'*?{}$;=&,\\]/.test(s)) return null;
  s = s.replace(/:\d+(?::\d+)?$/, "");
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(s) || /^[-@]/.test(s) || /\(\)$/.test(s) || /\s-/.test(s)) return null;
  if (s.startsWith("//") || s === "/" || s === "~") return null;
  if (s.startsWith("/") || s.startsWith("~/")) return s;
  if (s.startsWith("~")) return null;
  return s.includes("/") || PATH_EXT.test(s) ? s : null;
}

/* small markdown renderer: code blocks, headings, lists, quotes, bold, inline code, links */
export function md(src) {
  const out = []; const lines = (src || "").split("\n"); let i = 0;
  /* Code spans and [text](url) links are cut out of the raw text first and built from escaped parts, so no
     later step runs inside them or their attributes; the rest is escaped, then bold and bare URLs are added. */
  const inline = s => {
    const keep = [], put = html => `\u0001${keep.push(html) - 1}\u0001`;
    const link = (url, text) => `<a href="${esc(url)}" target="_blank" rel="noreferrer">${text}</a>`;
    // bold may hold whole cut-out parts (code spans, links): each \u0001N\u0001 is a finished element
    const bold = t => t.replace(/\*\*((?:[^*\u0001]|\u0001\d+\u0001)+)\*\*/g, "<b>$1</b>");
    /* bare URLs become links too, in code spans as well (as the prototype does); trailing punctuation stays outside */
    const bare = t => t.replace(/(^|[\s(>])(https?:\/\/[^\s<\u0001]+?)([.,;:!?)]*(?=\s|<|\u0001|$))/g, (m, pre, url, tail) => `${pre}${link(unesc(url), url)}${tail}`);
    const raw = (s || "").replace(/\u0001/g, "")
      .replace(/`([^`]+)`/g, (m, c) => { const p = pathCandidate(c); return put(`<code${p ? ` data-pc="${esc(p)}"` : ""}>${bare(esc(c))}</code>`); })
      .replace(/\[([^\]\u0001]+)\]\((https?:[^)\s\u0001]+)\)/g, (m, t, url) => put(link(url, bold(esc(t)))));
    /* a pasted image's [Image #N] tag, as the CLI puts it in the prompt (R5.13): a plain dim tag, not in code spans */
    return bare(bold(esc(raw))).replace(/\[Image #(\d+)\]/g, '<span class="img-tag">[Image #$1]</span>').replace(/\u0001(\d+)\u0001/g, (m, n) => keep[+n]);
  };
  /* a paragraph's or quote's lines: a single newline is a line break, as in the Claude Code CLI (a blank
     line makes a new paragraph). No URL or attribute holds a newline, so each one left is text. */
  const lines2 = buf => inline(buf.join("\n")).replace(/\n/g, "<br>");
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`); continue; }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      const rows = []; while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = r => r.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
      /* a separator row is one whose every cell is dashes (colons for alignment): "| --flag | x |" is data */
      const sep = cs => cs.every(c => /^:?-+:?$/.test(c));
      const body = rows.map(cells).filter(cs => !sep(cs));
      if (!body.length) { out.push(`<p>${lines2(rows)}</p>`); continue; } // only separators: the text as written
      const [head, ...rest] = body, align = colAlign(rows.map(cells).find(sep) || []), k = colKinds(rest);
      /* each cell carries its column's kind (table-fit.js and app.css fit the table by them) and the
         alignment the separator row states; the first column is also c0, the row's name */
      const cls = j => ` class="${k[j] || "short"}${j === 0 && k[j] !== "c0" ? " c0" : ""}${align[j] ? ` a${align[j]}` : ""}"`;
      out.push(`<div class="tw"><table><thead><tr>${head.map((c, j) => `<th${cls(j)}>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rest.map(r => `<tr>${r.map((c, j) => `<td${cls(j)}>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)/); if (h) { out.push(`<h4>${inline(h[2])}</h4>`); i++; continue; }
    if (/^\s*([-*]|\d+\.)(\s+|$)/.test(l)) {
      /* A list, as CommonMark reads one: an item's own content is every line indented past its marker
         (a nested list, a second paragraph, code), rendered recursively; blank lines between items keep
         the list going; an ordered list starts at the number written. An item may start with a blank line
         (a bare `-`), its content on the indented lines under it, one space past the marker; a blank line
         right after such a marker leaves the item empty. */
      const mk = /^(\s*)([-*]|\d+)(\.)?(\s+|$)/;
      const m0 = l.match(mk), base = m0[1].length, ordered = /\d/.test(m0[2]);
      const isItem = x => { const m = x.match(mk); return m && m[1].length <= base + 1 && /\d/.test(m[2]) === ordered && (ordered ? !!m[3] : !m[3]); };
      const items = []; let cur = null, pad = 0;
      while (i < lines.length) {
        const x = lines[i];
        if (!x.trim()) { // a blank line: the list goes on if the next text is an item or an item's content
          let j = i + 1; while (j < lines.length && !lines[j].trim()) j++;
          const bare = cur && cur.length === 1 && cur[0] === ""; // an item started blank ends at a blank line, empty
          if (j < lines.length && (isItem(lines[j]) || (cur && !bare && lines[j].search(/\S/) >= pad))) { if (cur && !bare) cur.push(""); i++; continue; }
          break;
        }
        if (isItem(x)) {
          const m = x.match(mk), blank = !x.slice(m[0].length).trim();
          pad = blank ? m[1].length + m[2].length + (m[3] ? 1 : 0) + 1 : m[0].length;
          cur = [blank ? "" : x.slice(pad)]; items.push({ n: +m[2], lines: cur }); i++; continue;
        }
        const ind = x.search(/\S/);
        if (cur && (ind >= Math.min(pad, base + 2) || !/^\s*([-*]|\d+\.)\s|^(```|#{1,4}\s|>|\s*\|)/.test(x))) { cur.push(x.slice(Math.min(ind, pad))); i++; continue; }
        break;
      }
      const tag = ordered ? "ol" : "ul", start = ordered && items[0].n !== 1 ? ` start="${items[0].n}"` : "";
      out.push(`<${tag}${start}>${items.map(it => {
        const html = md(it.lines.join("\n"));
        const one = /^<p>([\s\S]*)<\/p>$/.exec(html); // a one-paragraph item stays tight
        return `<li>${one && !one[1].includes("<p>") ? one[1] : html}</li>`;
      }).join("")}</${tag}>`); continue;
    }
    if (/^>\s?/.test(l)) { const buf = []; while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, "")); out.push(`<blockquote>${lines2(buf)}</blockquote>`); continue; }
    if (!l.trim()) { i++; continue; }
    /* the first line is always taken: a line no block above took ("| a | b", a table row cut mid-stream with
       no closing pipe) is text, so the loop always moves on */
    const buf = [lines[i++]]; while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s|>|\s*\|)/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${lines2(buf)}</p>`);
  }
  return out.join("");
}

/* A table column's kind, from its body cells as written (R5.10): "num" when every non-empty cell is a
   number with an optional unit (`~44 ms`, `418k + 386k`, `0.02%`, `1.2M`, `n/a`), but not a column of dates
   only; else "prose" when a cell is over 44 characters; else "short", or "c0" for the first column. Code
   ticks, bold and link syntax don't count. One cell of text makes the column text. */
const NUM = /^(n\/a|[~<>]?\d[\d.,]*\s?(k|M|ms|s|%)?(\s?[+]\s?[~]?\d[\d.,]*\s?(k|M|ms|s|%)?)*|\d{4}-\d\d-\d\d)$/;
const plain = s => s.replace(/`/g, "").replace(/\*\*/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
export function colKinds(rows) {
  const n = Math.max(0, ...rows.map(r => r.length));
  return Array.from({ length: n }, (_, j) => {
    const cells = rows.map(r => plain(r[j] ?? "")), full = cells.filter(c => c);
    if (full.length && full.every(c => NUM.test(c)) && !full.every(c => /^\d{4}-/.test(c))) return "num";
    if (Math.max(0, ...cells.map(c => c.length)) > 44) return "prose";
    return j === 0 ? "c0" : "short";
  });
}
/* the alignment a separator row states, per column: "l" (`:--`), "c" (`:-:`), "r" (`--:`), "" (`---`: the kind decides) */
export const colAlign = sepCells => sepCells.map(c => /^:-+:$/.test(c) ? "c" : /-:$/.test(c) ? "r" : /^:-/.test(c) ? "l" : "");

/* AskUserQuestion results read: "question"="answer". Pull the answers out. */
export function parseAnswers(a) {
  const res = []; const re = /"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"/g; let m;
  while ((m = re.exec(a || ""))) res.push(m[2]);
  return res;
}
/* The note you added to each answer: `"question"="answer" notes: <note>.`, up to the next answer or the CLI's closing sentence. */
export function parseNotes(a) {
  const res = []; const re = /"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"/g; const ms = [...(a || "").matchAll(re)];
  ms.forEach((m, i) => {
    const rest = a.slice(m.index + m[0].length, i + 1 < ms.length ? ms[i + 1].index : a.length).replace(/\s*Read the answers carefully[\s\S]*$/, "");
    const n = /^\s*notes:\s*([\s\S]*?)[.,]?\s*$/.exec(rest);
    res.push(n ? n[1] : "");
  });
  return res;
}
