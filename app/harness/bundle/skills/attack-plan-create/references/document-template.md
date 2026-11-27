# Document template

Three pages. The attack plan is for product, leadership and the team. The technical solution is for engineers and the implementing agents. The evidence page holds the proof, so the other two stay short. Plain US English, short sentences, one name per concept. The writing discipline behind these rules is in [writing-craft](../../writing-craft/SKILL.md).

## Attack plan (`draft/attack-plan.md`)

Title: `<Project> - Attack plan`.

1. **Table of contents.**
2. **Scope callout** (🧭): *What* (one sentence, the user and the gain), *In scope*, *Out of scope*, *Sources* (product doc, designs, earlier explorations, reference PRs, the evidence page).
3. **0. Summary.** Bullets: *Today*, *Goal*, *How* (no implementation detail), *Already decided*, *Still open*, *Delivery* (milestone order, release).
4. **1. Product solution.** Plain language, no code terms.
   - **Glossary:** product concepts only, bold term then one sentence. Technical terms stay out.
   - **Product rules:** a table of the rules that hold across pages (who sees what, which items count, limits). A rule no source fixes carries ❓.
   - **One section per page, widget or flow:** **Today** bullets, **After the change** bullets, then a table *What | <role 1> | <role 2> | …* when roles differ. Each section stands on its own.
   - **Design callouts become rules.** Each callout on a design (display logic, limits such as "no more than 3", sort order, empty state, what a click opens, conditional elements) appears as a rule or a table row, in words.
   - **Out of scope:** what is not delivered, and for work that depends on another team's unreleased project, what users get once it ships.
   - **Delivery:** the slices users get, numbered from M1, in order. Each: what users can do once it ships, why it comes in that place, how it is released. No preparation milestone and no tasks.
5. **2. Open questions.** Right after the product solution, before the technical part. Format in `questions.md`. "No open question" when there is none.
6. **3. Technical solution.** The overview steps in one numbered list, then a link to the technical solution page.
7. **4. Milestones and verification.**
   - **Milestones:** one line per milestone, its goal, as what a user or the system can do once it is merged. M1 onward are the delivery slices of the product solution; M0, when there is one, is the shared preparation users do not see. Then *Order and dependencies*.
   - **M<n> tasks:** one subsection per milestone, holding its task table with columns *Area | Deliverable | Tasks*. *Area* is Backend or Frontend. Tasks are `• ` bullets joined by `<br />`. Rows take the milestone's color (M0 blue, M1 green, M2 yellow, M3 purple, then orange, pink). The table ends with a *QA* row and a *Review / Release* row. A task that depends on an open question carries ❓. No estimate column.
8. **5. Risks.** The only place risks live. Only what cannot be settled or verified now and could hurt the project: numbered bold title, then what is unknown, what it would cost, and how it gets settled. A solved constraint is not a risk. A decided trade-off goes in the technical solution.
9. **6. Assumptions to verify.** *With product* (each with what was ruled out) and *In engineering, by a test or a review*.
10. **Evidence.** A link to the evidence page.

## Technical solution (`draft/technical-solution.md`)

Title: `<Project> - Technical solution`. A callout links back to the attack plan.

1. **Overview:** the 3 to 7 steps as a numbered list, the hard constraints stated as decided, and one Mermaid `flowchart LR` of the parts and their links.
2. **One section per step:** what is built, where (pack, paths), what stays unchanged on purpose and why, the invariants it keeps. Per-page or per-area subsections for the last steps when they differ by page.
3. **Cross-cutting rules** the project needs: sharding, permissions, caching, performance. A table *Component | Runs on | Safe? | Why* when there is more than one component.
4. **Data, migrations and rollout:** schema changes or "no schema change", pre-flight checks, the feature flag and who it targets, the order per milestone, the kill switch.
5. **Verification strategy:** the test matrix (which roles, which data shapes), fixtures, persona QA on a review app, monitoring after release.
6. **Task detail per milestone:** one subsection per milestone (`M<n> task detail`), one task block per task in the schema of `executable-plan.md`, checked by `check_draft.py --tasks`.

## Evidence (`draft/evidence.md`)

Title: `<Project> - Evidence`. A 🔎 callout: "Evidence behind the attack plan, read at `<SHA>` on `<date>`. Line numbers drift." Then one section per area of today's code: tables of endpoints, guards, frontend gates, data, each with `path:line` links pinned to the SHA. Then the unverifiable claims, each with the check that would settle it (a query on shared data, a console call, a team to ask). Then the reference PRs and what each taught. Risks stay in the attack plan.

## Writing rules

- No estimates: no days, weeks, points or sizes.
- No inline cross-references ("see 2.4", "P1", "risk 1", "as above"). The structure carries the story. Labels appear only on the questions themselves.
- No decision log and no history. Decisions sit in the section they belong to, stated as decided. Ruled-out alternatives stay in the work folder (`draft/alternatives.md`) and are not published. Never "Option A / B" in the text.
- Product rules are written as decided when product has answered, and as an open question otherwise. Never "Proposed".
- No worked-example diagrams in the product part. The Today / After tables carry the detail.
- Name a group of people by what links them in the product ("people assigned to the same client"), not by an informal word that may later become a product concept.
- No working-status notes in the pages ("moved to M1", "drafted, not filed yet"). Status lives in the issue tracker and the pull requests.
- After any structural edit, re-check numbering and every remaining reference.
