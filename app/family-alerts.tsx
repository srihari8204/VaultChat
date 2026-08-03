// app/family-alerts.tsx — Family Space alerts centre (mockup screen 23).
//
// Family events used to be plain system messages in the circle thread, so an SOS
// and a "typing…" had the same weight and there was no read state. This is the
// typed inbox over lib/family/alerts.ts: All / Important / System, severity
// colouring, and mark-all-read.
//
// Distinct from app/(tabs)/alerts.tsx, which is the SECURITY audit chain (root
// detection, screenshot capture). Different data, different threat model — they
// are deliberately not merged.

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, SectionList, Alert } from 'react-native';
import { Stack, useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { brandAlpha } from '../constants/theme';
import {
  useFamilyAlerts, loadAlerts, markAllRead, clearCircleAlerts,
  type AlertFilter, type AlertKind, type FamilyAlert,
} from '../lib/family/alerts';

const FILTERS: { key: AlertFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'important', label: 'Important' },
  { key: 'system', label: 'System' },
];

const ICON_FOR: Record<AlertKind, keyof typeof Ionicons.glyphMap> = {
  enter: 'enter-outline',
  leave: 'exit-outline',
  sos: 'alert-circle',
  checkin: 'checkmark-done-circle',
  battery: 'battery-dead',
  sharing: 'navigate-circle',
};

function when(ts: number): string {
  const d = new Date(ts), now = new Date();
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return t;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${t}`;
}

const sectionOf = (ts: number): string => {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (new Date(now.getTime() - 86400_000).toDateString() === d.toDateString()) return 'Yesterday';
  return 'Earlier';
};

export default function FamilyAlertsScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ circleId?: string; circleName?: string }>();
  const circleId = params.circleId ? String(params.circleId) : null;

  const [filter, setFilter] = useState<AlertFilter>('all');
  const alerts = useFamilyAlerts(circleId, filter);

  useEffect(() => { loadAlerts(); }, []);
  // Opening the inbox is the read receipt — same convention as the chats list.
  useFocusEffect(useCallback(() => {
    const t = setTimeout(() => { markAllRead(circleId); }, 600);
    return () => clearTimeout(t);
  }, [circleId]));

  const sections = React.useMemo(() => {
    const order = ['Today', 'Yesterday', 'Earlier'];
    const map = new Map<string, FamilyAlert[]>();
    for (const a of alerts) {
      const k = sectionOf(a.at);
      const arr = map.get(k);
      if (arr) arr.push(a); else map.set(k, [a]);
    }
    return order.filter((k) => map.has(k)).map((k) => ({ title: k, data: map.get(k)! }));
  }, [alerts]);

  const confirmClear = () => {
    if (!circleId) return;
    Alert.alert('Clear alerts?', 'This removes the alert history on this device only.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: () => { clearCircleAlerts(circleId); } },
    ]);
  };

  const tint = (a: FamilyAlert) =>
    a.sev === 'critical' ? colors.danger : a.sev === 'important' ? colors.primary : colors.textDim;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{
        title: 'Alerts', headerTitleAlign: 'center',
        headerRight: () => (
          <TouchableOpacity onPress={confirmClear} style={{ paddingHorizontal: 8 }}>
            <Ionicons name="trash-outline" size={19} color={colors.textDim} />
          </TouchableOpacity>
        ),
      }} />

      <View style={[st.tabs, { borderColor: colors.border }]}>
        {FILTERS.map((f) => {
          const on = f.key === filter;
          return (
            <TouchableOpacity key={f.key} onPress={() => setFilter(f.key)}
              style={[st.tab, { backgroundColor: on ? brandAlpha(0.14) : 'transparent', borderColor: on ? colors.primary : 'transparent' }]}>
              <Text style={{ color: on ? colors.primary : colors.textDim, fontWeight: on ? '800' : '600', fontSize: 13 }}>{f.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <SectionList
        sections={sections}
        keyExtractor={(a) => a.id}
        contentContainerStyle={sections.length ? { paddingBottom: 30 } : { flex: 1 }}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={
          <View style={st.empty}>
            <Ionicons name="notifications-off-outline" size={30} color={colors.textFaint} />
            <Text style={{ color: colors.text, fontWeight: '700', marginTop: 10 }}>No alerts yet</Text>
            <Text style={{ color: colors.textDim, fontSize: 13, textAlign: 'center', marginTop: 4, paddingHorizontal: 40 }}>
              Arrivals, departures, check-ins, SOS and low-battery warnings land here.
            </Text>
          </View>
        }
        renderSectionHeader={({ section }) => (
          <Text style={[st.sec, { color: colors.textDim, backgroundColor: colors.bg }]}>{section.title}</Text>
        )}
        renderItem={({ item }) => (
          <TouchableOpacity
            activeOpacity={0.75}
            onPress={() => circleId && router.push({
              pathname: '/family-member' as any,
              params: { circleId, userId: item.actorId, name: item.actorName, circleName: params.circleName ?? '' },
            })}
            style={[st.row, { borderColor: colors.border, backgroundColor: item.read ? 'transparent' : brandAlpha(0.05) }]}
          >
            <View style={[st.icon, { backgroundColor: tint(item) + '22' }]}>
              <Ionicons name={ICON_FOR[item.kind] ?? 'notifications'} size={17} color={tint(item)} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontSize: 14, fontWeight: item.read ? '500' : '700' }} numberOfLines={2}>
                {item.text}
              </Text>
              <Text style={{ color: colors.textDim, fontSize: 11.5, marginTop: 2 }}>{when(item.at)}</Text>
            </View>
            {!item.read && <View style={[st.unread, { backgroundColor: colors.primary }]} />}
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const st = StyleSheet.create({
  tabs: { flexDirection: 'row', gap: 8, padding: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 10, borderWidth: 1 },
  sec: { fontSize: 11.5, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  icon: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  unread: { width: 8, height: 8, borderRadius: 4 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
