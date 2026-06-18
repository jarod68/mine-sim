// Per-connection token-bucket rate limiter. State lives on the socket (`ws._rl`)
// so it's automatically reclaimed when the socket is collected. `allow` returns
// false when the bucket is empty (caller drops the message).

class RateLimiter {
  constructor({ ratePerSec = 30, burst = 60, now = Date.now } = {}) {
    this.rate = ratePerSec;
    this.burst = burst;
    this.now = now;
  }

  allow(ws) {
    const t = this.now();
    let rl = ws._rl;
    if (!rl) rl = ws._rl = { tokens: this.burst, last: t };
    rl.tokens = Math.min(this.burst, rl.tokens + ((t - rl.last) / 1000) * this.rate);
    rl.last = t;
    if (rl.tokens < 1) return false;
    rl.tokens -= 1;
    return true;
  }
}

module.exports = { RateLimiter };
