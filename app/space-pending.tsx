// app/space-pending.tsx — who is still waiting (School design screen 10).
//
// The screen a transport office opens when a parent rings. The server orders it
// by scheduled stop time rather than alphabetically, so the top of the list is
// who to worry about — and the client does not re-sort it, because the office
// and the server disagreeing about "first" is exactly the confusion this screen
// exists to remove.
//
// Scoped server-side: ops sees the space, a driver sees their own run, a
// guardian sees only riders they are linked to. There is no filter here.

import { AppText as Text } from '../components/ui/Text';
import React, { useCallback, useMemo, useState } from 'react';
import {
  View, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { useSpaceColors, spaceHeader } from '../lib/spaces/theme';
import type { SpacePalette as Palette } from '../lib/spaces/theme';
import { getPendingPickups, type PendingPickup } from '../lib/spaces/api';
import { AuroraBackground } from '../components/ui';
import LoadError from '../components/spaces/LoadError';
import { initialOf } from '../lib/format';

export default function SpacePendingScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ spaceId?: string; name?: string; groupType?: string }>();
  const colors = useSpaceColors(params.groupType);
  const spaceId = String(params.spaceId || '');

  const [rows, setRows] = useState<PendingPickup[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Re-render every 30s so "overdue" turns on without a manual refresh.
  const [, setTick] = useState(0);
  useFocusEffect(useCallback(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []));

  const load = useCallback(async () => {
    try {
      setRows(await getPendingPickups(spaceId));
      setLoadError(null);
    } catch (e: any) {
      // Never fall through to "Nobody is waiting": on the screen used when a
      // parent rings, that would be a false all-clear.
      setLoadError(e?.message ?? 'Could not load pending pickups.');
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [spaceId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Grouped by run for the eye, in the server's order. Map preserves insertion
  // order, so the first run listed is still the one with the earliest stop.
  const byRun = useMemo(() => {
    const m = new Map<string, { name: string; runId: string; items: PendingPickup[] }>();
    for (const r of rows) {
      const g = m.get(r.runId) ?? { name: r.runName, runId: r.runId, items: [] };
      g.items.push(r);
      m.set(r.runId, g);
    }
    return [...m.values()];
  }, [rows]);

  const s = styles(colors);

  if (loading) {
    return (
      <View style={[s.screen, s.centre]}>
      <AuroraBackground />
        <Stack.Screen options={spaceHeader(colors, 'Pending pickups')} />
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={s.body}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
    >
      <Stack.Screen options={spaceHeader(colors, `Pending pickups${rows.length ? ` (${rows.length})` : ''}`, { id: spaceId, name: params.name })} />

      {loadError && (
        <LoadError colors={colors} title="Could not load pending pickups" message={loadError} onRetry={() => { setLoading(true); void load(); }} />
      )}
      {!loadError && rows.length === 0 && (
        <View style={s.card}>
          <Text style={s.cardTitle}>Nobody is waiting</Text>
          <Text style={s.muted}>
            Everyone on today’s active runs has been marked one way or the other.
          </Text>
        </View>
      )}

      {byRun.map((g) => (
        <View key={g.runId} style={s.card}>
          <TouchableOpacity
            style={s.rowBetween}
            onPress={() => router.push({ pathname: '/space-run' as any, params: { spaceId, runId: g.runId, groupType: params.groupType ?? '', name: params.name ?? '' } })}
            accessibilityRole="button"
            accessibilityLabel={`${g.name}, ${g.items.length} waiting. Open the run`}
          >
            <Text numberOfLines={1} style={s.cardTitle}>{g.name}</Text>
            <Text style={s.link}>{g.items.length} waiting</Text>
          </TouchableOpacity>

          {g.items.map((p) => (
            <View key={p.riderId} style={s.row}>
              <View style={[s.avatar, { backgroundColor: colors.primary + '22' }]}>
                <Text style={{ color: colors.primary, fontWeight: '800' }}>
                  {initialOf(p.name)}
                </Text>
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.name} numberOfLines={1}>{p.name}</Text>
                <Text style={s.muted} numberOfLines={1}>
                  {p.stop || 'No stop set'}
                  {p.plannedAt ? ` · due ${clock(p.plannedAt)}` : ''}
                </Text>
              </View>
              {/* "Late" only when there IS a scheduled time to be late against.
                  Without one the app has no opinion, and says nothing rather
                  than implying the pickup is overdue. */}
              {p.plannedAt && Date.parse(p.plannedAt) < Date.now() && (
                <View style={[s.pill, { backgroundColor: colors.danger + '22' }]}>
                  <Text style={{ color: colors.danger, fontSize: 11, fontWeight: '700' }}>overdue</Text>
                </View>
              )}
              {p.runStatus === 'scheduled' && (
                <View style={[s.pill, { backgroundColor: colors.border }]}>
                  <Text style={{ color: colors.textDim, fontSize: 11 }}>not started</Text>
                </View>
              )}
            </View>
          ))}
        </View>
      ))}

      <Text style={s.footnote}>
        Ordered by scheduled stop time, oldest first, as the server returned it. Pull to refresh.
      </Text>
    </ScrollView>
  );
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const styles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  centre: { alignItems: 'center', justifyContent: 'center' },
  body: { padding: 16, gap: 10, paddingBottom: 40 },
  card: { backgroundColor: c.glassSoft, borderRadius: 14, padding: 14, gap: 6 },
  cardTitle: { color: c.text, fontSize: 15.5, fontWeight: '700' },
  muted: { color: c.textDim, fontSize: 12.5, flexShrink: 1 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  link: { color: c.primary, fontSize: 12.5, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  avatar: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  name: { color: c.text, fontSize: 14.5, fontWeight: '600' },
  pill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  footnote: { color: c.textFaint, fontSize: 11.5, lineHeight: 16 },
});
