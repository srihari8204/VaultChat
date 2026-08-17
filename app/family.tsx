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
  Linking, AppState,
} from 'react-native';
import * as Location from 'expo-location';
import { Stack, useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { brandAlpha } from '../constants/theme';
import FamilyMap, { type FamilyMarker } from '../components/family/FamilyMap';
// removeCircle stays: hetzner-deploy added a path that forgets a circle locally
// when the server starts 403/404ing it (kicked, or deleted). That is orthogonal
// to the group registry and must survive the switch — dropping it would bring
// back a phone retrying a dead circle on every focus.
import { getSettings, setSettings, removeCircle, getPlaces } from '../lib/family/store';
import { freshnessOf, speedBand, statusBoard, markSharingOff } from '../lib/family/status';
import { subscribeSpaceLocations, mergePresence, fetchSpaceSnapshot } from '../lib/location/live';
import { startRefreshController } from '../lib/family/refresh';
import { setPresenceForeground, currentPlan } from '../lib/family/presence';
import { getRelations, memberLabel, type RelationMap } from '../lib/family/relations';
import { useVisibleTick } from '../lib/family/useVisibleTick';
import { type Geofence } from '../lib/family/geofence';
// Groups & Circles: the registry is now typed groups. A Family Space circle is
// one of them (migrated on first load by lib/groups/store), so this screen is
// the group dashboard and no longer assumes there is exactly one family.
import { listGroups, reconcileGroups, resolveActiveGroup, saveGroup, setActiveGroupId, type GroupRef } from '../lib/groups/store';
import { groupIdentity } from '../lib/groups/catalog';
import { can as hasPerm, type Permission } from '../lib/groups/permissions';
import { getRuns } from '../lib/spaces/api';
import { familyOf, isOperational, sectionsFor, memberHeading, locationRationale } from '../lib/spaces/layout';
import { type Run as SpaceRun } from '../lib/spaces/runs';
import {
  circleMembers, renameCircle, leaveCircle, deleteCircle,
  removeCircleMember, setGuardian,
} from '../lib/family/circle';
import {
  startPresence, stopPresence, setSharing, subscribeCircle,
  canShareInBackground, type PresenceEvent,
} from '../lib/family/presence';
import { requestBackgroundPermission } from '../lib/family/background';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  requestIgnoreBatteryOptimizations, needsAutoStartGuidance, openAutoStartSettings, getManufacturer,
} from '../lib/batteryOptimization';
import { loadAlerts, recordAlert, useUnreadCount } from '../lib/family/alerts';
import { type CircleMember, type MemberPresence, STALE_MS, SPEED_ALERT_CHOICES, DEFAULT_SPEED_ALERT_KMH } from '../lib/family/types';
import { sendMessage, getMessages, decryptFromChat, getChat, listChats, sendAnnouncement, isAnnouncement } from '../lib/chatService';
import { getCurrentUserAsync } from './(constants)/authService';
import { navigateTo } from '../lib/nav/openNavigation';
import { subscribeTrip, currentTrip } from '../lib/groups/tripSession';
import {
  foldParticipants, lastEta, everyoneArrived, minutesUntil,
  type Trip, type TripPing,
} from '../lib/groups/trips';
import { haversine } from '../lib/nav/geo';
import {
  memberDistances, summarize as summarizeDistances, sortMembers, defaultRef,
  formatMetres, type SortMode,
} from '../lib/family/distance';

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
  // Local device time on purpose: a family dashboard is a local object, and
  // "good morning" is about the light outside the window, not a server clock.
  // The small-hours branch matters — this screen gets opened at 2am by someone
  // checking whether a teenager got home, and "Good evening" reads as wrong.
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 21) return 'Good evening';
  return 'Good night';
}

// The group registry is local, so a group you LEFT from the Chats screen would
// otherwise linger here (and in the Mini Apps tile) forever. Reconcile against
// the server's chat list on every load; a failed fetch changes nothing.
async function loadGroupsReconciled(): Promise<GroupRef[]> {
  const groups = await listGroups();
  try {
    const chats = await listChats();
    // Prune spaces we are no longer in.
    let next = await reconcileGroups(chats.map((c: any) => String(c.id)));

    // ADOPT spaces we ARE in but have never seen on this device.
    //
    // reconcileGroups only ever removed. The registry was written by whichever
    // device created or joined the space, so a School or Employee space set up
    // on another phone — or joined from an invitation — never appeared here at
    // all: not in the switcher, not in the dashboard, nowhere. That is what
    // "school and employee are not working" looks like from the outside, and it
    // gets worse the more a family uses more than one space.
    //
    // The chat list already carries the id, name and type, so adopting is free:
    // no extra request, and it happens on the same load that was already
    // pruning.
    // The chat LIST does not carry group_type — only GET /chats/:id does — so
    // the type has to be fetched for chats we have never seen. Bounded at 8 and
    // only for unknown GROUP chats, so the common case (nothing new) costs
    // nothing and a user in many ordinary group chats is not punished for it.
    // Anything that is not a typed space is skipped and simply not adopted.
    const known = new Set(next.map((g) => String(g.id)));
    const unknown = chats
      .filter((c: any) => c?.type === 'group' && !known.has(String(c.id)))
      .slice(0, 8);
    for (const c of unknown) {
      try {
        const detail: any = await getChat(String(c.id));
        if (!detail?.groupType) continue;   // an ordinary group chat, not a space
        next = await saveGroup({
          id: String(c.id),
          name: detail.name || c.name || 'Space',
          groupType: detail.groupType,
          icon: detail.icon ?? null,
          color: detail.color ?? null,
        } as GroupRef);
      } catch { /* one unreadable chat must not stop the others being adopted */ }
    }
    return next;
  } catch {
    return groups;   // offline — keep what we have rather than hiding everything
  }
}

interface Highlight { icon: string; text: string; at: number }

export default function FamilySpaceScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  // An explicit ?groupId= (membership push "You are in", deep link) selects
  // that space. This param was ALREADY being sent by the push-tap handler and
  // silently ignored here — an accepted invitee landed on whatever space was
  // last open instead of the one they just joined. Applied once per value so
  // the switcher still works afterwards.
  const linkParams = useLocalSearchParams<{ groupId?: string }>();
  const appliedGroupId = useRef<string | null>(null);
  const [me, setMe] = useState<{ id: string; name: string } | null>(null);
  const [circles, setCircles] = useState<GroupRef[]>([]);
  const [active, setActive] = useState<GroupRef | null>(null);
  const [members, setMembers] = useState<CircleMember[]>([]);
  /** False until the roster has actually come back. Distinguishes "still
   *  loading" from "genuinely a space of one" — see `roster` below. */
  const [membersLoaded, setMembersLoaded] = useState(false);
  const [presences, setPresences] = useState<Record<string, MemberPresence>>({});
  /** How the roster is ordered (spec §9). Nearest first is the useful default. */
  const [sortMode, setSortMode] = useState<SortMode>('nearest');
  /**
   * What every distance is measured FROM (spec §34–39). null = me; otherwise
   * one of MY saved places, by name — "how far is everyone from Home".
   *
   * Measured against MY place, using MY coordinate for it, entirely on this
   * device. That is the only version of this question that can be answered
   * without anyone's place coordinate leaving their phone.
   */
  const [originName, setOriginName] = useState<string | null>(null);
  /** memberId → "Mother"/"Father"/… Fetched ready-made from the server. */
  const [relations, setRelations] = useState<RelationMap>({});
  const [share, setShare] = useState(false);
  // My own high-speed alert (off by default; detected on this device only).
  const [speedAlert, setSpeedAlert] = useState<{ enabled: boolean; thresholdKmh: number }>(
    { enabled: false, thresholdKmh: DEFAULT_SPEED_ALERT_KMH });
  // Render tick so freshness DECAYS without new data. Presences only re-render
  // this screen when a ping arrives — which is exactly never once the last
  // publisher stops, so "LIVE" and "1 sharing" froze on screen for as long as
  // the dashboard stayed open (observed on-device: 2.5 min after sharing was
  // switched off the card still claimed live). Same load-bearing tick as
  // space-ops-map and family-map.
  // Ticks only while the app is FOREGROUNDED — a backgrounded hub re-rendering
  // its roster and summary every 30 s is pure battery for pixels nobody sees.
  // Publishing is unaffected: that lives in presence.ts and the background task.
  const tick = useVisibleTick(30_000);
  // Location was refused (or never asked for). Not an error state — the space
  // works without it; only our own dot on the map is missing.
  const [locDenied, setLocDenied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [manage, setManage] = useState(false);
  const [checkin, setCheckin] = useState(false);
  const [renameTxt, setRenameTxt] = useState('');
  const [note, setNote] = useState('');
  /** Selected check-in status, held until Send (design screen 20). */
  const [picked, setPicked] = useState<typeof CHECKINS[number] | null>(null);
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
  // Runs this caller may see in this space (Spaces & Operations, S3.1/S3.4).
  // The SERVER decides what is in this list: ops sees the timetable, a driver
  // sees their own runs, a guardian sees the runs their linked riders are on.
  // Nothing here filters it further.
  const [runs, setRuns] = useState<SpaceRun[]>([]);
  // This circle's saved Places (device-local geofences) — they name the FAMILY
  // NOW board's "At Home / At School" rows. Statuses are derived here on the
  // viewing device from decrypted presences: positions are E2EE, so the server
  // cannot compute "at school", and this screen never invents one.
  const [places, setPlacesState] = useState<Geofence[]>([]);

  useEffect(() => { loadAlerts(); }, []);

  // Honour ?groupId= once per value, as soon as the registry knows the space.
  useEffect(() => {
    const want = linkParams.groupId ? String(linkParams.groupId) : '';
    if (!want || appliedGroupId.current === want) return;
    const g = circles.find((c) => c.id === want);
    if (g) { appliedGroupId.current = want; setActive(g); }
  }, [linkParams.groupId, circles]);

  // identity + circle list
  useEffect(() => { (async () => {
    const u = await getCurrentUserAsync().catch(() => null);
    setMe(u ? { id: String(u.id), name: u.name || u.email || 'Me' } : null);
    const cs = await loadGroupsReconciled();
    setCircles(cs);
    if (!cs.length) { router.replace('/group-create' as any); return; }
    // Reopen on the group the user was last in, not blindly the first.
    const remembered = await resolveActiveGroup();
    // Settings are READ BEFORE the first setState so active + share land in ONE
    // render. The await that used to sit between them split this into two, and
    // the presence effect (deps: active.id, me.id, share) fired twice — once
    // with share=false, then with share=true — starting two overlapping
    // startPresence calls that raced on module state. presence.ts now guards
    // that race properly; this removes the reason it happens at all.
    const s = await getSettings();
    setActive((prev) => prev ?? remembered ?? cs[0]);
    setShare(s.sharing);
    setSpeedAlert(s.speedAlert ?? { enabled: false, thresholdKmh: DEFAULT_SPEED_ALERT_KMH });
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
    circleMembers(id).then((m) => { setMembers(m); setMembersLoaded(true); }).catch(async (e: any) => {
      // Kicked, or the circle was deleted: the group now 403/404s forever.
      // Forget it locally instead of hammering the server from every focus
      // and highlights poll (seen live: one phone retrying a dead circle
      // every few seconds).
      if (e?.status === 403 || e?.status === 404) {
        await removeCircle(id);
        await afterCircleGone();
        return;
      }
      // Anything else — offline, a 500, a parse failure — used to vanish here
      // with no trace, leaving the fabricated one-person roster on screen and
      // nothing in the log to explain it. Say so, and leave `membersLoaded`
      // false so the UI shows "still loading" rather than asserting a roster
      // of one.
      console.warn('[family] could not load members:', e?.status ?? '', e?.message ?? e);
    });
  };
  useEffect(() => { setMembersLoaded(false); refreshMembers(); }, [active?.id]);

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
      // SUBSCRIBE FIRST. Receiving other people's sealed positions needs no
      // permission of ours, so it must not sit behind anything that does — a
      // parent who declined location still has to see the bus.
      try {
        const u = await subscribeCircle(active.id, me.id, (e: PresenceEvent) => {
          if (cancelled) return;
          // Keyed by member id via the shared fold — independence of every
          // member's entry is proven by lib/family/visibility.selftest.ts.
          // A relay ping may be older than a platform fix already folded in,
          // so it merges rather than overwrites (newest fix per member wins).
          // A stop is an explicit choice: retain the last-known fix, flagged,
          // instead of deleting the member's dot (spec: last known location).
          setPresences((prev) => (e.presence
            ? mergePresence(prev, {
              userId: e.userId, lat: e.presence.pos.lat, lng: e.presence.pos.lng,
              ts: e.presence.ts, spd: e.presence.speed, acc: e.presence.accuracy, bat: e.presence.battery,
            })
            : markSharingOff(prev, e.userId)));
        });
        if (cancelled) u(); else unsub = u;
      } catch { /* the map degrades to "nobody live yet"; the space still works */ }

      // The dedicated location service (all-space platform): snapshot of the
      // newest server-stored point per authorized member + live events. This
      // is the path with NO chat-E2EE dependency — it works even when a
      // member pair's sender-key session is wedged — and it gives a late
      // joiner the catch-up the sealed relay never could. Same store, same
      // fold: whichever source is fresher per member wins.
      try {
        const u2 = await subscribeSpaceLocations(active.id, me.id, (e) => {
          if (cancelled) return;
          setPresences((prev) => (e.point
            ? mergePresence(prev, {
              userId: e.userId, lat: e.point.pos.lat, lng: e.point.pos.lng,
              ts: e.point.ts, spd: e.point.speed, acc: e.point.accuracy, bat: e.point.battery,
            })
            : markSharingOff(prev, e.userId)));
        });
        if (cancelled) u2(); else { const prevUnsub = unsub; unsub = () => { prevUnsub?.(); u2(); }; }
      } catch { /* platform absent — the sealed relay path stands alone */ }

      // Then our own position, which is optional. requestPermission is only
      // true when sharing is already on — otherwise entering a space prompts
      // for a permission the screen does not use.
      try {
        const res = await startPresence({
          circleIds: [active.id], myId: me.id, myName: me.name, share,
          requestPermission: share,
          onSelf: (p) => setPresences((prev) => ({ ...prev, [p.userId]: p })),
        });
        if (!cancelled) setLocDenied(res.denied);
      } catch { if (!cancelled) setLocDenied(true); }
    })();
    return () => { cancelled = true; unsub?.(); stopPresence(); };
  // `share` IS a dependency, and its absence was a real field bug: settings
  // load async, so a cold start ran this with share=false and never re-ran —
  // the switch showed ON, the self-dot worked (the watcher runs regardless),
  // but startPresence never began BROADCASTING and never delivered keys.
  // Verified server-side: a whole session with the switch on produced zero
  // key messages. The eslint exhaustive-deps warning on this line was right.
  }, [active?.id, me?.id, share]);

  // stop broadcasting when the screen loses focus (map still resumes on return)
  useFocusEffect(React.useCallback(() => () => { stopPresence(); }, []));

  /**
   * FamilyMapRefreshController — the "never frozen" watchdog (spec §59/§60).
   *
   * Realtime stays the primary path; this only notices when it has quietly
   * stopped working (app resumed, screen unlocked, socket reconnected, network
   * came back, or nothing has arrived for too long) and re-fetches the
   * authoritative snapshot.
   *
   * It folds through the SAME mergePresence the live events use, so only
   * members whose fix actually changed move. The MapView is never remounted
   * and the camera is never reset — a reconcile the user can see is a bug.
   *
   * One controller, mounted once, torn down on unmount: stop() removes the
   * AppState, socket and NetInfo listeners plus the timer, so §100's
   * "exactly one subscription and one timer" holds across navigation.
   */
  useEffect(() => {
    if (!active?.id || !me?.id) return;
    const circleId = active.id, myId = me.id;
    return startRefreshController({
      onReconcile: async () => {
        for (const e of await fetchSpaceSnapshot(circleId, myId)) {
          setPresences((prev) => (e.point
            ? mergePresence(prev, {
              userId: e.userId, lat: e.point.pos.lat, lng: e.point.pos.lng,
              ts: e.point.ts, spd: e.point.speed, acc: e.point.accuracy, bat: e.point.battery,
            })
            : markSharingOff(prev, e.userId)));
        }
      },
    });
  }, [active?.id, me?.id]);

  // Relations ("Mother", "Father") arrive READY from the server, keyed by
  // member id and already scoped to me as the viewer — the app looks one up
  // while rendering a row and computes nothing. A failure leaves the map empty
  // and the roster renders plain names, exactly as it did before this existed.
  useEffect(() => {
    if (!active?.id) { setRelations({}); return; }
    let live = true;
    getRelations(active.id).then((r) => { if (live) setRelations(r); });
    return () => { live = false; };
  }, [active?.id]);

  // Tell the adaptive engine whether anyone is looking. Foreground + moving is
  // the only situation that justifies a 5 s GPS cadence; everything else steps
  // down. AppState 'active' covers both app-switching and screen unlock.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setPresenceForeground(s === 'active'));
    setPresenceForeground(AppState.currentState === 'active');
    return () => sub.remove();
  }, []);

  // Refresh on focus — /family-add and /family-setup both mutate state this
  // screen already has in memory, and neither changes active.id, so nothing
  // else would re-read it. Places too: /family-places edits them and comes
  // straight back here, where the FAMILY NOW board is derived from them.
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
    if (active?.id) getPlaces(active.id).then((p) => { if (live) setPlacesState(p); }).catch(() => {});
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, active?.id]));

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
    // setSharing asks for location permission when turning ON — that is the
    // moment it is genuinely needed. If it is refused, leave the switch OFF
    // rather than showing it on while nothing is being published.
    let ok = v;
    try { ok = await setSharing(v); } catch { ok = false; }
    setShare(ok);
    setLocDenied(v && !ok);
    await setSettings({ sharing: ok });

    // TURNING SHARING ON IS THE MOMENT TO ASK FOR THE THINGS THAT KEEP IT ON.
    // A location foreground service is not enough by itself on most Android
    // phones sold here: EMUI/MIUI/ColorOS kill background work aggressively, so
    // a locked phone stops publishing and the family sees someone "vanish"
    // while the app believes it is sharing. Asked ONCE per circle, never
    // nagged — the flag records that we have asked, not that they said yes.
    if (ok && v) {
      try {
        const askedKey = 'vc_family_bg_asked';
        const asked = await AsyncStorage.getItem(askedKey);
        if (!asked) {
          await AsyncStorage.setItem(askedKey, '1');
          const bg = await canShareInBackground();
          if (!bg) await requestBackgroundPermission();
          await requestIgnoreBatteryOptimizations();
          if (await needsAutoStartGuidance()) {
            Alert.alert(
              'Keep sharing when locked',
              `${(await getManufacturer()).toUpperCase()} phones stop background apps to save power, which stops your location too.\n\n`
              + 'Turn ON auto-start for VaultChat so your family keeps seeing you while the screen is locked.',
              [{ text: 'Later', style: 'cancel' }, { text: 'Open settings', onPress: () => { openAutoStartSettings().catch(() => {}); } }],
            );
          }
        }
      } catch { /* guidance is best-effort; sharing itself already succeeded */ }
    }
    if (v && !ok) {
      Alert.alert(
        'Location is turned off',
        `VaultChat needs location permission to share your position with ${active?.name ?? 'this space'}. `
        + 'You can still use everything else here without it.',
        [{ text: 'Not now' }, { text: 'Open settings', onPress: () => { Linking.openSettings().catch(() => {}); } }],
      );
      return;
    }
    if (ok) await offerBackground();
  };

  const toggleSpeedAlert = async (on: boolean) => {
    const next = { enabled: on, thresholdKmh: speedAlert.thresholdKmh };
    setSpeedAlert(next);
    await setSettings({ speedAlert: next }).catch(() => {});
  };
  const cycleSpeedThreshold = async () => {
    const i = SPEED_ALERT_CHOICES.indexOf(speedAlert.thresholdKmh as typeof SPEED_ALERT_CHOICES[number]);
    const next = { enabled: true, thresholdKmh: SPEED_ALERT_CHOICES[(i + 1) % SPEED_ALERT_CHOICES.length] };
    setSpeedAlert(next);
    await setSettings({ speedAlert: next }).catch(() => {});
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
      lat: p.pos.lat, lng: p.pos.lng, battery: p.battery, self: uid === me?.id,
      // A sharing-off member's last-known dot renders dimmed, never live.
      stale: now - p.ts > STALE_MS || !!p.sharingOff,
    }));
  // `tick` keeps the stale fade honest when no new ping ever arrives.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presences, members, me?.id, tick]);

  // Members this device has no position for.
  //
  // WHY THIS EXISTS. Markers come only from `presences`, so a member who has not
  // turned sharing on simply does not appear — and an absent marker is
  // indistinguishable from a broken map. Sharing is opt-in PER DEVICE and
  // defaults to off, so the common case for a new phone is an empty map with no
  // explanation, which reads as "the app does not work".
  //
  // This device cannot tell "not sharing" from "sharing but no fix has reached
  // us yet" — both look like silence — so the wording covers both rather than
  // accusing anyone of having it switched off.
  const notVisible = useMemo(
    () => members.filter((m) => m.id !== me?.id && !presences[m.id]).map((m) => m.name),
    [members, presences, me?.id],
  );

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
  // Ops capabilities. NOT defaulted to isAdminish like the ones above: a
  // "Transport Manager" is an admin who should see runs, but a Family admin is
  // an admin who has no runs to see, and showing an empty operations card in
  // every household group would be noise. The permission is the whole test.
  const canDrive    = hasPerm(perms, 'drive_run');
  const canOps      = hasPerm(perms, 'view_space_ops') || hasPerm(perms, 'manage_runs');

  // Active runs for this space. Only asked for when the caller holds an ops
  // permission — a Family group has no runs, and a 200 with an empty array on
  // every dashboard open is a request nobody needed. Declared after the
  // permission checks it depends on, which is why this effect sits here rather
  // than beside the other loaders.
  // Ask for runs in ANY operational space, not only when the caller holds an
  // ops permission.
  //
  // This gate used to be `canDrive || canOps`, and it was why a school space
  // looked completely empty. A parent is an ordinary `member`: migration 084
  // gives school members no permissions at all, deliberately, because their
  // access comes from space_links rather than from a permission. So the client
  // never asked for runs — and the parent never saw their child's bus, even
  // though the SERVER would have returned exactly that one run and nothing else.
  //
  // The server is the authority on what a caller may see (vc_run_visible: ops
  // sees the timetable, a driver their own runs, a guardian the runs their
  // linked riders are on). Deciding here that they may see nothing was the
  // client overruling it, which is the one thing this codebase keeps proving is
  // wrong.
  // Space type drives the dashboard. isOperational is also the runs gate: a
  // school parent holds NO permissions, so gating the fetch on ops rights meant
  // they never asked for the run their own child is on.
  const spaceFamily = familyOf(active?.groupType);
  const opsSpace = isOperational(active?.groupType);
  const sections = useMemo(
    () => sectionsFor(active?.groupType, perms),
    [active?.groupType, perms],
  );
  useEffect(() => {
    if (!active?.id || !(canDrive || canOps || opsSpace)) { setRuns([]); return; }
    let live = true;
    getRuns(active.id, true)
      .then((r) => { if (live) setRuns(r || []); })
      // Silent: an operations card that failed to load must not interrupt a
      // dashboard whose other half is working.
      .catch(() => { if (live) setRuns([]); });
    return () => { live = false; };
  }, [active?.id, canDrive, canOps, opsSpace]);

  // S3.4 — a driver on the road lands on their manifest, not here.
  //
  // Three guards, and each one is there because the alternative traps someone:
  //   · only while a run is actually STARTED, so an off-duty driver keeps the
  //     whole app instead of being redirected out of it every time they open it
  //   · only for a driver who is NOT ops, because a Transport Manager who also
  //     drives needs the dashboard they came for
  //   · ONCE per mount (the ref), so pressing Back from the manifest returns
  //     here and stays here rather than bouncing straight out again
  const droveOnce = useRef(false);
  useEffect(() => {
    if (droveOnce.current || canOps || !canDrive || !active?.id || !me?.id) return;
    const mine = runs.find((r) => r.driverId === me.id && r.status === 'started');
    if (!mine) return;
    droveOnce.current = true;
    router.push({ pathname: '/space-run-driver' as any, params: { spaceId: active.id, runId: mine.id, groupType: active.groupType ?? '' } });
  }, [runs, canDrive, canOps, active?.id, me?.id, router]);
  // Identity for this group's type — icon and accent drive the whole dashboard.
  const ident = groupIdentity(active ?? {});
  const liveCount = useMemo(() => {
    const now = Date.now();
    return Object.entries(presences).filter(([uid, p]) => {
      // An explicit sharing-off never counts as live — neither another
      // member's stop, nor my own switch being off. Without this the map
      // tile said "1 sharing" while the board said "Location off 1" for the
      // same person, which is exactly the disagreement the board exists to
      // prevent (seen on device).
      if (p.sharingOff) return false;
      if (uid === me?.id && !share) return false;
      return now - p.ts <= STALE_MS;
    }).length;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presences, tick, share, me?.id]);

  /**
   * The distance layer (spec §7–12): every member's straight-line distance from
   * me, plus the family summary.
   *
   * Computed HERE, on the viewing device, from presences this device already
   * decrypted — not on the server. That is a deliberate exception to the
   * thin-client rule: on the sealed relay the server never sees a coordinate,
   * so it could not compute these even if we asked it to.
   *
   * A member with no usable fix gets fromMe: null, never zero — counting the
   * unlocatable as "0 km away" would make the summary claim the family is
   * closer together than it is.
   */
  const distanceRows = useMemo(() => {
    const now = Date.now();
    const mineNow = me ? presences[me.id] : undefined;
    // The origin every distance is measured from: my own position by default,
    // or one of MY saved places when one is picked ("how far is everyone from
    // Home"). A picked place that has since been deleted falls back to me
    // rather than silently measuring from nowhere.
    const origin = originName
      ? (places.find((p) => p.name === originName)?.center ?? mineNow?.pos ?? null)
      : (mineNow?.pos ?? null);
    return memberDistances(members.map((m) => {
      const p = presences[m.id];
      const usable = !!p && freshnessOf(p.ts, now) !== 'unavailable';
      return {
        id: m.id,
        // The relation LEADS when set — "Mother · Arun" identifies a person on
        // a family map faster than a display name does. Server-supplied, so
        // this is a lookup, not a computation.
        name: m.id === me?.id ? 'You' : memberLabel(m.name, relations[m.id]),
        pos: usable ? p.pos : null,
        refs: p?.sharingOff ? null : p?.refs,
        ts: p?.ts,
        // Measuring from a PLACE makes me an ordinary traveller to it — my own
        // distance from Home is exactly the number being asked for. Measuring
        // from myself keeps me excluded, since "You are 0 km from You" is noise.
        self: m.id === me?.id && !originName,
        unavailable: !usable,
      };
    }), origin);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presences, members, me?.id, tick, originName, places, relations]);

  const distanceSummary = useMemo(() => summarizeDistances(distanceRows), [distanceRows]);
  /**
   * Is there anyone at all we could measure — INCLUDING me?
   *
   * The origin chips are gated on this rather than on the summary's `available`,
   * which deliberately excludes self. Gating on `available` was a chicken-and-egg
   * bug: in a circle where I am the only member with a fix, available is 0, so
   * the chips stayed hidden, so I could never switch the origin to Home — the
   * one case where my own distance IS the answer being asked for.
   */
  const anyoneLocatable = useMemo(
    () => distanceRows.some((r) => r.fromMe != null) || (!!me && !!presences[me.id]),
    [distanceRows, me, presences],
  );
  /** Member ids in the chosen order, for the roster to follow. */
  const sortedIds = useMemo(
    () => sortMembers(distanceRows, sortMode).map((r) => r.id),
    [distanceRows, sortMode],
  );

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
      setPicked(null);
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
  // Only stand in for the roster once we KNOW it is empty.
  //
  // This used to be `members.length ? members : [me]`, which fabricated a
  // one-person roster whenever `members` was empty — and `members` is empty for
  // the whole time the fetch is in flight, and stays empty after any error
  // refreshMembers swallows. The screen then stated "1 of 1 sharing live" and
  // listed only You, as fact, for a space with three people in it. Opening
  // Family and being told you are alone in it is what "family is not working"
  // looks like from the outside.
  //
  // Same rule as everywhere else in this change: not-yet-known and known-empty
  // are different states, and only one of them may be asserted.
  const unsortedRoster = members.length
    ? members
    : (membersLoaded && me ? [{ id: me.id, name: 'You', role: 'guardian' as const, avatar: null }] : []);
  // Apply the chosen order (spec §9). A member the distance layer has not seen
  // sorts LAST rather than first — an unranked row floating to the top would
  // read as "nearest", which is the one thing it is not known to be. n ≤ 10,
  // so the rank lookup is a map build, not a concern.
  const rank = new Map(sortedIds.map((id, i) => [id, i]));
  const roster = [...unsortedRoster].sort(
    (a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity),
  );
  const allGood = liveCount > 0;
  const firstName = (me?.name || 'there').split(/\s+/)[0];

  const memberRow = (m: CircleMember, i: number) => {
    const p = presences[m.id];
    const isMe = m.id === me?.id;
    // The reference distance THIS MEMBER published ("1.2 km from Home").
    // Derived on their device from their own places — we hold the number and
    // the place's name, never its coordinate. Absent for members on older
    // builds, for anyone who has saved no places, and once they stop sharing.
    const ref = p && !p.sharingOff ? defaultRef(p.refs) : null;
    const d = p && mine && !isMe ? dist(haversine(mine.pos, p.pos)) : null;
    // Freshness tier for the row's caption (spec: LIVE / RECENT / STALE /
    // UNAVAILABLE). A fix past the recent window is "Last known", never live.
    //
    // SILENCE IS NOT A REASON. For another member, this device only ever
    // receives sealed pings — sharing-off, app-killed, offline, permission
    // missing and no-GPS all look identical (nothing arrives), so the caption
    // must not assert a cause ("Location off" accused people who were merely
    // offline). For MYSELF the device does know which it is, and says so.
    const fresh = freshnessOf(p?.ts, Date.now());
    const band = speedBand(p?.speed);
    const rowCaption = (isMe && !share)
      // MY OWN row while sharing is off. The watcher keeps running so my dot
      // stays on my own map — but the caption must never claim I am
      // broadcasting. Found on device: the switch read OFF while this row
      // still said LIVE, which is the one thing a sharing control must not do.
      ? (p ? `Location sharing off · my last fix ${ago(p.ts)}` : 'Location sharing off')
      : p?.sharingOff
        // An EXPLICIT stop by ANOTHER member: the one silence whose reason we
        // truly know — they said so. Last-known retained, never shown as LIVE.
        ? `Location sharing off · last seen ${ago(p.ts)}`
        : !p || fresh === 'unavailable'
        ? (isMe
          ? (!share ? 'Location sharing off'
            : locDenied ? 'Location permission needed'
              : 'Waiting for GPS fix…')
          : 'No location received')
        : fresh === 'stale'
          ? `Last known · ${ago(p.ts)}`
          : `${fresh === 'live' ? 'LIVE' : ago(p.ts)}${d ? ` · ${d} away` : ''}${band && band !== 'stationary' ? ' · moving' : ''}`;
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
            <Text style={{ color: colors.text, fontWeight: '600' }} numberOfLines={1}>
              {isMe ? 'You' : memberLabel(m.name, relations[m.id])}
            </Text>
            {m.role === 'guardian' && <Ionicons name="star" size={11} color={colors.primary} />}
          </View>
          <Text style={{ color: fresh === 'live' ? colors.success : colors.textDim, fontSize: 12 }} numberOfLines={1}>
            {rowCaption}
          </Text>
          {/* Their own reference distance, on its own line so the freshness
              caption above keeps its meaning. Only shown with a usable fix —
              a distance-from-Home computed for a position we no longer trust
              is exactly the stale number the freshness tiers exist to prevent. */}
          {ref && fresh !== 'unavailable' && fresh !== 'stale' && (
            <Text style={{ color: colors.textDim, fontSize: 12 }} numberOfLines={1}>
              {formatMetres(ref.d)} from {ref.n}
            </Text>
          )}
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
    <>
      <View style={st.shareRow}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Ionicons name={share ? 'navigate' : 'navigate-outline'} size={18} color={share ? colors.primary : colors.textDim} />
          <Text style={{ color: colors.text, fontWeight: '600' }}>Share my location</Text>
        </View>
        <Switch value={share} onValueChange={toggleShare} trackColor={{ true: colors.primary }} />
      </View>
      {/* Explains itself in the SPACE'S OWN TERMS, and only where it matters.
          The old copy said "Location permission is required for Family Circle"
          in every space type — including a school, where a parent needs no
          location at all — and it was an alert on entry rather than a note. */}
      {locDenied && (
        <Text style={{ color: colors.textDim, fontSize: 12, lineHeight: 17, marginTop: -4, marginBottom: 10 }}>
          {locationRationale(active?.groupType)}
        </Text>
      )}
      {/* What the adaptive engine is doing right now, in words.
          §71 forbids claiming battery optimisation without measurement — and
          until this line existed there was no way to observe the engine at all
          from a device: expo-location registers through Play Services, so
          `dumpsys location` attributes our interval to com.google.android.gms
          and shows nothing for this app. It also tells a user why their dot
          updates slowly, which is the most common "it's broken" report. */}
      {share && !!currentPlan() && (
        <Text style={{ color: colors.textFaint, fontSize: 11.5, marginTop: -4, marginBottom: 10 }} numberOfLines={2}>
          {currentPlan()!.reason} · every {Math.round(currentPlan()!.timeIntervalMs / 1000)}s
          {currentPlan()!.publish ? '' : ' · not publishing'}
        </Text>
      )}
    </>
  );

  return (
    <View style={[st.screen, { backgroundColor: colors.bg }]}>
      {/* The space's own name when there is one; otherwise the module's name.
          NOT "Family Space" — family is one type among sixteen, and a school
          transport space titled "Family Space" reads as a bug. */}
      <Stack.Screen options={{
        // headerShown is FALSE app-wide (root layout), so without opting back
        // in this header — and with it the back chevron, the person-add invite
        // button and the ⋯ manage-sheet trigger — simply never rendered on a
        // device. Everything behind the sheet (rename, invitations, calendar,
        // albums, privacy, leave/delete) was unreachable. Same fix as the
        // space module's spaceHeader().
        headerShown: true,
        headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text, headerShadowVisible: false,
        title: active?.name || 'Spaces', headerTitleAlign: 'center',
        // A way OUT. This screen is a hub people land on and then cannot leave
        // except with the system back gesture — which is not obvious, and on a
        // parent's phone the whole point is to move between their family and
        // their child's school transport space.
        headerLeft: () => (
          <TouchableOpacity
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/mini' as any))}
            style={{ paddingHorizontal: 8 }}
          >
            <Ionicons name="chevron-back" size={24} color={colors.primary} />
          </TouchableOpacity>
        ),
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
          {/* greeting (design screen 5) — the bell is the one thing the mockup
              adds here: a standing route to the alerts centre with an unread
              dot, so a new alert is visible without opening a tile. */}
          <View style={st.greetRow}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: colors.text, fontSize: 20, fontWeight: '800' }}>{greeting()}, {firstName} 👋</Text>
              <Text style={{ color: colors.textDim, fontSize: 12.5, marginTop: 2 }} numberOfLines={1}>
                {active?.name}{active?.groupType && ident.label !== active.name ? ` · ${ident.label}` : ''}
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => active && router.push({ pathname: '/family-alerts' as any, params: { circleId: active.id, circleName: active.name } })}
              style={[st.greetBell, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <Ionicons name="notifications-outline" size={19} color={colors.text} />
              {unread > 0 && <View style={[st.bellDot, { backgroundColor: colors.danger, borderColor: colors.card }]} />}
            </TouchableOpacity>
          </View>

          {/* Space switcher.
              Shown whenever there is anywhere to go — including with a single
              space, where the "New space" chip is the only route to creating a
              School or Employee one. Hiding it below two spaces meant a family
              with one circle had no visible way to reach anything else. */}
          {circles.length > 0 && (
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
              {/* Always last: the only visible route to a School, Office or
                  Transport space. Without it a user with one Family circle can
                  never discover that other space types exist. */}
              <TouchableOpacity
                onPress={() => router.push('/group-create' as any)}
                style={[st.chip, { flexDirection: 'row', alignItems: 'center', gap: 6, borderColor: colors.primary }]}
              >
                <Ionicons name="add" size={14} color={colors.primary} />
                <Text style={{ color: colors.primary, fontWeight: '700', fontSize: 13 }}>New space</Text>
              </TouchableOpacity>
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
              <Text style={{ color: colors.textDim, fontSize: 11.5, letterSpacing: 0.3 }}>
                {(ident.label || 'Family').toUpperCase()} STATUS
              </Text>
              <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15 }}>{allGood ? 'All good' : 'Nobody live yet'}</Text>
              <Text style={{ color: colors.textDim, fontSize: 12 }}>
                {/* "Loading" is its own state. Counting against a roster that
                    has not arrived is how this line claimed "1 of 1" for a
                    three-person space. */}
                {!membersLoaded ? 'Loading members…'
                  : liveCount ? `${liveCount} of ${roster.length} sharing live`
                    : share ? 'Waiting for locations…'
                      : 'Turn on sharing to appear on the map'}
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => active && router.push({ pathname: '/group-members' as any, params: { groupId: active.id, name: active.name } })}
              style={{ alignItems: 'flex-end', gap: 6 }}
            >
              <View style={st.avatarRow}>
                {roster.slice(0, 4).map((m, i) => (
                  <View key={m.id} style={[st.miniDot, { backgroundColor: colorFor(m.id), marginLeft: i ? -8 : 0, borderColor: colors.card, opacity: presences[m.id] ? 1 : 0.45 }]}>
                    <Text style={st.miniDotTxt}>{(m.name || '?').trim()[0]?.toUpperCase()}</Text>
                  </View>
                ))}
                {roster.length > 4 && <View style={[st.miniDot, { backgroundColor: colors.border, marginLeft: -8, borderColor: colors.card }]}><Text style={[st.miniDotTxt, { color: colors.text }]}>+{roster.length - 4}</Text></View>}
              </View>
              <Text style={{ color: colors.primary, fontSize: 11.5, fontWeight: '700' }}>View All</Text>
            </TouchableOpacity>
          </View>

          {/* map preview */}
          <TouchableOpacity activeOpacity={0.9} onPress={() => setExpanded(true)} style={[st.mapCard, { borderColor: colors.border }]}>
            <FamilyMap members={markers} focusId={focusId} onSelect={() => setExpanded(true)} style={{ flex: 1 }} />
            <View style={[st.mapBadge, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Ionicons name="expand" size={13} color={colors.text} /><Text style={{ color: colors.text, fontSize: 12, fontWeight: '700' }}>Live Map</Text>
            </View>
          </TouchableOpacity>

          {/* Why the map is emptier than the member list (see notVisible).
              Location sharing is opt-in on EACH device, so one phone sharing
              does not make the other appear — and without this line an empty
              map looks like a fault rather than a setting. */}
          {notVisible.length > 0 && (
            <View style={[st.card, { backgroundColor: colors.card, borderColor: colors.border, flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 }]}>
              <Ionicons name="location-outline" size={17} color={colors.textDim} />
              <Text style={{ color: colors.textDim, fontSize: 12.5, flex: 1, lineHeight: 17 }}>
                No location from {notVisible.slice(0, 3).join(', ')}
                {notVisible.length > 3 ? ` and ${notVisible.length - 3} more` : ''}.
                {' '}Each person turns sharing on from their own phone.
              </Text>
            </View>
          )}

          {/* FAMILY NOW — member statuses derived ON THIS DEVICE (spec §31):
              decrypted presences × this device's saved Places. The server
              cannot read positions, so it cannot compute these; and a board
              may only assert counts once the roster is actually known. Zero
              rows are dropped rather than shown as a wall of noise — except
              "No location", which is the honest count that keeps the rest in
              context. */}
          {(spaceFamily === 'family' || spaceFamily === 'generic') && membersLoaded && roster.length > 1 && (() => {
            // My own entry counts as sharing-off when MY switch is off, so the
            // board agrees with my row's caption instead of counting my
            // private dot as one of the family's live members.
            const forBoard = (me && !share && presences[me.id])
              ? { ...presences, [me.id]: { ...presences[me.id], sharingOff: true } }
              : presences;
            const b = statusBoard(roster.map((m) => m.id), forBoard, places, Date.now());
            // TWO GROUPS, AND THEY MUST NOT LOOK LIKE ONE SUM. The first row
            // PARTITIONS the roster — every member in exactly one bucket, so
            // the numbers add up to the family. The second says WHERE the
            // reachable ones are, and necessarily re-counts those same people.
            // Rendered as one undifferentiated row, a 2-member circle showed
            // four chips totalling 4 (seen on device).
            const chips: { icon: string; label: string; n: number }[] = [
              { icon: 'radio-outline', label: 'Live', n: b.live },
              { icon: 'time-outline', label: 'Recent', n: b.recent },
              { icon: 'moon-outline', label: 'Last known', n: b.stale },
              { icon: 'eye-off-outline', label: 'Location off', n: b.sharingOff },
              { icon: 'cloud-offline-outline', label: 'No location', n: b.noLocation },
            ].filter((c) => c.n > 0);
            const whereChips: { icon: string; label: string; n: number }[] = [
              ...[...b.atPlace.entries()].filter(([, n]) => n > 0)
                .map(([name, n]) => ({ icon: 'location', label: `At ${name}`, n })),
              { icon: 'car-outline', label: 'Traveling', n: b.traveling },
              { icon: 'walk-outline', label: 'Away', n: b.away },
            ].filter((c) => c.n > 0);
            if (!chips.length) return null;
            return (
              <View style={[st.card, { backgroundColor: colors.card, borderColor: colors.border, marginBottom: 12 }]}>
                <Text style={[st.secTitle, { color: colors.textDim, marginBottom: 8 }]}>
                  {spaceFamily === 'family' ? 'FAMILY NOW' : 'RIGHT NOW'} · {b.total} {b.total === 1 ? 'MEMBER' : 'MEMBERS'}
                </Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {chips.map((c) => (
                    <View key={c.label} style={[st.chip, { borderColor: colors.border, flexDirection: 'row', alignItems: 'center', gap: 5 }]}>
                      <Ionicons name={c.icon as any} size={13} color={colors.primary} />
                      <Text style={{ color: colors.text, fontSize: 12.5, fontWeight: '600' }}>{c.label}</Text>
                      <Text style={{ color: colors.primary, fontSize: 12.5, fontWeight: '800' }}>{c.n}</Text>
                    </View>
                  ))}
                </View>
                {whereChips.length > 0 && (
                  <>
                    <Text style={{ color: colors.textFaint, fontSize: 11, marginTop: 10, marginBottom: 6 }}>
                      Where they are
                    </Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                      {whereChips.map((c) => (
                        <View key={c.label} style={[st.chip, { borderColor: colors.border, flexDirection: 'row', alignItems: 'center', gap: 5 }]}>
                          <Ionicons name={c.icon as any} size={13} color={colors.textDim} />
                          <Text style={{ color: colors.textDim, fontSize: 12.5, fontWeight: '600' }}>{c.label}</Text>
                          <Text style={{ color: colors.text, fontSize: 12.5, fontWeight: '800' }}>{c.n}</Text>
                        </View>
                      ))}
                    </View>
                  </>
                )}
              </View>
            );
          })()}

          {/* A SCHOOL, OFFICE OR CAB SPACE GETS ITS OWN SECTIONS.
              Not a different app — the same screen, the same header, switcher,
              map and members, with the middle band routed by space type. A
              school parent used to land on Safe Zones and SOS with their
              child's bus below the fold; now transport leads and the family
              tools are simply not there. lib/spaces/layout.ts owns the
              decision, so it is testable without a renderer. */}
          {spaceFamily !== 'family' && spaceFamily !== 'generic' ? (
            <View style={st.qaGrid}>
              {sections.map((s) => (
                <TouchableOpacity
                  key={s.key}
                  onPress={() => active && router.push({
                    pathname: s.route as any,
                    params: {
                      spaceId: active.id, circleId: active.id,
                      name: active.name, circleName: active.name,
                      groupType: active.groupType ?? '',
                      perms: Array.from(perms).join(','),
                    },
                  })}
                  style={[st.qa, { backgroundColor: colors.card, borderColor: colors.border }]}
                >
                  <View style={[st.qaIcon, { backgroundColor: colors.primary + '22' }]}>
                    <Ionicons name={s.icon as any} size={19} color={colors.primary} />
                  </View>
                  <Text style={[st.qaTitle, { color: colors.text }]}>{s.label}</Text>
                  <Text style={[st.qaSub, { color: colors.textDim }]} numberOfLines={1}>{s.hint}</Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : (
          /* Quick actions (design screen 5).
              Icon in a tinted rounded square, title, and a subtitle saying what
              it does — the mockup's shape. Each tile keeps its existing
              permission gate; the restyle changes how they look, never who can
              see them. */
          <View style={st.qaGrid}>
            <TouchableOpacity
              onPress={() => setExpanded(true)}
              style={[st.qa, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <View style={[st.qaIcon, { backgroundColor: colors.primary + '22' }]}>
                <Ionicons name="map" size={19} color={colors.primary} />
              </View>
              <Text style={[st.qaTitle, { color: colors.text }]}>Live Map</Text>
              <Text style={[st.qaSub, { color: colors.textDim }]} numberOfLines={1}>
                {liveCount ? `${liveCount} sharing` : 'See all'}
              </Text>
            </TouchableOpacity>

            {/* MEET HERE (§40). This tile exists because without it the whole
                feature was unreachable: the Live Map tile above expands the map
                INLINE (setExpanded) and never routes, and the only other path to
                /family-map is a member's "Follow", which refuses unless that
                member has a same-day fix. Found on the Honor — Meet Here and
                Family Center were built and shipped behind a door with no
                handle, which no self-check could ever have caught. */}
            <TouchableOpacity
              onPress={() => active && router.push({
                pathname: '/family-map' as any,
                params: { circleId: active.id, circleName: active.name },
              })}
              style={[st.qa, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <View style={[st.qaIcon, { backgroundColor: colors.primary + '22' }]}>
                <Ionicons name="search" size={19} color={colors.primary} />
              </View>
              <Text style={[st.qaTitle, { color: colors.text }]}>Meet Here</Text>
              <Text style={[st.qaSub, { color: colors.textDim }]} numberOfLines={1}>Pick a place to meet</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => router.push('/emergency-sos' as any)}
              style={[st.qa, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <View style={[st.qaIcon, { backgroundColor: colors.danger + '22' }]}>
                <Ionicons name="medkit" size={19} color={colors.danger} />
              </View>
              <Text style={[st.qaTitle, { color: colors.text }]}>SOS</Text>
              <Text style={[st.qaSub, { color: colors.textDim }]} numberOfLines={1}>Emergency</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => setCheckin(true)}
              style={[st.qa, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <View style={[st.qaIcon, { backgroundColor: colors.success + '22' }]}>
                <Ionicons name="checkmark-done-circle" size={19} color={colors.success} />
              </View>
              <Text style={[st.qaTitle, { color: colors.text }]}>Check-in</Text>
              <Text style={[st.qaSub, { color: colors.textDim }]} numberOfLines={1}>Share status</Text>
            </TouchableOpacity>

            {canZones && (
              <TouchableOpacity
                onPress={() => active && router.push({ pathname: '/family-places' as any, params: { circleId: active.id, name: active.name } })}
                style={[st.qa, { backgroundColor: colors.card, borderColor: colors.border }]}
              >
                <View style={[st.qaIcon, { backgroundColor: colors.primary + '22' }]}>
                  <Ionicons name="location" size={19} color={colors.primary} />
                </View>
                <Text style={[st.qaTitle, { color: colors.text }]}>Safe Zones</Text>
                <Text style={[st.qaSub, { color: colors.textDim }]} numberOfLines={1}>Places that matter</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity
              onPress={() => active && router.push({ pathname: '/family-alerts' as any, params: { circleId: active.id, circleName: active.name } })}
              style={[st.qa, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <View style={[st.qaIcon, { backgroundColor: colors.primary + '22' }]}>
                <Ionicons name="notifications" size={19} color={colors.primary} />
              </View>
              <Text style={[st.qaTitle, { color: colors.text }]}>Alerts</Text>
              <Text style={[st.qaSub, { color: colors.textDim }]} numberOfLines={1}>
                {unread > 0 ? `${unread > 99 ? '99+' : unread} unread` : 'All caught up'}
              </Text>
              {unread > 0 && (
                <View style={[st.badge, { backgroundColor: colors.danger, borderColor: colors.card }]}>
                  <Text style={st.badgeTxt}>{unread > 99 ? '99+' : unread}</Text>
                </View>
              )}
            </TouchableOpacity>

            {canHistory && (
              <TouchableOpacity
                onPress={() => active && router.push({ pathname: '/family-history' as any, params: { circleId: active.id, circleName: active.name } })}
                style={[st.qa, { backgroundColor: colors.card, borderColor: colors.border }]}
              >
                <View style={[st.qaIcon, { backgroundColor: colors.primary + '22' }]}>
                  <Ionicons name="time" size={19} color={colors.primary} />
                </View>
                <Text style={[st.qaTitle, { color: colors.text }]}>History</Text>
                <Text style={[st.qaSub, { color: colors.textDim }]} numberOfLines={1}>Where everyone was</Text>
              </TouchableOpacity>
            )}
          </View>
          )}

          {/* hold-to-SOS — a family/friends affordance. A school parent holding
              their phone down to raise an alarm to a whole school is not the
              same gesture, and a bus space has its own incident flow. */}
          {(spaceFamily === 'family' || spaceFamily === 'generic') && (
          <Pressable onPressIn={sosStart} onPressOut={sosEnd} style={[st.sosBig, { borderColor: colors.danger, backgroundColor: colors.danger + '14' }]}>
            <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: colors.danger + '55', transform: [{ scaleX: sosProg }] }]} />
            <View style={[st.sosIcon, { backgroundColor: colors.danger }]}><Text style={{ fontSize: 20 }}>🆘</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.danger, fontWeight: '900', fontSize: 15 }}>HOLD FOR SOS</Text>
              <Text style={{ color: colors.textDim, fontSize: 12 }}>Alerts your circle and shares your live location</Text>
            </View>
          </Pressable>
          )}

          {shareToggleRow}

          {/* Operations (Spaces & Operations, S3.1 / S3.4).
              A driver's own run comes FIRST and is styled as the primary action:
              S3.4 says a driver never lands on a dashboard, and the honest way
              to honour that on a shared screen is to put their manifest above
              everything else rather than to hide the rest. */}
          {runs.filter((r) => canDrive && r.driverId === me?.id).map((r) => (
            <TouchableOpacity
              key={r.id}
              onPress={() => router.push({ pathname: '/space-run-driver' as any, params: { spaceId: active!.id, runId: r.id, groupType: active!.groupType ?? '' } })}
              style={[st.card, { backgroundColor: colors.card, borderColor: colors.primary, flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 }]}
            >
              <View style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary + '22' }}>
                <Ionicons name="bus" size={20} color={colors.primary} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: colors.text, fontWeight: '700', fontSize: 14.5 }} numberOfLines={1}>
                  {r.vehicleLabel || r.name}
                </Text>
                <Text style={{ color: colors.textDim, fontSize: 12 }} numberOfLines={1}>
                  {r.status === 'started' ? 'Your run is in progress' : 'Tap to start your run'}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
            </TouchableOpacity>
          ))}

          {/* Everything else the caller may see. For a guardian this is the bus
              their child is on; for ops it is the whole active timetable. */}
          {runs.filter((r) => !(canDrive && r.driverId === me?.id)).length > 0 && (
            <View style={[st.card, { backgroundColor: colors.card, borderColor: colors.border, marginBottom: 14 }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
                <Text style={{ color: colors.text, fontWeight: '700', fontSize: 14.5, flex: 1 }}>
                  {canOps ? 'Runs in progress' : 'Today’s run'}
                </Text>
                {canOps && (
                  <TouchableOpacity
                    onPress={() => active && router.push({ pathname: '/space-ops-map' as any, params: { spaceId: active.id, name: active.name, groupType: active.groupType ?? '' } })}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
                  >
                    <Ionicons name="map-outline" size={15} color={colors.primary} />
                    <Text style={{ color: colors.primary, fontSize: 12.5, fontWeight: '600' }}>Map</Text>
                  </TouchableOpacity>
                )}
              </View>
              {runs.filter((r) => !(canDrive && r.driverId === me?.id)).map((r) => (
                <TouchableOpacity
                  key={r.id}
                  onPress={() => router.push({ pathname: '/space-run' as any, params: { spaceId: active!.id, runId: r.id, groupType: active!.groupType ?? '' } })}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 }}
                >
                  <Ionicons
                    name={r.status === 'started' ? 'navigate' : 'time-outline'}
                    size={16}
                    color={r.stale ? colors.danger : (r.status === 'started' ? colors.success : colors.textDim)}
                  />
                  <Text style={{ color: colors.text, flex: 1 }} numberOfLines={1}>
                    {r.vehicleLabel || r.name}
                  </Text>
                  {/* A vehicle that has stopped reporting is called out here and
                      not left to look identical to one that is running fine. */}
                  {r.stale && r.status === 'started' && (
                    <Text style={{ color: colors.danger, fontSize: 12 }}>not reporting</Text>
                  )}
                  <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
                </TouchableOpacity>
              ))}
            </View>
          )}

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
            <Text style={[st.secTitle, { color: colors.text }]}>{memberHeading(active?.groupType)}</Text>
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
          {/* FAMILY DISTANCE (spec §11). Only once there is something to
              compare — a one-person circle has no nearest and no average, and
              printing "Nearest: —" would be noise, not information. */}
          {distanceSummary.available > 0 && (
            <View style={[st.card, { backgroundColor: colors.card, borderColor: colors.border, marginBottom: 10 }]}>
              <View style={st.distRow}>
                <View style={st.distCell}>
                  <Text style={[st.distVal, { color: colors.text }]} numberOfLines={1}>
                    {formatMetres(distanceSummary.nearest!.fromMe!)}
                  </Text>
                  <Text style={[st.distLbl, { color: colors.textDim }]} numberOfLines={1}>
                    Nearest · {distanceSummary.nearest!.name}
                  </Text>
                </View>
                <View style={[st.distDiv, { backgroundColor: colors.border }]} />
                <View style={st.distCell}>
                  <Text style={[st.distVal, { color: colors.text }]} numberOfLines={1}>
                    {formatMetres(distanceSummary.farthest!.fromMe!)}
                  </Text>
                  <Text style={[st.distLbl, { color: colors.textDim }]} numberOfLines={1}>
                    Farthest · {distanceSummary.farthest!.name}
                  </Text>
                </View>
                <View style={[st.distDiv, { backgroundColor: colors.border }]} />
                <View style={st.distCell}>
                  <Text style={[st.distVal, { color: colors.text }]} numberOfLines={1}>
                    {formatMetres(distanceSummary.averageM!)}
                  </Text>
                  <Text style={[st.distLbl, { color: colors.textDim }]}>Average</Text>
                </View>
              </View>
              {/* "9 / 10 available" is a statement about the CIRCLE, so the
                  total counts everyone — including the members we could not
                  measure and who are therefore absent from the figures above. */}
              <Text style={{ color: colors.textDim, fontSize: 11.5, textAlign: 'center', marginTop: 8 }}>
                {/* Names the ORIGIN, always. A distance with no stated origin
                    is the easiest number on this screen to misread. */}
                Straight-line from {originName ?? 'you'} · {distanceSummary.available} of{' '}
                {distanceSummary.total - (originName ? 0 : 1)} members located
              </Text>
            </View>
          )}

          {/* DISTANCE FROM (spec §34–39). "Near Me" is the default; picking a
              saved place re-measures EVERY member against it, which is the
              "how far is everyone from Home" question. Only appears once
              there is a place to pick, so a circle with none is unchanged. */}
          {places.length > 0 && anyoneLocatable && (
            <View style={st.sortRow}>
              <TouchableOpacity
                onPress={() => setOriginName(null)}
                accessibilityRole="button"
                accessibilityState={{ selected: !originName }}
                style={[st.sortChip, {
                  borderColor: !originName ? colors.primary : colors.border,
                  backgroundColor: !originName ? brandAlpha(0.12) : 'transparent',
                }]}
              >
                <Text style={{ color: !originName ? colors.primary : colors.textDim, fontSize: 12, fontWeight: !originName ? '800' : '600' }}>
                  Near me
                </Text>
              </TouchableOpacity>
              {places.map((p) => {
                const on = originName === p.name;
                return (
                  <TouchableOpacity
                    key={p.id}
                    onPress={() => setOriginName(on ? null : p.name)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    accessibilityLabel={`Measure everyone from ${p.name}`}
                    style={[st.sortChip, {
                      borderColor: on ? colors.primary : colors.border,
                      backgroundColor: on ? brandAlpha(0.12) : 'transparent',
                    }]}
                  >
                    <Text style={{ color: on ? colors.primary : colors.textDim, fontSize: 12, fontWeight: on ? '800' : '600' }}>
                      Near {p.name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {/* sort (spec §9) */}
          {roster.length > 2 && (
            <View style={st.sortRow}>
              {([['nearest', 'Nearest'], ['farthest', 'Farthest'], ['alpha', 'A–Z'], ['recent', 'Recent']] as const).map(([mode, label]) => (
                <TouchableOpacity
                  key={mode}
                  onPress={() => setSortMode(mode)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: sortMode === mode }}
                  style={[st.sortChip, {
                    borderColor: sortMode === mode ? colors.primary : colors.border,
                    backgroundColor: sortMode === mode ? brandAlpha(0.12) : 'transparent',
                  }]}
                >
                  <Text style={{
                    color: sortMode === mode ? colors.primary : colors.textDim,
                    fontSize: 12, fontWeight: sortMode === mode ? '800' : '600',
                  }}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          <View style={[st.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {roster.map(memberRow)}
          </View>

          {/* today's highlights */}
          {highlights.length > 0 && (
            <>
              {/* design screen 5: section header carries a View All to the
                  alerts centre, which is where the full stream already lives. */}
              <View style={st.secHead}>
                <Text style={[st.secTitle, { color: colors.text, flex: 1 }]}>Today&apos;s Highlights</Text>
                <TouchableOpacity onPress={() => active && router.push({ pathname: '/family-alerts' as any, params: { circleId: active.id, circleName: active.name } })}>
                  <Text style={{ color: colors.primary, fontSize: 12.5, fontWeight: '700' }}>View All</Text>
                </TouchableOpacity>
              </View>
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
            {/* Design screen 20: choose a status, then send.
                This also fixes a real trap in the previous flow — tapping a
                status sent IMMEDIATELY while the note field sat below it, so
                anyone who typed their note after choosing (the natural order,
                since the note is underneath) had it silently dropped. */}
            <Text style={[st.modalTitle, { color: colors.text }]}>Let your family know you&apos;re safe</Text>
            <View style={st.checkGrid}>
              {CHECKINS.map((c) => {
                const on = picked?.label === c.label;
                return (
                  <TouchableOpacity
                    key={c.label}
                    onPress={() => setPicked(on ? null : c)}
                    style={[st.checkBtn, {
                      backgroundColor: c.color + (on ? '33' : '1e'),
                      borderColor: on ? c.color : c.color + '55',
                      borderWidth: on ? 2 : 1,
                    }]}
                  >
                    <Text style={{ fontSize: 18 }}>{c.emoji}</Text>
                    <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13.5 }}>{c.label}</Text>
                    {on && <Ionicons name="checkmark-circle" size={16} color={c.color} style={{ position: 'absolute', top: 8, right: 8 }} />}
                  </TouchableOpacity>
                );
              })}
            </View>
            <TextInput value={note} onChangeText={setNote} placeholder="Add a note (optional)" placeholderTextColor={colors.textFaint}
              style={[st.noteInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]} />
            <TouchableOpacity
              onPress={() => picked && sendCheckin(picked)}
              disabled={!picked}
              style={[st.sendCheckin, { backgroundColor: picked ? colors.primary : colors.border }]}
            >
              <Text style={{ color: picked ? '#fff' : colors.textDim, fontWeight: '800', fontSize: 15 }}>
                {picked ? `Send “${picked.label}”` : 'Choose a status'}
              </Text>
            </TouchableOpacity>
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
            {/* The admin console. Offered only to someone who actually runs this
                space, and it carries their RESOLVED permissions across so the
                console draws only what they can use — a tile that fails on tap
                teaches people to distrust the whole screen. The permission list
                is presentation; every endpoint behind it re-checks server-side. */}
            {canOps && <TouchableOpacity onPress={() => { setManage(false); active && router.push({ pathname: '/space-admin' as any, params: { spaceId: active.id, name: active.name, groupType: active.groupType ?? '', perms: Array.from(perms).join(',') } }); }} style={[st.mRow, { borderColor: colors.border }]}>
              <Ionicons name="shield-checkmark-outline" size={18} color={colors.primary} />
              <Text style={[st.mTxt, { color: colors.primary, fontWeight: '700' }]}>Admin console</Text>
            </TouchableOpacity>}
            {/* Attendance is only meaningful where someone oversees others, so
                it is offered on the same permission that shows the runs card
                rather than to every member of every household. */}
            {canOps && <TouchableOpacity onPress={() => { setManage(false); active && router.push({ pathname: '/space-attendance' as any, params: { spaceId: active.id, name: active.name } }); }} style={[st.mRow, { borderColor: colors.border }]}>
              <Ionicons name="calendar-number-outline" size={18} color={colors.text} />
              <Text style={[st.mTxt, { color: colors.text }]}>Attendance</Text>
            </TouchableOpacity>}
            {/* The roster is offered to EVERYONE in an ops space, not just ops:
                a parent's "roster" is their own child, and that is the screen
                that tells them so. The server decides what is in it. */}
            {(canOps || hasPerm(perms, 'manage_roster') || !!active?.groupType?.includes('school') || !!active?.groupType?.includes('transport')) &&
              <TouchableOpacity onPress={() => { setManage(false); active && router.push({ pathname: '/space-roster' as any, params: { spaceId: active.id, name: active.name, canManage: hasPerm(perms, 'manage_roster') ? '1' : '0' } }); }} style={[st.mRow, { borderColor: colors.border }]}>
                <Ionicons name="people-outline" size={18} color={colors.text} />
                <Text style={[st.mTxt, { color: colors.text }]}>Roster</Text>
              </TouchableOpacity>}
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
            {/* High-speed alert for MY OWN device (spec: speed alerts). Tap the
                threshold to cycle it. Off by default; detected on this phone —
                the server never sees a speed. */}
            <View style={[st.mRow, { borderColor: colors.border }]}>
              <Ionicons name="speedometer-outline" size={19} color={colors.primary} />
              <Text style={[st.mTxt, { color: colors.text, flex: 1 }]}>High-speed alert</Text>
              {speedAlert.enabled && (
                <TouchableOpacity onPress={cycleSpeedThreshold} style={{ paddingHorizontal: 8 }}>
                  <Text style={{ color: colors.primary, fontWeight: '800', fontSize: 13 }}>{speedAlert.thresholdKmh} km/h</Text>
                </TouchableOpacity>
              )}
              <Switch value={speedAlert.enabled} onValueChange={toggleSpeedAlert} trackColor={{ true: colors.primary }} />
            </View>
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
  greetRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
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
  // ── design screen 5: greeting + quick-action cards ──
  greetBell: {
    width: 40, height: 40, borderRadius: 20, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  bellDot: {
    position: 'absolute', top: 8, right: 9, width: 9, height: 9,
    borderRadius: 5, borderWidth: 1.5,
  },
  qaGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 10 },
  // Three across on a normal phone; wraps to two on narrow screens rather than
  // squeezing the subtitle out of existence.
  qa: {
    flexBasis: '30%', flexGrow: 1, minWidth: 104,
    borderWidth: 1, borderRadius: 16, padding: 12, gap: 7,
  },
  qaIcon: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  qaTitle: { fontSize: 13.5, fontWeight: '700' },
  qaSub: { fontSize: 11 },
  badge: { position: 'absolute', top: 6, right: 10, minWidth: 18, height: 18, borderRadius: 9, borderWidth: 1.5, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  badgeTxt: { color: '#fff', fontSize: 10, fontWeight: '800' },
  announce: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderWidth: 1, borderRadius: 14, marginBottom: 10 },
  sosBig: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderWidth: 1.5, borderRadius: 18, overflow: 'hidden', marginBottom: 6 },
  sosIcon: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  shareRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 },
  secHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, marginBottom: 8 },
  secTitle: { fontSize: 13, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4 },
  card: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, marginBottom: 4 },
  distRow: { flexDirection: 'row', alignItems: 'flex-start', paddingTop: 14 },
  distCell: { flex: 1, alignItems: 'center', gap: 3, paddingHorizontal: 4 },
  distVal: { fontSize: 15, fontWeight: '800' },
  distLbl: { fontSize: 11, textAlign: 'center' },
  distDiv: { width: 1, height: 30 },
  sortRow: { flexDirection: 'row', gap: 7, marginBottom: 9 },
  // 30 px min height keeps these inside the accessible touch-target floor while
  // still reading as chips rather than buttons.
  sortChip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, minHeight: 30, justifyContent: 'center' },
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
  sendCheckin: { marginTop: 10, height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  btnWide: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 50, borderRadius: 13, marginTop: 12 },
  saveBtn: { width: 46, height: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  mRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, borderTopWidth: StyleSheet.hairlineWidth },
  mTxt: { fontSize: 15, fontWeight: '600' },
});
