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

import { AppText as Text } from '../components/ui/Text';
import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, TouchableOpacity, SectionList, Alert, ActivityIndicator } from 'react-native';
import { Stack, useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { brandAlpha } from '../constants/theme';
import SpaceGround, { useSpaceGlass } from '../components/spaces/SpaceGround';
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
  // Spaces & Operations (S5.4) — detected on the vehicle, not by the server.
  overspeed: 'speedometer-outline',
  longstop: 'pause-circle-outline',
  sos: 'alert-circle',
  checkin: 'checkmark-done-circle',
  battery: 'battery-dead',
  sharing: 'navigate-circle',
  gps: 'locate-outline',
  offline: 'cloud-offline-outline',
  deviation: 'git-branch-outline',
  announcement: 'megaphone-outline',
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
  const G = useSpaceGlass();
  const router = useRouter();
  const params = useLocalSearchParams<{ circleId?: string; circleName?: string }>();
  const circleId = params.circleId ? String(params.circleId) : null;

  const [filter, setFilter] = useState<AlertFilter>('all');
  const alerts = useFamilyAlerts(circleId, filter);

  // "No alerts yet" must not flash before the device store has been read.
  const [ready, setReady] = useState(false);
  useEffect(() => { loadAlerts().catch(() => {}).finally(() => setReady(true)); }, []);
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
    <View style={{ flex: 1, backgroundColor: G.bgMid }}>
      {/* headerShown: the root hides headers app-wide, so without opting back
          in this screen had NO back button and its headerRight clear-button
          never rendered at all — and the filter tabs sat in the dead strip
          under the status bar. Same fix as the space module. */}
      <Stack.Screen options={{
        headerShown: true, title: 'Alerts', headerTitleAlign: 'center',
        headerStyle: { backgroundColor: G.bgTop }, headerTintColor: colors.text, headerShadowVisible: false,
        headerRight: () => (
          <TouchableOpacity onPress={confirmClear} style={{ paddingHorizontal: 8 }} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }} accessibilityRole="button" accessibilityLabel="Clear alert history">
            <Ionicons name="trash-outline" size={19} color={colors.textDim} />
          </TouchableOpacity>
        ),
      }} />
      <SpaceGround />

      <View style={[st.tabs, { borderColor: G.line }]}>
        {FILTERS.map((f) => {
          const on = f.key === filter;
          return (
            <TouchableOpacity key={f.key} onPress={() => setFilter(f.key)}
              accessibilityRole="button" accessibilityState={{ selected: on }}
              style={[st.tab, { backgroundColor: on ? brandAlpha(0.14) : G.paneFaint, borderColor: on ? colors.primary : G.chipEdge }]}>
              <Text style={{ color: on ? G.accentText : colors.textDim, fontWeight: on ? '800' : '600', fontSize: 13 }}>{f.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <SectionList
        sections={sections}
        keyExtractor={(a) => a.id}
        contentContainerStyle={sections.length ? { paddingBottom: 30 } : { flex: 1 }}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={!ready ? (
          <View style={st.empty}><ActivityIndicator color={colors.primary} /></View>
        ) : (
          <View style={st.empty}>
            <Ionicons name="notifications-off-outline" size={30} color={colors.textFaint} />
            <Text style={{ color: colors.text, fontWeight: '700', marginTop: 10 }}>No alerts yet</Text>
            <Text style={{ color: colors.textDim, fontSize: 13, textAlign: 'center', marginTop: 4, paddingHorizontal: 40 }}>
              Arrivals, departures, check-ins, SOS and low-battery warnings land here.
            </Text>
          </View>
        )}
        renderSectionHeader={({ section }) => (
          // Transparent: a solid strip over the gradient ground reads as a bug.
          <Text numberOfLines={1} style={[st.sec, { color: colors.textDim }]}>{section.title}</Text>
        )}
        renderItem={({ item }) => {
          // System rows ("sharing paused" etc.) have no member to open.
          const hasMember = !!circleId && !!item.actorId && item.actorId !== 'system';
          return (
          <TouchableOpacity
            activeOpacity={0.75}
            disabled={!hasMember}
            accessibilityRole={hasMember ? 'button' : 'text'}
            accessibilityLabel={`${item.read ? '' : 'Unread. '}${item.text}. ${when(item.at)}`}
            accessibilityHint={hasMember ? `Opens ${item.actorName}` : undefined}
            onPress={() => hasMember && router.push({
              pathname: '/family-member' as any,
              params: { circleId: circleId!, userId: item.actorId, name: item.actorName, circleName: params.circleName ?? '' },
            })}
            style={[st.row, { borderColor: G.line, backgroundColor: item.read ? 'transparent' : brandAlpha(0.07) }]}
          >
            <View style={[st.icon, { backgroundColor: item.sev === 'critical' ? colors.danger + '22' : item.sev === 'important' ? brandAlpha(0.13) : G.paneFaint }]}>
              <Ionicons name={ICON_FOR[item.kind] ?? 'notifications'} size={17} color={tint(item)} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontSize: 14, fontWeight: item.read ? '500' : '700' }} numberOfLines={2}>
                {item.text}
              </Text>
              <Text style={{ color: colors.textDim, fontSize: 11.5, marginTop: 2 }}>{when(item.at)}</Text>
            </View>
            {!item.read && <View style={[st.unread, { backgroundColor: colors.brandOnLight }]} />}
          </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}

const st = StyleSheet.create({
  tabs: { flexDirection: 'row', gap: 8, padding: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 999, borderWidth: 1 },
  sec: { fontSize: 11.5, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  icon: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  unread: { width: 8, height: 8, borderRadius: 4 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
