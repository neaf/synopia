/* Store: the page's data and the state derived from it (split from prototype/app.html).
   For now the data comes from window.TRANSCRIPTS (transcripts.js); S1-5 feeds it through bridge.js. */
let data = [];
const shape = () => { data = (window.TRANSCRIPTS || []).map(t => ({ ...t, title: t.title || t.name, now: "" })); };
shape();
const STATE_OF = { waiting: "red", idle: "amber", busy: "green" };
/* The status field can say busy while Claude waits on you: a pending plan approval or question counts as "needs you". */
function pending(s) {
  const last = s.items[s.items.length - 1];
  if (last?.k === "tool" && last.name === "ExitPlanMode" && last.state === "running") return "plan";
  if (last?.k === "ask" && last.state === "pending") return "question";
  return null;
}
const stateOf = s => pending(s) ? "red" : (STATE_OF[s.status] || "amber");
const WORD = { red: "Needs you", amber: "Your turn", green: "Working" };
let current = (location.hash && data.find(s => s.id.startsWith(location.hash.slice(1)))?.id) || (data.find(s => s.status === "waiting") || data.find(s => s.status === "idle") || data[0])?.id;

/* reviewed subagents, interrupted turns, background work still running */
const REVIEWED_KEY = "synopia.reviewed.v1";
const reviewed = new Set(JSON.parse(localStorage.getItem(REVIEWED_KEY) || "[]"));
const isReview = a => /^for review:/i.test(a.description || "");
const toReview = s => agentsOf(s).filter(a => isReview(a) && a.finished && !reviewed.has(a.id));
const interrupted = s => { const l = s.items[s.items.length - 1]; return l?.k === "you" && /^\[Request interrupted by user/.test(l.text || ""); };
const bgRunning = s => agentsOf(s).some(a => !a.finished) || bgOf(s).some(b => bgState(b) === "running");
