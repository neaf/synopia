/* The one fuzzy matcher (requirements R3.14): a port of nota's FuzzyMatch.match and SearchIndex.search, which is
   fzf's v2 algorithm, as prototype/folders-storyboard.html runs it. The folder list, the Open list (in the backend,
   sessions.ts, over every past session), the / command menu and the model picker all match with it. DOM-free.
   A word matches when its letters appear in the text in order, case and accents aside; of every way it lines up,
   the best-scoring one is kept, with its positions. A space splits the query; every word must match, anywhere and
   in any order, and the scores add up. */

/* nota's constants: a matched letter, a gap's start and each letter more, the word-start bonuses */
const SCORE_MATCH = 16, GAP_START = -3, GAP_EXTENSION = -1;
const BONUS_BOUNDARY = SCORE_MATCH / 2, BONUS_NON_WORD = SCORE_MATCH / 2, BONUS_CAMEL123 = BONUS_BOUNDARY + GAP_EXTENSION;
const BONUS_CONSECUTIVE = -(GAP_START + GAP_EXTENSION), BONUS_FIRST_CHAR_MULTIPLIER = 2;
const BONUS_BOUNDARY_WHITE = BONUS_BOUNDARY + 2, BONUS_BOUNDARY_DELIMITER = BONUS_BOUNDARY + 1;
const NONE = -1e9;

/* character classes, in nota's order: 0 white, 1 non-word, 2 delimiter, 3 lower, 4 upper, 5 letter, 6 number */
const charClass = ch => /\s/.test(ch) ? 0 : "/,:;|".includes(ch) ? 2 : /\p{Ll}/u.test(ch) ? 3 : /\p{Lu}/u.test(ch) ? 4 : /\p{N}/u.test(ch) ? 6 : /\p{L}/u.test(ch) ? 5 : 1;
function bonusFor(prev, cls) {
  if (cls > 1) { if (prev === 0) return BONUS_BOUNDARY_WHITE; if (prev === 2) return BONUS_BOUNDARY_DELIMITER; if (prev === 1) return BONUS_BOUNDARY; }
  if ((prev === 3 && cls === 4) || (prev !== 6 && cls === 6)) return BONUS_CAMEL123;
  if (cls === 1 || cls === 2) return BONUS_NON_WORD;
  if (cls === 0) return BONUS_BOUNDARY_WHITE;
  return 0;
}
/* case and accents aside: "É" matches "e" */
const fold = ch => ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().charAt(0) || ch;
function prepare(s) { const cs = [...s]; return { keys: cs.map(fold), classes: cs.map(charClass) }; }

/* one word (folded letters) in a prepared text: { score, positions } or null */
function matchTerm(term, text) {
  const m = term.length, n = text.keys.length;
  if (!m || m > n) return null;
  const first = []; let j = 0;
  for (const c of term) { while (j < n && text.keys[j] !== c) j++; if (j >= n) return null; first.push(j); j++; }
  let last = n - 1; while (text.keys[last] !== term[m - 1]) last--;
  const W = last + 1, score = new Array(m * W).fill(0), cons = new Array(m * W).fill(0), bonus = [];
  let prev = 0; for (let col = 0; col < W; col++) { const c = text.classes[col]; bonus[col] = bonusFor(prev, c); prev = c; }
  let best = 0, bestCol = -1;
  for (let row = 0; row < m; row++) {
    const base = row * W, fc = first[row]; let inGap = false;
    for (let col = fc; col < W; col++) {
      const left = col > fc ? score[base + col - 1] : 0, s2 = left + (inGap ? GAP_EXTENSION : GAP_START);
      let s1 = NONE, consecutive = 0;
      if (text.keys[col] === term[row]) {
        if (row === 0) { s1 = SCORE_MATCH + bonus[col] * BONUS_FIRST_CHAR_MULTIPLIER; consecutive = 1; }
        else if (col > 0) {
          const diag = (row - 1) * W + col - 1; let b = bonus[col]; consecutive = cons[diag] + 1;
          if (consecutive > 1) { const fb = bonus[col - consecutive + 1]; if (b >= BONUS_BOUNDARY && b > fb) consecutive = 1; else b = Math.max(b, BONUS_CONSECUTIVE, fb); }
          s1 = score[diag] + SCORE_MATCH;
          if (s1 + b < s2) { s1 += bonus[col]; consecutive = 0; } else s1 += b;
          if (col - 1 < first[row - 1]) { s1 = NONE; consecutive = 0; }
        }
      }
      cons[base + col] = consecutive; inGap = s1 < s2;
      const sc = Math.max(s1, s2, 0); score[base + col] = sc;
      if (row === m - 1 && sc >= best && sc > 0) { best = sc; bestCol = col; }
    }
  }
  if (bestCol < 0) return null;
  /* the backtrace: the positions of the best alignment */
  const pos = []; let row = m - 1, col = bestCol, prefer = true;
  while (col >= 0) {
    const base = row * W, s = score[base + col];
    const s1 = row > 0 && col > 0 && col - 1 >= first[row - 1] ? score[base - W + col - 1] : 0;
    const s2 = col > first[row] ? score[base + col - 1] : 0;
    if (s > s1 && (s > s2 || (s === s2 && prefer)) && text.keys[col] === term[row]) { pos.push(col); if (row === 0) break; row--; }
    prefer = cons[base + col] > 1 || (base + W + col + 1 < m * W && row + 1 < m && cons[base + W + col + 1] > 0);
    col--;
  }
  return pos.length === m ? { score: best, positions: pos.reverse() } : null;
}

/* the query's words, folded */
export const terms = query => String(query || "").trim().split(/\s+/).filter(Boolean).map(t => [...t].map(fold));

/* the whole query in `text`: { score, at } (the matched positions, code points, ascending) or null. An empty
   query matches with score 0 and no positions. */
export function match(query, text) {
  const ts = Array.isArray(query) ? query : terms(query);
  if (!ts.length) return { score: 0, at: [] };
  const t = prepare(String(text)); let total = 0; const at = new Set();
  for (const term of ts) { const r = matchTerm(term, t); if (!r) return null; total += r.score; r.positions.forEach(p => at.add(p)); }
  return { score: total, at: [...at].sort((a, b) => a - b) };
}

/* the rows that match, best first; ties keep the list's own order. `textOf(row)` is what is matched; with
   `titleLength(row)`, a tie goes first to the row with more matched letters in its first titleLength code points
   (nota's `total * 64 + min(63, title matches)`). Each hit is { row, score, at }; an empty query keeps every row
   in order, with no positions. */
export function rank(rows, query, textOf, titleLength = null) {
  const ts = terms(query);
  if (!ts.length) return rows.map(row => ({ row, score: 0, at: [] }));
  const hits = [];
  rows.forEach((row, i) => {
    const m = match(ts, textOf(row)); if (!m) return;
    const inTitle = titleLength ? m.at.filter(p => p < titleLength(row)).length : 0;
    hits.push({ row, score: m.score, at: m.at, i, key: m.score * 64 + Math.min(63, inTitle) });
  });
  hits.sort((a, b) => b.key - a.key || a.i - b.i);
  return hits.map(({ row, score, at }) => ({ row, score, at }));
}

const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/* `text` as HTML, escaped, with the letters at `at` marked (`at` counts code points of the matched string, and
   `text` starts at code point `from` of it): <b class="m">, bold link blue, underlined on a selected row (app.css) */
export function marked(text, at, from = 0) {
  const on = new Set((at || []).map(p => p - from));
  if (!on.size) return escHtml(text);
  let out = "", open = false;
  [...String(text)].forEach((ch, i) => {
    const m = on.has(i);
    if (m && !open) { out += '<b class="m">'; open = true; } else if (!m && open) { out += "</b>"; open = false; }
    out += escHtml(ch);
  });
  return open ? out + "</b>" : out;
}
