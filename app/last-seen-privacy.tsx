// app/last-seen-privacy.tsx — Last Seen & Privacy.
//
// Wired to the REAL backend settings (/user/settings) that the server actually
// enforces: discoverable, last-seen visibility, read receipts, profile-photo
// visibility. Each toggle saves immediately and takes effect server-side. The
// earlier version stored richer-looking 3-way "everyone/contacts/nobody" radios
// in AsyncStorage that nothing read or enforced — those are gone.

import React, { useState, useEffect, useMemo } from 'react';
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

const ROWS: { key: keyof UserSettings; icon: any; title: string; info: string }[] = [
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
  const [busy, setBusy] = useState<keyof UserSettings | null>(null);

  useEffect(() => {
    (async () => {
      try { setSettings(await getSettings()); }
      catch { Alert.alert('Could not load', 'Failed to load privacy settings.'); }
    })();
  }, []);

  const toggle = async (key: keyof UserSettings, value: boolean) => {
    if (!settings) return;
    const prev = settings;
    setSettings({ ...settings, [key]: value });   // optimistic
    setBusy(key);
    try {
      await updateSettings({ [key]: value } as Partial<UserSettings>);
    } catch (e: any) {
      setSettings(prev);                            // rollback on failure
      Alert.alert('Could not save', e?.message ?? 'Try again');
    } finally {
      setBusy(null);
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
          <Text style={s.headerTitle}>Last Seen & Privacy</Text>
          <View style={{ width: 24 }} />
        </View>
      </View>

      {!settings ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.primary} size="large" />
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
                <Text numberOfLines={1} style={s.cardTitle}>{row.title}</Text>
                {busy === row.key && <ActivityIndicator color={colors.primary} style={{ marginLeft: 'auto' }} />}
              </View>
              <Text style={s.cardInfo}>{row.info}</Text>
              <View style={s.toggleRow}>
                <Text style={s.toggleLabel}>{settings[row.key] ? 'On' : 'Off'}</Text>
                <Switch
                  value={!!settings[row.key]}
                  onValueChange={(v) => toggle(row.key, v)}
                  disabled={busy === row.key}
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
  cardTitle: { color: c.text, fontSize: 17, fontWeight: '700', marginLeft: 10 },
  cardInfo: { color: c.textDim, fontSize: 13, lineHeight: 18, marginBottom: 12 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 },
  toggleLabel: { color: c.text, fontSize: 14, fontWeight: '600' },
});
