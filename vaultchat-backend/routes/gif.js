// vaultchat-backend/routes/gif.js
//
// GIF search proxy (GIPHY). Keeps the API key server-side (env GIPHY_KEY) and
// normalises the response so the client stays dumb. Auth-required; short
// in-memory cache.
//
// NOTE: we moved off Tenor — Google sunset the Tenor API (no new keys after
// 2026-01-13, fully decommissioned 2026-06-30). GIPHY still issues free
// developer keys: https://developers.giphy.com → Create an App → API Key.
// Set GIPHY_KEY in the backend env. There is NO public fallback key (GIPHY's
// old beta key is banned), so without GIPHY_KEY the picker returns empty +
// a not_configured flag.

const express = require('express');
const jwtUtil = require('../jwt');

const router = express.Router();
router.use(jwtUtil.requireAuth);

const GIPHY_KEY = process.env.GIPHY_KEY || '';
const TIMEOUT_MS = 6000;
const CACHE_TTL  = 5 * 60 * 1000;
const cache = new Map(); // key -> { at, data }

function normalize(json) {
  return (json.data || []).map(g => {
    const im = g.images || {};
    const fw = im.fixed_width || {};
    const dn = im.downsized || {};
    const sm = im.fixed_width_small || im.preview_gif || {};
    const orig = im.original || {};
    return {
      id:      String(g.id),
      url:     fw.url || dn.url || orig.url || '',   // animated gif to render
      gif:     dn.url || fw.url || orig.url || '',   // sendable animated gif
      preview: sm.url || fw.url || '',               // lightweight grid thumbnail
      width:   parseInt(fw.width, 10)  || 200,
      height:  parseInt(fw.height, 10) || 200,
    };
  }).filter(g => g.url || g.gif);
}

async function giphy(path, params) {
  const qs = new URLSearchParams({ api_key: GIPHY_KEY, rating: 'pg-13', ...params });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`https://api.giphy.com/v1/gifs/${path}?${qs}`, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`giphy ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// GET /gif/search?q=&pos=   (q empty → trending; pos = pagination offset)
router.get('/search', async (req, res) => {
  try {
    if (!GIPHY_KEY) return res.json({ results: [], next: '', error: 'not_configured' });

    const q      = String(req.query.q || '').slice(0, 100);
    const offset = String(parseInt(req.query.pos, 10) || 0);
    const key    = `${q}|${offset}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL) return res.json(hit.data);

    const json = q
      ? await giphy('search',   { q, limit: '24', offset, bundle: 'messaging_non_clips' })
      : await giphy('trending', { limit: '24', offset });

    const pag = json.pagination || {};
    const data = { results: normalize(json), next: String((pag.offset || 0) + (pag.count || 0)) };
    cache.set(key, { at: Date.now(), data });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    res.json(data);
  } catch (err) {
    console.error('[gif search]', err.message);
    res.status(502).json({ error: 'gif search unavailable', results: [] });
  }
});

module.exports = router;
