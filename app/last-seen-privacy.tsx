// @ts-nocheck
// app/last-seen-privacy.tsx — Last Seen & Online Privacy Settings
// All settings saved to AsyncStorage 'vc_privacy_settings'

import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  StatusBar, Platform, Alert, Switch, Dimensions,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';

const TOP = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 44;

const C = {
  bg: '#020B18', accent: '#4A9FFF', cyan: '#00E5FF',
  card: '#0A1628', cardBorder: '#112240', white: '#FFFFFF',
  muted: '#7B8CA8', green: '#10B981', red: '#FF4D6D',
  orange: '#FF9F43', yellow: '#FBBF24',
};

const STORAGE_KEY = 'vc_privacy_settings';

const DEFAULT_PRIVACY = {
  lastSeen: 'contacts',       // everyone | contacts | nobody
  onlineStatus: true,          // show | hide
  profilePhoto: 'everyone',    // everyone | contacts | nobody
  aboutBio: 'everyone',        // everyone | contacts | nobody
  readReceipts: true,
  typingIndicator: true,
  groups: 'contacts',          // everyone | contacts | nobody
  liveLocationDuration: 15,    // minutes default
};

type PrivacySettings = typeof DEFAULT_PRIVACY;

const VISIBILITY_OPTIONS = [
  { label: 'Everyone', value: 'everyone' },
  { label: 'My Contacts', value: 'contacts' },
  { label: 'Nobody', value: 'nobody' },
];

export default function LastSeenPrivacyScreen() {
  const router = useRouter();
  const [settings, setSettings] = useState<PrivacySettings>(DEFAULT_PRIVACY);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) setSettings({ ...DEFAULT_PRIVACY, ...JSON.parse(raw) });
    } catch {}
  };

  const update = (patch: Partial<PrivacySettings>) => {
    const updated = { ...settings, ...patch };
    setSettings(updated);
    setSaved(false);
  };

  const saveAll = async () => {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      Alert.alert('Error', 'Failed to save privacy settings.');
    }
  };

  const applyToAll = (value: 'everyone' | 'contacts' | 'nobody') => {
    update({
      lastSeen: value,
      profilePhoto: value,
      aboutBio: value,
      groups: value,
    });
  };

  const RadioGroup = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <View style={s.radioGroup}>
      {VISIBILITY_OPTIONS.map(opt => (
        <TouchableOpacity key={opt.value} style={s.radioRow} onPress={() => onChange(opt.value)} activeOpacity={0.7}>
          <View style={[s.radioOuter, value === opt.value && s.radioOuterActive]}>
            {value === opt.value && <View style={s.radioInner} />}
          </View>
          <Text style={s.radioLabel}>{opt.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );

  const InfoCard = ({ text }: { text: string }) => (
    <View style={s.infoCard}>
      <Ionicons name="information-circle-outline" size={16} color={C.accent} />
      <Text style={s.infoText}>{text}</Text>
    </View>
  );

  // Build preview description
  const previewItems = [
    { label: 'Last Seen', value: settings.lastSeen },
    { label: 'Profile Photo', value: settings.profilePhoto },
    { label: 'About/Bio', value: settings.aboutBio },
    { label: 'Online Status', value: settings.onlineStatus ? 'Visible' : 'Hidden' },
    { label: 'Read Receipts', value: settings.readReceipts ? 'On' : 'Off' },
    { label: 'Typing Indicator', value: settings.typingIndicator ? 'On' : 'Off' },
  ];

  return (
    <View style={s.root}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      <LinearGradient colors={['#0A1628', C.bg]} style={s.header}>
        <View style={[s.headerRow, { marginTop: TOP }]}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={16}>
            <Ionicons name="arrow-back" size={24} color={C.white} />
          </TouchableOpacity>
          <Text style={s.headerTitle}>Privacy Settings</Text>
          <TouchableOpacity onPress={saveAll} hitSlop={16}>
            <Text style={[s.saveBtn, saved && { color: C.green }]}>
              {saved ? 'Saved!' : 'Save'}
            </Text>
          </TouchableOpacity>
        </View>
      </LinearGradient>

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} showsVerticalScrollIndicator={false}>

        {/* ── Last Seen ──────────────────────────────── */}
        <LinearGradient colors={['#0F2847', '#0A1628']} style={s.card}>
          <View style={s.sectionHeader}>
            <Ionicons name="time-outline" size={20} color={C.cyan} />
            <Text style={s.cardTitle}>Last Seen</Text>
          </View>
          <InfoCard text="Controls who can see when you were last active in VaultChat." />
          <RadioGroup value={settings.lastSeen} onChange={(v) => update({ lastSeen: v })} />
        </LinearGradient>

        {/* ── Online Status ──────────────────────────── */}
        <LinearGradient colors={['#0F2847', '#0A1628']} style={s.card}>
          <View style={s.sectionHeader}>
            <Ionicons name="radio-button-on-outline" size={20} color={C.green} />
            <Text style={s.cardTitle}>Online Status</Text>
          </View>
          <InfoCard text="When hidden, others won't see when you're currently online." />
          <View style={s.toggleRow}>
            <Text style={s.toggleLabel}>Show Online Status</Text>
            <Switch
              value={settings.onlineStatus}
              onValueChange={(v) => update({ onlineStatus: v })}
              trackColor={{ false: '#1A2A44', true: C.green }}
              thumbColor={settings.onlineStatus ? C.white : '#555'}
            />
          </View>
        </LinearGradient>

        {/* ── Profile Photo ──────────────────────────── */}
        <LinearGradient colors={['#0F2847', '#0A1628']} style={s.card}>
          <View style={s.sectionHeader}>
            <Ionicons name="person-circle-outline" size={20} color={C.accent} />
            <Text style={s.cardTitle}>Profile Photo</Text>
          </View>
          <InfoCard text="Choose who can see your profile photo." />
          <RadioGroup value={settings.profilePhoto} onChange={(v) => update({ profilePhoto: v })} />
        </LinearGradient>

        {/* ── About / Bio ────────────────────────────── */}
        <LinearGradient colors={['#0F2847', '#0A1628']} style={s.card}>
          <View style={s.sectionHeader}>
            <Ionicons name="text-outline" size={20} color={C.orange} />
            <Text style={s.cardTitle}>About / Bio</Text>
          </View>
          <InfoCard text="Controls who can see your bio or status text." />
          <RadioGroup value={settings.aboutBio} onChange={(v) => update({ aboutBio: v })} />
        </LinearGradient>

        {/* ── Read Receipts ──────────────────────────── */}
        <LinearGradient colors={['#0F2847', '#0A1628']} style={s.card}>
          <View style={s.sectionHeader}>
            <Ionicons name="checkmark-done-outline" size={20} color={C.accent} />
            <Text style={s.cardTitle}>Read Receipts</Text>
          </View>
          <View style={s.toggleRow}>
            <Text style={s.toggleLabel}>Read Receipts</Text>
            <Switch
              value={settings.readReceipts}
              onValueChange={(v) => {
                if (!v) {
                  Alert.alert(
                    'Disable Read Receipts?',
                    'If you turn off read receipts, you won\'t be able to see others\' read receipts either.',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Turn Off', onPress: () => update({ readReceipts: false }) },
                    ]
                  );
                } else {
                  update({ readReceipts: true });
                }
              }}
              trackColor={{ false: '#1A2A44', true: C.accent }}
              thumbColor={settings.readReceipts ? C.white : '#555'}
            />
          </View>
          {!settings.readReceipts && (
            <View style={s.warningCard}>
              <Ionicons name="warning-outline" size={16} color={C.yellow} />
              <Text style={s.warningText}>
                You won't see others' read receipts either when this is turned off.
              </Text>
            </View>
          )}
        </LinearGradient>

        {/* ── Typing Indicator ───────────────────────── */}
        <LinearGradient colors={['#0F2847', '#0A1628']} style={s.card}>
          <View style={s.sectionHeader}>
            <Ionicons name="chatbubble-ellipses-outline" size={20} color={C.cyan} />
            <Text style={s.cardTitle}>Typing Indicator</Text>
          </View>
          <InfoCard text="When off, others won't see when you're typing a message." />
          <View style={s.toggleRow}>
            <Text style={s.toggleLabel}>Show Typing Indicator</Text>
            <Switch
              value={settings.typingIndicator}
              onValueChange={(v) => update({ typingIndicator: v })}
              trackColor={{ false: '#1A2A44', true: C.cyan }}
              thumbColor={settings.typingIndicator ? C.white : '#555'}
            />
          </View>
        </LinearGradient>

        {/* ── Groups ─────────────────────────────────── */}
        <LinearGradient colors={['#0F2847', '#0A1628']} style={s.card}>
          <View style={s.sectionHeader}>
            <Ionicons name="people-outline" size={20} color={C.accent} />
            <Text style={s.cardTitle}>Groups</Text>
          </View>
          <InfoCard text="Controls who can add you to group chats." />
          <RadioGroup value={settings.groups} onChange={(v) => update({ groups: v })} />
        </LinearGradient>

        {/* ── Live Location Duration ─────────────────── */}
        <LinearGradient colors={['#0F2847', '#0A1628']} style={s.card}>
          <View style={s.sectionHeader}>
            <Ionicons name="location-outline" size={20} color={C.red} />
            <Text style={s.cardTitle}>Live Location</Text>
          </View>
          <InfoCard text="Default sharing duration when you share your live location." />
          <View style={s.durationRow}>
            {[15, 30, 60, 120].map(min => (
              <TouchableOpacity
                key={min}
                style={[s.durationBtn, settings.liveLocationDuration === min && s.durationBtnActive]}
                onPress={() => update({ liveLocationDuration: min })}
                activeOpacity={0.7}
              >
                <Text style={[s.durationText, settings.liveLocationDuration === min && s.durationTextActive]}>
                  {min < 60 ? `${min}m` : `${min / 60}h`}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </LinearGradient>

        {/* ── Profile Preview ────────────────────────── */}
        <LinearGradient colors={['#0F2847', '#0A1628']} style={s.card}>
          <View style={s.sectionHeader}>
            <Ionicons name="eye-outline" size={20} color={C.cyan} />
            <Text style={s.cardTitle}>Profile Preview</Text>
          </View>
          <Text style={s.previewDesc}>How your profile appears to others:</Text>
          {previewItems.map((item, i) => (
            <View key={i} style={s.previewRow}>
              <Text style={s.previewLabel}>{item.label}</Text>
              <View style={[
                s.previewBadge,
                {
                  backgroundColor:
                    item.value === 'everyone' || item.value === 'Visible' || item.value === 'On'
                      ? C.green + '20'
                      : item.value === 'contacts'
                      ? C.accent + '20'
                      : C.red + '20'
                },
              ]}>
                <Text style={[
                  s.previewValue,
                  {
                    color:
                      item.value === 'everyone' || item.value === 'Visible' || item.value === 'On'
                        ? C.green
                        : item.value === 'contacts'
                        ? C.accent
                        : C.red
                  },
                ]}>
                  {typeof item.value === 'string'
                    ? item.value.charAt(0).toUpperCase() + item.value.slice(1)
                    : item.value}
                </Text>
              </View>
            </View>
          ))}
        </LinearGradient>

        {/* ── Apply to All ───────────────────────────── */}
        <LinearGradient colors={['#0F2847', '#0A1628']} style={s.card}>
          <Text style={s.cardTitle}>Quick Apply</Text>
          <Text style={s.cardDesc}>Set all visibility options at once:</Text>
          <View style={s.applyRow}>
            {VISIBILITY_OPTIONS.map(opt => (
              <TouchableOpacity
                key={opt.value}
                style={s.applyBtn}
                onPress={() => {
                  applyToAll(opt.value as any);
                  Alert.alert('Applied', `All visibility settings set to "${opt.label}".`);
                }}
                activeOpacity={0.7}
              >
                <Text style={s.applyBtnText}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </LinearGradient>

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: { paddingBottom: 16, paddingHorizontal: 20 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerTitle: { color: C.white, fontSize: 20, fontWeight: '700' },
  saveBtn: { color: C.accent, fontSize: 15, fontWeight: '700' },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 40 },

  card: { borderRadius: 16, padding: 20, marginBottom: 16, borderWidth: 1, borderColor: C.cardBorder },
  cardTitle: { color: C.white, fontSize: 17, fontWeight: '700', marginLeft: 10 },
  cardDesc: { color: C.muted, fontSize: 13, marginBottom: 14 },

  sectionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },

  infoCard: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: C.accent + '10', borderRadius: 10, padding: 12, marginBottom: 14, gap: 8 },
  infoText: { color: C.muted, fontSize: 13, flex: 1, lineHeight: 18 },

  warningCard: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: C.yellow + '15', borderRadius: 10, padding: 12, marginTop: 10, gap: 8 },
  warningText: { color: C.yellow, fontSize: 13, flex: 1, lineHeight: 18 },

  radioGroup: { gap: 2 },
  radioRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  radioOuter: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: C.muted, justifyContent: 'center', alignItems: 'center' },
  radioOuterActive: { borderColor: C.accent },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.accent },
  radioLabel: { color: C.white, fontSize: 14, marginLeft: 10 },

  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 },
  toggleLabel: { color: C.white, fontSize: 14 },

  durationRow: { flexDirection: 'row', gap: 10 },
  durationBtn: { flex: 1, paddingVertical: 10, borderRadius: 10, backgroundColor: '#1A2A44', alignItems: 'center' },
  durationBtnActive: { backgroundColor: C.accent + '30', borderWidth: 1, borderColor: C.accent },
  durationText: { color: C.muted, fontSize: 14, fontWeight: '600' },
  durationTextActive: { color: C.accent },

  previewDesc: { color: C.muted, fontSize: 13, marginBottom: 12 },
  previewRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.cardBorder },
  previewLabel: { color: C.white, fontSize: 14 },
  previewBadge: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 8 },
  previewValue: { fontSize: 12, fontWeight: '700' },

  applyRow: { flexDirection: 'row', gap: 10 },
  applyBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: C.accent + '20', alignItems: 'center' },
  applyBtnText: { color: C.accent, fontSize: 13, fontWeight: '700' },
});
