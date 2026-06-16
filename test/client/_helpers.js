// Shared fakes for client component tests. Not a *.test.js file, so Vitest does
// not collect it. The client renderers expect a canvas with a 2D context and a
// few DOM/browser globals; happy-dom supplies the globals, and these fakes stand
// in for the (unimplemented) canvas 2D context so render() calls are harmless.

import { vi } from 'vitest';

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

// A controllable WebSocket double. Captures sent frames and lets a test push
// server frames in and toggle the connection state.
export class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }
  send(msg) { this.sent.push(msg); }
  close() { this.readyState = FakeWebSocket.CLOSED; this.onclose?.(); }
  // test helpers
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  receive(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  lastSent() { return this.sent.length ? JSON.parse(this.sent[this.sent.length - 1]) : null; }
}

export function installFakeWebSocket() {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  return FakeWebSocket;
}
