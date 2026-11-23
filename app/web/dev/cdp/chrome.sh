#!/bin/bash
# headless Chrome with CDP on 9334
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9334 --user-data-dir="${TMPDIR:-/tmp}/synopia-cdp-chrome" --window-size=1280,820 --no-first-run --no-default-browser-check about:blank > "${TMPDIR:-/tmp}/synopia-cdp-chrome.out" 2>&1 &
echo $! > "${TMPDIR:-/tmp}/synopia-cdp-chrome.pid"
