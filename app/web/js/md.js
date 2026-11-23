/* Md: small helpers and the markdown renderer (split from prototype/app.html). */
/* ---------- helpers ---------- */
const esc = s => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function dur(ms) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} d`;
}
const clock = ts => new Date(ts).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

/* small markdown renderer: code blocks, headings, lists, quotes, bold, inline code, links */
function md(src) {
  const out = []; const lines = (src || "").split("\n"); let i = 0;
  const inline = s => esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    /* bare URLs become links too; existing links are left alone, trailing punctuation stays outside */
    .split(/(<a [^>]*>.*?<\/a>)/).map((part, i) => i % 2 ? part : part.replace(/(^|[\s(>])(https?:\/\/[^\s<]+?)([.,;:!?)]*(?=\s|<|$))/g,
      (m, pre, url, tail) => `${pre}<a href="${url}" target="_blank" rel="noreferrer">${url}</a>${tail}`)).join("");
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
    if (/^>\s?/.test(l)) { const buf = []; while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, "")); out.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`); continue; }
    if (!l.trim()) { i++; continue; }
    const buf = []; while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s|>|\s*\|)/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }
  return out.join("");
}

/* AskUserQuestion results read: "question"="answer". Pull the answers out. */
function parseAnswers(a) {
  const res = []; const re = /"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"/g; let m;
  while ((m = re.exec(a || ""))) res.push(m[2]);
  return res;
}
