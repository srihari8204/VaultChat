import { useTheme } from '../lib/theme';
import type { Palette } from '../constants/theme';
import { AuroraBackground } from '../components/ui';
import { HEADER_TOP, SCREEN_BOTTOM } from '../constants/layout';
import { Camera } from "expo-camera";
import * as Contacts from "expo-contacts";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import { Pedometer } from "expo-sensors";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { AppState, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { canUseFullScreenIntent, openFullScreenIntentSettings } from "../lib/CallService";
import { permissionDenied } from "../lib/permissionDenied";
import { tint } from "../lib/tintColor";

// App permissions, opened from Settings ("App permissions"). One place to see
// what is granted and to ask again, ONE permission at a time: each row asks
// for its own permission with its own reason, and a permission the OS will no
// longer prompt for (canAskAgain false) offers the app's Settings page instead
// of failing silently (lib/permissionDenied).
//
// The legacy signup chain this screen was also part of is deleted, so the
// step dots, "Step 7 of 8", the auto-advance and "Skip" are gone with it.
type Grant = { granted: boolean; canAskAgain?: boolean };
const PERMS: { key: string; icon: string; label: string; sub: string; request: () => Promise<Grant> }[] = [
  {key:"camera",   icon:"📷",label:"Camera",       sub:"Face scan and photo sharing",
    request: () => Camera.requestCameraPermissionsAsync()},
  {key:"mic",      icon:"🎙️",label:"Microphone",   sub:"Voice and video calls",
    request: () => Camera.requestMicrophonePermissionsAsync()},
  {key:"contacts", icon:"👥",label:"Contacts",     sub:"Find friends on crazzychat",
    request: () => Platform.OS === 'web' ? Promise.resolve({ granted: true }) : Contacts.requestPermissionsAsync()},
  {key:"location", icon:"📍",label:"Location",     sub:"Secure location sharing",
    request: () => Location.requestForegroundPermissionsAsync()},
  // Background location MUST follow a granted foreground grant — both
  // platforms reject the always-on prompt otherwise. Family Space only keeps
  // sharing while the app is closed if this one lands. Never asked as part of
  // "Grant missing": it is the most sensitive grant here, so only its own row.
  {key:"background",icon:"🛰️",label:"Background Access",sub:"Keep Family Space sharing when the app is closed",
    request: async () => {
      const fg = await Location.requestForegroundPermissionsAsync();
      return fg.granted ? Location.requestBackgroundPermissionsAsync() : fg;
    }},
  // Motion is an iOS-only prompt; Android resolves granted with no dialog.
  {key:"motion",   icon:"🏃",label:"Motion & Fitness",sub:"Detect driving so location updates adapt",
    request: () => Pedometer.requestPermissionsAsync()},
  {key:"notifs",   icon:"🔔",label:"Notifications",sub:"New messages and calls",
    request: () => Notifications.requestPermissionsAsync()},
];

export default function PermissionsScreen() {
  const { colors: c, scheme } = useTheme();
  const S = useMemo(() => makeStyles(c, scheme === "light"), [c, scheme]);
  // Settings opens this with ?from=settings, and Done goes back there. Opened
  // any other way (a deep link), Done lands on Settings — the page this one
  // belongs to — rather than popping into whatever happened to be underneath.
  const fromSettings = useLocalSearchParams<{ from?: string }>().from === 'settings';
  const done = () => { if (fromSettings && router.canGoBack()) router.back(); else router.replace('/settings' as any); };
  const [granted,setGranted] = useState<Record<string,boolean>>({});
  /** The key being requested, or 'all' for the main button. */
  const [busy,setBusy] = useState<string | null>(null);
  // Android 14 turned USE_FULL_SCREEN_INTENT into a user-granted special
  // access. Declaring it in the manifest is no longer enough, and there is no
  // runtime dialog to request it — the only route is the Settings page below.
  // Ungranted, an incoming call on a locked phone arrives as a small banner
  // instead of a ringing call screen, which for a calling app reads as "calls
  // don't work". canUseFullScreenIntent resolves true where the concept does
  // not exist (iOS, Android 13 and below), so the row simply never appears.
  const [fsiOk,setFsiOk] = useState(true);

  // READ WHAT IS ALREADY GRANTED, with getters that prompt nobody, so a user
  // who granted everything earlier does not see seven empty circles.
  const readGranted = async () => {
    const r: Record<string, boolean> = {};
    try {
      r.camera   = (await Camera.getCameraPermissionsAsync()).granted;
      r.mic      = (await Camera.getMicrophonePermissionsAsync()).granted;
      r.contacts = Platform.OS === 'web' ? true : (await Contacts.getPermissionsAsync()).granted;
      r.location = (await Location.getForegroundPermissionsAsync()).granted;
      try { r.background = (await Location.getBackgroundPermissionsAsync()).granted; } catch { r.background = false; }
      try { r.motion = (await Pedometer.getPermissionsAsync()).granted; } catch { r.motion = false; }
      r.notifs   = (await Notifications.getPermissionsAsync()).granted;
    } catch { /* a getter that fails leaves its row unknown, which reads as not granted */ }
    setGranted((prev) => ({ ...prev, ...r }));
  };

  const checkFsi = () => { canUseFullScreenIntent().then(setFsiOk).catch(()=>{}); };

  // Re-check when the user comes back: the grant happens in Settings, in
  // another app, so nothing here would otherwise learn that it succeeded and
  // the row would sit there looking unfinished after they had done it.
  useEffect(() => {
    checkFsi();
    void readGranted();
    const sub = AppState.addEventListener('change', s => { if (s === 'active') { checkFsi(); void readGranted(); } });
    return () => sub.remove();
  }, []);

  /** Ask for one permission; returns false when the user said no. */
  const ask = async (p: typeof PERMS[number], explainDenial: boolean): Promise<boolean> => {
    let res: Grant = { granted: false };
    try { res = await p.request(); } catch { /* treated as a refusal */ }
    setGranted((prev) => ({ ...prev, [p.key]: res.granted }));
    // The OS will not prompt again: the app's Settings page is the only route.
    if (!res.granted && explainDenial && res.canAskAgain === false) {
      permissionDenied(`${p.label} is off`, `crazzychat uses it for: ${p.sub.toLowerCase()}.`, false);
    }
    return res.granted;
  };

  const requestOne = async (p: typeof PERMS[number]) => {
    if (busy) return;
    setBusy(p.key);
    try { await ask(p, true); } finally { setBusy(null); }
  };

  // Everything still missing except background location (its own row only).
  const requestMissing = async () => {
    if (busy) return;
    setBusy('all');
    try {
      for (const p of PERMS) {
        if (p.key === 'background' || granted[p.key]) continue;
        await ask(p, false);
      }
      setFsiOk(await canUseFullScreenIntent().catch(() => true));
      await readGranted();
    } finally { setBusy(null); }
  };

  const missing = PERMS.some(p => p.key !== 'background' && !granted[p.key]);

  return (
    <View style={{flex:1,backgroundColor:c.bg}}>
      <AuroraBackground />
      <ScrollView style={S.container} contentContainerStyle={S.content} showsVerticalScrollIndicator={false}>
        <TouchableOpacity
          onPress={done}
          style={S.back}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Text style={S.backTxt}>‹ Back</Text>
        </TouchableOpacity>
        <View style={S.header}>
          <View style={S.badge} accessibilityElementsHidden importantForAccessibility="no"><Text style={{fontSize:36}}>🔑</Text></View>
          <Text style={S.title} accessibilityRole="header">App Permissions</Text>
          <Text style={S.sub}>Tap a permission to allow it. Each one is only used for the reason shown.</Text>
        </View>
        <View style={S.list}>
          {PERMS.map(p=>{
            const on = !!granted[p.key];
            const asking = busy === p.key;
            return (
              <TouchableOpacity
                key={p.key}
                style={S.row}
                onPress={() => requestOne(p)}
                disabled={on || !!busy}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel={`${p.label}, ${p.sub}, ${on ? 'allowed' : 'not allowed'}`}
                accessibilityHint={on ? undefined : 'Asks for this permission'}
                accessibilityState={{ disabled: on || !!busy, busy: asking, checked: on }}
              >
                <Text style={{fontSize:22,width:34}} accessibilityElementsHidden importantForAccessibility="no">{p.icon}</Text>
                <View style={{flex:1}}>
                  <Text style={S.label}>{p.label}</Text>
                  <Text style={S.psub}>{p.sub}</Text>
                </View>
                {on ? (
                  <View style={[S.status,S.statusOk]}>
                    <Text style={{fontSize:12,color:c.success}}>✓</Text>
                  </View>
                ) : (
                  <Text style={S.allow}>{asking ? 'Asking…' : 'Allow'}</Text>
                )}
              </TouchableOpacity>
            );
          })}
        </View>
        {!fsiOk && (
          <TouchableOpacity
            style={S.fsi}
            onPress={openFullScreenIntentSettings}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Full-screen calls, not allowed"
            accessibilityHint="Opens Android settings so calls can ring on a locked screen"
          >
            <Text style={{fontSize:22,width:34}} accessibilityElementsHidden importantForAccessibility="no">📱</Text>
            <View style={{flex:1}}>
              <Text style={S.label}>Full-screen calls</Text>
              <Text style={S.psub}>Android needs one extra tap for calls to ring on a locked screen</Text>
            </View>
            <Text style={S.fsiGo}>Allow ›</Text>
          </TouchableOpacity>
        )}
        {missing && (
          <TouchableOpacity
            style={[S.btn,!!busy&&S.btnOff]}
            onPress={requestMissing}
            disabled={!!busy}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityState={{ disabled: !!busy, busy: busy === 'all' }}
          >
            <Text style={S.btnTxt}>{busy === 'all' ? "Requesting..." : "Allow all missing"}</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={S.skip} onPress={done} accessibilityRole="button">
          <Text style={S.skipTxt}>Done</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette, light: boolean) => StyleSheet.create({
  // SCROLLVIEW, NOT A FIXED View (2026-09-17). Seven permission rows plus the
  // amber full-screen-intent card plus two buttons overflow a short screen, and
  // at OS font scale 1.5 the primary button and the exit clipped off the bottom
  // entirely. SCREEN_BOTTOM is the live gesture inset.
  container:{ flex:1 },
  content:{ padding:24, paddingTop:HEADER_TOP, paddingBottom:24+SCREEN_BOTTOM },
  back:     { alignSelf:"flex-start",minHeight:44,justifyContent:"center",marginBottom:4 },
  backTxt:  { color:c.accentOn,fontSize:16,fontWeight:"700" },
  header:   { alignItems:"center",marginBottom:24,gap:10 },
  badge:    { width:80,height:80,borderRadius:40,backgroundColor:tint(c.primary,0.12),borderWidth:1.5,borderColor:tint(c.primary,0.3),justifyContent:"center",alignItems:"center" },
  title:    { color:c.text,fontSize:24,fontWeight:"900" },
  sub:      { color:c.textDim,fontSize:13,textAlign:"center" },
  list:     { backgroundColor:c.glassSoft,borderRadius:16,padding:8,marginBottom:28,gap:4 },
  row:      { flexDirection:"row",alignItems:"center",gap:12,padding:12,borderRadius:12,minHeight:56 },
  label:    { color:c.text,fontSize:14,fontWeight:"600" },
  psub:     { color:c.textDim,fontSize:12,marginTop:2 },
  allow:    { color:c.accentOn,fontSize:13,fontWeight:"800" },
  status:   { width:28,height:28,borderRadius:14,borderWidth:1,borderColor:c.glassStroke,justifyContent:"center",alignItems:"center" },
  statusOk: { borderColor:c.success,backgroundColor:tint(c.success,0.1) },
  // Amber, not the blue of the primary button: this row is the one thing on the
  // screen that still needs the user, so it has to read as outstanding rather
  // than as another item in the list above. The palette has no warning role,
  // so the amber stays fixed (darkened on light for contrast).
  fsi:      { flexDirection:"row",alignItems:"center",gap:12,padding:12,borderRadius:12,marginBottom:12,
              backgroundColor:"rgba(245,158,11,0.12)",borderWidth:1,borderColor:"rgba(245,158,11,0.45)" },
  fsiGo:    { color:light ? "#925B00" : "#F59E0B",fontWeight:"800",fontSize:13 },
  btn:      { backgroundColor:c.primary,borderRadius:14,paddingVertical:16,alignItems:"center",marginBottom:12 },
  btnOff:   { opacity:0.5 },
  // White on the primary fill in both themes (the button ground is always the accent).
  btnTxt:   { color:"#fff",fontSize:16,fontWeight:"800" },
  skip:     { padding:10,alignItems:"center",minHeight:44,justifyContent:"center" },
  skipTxt:  { color:c.textDim,fontSize:13 },
});
