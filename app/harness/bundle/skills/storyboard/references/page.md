# The storyboard page

The reader is the author, deciding. They read the summary first and may stop there. They open a scenario when a bullet surprises them. Every block below serves that path.

## Top

- Title: the question as the author would say it. "Starting and opening sessions in any folder", not "Folder picker storyboard".
- One line under it: what the page compares, and "Every folder, title and count here is invented."
- A short table of contents, one link per section.
- One theme button, top right: "Dark mode" or "Light mode", the mode it switches to.

## Summary

Three columns, side by side on a wide screen.

1. **Recommended.** One bullet per behaviour, each a bold claim then one sentence on how it works. "**New session asks where, with the answer ready.** The folder of the session on screen is selected, so Cmd+N Enter starts there." Exactly one way to do each thing.
2. **Requirement changes.** One bullet per change, led by the ids it touches (`R3.3, FR-SES-02`) or "New R3.11". Say what goes as well as what comes: "settings.newSessionCwd and its default rule go."
3. **Open questions.** Only what the author owns: product choices, risk, scope. Each states the proposal, or the one check that would settle it ("Not checked: one scripted run must show whether …"). Facts the code can settle are settled before the page is shown, never asked.

## The design in one picture

One frame of the recommended design at its busiest (a year of data, many sessions open), with a caption that names the situation and what the eye should find first.

## A scenario

- `h2`: a numbered situation. "3. After a year", "4. Moved and deleted folders".
- Lede: the concrete situation in two or three sentences, with numbers. "43 folders used, 812 past sessions, 12 open." Say what happens today when it differs: "Today a send in either fails with …".
- `h3` per sub-question when one scenario holds several choices.
- **Options** (only where the choice is real): two or three columns, each a frame, a name, a status line ("Recommended" or "Not recommended") and one line. The recommended line says why it wins; the others say why they lose, in terms the author can check on the frame. All options share the same data, size and theme, so only the design differs.
- **Recommended flow:** a strip of numbered states. Each state has a "do" line (the user's action, with keys as `<kbd>`), the frame after it, and a "see" line under the frame (what changed and what to notice). Two or three states per row.

## Keyboard path

When the app is key-driven, a table: "You want to", "Keys", "Presses". One row per flow on the page, counted the same way ("not counting your first message"). Then a table of the keys inside any new list or dialog, each with what it does.

## Edge cases

Draw each: no data at all, the largest realistic amount, data that is broken, moved or deleted, text that is too long, a slow or failed load. Each frame says what the user can still do.

## Rejected

A list of options considered and not drawn. Each: the option in bold, then why it lost in one sentence. These lines move into the requirements doc's design notes once the author decides.

## Frames

- A frame is a piece of the app drawn with the look reference's own markup and tokens, at the app's real size. Show the whole window when position matters, a crop when only a part changes; say which in the caption.
- Marks and icons are judged at every size the app uses, from the largest preview to the smallest real size, plus a greyscale row.
- Motion in a frame runs as it will in the app. A "Preview reduced motion" toggle shows the fallback.
- Every string in a frame is the exact label the app uses, or the new label proposed, never lorem ipsum.

## Writing

- Captions name what the user does and sees, in the app's words, not in class or component names.
- One term per concept across the whole page and the summary.
- No ALL CAPS, no emoji, no decorative badges. "Recommended" is the only emphasis an option gets.
- Dates are absolute. "Today" means the behaviour of the current code, and the lede says so.
