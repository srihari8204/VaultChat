// app/ghost-mode.tsx
// Ghost Mode — per-contact privacy controls
// Hide: online status, typing indicators, read receipts, last seen
// Accessed from contact-info screen or chat header

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, Switch, TouchableOpacity,
  ActivityIndicator, Alert, ScrollView, Platform,
} from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import {
  getGhostSettings,
  setGhostSettings,
  GhostSettings,
} from '../services/ghostModeService';

const DARK = '#0D0F14';
const CARD = '#1A1D27';
const PURPLE = '#6C63FF';
const BORDER = '#2A2D3A';
const TEXT = '#E8E8E8';
const SUB = '#9CA3AF';
const DANGER = '#EF4444';

export default function GhostModeScreen() {
  const router = useRouter();
  const { contactUid, contactName } = useLocalSearchParams<{ contactUid: string; contactName: string }>();
  const [settings, setSettings] = useState<GhostSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!contactUid) return;
    getGhostSettings(contactUid).then(s => {
      setSettings(s);
      setLoading(false);
    });
  }, [contactUid]);

  const update = useCallback(async (key: keyof GhostSettings, value: boolean) => {
    if (!settings || !contactUid) return;
    const updated = { ...settings, [key]: value };
    setSettings(updated);
    setSaving(true);
    try {
      await setGhostSettings(contactUid, { [key]: value });
    } catch {
      Alert.alert('Error', 'Failed to save ghost settings');
    }
    setSaving(false);
  }, [settings, contactUid]);

  const toggleMaster = useCallback(async () => {
    if (!settings || !contactUid) return;
    const newVal = !settings.enabled;
    const updated = { ...settings, enabled: newVal };
    setSettings(updated);
    setSaving(true);
    try {
      await setGhostSettings(contactUid, { enabled: newVal });
    } catch {
      Alert.alert('Error', 'Failed to toggle ghost mode');
    }
    setSaving(false);
  }, [settings, contactUid]);

  if (loading) {
    return (
      <View style={[s.screen, s.center]}>
        <Stack.Screen options={{ headerShown: false }} />
        <ActivityIndicator size="large" color={PURPLE} />
      </View>
    );
  }

  if (!settings) return null;

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Text style={s.backTxt}>{'←'}</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle}>Ghost Mode</Text>
          <Text style={s.headerSub}>{contactName || 'Contact'}</Text>
        </View>
        {saving && <ActivityIndicator size="small" color={PURPLE} />}
      </View>

      <ScrollView contentContainerStyle={s.content}>

        {/* Ghost icon */}
        <View style={s.iconWrap}>
          <Text style={s.ghostIcon}>{'👻'}</Text>
          <Text style={s.ghostLabel}>
            {settings.enabled ? 'Ghost Mode Active' : 'Ghost Mode Off'}
          </Text>
          <Text style={s.ghostDesc}>
            When active, this contact cannot see your online status, typing indicators, read receipts, or last seen.
          </Text>
        </View>

        {/* Master toggle */}
        <View style={s.card}>
          <View style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={s.rowTitle}>Enable Ghost Mode</Text>
              <Text style={s.rowSub}>Become invisible to this contact</Text>
            </View>
            <Switch
              value={settings.enabled}
              onValueChange={toggleMaster}
              trackColor={{ false: '#374151', true: PURPLE + '80' }}
              thumbColor={settings.enabled ? PURPLE : '#6B7280'}
            />
          </View>
        </View>

        {/* Individual toggles */}
        <View style={[s.card, !settings.enabled && s.cardDisabled]}>
          <Text style={s.sectionTitle}>Privacy Controls</Text>

          <ToggleRow
            icon="🟢"
            title="Hide Online Status"
            sub="They won't see when you're online"
            value={settings.hideOnline}
            disabled={!settings.enabled}
            onToggle={(v) => update('hideOnline', v)}
          />

          <ToggleRow
            icon="✍️"
            title="Hide Typing Indicator"
            sub="No 'typing...' shown to them"
            value={settings.hideTyping}
            disabled={!settings.enabled}
            onToggle={(v) => update('hideTyping', v)}
          />

          <ToggleRow
            icon="✓✓"
            title="Hide Read Receipts"
            sub="Blue ticks won't appear for them"
            value={settings.hideReadReceipts}
            disabled={!settings.enabled}
            onToggle={(v) => update('hideReadReceipts', v)}
          />

          <ToggleRow
            icon="🕐"
            title="Hide Last Seen"
            sub="Your last seen time stays hidden"
            value={settings.hideLastSeen}
            disabled={!settings.enabled}
            onToggle={(v) => update('hideLastSeen', v)}
          />
        </View>

        {/* Info */}
        <View style={s.infoCard}>
          <Text style={s.infoIcon}>{'🔒'}</Text>
          <Text style={s.infoTxt}>
            Ghost Mode is per-contact. Other contacts are not affected. Settings are encrypted and stored only on your device and your private Firestore collection.
          </Text>
        </View>

      </ScrollView>
    </View>
  );
}

function ToggleRow({ icon, title, sub, value, disabled, onToggle }: {
  icon: string; title: string; sub: string;
  value: boolean; disabled: boolean; onToggle: (v: boolean) => void;
}) {
  return (
    <View style={[s.row, s.rowBorder, disabled && { opacity: 0.4 }]}>
      <Text style={s.rowIcon}>{icon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={s.rowTitle}>{title}</Text>
        <Text style={s.rowSub}>{sub}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onToggle}
        disabled={disabled}
        trackColor={{ false: '#374151', true: PURPLE + '80' }}
        thumbColor={value && !disabled ? PURPLE : '#6B7280'}
      />
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: DARK },
  center: { justifyContent: 'center', alignItems: 'center' },

  header: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingTop: Platform.OS === 'ios' ? 56 : 44, paddingBottom: 16, paddingHorizontal: 16,
    backgroundColor: CARD, borderBottomWidth: 1, borderBottomColor: BORDER,
  },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#2A2D3A', alignItems: 'center', justifyContent: 'center' },
  backTxt: { fontSize: 18, color: TEXT },
  headerTitle: { fontSize: 18, fontWeight: '700', color: TEXT },
  headerSub: { fontSize: 13, color: SUB, marginTop: 1 },

  content: { padding: 16, paddingBottom: 40 },

  iconWrap: { alignItems: 'center', paddingVertical: 24 },
  ghostIcon: { fontSize: 56, marginBottom: 12 },
  ghostLabel: { fontSize: 20, fontWeight: '700', color: TEXT, marginBottom: 6 },
  ghostDesc: { fontSize: 13, color: SUB, textAlign: 'center', lineHeight: 18, paddingHorizontal: 24 },

  card: {
    backgroundColor: CARD, borderRadius: 16, padding: 16, marginBottom: 16,
    borderWidth: 1, borderColor: BORDER,
  },
  cardDisabled: { opacity: 0.5 },
  sectionTitle: { fontSize: 14, fontWeight: '600', color: PURPLE, marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.5 },

  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 4 },
  rowBorder: { borderTopWidth: 1, borderTopColor: BORDER, paddingTop: 12, marginTop: 8 },
  rowIcon: { fontSize: 20 },
  rowTitle: { fontSize: 15, fontWeight: '600', color: TEXT },
  rowSub: { fontSize: 12, color: SUB, marginTop: 1 },

  infoCard: {
    flexDirection: 'row', gap: 10, backgroundColor: PURPLE + '10',
    borderRadius: 12, padding: 14, marginTop: 8,
    borderWidth: 1, borderColor: PURPLE + '30',
  },
  infoIcon: { fontSize: 18 },
  infoTxt: { flex: 1, fontSize: 12, color: SUB, lineHeight: 17 },
});
