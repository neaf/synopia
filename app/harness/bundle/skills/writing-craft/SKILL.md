---
name: writing-craft
description: Craft rules for text a human will read and act on: pages, QA scripts, runbooks, plans, PR descriptions, ticket text, longer replies. Use before drafting such text, and when a reader says it is unclear, late or hard to follow. Not for agent-to-agent text such as subagent briefs, audit reports and run state files. Covers the form that mirrors the reader's task, the order, the exact word, the layout, and how to revise.
---

# Writing craft

Clarity is choice and placement: the right form, the right order, the right word at the right moment. It is not volume. Adding information is the cheap move and usually the wrong one. Every word, step and line is a decision, so make each one on purpose.

The default output of a writer, human or model, is the average: the popular frame, three bullets, a bold summary, a "comprehensive" paragraph. Average text is sloppy text. Before drafting, name the frame you would reach for by default, and replace it with the one this reader needs.

The working methods come from traditions where words and layout were engineered for a reader under real conditions. Maintenance manuals: one action per step, the expected result beside the action, the warning before the step it guards, because the reader's hands are busy. Poster and slogan design: one idea, the strongest concrete word, nothing that dilutes it. Swiss-style typography: hierarchy and position carry meaning, and whitespace groups better than labels. Task-oriented technical documentation: the reader's path, not the system's structure.

## Scope

These rules cover text a human reads and acts on. Agent-to-agent text is exempt: subagent briefs, a subagent's report to its orchestrator, audit reports, and run state files (`.rearch/`, `.attack-plan/`, `.ai-notes/` state sections). That text follows the brief's own rules and the style line in [preamble.md](../harness-common/references/preamble.md), and may use ids such as F1 or D1. When an agent writes text a human will read, such as a page, a PR description or ticket text, these rules apply to that text, whoever drafts it.

## 1. Before writing

Answer these in one line each. If you cannot, the text is not ready.

- Who reads it, and at what moment? Mid-deploy, mid-incident, between two meetings, on a phone?
- What are their hands and attention doing? Someone running a rollback with a terminal open cannot stop to look up an id.
- What is the one job of the text? "Roll back the release and confirm the error rate drops" is a job. "Document the feature" is not.
- What do they already know, and what do they call things? Use their words, not the names in your code or spec.

## 2. Structure: mirror the reader's task

Pick the form from the task the reader performs.

- Sequence (they do things in order): numbered steps, one action each, never labelled bullets per item (Who / Open / Expected / Why). Add checkboxes when progress matters, because a tick records that they moved through one thing.
- Decision (they choose): state the choice, then what each option does. Put the consequence beside its option, not in a paragraph below. Say what the reader sees, why it matters, the alternative, and what you need from them, in their words.
- Reference (they look things up): a table or labelled list they can scan. Never make them read it in order.
- Explanation (they must understand before acting): one idea, the case, the consequence. Short enough to hold in mind while acting.

Order is narrative. Each part sets up the next. If case 3 only makes sense after case 2, number them and say what changed since the previous one. Do not present items in parallel when the reader will go through them one after another: one list of parallel cases, each for a different user, becomes one progression where each step says what changed.

Put the precondition, the warning and the expected result before or beside the action they apply to. Never in a closing section the reader reaches after the damage.

## 3. Words

- Find the word where the reader could misread, and replace it with the exact one. "Today" and "current" are the usual traps: "the current version" can mean production or the build under test. "The version deployed to staging" is one phrase and settles it. One precise word beats three clarifying sentences.
- Write for the reader's place in the text. Spec ids such as "see case R4" or "as in D1" make the reader search, which is the author's index, not theirs. Remove them: say the thing again in a few words, or put it where it is needed.
- Use the reader's vocabulary: product names, screen labels, the role's own term. Not internal ids, class names or template labels.
- One term per concept, held constant from first use to last. A synonym for variety reads as a second concept.
- Concrete nouns and verbs. "The Reports tab lists 3 clients" beats "the view reflects the assignment". Cut "should", "may", "simply", "robust", "seamlessly", "ensure", "leverage" unless they carry a real meaning.
- Hedge only with the specific unknown. "Not yet checked in production" is a fact. "Might possibly" is noise. Mark what is verified and what is assumed.
- Resolve values before the reader needs them. A placeholder such as `<client id>` in a step the reader performs live forces them off the page. Put the value in, or the one lookup they need, in an earlier step.

## 4. Facts

- Verify every statement about the product, code or data before writing it, controls, paths and labels included. A wrong instruction costs more than a missing one: a check for a button that does not exist wastes a session and erodes trust in the rest.
- If you cannot verify a point, label it as an assumption and name the check that settles it. Never write it as a step.
- State each fact once, in the place it applies, also across pages. Two checks that differ by one fact become one sentence carrying both: "The export holds 120 orders. The table shows 120; the total line counts 118, because it skips refunded orders."

## 5. Layout

- Decide what the eye meets first: the title, then the one instruction or decision. Everything else is subordinate in position and size.
- Group by meaning. Space and nesting show what belongs together. Identical bullets flatten a sequence into a pile of concepts.
- Emphasis (bold, callouts, icons, colour) is rare, so it means something. When everything is bold, nothing is.
- Asides leave the main path: a short appendix, or a "why" block the reader opens if needed. The main path must be correct without them.
- A template is not a structure. Fixed labels (Context, Question, Options, Recommendation) get filled whether or not the content fits. Let the content choose the form, then check it against section 2.
- Labels serve the reader. A patched label such as "Caveat (cont.)" is left over from editing, not from writing. Rewrite the block as if it were new.

## 6. Revision

When a reader says "unclear" or "be more descriptive", do not add first: a glossary box or a longer note leaves the failure in place. Find the specific failure:

- Order: a step uses something introduced later.
- Word: one term means two things, or it is an internal name.
- Missing fact at the moment of need: the reader must leave the page or guess.
- Layout: the instruction sits under its explanation, or the expected result is far from the action.

Fix that place. Then cut. A good revision usually removes as much as it adds.

Reread cold, as the reader at that moment, with only this page open and their hands busy. For each step, ask what they do next and what they should see. If the page does not give the answer, the page is missing something.

After any structural edit, recheck numbering, sequence and every remaining reference.
