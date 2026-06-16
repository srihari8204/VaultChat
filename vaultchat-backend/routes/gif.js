// vaultchat-backend/routes/gif.js
//
// GIF search proxy (Tenor). Keeps the API key server-side (env TENOR_KEY) instead
// of shipping a shared public demo key in the app bundle, and normalises the
// response so the client stays dumb. Auth-required; short in-memory cache.
//
// Set TENOR_KEY in the backend env to your own free key (tenor.com/developer).
// Falls back to Google's public test key so it still works out of the box.

const express = require('express');
const jwtUtil = require('../jwt');

const router = express.Router();
router.use(jwtUtil.requireAuth);

const TENOR_KEY = process.env.TENOR_KEY || 'AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCPY';
const TIMEOUT_MS = 5000;
const CACHE_TTL  = 5 * 60 * 1000;
const cache = new Map(); // key -> { at, data }

function normalize(json) {
  return (json.results || []).map(r => {
    const mf = r.media_formats || {};
    const gif = mf.tinygif || mf.gif || {};
    const mp4 = mf.tinymp4 || mf.mp4 || {};
    return {
      id:      String(r.id),
      url:     (mp4.url || gif.url || ''),     // playback (mp4 preferred — smaller/smoother)
      gif:     (gif.url || ''),                // animated gif fallback
      preview: (mf.nanogif?.url || gif.url || ''),
      width:   (gif.dims && gif.dims[0]) || 200,
      height:  (gif.dims && gif.dims[1]) || 200,
    };
  }).filter(g => g.url || g.gif);
}

async function tenor(path, params) {
  const qs = new URLSearchParams({ key: TENOR_KEY, client_key: 'vaultchat', media_filter: 'tinygif,gif,tinymp4,mp4,nanogif', ...params });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`https://tenor.googleapis.com/v2/${path}?${qs}`, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`tenor ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// GET /gif/search?q=&pos=   (q empty → featured/trending)
router.get('/search', async (req, res) => {
  try {
    const q   = String(req.query.q || '').slice(0, 100);
    const pos = String(req.query.pos || '');
    const key = `${q}|${pos}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL) return res.json(hit.data);

    const json = q
      ? await tenor('search',   { q, limit: '24', pos })
      : await tenor('featured', { limit: '24', pos });
    const data = { results: normalize(json), next: json.next || '' };
    cache.set(key, { at: Date.now(), data });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    res.json(data);
  } catch (err) {
    console.error('[gif search]', err.message);
    res.status(502).json({ error: 'gif search unavailable', results: [] });
  }
});

module.exports = router;
