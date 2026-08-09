// Shared fakes for client component tests. Not a *.test.js file, so Vitest does
// not collect it. The client renderers expect a canvas with a 2D context and a
// few DOM/browser globals; happy-dom supplies the globals, and these fakes stand
// in for the (unimplemented) canvas 2D context so render() calls are harmless.

export function noopCtx() {
  // Methods are no-ops; property assignments (fillStyle, font, …) just stick.
  return new Proxy({}, {
    get: (t, p) => (p in t ? t[p] : () => {}),
    set: (t, p, v) => { t[p] = v; return true; },
  });
}

export function fakeCanvas() {
  const ctx = noopCtx();
  return {
    width: 0,
    height: 0,
    style: {},
    getContext: () => ctx,
    addEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  };
}
