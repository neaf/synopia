/* Composer: pasted images, the slash menu and the model picker (split from prototype/app.html). */
const attachments = [];

/* ---------- slash commands and /model ---------- */
const MENU = window.MENU || { models: [], commands: [] };
const COMMANDS = MENU.commands.filter(c => !c.name.startsWith("__"));
let modelValue = "default";
const modelName = () => {
  const m = MENU.models.find(x => x.value === modelValue) || { name: "Default", description: "" };
  const cur = (m.description || "").match(/currently ([^()]+)/);
  return m.value === "default" && cur ? `Default (${cur[1].trim()})` : m.name;
};
function rank(list, q, key) {
  q = q.toLowerCase();
  const scored = list.map(x => {
    const n = key(x).toLowerCase();
    const i = n.indexOf(q);
    const parts = n.split(/[-:_]/);
    const word = parts.some(p => p.startsWith(q));
    return { x, s: !q ? 1 : n.startsWith(q) ? 0 : word ? 1 : i >= 0 ? 2 : 9 };
  }).filter(r => r.s < 9);
  return scored.sort((a, b) => a.s - b.s || key(a.x).localeCompare(key(b.x))).map(r => r.x);
}
function attachSlash(ta, s, onModel) {
  const box = document.getElementById("slash");
  let mode = null, items = [], sel = 0;
  const close = () => { box.hidden = true; mode = null; };
  const draw = () => {
    if (!items.length) { box.innerHTML = `<div class="head">No matching command</div>`; box.hidden = false; return; }
    box.innerHTML = (mode === "model" ? `<div class="head">Choose a model for this session</div>` : "") + items.slice(0, 40).map((it, i) => mode === "model"
      ? `<div class="it" role="option" data-i="${i}" aria-selected="${i === sel}"><span class="n">${it.value === modelValue ? "❯ " : "  "}${esc(it.name)}</span><span class="d">${esc(it.description || "")}</span></div>`
      : `<div class="it" role="option" data-i="${i}" aria-selected="${i === sel}"><span class="n">/${esc(it.name)}${it.hint ? ` <span class="h">${esc(it.hint)}</span>` : ""}</span><span class="d">${esc(it.description)}</span></div>`).join("");
    box.hidden = false;
    box.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    box.querySelectorAll(".it").forEach(el => el.onmousedown = e => { e.preventDefault(); sel = +el.dataset.i; pick(); });
  };
  const update = () => {
    if (mode === "model") return;
    const m = ta.value.match(/^\/(\S*)$/);
    if (!m) { close(); return; }
    mode = "cmd"; items = rank(COMMANDS, m[1], c => c.name); sel = 0; draw();
  };
  const pick = () => {
    const it = items[sel]; if (!it) return;
    if (mode === "model") { modelValue = it.value; close(); ta.value = ""; onModel(it); return; }
    if (it.name === "model") { mode = "model"; items = MENU.models; sel = Math.max(0, items.findIndex(m => m.value === modelValue)); ta.value = "/model "; draw(); return; }
    ta.value = `/${it.name} `; close(); ta.focus();
  };
  ta.addEventListener("input", update);
  ta.addEventListener("keydown", e => {
    if (box.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); e.stopImmediatePropagation(); sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; draw(); }
    else if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); e.stopImmediatePropagation(); pick(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(); if (ta.value.startsWith("/model")) ta.value = ""; }
  }, true);
  ta.addEventListener("blur", () => setTimeout(close, 120));
}
