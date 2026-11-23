/* Bridge: how data reaches the page. A stub for now: S1-5 fills it with the protocol client that applies
   server messages to the store and renders the panels that changed. Until then the page renders once from
   transcripts.js (see store.js). This file loads last, so the first render and the timers live here. */
const still = matchMedia("(prefers-reduced-motion: reduce)");
setInterval(() => {
  NOWISH = liveNow();
  document.querySelectorAll("[data-live]").forEach(el => { el.textContent = tookLive(NOWISH - new Date(el.dataset.live)); });
}, 1000);

renderAll();
if (new URLSearchParams(location.search).get("agent")) { view = new URLSearchParams(location.search).get("agent"); renderConv(); }
if (new URLSearchParams(location.search).get("open")) { const r = [...document.querySelectorAll(".frow .fc")].pop(); r?.click(); r?.scrollIntoView({ block: "start" }); }
