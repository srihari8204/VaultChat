const path = require("path");
const { getSentryExpoConfig } = require("@sentry/react-native/metro");
const config = getSentryExpoConfig(__dirname);
config.resolver.unstable_enablePackageExports = true;

// ─── Redirect @react-native-firebase/* to JS SDK shims ─────────────
const shimDir = path.resolve(__dirname, "shims");
const firebaseShims = {
  "@react-native-firebase/app": path.join(shimDir, "firebase-app.js"),
  "@react-native-firebase/auth": path.join(shimDir, "firebase-auth.js"),
  "@react-native-firebase/firestore": path.join(shimDir, "firebase-firestore.js"),
  "@react-native-firebase/storage": path.join(shimDir, "firebase-storage.js"),
};

// ─── Redirect react-native-webrtc to web shim on web platform ────
const webOnlyShims = {
  "react-native-webrtc": path.join(shimDir, "react-native-webrtc.js"),
};

const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (firebaseShims[moduleName]) {
    return {
      filePath: firebaseShims[moduleName],
      type: "sourceFile",
    };
  }
  // On web, redirect native-only modules to web shims
  if (platform === "web" && webOnlyShims[moduleName]) {
    return {
      filePath: webOnlyShims[moduleName],
      type: "sourceFile",
    };
  }
  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
