
// Add these routes to vaultchat-backend/server.js
// Paste before app.listen(...)

// Phone hash registration (called at signup)
const phoneHashMap = new Map(); // hash → vaultId

app.post('/api/contacts/register-phone', (req, res) => {
  const { vaultId, phoneHash } = req.body;
  if (!vaultId || !phoneHash) return res.status(400).json({ error: 'Missing' });
  phoneHashMap.set(phoneHash, vaultId);
  res.json({ success: true });
});

// Match hashes → return VaultIDs + profile info
app.post('/api/contacts/match', (req, res) => {
  const { myVaultId, phoneHashes: hashes } = req.body;
  if (!Array.isArray(hashes)) return res.status(400).json({ error: 'Invalid' });

  const matched = hashes
    .filter(h => phoneHashMap.has(h) && phoneHashMap.get(h) !== myVaultId)
    .map(h => {
      const vid  = phoneHashMap.get(h);
      const user = users.get(vid) || {};
      return {
        phoneHash:   h,
        vaultId:     vid,
        vaultName:   user.displayName || vid,
        vaultAvatar: user.photoUri    || null,
        online:      user.online      || false,
        lastSeen:    user.lastSeen    || null,
        status:      user.status      || null,
      };
    });

  res.json(matched);
});

// Incoming message from unknown sender → store as request
app.post('/api/contacts/message-request', (req, res) => {
  const { fromVaultId, toVaultId, message } = req.body;
  const toSocket = [...io.sockets.sockets.values()]
    .find(s => s.data?.vaultId === toVaultId);
  if (toSocket) {
    toSocket.emit('message_request', { fromVaultId, message, ts: Date.now() });
  }
  res.json({ success: true });
});
