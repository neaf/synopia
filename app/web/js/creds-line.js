/* The credential refresh line in the dock (requirements R8.2, 2026-11-26): what a session shows while its model
   sign-in expired. The backend owns it (creds.ts): one `creds` frame per folder, whole, naming the sessions it
   is for (state.js keeps the last one). While the folder's refresh command runs it is a run like any other
   (runs.js): one line about the sign-in ("Refreshing credentials…", or "Needs you, sign-in expired" while it
   waits for input), with the run's preview under it; the preview opens its shell view, where its whole output,
   its input and its stop are (bg-view.js). Otherwise "Needs you, sign-in expired" with why, and the command on
   one editable line with Save: Save stores it for the folder and runs it now; saved empty it is cleared. The
   field keeps what you typed and its focus when the line is drawn again (card.js keepFields). */
import { act } from "./connection.js";
import { esc } from "./format.js";
import { ind } from "./marks.js";
import { toast } from "./toast.js";
import { applyCreds, credsOf, credsAll } from "./state.js";
import { credsRun, credsRunHTML } from "./runs.js";
export { applyCreds, credsOf, credsAll };

const sentence = t => { const s = String(t || "").trim(); return !s ? "" : /[.!?]$/.test(s) ? s : s + "."; };

/* the line for a session that is signed out or refreshing */
export function credsHTML(s) {
  const f = credsOf(s.id), st = s.state;
  if (f?.phase === "running" || st.status === "refreshing") {
    const waits = !!f?.waiting, r = f ? credsRun(f) : null;
    return `<div class="status creds" data-state="${waits ? "red" : "green"}"><b>${waits ? `${ind("pause")} Needs you, sign-in expired` : `${ind("work")} Refreshing credentials…`}</b><span>Synopia runs the folder's refresh command; Claude retries when it ends.</span>
      ${r ? credsRunHTML(r, `creds:${f.root}`) : ""}</div>`;
  }
  const why = f?.error || sentence(st.detail?.error);
  return `<div class="status creds" data-state="red"><b>${ind("pause")} Needs you, sign-in expired</b><span>${why ? `${esc(why)} ` : ""}The model's credentials expired. Refresh them and Claude retries; once its turn has ended, send your message again.</span>
    <div class="creds-line"><label for="creds-cmd">Run to refresh credentials:</label><input id="creds-cmd" spellcheck="false" autocomplete="off" value="${esc(f?.command || "")}" placeholder="a command, such as bin/aws-login" aria-label="Command that refreshes the credentials"><button type="button" data-creds="save">Save</button></div></div>`;
}

/* after the line is in the dock: its field and buttons */
export function wireCreds(s) {
  const cmd = document.getElementById("creds-cmd");
  const save = () => act({ t: "credsSave", sid: s.id, command: cmd.value }, { done: (ok, error) => { if (!ok && error) toast(error); } });
  document.querySelector('[data-creds="save"]')?.addEventListener("click", save);
  if (cmd) cmd.addEventListener("input", () => { cmd.dataset.typed = "1"; });
  if (cmd) cmd.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); save(); }
    else if (e.key === "Escape") { e.preventDefault(); cmd.blur(); }
  });
}
