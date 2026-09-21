// app/group-trip.tsx — group trips (Groups & Circles, G5).
//
// Share a destination, see everyone's ETA, and get told when someone leaves the
// route or arrives. Each phone routes itself and shares only the derived
// numbers, so the map here is a convoy status board rather than a second copy
// of everyone's location — presence already governs that, and duplicating it
// would bypass a member's per-group privacy setting.

import React, { useCallback, useMemo, useState } from 'react';
import { KeyboardSafe } from '../components/ui';
import {
  View, StyleSheet, TouchableOpacity, ScrollView, TextInput, Alert,
  ActivityIndicator, Platform,
} from 'react-native';
import * as Location from 'expo-location';
import { Stack, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { AuroraBackground } from '../components/ui/AuroraBackground';
import { AppText as Text } from '../components/ui/Text';
import { circleMembers } from '../lib/family/circle';
import { getCurrentUserAsync } from './(constants)/authService';
import { navigateTo } from '../lib/nav/openNavigation';
import {
  foldParticipants, lastEta, everyoneArrived, minutesUntil,
  type Participant, type TripPing, type Trip,
} from '../lib/groups/trips';
import {
  startTrip, joinTrip, leaveTrip, endTrip, subscribeTrip, currentTrip,
} from '../lib/groups/tripSession';
import { type CircleMember } from '../lib/family/types';

const COORD_RE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

const STATUS_TONE = {
  travelling: 'primary', arrived: 'success', deviated: 'danger', stale: 'dim',
} as const;

const STATUS_LABEL = {
  travelling: 'On the way', arrived: 'Arrived', deviated: 'Off route', stale: 'No signal',
} as const;

export default function GroupTripScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ groupId?: string; name?: string }>();
  const groupId = String(params.groupId || '');
  const groupName = String(params.name || 'the group');

  const [me, setMe] = useState<string | null>(null);
  const [members, setMembers] = useState<CircleMember[]>([]);
  const [trip, setTrip] = useState<Trip | null>(currentTrip());
  const [pings, setPings] = useState<TripPing[]>([]);
  const [where, setWhere] = useState('');
  const [lead, setLead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  useFocusEffect(useCallback(() => {
    let live = true;
    let unsub: (() => void) | null = null;
    (async () => {
      const u = await getCurrentUserAsync().catch(() => null);
      if (!live) return;
      const myId = u ? String(u.id) : null;
      setMe(myId);
      circleMembers(groupId).then((m) => live && setMembers(m)).catch(() => {});
      if (!groupId || !myId) return;
      const off = await subscribeTrip(
        groupId, myId,
        (e) => {
          if (!live) return;
          setPings((prev) => (e.ping
            ? [...prev.filter((p) => p.userId !== e.userId), e.ping]
            : prev.filter((p) => p.userId !== e.userId)));
        },
        // null = the trip ended (or expired) — clear it, don't just ignore it.
        (t) => {
          if (!live) return;
          if (t === null) { setTrip(null); setPings([]); }
          else setTrip((cur) => cur ?? t);
        },
      );
      if (live) unsub = off; else off();
    })();
    // ETAs are relative to now, so re-render on a timer rather than only when a
    // ping lands — a stale "3 min" that never counts down looks broken.
    const timer = setInterval(() => live && setTick((n) => n + 1), 15_000);
    return () => { live = false; clearInterval(timer); unsub?.(); };
  }, [groupId]));

  const names = useMemo(
    () => Object.fromEntries(members.map((m) => [m.id, m.id === me ? 'You' : m.name])),
    [members, me],
  );

  const now = Date.now();
  const participants: Participant[] = useMemo(
    () => foldParticipants(pings, names, Date.now()),
    // tick keeps statuses (notably "no signal") honest as time passes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pings, names, tick],
  );
  const convoyEta = useMemo(() => lastEta(participants), [participants]);
  const done = everyoneArrived(participants);

  const begin = async () => {
    const q = where.trim();
    if (!q || busy || !me) return;
    setBusy(true);
    try {
      let dest: { lat: number; lng: number } | null = null;
      const m = q.match(COORD_RE);
      if (m) dest = { lat: Number(m[1]), lng: Number(m[2]) };
      else {
        const hit = await Location.geocodeAsync(q);
        if (hit[0]) dest = { lat: hit[0].latitude, lng: hit[0].longitude };
      }
      if (!dest) { Alert.alert('Not found', `Could not find "${q}". Try an address, or "lat, lng".`); return; }

      // Leading means everyone measures "on route" against MY road, not their
      // own. Opt-in: silently making the starter the leader would quietly
      // redefine off-route for the whole group.
      const t = await startTrip(groupId, me, dest, q, { leaderId: lead ? me : null });
      setTrip(t);
      setWhere('');
      // Start navigating immediately — a trip nobody is driving is just a pin.
      navigateTo(dest.lat, dest.lng, q);
    } catch (e: any) {
      Alert.alert('Could not start', e?.message ?? 'Try again.');
    } finally { setBusy(false); }
  };

  const join = async () => {
    if (!trip || !me) return;
    try {
      // The sealing key resolves from the harvested announcement inside
      // joinTrip — passing '' here used to make a joiner seal with a key
      // nobody else held.
      await joinTrip(trip, me);
      navigateTo(trip.destination.lat, trip.destination.lng, trip.destinationName);
    } catch (e: any) { Alert.alert('Could not join', e?.message ?? 'Try again.'); }
  };

  const leave = () => {
    Alert.alert('Leave the trip?', 'You stop sharing your ETA. The trip continues for everyone else.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Leave', style: 'destructive', onPress: async () => { await leaveTrip(); setTrip(null); setPings([]); } },
    ]);
  };

  const end = () => {
    Alert.alert('End the trip?', 'The trip is over for everyone in the group.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'End trip', style: 'destructive', onPress: async () => { await endTrip(); setTrip(null); setPings([]); } },
    ]);
  };

  const tone = (t: Participant['status']) => {
    const k = STATUS_TONE[t];
    return k === 'success' ? colors.success : k === 'danger' ? colors.danger
      : k === 'dim' ? colors.textDim : colors.primary;
  };

  return (
    <KeyboardSafe style={{ flex: 1, backgroundColor: colors.bg }}>
      <AuroraBackground variant="chat" />
      <Stack.Screen options={{ headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text, headerShadowVisible: false,
        headerShown: true, /* the root Stack sets headerShown:false app-wide, so the options below were inert and this screen had no back control at all */  title: trip ? 'Trip' : 'Start a trip', headerTitleAlign: 'center' }} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">

        {!trip ? (
          <>
            <Text style={[st.h, { color: colors.text }]}>Where are you all going?</Text>
            <View style={[st.field, { borderColor: colors.glassStroke, backgroundColor: colors.glassSoft }]}>
              <Ionicons name="flag" size={18} color={colors.textDim} />
              <TextInput value={where} onChangeText={setWhere} placeholder="Address, place, or lat, lng"
                placeholderTextColor={colors.textFaint} style={[st.input, { color: colors.text }]}
                autoCapitalize="none" returnKeyType="go" onSubmitEditing={begin} />
            </View>
            <TouchableOpacity onPress={() => setLead((v) => !v)}
              style={[st.lead, { borderColor: lead ? colors.primary : colors.border, backgroundColor: lead ? colors.primary + '14' : 'transparent' }]}>
              <Ionicons name={lead ? 'checkbox' : 'square-outline'} size={19} color={lead ? colors.primary : colors.textFaint} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13.5 }}>Everyone follows my route</Text>
                <Text style={{ color: colors.textDim, fontSize: 12, marginTop: 2, lineHeight: 16 }}>
                  Off-route warnings are measured against the road you take. Without this each
                  phone judges itself against its own route.
                </Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity onPress={begin} disabled={!where.trim() || busy}
              style={[st.btn, { backgroundColor: where.trim() && !busy ? colors.primary : colors.border }]}>
              {busy ? <ActivityIndicator color="#fff" />
                : <><Ionicons name="navigate" size={18} color="#fff" /><Text style={st.btnTxt}>Start trip</Text></>}
            </TouchableOpacity>
            <Text style={{ color: colors.textDim, fontSize: 12.5, marginTop: 14, lineHeight: 18 }}>
              Everyone in {groupName} is invited to join. Each phone works out its own arrival time —
              only the ETA is shared, never a second copy of your location.
            </Text>
          </>
        ) : (
          <>
            <View style={[st.dest, { backgroundColor: colors.glassSoft, borderColor: done ? colors.success : colors.primary }]}>
              <View style={[st.destIcon, { backgroundColor: (done ? colors.success : colors.primary) + '22' }]}>
                <Ionicons name={done ? 'checkmark-done' : 'flag'} size={20} color={done ? colors.success : colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15 }} numberOfLines={1}>
                  {trip.destinationName}
                </Text>
                <Text style={{ color: colors.textDim, fontSize: 12.5 }}>
                  {done ? 'Everyone has arrived'
                    : convoyEta != null ? `All in by about ${minutesUntil(convoyEta, now)} min`
                    : 'Waiting for ETAs…'}
                </Text>
                {!!trip.leaderId && (
                  <Text style={{ color: colors.primary, fontSize: 11.5, marginTop: 2 }}>
                    Following {trip.leaderId === me ? 'your' : `${names[trip.leaderId] ?? 'the leader'}'s`} route
                  </Text>
                )}
              </View>
            </View>

            <View style={st.actions}>
              <TouchableOpacity onPress={join} style={[st.action, { borderColor: colors.glassStroke, backgroundColor: colors.glassSoft }]}>
                <Ionicons name="navigate" size={18} color={colors.primary} />
                <Text style={[st.actionTxt, { color: colors.text }]}>Navigate</Text>
              </TouchableOpacity>
              {/* The starter ends it for everyone; anyone else can only leave. */}
              {trip.startedBy === me ? (
                <TouchableOpacity onPress={end} style={[st.action, { borderColor: colors.danger, backgroundColor: colors.danger + '12' }]}>
                  <Ionicons name="flag-outline" size={18} color={colors.danger} />
                  <Text style={[st.actionTxt, { color: colors.danger }]}>End trip</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity onPress={leave} style={[st.action, { borderColor: colors.danger, backgroundColor: colors.danger + '12' }]}>
                  <Ionicons name="exit-outline" size={18} color={colors.danger} />
                  <Text style={[st.actionTxt, { color: colors.danger }]}>Leave</Text>
                </TouchableOpacity>
              )}
            </View>

            <Text style={[st.h, { color: colors.text, marginTop: 26 }]}>
              {participants.length ? `${participants.length} on the way` : 'Nobody sharing yet'}
            </Text>

            {participants.length === 0 && (
              <Text style={{ color: colors.textDim, fontSize: 13.5 }}>
                ETAs appear as members join and start moving.
              </Text>
            )}

            {participants.map((p) => (
              <View key={p.userId} style={[st.row, { borderColor: colors.glassStroke }]}>
                <View style={[st.dot, { backgroundColor: tone(p.status) + '22' }]}>
                  <Ionicons
                    name={p.status === 'arrived' ? 'checkmark' : p.status === 'deviated' ? 'git-branch'
                      : p.status === 'stale' ? 'cloud-offline-outline' : 'car'}
                    size={16} color={tone(p.status)}
                  />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ color: colors.text, fontWeight: '600', fontSize: 14 }} numberOfLines={1}>{p.name}</Text>
                  <Text style={{ color: tone(p.status), fontSize: 11.5 }}>{STATUS_LABEL[p.status]}</Text>
                </View>
                <Text style={{ color: colors.text, fontSize: 13, fontWeight: '700' }}>
                  {p.status === 'arrived' ? '—'
                    : p.etaAt != null ? `${minutesUntil(p.etaAt, now)} min`
                    : '·'}
                </Text>
              </View>
            ))}

            <Text style={{ color: colors.textFaint, fontSize: 11.5, marginTop: 18, lineHeight: 16 }}>
              A dash means they are already there. A dot means their phone has not worked out an
              arrival time yet — it is never a guess.
            </Text>
          </>
        )}
      </ScrollView>
    </KeyboardSafe>
  );
}

const st = StyleSheet.create({
  h: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 10 },
  field: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, minHeight: 50 },
  input: { flex: 1, fontSize: 15 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 50, borderRadius: 13, marginTop: 14 },
  lead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 13, borderWidth: 1, borderRadius: 13, marginTop: 14 },
  btnTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },
  dest: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderWidth: 1, borderRadius: 16 },
  destIcon: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', gap: 9, marginTop: 12 },
  // 2026-09-18: 13.5sp label in a pinned 48 clips at font scale 1.5; minHeight
  // is the same 48 at scale 1.0. Icon-only `dot`/`destIcon` stay square.
  action: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, minHeight: 48, paddingVertical: 8, borderWidth: 1, borderRadius: 13 },
  actionTxt: { fontSize: 13.5, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  dot: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
});
