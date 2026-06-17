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
import { getAccessToken } from "../lib/api";

export default function IndexScreen() {
  useEffect(() => {
    (async () => {
      try {
        const token = await getAccessToken();
        router.replace((token ? "/(tabs)/chats" : "/onboard") as any);
      } catch {
        router.replace("/onboard" as any);
      }
    })();
  }, []);

  return (
    <View style={S.bg}>
      <ActivityIndicator color="#4A9FFF" size="large" />
    </View>
  );
}

const S = StyleSheet.create({
  bg: { flex: 1, backgroundColor: "#FFFFFF", justifyContent: "center", alignItems: "center" },
});
