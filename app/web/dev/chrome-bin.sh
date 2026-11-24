#!/bin/sh
# Prints the browser binary for headless checks and screenshots: $CHROME, else the newest Playwright
# chrome-headless-shell. That is a plain binary with no app bundle, so it never shows in the Dock,
# activates or takes focus (docs/Page checks.md, "Focus rule"). With neither it fails with the install hint:
# there is no fallback to a browser app.
if [ -n "${CHROME:-}" ]; then echo "$CHROME"; exit 0; fi
shell=$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-*/chrome-headless-shell 2>/dev/null | sort -V | tail -1)
if [ -n "$shell" ] && [ -x "$shell" ]; then echo "$shell"; exit 0; fi
echo "chrome-bin.sh: no chrome-headless-shell; install it with: npx playwright install chromium-headless-shell" >&2
exit 1
