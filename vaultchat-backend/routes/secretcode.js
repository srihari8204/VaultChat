const express = require("express");
const router  = express.Router();
const admin   = require("firebase-admin");
const db      = admin.firestore();

router.post("/save", async (req, res) => {
  try {
    const { uid, phone, codeHash } = req.body;
    if (!uid || !phone || !codeHash) return res.status(400).json({ error: "Missing fields" });
    await db.collection("users").doc(uid).set({
      secretCodeHash: codeHash,
      phone: phone,
      codeCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/verify", async (req, res) => {
  try {
    const { uid, codeHash } = req.body;
    if (!uid || !codeHash) return res.status(400).json({ error: "Missing fields" });
    const doc = await db.collection("users").doc(uid).get();
    if (!doc.exists) return res.status(404).json({ error: "User not found" });
    const data = doc.data();
    const fails = data.codeFailCount || 0;
    const lockedUntil = data.codeLockedUntil?.toDate?.() || null;
    if (lockedUntil && new Date() < lockedUntil) {
      return res.json({ success: false, locked: true, lockedUntil });
    }
    const match = data.secretCodeHash === codeHash;
    if (match) {
      await db.collection("users").doc(uid).update({ codeFailCount: 0, codeLockedUntil: null });
      res.json({ success: true });
    } else {
      const newFails = fails + 1;
      const lockData = newFails >= 3 ? { codeLockedUntil: new Date(Date.now() + 30 * 60 * 1000) } : {};
      await db.collection("users").doc(uid).update({ codeFailCount: newFails, ...lockData });
      res.json({ success: false, attemptsLeft: Math.max(0, 3 - newFails) });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/regenerate", async (req, res) => {
  try {
    const { uid, codeHash } = req.body;
    if (!uid || !codeHash) return res.status(400).json({ error: "Missing fields" });
    await db.collection("users").doc(uid).update({ secretCodeHash: codeHash, codeCreatedAt: admin.firestore.FieldValue.serverTimestamp(), codeFailCount: 0, codeLockedUntil: null });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
