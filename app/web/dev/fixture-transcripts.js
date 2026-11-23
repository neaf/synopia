// Hand-written fixture in the shape export_transcripts.py writes. All content is made up.
// Times are relative to the moment the page loads, so ages read the same on every run.
(() => {
const now = Date.now();
const ago = min => new Date(now - min * 60000).toISOString();

const billing = {
  id: "a7c3e1f0-5b2d-4c8e-9f10-1a2b3c4d5e6f", status: "waiting", statusAt: now - 4 * 60000,
  cwd: "~/dev/ledgerly", name: "billing-export", title: "Billing export: tax code column", prs: [41, 44, 47],
  background: [], agents: [],
  items: [
    { k: "you", ts: ago(42), text: "Add the **tax code** column to the billing CSV export and check the totals still match.", images: 0 },
    { k: "claude", ts: ago(41), text: "I'll look at the exporter and its specs first." },
    { k: "tool", ts: ago(41), name: "Grep", verb: "Searched", obj: "tax_code", state: "done" },
    { k: "tool", ts: ago(40), name: "Read", verb: "Read", obj: "~/dev/ledgerly/app/export/billing_csv.rb", state: "done" },
    { k: "tool", ts: ago(40), name: "Read", verb: "Read", obj: "~/dev/ledgerly/spec/export/billing_csv_spec.rb", state: "done" },
    { k: "tool", ts: ago(39), name: "Bash", verb: "Ran", obj: "Run the export specs", state: "done" },
    { k: "claude", ts: ago(36), text: "The exporter builds its columns in one list:\n\n- `amount` and `currency` come from the invoice line\n- the totals row sums `amount` only\n\n| Column | Source |\n|---|---|\n| amount | invoice line |\n| tax code | tax rule |\n\nSee https://example.com/ledgerly/csv-format for the format notes." },
    { k: "ask", ts: ago(34), state: "answered", qs: [
      { q: "Where should the tax code column go?", header: "Order", multi: false, opts: [["After amount (Recommended)", "Keeps money columns together."], ["At the end", "Old importers keep working."]] }],
      answer: "User has answered your questions: \"Where should the tax code column go?\"=\"After amount (Recommended)\". You can now continue with the user's answers in mind." },
    { k: "tool", ts: ago(30), name: "Edit", verb: "Edited", obj: "~/dev/ledgerly/app/export/billing_csv.rb", state: "done",
      patch: { file: "~/dev/ledgerly/app/export/billing_csv.rb", abs: "/Users/fixture/dev/ledgerly/app/export/billing_csv.rb", add: 2, del: 1, created: false, cut: false,
        hunks: [{ o: 14, n: 14, lines: ["   COLUMNS = [", "-    :date, :customer, :amount, :currency", "+    :date, :customer, :amount, :tax_code,", "+    :currency", "   ].freeze"] }] } },
    { k: "tool", ts: ago(29), name: "Bash", verb: "Ran", obj: "Run the export specs", state: "failed" },
    { k: "claude", ts: ago(5), text: "One spec fails: the totals row now has an empty tax code cell, and the importer reads that as a missing value. Two questions before I fix it." },
    { k: "ask", ts: ago(4), state: "pending", answer: null, qs: [
      { q: "What should the totals row show in the tax code column?", header: "Totals row", multi: false, opts: [["Leave it empty (Recommended)", "Matches the currency column, which is also empty there."], ["Write \"mixed\"", "Clear for people, but importers must skip it."]] },
      { q: "Which checks should I run after the fix?", header: "Checks", multi: true, opts: [["Export specs", "About 40 seconds."], ["Importer specs", "About 2 minutes."], ["The full suite", "About 12 minutes."]] }] }
  ]
};
billing.total = billing.items.length;

const reindex = {
  id: "b84d2a91-7e6f-4a3b-8c2d-2b3c4d5e6f70", status: "busy", statusAt: now - 26 * 60000,
  cwd: "~/dev/ledgerly.reindex", name: "search-reindex", title: "Search reindex: parallel workers", prs: [],
  items: [
    { k: "you", ts: ago(27), text: "Reindex search with parallel workers. Map the indexer first, and draft a rollout note I can review.", images: 1 },
    { k: "claude", ts: ago(26), text: "I'll split this three ways: one subagent maps the indexer, one benchmarks batch sizes, and a fork drafts the rollout note." },
    { k: "tool", ts: ago(25), name: "Agent", verb: "Subagent", obj: "Map the indexer", state: "done", toolUseId: "toolu_fx_a1" },
    { k: "tool", ts: ago(25), name: "Agent", verb: "Subagent", obj: "Benchmark batch sizes", state: "running", toolUseId: "toolu_fx_a2" },
    { k: "tool", ts: ago(25), name: "Agent", verb: "Subagent", obj: "For review: Draft the rollout note", state: "done", toolUseId: "toolu_fx_a3" },
    { k: "report", ts: ago(18), agent: "fa01c0de0001", text: "## Indexer map\n\nThe indexer reads in one loop of 500 rows. **Workers** can split on the id range.\n\n- `Indexer#run` holds the loop\n- `BatchWriter` flushes every 500 rows" },
    { k: "tool", ts: ago(17), name: "Bash", verb: "Ran", obj: "Start the reindex worker", state: "done" },
    { k: "tool", ts: ago(16), name: "Monitor", verb: "Watched", obj: "", state: "done" },
    { k: "claude", ts: ago(8), text: "The worker runs. While the benchmark finishes I'm running the reindex specs." },
    { k: "tool", ts: ago(1), name: "Bash", verb: "Ran", obj: "Run the reindex specs", state: "running" }
  ],
  agents: [
    { id: "fa01c0de0001", description: "Map the indexer", type: "Explore", fork: false, toolUseId: "toolu_fx_a1", model: "fixture-small", depth: 1, finished: true,
      start: ago(25), end: ago(18), total: 4, items: [
        { k: "you", ts: ago(25), text: "Map how the search indexer reads and writes rows.", images: 0 },
        { k: "tool", ts: ago(24), name: "Grep", verb: "Searched", obj: "class Indexer", state: "done" },
        { k: "tool", ts: ago(23), name: "Read", verb: "Read", obj: "~/dev/ledgerly.reindex/app/search/indexer.rb", state: "done" },
        { k: "claude", ts: ago(18), text: "The indexer reads in one loop of 500 rows." }] },
    { id: "fa02c0de0002", description: "Benchmark batch sizes", type: "general-purpose", fork: false, toolUseId: "toolu_fx_a2", model: "fixture-small", depth: 1, finished: false,
      start: ago(25), end: ago(1), total: 120, items: [
        { k: "you", ts: ago(25), text: "Benchmark batch sizes 250, 500 and 1000 on the staging copy.", images: 0 },
        { k: "tool", ts: ago(20), name: "Bash", verb: "Ran", obj: "Benchmark batch size 250", state: "done" },
        { k: "tool", ts: ago(12), name: "Bash", verb: "Ran", obj: "Benchmark batch size 500", state: "done" },
        { k: "claude", ts: ago(11), text: "250 rows: 41 s. 500 rows: 33 s. Running 1000 next." },
        { k: "tool", ts: ago(2), name: "Bash", verb: "Ran", obj: "Benchmark batch size 1000", state: "running" }] },
    { id: "fa03c0de0003", description: "For review: Draft the rollout note", type: "general-purpose", fork: true, toolUseId: "toolu_fx_a3", model: "fixture-large", depth: 1, finished: true,
      start: ago(24.5), end: ago(12), total: 2, items: [
        { k: "you", ts: ago(24.5), text: "Draft the rollout note for the parallel reindex.", images: 0 },
        { k: "claude", ts: ago(12), text: "#### Rollout\n\n1. Ship behind the `parallel_reindex` flag.\n2. Turn it on for one region." }] }
  ],
  background: [
    { toolUseId: "toolu_fx_b1", kind: "shell", description: "Reindex worker", command: "bin/reindex --workers 4", timeout: null, persistent: false, start: ago(17), status: "running", summary: "", end: null },
    { toolUseId: "toolu_fx_b2", kind: "monitor", description: "Watch the worker log for errors", command: "tail -f log/reindex.log | grep --line-buffered ERROR", timeout: 3600000, persistent: false, start: ago(16), status: "running", summary: "", end: null },
    { toolUseId: "toolu_fx_b3", kind: "shell", description: "Warm the cache", command: "bin/cache warm", timeout: null, persistent: false, start: ago(22), status: "completed", summary: "Cache warmed, 1,204 keys", end: ago(20) },
    { toolUseId: "toolu_fx_b4", kind: "monitor", description: "Watch CI on the branch", command: "gh run watch", timeout: 300000, persistent: false, start: ago(40), status: "running", summary: "", end: null },
    { toolUseId: "toolu_fx_b5", kind: "shell", description: "Old reindex dry run", command: "bin/reindex --dry-run", timeout: null, persistent: false, start: ago(35), status: "failed", summary: "Exited with code 1", end: ago(33) }
  ]
};
reindex.total = reindex.items.length;

const invoice = {
  id: "c1e94b07-3d8a-4f5e-a6b7-3c4d5e6f7081", status: "idle", statusAt: now - 12 * 60000,
  cwd: "~/dev/ledgerly", name: "invoice-pdf", title: "Invoice PDF: footer layout", prs: [52],
  background: [], agents: [], total: 180,
  items: [
    { k: "you", ts: ago(26 * 60), text: "The invoice footer wraps on A4. Find out why.", images: 0 },
    { k: "tool", ts: ago(26 * 60 - 1), name: "Read", verb: "Read", obj: "~/dev/ledgerly/app/pdf/invoice_footer.rb", state: "done" },
    { k: "claude", ts: ago(26 * 60 - 3), text: "The footer uses a fixed width of 210 mm minus margins, but the margins are counted twice." },
    { k: "you", ts: ago(30), text: "Fix it and add a spec for A4 and Letter.", images: 0 },
    { k: "tool", ts: ago(29), name: "Edit", verb: "Edited", obj: "~/dev/ledgerly/app/pdf/invoice_footer.rb", state: "done",
      patch: { file: "~/dev/ledgerly/app/pdf/invoice_footer.rb", abs: "/Users/fixture/dev/ledgerly/app/pdf/invoice_footer.rb", add: 3, del: 2, created: false, cut: false,
        hunks: [
          { o: 12, n: 12, lines: ["   def width", "-    page.width - margin * 2 - margin * 2", "+    page.width - margin * 2", "   end"] },
          { o: 40, n: 40, lines: ["   def render", "-    text footer_line, size: 9", "+    text footer_line, size: 9,", "+      overflow: :shrink_to_fit", "   end"] }] } },
    { k: "tool", ts: ago(27), name: "Write", verb: "Wrote", obj: "~/dev/ledgerly/spec/pdf/invoice_footer_spec.rb", state: "done",
      patch: { file: "~/dev/ledgerly/spec/pdf/invoice_footer_spec.rb", abs: "/Users/fixture/dev/ledgerly/spec/pdf/invoice_footer_spec.rb", add: 6, del: 0, created: true, cut: false,
        hunks: [{ o: 0, n: 1, lines: ["+RSpec.describe InvoiceFooter do", "+  %i[a4 letter].each do |size|", "+    it \"fits on one line on #{size}\" do", "+      expect(render_footer(size).lines).to eq(1)", "+    end", "+  end"] }] } },
    { k: "tool", ts: ago(26), name: "Bash", verb: "Ran", obj: "Run the PDF specs", state: "done" },
    { k: "tool", ts: ago(25), name: "Bash", verb: "Ran", obj: "Run rubocop on the changed files", state: "done" },
    { k: "claude", ts: ago(24), text: "Fixed. The margins were subtracted twice, so the footer had 40 mm less room than the page. Both sizes now fit on one line and the new spec covers them." }
  ]
};

const notes = {
  id: "d5f07c12-9a4b-4e6d-b7c8-4d5e6f708192", status: "idle", statusAt: now - 2 * 3600000,
  cwd: "~/dev/notes", name: "notes-cleanup", title: null, prs: [],
  background: [], agents: [],
  items: [
    { k: "you", ts: ago(130), text: "Merge the duplicate meeting notes in the inbox folder.", images: 0 },
    { k: "claude", ts: ago(129), text: "I'll list the inbox first." },
    { k: "tool", ts: ago(129), name: "Glob", verb: "Searched", obj: "inbox/*.md", state: "done" },
    { k: "tool", ts: ago(128), name: "Bash", verb: "Ran", obj: "Compare the two standup notes", state: "failed" },
    { k: "you", ts: ago(121), text: "[Request interrupted by user]", images: 0 }
  ]
};
notes.total = notes.items.length;

window.EXPORTED_AT = now;
window.TRANSCRIPTS = [billing, reindex, invoice, notes];
})();
