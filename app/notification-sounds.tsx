// app/notification-sounds.tsx — Notifications & Sounds settings.
//
// Controls in-app message tones, call ringtone (with preview) and call
// vibration. Theme-aware (light + dark). Prefs persist via lib/sounds.

import { HEADER_TOP } from '../constants/layout';
import React, { useEffect, useMemo, useState } from 'react';
import { View, TouchableOpacity, StyleSheet, ScrollView, Switch, ActivityIndicator, Alert } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';
import {
  getSoundPrefs, setSoundPrefs, previewRingtone, stopRingtonePreview, RINGTONES,
  SYSTEM_RINGTONE, systemRingtoneAvailable, type SoundPrefs,
} from '../lib/sounds';
import { AppText as Text, AuroraBackground } from '../components/ui';

// The Switch thumb stays white in both themes (the platform look). colors.card
// would turn it near-black on the dark theme's dark track and lose it.
const THUMB = '#FFFFFF';

export default function NotificationSoundsScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [prefs, setPrefs] = useState<SoundPrefs | null>(null);

  useEffect(() => {
    getSoundPrefs().then(setPrefs);
    // Only the preview: stopRingtone() here also silenced a real incoming call.
    return () => { void stopRingtonePreview(); };
  }, []);

  // A failed save must not look saved: setSoundPrefs keeps the old value and throws.
  const patch = async (p: Partial<SoundPrefs>): Promise<boolean> => {
    try { setPrefs(await setSoundPrefs(p)); return true; }
    catch { Alert.alert('Could not save', 'Your sound setting was not changed. Please try again.'); return false; }
  };

  const pickRingtone = async (id: string) => {
    if (await patch({ ringtone: id })) previewRingtone(id);   // play it once so they hear the choice
  };

  if (!prefs) return <View style={[s.root, { justifyContent: 'center' }]}><ActivityIndicator color={colors.primary} /></View>;

  // "Phone ringtone" only where the native ringer exists to play it.
  const options = [
    ...(systemRingtoneAvailable() ? [{ id: SYSTEM_RINGTONE, name: 'Phone ringtone', preview: false }] : []),
    ...RINGTONES.map(r => ({ id: r.id, name: r.name, preview: true })),
  ];

  return (
    <View style={s.root}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />
      <View style={s.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={s.iconBtn} hitSlop={8}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Notifications & Sounds</Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {/* Message tones */}
        <Text style={s.section} accessibilityRole="header">MESSAGES</Text>
        <View style={s.row}>
          <Ionicons name="musical-notes-outline" size={22} color={colors.text} />
          <View style={s.rowBody}>
            <Text style={s.rowTitle}>In-app message sounds</Text>
            <Text style={s.rowSub}>Play a tone when you send or receive a message while the app is open</Text>
          </View>
          <Switch
            value={prefs.messageSounds}
            onValueChange={(v) => { void patch({ messageSounds: v }); }}
            accessibilityLabel="In-app message sounds"
            trackColor={{ true: colors.primary, false: colors.border }}
            thumbColor={THUMB}
          />
        </View>

        {/* Calls */}
        <Text style={s.section} accessibilityRole="header">CALLS</Text>
        <View style={s.row}>
          <Ionicons name="phone-portrait-outline" size={22} color={colors.text} />
          <View style={s.rowBody}>
            <Text style={s.rowTitle}>Vibrate on incoming call</Text>
          </View>
          <Switch
            value={prefs.vibrate}
            onValueChange={(v) => { void patch({ vibrate: v }); }}
            accessibilityLabel="Vibrate on incoming call"
            trackColor={{ true: colors.primary, false: colors.border }}
            thumbColor={THUMB}
          />
        </View>

        <Text style={[s.section, { marginTop: 18 }]} accessibilityRole="header">RINGTONE</Text>
        <View accessibilityRole="radiogroup" accessibilityLabel="Ringtone">
        {options.map(rt => {
          // Without the native ringer a stored 'system' plays the first bundled tone.
          const on = prefs.ringtone === rt.id
            || (prefs.ringtone === SYSTEM_RINGTONE && !systemRingtoneAvailable() && rt.id === RINGTONES[0].id);
          return (
            <TouchableOpacity
              key={rt.id}
              style={s.row}
              onPress={() => pickRingtone(rt.id)}
              activeOpacity={0.7}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={rt.preview ? `${rt.name}, plays a preview` : rt.name}
            >
              <Ionicons name={on ? 'radio-button-on' : 'radio-button-off'} size={22} color={on ? colors.primary : colors.textDim} />
              <View style={s.rowBody}>
                <Text numberOfLines={1} style={s.rowTitle}>{rt.name}</Text>
              </View>
              {rt.preview && <Ionicons name="play-circle-outline" size={24} color={colors.textDim} />}
            </TouchableOpacity>
          );
        })}
        </View>

        <Text style={s.note}>
          This ringtone plays while crazzychat is open. When the app is closed, incoming calls and
          notifications use your phone’s own sounds.
        </Text>
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', paddingTop: HEADER_TOP, paddingHorizontal: 12, paddingBottom: 12, backgroundColor: c.bg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke, gap: 8 },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: c.text, fontSize: 18, fontWeight: '700' },

  section: { color: c.textDim, fontSize: 11, fontWeight: '800', letterSpacing: 1, paddingHorizontal: 18, paddingTop: 18, paddingBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 18, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.hairline },
  rowBody: { flex: 1 },
  rowTitle: { color: c.text, fontSize: 15, fontWeight: '600' },
  rowSub: { color: c.textDim, fontSize: 12, marginTop: 2, lineHeight: 16 },

  note: { color: c.textFaint, fontSize: 12, lineHeight: 17, paddingHorizontal: 18, paddingTop: 20 },
});
