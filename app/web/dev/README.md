# Checking the page without real data

- `fixture-transcripts.js`: four made-up sessions in the shape `export_transcripts.py` writes. Needs you (a pending ask with two questions), working (subagents with a fork, a running one and a "For review:" one, shells and monitors), your turn (files changed with diffs), and stopped (an interrupted turn). Times are relative to page load.
- `fixture-menu.js`: a made-up `window.MENU` (models and slash commands).

## Compare the port with the prototype

```sh
app/web/dev/compare.sh            # writes /tmp/synopia-compare/shots/<state>-proto.png and <state>-port.png
```

It copies `prototype/app.html` and the port into temp folders, puts the fixtures next to each as `transcripts.js` and `menu.js`, and takes headless Chrome screenshots at 1280x820, with reduced motion so the marks hold still. The states are picked with the hash and the `?open=` and `?agent=` hooks. It never touches `prototype/transcripts.js`.

The only expected differences are what the port dropped (see `PORT.md`). With this fixture that is the "4 open sessions" text in the sidebar footer.

## View it by hand

```sh
d=$(mktemp -d); cp -R app/web/index.html app/web/css app/web/js app/web/icon "$d"
cp app/web/dev/fixture-transcripts.js "$d/transcripts.js"; cp app/web/dev/fixture-menu.js "$d/menu.js"
open "$d/index.html#a7c3e1f0"
```

Don't put a `transcripts.js` in `app/web/` itself: from S1-5 the page gets its data from the backend.
