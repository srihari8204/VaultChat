const express = require("express");
const router  = express.Router();
const admin   = require("firebase-admin");

const db = admin.firestore();
const MATCH_THRESHOLD = 0.82;

// Cosine similarity
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// POST /api/face/register
// Called during onboarding to store encrypted face template
router.post("/register", async (req, res) => {
  try {
    const { uid, encryptedTemplate, deviceId } = req.body;
    if (!uid || !encryptedTemplate || !deviceId) {
      return res.status(400).json({ error: "Missing fields" });
    }
    await db.collection("users").doc(uid).set({
      faceTemplate:    encryptedTemplate,
      templateVersion: 1,
      updatedAt:       admin.firestore.FieldValue.serverTimestamp(),
      trustedDevices:  admin.firestore.FieldValue.arrayUnion(deviceId),
    }, { merge: true });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/face/verify
// Called on new device login — compare face vectors
router.post("/verify", async (req, res) => {
  try {
    const { uid, faceVector } = req.body;
    if (!uid || !faceVector) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const doc = await db.collection("users").doc(uid).get();
    if (!doc.exists) return res.status(404).json({ error: "User not found" });

    const stored = doc.data();

    // Check failed attempts
    const fails = stored.failedFaceAttempts || 0;
    const lockedUntil = stored.faceLockedUntil?.toDate?.() || null;
    if (lockedUntil && new Date() < lockedUntil) {
      return res.json({ match: false, locked: true, lockedUntil });
    }

    // NOTE: In production, server receives transformed vector (PIN-transformed)
    // and compares to stored transformed template
    // For now: direct vector comparison (replace with decryption in production)
    const storedVector = JSON.parse(stored.faceTemplate || "[]");

    if (!storedVector.length) {
      // No template stored yet — first time, auto-trust
      return res.json({ match: true, firstTime: true });
    }

    const score = cosineSimilarity(faceVector, storedVector);
    const match = score >= MATCH_THRESHOLD;

    if (match) {
      // Reset failed attempts
      await db.collection("users").doc(uid).update({
        failedFaceAttempts: 0,
        faceLockedUntil: null,
        lastVerified: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      // Increment failed attempts
      const newFails = fails + 1;
      const lockData = newFails >= 3
        ? { faceLockedUntil: new Date(Date.now() + 30 * 60 * 1000) }
        : {};
      await db.collection("users").doc(uid).update({
        failedFaceAttempts: newFails,
        ...lockData,
      });
    }

    res.json({ match, score: Math.round(score * 100) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/face/check-device
// Returns whether device is in trusted list
router.post("/check-device", async (req, res) => {
  try {
    const { uid, deviceId } = req.body;
    const doc = await db.collection("users").doc(uid).get();
    if (!doc.exists) return res.json({ known: false });
    const devices = doc.data().trustedDevices || [];
    res.json({ known: devices.includes(deviceId) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/face/trust-device
// Adds device to trusted list after successful face verify
router.post("/trust-device", async (req, res) => {
  try {
    const { uid, deviceId } = req.body;
    await db.collection("users").doc(uid).update({
      trustedDevices: admin.firestore.FieldValue.arrayUnion(deviceId),
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/face/revoke-all-devices
// Security wipe — removes all trusted devices
router.post("/revoke-all-devices", async (req, res) => {
  try {
    const { uid } = req.body;
    await db.collection("users").doc(uid).update({
      trustedDevices: [],
      failedFaceAttempts: 0,
      faceLockedUntil: null,
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
