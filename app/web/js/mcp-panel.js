/* MCP servers (requirements R5.15): /mcp in the message box opens this panel over the main area, for the shown
   session, as the Open list does. The backend owns what it shows (mcp.ts): each server's status, the action
   running on it, the last action's error; every `mcp` frame replaces it whole. ↑↓ (j k) move between servers,
   ← → choose an action, Enter does it, Esc closes. A server shows its status as a mark and a word: Connected,
   Needs sign-in, Failed, Connecting, Disabled; only Connecting and a running action have a moving mark. */
import { request, act } from "./connection.js";
import { esc } from "./format.js";
import { ind } from "./marks.js";
import { setMode } from "./mode.js";
import { store } from "./state.js";

export const mp = { el: null, sid: null, servers: [], error: null, note: null, reading: false, sel: 0, act: null };

const STATUS = {
  connected: ["s_agent", "Connected"],
  "needs-auth": ["creds", "Needs sign-in"],
  failed: ["failed", "Failed"],
  pending: ["work", "Connecting"],
  disabled: ["mcp_off", "Disabled"],
};
const BUSY = { login: "Waiting for the browser…", logout: "Signing out…", reconnect: "Reconnecting…", enable: "Enabling…", disable: "Disabling…" };
const LABEL = { login: "Sign in", logout: "Sign out", reconnect: "Reconnect", enable: "Enable", disable: "Disable" };
const KIND = { http: "HTTP", sse: "SSE", ws: "WebSocket", stdio: "Local command", sdk: "Synopia's own", "claudeai-proxy": "claude.ai connector", other: "Server" };

/* a server's actions, in one order; the one Enter does first comes from its status */
function actionsOf(r) {
  if (r.status === "disabled") return [...(r.signIn ? ["logout"] : []), "enable"];
  return [...(r.signIn ? ["login", "logout"] : []), ...(r.reconnect ? ["reconnect"] : []), "disable"];
}
function primary(r) {
  const a = actionsOf(r);
  const want = r.status === "needs-auth" ? "login" : r.status === "disabled" ? "enable" : r.status === "failed" ? (r.reconnect ? "reconnect" : "login") : "reconnect";
  return a.includes(want) ? want : a[0];
}

export const mcpShown = () => Boolean(mp.el && !mp.el.hidden);

export function showMcp(sid) {
  if (!mp.el) {
    document.querySelector(".app").insertAdjacentHTML("beforeend", `
      <div class="open-list mcp-list" id="mcp-list" role="dialog" aria-label="MCP servers">
        <div class="panel ol-panel">
          <header class="ol-head">
            <h2 class="c-title">MCP servers</h2>
            <p class="c-meta" id="mcp-meta"></p>
          </header>
          <div class="ol-list mcp-rows" id="mcp-rows" role="listbox" aria-label="MCP servers"></div>
          <p class="ol-note mcp-err" id="mcp-err" role="alert" hidden></p>
          <p class="ol-keys"><kbd>↑</kbd> <kbd>↓</kbd> or <kbd>j</kbd> <kbd>k</kbd> move, <kbd>←</kbd> <kbd>→</kbd> choose, <kbd>Enter</kbd> does it, <kbd>Esc</kbd> closes</p>
        </div>
      </div>`);
    mp.el = document.getElementById("mcp-list");
    document.getElementById("mcp-rows").addEventListener("click", e => {
      const b = e.target.closest("[data-act]"), it = e.target.closest(".mcp-it"); if (!it) return;
      mp.sel = +it.dataset.i; mp.act = b ? b.dataset.act : null;
      if (b) run(); else draw();
    });
  }
  const same = mp.sid === sid;
  mp.sid = sid; mp.el.hidden = false;
  if (!same) { mp.servers = []; mp.error = null; mp.note = null; mp.sel = 0; mp.act = null; }
  mp.reading = true;
  draw();
  document.activeElement?.blur?.(); setMode("normal", false);
  if (!request({ t: "mcp", sid })) { mp.reading = false; draw(); }
}
function hide() { if (mcpShown()) mp.el.hidden = true; }

/* a new hello: the panel asks again (a frame lost with the old socket never comes) */
export function mcpAgain() { if (mcpShown() && mp.sid) request({ t: "mcp", sid: mp.sid }); }

export function applyMcp(m) {
  if (m.sid !== mp.sid) return;
  const was = mp.servers[mp.sel]?.name;
  mp.servers = m.servers || []; mp.error = m.error || null; mp.note = m.note || null; mp.reading = Boolean(m.reading);
  const i = mp.servers.findIndex(r => r.name === was);
  if (i >= 0) mp.sel = i; else { mp.sel = Math.min(mp.sel, Math.max(0, mp.servers.length - 1)); mp.act = null; }
  if (mcpShown()) draw();
}

function draw() {
  const box = document.getElementById("mcp-rows"); if (!box) return;
  const s = store.sessions.get(mp.sid), meta = document.getElementById("mcp-meta"), err = document.getElementById("mcp-err");
  meta.textContent = s ? "This session's servers. Sign in opens your browser; the session picks the sign-in up when it ends." : "";
  err.textContent = mp.error || ""; err.hidden = !mp.error;
  if (mp.note || !mp.servers.length) {
    box.innerHTML = `<p class="ol-empty">${esc(mp.note || (mp.reading ? "Reading the MCP servers…" : "This session has no MCP servers."))}</p>`;
    return;
  }
  const cur = mp.servers[mp.sel];
  if (cur && !actionsOf(cur).includes(mp.act)) mp.act = primary(cur);
  box.innerHTML = mp.servers.map((r, i) => {
    const [mark, word] = r.busy ? ["work", BUSY[r.busy] || "Working…"] : STATUS[r.status] || ["stopped", r.status];
    const on = i === mp.sel;
    const acts = r.busy ? "" : actionsOf(r).map(a => `<span class="act" role="button" data-act="${a}"${on && a === mp.act ? ' aria-pressed="true"' : ""}>${LABEL[a]}</span>`).join("");
    return `<div class="mcp-it st-${esc(r.busy ? "busy" : r.status)}" role="option" data-i="${i}" data-name="${esc(r.name)}" aria-selected="${on}">
      <span class="n">${esc(r.name)}</span><span class="st">${ind(mark)}<span class="w">${esc(word)}</span></span><span class="f">${esc(KIND[r.kind] || KIND.other)}${r.scope ? `, ${esc(r.scope)}` : ""}</span><span class="acts">${acts}</span></div>`;
  }).join("");
  box.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}

function run() {
  const r = mp.servers[mp.sel]; if (!r || r.busy || !mp.act) return;
  act({ t: "mcpAction", sid: mp.sid, name: r.name, action: mp.act });
}

/* its keys while it is shown (keys.js: the layer over the session keys) */
export function mcpKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) { if (e.metaKey && e.shiftKey && /^Bracket(Left|Right)$/.test(e.code)) e.preventDefault(); return; }
  const n = mp.servers.length;
  const move = step => { if (n) { mp.sel = (mp.sel + step + n) % n; mp.act = null; draw(); } };
  const choose = step => {
    const r = mp.servers[mp.sel]; if (!r || r.busy) return;
    const a = actionsOf(r), i = Math.max(0, a.indexOf(mp.act));
    mp.act = a[Math.min(a.length - 1, Math.max(0, i + step))]; draw();
  };
  if (e.key === "Escape") hide();
  else if (e.key === "Enter") run();
  else if (e.key === "ArrowDown" || e.key === "j") move(1);
  else if (e.key === "ArrowUp" || e.key === "k") move(-1);
  else if (e.key === "ArrowRight" || e.key === "l" || (e.key === "Tab" && !e.shiftKey)) choose(1);
  else if (e.key === "ArrowLeft" || e.key === "h" || (e.key === "Tab" && e.shiftKey)) choose(-1);
  else if (e.key.length !== 1) return;
  e.preventDefault(); e.stopPropagation(); // a letter that does nothing is still taken (keys.js: AppKit beeps)
}
/* a click outside the panel closes it */
document.addEventListener("mousedown", e => { if (mcpShown() && !e.target.closest(".mcp-list .ol-panel")) hide(); }, true);
