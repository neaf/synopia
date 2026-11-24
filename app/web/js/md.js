/* Md: small helpers and the markdown renderer (split from prototype/app.html). */
/* ---------- helpers ---------- */
/* every string that goes into HTML, as text or as an attribute, passes through esc (all five characters) */
const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
/* back from esc, for a URL found in escaped text that is escaped again as an attribute */
const unesc = s => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
function dur(ms) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} d`;
}
/* A model id as a name, until the folder's menu names it: "eu.anthropic.claude-opus-5-5[1m]" reads
   "Claude Opus 5.5 (1M context)". Region and provider prefixes, an ARN's path, a date, a Vertex `@`
   version and a Bedrock `-v1:0` go; a bare alias ("haiku") reads "Claude Haiku"; anything else stays. */
function modelLabel(id) {
  let s = String(id ?? "").trim(); if (!s) return "Default";
  const big = /\[1m\]$/i.test(s); s = s.replace(/\[1m\]$/i, "");
  s = s.slice(s.lastIndexOf("/") + 1).replace(/^([a-z]{2,7}\.)*anthropic\./i, "").replace(/^[a-z]{2,7}\.(?=claude-)/i, "")
    .replace(/@.*$/, "").replace(/-v\d+(:\d+)?$/i, "").replace(/-\d{8}$/, "").replace(/-latest$/i, "");
  const fam = /^(opus|sonnet|haiku)$/i.test(s) ? [s] : null;
  const m = fam ? null : /^claude-((?:[a-z]+|\d+)(?:-(?:[a-z]+|\d+))*)$/i.exec(s);
  if (!fam && !m) return String(id);
  const parts = fam || m[1].split("-"), word = parts.filter(p => !/^\d+$/.test(p)), num = parts.filter(p => /^\d+$/.test(p));
  const name = ["Claude", ...word.map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()), ...(num.length ? [num.join(".")] : [])].join(" ");
  return big ? `${name} (1M context)` : name;
}
const clock = ts => new Date(ts).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

/* small markdown renderer: code blocks, headings, lists, quotes, bold, inline code, links */
function md(src) {
  const out = []; const lines = (src || "").split("\n"); let i = 0;
  /* Code spans and [text](url) links are cut out of the raw text first and built from escaped parts, so no
     later step runs inside them or their attributes; the rest is escaped, then bold and bare URLs are added. */
  const inline = s => {
    const keep = [], put = html => `\u0001${keep.push(html) - 1}\u0001`;
    const link = (url, text) => `<a href="${esc(url)}" target="_blank" rel="noreferrer">${text}</a>`;
    const bold = t => t.replace(/\*\*([^*\u0001]+)\*\*/g, "<b>$1</b>");
    /* bare URLs become links too, in code spans as well (as the prototype does); trailing punctuation stays outside */
    const bare = t => t.replace(/(^|[\s(>])(https?:\/\/[^\s<\u0001]+?)([.,;:!?)]*(?=\s|<|\u0001|$))/g, (m, pre, url, tail) => `${pre}${link(unesc(url), url)}${tail}`);
    const raw = (s || "").replace(/\u0001/g, "")
      .replace(/`([^`]+)`/g, (m, c) => put(`<code>${bare(esc(c))}</code>`))
      .replace(/\[([^\]\u0001]+)\]\((https?:[^)\s\u0001]+)\)/g, (m, t, url) => put(link(url, bold(esc(t)))));
    return bare(bold(esc(raw))).replace(/\u0001(\d+)\u0001/g, (m, n) => keep[+n]);
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
      const body = rows.filter(r => !/^\s*\|?\s*:?-{2,}/.test(r)).map(cells);
      const [head, ...rest] = body;
      out.push(`<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rest.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)/); if (h) { out.push(`<h4>${inline(h[2])}</h4>`); i++; continue; }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l); const items = [];
      while (i < lines.length && (/^\s*([-*]|\d+\.)\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (/^\s*([-*]|\d+\.)\s+/.test(lines[i]) && !/^\s{4,}/.test(lines[i])) items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""));
        else items[items.length - 1] += "<br>" + lines[i].trim().replace(/^([-*]|\d+\.)\s+/, "– ");
        i++;
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.map(x => `<li>${inline(x).replace(/&lt;br&gt;/g, "<br>")}</li>`).join("")}</${ordered ? "ol" : "ul"}>`); continue;
    }
    if (/^>\s?/.test(l)) { const buf = []; while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, "")); out.push(`<blockquote>${lines2(buf)}</blockquote>`); continue; }
    if (!l.trim()) { i++; continue; }
    const buf = []; while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s|>|\s*\|)/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${lines2(buf)}</p>`);
  }
  return out.join("");
}

/* AskUserQuestion results read: "question"="answer". Pull the answers out. */
function parseAnswers(a) {
  const res = []; const re = /"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"/g; let m;
  while ((m = re.exec(a || ""))) res.push(m[2]);
  return res;
}
/* The note you added to each answer: `"question"="answer" notes: <note>.`, up to the next answer or the CLI's closing sentence. */
function parseNotes(a) {
  const res = []; const re = /"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"/g; const ms = [...(a || "").matchAll(re)];
  ms.forEach((m, i) => {
    const rest = a.slice(m.index + m[0].length, i + 1 < ms.length ? ms[i + 1].index : a.length).replace(/\s*Read the answers carefully[\s\S]*$/, "");
    const n = /^\s*notes:\s*([\s\S]*?)[.,]?\s*$/.exec(rest);
    res.push(n ? n[1] : "");
  });
  return res;
}
