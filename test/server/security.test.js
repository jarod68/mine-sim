import { describe, it, expect } from 'vitest';
import { parseOrigins, verifyOrigin, clientIp } from '../../server/security.js';
import { RateLimiter } from '../../server/rate-limit.js';

const reqWith = (headers) => ({ req: { headers } });

describe('security — origin allow-listing', () => {
  it('accepts a missing Origin (non-browser client)', () => {
    expect(verifyOrigin(reqWith({ host: 'game.example' }))).toBe(true);
  });

  it('defaults to same-origin: rejects a foreign Origin', () => {
    expect(verifyOrigin(reqWith({ host: 'game.example', origin: 'https://game.example' }))).toBe(true);
    expect(verifyOrigin(reqWith({ host: 'game.example', origin: 'https://evil.test' }))).toBe(false);
  });

  it('honours an explicit allow-list', () => {
    const allow = parseOrigins('https://a.test, https://b.test');
    expect(verifyOrigin(reqWith({ host: 'x', origin: 'https://a.test' }), allow)).toBe(true);
    expect(verifyOrigin(reqWith({ host: 'x', origin: 'https://c.test' }), allow)).toBe(false);
  });

  it('reads the client IP, honouring one proxy hop', () => {
    expect(clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }, socket: {} })).toBe('1.2.3.4');
    expect(clientIp({ headers: {}, socket: { remoteAddress: '9.9.9.9' } })).toBe('9.9.9.9');
  });
});

describe('rate limiter — token bucket', () => {
  it('allows a burst then drops, and refills over time', () => {
    let t = 0;
    const rl = new RateLimiter({ ratePerSec: 10, burst: 3, now: () => t });
    const ws = {};
    expect(rl.allow(ws)).toBe(true);
    expect(rl.allow(ws)).toBe(true);
    expect(rl.allow(ws)).toBe(true);
    expect(rl.allow(ws)).toBe(false);    // burst exhausted
    t = 200;                             // +0.2s → +2 tokens at 10/s
    expect(rl.allow(ws)).toBe(true);
    expect(rl.allow(ws)).toBe(true);
    expect(rl.allow(ws)).toBe(false);
  });
});
