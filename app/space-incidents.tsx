// app/space-incidents.tsx — the incident queue (Spaces & Operations, S5.3).
//
// What an office watches when something has gone wrong on the road: breakdowns,
// accidents, blocked routes, and a driver's emergency alert.
//
// ── two things this screen shows and two it does not ──
//
// It shows the CATEGORY and the vehicle, because those are plaintext and are
// what ops triages on. It does not show the reporter's note: that is ciphertext
// the server cannot read, and this screen has no business pretending otherwise.
//
// It shows an SOS first and differently, because a driver pressing a panic
// button and a road being blocked are not the same event and a queue that
// renders them identically is a queue that gets skimmed.
//
// Resolving is ops-only, enforced server-side. A driver cannot close their own
// breakdown report — someone who could resolve it could also make it disappear.

import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity, Alert,
} from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSpaceColors, spaceHeader } from '../lib/spaces/theme';
import type { Palette } from '../constants/theme';
import { getIncidents, setIncidentStatus, getRuns, type Incident } from '../lib/spaces/api';
import type { Run } from '../lib/spaces/runs';
import { AuroraBackground } from '../components/ui';

const CATEGORY: Record<string, { label: string; icon: keyof typeof Ionicons.glyphMap }> = {
  sos: { label: 'Emergency alert', icon: 'warning' },
  breakdown: { label: 'Breakdown', icon: 'construct-outline' },
  accident: { label: 'Accident', icon: 'alert-circle-outline' },
  route_blocked: { label: 'Road blocked', icon: 'remove-circle-outline' },
  medical: { label: 'Medical', icon: 'medkit-outline' },
  behaviour: { label: 'Behaviour', icon: 'people-outline' },
  other: { label: 'Other', icon: 'ellipsis-horizontal' },
};

export default function SpaceIncidentsScreen() {
  const params = useLocalSearchParams<{ spaceId?: string; name?: string; groupType?: string }>();
  const colors = useSpaceColors(params.groupType);
  const spaceId = String(params.spaceId || '');

  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [inc, rs] = await Promise.all([
        getIncidents(spaceId),
        getRuns(spaceId).catch(() => [] as Run[]),
      ]);
      setIncidents(inc);
      setRuns(rs);
    } catch (e: any) {
      Alert.alert('Could not load incidents', e?.message ?? 'Try again.');
    } finally {
      setLoading(false);
    }
  }, [spaceId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Open first, and an SOS above everything else in it. Resolved ones stay
  // visible below — an incident log that hides what was dealt with is a log
  // nobody can answer questions from afterwards.
  const ordered = useMemo(() => {
    const rank = (i: Incident) =>
      (i.status === 'resolved' ? 100 : 0) + (i.category === 'sos' ? 0 : 10);
    return [...incidents].sort((a, b) =>
      rank(a) - rank(b) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [incidents]);

  const vehicleFor = useCallback(
    (runId: string | null) => runId ? (runs.find((r) => r.id === runId)?.vehicleLabel ?? 'a vehicle') : null,
    [runs],
  );

  const setStatus = useCallback(async (i: Incident, status: 'ack' | 'resolved') => {
    setBusy(i.id);
    try {
      await setIncidentStatus(spaceId, i.id, status);
      await load();
    } catch (e: any) {
      Alert.alert('Could not update', e?.message ?? 'Try again.');
    } finally {
      setBusy(null);
    }
  }, [spaceId, load]);

  const s = styles(colors);

  if (loading) {
    return (
      <View style={[s.screen, s.centre]}>
      <AuroraBackground />
        <Stack.Screen options={spaceHeader(colors, 'Incidents')} />
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.body}>
      <Stack.Screen options={spaceHeader(colors, params.name ? `${params.name} · Incidents` : 'Incidents', { id: spaceId, name: params.name })} />

      {ordered.length === 0 && (
        <View style={s.card}>
          <Text style={s.cardTitle}>Nothing reported</Text>
          <Text style={s.muted}>
            Drivers report breakdowns, accidents and road problems from their run screen.
            Anything they raise appears here.
          </Text>
        </View>
      )}

      {ordered.map((i) => {
        const meta = CATEGORY[i.category] ?? CATEGORY.other;
        const sos = i.category === 'sos';
        const done = i.status === 'resolved';
        const vehicle = vehicleFor(i.runId);
        return (
          <View key={i.id} style={[s.card, sos && !done && s.sosCard, done && s.doneCard]}>
            <View style={s.row}>
              <View style={[s.icon, { backgroundColor: (sos ? colors.danger : colors.primary) + '22' }]}>
                <Ionicons name={meta.icon} size={19} color={sos ? colors.danger : colors.primary} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[s.cardTitle, sos && !done && { color: colors.danger }]} numberOfLines={1}>
                  {meta.label}
                </Text>
                <Text style={s.muted} numberOfLines={1}>
                  {vehicle ? `${vehicle} · ` : ''}{when(i.createdAt)}
                  {done ? ' · resolved' : i.status === 'ack' ? ' · acknowledged' : ''}
                </Text>
              </View>
            </View>

            {/* The note is ciphertext. Saying so is more useful than an empty
                space where an explanation should be. */}
            {i.note && (
              <Text style={s.footnote}>
                The reporter attached a note. It is end-to-end encrypted and readable only
                in the space’s chat, not from this list.
              </Text>
            )}

            {!done && (
              <View style={s.actions}>
                {i.status !== 'ack' && (
                  <TouchableOpacity
                    style={[s.btn, s.ghost]}
                    onPress={() => setStatus(i, 'ack')}
                    disabled={busy === i.id}
                  >
                    <Text style={s.ghostText}>Acknowledge</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  style={[s.btn, s.solid]}
                  onPress={() => setStatus(i, 'resolved')}
                  disabled={busy === i.id}
                >
                  {busy === i.id
                    ? <ActivityIndicator size="small" color="#fff" />
                    : <Text style={s.solidText}>Resolve</Text>}
                </TouchableOpacity>
              </View>
            )}
          </View>
        );
      })}

      <Text style={s.footnote}>
        Acknowledging and resolving are recorded in the space’s audit log. A driver cannot
        resolve their own report — someone who could would also be able to make it vanish.
      </Text>
    </ScrollView>
  );
}

function when(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

const styles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  centre: { alignItems: 'center', justifyContent: 'center' },
  body: { padding: 16, gap: 10, paddingBottom: 40 },
  card: { backgroundColor: c.glassSoft, borderRadius: 14, padding: 14, gap: 8 },
  sosCard: { borderWidth: 1, borderColor: c.danger },
  doneCard: { opacity: 0.6 },
  cardTitle: { color: c.text, fontSize: 15.5, fontWeight: '700' },
  muted: { color: c.textDim, fontSize: 12.5, flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', gap: 8, marginTop: 4 },
  btn: { flex: 1, paddingVertical: 11, borderRadius: 10, alignItems: 'center' },
  ghost: { borderWidth: 1, borderColor: c.glassStroke },
  ghostText: { color: c.text, fontWeight: '600' },
  solid: { backgroundColor: c.primary },
  solidText: { color: '#fff', fontWeight: '700' },
  footnote: { color: c.textFaint, fontSize: 11.5, lineHeight: 16 },
});
