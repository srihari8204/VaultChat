// app/backup-pin.tsx — set or change the Device PIN (Settings → Device PIN).
//
// The PIN opens the Vault and seals this device's session (services/security/
// pinStore). Changing an existing PIN asks for the current one first: before
// 2026-10-04 anyone holding an unlocked phone could replace it, which also
// re-sealed the session under a PIN the owner did not know.

import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, ScrollView, StyleSheet, TouchableOpacity, View } from "react-native";
import { savePIN } from "../services/securityService";
import * as pinStore from "../services/security/pinStore";
import { PIN_MAX, PIN_MIN } from "../services/security/pinFormat";
import { rewrapVaultKeys } from "../lib/vaultKeyStore";
import { AppText as Text, AuthSky, KeyboardSafe } from "../components/ui";
import { AUTH_LIGHT, type AuthPalette } from '../constants/authTheme';
import { useAuthTheme } from '../lib/useAuthTheme';

/** Length of a NEW PIN. Must stay inside pinFormat (pinFormat.selftest checks). */
const NEW_PIN_LENGTH = 6;
const KEYS = ["1","2","3","4","5","6","7","8","9","ok","0","⌫"];
const isWeak = (p: string) => /^(\d)\1+$/.test(p) || "0123456789".includes(p) || "9876543210".includes(p);

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
  const maxLen  = stage==="current"?PIN_MAX:NEW_PIN_LENGTH;

  const leave = () => { if (router.canGoBack()) router.back(); else router.replace("/(tabs)/chats" as any); };

  const checkCurrent = async (val:string) => {
    if (busy || val.length < PIN_MIN) return;
    setBusy(true);
    try {
      if (await pinStore.verifyPin(val)) { oldPin.current = val; setCur(""); setError(""); setStage("set"); return; }
      const wait = await pinStore.pinBackoffMs();
      setError(wait > 0 ? `Too many attempts. Try again in ${Math.ceil(wait / 1000)} s.` : "That is not your current PIN.");
      setCur("");
    } finally { setBusy(false); }
  };

  const handleKey = (k:string) => {
    if (busy) return;
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (k==="⌫"){setter(p=>p.slice(0,-1));setError("");return;}
    if (k==="ok"){ if (stage==="current") checkCurrent(cur); return; }
    if (current.length>=maxLen) return;
    const next=current+k; setter(next); setError("");
    if (next.length===maxLen) setTimeout(()=>advance(next),120);
  };

  const advance = async (val:string) => {
    if (stage==="current"){ await checkCurrent(val); return; }
    if (stage==="set"){
      if (isWeak(val)) { setError("That PIN is too easy to guess. Choose another."); setPin(""); return; }
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

  const dots = Array(stage==="current"?Math.max(PIN_MIN,cur.length):NEW_PIN_LENGTH).fill(0).map((_,i)=>({filled:i<current.length}));
  const title = stage==="current"?"Enter current PIN":stage==="confirm"?"Confirm PIN":"Set Device PIN";
  const sub = stage==="current"
    ? "Enter the PIN you use now, then tap ✓, before choosing a new one."
    : stage==="confirm" ? "Enter your new PIN again to confirm"
    : `${NEW_PIN_LENGTH} digits. It opens the Vault and locks this device's session. Keep it private.`;

  return (
    <View style={S.screen}>
      <AuthSky />
      <KeyboardSafe style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={S.container} keyboardShouldPersistTaps="handled">
        <TouchableOpacity style={S.back} onPress={leave} accessibilityRole="button" accessibilityLabel="Back" hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={AUTH.text} />
        </TouchableOpacity>
        <View style={S.header}>
          <View style={S.badge}><Text style={{fontSize:36}}>🔢</Text></View>
          <Text style={S.title} accessibilityRole="header">{title}</Text>
          <Text style={S.sub}>{sub}</Text>
        </View>
        {stage==="loading" ? <ActivityIndicator color={AUTH.text} /> : (
          <>
            <View style={S.dotsRow} accessible accessibilityLabel={`${current.length} digits entered`}>
              {dots.map((d,i)=><View key={i} style={[S.pinDot,d.filled&&S.pinDotFilled]}/>)}
            </View>
            {!!error&&<Text style={S.err} accessibilityLiveRegion="polite">{error}</Text>}
            <View style={S.keypad}>
              {KEYS.map((k,i)=>{
                if (k==="ok" && stage!=="current") return <View key={i} style={[S.key,S.keyEmpty]} />;
                const off = busy || (k==="ok" && cur.length<PIN_MIN);
                return (
                  <TouchableOpacity
                    key={i}
                    style={[S.key,k==="⌫"&&S.keyDel,off&&{opacity:0.4}]}
                    onPress={()=>handleKey(k)}
                    disabled={off}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={k==="⌫"?"Delete":k==="ok"?"Continue":k}
                    accessibilityState={{ disabled: off }}
                  >
                    <Text style={[S.keyTxt,k==="⌫"&&{color:AUTH.danger}]}>{k==="ok"?"✓":k}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
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
  badge:      { width:80,height:80,borderRadius:40,backgroundColor:"rgba(74,159,255,0.12)",borderWidth:1.5,borderColor:"rgba(74,159,255,0.3)",justifyContent:"center",alignItems:"center" },
  title:      { color:AUTH.text,fontSize:24,fontWeight:"900" },
  sub:        { color:AUTH.dim,fontSize:13,textAlign:"center" },
  dotsRow:    { flexDirection:"row",gap:14,marginBottom:16 },
  pinDot:     { width:18,height:18,borderRadius:9,borderWidth:2,borderColor:AUTH.bg === AUTH_LIGHT.bg ? AUTH.stroke : "rgba(255,255,255,0.2)" },
  pinDotFilled:{ backgroundColor:"#4A9FFF",borderColor:"#4A9FFF" },
  err:        { color:AUTH.danger,fontSize:13,marginBottom:16,textAlign:"center" },
  keypad:     { flexDirection:"row",flexWrap:"wrap",width:"100%",maxWidth:280,gap:14,justifyContent:"center",marginBottom:24 },
  key:        { width:76,height:76,borderRadius:38,backgroundColor:AUTH.bg === AUTH_LIGHT.bg ? AUTH.card : "rgba(255,255,255,0.07)",borderWidth:1,borderColor:AUTH.bg === AUTH_LIGHT.bg ? AUTH.stroke : "rgba(255,255,255,0.1)",justifyContent:"center",alignItems:"center" },
  keyEmpty:   { backgroundColor:"transparent",borderColor:"transparent" },
  keyDel:     { backgroundColor:"rgba(239,68,68,0.08)",borderColor:"rgba(239,68,68,0.2)" },
  keyTxt:     { color:AUTH.text,fontSize:24,fontWeight:"600" },
  hint:       { color:AUTH.dim,fontSize:12,textAlign:"center" },
});
