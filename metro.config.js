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

// ─── Inline requires (cold start) ────────────────────────────────
// @expo/metro-config ships `inlineRequires: false` (ExpoMetroConfig.js), so
// every top-level import in a module is evaluated the moment that module is
// first required. app/_layout.tsx imports ~12 services at module scope, which
// means all of them parse and run before the first frame. With inlining, a
// require moves to its first USE site, so a service that is only touched on a
// later screen no longer costs anything at boot.
//
// `experimentalImportSupport` must stay true — it is Expo's default and the
// two are set together; dropping it here would silently change ESM semantics.
config.transformer.getTransformOptions = async () => ({
  transform: {
    experimentalImportSupport: true,
    inlineRequires: true,
  },
});

// ─── Do not WATCH the Rust build output ──────────────────────────
// Metro crashed on startup with
//   ENOENT: no such file or directory, watch '...\rust\target\...\deps\rmeta7KChbg'
// whenever a Gradle build was running at the same time. There are four cargo
// target trees under services/ (crypto, nav, transport/rust-net, vaultbeam),
// and cargo writes and deletes thousands of short-lived intermediates in them.
// Metro's directory walker stats a file, then opens a watch on it a moment
// later; on Windows the FallbackWatcher has no way to survive the file having
// vanished in between, so the whole dev server exits.
//
// Nothing here is ever imported by JS — the Rust reaches the app as a prebuilt
// .so through Gradle, never through the bundler — so excluding it costs
// nothing and removes the race entirely. Matches both separators because this
// is read on Windows and CI alike.
const rustTargets = /[\\/]services[\\/][^\\/]+[\\/]rust[^\\/]*[\\/]target[\\/]/;
config.resolver.blockList = config.resolver.blockList
  ? [].concat(config.resolver.blockList, rustTargets)
  : rustTargets;

module.exports = config;
