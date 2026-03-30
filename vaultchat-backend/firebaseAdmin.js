// firebaseAdmin.js
// Initialize Firebase Admin SDK once, shared by all routes

const admin = require('firebase-admin');

if (!admin.apps.length) {
  // Option 1: Use service account key file (for local dev)
  // Download from: Firebase Console → Project Settings → Service Accounts → Generate New Key
  // Save as: vaultchat-backend/serviceAccountKey.json
  const path = require('path');
  const fs = require('fs');
  const keyPath = path.join(__dirname, 'serviceAccountKey.json');

  if (fs.existsSync(keyPath)) {
    const serviceAccount = require(keyPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: 'vaultchat-ce9e3',
    });
  } else {
    // Option 2: Use project ID only (for Render.com with GOOGLE_APPLICATION_CREDENTIALS env var)
    admin.initializeApp({
      projectId: 'vaultchat-ce9e3',
    });
    console.warn('[Firebase Admin] No serviceAccountKey.json found.');
    console.warn('[Firebase Admin] Download from: Firebase Console → Project Settings → Service Accounts → Generate New Key');
    console.warn('[Firebase Admin] Save as: vaultchat-backend/serviceAccountKey.json');
  }
}

module.exports = admin;
