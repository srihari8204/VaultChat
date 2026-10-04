// Cold-start router for a launch that opened on "/" (no deep link).
//
// The root layout (app/_layout.tsx) owns the auth decision and redirects
// signed-out or locked launches itself. This screen waits for that decision
// (lib/launchGate) and, only when the launch is allowed through, picks the
// first screen: the restore offer on a new phone, otherwise Chats — with any
// notification tap that arrived meanwhile opened on top (lib/pendingLink).

import { type Href, router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, StyleSheet, TouchableOpacity, View } from "react-native";
import { AppText as Text } from "../components/ui/Text";
import { AuroraDark, BRAND_NIGHT } from "../constants/theme";
import { launchAllowed } from "../lib/launchGate";
import { consumeLaunchLink, markLaunchRouted } from "../lib/pendingLink";
import { shouldCheckRestore } from "../lib/restoreGate";
import { securityVerdict } from "../lib/securityVerdict";

export default function IndexScreen() {
  const [failed, setFailed] = useState(false);
  // Shown only if this fallback is still up after the native splash would
  // normally have handed over, so a quick launch never flashes a spinner.
  const [slow, setSlow] = useState(false);
  useEffect(() => { const id = setTimeout(() => setSlow(true), 1500); return () => clearTimeout(id); }, []);
  // One routing run at a time: a double tap on Retry ran two replaces and
  // could push a held link twice. Released only by a failure.
  const inFlight = useRef(false);

  const route = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFailed(false);
    try {
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
      // The launch scan found a threat and is routing to /blocked: don't race it.
      if (securityVerdict()) return;

      // NEW PHONE? OFFER THE BACKUP BEFORE THE EMPTY CHAT LIST. The local
      // check is one indexed SQLite row; the restore screen does the network
      // lookup. A failed check skips the offer rather than holding the splash.
      // Any held tap stays in lib/pendingLink: restore-backup's resetTo
      // replays it on the way into the tabs.
      if (await shouldCheckRestore().catch(() => false)) {
        router.replace("/restore-backup");
        markLaunchRouted();
        return;
      }

      // A notification tap that arrived while this splash was up was HELD
      // (lib/pendingLink.openWhenUnlocked): pushed first, it would have been
      // overwritten by the replace below. Open it on top of Chats instead, so
      // BACK from it lands on the list.
      // Synchronous from here on, so no tap can slip between the mark that
      // lets later taps open directly and the consume of the held one.
      router.replace("/(tabs)/chats");
      markLaunchRouted();
      const held = consumeLaunchLink();
      if (held) router.push(held as Href);
    } catch (e) {
      // No silent splash: a throw here used to leave the user on the logo with
      // nothing to press. Offer a retry.
      console.warn('[index] launch routing failed', e);
      inFlight.current = false;
      setFailed(true);
    }
  }, []);

  useEffect(() => { void route(); }, [route]);

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
      {slow && !failed && (
        <ActivityIndicator style={S.wait} color={AuroraDark.accentOn} accessibilityLabel="Opening crazzychat" />
      )}
      {failed && (
        <TouchableOpacity
          style={S.retry}
          onPress={() => { void route(); }}
          accessibilityRole="button"
          accessibilityLabel="Couldn't open the app. Try again"
        >
          <Text style={S.retryTxt}>Couldn’t open the app — Try again</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const S = StyleSheet.create({
  // BRAND_NIGHT is app.json's splash backgroundColor; this view must match the
  // native splash in both themes, so it is not a theme token.
  bg: { flex: 1, backgroundColor: BRAND_NIGHT, alignItems: "center", justifyContent: "center" },
  // 200 and contain are app.json's expo-splash-screen values, verbatim.
  mark: { width: 200, height: 200 },
  // Always on the night ground, so the dark palette's ink, not the theme's.
  wait: { marginTop: 32 },
  retry: { marginTop: 32, minHeight: 44, paddingHorizontal: 20, justifyContent: "center" },
  retryTxt: { color: AuroraDark.accentOn, fontSize: 15, fontWeight: "700", textAlign: "center" },
});
