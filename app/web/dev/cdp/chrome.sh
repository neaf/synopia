#!/bin/bash
# headless Chrome with CDP on $SYNOPIA_CHROME_PORT (default 9334), one profile per port
cp="${SYNOPIA_CHROME_PORT:-9334}"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port="$cp" --user-data-dir="${TMPDIR:-/tmp}/synopia-cdp-chrome-$cp" --window-size=1280,820 --no-first-run --no-default-browser-check about:blank > "${TMPDIR:-/tmp}/synopia-cdp-chrome-$cp.out" 2>&1 &
echo $! > "${TMPDIR:-/tmp}/synopia-cdp-chrome-$cp.pid"
