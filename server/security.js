// WebSocket origin allow-listing (anti cross-site-WebSocket-hijacking) and small
// connection-limit helpers. Browser clients always send an Origin header; a
// cross-site page connecting to us would carry a foreign Origin, so we reject any
// Origin that is neither explicitly allowed nor same-origin with the Host.

function parseOrigins(env) {
  return (env || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// `info` is the ws verifyClient argument ({ req }). Returns true to accept.
function verifyOrigin(info, allowedOrigins = []) {
  const origin = info.req.headers.origin;
  if (!origin) return true;                      // non-browser client (no Origin)
  if (allowedOrigins.length) return allowedOrigins.includes(origin);
  try {
    return new URL(origin).host === info.req.headers.host;   // default: same-origin only
  } catch {
    return false;
  }
}

// Client IP from the socket, honouring a single proxy hop (Traefik) if present.
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

module.exports = { parseOrigins, verifyOrigin, clientIp };
