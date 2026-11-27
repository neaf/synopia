# Target documentation style

## Doc set

- `README.md`: what the project does, how to build, run and test.
- `docs/requirements.md`: functional requirements with IDs.
- `docs/architecture.md`: modules, data flow, concurrency, interfaces.
- One topic doc per external system or hard subsystem, named after it: `docs/Payment API.md`, `docs/PostgreSQL.md`, `docs/USB device protocol.md`.
- `CLAUDE.md` or `AGENTS.md`: under 60 lines, commands plus pointers to the docs above.

## Topic doc rules

- Present tense facts about how the system behaves.
- No history. Cut "we tried", "initially", "turned out", inspirations and dead ends. Tag `rearch-base` keeps that history.
- Each quirk has four parts: symptom, cause (or "cause unknown"), workaround, code location.
- Each fact has a source: code location, capture file, test, or vendor doc link. Unverified facts carry the word `unverified`.
- Protocol and API details go in tables: message or call, fields, meaning.
- One topic per doc. A fact used by two docs lives in one and the other links to it.

## Code comments

- Comments state why the code does something non-obvious, usually a quirk. Link the topic doc section.
- Delete commented-out code, TODOs that the plan resolves, and comments describing old behavior.
