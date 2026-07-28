// app/family.tsx — the Family Circle hero screen (Life360-style). A live map of
// everyone who's sharing + a roster with last-seen/distance, a sharing toggle, an
// SOS, Places (geofences) and invite. All positions are E2EE: the server relays
// sealed blobs and stores nothing readable. See lib/family/presence.ts.

import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert, ActivityIndicator, Share, Switch } from 'react-native';
import * as Location from 'expo-location';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import FamilyMap, { type FamilyMarker } from '../components/family/FamilyMap';
import { listCircles, getSettings, setSettings, type CircleRef } from '../lib/family/store';
import { circleMembers, circleInviteCode } from '../lib/family/circle';
import { startPresence, stopPresence, setSharing, subscribeCircle, type PresenceEvent } from '../lib/family/presence';
import { type CircleMember, type MemberPresence, STALE_MS } from '../lib/family/types';
import { sendMessage } from '../lib/chatService';
import { getCurrentUserAsync } from './(constants)/authService';
import { navigateTo } from '../lib/nav/openNavigation';
import { haversine } from '../lib/nav/geo';

function ago(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function dist(m: number): string { return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`; }

export default function FamilyScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const [me, setMe] = useState<{ id: string; name: string } | null>(null);
  const [circles, setCircles] = useState<CircleRef[]>([]);
  const [active, setActive] = useState<CircleRef | null>(null);
  const [members, setMembers] = useState<CircleMember[]>([]);
  const [presences, setPresences] = useState<Record<string, MemberPresence>>({});
  const [share, setShare] = useState(false);
  const [loading, setLoading] = useState(true);
  const [focusId, setFocusId] = useState<string | null>(null);

  // identity + circle list
  useEffect(() => { (async () => {
    const u = await getCurrentUserAsync().catch(() => null);
    setMe(u ? { id: String(u.id), name: u.name || u.email || 'Me' } : null);
    const cs = await listCircles();
    setCircles(cs);
    if (!cs.length) { router.replace('/family-setup' as any); return; }
    setActive((prev) => prev ?? cs[0]);
    setShare((await getSettings()).sharing);
    setLoading(false);
  })(); }, []);

  // members for the active circle
  useEffect(() => { if (active) circleMembers(active.id).then(setMembers).catch(() => {}); }, [active?.id]);

  // presence (broadcast self + receive others) for the active circle
  useEffect(() => {
    if (!active || !me) return;
    let unsub: (() => void) | null = null, cancelled = false;
    setPresences({});
    (async () => {
      try {
        await startPresence({ circleIds: [active.id], myId: me.id, myName: me.name, share, onSelf: (p) => setPresences((prev) => ({ ...prev, [p.userId]: p })) });
        const u = await subscribeCircle(active.id, me.id, (e: PresenceEvent) => {
          if (cancelled) return;
          setPresences((prev) => { const n = { ...prev }; if (e.presence) n[e.userId] = e.presence; else delete n[e.userId]; return n; });
        });
        if (cancelled) u(); else unsub = u;
      } catch (err: any) { if (!cancelled) Alert.alert('Family Circle', err?.message ?? 'Could not start location.'); }
    })();
    return () => { cancelled = true; unsub?.(); stopPresence(); };
  }, [active?.id, me?.id]);

  // stop broadcasting when the screen loses focus (map still resumes on return)
  useFocusEffect(React.useCallback(() => () => { stopPresence(); }, []));

  const toggleShare = async (v: boolean) => {
    setShare(v);
    await setSettings({ sharing: v });
    try { await setSharing(v); } catch {}
  };

  const markers: FamilyMarker[] = useMemo(() => {
    const now = Date.now();
    const nameById = new Map(members.map((m) => [m.id, m.name]));
    return Object.entries(presences).map(([uid, p]) => ({
      id: uid, name: uid === me?.id ? 'You' : (nameById.get(uid) || 'Member'),
      lat: p.pos.lat, lng: p.pos.lng, self: uid === me?.id, stale: now - p.ts > STALE_MS,
    }));
  }, [presences, members, me?.id]);

  const invite = async () => {
    if (!active) return;
    try {
      const code = await circleInviteCode(active.id);
      await Share.share({ message: `Join my Family Circle "${active.name}" on VaultChat.\nCode: ${code}` });
    } catch (e: any) { Alert.alert('Invite', e?.message ?? 'Could not create an invite.'); }
  };

  const sos = () => {
    if (!active || !me) return;
    Alert.alert('Send SOS?', `Alert everyone in "${active.name}" and share your live location.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Send SOS', style: 'destructive', onPress: async () => {
        try {
          await toggleShare(true);
          let where = '';
          try { const c = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }); where = ` (${c.coords.latitude.toFixed(5)}, ${c.coords.longitude.toFixed(5)})`; } catch {}
          await sendMessage(active.id, `🆘 ${me.name} triggered an SOS — please respond${where}`, 'system');
          Alert.alert('SOS sent', 'Your circle has been alerted and your live location is on.');
        } catch (e: any) { Alert.alert('SOS', e?.message ?? 'Could not send SOS.'); }
      } },
    ]);
  };

  if (loading) return <View style={[st.center, { backgroundColor: colors.bg }]}><ActivityIndicator color={colors.primary} /></View>;

  const mine = me ? presences[me.id] : undefined;
  const roster = members.length ? members : (me ? [{ id: me.id, name: 'You', role: 'guardian' as const, avatar: null }] : []);

  return (
    <View style={[st.screen, { backgroundColor: colors.bg }]}>
      <Stack.Screen options={{ title: active?.name || 'Family Circle', headerTitleAlign: 'center',
        headerRight: () => <TouchableOpacity onPress={invite} style={{ paddingHorizontal: 6 }}><Ionicons name="person-add" size={20} color={colors.primary} /></TouchableOpacity> }} />

      {/* circle switcher */}
      {circles.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={st.switcher}>
          {circles.map((c) => (
            <TouchableOpacity key={c.id} onPress={() => setActive(c)}
              style={[st.chip, { borderColor: active?.id === c.id ? colors.primary : colors.border, backgroundColor: active?.id === c.id ? colors.primary + '1a' : 'transparent' }]}>
              <Text style={{ color: active?.id === c.id ? colors.primary : colors.text, fontWeight: active?.id === c.id ? '700' : '500', fontSize: 13 }}>{c.name}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      <View style={{ flex: 1 }}>
        <FamilyMap members={markers} focusId={focusId} onSelect={(id) => setFocusId(id)} style={{ flex: 1 }} />
      </View>

      {/* roster */}
      <View style={[st.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={st.shareRow}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Ionicons name={share ? 'navigate' : 'navigate-outline'} size={18} color={share ? colors.primary : colors.textDim} />
            <Text style={{ color: colors.text, fontWeight: '600' }}>Share my location</Text>
          </View>
          <Switch value={share} onValueChange={toggleShare} trackColor={{ true: colors.primary }} />
        </View>

        <ScrollView style={{ maxHeight: 190 }} contentContainerStyle={{ paddingBottom: 6 }}>
          {roster.map((m) => {
            const p = presences[m.id];
            const isMe = m.id === me?.id;
            const d = p && mine && !isMe ? dist(haversine(mine.pos, p.pos)) : null;
            return (
              <View key={m.id} style={[st.row, { borderColor: colors.border }]}>
                <View style={[st.dot, { backgroundColor: p ? colors.primary : colors.border }]}>
                  <Text style={st.dotTxt}>{(m.name || '?').trim()[0]?.toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.text, fontWeight: '600' }} numberOfLines={1}>{isMe ? 'You' : m.name}</Text>
                  <Text style={{ color: colors.textDim, fontSize: 12 }} numberOfLines={1}>
                    {p ? `${ago(p.ts)}${d ? ` · ${d} away` : ''}${p.speed && p.speed > 3 ? ' · moving' : ''}` : 'Location off'}
                  </Text>
                </View>
                {p && (
                  <TouchableOpacity onPress={() => setFocusId(m.id)} style={st.rowBtn}><Ionicons name="locate" size={18} color={colors.primary} /></TouchableOpacity>
                )}
                {p && !isMe && (
                  <TouchableOpacity onPress={() => navigateTo(p.pos.lat, p.pos.lng, m.name)} style={st.rowBtn}><Ionicons name="navigate-circle" size={20} color={colors.primary} /></TouchableOpacity>
                )}
              </View>
            );
          })}
        </ScrollView>

        {/* action bar */}
        <View style={st.actions}>
          <TouchableOpacity onPress={() => active && router.push({ pathname: '/family-places' as any, params: { circleId: active.id, name: active.name } })} style={[st.action, { borderColor: colors.border }]}>
            <Ionicons name="location" size={18} color={colors.primary} /><Text style={[st.actionTxt, { color: colors.text }]}>Places</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={invite} style={[st.action, { borderColor: colors.border }]}>
            <Ionicons name="person-add" size={18} color={colors.primary} /><Text style={[st.actionTxt, { color: colors.text }]}>Invite</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={sos} style={[st.action, { borderColor: colors.danger, backgroundColor: colors.danger + '14' }]}>
            <Ionicons name="alert-circle" size={18} color={colors.danger} /><Text style={[st.actionTxt, { color: colors.danger, fontWeight: '800' }]}>SOS</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  switcher: { gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7 },
  sheet: { borderTopWidth: 1, borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 14, gap: 6 },
  shareRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth },
  dot: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  dotTxt: { color: '#fff', fontWeight: '800' },
  rowBtn: { padding: 6 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 8 },
  action: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 44, borderWidth: 1, borderRadius: 12 },
  actionTxt: { fontSize: 14, fontWeight: '600' },
});
