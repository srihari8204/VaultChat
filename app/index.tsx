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
import { ActivityIndicator, StyleSheet, View } from "react-native";
import * as SplashScreen from "expo-splash-screen";
import { getAccessToken } from "../lib/api";
import { isMfaEnabled } from "../lib/mfa";

export default function IndexScreen() {
  useEffect(() => {
    (async () => {
      try {
        // Read the token and the MFA flag in parallel (both are SecureStore reads)
        // so the launch decision costs one round-trip, not two serial ones.
        const [token, mfaOn] = await Promise.all([getAccessToken(), isMfaEnabled()]);
        if (!token) { router.replace("/onboard" as any); return; }
        // Logged in → if device MFA is on, gate the launch (biometric or MPIN).
        router.replace((mfaOn ? "/app-lock" : "/(tabs)/chats") as any);
      } catch {
        router.replace("/onboard" as any);
      } finally {
        // Reveal the target screen. The native splash covered the security scan +
        // token read + redirect, so the user goes splash → chats with no spinner
        // flash in between (WhatsApp-style instant open).
        SplashScreen.hideAsync().catch(() => {});
      }
    })();
  }, []);

  // Fallback UI, only visible if the splash was already hidden. Uses the app's
  // dark base (not white) so there is never a light flash before chats/onboard.
  return (
    <View style={S.bg}>
      <ActivityIndicator color="#4A9FFF" size="large" />
    </View>
  );
}

const S = StyleSheet.create({
  bg: { flex: 1, backgroundColor: "#0A0A0F", justifyContent: "center", alignItems: "center" },
});
