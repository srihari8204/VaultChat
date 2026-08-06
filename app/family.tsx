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
  Switch, Modal, TextInput, Animated, Vibration, Pressable, KeyboardAvoidingView, Platform,
} from 'react-native';
import * as Location from 'expo-location';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { brandAlpha } from '../constants/theme';
import FamilyMap, { type FamilyMarker } from '../components/family/FamilyMap';
// removeCircle stays: hetzner-deploy added a path that forgets a circle locally
// when the server starts 403/404ing it (kicked, or deleted). That is orthogonal
// to the group registry and must survive the switch — dropping it would bring
// back a phone retrying a dead circle on every focus.
import { getSettings, setSettings, removeCircle } from '../lib/family/store';
// Groups & Circles: the registry is now typed groups. A Family Space circle is
// one of them (migrated on first load by lib/groups/store), so this screen is
// the group dashboard and no longer assumes there is exactly one family.
import { listGroups, reconcileGroups, resolveActiveGroup, saveGroup, setActiveGroupId, type GroupRef } from '../lib/groups/store';
import { groupIdentity } from '../lib/groups/catalog';
import { can as hasPerm, type Permission } from '../lib/groups/permissions';
import {
  circleMembers, renameCircle, leaveCircle, deleteCircle,
  removeCircleMember, setGuardian,
} from '../lib/family/circle';
import {
  startPresence, stopPresence, setSharing, subscribeCircle,
  canShareInBackground, type PresenceEvent,
} from '../lib/family/presence';
import { requestBackgroundPermission } from '../lib/family/background';
import { loadAlerts, recordAlert, useUnreadCount } from '../lib/family/alerts';
import { type CircleMember, type MemberPresence, STALE_MS } from '../lib/family/types';
import { sendMessage, getMessages, decryptFromChat, getChat, listChats, sendAnnouncement, isAnnouncement } from '../lib/chatService';
import { getCurrentUserAsync } from './(constants)/authService';
import { navigateTo } from '../lib/nav/openNavigation';
import { subscribeTrip, currentTrip } from '../lib/groups/tripSession';
import {
  foldParticipants, lastEta, everyoneArrived, minutesUntil,
  type Trip, type TripPing,
} from '../lib/groups/trips';
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

// The group registry is local, so a group you LEFT from the Chats screen would
// otherwise linger here (and in the Mini Apps tile) forever. Reconcile against
// the server's chat list on every load; a failed fetch changes nothing.
async function loadGroupsReconciled(): Promise<GroupRef[]> {
  const groups = await listGroups();
  try {
    const chats = await listChats();
    return await reconcileGroups(chats.map((c: any) => String(c.id)));
  } catch {
    return groups;   // offline — keep what we have rather than hiding everything
  }
}

interface Highlight { icon: string; text: string; at: number }

export default function FamilySpaceScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const [me, setMe] = useState<{ id: string; name: string } | null>(null);
  const [circles, setCircles] = useState<GroupRef[]>([]);
  const [active, setActive] = useState<GroupRef | null>(null);
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
  const bgAsked = useRef(false);       // only nag once per mount about always-on location
  const unread = useUnreadCount(active?.id ?? null);
  // THIS USER's permissions in the active group, as resolved by the server.
  // Presentation only — every mutating endpoint re-checks. A stale or absent
  // set must never widen what is shown, so it starts empty.
  const [perms, setPerms] = useState<Set<Permission>>(new Set());
  // The most recent announcement, pinned to the dashboard.
  const [announcement, setAnnouncement] = useState<{ text: string; at: number } | null>(null);
  const [announcing, setAnnouncing] = useState(false);
  const [announceTxt, setAnnounceTxt] = useState('');
  // A trip already running in this group, so the dashboard says so instead of
  // leaving it discoverable only by opening the trip screen.
  const [trip, setTrip] = useState<Trip | null>(null);
  const [tripPings, setTripPings] = useState<TripPing[]>([]);

  useEffect(() => { loadAlerts(); }, []);

  // identity + circle list
  useEffect(() => { (async () => {
    const u = await getCurrentUserAsync().catch(() => null);
    setMe(u ? { id: String(u.id), name: u.name || u.email || 'Me' } : null);
    const cs = await loadGroupsReconciled();
    setCircles(cs);
    if (!cs.length) { router.replace('/group-create' as any); return; }
    // Reopen on the group the user was last in, not blindly the first.
    const remembered = await resolveActiveGroup();
    setActive((prev) => prev ?? remembered ?? cs[0]);
    setShare((await getSettings()).sharing);
    setLoading(false);
  })(); }, []);

  // Watch for a live trip in the active group. Subscribing here rather than
  // only inside the trip screen is the whole point of 5.7: a convoy that is
  // already moving should be visible without going looking for it.
  useEffect(() => {
    if (!active?.id || !me?.id) { setTrip(null); setTripPings([]); return; }
    let live = true;
    let off: (() => void) | null = null;
    setTrip(currentTrip());
    setTripPings([]);
    (async () => {
      const unsub = await subscribeTrip(
        active.id, me.id,
        (e) => {
          if (!live) return;
          setTripPings((prev) => (e.ping
            ? [...prev.filter((p) => p.userId !== e.userId), e.ping]
            : prev.filter((p) => p.userId !== e.userId)));
        },
        (t) => { if (live) setTrip((cur) => cur ?? t); },
      ).catch(() => null);
      if (live && unsub) off = unsub; else unsub?.();
    })();
    return () => { live = false; off?.(); };
  }, [active?.id, me?.id]);

  // Keeps hetzner-deploy's dead-circle handling. My side of this rebase had
  // simplified it back to a bare .catch(() => {}), which would have silently
  // reverted a real fix: a kicked member's phone retrying a 403 circle on every
  // focus and highlights poll.
  const refreshMembers = () => {
    if (!active) return;
    const id = active.id;
    circleMembers(id).then(setMembers).catch(async (e: any) => {
      // Kicked, or the circle was deleted: the group now 403/404s forever.
      // Forget it locally instead of hammering the server from every focus
      // and highlights poll (seen live: one phone retrying a dead circle
      // every few seconds).
      if (e?.status === 403 || e?.status === 404) {
        await removeCircle(id);
        await afterCircleGone();
      }
    });
  };
  useEffect(() => { refreshMembers(); }, [active?.id]);

  // Persist the switch so the next launch reopens here, and refresh the group's
  // server-side truth (permissions, cap, type) into the local registry.
  useEffect(() => {
    if (!active) return;
    setActiveGroupId(active.id);
    let live = true;
    (async () => {
      try {
        const chat = await getChat(active.id);
        if (!live) return;
        const list = (chat.permissions ?? []) as Permission[];
        setPerms(new Set(list));
        await saveGroup({
          id: active.id, name: chat.name || active.name,
          groupType: (chat.groupType ?? active.groupType) ?? null,
          icon: chat.icon ?? active.icon ?? null,
          color: chat.color ?? active.color ?? null,
          privacy: chat.privacy, maxMembers: chat.maxMembers ?? null,
          role: chat.myRole, permissions: list,
        });
      } catch {
        // Offline or a server without the group columns yet: fall back to what
        // the registry already cached, never to "everything allowed".
        if (live) setPerms(new Set((active.permissions ?? []) as Permission[]));
      }
    })();
    return () => { live = false; };
  // Keyed on the id ALONE on purpose: `active` is a fresh object on every
  // registry refresh, so depending on it would re-fetch permissions endlessly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

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

  // Refresh on focus — /family-add and /family-setup both mutate state this
  // screen already has in memory, and neither changes active.id, so nothing
  // else would re-read it.
  useFocusEffect(React.useCallback(() => {
    let live = true;
    (async () => {
      const cs = await loadGroupsReconciled();
      if (!live) return;
      setCircles(cs);
      if (!cs.length) { router.replace('/group-create' as any); return; }
      // Keep the user on the space they were looking at unless it is gone.
      setActive(prev => (prev && cs.some(c => c.id === prev.id)) ? prev : cs[0]);
    })();
    refreshMembers();
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]));

  // today's highlights — recent check-ins / SOS decrypted from the circle chat
  useEffect(() => {
    if (!active) return;
    let dead = false;
    (async () => {
      try {
        const msgs = await getMessages(active.id, { limit: 30 });
        const out: Highlight[] = [];
        // Announcements are identified from meta, so finding the latest costs
        // no extra request and no decryption of unrelated messages.
        let latest: { text: string; at: number } | null = null;
        for (const m of msgs) {
          if (!m.deletedAt && m.content && isAnnouncement(m)) {
            const at = new Date(m.createdAt).getTime();
            if (!latest || at > latest.at) {
              try { latest = { text: await decryptFromChat(active.id, m.senderId, m.content, m.id), at }; } catch {}
            }
          }
        }
        if (!dead) setAnnouncement(latest);
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
    if (v) await offerBackground();
  };

  /**
   * Sharing only used to survive while this screen was in front. Ask once for
   * always-on so it keeps working in a pocket; declining is a valid answer and
   * simply leaves the foreground-only behaviour in place.
   */
  const offerBackground = async () => {
    if (bgAsked.current) return;
    bgAsked.current = true;
    try {
      if (await canShareInBackground()) return;
      Alert.alert(
        'Keep sharing in the background?',
        'Without always-on location, your family only sees you while this screen is open. You can change this any time in system settings.',
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Allow', onPress: async () => {
            const ok = await requestBackgroundPermission();
            if (ok && active && me) { try { await setSharing(false); await setSharing(true); } catch {} }
          } },
        ],
      );
    } catch {}
  };

  const markers: FamilyMarker[] = useMemo(() => {
    const now = Date.now();
    const nameById = new Map(members.map((m) => [m.id, m.name]));
    return Object.entries(presences).map(([uid, p]) => ({
      id: uid, name: uid === me?.id ? 'You' : (nameById.get(uid) || 'Member'),
      lat: p.pos.lat, lng: p.pos.lng, battery: p.battery, self: uid === me?.id, stale: now - p.ts > STALE_MS,
    }));
  }, [presences, members, me?.id]);

  const myRole = members.find((m) => m.id === me?.id)?.role ?? active?.role ?? 'member';
  // "Guardian" is the Family type's word for admin; every other group type says
  // admin. Capability checks below use permissions, never this label.
  const isAdminish = myRole === 'guardian' || myRole === 'admin' || myRole === 'owner';
  const canInvite  = hasPerm(perms, 'invite_members')   || isAdminish;
  const canManage  = hasPerm(perms, 'edit_settings')    || isAdminish;
  const canRemove  = hasPerm(perms, 'remove_members')   || isAdminish;
  const canZones   = hasPerm(perms, 'manage_zones')     || isAdminish;
  const canHistory = hasPerm(perms, 'view_history')     || isAdminish;
  const canAnnounce = hasPerm(perms, 'send_announcements') || isAdminish;
  const canNavigate = hasPerm(perms, 'start_navigation')    || isAdminish;
  // Identity for this group's type — icon and accent drive the whole dashboard.
  const ident = groupIdentity(active ?? {});
  const liveCount = useMemo(() => {
    const now = Date.now();
    return Object.values(presences).filter((p) => now - p.ts <= STALE_MS).length;
  }, [presences]);

  // Contact picker: add someone straight from the phone's contacts.
  //
  // The shareable invite CODE that used to sit alongside this is gone. Under
  // membership v2 everything happens inside VaultChat, and a code you could
  // paste into a message was the last thing here that could be forwarded to
  // somebody it was not meant for. /group-invites replaces it.
  const openAdd = () => {
    if (!active) return;
    router.push({ pathname: '/family-add' as any, params: { circleId: active.id, circleName: active.name } });
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
      await recordAlert({
        circleId: active.id, kind: 'sos', actorId: me.id, actorName: me.name,
        text: `${me.name} triggered an SOS`,
      });
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
      const suffix = note.trim() ? ` — ${note.trim()}` : '';
      await sendMessage(active.id, `${c.emoji} ${me.name}: ${c.label}${suffix}`);
      await recordAlert({
        circleId: active.id, kind: c.label === 'Need Help' ? 'sos' : 'checkin',
        actorId: me.id, actorName: me.name, text: `${me.name}: ${c.label}${suffix}`,
      });
      setNote('');
      setBump((b) => b + 1);
    } catch (e: any) { Alert.alert('Check-in', e?.message ?? 'Could not send.'); }
  };

  // ── Member management (guardians) ────────────────────────────────────
  const memberActions = (m: CircleMember) => {
    if (!active || !me || m.id === me.id || !canRemove) return;
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
    const cs = await listGroups();
    setCircles(cs);
    if (!cs.length) { router.replace('/group-create' as any); return; }
    setActive(cs[0]);
  };
  const doRename = async () => {
    if (!active || !renameTxt.trim() || busy) return;
    setBusy(true);
    try {
      await renameCircle(active.id, renameTxt);
      const name = renameTxt.trim();
      setActive({ ...active, name });
      setCircles(await listGroups());
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
      <Pressable
        key={m.id}
        onLongPress={() => memberActions(m)}
        onPress={() => active && router.push({
          pathname: '/family-member' as any,
          params: { circleId: active.id, circleName: active.name, userId: m.id, name: isMe ? 'You' : m.name, role: m.role },
        })}
        style={[st.row, { borderColor: colors.border }, i === 0 && { borderTopWidth: 0 }]}
      >
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
      <Stack.Screen options={{ title: active?.name || 'Family Space', headerTitleAlign: 'center',
        headerRight: () => (
          <View style={{ flexDirection: 'row' }}>
            {canInvite && <TouchableOpacity onPress={openAdd} style={{ paddingHorizontal: 6 }}><Ionicons name="person-add" size={20} color={colors.primary} /></TouchableOpacity>}
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
              <Text style={{ color: colors.textDim, fontSize: 12.5, marginTop: 2 }}>
              {active?.name}{active?.groupType && ident.label !== active.name ? ` · ${ident.label}` : ''}
            </Text>
            </View>
          </View>

          {/* circle switcher */}
          {circles.length > 1 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, marginBottom: 10 }} contentContainerStyle={{ gap: 8 }}>
              {circles.map((c) => {
                const on = active?.id === c.id;
                const gi = groupIdentity(c);
                return (
                  <TouchableOpacity key={c.id} onPress={() => setActive(c)}
                    style={[st.chip, { flexDirection: 'row', alignItems: 'center', gap: 6,
                      borderColor: on ? gi.color : colors.border,
                      backgroundColor: on ? gi.color + '1a' : 'transparent' }]}>
                    <Ionicons name={gi.icon} size={13} color={on ? gi.color : colors.textDim} />
                    <Text style={{ color: on ? colors.text : colors.textDim, fontWeight: on ? '700' : '500', fontSize: 13 }}>{c.name}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}

          {/* pinned announcement */}
          {!!announcement && (
            <View style={[st.announce, { backgroundColor: brandAlpha(0.08), borderColor: colors.primary }]}>
              <Ionicons name="megaphone" size={17} color={colors.primary} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontSize: 13.5, fontWeight: '600' }} numberOfLines={3}>
                  {announcement.text}
                </Text>
                <Text style={{ color: colors.textDim, fontSize: 11 }}>{ago(announcement.at)}</Text>
              </View>
            </View>
          )}

          {/* status card */}
          <View style={[st.status, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={[st.statusIcon, { backgroundColor: (allGood ? colors.success : ident.color) + '22' }]}>
              <Ionicons name={allGood ? 'shield-checkmark' : ident.icon} size={20} color={allGood ? colors.success : ident.color} />
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
            {canZones && (
              <TouchableOpacity onPress={() => active && router.push({ pathname: '/family-places' as any, params: { circleId: active.id, name: active.name } })}
                style={[st.tile, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Ionicons name="location" size={21} color={colors.primary} /><Text style={[st.tileTxt, { color: colors.text }]}>Places</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={() => active && router.push({ pathname: '/family-alerts' as any, params: { circleId: active.id, circleName: active.name } })}
              style={[st.tile, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Ionicons name="notifications" size={21} color={colors.primary} /><Text style={[st.tileTxt, { color: colors.text }]}>Alerts</Text>
              {unread > 0 && (
                <View style={[st.badge, { backgroundColor: colors.danger, borderColor: colors.card }]}>
                  <Text style={st.badgeTxt}>{unread > 99 ? '99+' : unread}</Text>
                </View>
              )}
            </TouchableOpacity>
            {canHistory && (
              <TouchableOpacity onPress={() => active && router.push({ pathname: '/family-history' as any, params: { circleId: active.id, circleName: active.name } })}
                style={[st.tile, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Ionicons name="time" size={21} color={colors.primary} /><Text style={[st.tileTxt, { color: colors.text }]}>History</Text>
              </TouchableOpacity>
            )}
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

          {/* active trip (G5.7) — only when one is actually running */}
          {!!trip && (() => {
            const parts = foldParticipants(
              tripPings,
              Object.fromEntries(members.map((m) => [m.id, m.id === me?.id ? 'You' : m.name])),
              Date.now(),
            );
            const eta = lastEta(parts);
            const done = everyoneArrived(parts);
            return (
              <TouchableOpacity
                onPress={() => router.push({ pathname: '/group-trip' as any, params: { groupId: active!.id, name: active!.name } })}
                style={[st.card, { backgroundColor: colors.card, borderColor: done ? colors.success : colors.primary, flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 }]}
              >
                <View style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: (done ? colors.success : colors.primary) + '22' }}>
                  <Ionicons name={done ? 'checkmark-done' : 'car'} size={20} color={done ? colors.success : colors.primary} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ color: colors.text, fontWeight: '700', fontSize: 14.5 }} numberOfLines={1}>
                    {trip.destinationName}
                  </Text>
                  <Text style={{ color: colors.textDim, fontSize: 12 }} numberOfLines={1}>
                    {done ? 'Everyone has arrived'
                      : parts.length === 0 ? 'Trip started · no ETAs yet'
                      : eta != null ? `${parts.length} on the way · all in by about ${minutesUntil(eta, Date.now())} min`
                      : `${parts.length} on the way`}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
              </TouchableOpacity>
            );
          })()}

          {/* members */}
          <View style={st.secHead}>
            <Text style={[st.secTitle, { color: colors.text }]}>Family Members</Text>
            {/* "+ Invite" opens the CONTACT PICKER (it used to open the sent-
                invitations manager, which asks you to type a name/email/phone —
                the person you want is almost always already a contact). The
                manager is still one tap away in the ⋯ sheet. */}
            {canInvite && active && (
              <TouchableOpacity onPress={openAdd}>
                <Text style={{ color: colors.primary, fontWeight: '700', fontSize: 13 }}>+ Invite</Text>
              </TouchableOpacity>
            )}
          </View>
          <View style={[st.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {roster.map(memberRow)}
          </View>

          {/* today's highlights */}
          {highlights.length > 0 && (
            <>
              <View style={st.secHead}><Text style={[st.secTitle, { color: colors.text }]}>Today&apos;s Highlights</Text></View>
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

      {/* ── Announcement sheet ── */}
      <Modal visible={announcing} transparent animationType="slide" onRequestClose={() => setAnnouncing(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={st.modalWrap}>
          <Pressable style={{ flex: 1 }} onPress={() => setAnnouncing(false)} />
          <View style={[st.modal, { backgroundColor: colors.surfaceSolid, borderColor: colors.border }]}>
            <Text style={[st.modalTitle, { color: colors.text }]}>Announcement</Text>
            <Text style={{ color: colors.textDim, fontSize: 12.5, textAlign: 'center', marginBottom: 8 }}>
              Pinned to everyone&apos;s dashboard and raised as an alert.
            </Text>
            <TextInput
              value={announceTxt} onChangeText={setAnnounceTxt} multiline
              placeholder="What should everyone know?" placeholderTextColor={colors.textFaint}
              style={[st.noteInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface, height: 96, paddingTop: 12 }]}
              maxLength={500}
            />
            <TouchableOpacity
              onPress={async () => {
                const t = announceTxt.trim();
                if (!t || !active || !me || busy) return;
                setBusy(true);
                try {
                  await sendAnnouncement(active.id, t);
                  await recordAlert({
                    circleId: active.id, kind: 'announcement',
                    actorId: me.id, actorName: me.name, text: t,
                  });
                  setAnnouncing(false); setAnnounceTxt('');
                  setBump((b) => b + 1);
                } catch (e: any) {
                  // The server re-checks the permission, so this can legitimately
                  // fail even though the button was drawn.
                  Alert.alert('Not posted', e?.message ?? 'Could not post the announcement.');
                } finally { setBusy(false); }
              }}
              disabled={!announceTxt.trim() || busy}
              style={[st.btnWide, { backgroundColor: announceTxt.trim() && !busy ? colors.primary : colors.border }]}
            >
              {busy ? <ActivityIndicator color="#fff" />
                : <><Ionicons name="megaphone" size={17} color="#fff" /><Text style={{ color: '#fff', fontWeight: '800', fontSize: 15 }}>Post to group</Text></>}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Manage circle sheet ── */}
      <Modal visible={manage} transparent animationType="slide" onRequestClose={() => setManage(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={st.modalWrap}>
          <Pressable style={{ flex: 1 }} onPress={() => setManage(false)} />
          <View style={[st.modal, { backgroundColor: colors.surfaceSolid, borderColor: colors.border }]}>
            <Text style={[st.modalTitle, { color: colors.text }]}>{active?.name}</Text>

            {canManage && (
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

            <TouchableOpacity onPress={() => { setManage(false); openAdd(); }} style={[st.mRow, { borderColor: colors.border }]}>
              <Ionicons name="person-add" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>Invite from contacts</Text>
            </TouchableOpacity>
            {canInvite && <TouchableOpacity onPress={() => { setManage(false); active && router.push({ pathname: '/group-invites' as any, params: { chatId: active.id, name: active.name } }); }} style={[st.mRow, { borderColor: colors.border }]}>
              <Ionicons name="mail-open-outline" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>Sent invitations &amp; requests</Text>
            </TouchableOpacity>}
            <TouchableOpacity onPress={() => { setManage(false); active && router.push({ pathname: '/group-members' as any, params: { groupId: active.id, name: active.name } }); }} style={[st.mRow, { borderColor: colors.border }]}>
              <Ionicons name="people-outline" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>Members &amp; roles</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setManage(false); router.push('/group-invitations' as any); }} style={[st.mRow, { borderColor: colors.border }]}>
              <Ionicons name="mail-outline" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>My invitations</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setManage(false); router.push('/group-create' as any); }} style={[st.mRow, { borderColor: colors.border }]}>
              <Ionicons name="add-circle-outline" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>Create or join another group</Text>
            </TouchableOpacity>
            {canAnnounce && (
              <TouchableOpacity onPress={() => { setManage(false); setAnnounceTxt(''); setAnnouncing(true); }} style={[st.mRow, { borderColor: colors.border }]}>
                <Ionicons name="megaphone-outline" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>Post an announcement</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={() => { setManage(false); active && router.push({ pathname: '/group-calendar' as any, params: { groupId: active.id, name: active.name } }); }} style={[st.mRow, { borderColor: colors.border }]}>
              <Ionicons name="calendar-outline" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>Shared calendar</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setManage(false); active && router.push({ pathname: '/group-insights' as any, params: { groupId: active.id, name: active.name } }); }} style={[st.mRow, { borderColor: colors.border }]}>
              <Ionicons name="stats-chart-outline" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>Insights</Text>
            </TouchableOpacity>
            {canNavigate && (
              <TouchableOpacity onPress={() => { setManage(false); active && router.push({ pathname: '/group-trip' as any, params: { groupId: active.id, name: active.name } }); }} style={[st.mRow, { borderColor: colors.border }]}>
                <Ionicons name="navigate-outline" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>Start a group trip</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={() => { setManage(false); active && router.push({ pathname: '/media-gallery' as any, params: { chatId: active.id, peerName: active.name } }); }} style={[st.mRow, { borderColor: colors.border }]}>
              <Ionicons name="images-outline" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>Shared album</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setManage(false); active && router.push({ pathname: '/group-notes' as any, params: { groupId: active.id, name: active.name } }); }} style={[st.mRow, { borderColor: colors.border }]}>
              <Ionicons name="document-text-outline" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>Shared notes</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setManage(false); active && router.push({ pathname: '/group-tasks' as any, params: { groupId: active.id, name: active.name } }); }} style={[st.mRow, { borderColor: colors.border }]}>
              <Ionicons name="checkbox-outline" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>Shared tasks</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setManage(false); active && router.push({ pathname: '/group-privacy' as any, params: { groupId: active.id, name: active.name } }); }} style={[st.mRow, { borderColor: colors.border }]}>
              <Ionicons name="eye-off-outline" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>What this group can see</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setManage(false); active && router.push({ pathname: '/chat', params: { id: active.id } } as any); }} style={[st.mRow, { borderColor: colors.border }]}>
              <Ionicons name="chatbubbles" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>Open circle chat</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setManage(false); router.push('/family-setup' as any); }} style={[st.mRow, { borderColor: colors.border }]}>
              <Ionicons name="key" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>Create or join another circle</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setManage(false); router.push('/emergency-sos' as any); }} style={[st.mRow, { borderColor: colors.border }]}>
              <Ionicons name="medkit" size={19} color={colors.danger} /><Text style={[st.mTxt, { color: colors.text }]}>Emergency SOS (trusted contacts)</Text>
            </TouchableOpacity>
            <Text style={{ color: colors.textFaint, fontSize: 12, paddingVertical: 8 }}>
              Tap a member for their details and history. Long-press to change their role or remove them.
            </Text>
            <TouchableOpacity onPress={doLeave} style={[st.mRow, { borderColor: colors.border }]}>
              <Ionicons name="exit-outline" size={19} color={colors.danger} /><Text style={[st.mTxt, { color: colors.danger }]}>Leave circle</Text>
            </TouchableOpacity>
            {canManage && (
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
  // 5 tiles wrap onto two rows at ~3 per row (30% basis + the 10px gaps).
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 10 },
  tile: { flexBasis: '30%', flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 5, height: 66, borderWidth: 1, borderRadius: 16 },
  tileTxt: { fontSize: 12.5, fontWeight: '700' },
  badge: { position: 'absolute', top: 6, right: 10, minWidth: 18, height: 18, borderRadius: 9, borderWidth: 1.5, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  badgeTxt: { color: '#fff', fontSize: 10, fontWeight: '800' },
  announce: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderWidth: 1, borderRadius: 14, marginBottom: 10 },
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
  btnWide: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 50, borderRadius: 13, marginTop: 12 },
  saveBtn: { width: 46, height: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  mRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, borderTopWidth: StyleSheet.hairlineWidth },
  mTxt: { fontSize: 15, fontWeight: '600' },
});
