/* The credential refresh line in the dock (requirements R8.2, 2026-11-26): what a session shows while its model
   sign-in expired. The backend owns it (creds.ts): one `creds` frame per folder, whole, naming the sessions it
   is for. While the folder's refresh command runs ("Refreshing credentials…"), its output so far as a terminal
   run, and one field that types a line into it (Enter sends it with a newline) and Cancel. Otherwise "Needs
   you, sign-in expired" with why, and the command on one editable line with Save: Save stores it for the
   folder and runs it now; saved empty it is cleared. The fields keep what you typed and their focus when the
   line is drawn again (card.js keepFields). */
import { act } from "./connection.js";
import { esc } from "./format.js";
import { ind } from "./marks.js";
import { toast } from "./toast.js";

const byRoot = new Map(); // root -> the last `creds` frame
export function applyCreds(m) {
  if (m.phase === "idle" || !m.sids.length) byRoot.delete(m.root);
  else byRoot.set(m.root, m);
}
export const credsOf = sid => [...byRoot.values()].find(f => f.sids.includes(sid)) || null;
export const credsAll = () => [...byRoot.values()].map(f => ({ ...f, sids: [...f.sids] }));

const sentence = t => { const s = String(t || "").trim(); return !s ? "" : /[.!?]$/.test(s) ? s : s + "."; };

/* the line for a session that is signed out or refreshing */
export function credsHTML(s) {
  const f = credsOf(s.id), st = s.state;
  if (st.status === "refreshing" || f?.phase === "running") {
    const out = f?.output || "";
    return `<div class="status creds" data-state="green"><b>${ind("work")} Refreshing credentials…</b><span>Running ${f?.command ? `<code>${esc(f.command)}</code>` : "the refresh command"} in the session's folder. A sign-in in the browser may wait for you.</span>
      <div class="creds-run step-out running"><div class="res"><span class="lcorner" aria-hidden="true"></span><span class="out" id="creds-out">${out ? esc(out) : "<span class=\"dim\">No output yet</span>"}</span></div></div>
      <div class="creds-line"><span class="g">❯</span><input id="creds-in" spellcheck="false" autocomplete="off" placeholder="Type to the command, Enter sends" aria-label="Input to the refresh command"><button type="button" data-creds="cancel">Cancel</button></div></div>`;
  }
  const why = f?.error || sentence(st.detail?.error);
  return `<div class="status creds" data-state="red"><b>${ind("pause")} Needs you, sign-in expired</b><span>${why ? `${esc(why)} ` : ""}The model's credentials expired. Refresh them and Claude retries; once its turn has ended, send your message again.</span>
    <div class="creds-line"><label for="creds-cmd">Run to refresh credentials:</label><input id="creds-cmd" spellcheck="false" autocomplete="off" value="${esc(f?.command || "")}" placeholder="a command, such as bin/aws-login" aria-label="Command that refreshes the credentials"><button type="button" data-creds="save">Save</button></div></div>`;
}

/* after the line is in the dock: its field and buttons */
export function wireCreds(s) {
  const cmd = document.getElementById("creds-cmd"), inp = document.getElementById("creds-in");
  const save = () => act({ t: "credsSave", sid: s.id, command: cmd.value }, { done: (ok, error) => { if (!ok && error) toast(error); } });
  const type = () => { const text = inp.value; if (act({ t: "credsInput", sid: s.id, text }, { done: (ok, error) => { if (!ok && error) toast(error); } })) { inp.value = ""; delete inp.dataset.typed; } };
  document.querySelector('[data-creds="save"]')?.addEventListener("click", save);
  document.querySelector('[data-creds="cancel"]')?.addEventListener("click", () => act({ t: "credsCancel", sid: s.id }));
  for (const el of [cmd, inp]) if (el) el.addEventListener("input", () => { el.dataset.typed = "1"; });
  for (const el of [cmd, inp]) if (el) el.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); if (el === cmd) save(); else type(); }
    else if (e.key === "Escape") { e.preventDefault(); el.blur(); }
  });
  const out = document.getElementById("creds-out");
  if (out) out.parentElement.parentElement.scrollTop = 1e9; // the newest output in view
}
