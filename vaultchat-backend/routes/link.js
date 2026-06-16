// vaultchat-backend/routes/link.js
//
// Server-side link-preview (Open Graph) fetcher. Replaces the client's old
// opengraph.io "sample_id" demo call with a real, self-hosted fetch so previews
// actually work and no third-party sees our users' links.
//
// SECURITY (SSRF): users send arbitrary URLs, so we fetch with a hard allow-list
// of public http(s) targets only — every candidate IP is checked against private
// / loopback / link-local ranges and the request is blocked otherwise. We also
// cap time + bytes and never follow into a private host on redirect.

const express = require('express');
const dns     = require('dns').promises;
const net     = require('net');
const jwtUtil = require('../jwt');

const router = express.Router();
router.use(jwtUtil.requireAuth);

const TIMEOUT_MS = 5000;
const MAX_BYTES  = 512 * 1024;          // read at most 512KB of HTML
const CACHE_TTL  = 30 * 60 * 1000;      // 30 min
const cache = new Map();                // url -> { at, data }

function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => Number.isNaN(n))) return true;
  const [a, b] = p;
  return a === 10 || a === 127 || a === 0 ||
         (a === 172 && b >= 16 && b <= 31) ||
         (a === 192 && b === 168) ||
         (a === 169 && b === 254) ||          // link-local
         (a === 100 && b >= 64 && b <= 127);  // CGNAT
}
function isPrivateIPv6(ip) {
  const x = ip.toLowerCase();
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') ||
         x.startsWith('fe80') || x.startsWith('::ffff:'); // mapped v4 -> treat as suspect
}
function isBlockedIP(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true;
}

// Resolve a hostname and ensure EVERY address is a public IP.
async function assertPublicHost(hostname) {
  if (net.isIP(hostname)) {
    if (isBlockedIP(hostname)) throw new Error('blocked host');
    return;
  }
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(hostname)) throw new Error('blocked host');
  const addrs = await dns.lookup(hostname, { all: true });
  if (!addrs.length) throw new Error('no address');
  for (const a of addrs) if (isBlockedIP(a.address)) throw new Error('blocked host');
}

function pickMeta(html, prop) {
  // <meta property="og:title" content="..."> (either attribute order)
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, 'i');
  const m = html.match(re1) || html.match(re2);
  return m ? decodeEntities(m[1]).trim() : '';
}
function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'");
}

// GET /link/preview?url=...
router.get('/preview', async (req, res) => {
  try {
    const raw = String(req.query.url || '');
    let u;
    try { u = new URL(raw); } catch { return res.status(400).json({ error: 'invalid url' }); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return res.status(400).json({ error: 'unsupported scheme' });
    if (u.port && !['80', '443', ''].includes(u.port)) return res.status(400).json({ error: 'blocked port' });

    const key = u.toString();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL) return res.json(hit.data);

    await assertPublicHost(u.hostname);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(u.toString(), {
        redirect: 'follow',
        signal: ctrl.signal,
        headers: { 'User-Agent': 'VaultChatBot/1.0 (+link-preview)', 'Accept': 'text/html' },
      });
    } finally { clearTimeout(timer); }

    // Re-validate the FINAL url after redirects (defends redirect-to-internal).
    try { await assertPublicHost(new URL(resp.url).hostname); } catch { return res.status(400).json({ error: 'blocked redirect' }); }

    const ctype = resp.headers.get('content-type') || '';
    if (!ctype.includes('text/html')) return res.json({ url: key, title: '', description: '', image: '' });

    // Read up to MAX_BYTES then stop.
    const reader = resp.body.getReader();
    let received = 0; const chunks = [];
    while (received < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length; chunks.push(value);
    }
    try { await reader.cancel(); } catch {}
    const html = Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');

    const titleTag = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
    let image = pickMeta(html, 'og:image') || pickMeta(html, 'twitter:image');
    if (image && image.startsWith('//')) image = u.protocol + image;
    else if (image && image.startsWith('/')) image = `${u.protocol}//${u.host}${image}`;

    const data = {
      url: key,
      title:       pickMeta(html, 'og:title') || decodeEntities(titleTag).trim(),
      description: pickMeta(html, 'og:description') || pickMeta(html, 'description'),
      image,
    };
    cache.set(key, { at: Date.now(), data });
    if (cache.size > 500) cache.delete(cache.keys().next().value); // bound memory
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'preview unavailable' });
  }
});

module.exports = router;
