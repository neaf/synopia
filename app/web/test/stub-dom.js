// The browser globals the page modules touch when they load (listeners, the #conv and #groups elements, the
// URL), as inert stand-ins, so a test can import a module that renders HTML and call its pure parts.
// Import this before any page module: `import "./stub-dom.js";` first, then `await import(...)` the modules.
const el = () => ({
  addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
  closest: () => null, classList: { toggle() {}, add() {}, remove() {}, contains: () => false }, dataset: {}, style: { setProperty() {} },
});
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.document = {
  getElementById: el, querySelector: el, querySelectorAll: () => [], addEventListener() {},
  documentElement: el(), body: el(),
};
globalThis.location = { search: "?token=t", hash: "" };
globalThis.CSS = { escape: s => s };
globalThis.MutationObserver = class { observe() {} };
globalThis.requestAnimationFrame = () => 0;
