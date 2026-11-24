// dark.css: its text colours keep 4.5:1 or more on the panels (FR-LOOK-02, the claim at the top of dark.css).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../css/dark.css", import.meta.url), "utf8");
const block = css.match(/:root\[data-theme="dark"\] \{([^}]*)\}/)[1];
const vars = Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{6})/g)].map(m => [m[1], m[2]]));

const lum = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test("dark mode: ink, ink-2, ink-3 and faint text reach 4.5:1 on the panel, the sub band and the canvas", () => {
  for (const fg of ["ink", "ink-2", "ink-3", "faint"]) for (const bg of ["panel", "sub", "canvas"]) {
    assert.ok(vars[fg] && vars[bg], `--${fg} and --${bg} are set`);
    const r = ratio(vars[fg], vars[bg]);
    assert.ok(r >= 4.5, `--${fg} ${vars[fg]} on --${bg} ${vars[bg]} is ${r.toFixed(2)}:1`);
  }
});
