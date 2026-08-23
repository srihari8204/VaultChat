const path = require("path");
const { getSentryExpoConfig } = require("@sentry/react-native/metro");
const config = getSentryExpoConfig(__dirname);
config.resolver.unstable_enablePackageExports = true;

// The @react-native-firebase/* -> JS-SDK shim redirect that used to live here
// is gone with the packages: nothing imported those modules, so the shims were
// never resolved and the firebase JS SDK was never bundled.
//
// Native FCM is unaffected and MUST stay: the messaging library comes from
// plugins/withVaultChatCalls.js (implementation "com.google.firebase:firebase-messaging"),
// and the google-services Gradle plugin + google-services.json come from Expo's
// own default prebuild chain via app.json's android.googleServicesFile. Neither
// goes through @react-native-firebase.
// ─── SVG as components (react-native-svg-transformer) ────────────
// Brand marks ship as vectors so they stay crisp at any size and cannot be
// silently mis-scaled by a style box that disagrees with a raster's aspect
// ratio — which is exactly how the KLIPY watermark ended up drawing at 40px.
//
// The three lines are a set: svg has to LEAVE assetExts (or Metro keeps
// treating it as an image and `require` returns a URI) and JOIN sourceExts (so
// the transformer compiles it to a component). Doing one without the other
// fails at runtime, not at build time.
//
// Uses the "/expo" entry point, which is the variant that understands Expo's
// asset plugin chain — the bare one drops Expo's own transforms.
config.transformer.babelTransformerPath = require.resolve(
  "react-native-svg-transformer/expo",
);
config.resolver.assetExts = config.resolver.assetExts.filter((e) => e !== "svg");
config.resolver.sourceExts = [...config.resolver.sourceExts, "svg"];

const shimDir = path.resolve(__dirname, "shims");

// ─── Redirect the native WebRTC module to a web shim on web ──────
// The key must match what source files IMPORT. That is now the LiveKit fork
// (@livekit/react-native-webrtc) — a drop-in replacement for react-native-webrtc
// that ships the frame cryptor the SFU work needs; see docs/SFU_SPIKE.md. The
// shim itself is unchanged: on web these are browser-native APIs, which have no
// idea which native package the app would have used.
const webOnlyShims = {
  "@livekit/react-native-webrtc": path.join(shimDir, "react-native-webrtc.js"),
};

const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
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
