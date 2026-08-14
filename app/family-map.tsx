// app/family-map.tsx — the Family space's full-screen live map, standalone.
//
// lib/spaces/layout.ts has routed the family/generic 'map' section here since
// the section lists existed, but the screen never did — the route 404'd if
// anything rendered those sections. It is the same map the hub shows expanded,
// as its own screen: subscribe to the circle's sealed presence, decrypt, draw.
//
// READ-ONLY BY DESIGN: this screen never starts publishing our own location.
// Sharing stays a deliberate switch on the hub (and is off by default), so
// opening a map must not prompt for a permission or broadcast anything.

import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useTheme } from '../lib/theme';
import FamilyMap, { type FamilyMarker } from '../components/family/FamilyMap';
import { circleMembers } from '../lib/family/circle';
import { subscribeCircle, type PresenceEvent } from '../lib/family/presence';
import { freshnessOf, foldPresence, markSharingOff, type Freshness } from '../lib/family/status';
import { subscribeSpaceLocations, mergePresence } from '../lib/location/live';
import { type CircleMember, type MemberPresence } from '../lib/family/types';
import { getCurrentUserAsync } from './(constants)/authService';

const AGO = (ms: number) => {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return `${h} h ago`;
};

/** Honest per-member line: never "LIVE" without a fresh fix, and an explicit
 *  sharing-off outranks freshness however new the retained fix is. */
const freshLabel = (f: Freshness, ts?: number, now?: number, sharingOff?: boolean): string => {
  if (sharingOff) return ts && now ? `Sharing off · last seen ${AGO(now - ts)}` : 'Location sharing off';
  switch (f) {
    case 'live': return 'LIVE';
    case 'recent': return ts && now ? AGO(now - ts) : 'recent';
    case 'stale': return ts && now ? `Last known · ${AGO(now - ts)}` : 'last known';
    default: return 'Location unavailable';
  }
};

export default function FamilyMapScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ circleId?: string; circleName?: string }>();
  const circleId = String(params.circleId || '');

  const [me, setMe] = useState<string | null>(null);
  const [members, setMembers] = useState<CircleMember[]>([]);
  const [membersLoaded, setMembersLoaded] = useState(false);
  const [presences, setPresences] = useState<Record<string, MemberPresence>>({});
  const [focusId, setFocusId] = useState<string | null>(null);
  // Render tick so "LIVE" decays to "5 min ago" without a new ping arriving.
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);

  useEffect(() => {
    if (!circleId) return;
    let live = true;
    let off: (() => void) | null = null;
    (async () => {
      const u = await getCurrentUserAsync().catch(() => null);
      if (!live) return;
      const myId = u ? String(u.id) : null;
      setMe(myId);
      circleMembers(circleId)
        .then((m) => { if (live) { setMembers(m); setMembersLoaded(true); } })
        .catch(() => { /* keep "still loading" rather than asserting an empty roster */ });
      if (!myId) return;
      try {
        const un = await subscribeCircle(circleId, myId, (e: PresenceEvent) => {
          if (!live) return;
          setPresences((prev) => (e.presence
            ? mergePresence(prev, {
              userId: e.userId, lat: e.presence.pos.lat, lng: e.presence.pos.lng,
              ts: e.presence.ts, spd: e.presence.speed, acc: e.presence.accuracy, bat: e.presence.battery,
            })
            : markSharingOff(prev, e.userId)));
        });
        if (live) off = un; else un();
      } catch { /* map degrades to "nobody live yet" */ }
      // Dedicated location service (no chat-E2EE dependency): snapshot + live.
      try {
        const un2 = await subscribeSpaceLocations(circleId, myId, (e) => {
          if (!live) return;
          setPresences((prev) => (e.point
            ? mergePresence(prev, {
              userId: e.userId, lat: e.point.pos.lat, lng: e.point.pos.lng,
              ts: e.point.ts, spd: e.point.speed, acc: e.point.accuracy, bat: e.point.battery,
            })
            : markSharingOff(prev, e.userId)));
        });
        if (live) { const prevOff = off; off = () => { prevOff?.(); un2(); }; } else un2();
      } catch { /* platform absent — sealed relay stands alone */ }
    })();
    return () => { live = false; off?.(); };
  }, [circleId]);

  const nameOf = useMemo(() => new Map(members.map((m) => [m.id, m.name])), [members]);
  const markers: FamilyMarker[] = useMemo(() => Object.entries(presences)
    .filter(([, p]) => freshnessOf(p.ts, now) !== 'unavailable')
    .map(([uid, p]) => ({
      id: uid,
      name: uid === me ? 'You' : (nameOf.get(uid) || 'Member'),
      lat: p.pos.lat, lng: p.pos.lng, battery: p.battery,
      self: uid === me,
      stale: freshnessOf(p.ts, now) !== 'live' || !!p.sharingOff,
    })), [presences, nameOf, me, now]);

  if (!circleId) {
    return (
      <View style={[st.center, { backgroundColor: colors.bg }]}>
        <Stack.Screen options={{ headerShown: true, title: 'Live map' }} />
        <Text style={{ color: colors.textDim }}>Open this map from a space.</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{
        headerShown: true,
        title: params.circleName ? `${params.circleName} · Live map` : 'Live map',
        headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text,
        headerShadowVisible: false,
      }} />
      <FamilyMap members={markers} focusId={focusId} onSelect={(id) => setFocusId(id)} style={{ flex: 1 }} />
      <View style={[st.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
        {!membersLoaded ? (
          <View style={st.center}><ActivityIndicator color={colors.primary} /></View>
        ) : (
          <ScrollView style={{ maxHeight: 210 }} contentContainerStyle={{ paddingBottom: 6 }}>
            {members.map((m) => {
              const p = presences[m.id];
              const f = freshnessOf(p?.ts, now);
              const liveNow = f === 'live' && !p?.sharingOff;
              return (
                <Text
                  key={m.id}
                  onPress={() => p && setFocusId(m.id)}
                  style={[st.row, { color: colors.text, borderTopColor: colors.border }]}
                >
                  <Text style={{ color: liveNow ? colors.success : colors.textFaint }}>● </Text>
                  {m.id === me ? 'You' : m.name}
                  <Text style={{ color: liveNow ? colors.success : colors.textDim, fontSize: 12 }}>
                    {'   '}{freshLabel(f, p?.ts, now, p?.sharingOff)}
                  </Text>
                </Text>
              );
            })}
            {members.length === 0 && (
              <Text style={{ color: colors.textDim, padding: 12, textAlign: 'center' }}>
                Nobody here yet.
              </Text>
            )}
          </ScrollView>
        )}
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  sheet: {
    borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1,
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 14,
  },
  row: { paddingVertical: 10, fontSize: 14.5, fontWeight: '600', borderTopWidth: StyleSheet.hairlineWidth },
});
