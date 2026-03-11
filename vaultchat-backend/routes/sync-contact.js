const express = require('express');
const router  = express.Router();

const syncStore = new Map();

function gen6Code() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// POST /api/sync-contact/create
// Body: { uid, displayName, phoneNumber?, email?, avatarUrl? }
router.post('/create', (req, res) => {
  const { uid, displayName, phoneNumber, email, avatarUrl } = req.body;
  if (!uid || !displayName) {
    return res.status(400).json({ error: 'uid and displayName required' });
  }

  const code      = gen6Code();
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

  syncStore.set(code, {
    code,
    initiator: {
      uid,
      displayName,
      phoneNumber: phoneNumber || null,
      email:       email       || null,
      avatarUrl:   avatarUrl   || null,
    },
    responder: null,
    verified:  false,
    createdAt: Date.now(),
    expiresAt,
  });

  // Auto-delete after 5 minutes
  setTimeout(() => syncStore.delete(code), 5 * 60 * 1000 + 1000);

  res.json({ success: true, code, expiresAt });
});

// GET /api/sync-contact/:code
router.get('/:code', (req, res) => {
  const record = syncStore.get(req.params.code);
  if (!record) return res.status(404).json({ error: 'Code not found or expired' });
  if (Date.now() > record.expiresAt) {
    syncStore.delete(req.params.code);
    return res.status(410).json({ error: 'Code expired' });
  }
  res.json({
    success:       true,
    initiatorName: record.initiator.displayName,
    verified:      record.verified,
    expiresAt:     record.expiresAt,
  });
});

// POST /api/sync-contact/verify
// Body: { code, uid, displayName, phoneNumber?, email? }
router.post('/verify', (req, res) => {
  const { code, uid, displayName, phoneNumber, email, avatarUrl } = req.body;
  if (!code || !uid || !displayName) {
    return res.status(400).json({ error: 'code, uid, displayName required' });
  }

  const record = syncStore.get(code);
  if (!record)                        return res.status(404).json({ error: 'Code not found or expired' });
  if (Date.now() > record.expiresAt) { syncStore.delete(code); return res.status(410).json({ error: 'Code expired' }); }
  if (record.verified)                return res.status(409).json({ error: 'Code already used' });
  if (record.initiator.uid === uid)   return res.status(400).json({ error: 'Cannot verify your own code' });

  record.responder = { uid, displayName, phoneNumber: phoneNumber || null, email: email || null, avatarUrl: avatarUrl || null };
  record.verified  = true;

  // Clean up after 30 seconds
  setTimeout(() => syncStore.delete(code), 30000);

  res.json({
    success:   true,
    initiator: record.initiator,
    responder: record.responder,
    message:   'Contact synced! Both users can now save each other.',
  });
});

module.exports = router;
