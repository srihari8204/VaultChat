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
import * as SplashScreen from "expo-splash-screen";
import { hasSession, sealedSessionLocked } from "../lib/api";
import { isMfaEnabled } from "../lib/mfa";
import { shouldOfferRestore } from "../lib/restoreGate";

export default function IndexScreen() {
  useEffect(() => {
    (async () => {
      try {
        // Read the token and the MFA flag in parallel (both are SecureStore reads)
        // so the launch decision costs one round-trip, not two serial ones.
        // hasSession() — NOT getAccessToken(). Identical today (both answer
        // "is there a plaintext token in SecureStore"), but under
        // VAULT_SESSION_SEALED the tokens live in a sealed blob and
        // getAccessToken() answers null until the PIN unseals them — which
        // would route a signed-in user to /onboard, i.e. a silent logout.
        const [signedIn, mfaOn, sealed] = await Promise.all([
          hasSession(), isMfaEnabled(), sealedSessionLocked(),
        ]);
        if (!signedIn) { router.replace("/onboard" as any); return; }
        // Logged in → if device MFA is on, gate the launch (biometric or MPIN).
        //
        // ALSO gate when the session is SEALED and still locked (#32), MFA flag
        // or not: the tokens only exist inside a blob the PIN opens, so landing
        // on /chats would mean an authenticated shell with no credentials and
        // no way to ask for them. app-lock detects the sealed case and asks for
        // the local PIN instead of the biometric/remote-MPIN path.
        if (mfaOn || sealed) { router.replace("/app-lock" as any); return; }

        // NEW PHONE? OFFER THE BACKUP BEFORE THE EMPTY CHAT LIST.
        //
        // Everything needed to restore already existed — this was the missing
        // moment. Without it, replacing a handset meant landing on an empty
        // chat list and either knowing about a settings screen in advance or
        // losing the history for good.
        //
        // Fires only when signed in AND this device holds no messages AND a
        // server backup exists AND we have not asked before (lib/restoreGate).
        // Any failure answers false, so this can never block the launch path.
        if (await shouldOfferRestore()) { router.replace("/restore-backup" as any); return; }

        router.replace("/(tabs)/chats" as any);
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
