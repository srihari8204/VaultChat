const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');

const locationStore = new Map();

// POST /api/location/share
// Body: { uid, mode, durationMinutes, lat, lng, address }
router.post('/share', (req, res) => {
  const { uid, mode, durationMinutes, lat, lng, address } = req.body;
  if (!uid || !lat || !lng) {
    return res.status(400).json({ error: 'uid, lat, lng required' });
  }

  const id        = uuidv4();
  const expiresAt = mode === 'current' && durationMinutes > 0
    ? Date.now() + durationMinutes * 60 * 1000
    : null;

  const session = {
    id, uid, mode,
    lat:       parseFloat(lat),
    lng:       parseFloat(lng),
    address:   address || 'Unknown location',
    createdAt: Date.now(),
    expiresAt,
    active:    true,
    updatedAt: Date.now(),
  };
  locationStore.set(id, session);

  if (expiresAt) {
    setTimeout(() => {
      const s = locationStore.get(id);
      if (s) s.active = false;
    }, durationMinutes * 60 * 1000);
  }

  res.json({ success: true, id, session });
});

// PUT /api/location/update/:id
// Body: { lat, lng, address }
router.put('/update/:id', (req, res) => {
  const session = locationStore.get(req.params.id);
  if (!session)        return res.status(404).json({ error: 'Session not found' });
  if (!session.active) return res.status(410).json({ error: 'Session ended' });

  const { lat, lng, address } = req.body;
  if (lat) session.lat    = parseFloat(lat);
  if (lng) session.lng    = parseFloat(lng);
  if (address) session.address = address;
  session.updatedAt = Date.now();

  res.json({ success: true });
});

// GET /api/location/:id
router.get('/:id', (req, res) => {
  const session = locationStore.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  if (session.expiresAt && Date.now() > session.expiresAt) {
    session.active = false;
  }

  res.json({ success: true, session });
});

// DELETE /api/location/:id
router.delete('/:id', (req, res) => {
  const session = locationStore.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.active = false;
  res.json({ success: true });
});

module.exports = router;
