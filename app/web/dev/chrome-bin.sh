#!/bin/sh
# Prints the browser binary for headless checks and screenshots.
# Prefers chrome-headless-shell: a plain binary with no app bundle, so it never shows in the Dock,
# activates or takes focus. Google Chrome.app run with --headless still registers as a macOS app.
# Order: $CHROME, the newest Playwright chrome-headless-shell, then Google Chrome (warns on stderr).
# Install the shell with: npx playwright install chromium-headless-shell
if [ -n "${CHROME:-}" ]; then echo "$CHROME"; exit 0; fi
shell=$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-*/chrome-headless-shell 2>/dev/null | sort -V | tail -1)
if [ -n "$shell" ] && [ -x "$shell" ]; then echo "$shell"; exit 0; fi
echo "chrome-bin.sh: no chrome-headless-shell, using Google Chrome (it can take focus); install: npx playwright install chromium-headless-shell" >&2
echo "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
