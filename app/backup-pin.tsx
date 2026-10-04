// app/backup-pin.tsx — set or change the Device PIN (Settings → Device PIN).
//
// The PIN opens the Vault and seals this device's session (services/security/
// pinStore). Changing an existing PIN asks for the current one first: before
// 2026-10-04 anyone holding an unlocked phone could replace it, which also
// re-sealed the session under a PIN the owner did not know.

import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, TouchableOpacity, View } from "react-native";
import { savePIN } from "../services/securityService";
import * as pinStore from "../services/security/pinStore";
import { PIN_MAX, PIN_MIN } from "../services/security/pinFormat";
import { rewrapVaultKeys } from "../lib/vaultKeyStore";
import { AppText as Text, AuthSky, KeyboardSafe } from "../components/ui";
import { PinPad } from "../components/PinPad";
import { type AuthPalette } from '../constants/authTheme';
import { useAuthTheme } from '../lib/useAuthTheme';
import { isWeakPin } from '../lib/weakPin';
import { tint } from '../lib/tintColor';

/** Length of a NEW PIN. Must stay inside pinFormat (pinFormat.selftest checks). */
const NEW_PIN_LENGTH = 6;

type Stage = "loading" | "current" | "set" | "confirm";

export default function BackupPINScreen() {
  const AUTH = useAuthTheme();
  const S = useMemo(() => makeStyles(AUTH), [AUTH]);
  const [stage,setStage] = useState<Stage>("loading");
  const [cur,setCur]     = useState("");
  const [pin,setPin]     = useState("");
  const [confirm,setConfirm] = useState("");
  const [error,setError] = useState("");
  const [busy,setBusy]   = useState(false);
  // The verified current PIN, kept only until the new one is stored: the vault
  // key is re-wrapped from it (lib/vaultKeyStore) so no vault file is orphaned.
  const oldPin = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    pinStore.hasPin()
      .then(h => { if (live) setStage(h ? "current" : "set"); })
      // Unknown is treated as "has one": asking for a PIN that does not exist is
      // recoverable (Back), silently skipping the check is not.
      .catch(() => { if (live) setStage("current"); });
    return () => { live = false; oldPin.current = null; };
  }, []);

  const current = stage==="current"?cur:stage==="set"?pin:confirm;
  const setter  = stage==="current"?setCur:stage==="set"?setPin:setConfirm;

  const leave = () => { if (router.canGoBack()) router.back(); else router.replace("/(tabs)/chats" as any); };

  const checkCurrent = async (val:string) => {
    if (busy || val.length < PIN_MIN) return;
    setBusy(true);
    try {
      if (await pinStore.verifyPin(val)) { oldPin.current = val; setCur(""); setError(""); setStage("set"); return; }
      const wait = await pinStore.pinBackoffMs();
      setError(wait > 0 ? `Too many attempts. Try again in ${Math.ceil(wait / 1000)} s.` : "That is not your current PIN.");
      setCur("");
    } catch {
      setError("Couldn't check your PIN. Try again.");
      setCur("");
    } finally { setBusy(false); }
  };

  // The shared keypad (components/PinPad): typing is ignored while a check or
  // save is running, so a fast thumb cannot queue digits into the next stage.
  const onType = (v: string) => { if (busy) return; setter(v); setError(""); };

  // A forgotten Device PIN cannot be reset from here: it is the key the Vault
  // and the sealed session are wrapped under, and nothing else can re-derive
  // it. Say so, and point at the one real way out (the lock's sign-in again).
  const forgotCurrent = () => Alert.alert(
    'Forgotten your PIN?',
    'Your Device PIN is only on this phone, so it cannot be reset or recovered here. To start over, lock the app and choose "Forgotten your PIN?" there to sign in again — anything kept only on this phone under the old PIN, such as Vault files, is lost.',
    [{ text: 'OK' }],
  );

  const advance = async (val:string) => {
    if (stage==="current"){ await checkCurrent(val); return; }
    if (stage==="set"){
      if (isWeakPin(val, NEW_PIN_LENGTH)) { setError("That PIN is too easy to guess. Choose another."); setPin(""); return; }
      setStage("confirm"); return;
    }
    if (val!==pin){setError("PINs do not match. Try again.");setConfirm("");setStage("set");setPin("");return;}
    setBusy(true);
    const prev = oldPin.current;
    try {
      // Re-wrap the vault key FIRST: if that cannot be written, the PIN is not
      // changed, so the vault key is never left under a PIN that no longer exists.
      if (prev) await rewrapVaultKeys(prev, val);
      try {
        await savePIN(val);   // also seals the session under it (#32) — see pinStore
      } catch (e) {
        if (prev) await rewrapVaultKeys(val, prev).catch(() => {});
        throw e;
      }
      oldPin.current = null;
      leave();
    } catch {
      setError("Your PIN could not be saved, and nothing was changed. Try again.");
      setConfirm(""); setPin(""); setStage("set");
    } finally { setBusy(false); }
  };

  const title = stage==="current"?"Enter current PIN":stage==="confirm"?"Confirm PIN":"Set Device PIN";
  const sub = stage==="current"
    ? "Enter the PIN you use now, then tap Continue (✓), before choosing a new one."
    : stage==="confirm" ? "Enter your new PIN again to confirm"
    : `${NEW_PIN_LENGTH} digits. It opens the Vault, locks this device's session, and unlocks the app when Auto Screen Lock relocks it. Keep it private.`;

  return (
    <View style={S.screen}>
      <AuthSky />
      <KeyboardSafe style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={S.container} keyboardShouldPersistTaps="handled">
        <TouchableOpacity style={S.back} onPress={leave} accessibilityRole="button" accessibilityLabel="Back" hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={AUTH.text} />
        </TouchableOpacity>
        <View style={S.header}>
          <View style={S.badge} accessibilityElementsHidden importantForAccessibility="no"><Text style={{fontSize:36}}>🔢</Text></View>
          <Text style={S.title} accessibilityRole="header">{title}</Text>
          <Text style={S.sub}>{sub}</Text>
        </View>
        {stage==="loading" ? <ActivityIndicator color={AUTH.text} /> : (
          <>
            {!!error&&<Text style={S.err} accessibilityLiveRegion="polite">{error}</Text>}
            {stage==="current" ? (
              <PinPad
                key="current"
                value={cur}
                onChange={onType}
                length={PIN_MAX}
                minLength={PIN_MIN}
                onSubmit={(v) => { void checkCurrent(v); }}
                submitLabel="Continue"
                error={!!error}
              />
            ) : (
              <PinPad
                key={stage}
                value={current}
                onChange={onType}
                length={NEW_PIN_LENGTH}
                onComplete={(v) => { void advance(v); }}
                error={!!error}
              />
            )}
            {busy && <ActivityIndicator color={AUTH.text} style={{ marginTop: 12 }} />}
            {stage==="current" && (
              <TouchableOpacity onPress={forgotCurrent} style={S.forgot} accessibilityRole="button">
                <Text style={S.forgotTxt}>Forgotten your current PIN?</Text>
              </TouchableOpacity>
            )}
          </>
        )}
        <Text style={S.hint}>PIN is stored securely on your device only.</Text>
        </ScrollView>
      </KeyboardSafe>
    </View>
  );
}

const makeStyles = (AUTH: AuthPalette) => StyleSheet.create({
  screen:     { flex:1, backgroundColor:"transparent" },
  container:  { flexGrow:1,alignItems:"center",paddingTop:HEADER_TOP,paddingHorizontal:32,paddingBottom:32 },
  back:       { alignSelf:"flex-start",width:44,height:44,justifyContent:"center",marginBottom:8 },
  header:     { alignItems:"center",marginBottom:24,gap:10 },
  badge:      { width:80,height:80,borderRadius:40,backgroundColor:tint(AUTH.accent,0.12),borderWidth:1.5,borderColor:tint(AUTH.accent,0.3),justifyContent:"center",alignItems:"center" },
  title:      { color:AUTH.text,fontSize:24,fontWeight:"900" },
  sub:        { color:AUTH.dim,fontSize:13,textAlign:"center" },
  err:        { color:AUTH.danger,fontSize:13,marginBottom:16,textAlign:"center" },
  forgot:     { minHeight:44,justifyContent:"center",marginTop:8 },
  forgotTxt:  { color:AUTH.accent,fontSize:13,fontWeight:"700" },
  hint:       { color:AUTH.dim,fontSize:12,textAlign:"center",marginTop:16 },
});
