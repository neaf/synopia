---
name: handoff
description: Hands the current work off to a new session, invoked as `/handoff [notes]`. Writes the handoff file through the ai-notes skill and, where the host can start a session (Synopia), starts it; otherwise prints the prompt that starts it. Use when the user types `/handoff`, or asks to hand the work off or to continue in a new session.
---

# Handoff

Follow the "Handing off to a new session" section of [ai-notes](../ai-notes/SKILL.md). That section holds every step; this skill adds only the user's notes.

The user's notes for the next session, to include word for word under their own heading (may be empty):

$ARGUMENTS

If the line above still reads as a placeholder (a dollar sign followed by ARGUMENTS), the host did not substitute it. The notes are then the words the user wrote after the skill name, or in the request that loaded this skill.
