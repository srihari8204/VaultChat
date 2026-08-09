// app/group-privacy.tsx — what this group is allowed to see about me
// (Groups & Circles, G3.4).
//
// The settings here are enforced BEFORE the payload is sealed (see
// lib/groups/privacy.ts), so choosing "approximate" means the precise
// coordinate never leaves this device — not that the other side is politely
// asked to round it. The copy says so plainly, because a privacy control the
// user doesn't trust is a privacy control they won't use.
//
// Every change calls reloadPrivacy() so the RUNNING publisher picks it up
// immediately. Without that, a setting would only take effect after a restart,
// which for a privacy control is a bug, not a delay.

import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Switch, ActivityIndicator, Alert,
} from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { brandAlpha } from '../constants/theme';
import { getGroupPrivacy, setGroupPrivacy } from '../lib/groups/store';
import {
  describePrivacy, DEFAULT_GROUP_PRIVACY, APPROX_GRID_DEG,
  type GroupPrivacy, type LocationPrecision,
} from '../lib/groups/privacy';
import { reloadPrivacy } from '../lib/family/presence';

const PRECISIONS: {
  key: LocationPrecision; label: string; blurb: string; icon: keyof typeof Ionicons.glyphMap;
}[] = [
  { key: 'precise', label: 'Precise location', icon: 'locate',
    blurb: 'They see exactly where you are.' },
  { key: 'approximate', label: 'Approximate location', icon: 'ellipse-outline',
    blurb: `Rounded to about ${Math.round(APPROX_GRID_DEG * 111_000 / 50) * 50} m before it leaves your phone. Speed is not shared.` },
  { key: 'off', label: 'Don’t share location', icon: 'eye-off',
    blurb: 'You stay in the group, but nobody sees you on the map.' },
];

const DURATIONS: { label: string; ms: number | null }[] = [
  { label: '1 hour', ms: 60 * 60 * 1000 },
  { label: '8 hours', ms: 8 * 60 * 60 * 1000 },
  { label: 'Until I turn it off', ms: null },
];

export default function GroupPrivacyScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ groupId?: string; name?: string }>();
  const groupId = String(params.groupId || '');
  const groupName = String(params.name || 'this group');

  const [p, setP] = useState<GroupPrivacy>(DEFAULT_GROUP_PRIVACY);
  const [loading, setLoading] = useState(true);

  useFocusEffect(useCallback(() => {
    let live = true;
    (async () => {
      if (!groupId) { setLoading(false); return; }
      const cur = await getGroupPrivacy(groupId);
      if (!live) return;
      setP(cur); setLoading(false);
    })();
    return () => { live = false; };
  }, [groupId]));

  /** Persist, then push into the live publisher so it applies to the next fix. */
  const patch = async (next: Partial<GroupPrivacy>) => {
    if (!groupId) return;
    const saved = await setGroupPrivacy(groupId, next);
    setP(saved);
    try { await reloadPrivacy(groupId); } catch { /* not publishing right now */ }
  };

  const startTemporary = (ms: number | null) =>
    patch({ sharingUntil: ms == null ? null : Date.now() + ms, invisible: false });

  if (loading) {
    return <View style={[st.center, { backgroundColor: colors.bg }]}><ActivityIndicator color={colors.primary} /></View>;
  }

  const muted = p.invisible || p.precision === 'off';

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: 'Privacy', headerTitleAlign: 'center' }} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>

        {/* live summary — what this group can see right now */}
        <View style={[st.summary, { backgroundColor: colors.card, borderColor: muted ? colors.border : colors.primary }]}>
          <View style={[st.summaryIcon, { backgroundColor: (muted ? colors.textFaint : colors.primary) + '22' }]}>
            <Ionicons name={muted ? 'eye-off' : 'eye'} size={22} color={muted ? colors.textDim : colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15 }}>
              {describePrivacy(p, Date.now())}
            </Text>
            <Text style={{ color: colors.textDim, fontSize: 12.5 }}>in {groupName}</Text>
          </View>
        </View>

        <Text style={[st.note, { color: colors.textDim }]}>
          These settings apply before your location is encrypted and sent. What you hide here
          never leaves this phone — the group does not receive it and choose not to show it.
        </Text>

        <Text style={[st.h, { color: colors.text }]}>Location</Text>
        {PRECISIONS.map((opt) => {
          const on = p.precision === opt.key && !p.invisible;
          return (
            <TouchableOpacity
              key={opt.key}
              onPress={() => patch({ precision: opt.key, invisible: false })}
              style={[st.row, { borderColor: on ? colors.primary : colors.border, backgroundColor: on ? brandAlpha(0.08) : colors.card }]}
            >
              <Ionicons name={opt.icon} size={19} color={on ? colors.primary : colors.textDim} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontWeight: '700', fontSize: 14 }}>{opt.label}</Text>
                <Text style={{ color: colors.textDim, fontSize: 11.5, lineHeight: 16 }}>{opt.blurb}</Text>
              </View>
              <Ionicons name={on ? 'radio-button-on' : 'radio-button-off'} size={19} color={on ? colors.primary : colors.textFaint} />
            </TouchableOpacity>
          );
        })}

        <Text style={[st.h, { color: colors.text }]}>Details</Text>
        <View style={[st.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={st.toggle}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontWeight: '600', fontSize: 14 }}>Hide my battery</Text>
              <Text style={{ color: colors.textDim, fontSize: 11.5 }}>They won&apos;t see your battery level</Text>
            </View>
            <Switch value={p.hideBattery} onValueChange={(v) => patch({ hideBattery: v })} trackColor={{ true: colors.primary }} />
          </View>
          <View style={[st.toggle, { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontWeight: '600', fontSize: 14 }}>Hide my speed</Text>
              <Text style={{ color: colors.textDim, fontSize: 11.5 }}>
                {p.precision === 'approximate' ? 'Always hidden while sharing approximately' : 'They won’t see how fast you’re moving'}
              </Text>
            </View>
            <Switch
              value={p.hideSpeed || p.precision === 'approximate'}
              disabled={p.precision === 'approximate'}
              onValueChange={(v) => patch({ hideSpeed: v })}
              trackColor={{ true: colors.primary }}
            />
          </View>
        </View>

        <Text style={[st.h, { color: colors.text }]}>Invisible</Text>
        <View style={[st.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={st.toggle}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontWeight: '600', fontSize: 14 }}>Go invisible in this group</Text>
              <Text style={{ color: colors.textDim, fontSize: 11.5, lineHeight: 16 }}>
                Publishes nothing at all here. Your other groups are unaffected, and your
                settings above are kept for when you turn it off.
              </Text>
            </View>
            <Switch value={p.invisible} onValueChange={(v) => patch({ invisible: v })} trackColor={{ true: colors.danger }} />
          </View>
        </View>

        <Text style={[st.h, { color: colors.text }]}>Share for a while</Text>
        <View style={st.chips}>
          {DURATIONS.map((d) => {
            const on = d.ms == null ? p.sharingUntil == null : false;
            return (
              <TouchableOpacity key={d.label} onPress={() => startTemporary(d.ms)}
                style={[st.chip, { borderColor: on ? colors.primary : colors.border, backgroundColor: on ? brandAlpha(0.1) : 'transparent' }]}>
                <Text style={{ color: on ? colors.primary : colors.text, fontSize: 12.5, fontWeight: on ? '700' : '500' }}>{d.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        {p.sharingUntil != null && (
          <TouchableOpacity
            onPress={() => Alert.alert('Stop the timer?', 'You will keep sharing until you change it yourself.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Stop timer', onPress: () => patch({ sharingUntil: null }) },
            ])}
            style={{ paddingVertical: 12 }}
          >
            <Text style={{ color: colors.primary, fontSize: 13, fontWeight: '600' }}>
              Sharing stops {new Date(p.sharingUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — tap to cancel the timer
            </Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  summary: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderWidth: 1, borderRadius: 16 },
  summaryIcon: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  note: { fontSize: 12, lineHeight: 17, marginTop: 12 },
  h: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3, marginTop: 26, marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 13, borderWidth: 1, borderRadius: 14, marginBottom: 9 },
  card: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 13 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9 },
});
