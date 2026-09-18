/*
 * CarRiderPro token service for OPSsign2.
 *
 * Mints bearer tokens with the standard ASP.NET /Token password grant and
 * caches them in memory, so dismissal displays can come up already signed in
 * instead of showing a login screen.
 *
 * Wire it up in server.js the same way as hls-proxy:
 *
 *     const crpTokenRouter = require('./crp-token');      // with the requires
 *     app.use('/api/crp', crpTokenRouter);                // with the routes
 *
 * Requires in .env:
 *     CRP_USERNAME=...
 *     CRP_PASSWORD=...
 *     CRP_BASE_URL=https://www.carriderpro.com     (optional)
 *     CRP_ALLOWED_CIDRS=10.17.0.0/16,127.0.0.1/32  (optional, see below)
 *
 * Exposes:  GET /token (mounted at /api/crp) -> { access_token, expires, cached }
 */

const express = require('express');
const router = express.Router();

const CRP_BASE = process.env.CRP_BASE_URL || 'https://www.carriderpro.com';

// Re-mint when fewer than this many ms remain. Tokens last ~14 days, so a
// one-day margin means a display never receives a token close to expiry.
const REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;

let cached = null;          // { token, expiresAt (ms), issuedAt (ms) }
let inFlight = null;        // de-duplicates concurrent requests

function log(...args) {
  console.log('🚗 [crp-token]', ...args);
}

async function mintToken() {
  const username = process.env.CRP_USERNAME;
  const password = process.env.CRP_PASSWORD;

  if (!username || !password) {
    throw new Error('CRP_USERNAME / CRP_PASSWORD are not set in the environment');
  }

  const body = new URLSearchParams({
    grant_type: 'password',
    username,
    password
  });

  const res = await fetch(`${CRP_BASE}/Token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`/Token returned ${res.status} ${res.statusText} ${detail.slice(0, 200)}`);
  }

  const data = await res.json();

  if (!data.access_token) {
    throw new Error('/Token response contained no access_token');
  }

  // Prefer the explicit .expires field; fall back to expires_in seconds.
  const expiresAt = data['.expires']
    ? new Date(data['.expires']).getTime()
    : Date.now() + ((data.expires_in || 0) * 1000);

  cached = {
    token: data.access_token,
    expiresAt,
    issuedAt: Date.now()
  };

  log(`minted token, expires ${new Date(expiresAt).toISOString()}`);
  return cached;
}

async function getToken(force = false) {
  const stillGood = cached
    && !force
    && (cached.expiresAt - Date.now()) > REFRESH_MARGIN_MS;

  if (stillGood) {
    return { ...cached, fromCache: true };
  }

  // Collapse concurrent misses into a single upstream request.
  if (!inFlight) {
    inFlight = mintToken().finally(() => { inFlight = null; });
  }

  const fresh = await inFlight;
  return { ...fresh, fromCache: false };
}

/*
 * The OPSsign server is LAN-only, but this endpoint hands out a working
 * credential, so keep it to the signage network by default. Set
 * CRP_ALLOWED_CIDRS='' to disable the check entirely.
 */
function ipAllowed(req) {
  const raw = process.env.CRP_ALLOWED_CIDRS;
  if (raw === '') return true;                       // explicitly disabled

  const cidrs = (raw || '10.17.0.0/16,127.0.0.1/32,::1/128')
    .split(',').map(s => s.trim()).filter(Boolean);

  let ip = (req.ip || req.connection?.remoteAddress || '').replace(/^::ffff:/, '');
  if (ip === '::1') ip = '127.0.0.1';

  const toInt = a => a.split('.').reduce((n, o) => (n << 8 >>> 0) + parseInt(o, 10), 0) >>> 0;

  return cidrs.some(cidr => {
    if (cidr === '::1/128') return false;             // handled above
    const [net, bitsRaw] = cidr.split('/');
    if (!net.includes('.') || !ip.includes('.')) return false;
    const bits = parseInt(bitsRaw ?? '32', 10);
    if (bits === 0) return true;
    const mask = (~0 << (32 - bits)) >>> 0;
    return (toInt(ip) & mask) === (toInt(net) & mask);
  });
}

router.get('/token', async (req, res) => {
  if (!ipAllowed(req)) {
    log(`denied ${req.ip}`);
    return res.status(403).json({ error: 'Not permitted from this address' });
  }

  try {
    const { token, expiresAt, fromCache } = await getToken(req.query.force === '1');
    res.set('Cache-Control', 'no-store');
    res.json({
      access_token: token,
      expires: new Date(expiresAt).toISOString(),
      expires_in: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)),
      cached: fromCache
    });
  } catch (err) {
    console.error('🚗 [crp-token] failed:', err.message);
    res.status(502).json({ error: 'Could not obtain a CarRiderPro token' });
  }
});

// Warm the cache at module load and keep it fresh, so the first display of the
// day never waits on an upstream round trip.
getToken().catch(err => log('initial mint failed (will retry on demand):', err.message));
setInterval(() => {
  getToken().catch(err => log('scheduled refresh failed:', err.message));
}, 6 * 60 * 60 * 1000).unref();

log('router ready (mount at /api/crp)');

module.exports = router;
module.exports.getToken = getToken;
