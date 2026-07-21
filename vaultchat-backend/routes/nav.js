// routes/nav.js — routing proxy to the self-hosted Valhalla engine.
//
// The app never talks to Valhalla directly: it POSTs here (authenticated,
// rate-limited) and we forward to the INTERNAL Valhalla service (never exposed
// publicly). Content-free — just two coordinates + a costing mode; no user data
// is stored. VALHALLA_URL points at the compose service (http://valhalla:8002).

const express = require('express');
const jwtUtil = require('../jwt');
const rateLimit = require('../rateLimit');

const router = express.Router();
router.use(jwtUtil.requireAuth);

const VALHALLA_URL = process.env.VALHALLA_URL || 'http://valhalla:8002';
const COSTINGS = ['auto', 'motorcycle', 'bicycle', 'pedestrian', 'truck'];
const num = (v) => typeof v === 'number' && Number.isFinite(v);

// POST /nav/route  { from:{lat,lng}, to:{lat,lng}, costing } → Valhalla trip
router.post('/route', async (req, res) => {
  try {
    const rl = await rateLimit.consume(`navroute:${req.user.id}`, 60, 60);
    if (!rl.allowed) return res.status(429).json({ error: 'Too many route requests', retryAfter: rl.resetInSec });

    const { from, to } = req.body || {};
    const costing = COSTINGS.includes(req.body?.costing) ? req.body.costing : 'auto';
    if (!from || !to || !num(from.lat) || !num(from.lng) || !num(to.lat) || !num(to.lng)) {
      return res.status(400).json({ error: 'from{lat,lng} + to{lat,lng} required' });
    }

    const body = {
      locations: [{ lat: from.lat, lon: from.lng }, { lat: to.lat, lon: to.lng }],
      costing,
      directions_options: { units: 'kilometers' },
    };
    const r = await fetch(`${VALHALLA_URL}/route`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return res.status(502).json({ error: 'routing engine error', detail: t.slice(0, 200) });
    }
    res.json(await r.json());
  } catch (e) {
    const offline = e.name === 'TimeoutError' || /fetch failed|ECONNREFUSED/.test(e.message || '');
    console.error('[nav/route]', e.message);
    res.status(offline ? 503 : 500).json({ error: offline ? 'routing engine unavailable' : 'route failed' });
  }
});

module.exports = router;
