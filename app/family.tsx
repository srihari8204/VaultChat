// app/family.tsx — Family Space: the single hub that absorbed the old Family
// Circle + SOS mini-apps (mockup screen 5). One screen, two modes:
//   dashboard — greeting, status card, map preview, quick tiles, hold-to-SOS,
//               members, today's highlights (decrypted check-ins/SOS)
//   expanded  — full-screen live map + roster sheet
// Circle CRUD (rename/roles/remove/leave/delete) lives in the ⋯ manage sheet;
// all of it rides existing group endpoints. Positions stay E2EE end to end.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert, ActivityIndicator,
  Share, Switch, Modal, TextInput, Animated, Vibration, Pressable, KeyboardAvoidingView, Platform,
} from 'react-native';
import * as Location from 'expo-location';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { brandAlpha } from '../constants/theme';
import FamilyMap, { type FamilyMarker } from '../components/family/FamilyMap';
import { listCircles, getSettings, setSettings, type CircleRef } from '../lib/family/store';
import {
  circleMembers, circleInviteCode, renameCircle, leaveCircle, deleteCircle,
  removeCircleMember, setGuardian,
} from '../lib/family/circle';
import { startPresence, stopPresence, setSharing, subscribeCircle, type PresenceEvent } from '../lib/family/presence';
import { type CircleMember, type MemberPresence, STALE_MS } from '../lib/family/types';
import { sendMessage, getMessages, decryptFromChat } from '../lib/chatService';
import { getCurrentUserAsync } from './(constants)/authService';
import { navigateTo } from '../lib/nav/openNavigation';
import { haversine } from '../lib/nav/geo';

const SOS_HOLD_MS = 1500;
const AVATAR_COLORS = ['#4A9FFF', '#EC4899', '#22C55E', '#F59E0B', '#A855F7', '#EF4444', '#14B8A6', '#F97316'];
const colorFor = (id: string) => AVATAR_COLORS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length];

const CHECKINS: { label: string; emoji: string; color: string }[] = [
  { label: "I'm Safe",     emoji: '✅', color: '#22C55E' },
  { label: 'On My Way',    emoji: '🚗', color: '#4A9FFF' },
  { label: 'Running Late', emoji: '⏳', color: '#F59E0B' },
  { label: 'Need Help',    emoji: '🆘', color: '#EF4444' },
];
// Family Space message prefixes — used to pick highlights out of the circle chat.
const HIGHLIGHT_RE = /^(🆘|✅|🚗|⏳)/;

function ago(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function dist(m: number): string { return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`; }
function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

interface Highlight { icon: string; text: string; at: number }

export default function FamilySpaceScreen() {
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
  const [expanded, setExpanded] = useState(false);
  const [manage, setManage] = useState(false);
  const [checkin, setCheckin] = useState(false);
  const [renameTxt, setRenameTxt] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [bump, setBump] = useState(0); // re-pull highlights after we send something

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

  const refreshMembers = () => { if (active) circleMembers(active.id).then(setMembers).catch(() => {}); };
  useEffect(() => { refreshMembers(); }, [active?.id]);

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
      } catch (err: any) { if (!cancelled) Alert.alert('Family Space', err?.message ?? 'Could not start location.'); }
    })();
    return () => { cancelled = true; unsub?.(); stopPresence(); };
  }, [active?.id, me?.id]);

  // stop broadcasting when the screen loses focus (map still resumes on return)
  useFocusEffect(React.useCallback(() => () => { stopPresence(); }, []));

  // today's highlights — recent check-ins / SOS decrypted from the circle chat
  useEffect(() => {
    if (!active) return;
    let dead = false;
    (async () => {
      try {
        const msgs = await getMessages(active.id, { limit: 30 });
        const out: Highlight[] = [];
        for (const m of msgs) {
          if (m.deletedAt || !m.content || (m.type !== 'text' && m.type !== 'system')) continue;
          let t = '';
          try { t = await decryptFromChat(active.id, m.senderId, m.content, m.id); } catch { continue; }
          if (!HIGHLIGHT_RE.test(t)) continue;
          const icon = [...t][0] ?? '•';
          out.push({ icon, text: t.slice(icon.length).trim(), at: new Date(m.createdAt).getTime() });
        }
        out.sort((a, b) => b.at - a.at);
        if (!dead) setHighlights(out.slice(0, 5));
      } catch {}
    })();
    return () => { dead = true; };
  }, [active?.id, bump]);

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
      lat: p.pos.lat, lng: p.pos.lng, battery: p.battery, self: uid === me?.id, stale: now - p.ts > STALE_MS,
    }));
  }, [presences, members, me?.id]);

  const myRole = members.find((m) => m.id === me?.id)?.role ?? 'guardian';
  const liveCount = useMemo(() => {
    const now = Date.now();
    return Object.values(presences).filter((p) => now - p.ts <= STALE_MS).length;
  }, [presences]);

  const invite = async () => {
    if (!active) return;
    try {
      const code = await circleInviteCode(active.id);
      await Share.share({ message: `Join my Family Space "${active.name}" on VaultChat.\nCode: ${code}` });
    } catch (e: any) { Alert.alert('Invite', e?.message ?? 'Could not create an invite.'); }
  };

  // ── SOS: hold-to-activate ────────────────────────────────────────────
  const sosProg = useRef(new Animated.Value(0)).current;
  const sosTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fireSos = async () => {
    sosProg.setValue(0);
    if (!active || !me) return;
    Vibration.vibrate([0, 400, 150, 400]);
    try {
      await toggleShare(true);
      let where = '';
      try { const c = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }); where = ` (${c.coords.latitude.toFixed(5)}, ${c.coords.longitude.toFixed(5)})`; } catch {}
      await sendMessage(active.id, `🆘 ${me.name} triggered an SOS — please respond${where}`, 'system');
      setBump((b) => b + 1);
      Alert.alert('SOS sent', 'Your circle has been alerted and your live location is on.', [
        { text: 'Also alert trusted contacts', onPress: () => router.push('/emergency-sos' as any) },
        { text: 'OK' },
      ]);
    } catch (e: any) { Alert.alert('SOS', e?.message ?? 'Could not send SOS.'); }
  };
  const sosStart = () => {
    Vibration.vibrate(30);
    Animated.timing(sosProg, { toValue: 1, duration: SOS_HOLD_MS, useNativeDriver: true }).start();
    sosTimer.current = setTimeout(fireSos, SOS_HOLD_MS);
  };
  const sosEnd = () => {
    if (sosTimer.current) { clearTimeout(sosTimer.current); sosTimer.current = null; }
    Animated.timing(sosProg, { toValue: 0, duration: 120, useNativeDriver: true }).start();
  };

  // ── Check-in ─────────────────────────────────────────────────────────
  const sendCheckin = async (c: typeof CHECKINS[number]) => {
    if (!active || !me) return;
    setCheckin(false);
    try {
      await sendMessage(active.id, `${c.emoji} ${me.name}: ${c.label}${note.trim() ? ` — ${note.trim()}` : ''}`);
      setNote('');
      setBump((b) => b + 1);
    } catch (e: any) { Alert.alert('Check-in', e?.message ?? 'Could not send.'); }
  };

  // ── Member management (guardians) ────────────────────────────────────
  const memberActions = (m: CircleMember) => {
    if (!active || !me || m.id === me.id || myRole !== 'guardian') return;
    Alert.alert(m.name, 'Manage this member', [
      { text: m.role === 'guardian' ? 'Make member' : 'Make guardian', onPress: async () => {
        try { await setGuardian(active.id, m.id, m.role !== 'guardian'); refreshMembers(); }
        catch (e: any) { Alert.alert('Role', e?.message ?? 'Could not change role.'); }
      } },
      { text: 'Remove from circle', style: 'destructive', onPress: () => {
        Alert.alert('Remove member?', `${m.name} will no longer see or share locations in "${active.name}".`, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Remove', style: 'destructive', onPress: async () => {
            try { await removeCircleMember(active.id, m.id); refreshMembers(); }
            catch (e: any) { Alert.alert('Remove', e?.message ?? 'Could not remove.'); }
          } },
        ]);
      } },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  // ── Circle management ────────────────────────────────────────────────
  const afterCircleGone = async () => {
    setManage(false);
    const cs = await listCircles();
    setCircles(cs);
    if (!cs.length) { router.replace('/family-setup' as any); return; }
    setActive(cs[0]);
  };
  const doRename = async () => {
    if (!active || !renameTxt.trim() || busy) return;
    setBusy(true);
    try {
      await renameCircle(active.id, renameTxt);
      const name = renameTxt.trim();
      setActive({ ...active, name });
      setCircles(await listCircles());
      setRenameTxt('');
    } catch (e: any) { Alert.alert('Rename', e?.message ?? 'Could not rename.'); }
    finally { setBusy(false); }
  };
  const doLeave = () => {
    if (!active || !me) return;
    Alert.alert('Leave circle?', `You will stop sharing and seeing locations in "${active.name}".`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Leave', style: 'destructive', onPress: async () => {
        await leaveCircle(active.id, me.id);
        await afterCircleGone();
      } },
    ]);
  };
  const doDelete = () => {
    if (!active || !me) return;
    Alert.alert('Delete circle?', `"${active.name}" will be disbanded for everyone. This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete circle', style: 'destructive', onPress: async () => {
        setBusy(true);
        try { await deleteCircle(active.id, me.id); await afterCircleGone(); }
        catch (e: any) { Alert.alert('Delete', e?.message ?? 'Could not delete the circle.'); }
        finally { setBusy(false); }
      } },
    ]);
  };

  if (loading) return <View style={[st.center, { backgroundColor: colors.bg }]}><ActivityIndicator color={colors.primary} /></View>;

  const mine = me ? presences[me.id] : undefined;
  const roster = members.length ? members : (me ? [{ id: me.id, name: 'You', role: 'guardian' as const, avatar: null }] : []);
  const allGood = liveCount > 0;
  const firstName = (me?.name || 'there').split(/\s+/)[0];

  const memberRow = (m: CircleMember, i: number) => {
    const p = presences[m.id];
    const isMe = m.id === me?.id;
    const d = p && mine && !isMe ? dist(haversine(mine.pos, p.pos)) : null;
    return (
      <Pressable key={m.id} onLongPress={() => memberActions(m)} style={[st.row, { borderColor: colors.border }, i === 0 && { borderTopWidth: 0 }]}>
        <View style={[st.dot, { backgroundColor: colorFor(m.id), opacity: p ? 1 : 0.5 }]}>
          <Text style={st.dotTxt}>{(m.name || '?').trim()[0]?.toUpperCase()}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={{ color: colors.text, fontWeight: '600' }} numberOfLines={1}>{isMe ? 'You' : m.name}</Text>
            {m.role === 'guardian' && <Ionicons name="star" size={11} color={colors.primary} />}
          </View>
          <Text style={{ color: colors.textDim, fontSize: 12 }} numberOfLines={1}>
            {p ? `${ago(p.ts)}${d ? ` · ${d} away` : ''}${p.speed && p.speed > 3 ? ' · moving' : ''}` : 'Location off'}
          </Text>
        </View>
        {p?.battery != null && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
            <Ionicons name={p.charging ? 'battery-charging' : p.battery <= 20 ? 'battery-dead' : 'battery-half'} size={15}
              color={p.battery <= 20 && !p.charging ? colors.danger : colors.textDim} />
            <Text style={{ color: p.battery <= 20 && !p.charging ? colors.danger : colors.textDim, fontSize: 11 }}>{Math.round(p.battery)}%</Text>
          </View>
        )}
        {p && (
          <TouchableOpacity onPress={() => { setFocusId(m.id); setExpanded(true); }} style={st.rowBtn}><Ionicons name="locate" size={18} color={colors.primary} /></TouchableOpacity>
        )}
        {p && !isMe && (
          <TouchableOpacity onPress={() => navigateTo(p.pos.lat, p.pos.lng, m.name)} style={st.rowBtn}><Ionicons name="navigate-circle" size={20} color={colors.primary} /></TouchableOpacity>
        )}
      </Pressable>
    );
  };

  const shareToggleRow = (
    <View style={st.shareRow}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Ionicons name={share ? 'navigate' : 'navigate-outline'} size={18} color={share ? colors.primary : colors.textDim} />
        <Text style={{ color: colors.text, fontWeight: '600' }}>Share my location</Text>
      </View>
      <Switch value={share} onValueChange={toggleShare} trackColor={{ true: colors.primary }} />
    </View>
  );

  return (
    <View style={[st.screen, { backgroundColor: colors.bg }]}>
      <Stack.Screen options={{ title: 'Family Space', headerTitleAlign: 'center',
        headerRight: () => (
          <View style={{ flexDirection: 'row' }}>
            <TouchableOpacity onPress={invite} style={{ paddingHorizontal: 6 }}><Ionicons name="person-add" size={20} color={colors.primary} /></TouchableOpacity>
            <TouchableOpacity onPress={() => { setRenameTxt(''); setManage(true); }} style={{ paddingHorizontal: 6 }}><Ionicons name="ellipsis-vertical" size={20} color={colors.primary} /></TouchableOpacity>
          </View>
        ) }} />

      {expanded ? (
        /* ── expanded: full-screen live map + roster sheet ── */
        <>
          <View style={{ flex: 1 }}>
            <FamilyMap members={markers} focusId={focusId} onSelect={(id) => setFocusId(id)} style={{ flex: 1 }} />
            <TouchableOpacity onPress={() => setExpanded(false)} style={[st.collapse, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Ionicons name="contract" size={18} color={colors.text} />
            </TouchableOpacity>
          </View>
          <View style={[st.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {shareToggleRow}
            <ScrollView style={{ maxHeight: 190 }} contentContainerStyle={{ paddingBottom: 6 }}>
              {roster.map(memberRow)}
            </ScrollView>
          </View>
        </>
      ) : (
        /* ── dashboard ── */
        <ScrollView contentContainerStyle={st.dash} showsVerticalScrollIndicator={false}>
          {/* greeting */}
          <View style={st.greetRow}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontSize: 20, fontWeight: '800' }}>{greeting()}, {firstName} 👋</Text>
              <Text style={{ color: colors.textDim, fontSize: 12.5, marginTop: 2 }}>{active?.name}</Text>
            </View>
          </View>

          {/* circle switcher */}
          {circles.length > 1 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, marginBottom: 10 }} contentContainerStyle={{ gap: 8 }}>
              {circles.map((c) => (
                <TouchableOpacity key={c.id} onPress={() => setActive(c)}
                  style={[st.chip, { borderColor: active?.id === c.id ? colors.primary : colors.border, backgroundColor: active?.id === c.id ? brandAlpha(0.1) : 'transparent' }]}>
                  <Text style={{ color: active?.id === c.id ? colors.primary : colors.text, fontWeight: active?.id === c.id ? '700' : '500', fontSize: 13 }}>{c.name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}

          {/* status card */}
          <View style={[st.status, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={[st.statusIcon, { backgroundColor: (allGood ? colors.success : colors.textFaint) + '22' }]}>
              <Ionicons name={allGood ? 'shield-checkmark' : 'shield-outline'} size={20} color={allGood ? colors.success : colors.textDim} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15 }}>{allGood ? 'All good' : 'Nobody live yet'}</Text>
              <Text style={{ color: colors.textDim, fontSize: 12 }}>
                {liveCount ? `${liveCount} of ${roster.length} sharing live` : share ? 'Waiting for locations…' : 'Turn on sharing to appear on the map'}
              </Text>
            </View>
            <View style={st.avatarRow}>
              {roster.slice(0, 4).map((m, i) => (
                <View key={m.id} style={[st.miniDot, { backgroundColor: colorFor(m.id), marginLeft: i ? -8 : 0, borderColor: colors.card, opacity: presences[m.id] ? 1 : 0.45 }]}>
                  <Text style={st.miniDotTxt}>{(m.name || '?').trim()[0]?.toUpperCase()}</Text>
                </View>
              ))}
              {roster.length > 4 && <View style={[st.miniDot, { backgroundColor: colors.border, marginLeft: -8, borderColor: colors.card }]}><Text style={[st.miniDotTxt, { color: colors.text }]}>+{roster.length - 4}</Text></View>}
            </View>
          </View>

          {/* map preview */}
          <TouchableOpacity activeOpacity={0.9} onPress={() => setExpanded(true)} style={[st.mapCard, { borderColor: colors.border }]}>
            <FamilyMap members={markers} focusId={focusId} onSelect={() => setExpanded(true)} style={{ flex: 1 }} />
            <View style={[st.mapBadge, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Ionicons name="expand" size={13} color={colors.text} /><Text style={{ color: colors.text, fontSize: 12, fontWeight: '700' }}>Live Map</Text>
            </View>
          </TouchableOpacity>

          {/* quick tiles */}
          <View style={st.tiles}>
            <TouchableOpacity onPress={() => setCheckin(true)} style={[st.tile, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Ionicons name="checkmark-done-circle" size={21} color={colors.success} /><Text style={[st.tileTxt, { color: colors.text }]}>Check-in</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => active && router.push({ pathname: '/family-places' as any, params: { circleId: active.id, name: active.name } })}
              style={[st.tile, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Ionicons name="location" size={21} color={colors.primary} /><Text style={[st.tileTxt, { color: colors.text }]}>Places</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => router.push('/emergency-sos' as any)} style={[st.tile, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Ionicons name="medkit" size={21} color={colors.danger} /><Text style={[st.tileTxt, { color: colors.text }]}>Emergency</Text>
            </TouchableOpacity>
          </View>

          {/* hold-to-SOS */}
          <Pressable onPressIn={sosStart} onPressOut={sosEnd} style={[st.sosBig, { borderColor: colors.danger, backgroundColor: colors.danger + '14' }]}>
            <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: colors.danger + '55', transform: [{ scaleX: sosProg }] }]} />
            <View style={[st.sosIcon, { backgroundColor: colors.danger }]}><Text style={{ fontSize: 20 }}>🆘</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.danger, fontWeight: '900', fontSize: 15 }}>HOLD FOR SOS</Text>
              <Text style={{ color: colors.textDim, fontSize: 12 }}>Alerts your circle and shares your live location</Text>
            </View>
          </Pressable>

          {shareToggleRow}

          {/* members */}
          <View style={st.secHead}>
            <Text style={[st.secTitle, { color: colors.text }]}>Family Members</Text>
            <TouchableOpacity onPress={invite}><Text style={{ color: colors.primary, fontWeight: '700', fontSize: 13 }}>+ Invite</Text></TouchableOpacity>
          </View>
          <View style={[st.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {roster.map(memberRow)}
          </View>

          {/* today's highlights */}
          {highlights.length > 0 && (
            <>
              <View style={st.secHead}><Text style={[st.secTitle, { color: colors.text }]}>Today's Highlights</Text></View>
              <View style={[st.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                {highlights.map((h, i) => (
                  <View key={i} style={[st.row, { borderColor: colors.border }, i === 0 && { borderTopWidth: 0 }]}>
                    <Text style={{ fontSize: 16 }}>{h.icon}</Text>
                    <Text style={{ flex: 1, color: colors.text, fontSize: 13.5 }} numberOfLines={2}>{h.text}</Text>
                    <Text style={{ color: colors.textFaint, fontSize: 11 }}>{ago(h.at)}</Text>
                  </View>
                ))}
              </View>
            </>
          )}
          <View style={{ height: 24 }} />
        </ScrollView>
      )}

      {/* ── Check-in sheet ── */}
      <Modal visible={checkin} transparent animationType="slide" onRequestClose={() => setCheckin(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={st.modalWrap}>
          <Pressable style={{ flex: 1 }} onPress={() => setCheckin(false)} />
          <View style={[st.modal, { backgroundColor: colors.surfaceSolid, borderColor: colors.border }]}>
            <Text style={[st.modalTitle, { color: colors.text }]}>Let your family know</Text>
            <View style={st.checkGrid}>
              {CHECKINS.map((c) => (
                <TouchableOpacity key={c.label} onPress={() => sendCheckin(c)}
                  style={[st.checkBtn, { backgroundColor: c.color + '1e', borderColor: c.color + '55' }]}>
                  <Text style={{ fontSize: 18 }}>{c.emoji}</Text>
                  <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13.5 }}>{c.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TextInput value={note} onChangeText={setNote} placeholder="Add a note (optional)" placeholderTextColor={colors.textFaint}
              style={[st.noteInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]} />
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Manage circle sheet ── */}
      <Modal visible={manage} transparent animationType="slide" onRequestClose={() => setManage(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={st.modalWrap}>
          <Pressable style={{ flex: 1 }} onPress={() => setManage(false)} />
          <View style={[st.modal, { backgroundColor: colors.surfaceSolid, borderColor: colors.border }]}>
            <Text style={[st.modalTitle, { color: colors.text }]}>{active?.name}</Text>

            {myRole === 'guardian' && (
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 4 }}>
                <TextInput value={renameTxt} onChangeText={setRenameTxt} placeholder="Rename circle" placeholderTextColor={colors.textFaint}
                  style={[st.noteInput, { flex: 1, marginTop: 0, color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
                  returnKeyType="done" onSubmitEditing={doRename} />
                <TouchableOpacity onPress={doRename} disabled={!renameTxt.trim() || busy}
                  style={[st.saveBtn, { backgroundColor: renameTxt.trim() ? colors.primary : colors.border }]}>
                  {busy ? <ActivityIndicator color="#fff" size="small" /> : <Ionicons name="checkmark" size={20} color="#fff" />}
                </TouchableOpacity>
              </View>
            )}

            <TouchableOpacity onPress={() => { setManage(false); invite(); }} style={[st.mRow, { borderColor: colors.border }]}>
              <Ionicons name="person-add" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>Invite with code</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setManage(false); active && router.push({ pathname: '/chat', params: { id: active.id } } as any); }} style={[st.mRow, { borderColor: colors.border }]}>
              <Ionicons name="chatbubbles" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>Open circle chat</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setManage(false); router.push('/emergency-sos' as any); }} style={[st.mRow, { borderColor: colors.border }]}>
              <Ionicons name="medkit" size={19} color={colors.danger} /><Text style={[st.mTxt, { color: colors.text }]}>Emergency SOS (trusted contacts)</Text>
            </TouchableOpacity>
            <Text style={{ color: colors.textFaint, fontSize: 12, paddingVertical: 8 }}>
              Long-press a member in the list to change their role or remove them.
            </Text>
            <TouchableOpacity onPress={doLeave} style={[st.mRow, { borderColor: colors.border }]}>
              <Ionicons name="exit-outline" size={19} color={colors.danger} /><Text style={[st.mTxt, { color: colors.danger }]}>Leave circle</Text>
            </TouchableOpacity>
            {myRole === 'guardian' && (
              <TouchableOpacity onPress={doDelete} disabled={busy} style={[st.mRow, { borderColor: colors.border }]}>
                <Ionicons name="trash" size={19} color={colors.danger} /><Text style={[st.mTxt, { color: colors.danger, fontWeight: '800' }]}>Delete circle</Text>
              </TouchableOpacity>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  dash: { padding: 14 },
  greetRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderWidth: 1, borderRadius: 16, marginBottom: 10 },
  statusIcon: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  avatarRow: { flexDirection: 'row', alignItems: 'center' },
  miniDot: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', borderWidth: 2 },
  miniDotTxt: { color: '#fff', fontWeight: '800', fontSize: 11 },
  mapCard: { height: 200, borderRadius: 18, borderWidth: 1, overflow: 'hidden', marginBottom: 10 },
  mapBadge: { position: 'absolute', top: 10, right: 10, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, borderWidth: 1 },
  collapse: { position: 'absolute', top: 12, right: 12, width: 38, height: 38, borderRadius: 19, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  tiles: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  tile: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 5, height: 66, borderWidth: 1, borderRadius: 16 },
  tileTxt: { fontSize: 12.5, fontWeight: '700' },
  sosBig: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderWidth: 1.5, borderRadius: 18, overflow: 'hidden', marginBottom: 6 },
  sosIcon: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  shareRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 },
  secHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, marginBottom: 8 },
  secTitle: { fontSize: 13, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4 },
  card: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, marginBottom: 4 },
  sheet: { borderTopWidth: 1, borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 14, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth },
  dot: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  dotTxt: { color: '#fff', fontWeight: '800' },
  rowBtn: { padding: 6 },
  modalWrap: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  modal: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, padding: 16, paddingBottom: 28, gap: 8 },
  modalTitle: { fontSize: 17, fontWeight: '800', marginBottom: 6, textAlign: 'center' },
  checkGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  checkBtn: { flexBasis: '47%', flexGrow: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 52, borderRadius: 14, borderWidth: 1 },
  noteInput: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, height: 46, marginTop: 4, fontSize: 14.5 },
  saveBtn: { width: 46, height: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  mRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, borderTopWidth: StyleSheet.hairlineWidth },
  mTxt: { fontSize: 15, fontWeight: '600' },
});
