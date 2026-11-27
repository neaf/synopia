# Asking the author

## Before you ask

Drop a question when a source, the code, a digest or this conversation already answers it, or when no answer would change the plan. Launch a subagent for a fact you can look up: the author answers decisions, not facts.

## One at a time

- Ask one question, wait for the answer, write it into the ledger and the draft, then ask the next one. Use the question tool when the editor has one, with the recommended option first.
- Order: the question that blocks the most other work first. A question that depends on an unanswered one waits.
- When the answer opens new questions, ask them next, before moving on.
- When a fact-finding subagent is still running, ask the questions that do not depend on it.

## The safe default

Every question carries the option you recommend and the safe default. They are often the same. The safe default is the option that:

1. opens access to no one who does not have it today;
2. changes no shared framework and no code owned by another team;
3. is easy to undo (a flag, a config, no data migration);
4. keeps the smallest scope that still delivers the need;
5. matches what the reference feature or the existing code already does.

When the options rank differently on these, say which point decides.

## The format

In the conversation:

```
**<n>. <Title, no trailing period>**
- What I found: <one or two sentences, with the source link or path:line>
- Question: **<the question>**
  - **<Short label>:** <what happens with this option>
  - **<Short label>:** <what happens with this option>
- Recommendation: **<label>**, <one-line reason>. Safe default: **<label>** <only when different>.
- Depends on it: <the part of the plan this answer changes>
```

A product question is built on one concrete example: a named persona, a client, real numbers, and what that person sees under each option. Never point to an outside document ("the matrix", "PR #123"): restate the problem in the question.

## Recording the answer

- Write the answer where it belongs in the draft, stated as decided. Log it in `ledger.md` with who answered and where (chat, date, link).
- When the author does not own the decision (product, design, another team), keep it in the Open questions section of the attack plan in this format, and continue with the safe default written as an assumption:

  ```
  **Q<n>. <Title>**
  - **Context**
    - <one short sentence per sub-bullet>
  - **Question:** **<the question>**
    - **<Short label>:** <option>
    - **<Short label>:** <option>
  - **Recommendation:** **<label>**, <one-line reason>.
  ```

- Number questions in reading order. When one is answered, move the answer into its section, remove the question and renumber.
- No answer and no one to ask: take the safe default, mark it ❓ in the product tables, and list it under Assumptions. Tell the author how far the plan goes on assumed answers.
