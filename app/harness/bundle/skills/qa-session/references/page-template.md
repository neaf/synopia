# Page template

The shape of a QA session page. Square brackets are placeholders the Builder fills in; the finished page has none. The page has three parts, in this order: the setup for the lead developer, collapsed; the scenarios; an empty Findings section. Add nothing else.

The driver reads the page top to bottom with the app open. Each scenario carries everything the driver needs to run it, so nobody has to scroll back or ask.

````markdown
# QA session: [feature in plain words] ([date of the session])

[One sentence: what the session walks through and in which order of personas. The driver ticks each check as they see it, and anyone adds what surprised them under Findings.]

<details>
<summary>Setup for the lead developer</summary>

Done before the session. Each check below has been run, and its result is written here.

- [ ] Environment: [URL] runs build [commit or pull request]. The deploy finished on that commit before the seed ran. Check: [the first thing on screen that proves the build].
- [ ] Feature switch [its exact UI label] is on for [scope]. Check: [where to see it]. To turn it off: [how].
- [ ] Data: [exact seed command] ran. It printed:
  - [label as printed]: [value], [what it means in one phrase]
  - [one line for every printed value a scenario relies on]
- [ ] Sign-in: each user below signed in once. [How sign-in or impersonation works, when it is not obvious.]
- [ ] Users: [email] (scenarios 1 and 3); [email] (scenario 2).

</details>

## Scenarios

### 1. [Title: what this scenario shows, in plain words]

As [persona, by the role label the UI shows] (`[email]`):

Start: [the real URL or screen where the scenario starts].

Context: [what the driver needs to know first: the seeded data this scenario uses, what changed since the previous scenario, and anything that will look odd but is expected here, with the reason].

1. [One action, naming each control by its exact label.]
   - [ ] [One observable fact this action shows.]
   - [ ] [Next fact.]
2. [Next action.]
   - [ ] [Fact.]

### 2. [Next title]

As [persona] (`[email]`):

Start: [URL or screen].

Context: [only what differs from scenario 1, and why the results below follow].

1. [Action.]
   - [ ] [Fact.]

## Findings
````

## Writing the scenarios

- **Order.** One persona at a time. Default order: the most powerful persona, then the new role, its edge cases, the roles that must see no change, then the feature switch off.
- **Persona line.** Exactly ``As [persona] (`[email]`):``, the first line under the heading. The persona is the role label the UI shows, the email the seeded one.
- **Context.** Everything the driver needs before the first step: the data the results depend on, the difference from the previous scenario, and any surprise with its reason (an environment gap, production behavior kept on purpose, real data next to seeded data). Show the data relationships in the UI in one scenario before a later one relies on them.
- **Steps.** One action each, numbered. A step that shows nothing new has no checkbox.
- **Checks.** One fact the driver can see, under the step that shows it. Two facts become two checks. Every expected result comes from the code and the seed. A result nobody could verify is labeled `unverified` with the check that would settle it, never written as a plain check.
- **Labels.** Every on-screen word is the exact label that scenario's persona sees, in their UI language, traced to the code that renders it. No paraphrase. Write a label that looks like an id or a date word (`Q4 Budget`, `Today`) in backticks; `check_page.py` skips backticked text for those checks.
- **Open product decisions.** A result that depends on a decision not yet made says so in the Context line: what the environment does now, and that it may change.
- **Words.** Prose in US English. No internal reference ids (spec rules, decision or question ids): name the case. Scenario numbers are allowed. No bare "today" or "now": say "on production" or "in this test environment". No history from earlier sessions.

## Findings

The heading is exactly `## Findings`, and nothing follows it when the page is built: no table, no placeholder text. The team writes findings there during the session, one bullet each.

## In a document tool

The setup becomes the tool's toggle block, titled "Setup for the lead developer", collapsed. Checkboxes become to-do blocks. See [publishing.md](../../harness-common/references/publishing.md).
