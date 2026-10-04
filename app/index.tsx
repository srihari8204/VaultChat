// Cold-start router.
//
// Phase 2 rule: if a JWT exists in SecureStore, the user is signed in →
// land them on /signed-in. Otherwise → /welcome (sign-in / sign-up).
//
// The old Firebase-based path (isSetupComplete → known device → /lock)
// is gone for now and will be re-introduced in Phases 4-7 alongside the
// chats UI it gates.

import { router } from "expo-router";
import { useEffect } from "react";
import { Image, StyleSheet, View } from "react-native";
import { launchAllowed } from "../lib/launchGate";
import { shouldCheckRestore } from "../lib/restoreGate";

export default function IndexScreen() {
  useEffect(() => {
    (async () => {
      try {
        // NEW PHONE? OFFER THE BACKUP BEFORE THE EMPTY CHAT LIST.
        //
        // Everything needed to restore already existed — this was the missing
        // moment. Without it, replacing a handset meant landing on an empty
        // chat list and either knowing about a settings screen in advance or
        // losing the history for good.
        //
        // The local eligibility check is bounded by one indexed SQLite row. The
        // restore screen paints immediately and performs the network lookup, so
        // a dead connection can no longer hold the launch splash for 30 seconds.
        // THE ROOT OWNS THE LAUNCH DECISION (app/_layout.tsx).
        //
        // This screen used to race it: both replaced the route after their own
        // async work, and whichever finished last won. When this one won, a
        // launch the root had sent to /app-lock was overwritten — which both
        // SKIPPED THE MFA / SEALED-SESSION GATE and wedged the root's veil up
        // for good, because launchGate '/app-lock' can never equal pathname
        // '/(tabs)/chats' and the splash is only hidden when they match.
        //
        // Wait for the root instead. `false` means it has already replaced the
        // route, and there is nothing for this screen to do but stay out of the
        // way. Cannot deadlock: settleLaunchGate is called on every settlement
        // of the root's Promise.all — both redirect branches, the allow branch
        // and the catch — and a Promise.all has no fourth outcome.
        if (!(await launchAllowed)) return;

        if (await shouldCheckRestore()) { router.replace("/restore-backup" as any); return; }

        router.replace("/(tabs)/chats" as any);
      } catch (e) {
        // No fallback redirect: the root already routes a failed gate to
        // /onboard, and a second replace from here is the race this removes.
        // Logged, though: a throw here leaves the splash fallback on screen.
        console.warn('[index] launch routing failed', e);
      }
    })();
  }, []);

  // Fallback UI, only visible if the splash was already hidden.
  //
  // This used to draw assets/images/splash.png full-bleed: 941x1672, 1.5MB -
  // and NOT what the native splash shows. app.json hands expo-splash-screen
  // splash-icon.png at imageWidth 200, contain, on #010628, so the "seamless"
  // fallback was a DIFFERENT picture, and it put a ~6MB bitmap decode on the
  // cold path to the first route. Mirroring the real splash config is both the
  // accurate seam and 1.5MB lighter: splash.png now has no importer at all, so
  // Metro stops bundling it (2026-09-17).
  //
  // splash-icon.png itself was then resized 1024x1024 -> 800x800 (2026-09-18).
  // 800 is the ceiling both consumers can use, not a guess: prebuild-config's
  // withAndroidSplashImages draws the logo at imageWidth * densityMultiplier,
  // so xxxhdpi (4x) asks for exactly 200 * 4 = 800px, and this <Image> is 200dp
  // too. The extra 224px were downscaled away on every device while still
  // costing 107KB in the APK and a 4096x4096 ARGB decode when Android scaled
  // the drawable-mdpi copy up on an xxxhdpi screen. The canvas stays square and
  // the mark keeps the same fraction of it, so nothing moves on screen.
  //
  // app.json's `dark` splash block went at the same time: it pointed at THIS
  // file on THIS background colour, so prebuild wrote five drawable-night-*
  // PNGs that were byte-for-byte identical to the light ones (md5-checked).
  // With no dark config, getAndroidDarkSplashConfig returns null and they are
  // never generated. Dark mode looks the same because it always did.
  return (
    <View style={S.bg}>
      <Image
        source={require("../assets/images/splash-icon.png")}
        style={S.mark}
        resizeMode="contain"
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no"
      />
    </View>
  );
}

const S = StyleSheet.create({
  bg: { flex: 1, backgroundColor: "#010628", alignItems: "center", justifyContent: "center" },
  // 200 and contain are app.json's expo-splash-screen values, verbatim.
  mark: { width: 200, height: 200 },
});
