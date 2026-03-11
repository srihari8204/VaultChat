import { router } from "expo-router";
import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { shouldLock } from "../services/lockService";

const SERVER_URL = "http://192.168.29.58:3001";

export default function IndexScreen() {
  useEffect(() => {
    (async () => {
      try {
        const { isSetupComplete } = await import("../services/securityService");
        const setup = await isSetupComplete();
        if (!setup) { router.replace("/welcome"); return; }

        const { getCurrentUser } = await import("./(constants)/authService");
        const user = getCurrentUser();
        if (!user) { router.replace("/welcome"); return; }

        const { isKnownDevice } = await import("../services/deviceService");
        const known = await isKnownDevice(user.uid, SERVER_URL);
        if (!known) { router.replace("/phone"); return; }

        // Always show lock on every open
        router.replace("/lock");
      } catch {
        router.replace("/welcome");
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
  bg: { flex:1, backgroundColor:"#010812", justifyContent:"center", alignItems:"center" },
});
