// app/notification-sounds.tsx — Notifications & Sounds settings.
//
// Controls in-app message tones, call ringtone (with preview) and call
// vibration. Theme-aware (light + dark). Prefs persist via lib/sounds.

import { HEADER_TOP } from '../constants/layout';
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Switch } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';
import {
  getSoundPrefs, setSoundPrefs, previewRingtone, stopRingtone, RINGTONES, type SoundPrefs,
} from '../lib/sounds';
import { AuroraBackground } from '../components/ui';

export default function NotificationSoundsScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [prefs, setPrefs] = useState<SoundPrefs | null>(null);

  useEffect(() => {
    getSoundPrefs().then(setPrefs);
    return () => { stopRingtone(); };
  }, []);

  const patch = async (p: Partial<SoundPrefs>) => setPrefs(await setSoundPrefs(p));

  const pickRingtone = async (id: string) => {
    await patch({ ringtone: id });
    previewRingtone(id);   // play it once so they hear the choice
  };

  if (!prefs) return <View style={s.root} />;

  return (
    <View style={s.root}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.iconBtn} hitSlop={8}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Notifications & Sounds</Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {/* Message tones */}
        <Text style={s.section}>MESSAGES</Text>
        <View style={s.row}>
          <Ionicons name="musical-notes-outline" size={22} color={colors.text} />
          <View style={s.rowBody}>
            <Text style={s.rowTitle}>In-app message sounds</Text>
            <Text style={s.rowSub}>Play a tone when you send or receive a message while the app is open</Text>
          </View>
          <Switch
            value={prefs.messageSounds}
            onValueChange={(v) => patch({ messageSounds: v })}
            trackColor={{ true: colors.primary, false: colors.border }}
            thumbColor="#fff"
          />
        </View>

        {/* Calls */}
        <Text style={s.section}>CALLS</Text>
        <View style={s.row}>
          <Ionicons name="phone-portrait-outline" size={22} color={colors.text} />
          <View style={s.rowBody}>
            <Text style={s.rowTitle}>Vibrate on incoming call</Text>
          </View>
          <Switch
            value={prefs.vibrate}
            onValueChange={(v) => patch({ vibrate: v })}
            trackColor={{ true: colors.primary, false: colors.border }}
            thumbColor="#fff"
          />
        </View>

        <Text style={[s.section, { marginTop: 18 }]}>RINGTONE</Text>
        {RINGTONES.map(rt => {
          const on = prefs.ringtone === rt.id;
          return (
            <TouchableOpacity key={rt.id} style={s.row} onPress={() => pickRingtone(rt.id)} activeOpacity={0.7}>
              <Ionicons name={on ? 'radio-button-on' : 'radio-button-off'} size={22} color={on ? colors.primary : colors.textDim} />
              <View style={s.rowBody}>
                <Text numberOfLines={1} style={s.rowTitle}>{rt.name}</Text>
              </View>
              <Ionicons name="play-circle-outline" size={24} color={colors.textDim} />
            </TouchableOpacity>
          );
        })}

        <Text style={s.note}>
          Notifications when the app is closed use your phone’s system notification sound. A custom
          per-chat notification sound is coming in a future build.
        </Text>
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', paddingTop: HEADER_TOP, paddingHorizontal: 12, paddingBottom: 12, backgroundColor: c.bg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke, gap: 8 },
  iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: c.text, fontSize: 18, fontWeight: '700' },

  section: { color: c.textDim, fontSize: 11, fontWeight: '800', letterSpacing: 1, paddingHorizontal: 18, paddingTop: 18, paddingBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 18, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.hairline },
  rowBody: { flex: 1 },
  rowTitle: { color: c.text, fontSize: 15, fontWeight: '600' },
  rowSub: { color: c.textDim, fontSize: 12, marginTop: 2, lineHeight: 16 },

  note: { color: c.textFaint, fontSize: 12, lineHeight: 17, paddingHorizontal: 18, paddingTop: 20 },
});
