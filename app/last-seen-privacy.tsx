// app/last-seen-privacy.tsx — Last Seen & Privacy.
//
// Wired to the REAL backend settings (/user/settings) that the server actually
// enforces: discoverable, last-seen visibility, read receipts, profile-photo
// visibility. Each toggle saves immediately and takes effect server-side. The
// earlier version stored richer-looking 3-way "everyone/contacts/nobody" radios
// in AsyncStorage that nothing read or enforced — those are gone.
//
// This is the ONE screen that edits these four settings. Settings and the
// Privacy Dashboard link here rather than carrying their own copies.

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { View, TouchableOpacity, StyleSheet, ScrollView, Alert, Switch, ActivityIndicator } from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { getSettings, updateSettings, type UserSettings } from '../lib/chatService';
import { AppText as Text, AuroraBackground } from '../components/ui';
import { HEADER_TOP } from '../constants/layout';

// Was: StatusBar.currentHeight on Android, a hardcoded 44 elsewhere, read
// ONCE at module scope. currentHeight ignores display cutouts, the 44 is a
// guess, and the module read froze whichever it picked for the life of the
// process. HEADER_TOP is the live binding and is applied at the element
// below, so it follows a rotation like every other screen (2026-09-17).

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

type PrivacyKey = 'lastSeenVisible' | 'readReceipts' | 'profilePhotoVisible' | 'discoverable';
const ROWS: { key: PrivacyKey; icon: React.ComponentProps<typeof Ionicons>['name']; title: string; info: string }[] = [
  { key: 'lastSeenVisible',     icon: 'time-outline',           title: 'Last Seen & Online', info: 'Let others see when you were last active and whether you are online.' },
  { key: 'readReceipts',        icon: 'checkmark-done-outline', title: 'Read Receipts',      info: 'Send read receipts. If off, you also stop seeing others’ read receipts.' },
  { key: 'profilePhotoVisible', icon: 'person-circle-outline',  title: 'Profile Photo',      info: 'Allow other people to see your profile photo.' },
  { key: 'discoverable',        icon: 'search-outline',         title: 'Discoverable',       info: 'Allow people to find you by your phone number, or by email if you added one.' },
];

export default function LastSeenPrivacyScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadTick, setLoadTick] = useState(0);
  // One save at a time. Two rows saving at once could each roll back over the
  // other's success; serialising keeps the switches equal to the server.
  const [busy, setBusy] = useState<PrivacyKey | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    let cancel = false;
    setLoadError(null);
    getSettings()
      .then((v) => { if (!cancel) setSettings(v); })
      .catch((e: unknown) => { if (!cancel) setLoadError((e as Error | undefined)?.message ?? 'Failed to load privacy settings.'); });
    return () => { cancel = true; };
  }, [loadTick]);

  const toggle = async (key: PrivacyKey, value: boolean) => {
    if (!settings || busy) return;
    setSettings((cur) => (cur ? { ...cur, [key]: value } : cur));   // optimistic, on the newest state
    setBusy(key);
    try {
      await updateSettings({ [key]: value });
    } catch (e: unknown) {
      if (!mounted.current) return;
      // Roll back only the key that failed.
      setSettings((cur) => (cur ? { ...cur, [key]: !value } : cur));
      Alert.alert('Could not save', (e as Error | undefined)?.message ?? 'Try again');
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  return (
    <View style={s.root}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />

      <View style={s.header}>
        <View style={[s.headerRow, { marginTop: HEADER_TOP }]}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} hitSlop={16} style={s.backBtn}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={s.headerTitle} accessibilityRole="header">Last Seen & Privacy</Text>
          <View style={{ width: 40 }} />
        </View>
      </View>

      {!settings ? (
        <View style={s.center}>
          {loadError ? (
            <View style={{ alignItems: 'center', gap: 8 }} accessibilityRole="alert">
              <Text style={s.errTitle}>Could not load privacy settings</Text>
              <Text style={s.errSub}>{loadError}</Text>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Try again" onPress={() => setLoadTick(t => t + 1)} style={s.retryBtn} activeOpacity={0.7}>
                <Text style={s.retryTxt}>Try again</Text>
              </TouchableOpacity>
            </View>
          ) : <ActivityIndicator color={colors.primary} size="large" />}
        </View>
      ) : (
        <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} showsVerticalScrollIndicator={false}>
          <View style={s.infoCard}>
            <Ionicons name="shield-checkmark-outline" size={16} color={colors.textDim} />
            <Text style={s.infoText}>These settings are enforced on the server and apply across all your devices.</Text>
          </View>

          {ROWS.map(row => (
            <View key={row.key} style={s.card}>
              <View style={s.sectionHeader}>
                <Ionicons name={row.icon} size={20} color={colors.textDim} />
                <Text style={s.cardTitle}>{row.title}</Text>
                {busy === row.key && <ActivityIndicator color={colors.primary} style={{ marginLeft: 'auto' }} />}
              </View>
              <Text style={s.cardInfo}>{row.info}</Text>
              <View style={s.toggleRow}>
                <Text style={s.toggleLabel}>{settings[row.key] ? 'On' : 'Off'}</Text>
                <Switch
                  accessibilityLabel={row.title}
                  accessibilityHint={row.info}
                  value={!!settings[row.key]}
                  onValueChange={(v) => toggle(row.key, v)}
                  disabled={busy !== null}
                  trackColor={{ false: colors.border, true: colors.primary }}
                  thumbColor={colors.card}
                />
              </View>
            </View>
          ))}

          <View style={{ height: 40 }} />
        </ScrollView>
      )}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  header: { paddingBottom: 16, paddingHorizontal: 20 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20 },
  headerTitle: { color: c.text, fontSize: 20, fontWeight: '700' },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 40 },

  infoCard: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: c.glass, borderRadius: 14, padding: 12, marginBottom: 16, gap: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  infoText: { color: c.textDim, fontSize: 13, flex: 1, lineHeight: 18 },

  card: { backgroundColor: c.glass, borderRadius: 16, padding: 20, marginBottom: 16, borderWidth: 1, borderColor: c.glassStroke },
  cardTitle: { flexShrink: 1, color: c.text, fontSize: 17, fontWeight: '700', marginLeft: 10 },
  cardInfo: { color: c.textDim, fontSize: 13, lineHeight: 18, marginBottom: 12 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 },
  toggleLabel: { color: c.text, fontSize: 14, fontWeight: '600' },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  errTitle: { color: c.text, fontSize: 16, fontWeight: '700', textAlign: 'center' },
  errSub: { color: c.textDim, fontSize: 13, lineHeight: 18, textAlign: 'center' },
  retryBtn: { marginTop: 4, minHeight: 44, paddingHorizontal: 18, justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: c.glassStroke, backgroundColor: c.glassSoft },
  retryTxt: { color: c.primary, fontWeight: '700' },
});
