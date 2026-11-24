# WKWebView and AppKit

How the Swift shell hosts the page, and what WebKit and AppKit do that the page must work around. The shell is one window with one `WKWebView` loading `http://127.0.0.1:<port>/?token=…` from the daemon ([Daemon files](Daemon%20files.md)). The page also runs in Chrome for checks ([Page checks](Page%20checks.md)). Sources: code, and a probe window on macOS 26 recorded in `.ai-notes/app/README.md` (Title bar).

## Title bar

- The window uses `.fullSizeContentView` with a transparent, hidden title (the title stays for Mission Control and the Window menu). The traffic lights sit over the dark sidebar.
- On macOS 26 the title bar is 32 pt (frame height minus `contentLayoutRect.height`), with or without `.fullSizeContentView`. The traffic lights sit 9 to 23 pt down and 9 to 69 pt across.
- The shell measures the height at launch and passes it to the page as `--titlebar`; until then it uses 28 pt. In Chrome `--titlebar` is 0.
- A page overlay that covers the window (fixed, top 0) must start at `top: var(--titlebar)`, or its top part sits under the drag strip and can't be clicked.
- The page gets `html.in-app`, `html.fullscreen` and `--titlebar` from a `WKUserScript` at document start, re-applied on change.
- Code: `TitleBar.swift` `WindowFrame` (11-20), `AppDelegate.swift` 31-43, `WebView.swift` `syncChrome` (29-42).

### Quirk: the sidebar width lives in two places

- Symptom: the drag strip and the sidebar disagree after a CSS change.
- Cause: the strip over the sidebar is native; its width can't be read from the page.
- Workaround: 270 px in `app.css` (`.app` first track, line 33) and `WindowFrame.sidebarWidth` (`TitleBar.swift` 18), kept equal by hand.

### Double-click on the strip

`DragStrip` follows System Settings, "Double-click a window's title bar to": `AppleActionOnDoubleClick` in the global domain (`Minimize`, `None`, `Maximize` or `Fill`, which zoom; unset zooms). When it is unset, the older `AppleMiniaturizeOnDoubleClick` true means minimize. Code: `TitleBar.swift` `doubleClick` (81-93).

## Window tabbing takes ⌘⇧[

- Symptom: ⌘⇧[ shows the previous window tab instead of switching sessions.
- Cause: AppKit's automatic window tabbing adds "Show Previous Tab" (⌘⇧[) and "Show Next Tab" to the Window menu.
- Workaround: `NSWindow.allowsAutomaticWindowTabbing = false` before the menus are built.
- Code: `AppDelegate.swift` 23-24.

## 24-hour clock

- Symptom: times show 12-hour although macOS is set to 24-hour.
- Cause: the web view's locale does not see the macOS 24-hour setting (System Settings, Date & Time).
- Workaround: the shell reads `DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: .current)` (`H` or `k` means 24-hour) and injects `window.SYNOPIA_CLOCK24`; the page formats every time with it.
- Code: `WebView.swift` 31-35; `transcript.js` 8-9.

## Links and navigation

- Symptom: a `target="_blank"` link or a `file://` link does nothing.
- Cause: WKWebView opens no new windows without a UI delegate, and has no file access.
- Workaround: the page intercepts every link and file click and sends `open` to the daemon (`/usr/bin/open`, see [macOS](macOS.md#opening-files-usrbinopen)). The shell allows only navigation to the backend origin and `about:blank`; any other main-frame navigation is cancelled and, for http and https, opened with `NSWorkspace`. `createWebViewWith` does the same and returns nil.
- Code: `transcript.js` 529; `WebView.swift` `decidePolicyFor`, `createWebViewWith` (66-99).

## JavaScript panels

WKWebView shows no `alert()` or `confirm()` itself: without a `WKUIDelegate` `runJavaScriptConfirmPanelWithMessage` implementation, `confirm()` returns false at once. The page uses no `alert()` or `confirm()`: closing asks in the message box, so the shell implements no panel delegate. Code: `WebView.swift` `WKUIDelegate` (createWebViewWith only).

## Snapshots without permission

`WKWebView.takeSnapshot` needs no Screen Recording permission. The debug hook `SYNOPIA_SNAPSHOT=/path.png` writes the first load 1.5 s after it finishes; it captures web content only, not the title bar. Code: `WebView.swift` 80-95. Page checks do not use it: they never launch the app.

## Rendering quirks

### Quirk: a rebuilt element restarts its animation

- Symptom: running marks jump back to phase 0 every few seconds.
- Cause: an `innerHTML` render makes new elements, and a new element's CSS animation starts at 0.
- Workaround: pin every mark animation (`.ind`, `.spinner`) to the document timeline's origin, `CSSAnimation.startTime = 0`, from a document-wide `MutationObserver` (once per frame) and an `animationstart` listener. Layout tweens keep their own timing.
- Code: `marks.js` `syncMarks` (99-118).
- Related: `getAnimations()` on a detached node is empty, so a tween is cancelled after reinserting the node; `currentTime` on a new animation waits a frame, `startTime` doesn't. Code: `sidebar.js` `tweenLines`.

### Quirk: a re-render loses open state

- Symptom: open `<details>` and expanded diffs close on every update.
- Cause: keyed blocks are rebuilt from HTML strings; the new elements have default state.
- Workaround: `carryState` copies open state by position and id; open steps are kept in a set keyed `sid|view|itemId`.
- Code: `transcript.js` 487-494, `ui.js` 152-169.

### Quirk: native drag on buttons

- Symptom: dragging a sidebar row starts no drag, or a click instead.
- Cause: native HTML5 drag is unreliable on `<button>` rows in WebKit.
- Workaround: drag and drop uses pointer events and `touch-action: none`.
- Code: `dnd.js` 2, `app.css` 441.

## Page platform facts

- Pasted images: an object URL for the thumbnail, a `FileReader` data URL for sending; PNG and JPEG only, 5 MB each. Code: `composer.js` 274-304.
- `crypto.randomUUID` exists only in secure contexts; `http://127.0.0.1` is one, other hosts may not be, so a fallback is present. Code: `composer.js` 4.
- `<img>` requests can't carry headers, so image URLs carry the token in the query (`/api/image?token=`). The stored viewer state strips it and adds it back on restore. Code: `images.js` 9, `ui.js` 79, 205.

## Content Security Policy

- The daemon sends the CSP header on every response; `index.html` repeats a looser `<meta>` copy (no port) for when the header is missing.
- `script-src 'self'`: no inline script, no eval. `style-src-attr 'unsafe-inline'` is needed: the markup sets positions and mark sizes in style attributes (`--iw`, `--dn`), which can't run script.
- `style-src` and `font-src` allow `https://fonts.googleapis.com` and `https://fonts.gstatic.com`: the page loads Atkinson Hyperlegible Next and JetBrains Mono from Google Fonts at run time (`display=swap`); JetBrains Mono NL comes only from a local install. Offline or blocked, it falls back to `system-ui` and Menlo, and the `ch`-based transcript grids change width. The swap itself rewraps text after load; see [Page checks](Page%20checks.md#web-font-swap). R11 bundles the fonts (decision Q8), which removes both hosts.
- `img-src 'self' data: blob:` for `/api/image` and pasted images.
- Code: `server.ts` `contentSecurityPolicy` (52-72), `index.html` 6-14.

## WebKit features used

The page uses CSS `subgrid`, the CSS Custom Highlight API (`CSS.highlights`, feature-detected: without it find marks are absent), `inert`, `Array.prototype.findLast` and a writable `CSSAnimation.startTime`. The minimum WebKit (and so macOS) version that has all of them is `unverified`. Code: `app.css` 783 (subgrid), `preview.js` 97, `tween.js` 42 (inert), `store.js` 40 (findLast), `marks.js` 109.
