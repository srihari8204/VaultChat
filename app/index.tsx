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
import { ImageBackground, StyleSheet } from "react-native";
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
        if (await shouldCheckRestore()) { router.replace("/restore-backup" as any); return; }

        router.replace("/(tabs)/chats" as any);
      } catch {
        router.replace("/onboard" as any);
      }
    })();
  }, []);

  // Fallback UI, only visible if the splash was already hidden. It is the same
  // splash artwork on the same background colour, so the hand-off from the
  // native splash is seamless instead of a spinner flash.
  return (
    <ImageBackground
      source={require("../assets/images/splash.png")}
      style={S.bg}
      resizeMode="cover"
    />
  );
}

const S = StyleSheet.create({
  bg: { flex: 1, backgroundColor: "#010527" },
});
