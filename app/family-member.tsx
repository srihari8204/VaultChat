// app/family-member.tsx — Family Space member detail (mockup screen 7).
//
// Before this screen the only thing you could do with a member was long-press the
// roster row for an Alert() of admin actions. This is the per-person view: where
// they are, how much battery they have left, what they have done today, which
// place they are sitting in, and the four actions the mockup puts on a member
// (Message / Call / Route / History).
//
// It is self-sufficient: position comes from the local history store (which
// presence.ts fills from already-decrypted pings), so the screen works without
// having to re-plumb the parent's live subscription through navigation params.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert, ActivityIndicator } from 'react-native';
import { Stack, useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { brandAlpha } from '../constants/theme';
import { getTrack, summarize, type TrackSample } from '../lib/family/history';
import { useFamilyAlerts, loadAlerts, type FamilyAlert } from '../lib/family/alerts';
import { getPlaces } from '../lib/family/store';
import { type Geofence } from '../lib/family/geofence';
import { createDirectChat } from '../lib/chatService';
import { navigateTo } from '../lib/nav/openNavigation';
import { haversine } from '../lib/nav/geo';
import { STALE_MS } from '../lib/family/types';
// v3 — shared Location Lock engine classifiers/formatters (same bands as Navigate)
import { classifyDistance, zoneColor } from '../lib/lock/zoneMachine';
import { fmtSpeed, gpsQuality, QUALITY_LABEL, QUALITY_COLOR } from '../lib/lock/format';
import { timeAtPlace } from '../lib/family/history';

const REFRESH_MS = 15_000;
const AVATAR_COLORS = ['#4A9FFF', '#EC4899', '#22C55E', '#F59E0B', '#A855F7', '#EF4444', '#14B8A6', '#F97316'];
const colorFor = (id: string) => AVATAR_COLORS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length];

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function ago(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
const dist = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

const ICON_FOR: Record<string, keyof typeof Ionicons.glyphMap> = {
  enter: 'enter-outline', leave: 'exit-outline', sos: 'alert-circle',
  checkin: 'checkmark-done-circle', battery: 'battery-dead', sharing: 'navigate-circle',
};

export default function FamilyMemberScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{
    circleId?: string; circleName?: string; userId?: string; name?: string; role?: string;
  }>();
  const circleId = String(params.circleId || '');
  const userId = String(params.userId || '');
  const name = String(params.name || 'Member');
  const isGuardian = params.role === 'guardian';

  const [today, setToday] = useState<TrackSample[]>([]);
  const [places, setPlaces] = useState<Geofence[]>([]);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);

  const alerts = useFamilyAlerts(circleId || null, 'all');
  useEffect(() => { loadAlerts(); }, []);

  const pull = useCallback(async () => {
    if (!circleId || !userId) { setLoading(false); return; }
    const [track, ps] = await Promise.all([
      getTrack(circleId, { from: startOfToday(), userId }),
      getPlaces(circleId),
    ]);
    setToday(track);
    setPlaces(ps);
    setLoading(false);
  }, [circleId, userId]);

  // Poll while focused: presence.ts keeps writing pings into history behind us.
  useFocusEffect(useCallback(() => {
    let live = true;
    const tick = () => { if (live) pull(); };
    tick();
    const t = setInterval(tick, REFRESH_MS);
    return () => { live = false; clearInterval(t); };
  }, [pull]));

  const last = today.length ? today[today.length - 1] : null;
  const fresh = !!last && Date.now() - last.ts <= STALE_MS;
  const stats = useMemo(() => summarize(today), [today]);

  // Which place are they sitting in right now?
  const currentPlace = useMemo(() => {
    if (!last) return null;
    return places.find((p) =>
      p.enabled !== false && haversine(p.center, { lat: last.lat, lng: last.lng }) <= p.radiusM,
    ) ?? null;
  }, [last, places]);

  const todaysActivity = useMemo(
    () => alerts.filter((a: FamilyAlert) => a.actorId === userId && a.at >= startOfToday()),
    [alerts, userId],
  );

  const openDirect = async (target: 'chat' | 'voicecall') => {
    if (!userId || opening) return;
    setOpening(true);
    try {
      const chat = await createDirectChat({ userId });
      router.push(target === 'chat'
        ? { pathname: '/chat' as any, params: { id: chat.id } }
        : { pathname: '/voicecall' as any, params: { chatId: chat.id, peerUid: userId, peerName: name } });
    } catch (e: any) {
      Alert.alert(target === 'chat' ? 'Message' : 'Call', e?.message ?? 'Could not open a direct chat.');
    } finally { setOpening(false); }
  };

  const route = () => {
    if (!last) { Alert.alert('No location', `${name} is not sharing a location right now.`); return; }
    navigateTo(last.lat, last.lng, name);
  };

  const action = (icon: keyof typeof Ionicons.glyphMap, label: string, onPress: () => void, tint?: string) => (
    <TouchableOpacity onPress={onPress} style={[st.action, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Ionicons name={icon} size={20} color={tint ?? colors.primary} />
      <Text style={[st.actionTxt, { color: colors.text }]}>{label}</Text>
    </TouchableOpacity>
  );

  if (loading) {
    return <View style={[st.center, { backgroundColor: colors.bg }]}><ActivityIndicator color={colors.primary} /></View>;
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: name, headerTitleAlign: 'center' }} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>

        {/* identity card */}
        <View style={[st.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={[st.avatar, { backgroundColor: colorFor(userId) }]}>
            <Text style={st.avatarTxt}>{name.trim()[0]?.toUpperCase() ?? '?'}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={{ color: colors.text, fontSize: 17, fontWeight: '800' }} numberOfLines={1}>{name}</Text>
              {isGuardian && <Ionicons name="star" size={13} color={colors.primary} />}
            </View>
            <Text style={{ color: fresh ? colors.success : colors.textDim, fontSize: 12.5, marginTop: 2 }}>
              {last ? (fresh ? 'Online' : `Last seen ${ago(last.ts)}`) : 'Location off'}
              {currentPlace ? ` · at ${currentPlace.name}` : ''}
            </Text>
          </View>
          {last?.bat != null && (
            <View style={{ alignItems: 'center' }}>
              <Ionicons
                name={last.bat <= 20 ? 'battery-dead' : 'battery-half'}
                size={20}
                color={last.bat <= 20 ? colors.danger : colors.textDim}
              />
              <Text style={{ color: last.bat <= 20 ? colors.danger : colors.textDim, fontSize: 11, fontWeight: '700' }}>
                {Math.round(last.bat)}%
              </Text>
            </View>
          )}
        </View>

        {/* actions */}
        <View style={st.actions}>
          {action('chatbubble-ellipses', 'Message', () => openDirect('chat'))}
          {action('call', 'Call', () => openDirect('voicecall'))}
          {action('navigate-circle', 'Route', route)}
          {action('time', 'History', () => router.push({
            pathname: '/family-history' as any,
            params: { circleId, name, userId, circleName: params.circleName ?? '' },
          }))}
        </View>

        {/* today at a glance */}
        <Text style={[st.h, { color: colors.text }]}>Today</Text>
        <View style={[st.statRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={st.stat}>
            <Text style={[st.statVal, { color: colors.text }]}>{dist(stats.distanceM)}</Text>
            <Text style={[st.statLbl, { color: colors.textDim }]}>Travelled</Text>
          </View>
          <View style={[st.statDiv, { backgroundColor: colors.border }]} />
          <View style={st.stat}>
            <Text style={[st.statVal, { color: colors.text }]}>{Math.round(stats.maxSpeed * 3.6)} km/h</Text>
            <Text style={[st.statLbl, { color: colors.textDim }]}>Top speed</Text>
          </View>
          <View style={[st.statDiv, { backgroundColor: colors.border }]} />
          <View style={st.stat}>
            <Text style={[st.statVal, { color: colors.text }]}>{todaysActivity.length}</Text>
            <Text style={[st.statLbl, { color: colors.textDim }]}>Events</Text>
          </View>
        </View>

        {/* activity timeline */}
        <Text style={[st.h, { color: colors.text, marginTop: 22 }]}>Today&apos;s Activity</Text>
        {todaysActivity.length === 0 ? (
          <Text style={{ color: colors.textDim, fontSize: 13.5 }}>
            Nothing yet today. Arrivals, departures and check-ins show up here.
          </Text>
        ) : todaysActivity.map((a) => (
          <View key={a.id} style={[st.evt, { borderColor: colors.border }]}>
            <View style={[st.evtIcon, { backgroundColor: brandAlpha(0.1) }]}>
              <Ionicons
                name={ICON_FOR[a.kind] ?? 'ellipse'}
                size={15}
                color={a.sev === 'critical' ? colors.danger : colors.primary}
              />
            </View>
            <Text style={{ color: colors.text, fontSize: 13.5, flex: 1 }} numberOfLines={2}>{a.text}</Text>
            <Text style={{ color: colors.textDim, fontSize: 11.5 }}>{clock(a.at)}</Text>
          </View>
        ))}

        {/* location diagnostics (v3) — same data language as the lock engine */}
        {last && (
          <View style={[st.evt, { borderColor: colors.border }]}>
            <View style={[st.evtIcon, { backgroundColor: brandAlpha(0.1) }]}>
              <Ionicons name="speedometer" size={15} color={colors.primary} />
            </View>
            <Text style={{ color: colors.text, fontSize: 13.5, flex: 1 }}>
              {fmtSpeed((last.spd ?? 0) * 3.6)} · updated {ago(last.ts)}
              {last.bat != null ? ` · battery ${Math.round(last.bat)}%` : ''}
            </Text>
            {last.acc != null && (
              <View style={{ borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, backgroundColor: QUALITY_COLOR[gpsQuality(last.acc)] + '22' }}>
                <Text style={{ color: QUALITY_COLOR[gpsQuality(last.acc)], fontSize: 10.5, fontWeight: '800' }}>
                  GPS {QUALITY_LABEL[gpsQuality(last.acc)].toUpperCase()} ±{Math.round(last.acc)}m
                </Text>
              </View>
            )}
          </View>
        )}

        {/* places — zone status per place from the SHARED classifier, so a
            member's chip means exactly what Navigate's lock states mean */}
        <Text style={[st.h, { color: colors.text, marginTop: 22 }]}>Safe Zones</Text>
        {places.length === 0 ? (
          <Text style={{ color: colors.textDim, fontSize: 13.5 }}>
            No places yet. Add one in Places to get arrive/leave alerts.
          </Text>
        ) : places.map((p) => {
          const here = currentPlace?.id === p.id;
          const d = last ? haversine(p.center, { lat: last.lat, lng: last.lng }) : null;
          const zone = d != null && fresh ? classifyDistance(d, p.radiusM) : null;
          const zc = zone ? zoneColor(zone) : colors.textFaint;
          const zoneLabel = zone === 'safe' ? 'INSIDE' : zone === 'warning' ? 'NEAR EDGE' : zone === 'atLimit' ? 'AT LIMIT' : zone === 'outside' ? 'OUTSIDE' : null;
          // Today's time at this place from the presence track (v3 statistics).
          const tp = timeAtPlace(today, p);
          const tpTxt = tp.timeMs > 0
            ? ` · ${tp.timeMs >= 3_600_000 ? `${Math.floor(tp.timeMs / 3_600_000)}h ${Math.round((tp.timeMs % 3_600_000) / 60_000)}m` : `${Math.max(1, Math.round(tp.timeMs / 60_000))}m`} today${tp.firstArrival ? `, arrived ${clock(tp.firstArrival)}` : ''}`
            : '';
          return (
            <View key={p.id} style={[st.evt, { borderColor: colors.border }]}>
              <View style={[st.evtIcon, { backgroundColor: (here ? colors.success : colors.textFaint) + '22' }]}>
                <Ionicons name="location" size={15} color={here ? colors.success : colors.textDim} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }}>{p.name}</Text>
                <Text style={{ color: colors.textDim, fontSize: 11.5 }}>
                  {p.enabled === false ? 'Alerts off' : `${p.radiusM} m radius`}
                  {d != null ? ` · ${dist(d)} away` : ''}{tpTxt}
                </Text>
              </View>
              {zoneLabel && (
                <View style={{ borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, backgroundColor: zc + '22' }}>
                  <Text style={{ color: zc, fontSize: 10.5, fontWeight: '800' }}>{zoneLabel}</Text>
                </View>
              )}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: 16, padding: 14 },
  avatar: { width: 50, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center' },
  avatarTxt: { color: '#fff', fontWeight: '800', fontSize: 20 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 14 },
  action: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 5, height: 62, borderWidth: 1, borderRadius: 13 },
  actionTxt: { fontSize: 11.5, fontWeight: '600' },
  h: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3, marginTop: 24, marginBottom: 10 },
  statRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 14, paddingVertical: 14 },
  stat: { flex: 1, alignItems: 'center', gap: 3 },
  statVal: { fontSize: 15, fontWeight: '800' },
  statLbl: { fontSize: 11 },
  statDiv: { width: 1, height: 28 },
  evt: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth },
  evtIcon: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
});
