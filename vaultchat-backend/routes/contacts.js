// routes/contacts.js
// POST /api/contacts/match
// Receives array of phone hashes, returns matching VaultChat users
// Phone numbers are NEVER sent raw — SHA-256 hashed only

const express = require("express");
const admin   = require("firebase-admin");
const router  = express.Router();

// POST /api/contacts/match
// Body: { myVaultId: string, phoneHashes: string[] }
// Returns: [{ phoneHash, vaultId, vaultName, vaultAvatar, online, lastSeen, status }]
router.post("/match", async (req, res) => {
  try {
    const { myVaultId, phoneHashes } = req.body;

    if (!phoneHashes || !Array.isArray(phoneHashes) || phoneHashes.length === 0) {
      return res.status(400).json({ error: "phoneHashes array required" });
    }

    const db = admin.firestore();
    const matched = [];

    // Firestore "in" queries support max 30 items per batch
    const batchSize = 30;
    for (let i = 0; i < phoneHashes.length; i += batchSize) {
      const batch = phoneHashes.slice(i, i + batchSize);
      const snap = await db.collection("users")
        .where("phoneHash", "in", batch)
        .get();

      for (const doc of snap.docs) {
        const d = doc.data();
        // Skip yourself
        if (d.vaultId === myVaultId) continue;

        matched.push({
          phoneHash:   d.phoneHash,
          vaultId:     d.vaultId || doc.id,
          vaultName:   d.name || d.displayName || "VaultChat User",
          vaultAvatar: d.photoURL || null,
          online:      d.online || false,
          lastSeen:    d.lastSeen ? d.lastSeen.toMillis?.() || d.lastSeen : null,
          status:      d.status || null,
        });
      }
    }

    console.log("[contacts/match]", phoneHashes.length, "hashes ->", matched.length, "matches");
    res.json(matched);

  } catch (err) {
    console.error("[contacts/match] Error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;