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
import ChatDoorButton from '../components/spaces/ChatDoorButton';
import SpaceGround from '../components/spaces/SpaceGround';
import { useTheme } from '../lib/theme';
import { brandAlpha } from '../constants/theme';
import { SPACE_GLASS, SPACE_SHADOW } from '../constants/spaceTheme';
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
  isIgnoringBatteryOptimizations,
} from '../lib/batteryOptimization';
import { loadAlerts, recordAlert, useUnreadCount } from '../lib/family/alerts';
import { deriveWatchAlerts, emptyWatchState } from '../lib/family/watchAlerts';
import { emptyCrashState, feedSpeed, feedImpact, COUNTDOWN_S } from '../lib/family/crash';
import { Accelerometer } from 'expo-sensors';
import { type CircleMember, type MemberPresence, STALE_MS, SPEED_ALERT_CHOICES, DEFAULT_SPEED_ALERT_KMH } from '../lib/family/types';
import { sendMessage, getMessages, decryptFromChat, getChat, listChats, sendAnnouncement, isAnnouncement } from '../lib/chatService';
import { getCurrentUserAsync } from './(constants)/authService';
import { navigateTo } from '../lib/nav/openNavigation';
import { subscribeTrip, joinTrip, currentTrip } from '../lib/groups/tripSession';
import {
  foldParticipants, lastEta, everyoneArrived, minutesUntil,
  type Trip, type TripPing,
} from '../lib/groups/trips';
import { haversine } from '../lib/nav/geo';
import {
  memberDistances, mergeRoadDistances, summarize as summarizeDistances, sortMembers, defaultRef,
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

// The dusk-glass ground (gradient + identity aura) is shared with every other
// Space screen — see components/spaces/SpaceGround.tsx. Switching spaces
// re-colours the room, nothing else moves.

export default function FamilySpaceScreen() {
  const { colors, scheme } = useTheme();
  const G = SPACE_GLASS[scheme];
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
  /** Bumped every time this screen regains focus — see the focus effect below
   *  for why presence needs that in its dependency list. */
  const [focusTick, setFocusTick] = useState(0);
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
        // null = ended or expired — the card must clear, not linger forever.
        (t) => {
          if (!live) return;
          if (t === null) { setTrip(null); setTripPings([]); return; }
          setTrip((cur) => cur ?? t);
          // AUTO-JOIN: a family trip is for the whole circle, so every
          // member's device adopts it and starts reporting its own DERIVED
          // ETA on the next fix — no joining ceremony. The position itself
          // never rides the trip channel.
          if (me?.id && !currentTrip()) joinTrip(t, me.id).catch(() => {});
        },
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
        // EVERY group, not just the one on screen. The engine underneath
        // (presence.ts + background.ts) was always multi-group — per-group
        // privacy gates each publish — but this call site handed it a
        // singleton, so a School or Employee space only ever received
        // positions while its map was the active tab HERE. Locked phone,
        // different tab, or a space-* screen: nothing published, which is
        // "space location does not share when locked" from the outside.
        // Active first so the visible group gets the first fix.
        const allIds = [active.id, ...circles.map((c) => c.id).filter((id) => id !== active.id)];
        const res = await startPresence({
          circleIds: allIds, myId: me.id, myName: me.name, share,
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
  // The joined id list re-arms presence when a space is adopted or leaves —
  // an array literal here would re-run every render, a missing dep would keep
  // sharing on yesterday's group list.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, me?.id, share, focusTick, circles.map((c) => c.id).join(',')]);

  // stop broadcasting when the screen loses focus (map still resumes on return)
  /**
   * RE-ARM ON RETURN. The blur cleanup below stops the watcher, but the
   * presence effect above is keyed on [active.id, me.id, share] — none of
   * which change when the user simply comes BACK. So one visit to the map (or
   * any other screen) left the device permanently not sharing until the app
   * was restarted or the switch was toggled, with the switch still reading ON.
   *
   * Measured on the Honor: silent for 18 minutes with the switch on, then
   * publishing again 24 s after a cold start. It is also why family trips
   * never collected ETAs — only one phone was ever publishing.
   *
   * Bumping a counter on focus puts "we are back" into the effect's own
   * dependency list. startPresence already guards against overlapping calls
   * with its generation check, so the extra run on first focus is harmless.
   */
  useFocusEffect(React.useCallback(() => {
    setFocusTick((t) => t + 1);
    return () => { stopPresence(); };
  }, []));

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
        // Re-ask when the exemption is genuinely MISSING, even if we asked
        // before — "asked once" was the right rule while we could not read the
        // answer, but it also meant a user who declined (or an OEM that revoked
        // it later) was never told again, and their locked-screen sharing just
        // quietly stopped working. Now the state decides, not the memory of a
        // dialog.
        const exempt = await isIgnoringBatteryOptimizations();
        if (!asked || !exempt) {
          await AsyncStorage.setItem(askedKey, '1');
          const bg = await canShareInBackground();
          if (!bg) await requestBackgroundPermission();
          if (!exempt) await requestIgnoreBatteryOptimizations();
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
  const distanceInputs = useMemo(() => {
    const now = Date.now();
    const mineNow = me ? presences[me.id] : undefined;
    // The origin every distance is measured from: my own position by default,
    // or one of MY saved places when one is picked ("how far is everyone from
    // Home"). A picked place that has since been deleted falls back to me
    // rather than silently measuring from nowhere.
    const origin = originName
      ? (places.find((p) => p.name === originName)?.center ?? mineNow?.pos ?? null)
      : (mineNow?.pos ?? null);
    const rows = members.map((m) => {
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
    });
    return { rows: rows, origin };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presences, members, me?.id, tick, originName, places, relations]);

  const straightRows = useMemo(
    () => memberDistances(distanceInputs.rows, distanceInputs.origin),
    [distanceInputs]);

  /**
   * ROAD distance for the list, layered over the straight line.
   *
   * "4 km away" meaning four kilometres of driving is a more useful claim than
   * four kilometres of open air — a member across a river reads as close and
   * is not. /nav/matrix answers all members in ONE call (it is what Meet Here
   * already runs on), so this costs one request per refresh, not one per
   * member.
   *
   * Keyed on the ROUNDED positions, not on `presences`: a fix arrives every
   * few seconds and jitters by metres, and re-routing the whole family for a
   * 3-metre wobble would spend a request per tick to change nothing on screen.
   *
   * Geofences and published reference distances are deliberately NOT routed —
   * see mergeRoadDistances for why converting either would be a bug.
   */
  const [roadM, setRoadM] = useState<Record<string, number>>({});
  const roadKey = useMemo(() => {
    const o = distanceInputs.origin;
    if (!o) return '';
    const q = (n: number) => n.toFixed(3);   // ~110m: below this nothing on screen moves
    const parts = distanceInputs.rows
      .filter((r) => r.pos && !r.self && !r.unavailable)
      .map((r) => `${r.id}:${q(r.pos!.lat)},${q(r.pos!.lng)}`)
      .sort();
    return parts.length ? `${q(o.lat)},${q(o.lng)}|${parts.join('|')}` : '';
  }, [distanceInputs]);

  useEffect(() => {
    if (!roadKey) { setRoadM({}); return; }
    const origin = distanceInputs.origin;
    if (!origin) return;
    const targets = distanceInputs.rows.filter((r) => r.pos && !r.self && !r.unavailable);
    if (!targets.length) return;
    let cancel = false;
    (async () => {
      try {
        const { fetchMatrix } = require('../lib/nav/routing');
        const res = await fetchMatrix(targets.map((t: any) => t.pos), origin, 'auto');
        if (cancel) return;
        const next: Record<string, number> = {};
        for (const r of res) {
          const t = targets[r.index];
          if (t) next[t.id] = r.distanceM;
        }
        setRoadM(next);
      } catch {
        // Router unavailable: the straight-line numbers already on screen stand.
        if (!cancel) setRoadM({});
      }
    })();
    return () => { cancel = true; };
  }, [roadKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  const distanceRows = useMemo(
    () => mergeRoadDistances(straightRows, roadM), [straightRows, roadM]);

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

  // ── Watch alerts: low battery + went-quiet for OTHER members ─────────
  // Derived HERE, on the viewing device, from presences already decrypted —
  // a member's battery rides every ping and their silence is the absence of
  // pings, so only a watcher can raise either. Edge-detected in the pure
  // engine (one episode = one alert); recordAlert's 60s dedupe absorbs the
  // hub and map both deriving. State resets per circle.
  const watchRef = useRef(emptyWatchState());
  useEffect(() => { watchRef.current = emptyWatchState(); }, [active?.id]);
  useEffect(() => {
    if (!active?.id || !me?.id || !membersLoaded) return;
    const nameById = new Map(members.map((mm) => [mm.id, mm.name]));
    const snaps = Object.entries(presences)
      .filter(([uid]) => uid !== me.id)
      .map(([uid, p]) => ({
        id: uid, name: nameById.get(uid) || 'A member',
        battery: p.battery, charging: p.charging, ts: p.ts, sharingOff: p.sharingOff,
      }));
    if (!snaps.length) return;
    const r = deriveWatchAlerts(watchRef.current, snaps, Date.now());
    watchRef.current = r.state;
    for (const a of r.alerts) {
      recordAlert({ circleId: active.id, kind: a.kind, actorId: a.actorId, actorName: a.actorName, text: a.text })
        .catch(() => {});
    }
  // `tick` drives the quiet detection: silence, by definition, changes no state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presences, tick, active?.id, me?.id, members, membersLoaded]);

  // ── Crash detection (MY device): impact after driving → countdown → SOS ──
  // The accelerometer is armed only while sharing is on — the situation a
  // family expects protection in — and the decision logic is pure and
  // self-checked (lib/family/crash). A suspect opens a loud full-screen
  // countdown; SOS fires unless the person says they are OK.
  const crashRef = useRef(emptyCrashState());
  const [crashAsk, setCrashAsk] = useState(false);
  const [crashLeft, setCrashLeft] = useState(COUNTDOWN_S);
  useEffect(() => {
    const sp = me ? presences[me.id]?.speed : undefined;
    crashRef.current = feedSpeed(crashRef.current, sp ?? null, Date.now());
  }, [presences, me]);
  useEffect(() => {
    if (!share) return;
    Accelerometer.setUpdateInterval(200);
    const sub = Accelerometer.addListener(({ x, y, z }) => {
      const g = Math.sqrt(x * x + y * y + z * z);
      const r = feedImpact(crashRef.current, g, Date.now());
      crashRef.current = r.state;
      if (r.suspect) {
        setCrashLeft(COUNTDOWN_S);
        setCrashAsk(true);
        Vibration.vibrate([0, 600, 200, 600, 200, 600]);
      }
    });
    return () => sub.remove();
  }, [share]);
  useEffect(() => {
    if (!crashAsk) return;
    if (crashLeft <= 0) { setCrashAsk(false); fireSos(); return; }
    const t = setTimeout(() => setCrashLeft((v) => v - 1), 1000);
    return () => clearTimeout(t);
  // fireSos is stable enough here: the countdown re-renders every second, so
  // the closure is always the current one.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crashAsk, crashLeft]);

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

  if (loading) return (
    <View style={[st.screen, { backgroundColor: G.bgMid }]}>
      <SpaceGround />
      {/* Static glass skeleton in the dashboard's own shapes. Deliberately
          unanimated — this gate is one local settings read, and a shimmer
          loop spends GPU on a state that lasts under a second. The spinner
          in the map slot is the only motion. */}
      <View style={st.dash}>
        <View style={[st.skel, { width: '55%', height: 30, borderRadius: 10, backgroundColor: G.paneFaint, borderColor: G.edge }]} />
        <View style={[st.skel, { width: '35%', height: 14, borderRadius: 7, marginTop: 8, backgroundColor: G.paneFaint, borderColor: G.edge }]} />
        <View style={[st.skel, { height: 76, borderRadius: 22, marginTop: 20, backgroundColor: G.pane, borderColor: G.edge }]} />
        <View style={[st.skel, { height: 300, borderRadius: 24, marginTop: 12, backgroundColor: G.paneFaint, borderColor: G.edge, alignItems: 'center', justifyContent: 'center' }]}>
          <ActivityIndicator color={colors.primary} />
        </View>
        {/* Same wrap metrics as the real quick-action grid, so the layout
            does not jump when content arrives on a narrow screen. */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
          {[0, 1, 2].map((k) => (
            <View key={k} style={[st.skel, { flexBasis: '30%', flexGrow: 1, minWidth: 100, height: 92, borderRadius: 18, backgroundColor: G.paneFaint, borderColor: G.edge }]} />
          ))}
        </View>
      </View>
    </View>
  );

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
    // BY ROAD when the router has answered for this member, straight line only
    // until it does. Reads from the same roadM the distance list uses, so the
    // row and the summary can never disagree about how far someone is.
    const roadD = roadM[m.id];
    const d = p && mine && !isMe
      ? dist(Number.isFinite(roadD) && roadD >= 0 ? roadD : haversine(mine.pos, p.pos))
      : null;
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
        // Pressable draws no feedback of its own; a faint glass tint says
        // "this row is a door" without a ripple bleeding past the card corners.
        style={({ pressed }) => [st.row, { borderColor: G.line }, i === 0 && { borderTopWidth: 0 },
          pressed && { backgroundColor: G.press, borderRadius: 12 }]}
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
          <Text style={{ color: fresh === 'live' ? G.goodText : colors.textDim, fontSize: 12 }} numberOfLines={1}>
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
              color={p.battery <= 20 && !p.charging ? G.dangerText : colors.textDim} />
            <Text style={{ color: p.battery <= 20 && !p.charging ? G.dangerText : colors.textDim, fontSize: 11, fontVariant: ['tabular-nums'] }}>{Math.round(p.battery)}%</Text>
          </View>
        )}
        {p && (
          <TouchableOpacity
            onPress={() => { setFocusId(m.id); setExpanded(true); }} style={st.rowBtn}
            hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
            accessibilityRole="button" accessibilityLabel={`Show ${isMe ? 'yourself' : m.name} on the map`}
          ><Ionicons name="locate" size={18} color={colors.primary} /></TouchableOpacity>
        )}
        {p && !isMe && (
          <TouchableOpacity
            onPress={() => navigateTo(p.pos.lat, p.pos.lng, m.name)} style={st.rowBtn}
            hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
            accessibilityRole="button" accessibilityLabel={`Navigate to ${m.name}`}
          ><Ionicons name="navigate-circle" size={20} color={colors.primary} /></TouchableOpacity>
        )}
      </Pressable>
    );
  };

  const shareToggleRow = (
    <>
      <View style={st.shareRow}>
        {/* flex:1 + shrink so a scaled-up label wraps instead of pushing the
            master sharing Switch past the card edge. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
          <Ionicons name={share ? 'navigate' : 'navigate-outline'} size={18} color={share ? colors.primary : colors.textDim} />
          <Text style={{ color: colors.text, fontWeight: '600', flexShrink: 1 }}>Share my location</Text>
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
        <Text style={{ color: colors.textDim, fontSize: 11.5, marginTop: -4, marginBottom: 10 }} numberOfLines={2}>
          {currentPlan()!.reason} · every {Math.round(currentPlan()!.timeIntervalMs / 1000)}s
          {currentPlan()!.publish ? '' : ' · not publishing'}
        </Text>
      )}
    </>
  );

  return (
    // bgMid under the gradient: if the ground ever misses a frame during a
    // transition, the fallback is the mid dusk tone, not the theme's black.
    <View style={[st.screen, { backgroundColor: G.bgMid }]}>
      <SpaceGround aura={ident.color || colors.primary} />
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
        // The header sits on the same dusk ground as the screen — bgTop keeps
        // the seam invisible without the layout risk of a transparent header.
        headerStyle: { backgroundColor: G.bgTop }, headerTintColor: colors.text, headerShadowVisible: false,
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
            {/* The door to this group's ONE thread — same history and unread
                state as the chats tab (chat-map-separation D5). Shared with
                every space header via ChatDoorButton, so this no longer
                drifts from theirs (it briefly did: size 20 vs 21). */}
            {active?.id && (
              <ChatDoorButton colors={colors} chat={{ id: active.id, name: active.name }} />
            )}
            {canInvite && <TouchableOpacity onPress={openAdd} style={{ paddingHorizontal: 6 }} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }} accessibilityRole="button" accessibilityLabel="Invite member"><Ionicons name="person-add" size={20} color={colors.primary} /></TouchableOpacity>}
            <TouchableOpacity onPress={() => { setRenameTxt(''); setManage(true); }} style={{ paddingHorizontal: 6 }} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }} accessibilityRole="button" accessibilityLabel="Space options"><Ionicons name="ellipsis-vertical" size={20} color={colors.primary} /></TouchableOpacity>
          </View>
        ) }} />

      {expanded ? (
        /* ── expanded: full-screen live map + roster sheet ── */
        <>
          <View style={{ flex: 1 }}>
            <FamilyMap members={markers} focusId={focusId} onSelect={(id) => setFocusId(id)} style={{ flex: 1 }} />
            <TouchableOpacity onPress={() => setExpanded(false)} accessibilityRole="button" accessibilityLabel="Close full-screen map" style={[st.collapse, { backgroundColor: G.paneStrong, borderColor: G.edge }]}>
              <Ionicons name="contract" size={18} color={colors.text} />
            </TouchableOpacity>
          </View>
          {/* Solid, not glass: the roster floats over a live map, and glass
              over that much detail costs readability and buys nothing. */}
          <View style={[st.sheet, { backgroundColor: G.sheet, borderColor: G.edge }]}>
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
              <Text style={{ color: colors.text, fontSize: 28, lineHeight: 34, fontWeight: '800', letterSpacing: -0.4 }}>
                {greeting()}, {firstName} 👋
              </Text>
              <Text style={{ color: colors.textDim, fontSize: 13, marginTop: 3 }} numberOfLines={1}>
                {active?.name}{active?.groupType && ident.label !== active.name ? ` · ${ident.label}` : ''}
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => active && router.push({ pathname: '/family-alerts' as any, params: { circleId: active.id, circleName: active.name } })}
              style={[st.greetBell, { backgroundColor: G.pane, borderColor: G.edge }]}
              accessibilityRole="button"
              accessibilityLabel={`Alerts${unread > 0 ? `, ${unread} unread` : ''}`}
            >
              <Ionicons name="notifications-outline" size={19} color={colors.text} />
              {unread > 0 && <View style={[st.bellDot, { backgroundColor: colors.danger, borderColor: G.sheet }]} />}
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
                    accessibilityRole="button" accessibilityState={{ selected: on }}
                    hitSlop={{ top: 4, bottom: 4 }}
                    style={[st.chip, { flexDirection: 'row', alignItems: 'center', gap: 6,
                      borderColor: on ? gi.color : G.chipEdge,
                      backgroundColor: on ? gi.color + '26' : G.paneFaint }]}>
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
                style={[st.chip, { flexDirection: 'row', alignItems: 'center', gap: 6, borderColor: colors.primary, backgroundColor: G.paneFaint }]}
              >
                <Ionicons name="add" size={14} color={colors.primary} />
                <Text style={{ color: G.accentText, fontWeight: '700', fontSize: 13 }}>New space</Text>
              </TouchableOpacity>
            </ScrollView>
          )}

          {/* pinned announcement */}
          {!!announcement && (
            <View style={[st.announce, { backgroundColor: G.pane, borderColor: G.edge, borderLeftWidth: 3, borderLeftColor: colors.primary }]}>
              <Ionicons name="megaphone" size={17} color={colors.primary} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontSize: 13.5, fontWeight: '600' }} numberOfLines={3}>
                  {announcement.text}
                </Text>
                <Text style={{ color: colors.textDim, fontSize: 11 }}>{ago(announcement.at)}</Text>
              </View>
            </View>
          )}

          {/* status card — the hero pane: the strongest glass on the screen,
              with the identity aura bleeding through from the ground behind. */}
          <View style={[st.status, { backgroundColor: G.paneStrong, borderColor: G.edge }]}>
            <View style={[st.statusIcon, { backgroundColor: (allGood ? colors.success : ident.color) + '26' }]}>
              <Ionicons name={allGood ? 'shield-checkmark' : ident.icon} size={21} color={allGood ? colors.success : ident.color} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.textDim, fontSize: 11, fontWeight: '800', letterSpacing: 0.7 }}>
                {(ident.label || 'Family').toUpperCase()} STATUS
              </Text>
              <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16.5 }}>{allGood ? 'All good' : 'Nobody live yet'}</Text>
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
                  <View key={m.id} style={[st.miniDot, { backgroundColor: colorFor(m.id), marginLeft: i ? -8 : 0, borderColor: G.sheet, opacity: presences[m.id] ? 1 : 0.45 }]}>
                    <Text style={st.miniDotTxt}>{(m.name || '?').trim()[0]?.toUpperCase()}</Text>
                  </View>
                ))}
                {roster.length > 4 && <View style={[st.miniDot, { backgroundColor: colors.border, marginLeft: -8, borderColor: G.sheet }]}><Text style={[st.miniDotTxt, { color: colors.text }]}>+{roster.length - 4}</Text></View>}
              </View>
              <Text style={{ color: G.accentText, fontSize: 12.5, fontWeight: '700' }}>View All</Text>
            </TouchableOpacity>
          </View>

          {/* map preview */}
          <TouchableOpacity activeOpacity={0.9} onPress={() => setExpanded(true)} style={[st.mapCard, { borderColor: G.edge }]}>
            <FamilyMap members={markers} focusId={focusId} onSelect={() => setExpanded(true)} style={{ flex: 1 }} />
            <View style={[st.mapBadge, { backgroundColor: G.paneStrong, borderColor: G.edge }]}>
              <Ionicons name="expand" size={13} color={colors.text} /><Text style={{ color: colors.text, fontSize: 12, fontWeight: '700' }}>Live Map</Text>
            </View>
          </TouchableOpacity>

          {/* Why the map is emptier than the member list (see notVisible).
              Location sharing is opt-in on EACH device, so one phone sharing
              does not make the other appear — and without this line an empty
              map looks like a fault rather than a setting. */}
          {notVisible.length > 0 && (
            <View style={[st.card, st.quiet, { backgroundColor: G.paneFaint, borderColor: G.edge, flexDirection: 'row', alignItems: 'center', gap: 10 }]}>
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
              <View style={[st.card, { backgroundColor: G.pane, borderColor: G.edge }]}>
                <Text style={[st.secTitle, { color: colors.textDim, marginBottom: 8 }]}>
                  {spaceFamily === 'family' ? 'FAMILY NOW' : 'RIGHT NOW'} · {b.total} {b.total === 1 ? 'MEMBER' : 'MEMBERS'}
                </Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {chips.map((c) => (
                    <View key={c.label} style={[st.chip, { backgroundColor: G.paneFaint, borderColor: G.chipEdge, flexDirection: 'row', alignItems: 'center', gap: 5 }]}>
                      <Ionicons name={c.icon as any} size={13} color={colors.primary} />
                      <Text style={{ color: colors.text, fontSize: 12.5, fontWeight: '600' }}>{c.label}</Text>
                      <Text style={{ color: G.accentText, fontSize: 12.5, fontWeight: '800' }}>{c.n}</Text>
                    </View>
                  ))}
                </View>
                {whereChips.length > 0 && (
                  <>
                    <Text style={{ color: colors.textDim, fontSize: 11, marginTop: 10, marginBottom: 6 }}>
                      Where they are
                    </Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                      {whereChips.map((c) => (
                        <View key={c.label} style={[st.chip, { backgroundColor: G.paneFaint, borderColor: G.chipEdge, flexDirection: 'row', alignItems: 'center', gap: 5 }]}>
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
                  style={[st.qa, { backgroundColor: G.pane, borderColor: G.edge }]}
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
              style={[st.qa, { backgroundColor: G.pane, borderColor: G.edge }]}
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
              style={[st.qa, { backgroundColor: G.pane, borderColor: G.edge }]}
            >
              <View style={[st.qaIcon, { backgroundColor: colors.primary + '22' }]}>
                <Ionicons name="search" size={19} color={colors.primary} />
              </View>
              <Text style={[st.qaTitle, { color: colors.text }]}>Meet Here</Text>
              <Text style={[st.qaSub, { color: colors.textDim }]} numberOfLines={1}>Pick a place to meet</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => router.push('/emergency-sos' as any)}
              style={[st.qa, { backgroundColor: G.pane, borderColor: G.edge }]}
            >
              <View style={[st.qaIcon, { backgroundColor: colors.danger + '22' }]}>
                <Ionicons name="medkit" size={19} color={colors.danger} />
              </View>
              <Text style={[st.qaTitle, { color: colors.text }]}>SOS</Text>
              <Text style={[st.qaSub, { color: colors.textDim }]} numberOfLines={1}>Emergency</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => setCheckin(true)}
              style={[st.qa, { backgroundColor: G.pane, borderColor: G.edge }]}
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
                style={[st.qa, { backgroundColor: G.pane, borderColor: G.edge }]}
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
              style={[st.qa, { backgroundColor: G.pane, borderColor: G.edge }]}
            >
              <View style={[st.qaIcon, { backgroundColor: colors.primary + '22' }]}>
                <Ionicons name="notifications" size={19} color={colors.primary} />
              </View>
              <Text style={[st.qaTitle, { color: colors.text }]}>Alerts</Text>
              <Text style={[st.qaSub, { color: colors.textDim }]} numberOfLines={1}>
                {unread > 0 ? `${unread > 99 ? '99+' : unread} unread` : 'All caught up'}
              </Text>
              {unread > 0 && (
                <View style={[st.badge, { backgroundColor: colors.danger, borderColor: G.sheet }]}>
                  <Text style={st.badgeTxt}>{unread > 99 ? '99+' : unread}</Text>
                </View>
              )}
            </TouchableOpacity>

            {/* FIND MY THINGS — BLE item finder. Offered to every member: a
                person's keys are their own business, and it needs no
                permission the space grants. */}
            <TouchableOpacity
              onPress={() => active && router.push({ pathname: '/family-items' as any, params: { circleId: active.id } })}
              style={[st.qa, { backgroundColor: G.pane, borderColor: G.edge }]}
            >
              <View style={[st.qaIcon, { backgroundColor: colors.primary + '22' }]}>
                <Ionicons name="key" size={19} color={colors.primary} />
              </View>
              <Text style={[st.qaTitle, { color: colors.text }]}>Find Things</Text>
              <Text style={[st.qaSub, { color: colors.textDim }]} numberOfLines={1}>Keys, wallet, bag</Text>
            </TouchableOpacity>

            {canHistory && (
              <TouchableOpacity
                onPress={() => active && router.push({ pathname: '/family-history' as any, params: { circleId: active.id, circleName: active.name } })}
                style={[st.qa, { backgroundColor: G.pane, borderColor: G.edge }]}
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
          {/* The danger wash is deliberate: the one emergency control must not
              wear the same glass as a settings row. Title in dangerText — raw
              #EF4444 fails AA at this size on the glass ground (audit-found:
              the plain-pane version regressed dark mode from 4.95:1 to 4.27). */}
          {(spaceFamily === 'family' || spaceFamily === 'generic') && (
          <Pressable
            onPressIn={sosStart} onPressOut={sosEnd}
            accessibilityLabel="Emergency SOS"
            accessibilityHint="Press and hold for one and a half seconds to alert your circle and share your live location"
            style={[st.sosBig, { borderColor: colors.danger, backgroundColor: colors.danger + (scheme === 'dark' ? '1F' : '14') }]}
          >
            <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: colors.danger + '55', transform: [{ scaleX: sosProg }] }]} />
            <View style={[st.sosIcon, { backgroundColor: colors.danger }]}><Text style={{ fontSize: 20 }}>🆘</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: G.dangerText, fontWeight: '900', fontSize: 15 }}>HOLD FOR SOS</Text>
              <Text style={{ color: colors.textDim, fontSize: 12 }}>Alerts your circle and shares your live location</Text>
            </View>
          </Pressable>
          )}

          {/* Same row, its own pane on the dashboard (in the expanded sheet it
              sits directly on the sheet surface). */}
          <View style={[st.shareCard, { backgroundColor: G.pane, borderColor: G.edge }]}>
            {shareToggleRow}
          </View>

          {/* Operations (Spaces & Operations, S3.1 / S3.4).
              A driver's own run comes FIRST and is styled as the primary action:
              S3.4 says a driver never lands on a dashboard, and the honest way
              to honour that on a shared screen is to put their manifest above
              everything else rather than to hide the rest. */}
          {runs.filter((r) => canDrive && r.driverId === me?.id).map((r) => (
            <TouchableOpacity
              key={r.id}
              onPress={() => router.push({ pathname: '/space-run-driver' as any, params: { spaceId: active!.id, runId: r.id, groupType: active!.groupType ?? '' } })}
              style={[st.card, { backgroundColor: G.pane, borderColor: colors.primary, flexDirection: 'row', alignItems: 'center', gap: 12 }]}
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
            <View style={[st.card, { backgroundColor: G.pane, borderColor: G.edge }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
                <Text style={{ color: colors.text, fontWeight: '700', fontSize: 14.5, flex: 1 }}>
                  {canOps ? 'Runs in progress' : 'Today’s run'}
                </Text>
                {canOps && (
                  <TouchableOpacity
                    onPress={() => active && router.push({ pathname: '/space-ops-map' as any, params: { spaceId: active.id, name: active.name, groupType: active.groupType ?? '' } })}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
                    hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
                  >
                    <Ionicons name="map-outline" size={15} color={colors.primary} />
                    <Text style={{ color: G.accentText, fontSize: 12.5, fontWeight: '700' }}>Map</Text>
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
                    <Text style={{ color: G.dangerText, fontSize: 12, fontWeight: '600' }}>not reporting</Text>
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
                style={[st.card, { backgroundColor: G.pane, borderColor: done ? colors.success : colors.primary, flexDirection: 'row', alignItems: 'center', gap: 12 }]}
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
            <Text style={[st.secTitle, { color: colors.textDim }]}>{memberHeading(active?.groupType)}</Text>
            {/* "+ Invite" opens the CONTACT PICKER (it used to open the sent-
                invitations manager, which asks you to type a name/email/phone —
                the person you want is almost always already a contact). The
                manager is still one tap away in the ⋯ sheet. */}
            {canInvite && active && (
              <TouchableOpacity onPress={openAdd} hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}>
                <Text style={{ color: G.accentText, fontWeight: '700', fontSize: 12.5 }}>+ Invite</Text>
              </TouchableOpacity>
            )}
          </View>
          {/* FAMILY DISTANCE (spec §11). Only once there is something to
              compare — a one-person circle has no nearest and no average, and
              printing "Nearest: —" would be noise, not information. */}
          {distanceSummary.available > 0 && (
            <View style={[st.card, { backgroundColor: G.pane, borderColor: G.edge }]}>
              <View style={st.distRow}>
                <View style={st.distCell}>
                  <Text style={[st.distVal, { color: colors.text }]} numberOfLines={1}>
                    {formatMetres(distanceSummary.nearest!.fromMe!)}
                  </Text>
                  <Text style={[st.distLbl, { color: colors.textDim }]} numberOfLines={1}>
                    Nearest · {distanceSummary.nearest!.name}
                  </Text>
                </View>
                <View style={[st.distDiv, { backgroundColor: G.line }]} />
                <View style={st.distCell}>
                  <Text style={[st.distVal, { color: colors.text }]} numberOfLines={1}>
                    {formatMetres(distanceSummary.farthest!.fromMe!)}
                  </Text>
                  <Text style={[st.distLbl, { color: colors.textDim }]} numberOfLines={1}>
                    Farthest · {distanceSummary.farthest!.name}
                  </Text>
                </View>
                <View style={[st.distDiv, { backgroundColor: G.line }]} />
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
                hitSlop={{ top: 7, bottom: 7 }}
                style={[st.sortChip, {
                  borderColor: !originName ? colors.primary : G.chipEdge,
                  backgroundColor: !originName ? brandAlpha(0.14) : G.paneFaint,
                }]}
              >
                <Text style={{ color: !originName ? G.accentText : colors.textDim, fontSize: 12, fontWeight: !originName ? '800' : '600' }}>
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
                    hitSlop={{ top: 7, bottom: 7 }}
                    style={[st.sortChip, {
                      borderColor: on ? colors.primary : G.chipEdge,
                      backgroundColor: on ? brandAlpha(0.14) : G.paneFaint,
                    }]}
                  >
                    <Text style={{ color: on ? G.accentText : colors.textDim, fontSize: 12, fontWeight: on ? '800' : '600' }}>
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
                  hitSlop={{ top: 7, bottom: 7 }}
                  style={[st.sortChip, {
                    borderColor: sortMode === mode ? colors.primary : G.chipEdge,
                    backgroundColor: sortMode === mode ? brandAlpha(0.14) : G.paneFaint,
                  }]}
                >
                  <Text style={{
                    color: sortMode === mode ? G.accentText : colors.textDim,
                    fontSize: 12, fontWeight: sortMode === mode ? '800' : '600',
                  }}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          <View style={[st.card, { backgroundColor: G.pane, borderColor: G.edge }]}>
            {roster.map(memberRow)}
          </View>

          {/* today's highlights */}
          {highlights.length > 0 && (
            <>
              {/* design screen 5: section header carries a View All to the
                  alerts centre, which is where the full stream already lives. */}
              <View style={st.secHead}>
                <Text style={[st.secTitle, { color: colors.textDim, flex: 1 }]}>Today&apos;s Highlights</Text>
                <TouchableOpacity onPress={() => active && router.push({ pathname: '/family-alerts' as any, params: { circleId: active.id, circleName: active.name } })} hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}>
                  <Text style={{ color: G.accentText, fontSize: 12.5, fontWeight: '700' }}>View All</Text>
                </TouchableOpacity>
              </View>
              <View style={[st.card, { backgroundColor: G.pane, borderColor: G.edge }]}>
                {highlights.map((h, i) => (
                  <View key={i} style={[st.row, { borderColor: G.line }, i === 0 && { borderTopWidth: 0 }]}>
                    <Text style={{ fontSize: 16 }}>{h.icon}</Text>
                    <Text style={{ flex: 1, color: colors.text, fontSize: 13.5 }} numberOfLines={2}>{h.text}</Text>
                    <Text style={{ color: colors.textDim, fontSize: 11 }}>{ago(h.at)}</Text>
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
        <KeyboardAvoidingView behavior={'padding'} style={st.modalWrap}>
          <Pressable style={{ flex: 1 }} onPress={() => setCheckin(false)} />
          <View style={[st.modal, { backgroundColor: G.sheet, borderColor: G.edge }]}>
            {/* Design screen 20: choose a status, then send.
                This also fixes a real trap in the previous flow — tapping a
                status sent IMMEDIATELY while the note field sat below it, so
                anyone who typed their note after choosing (the natural order,
                since the note is underneath) had it silently dropped. */}
            <View style={[st.grab, { backgroundColor: colors.border }]} />
            <Text style={[st.modalTitle, { color: colors.text }]}>Let your family know you&apos;re safe</Text>
            <ScrollView bounces={false} keyboardShouldPersistTaps="handled">
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
              style={[st.noteInput, { color: colors.text, borderColor: colors.glassStroke, backgroundColor: colors.glassSoft }]} />
            <TouchableOpacity
              onPress={() => picked && sendCheckin(picked)}
              disabled={!picked}
              style={[st.sendCheckin, { backgroundColor: picked ? colors.primary : colors.border }]}
            >
              <Text style={{ color: picked ? '#fff' : colors.textDim, fontWeight: '800', fontSize: 15 }}>
                {picked ? `Send “${picked.label}”` : 'Choose a status'}
              </Text>
            </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Announcement sheet ── */}
      <Modal visible={announcing} transparent animationType="slide" onRequestClose={() => setAnnouncing(false)}>
        <KeyboardAvoidingView behavior={'padding'} style={st.modalWrap}>
          <Pressable style={{ flex: 1 }} onPress={() => setAnnouncing(false)} />
          {/* Height-capped with an inner scroll, same recipe as the manage
              sheet: with the keyboard up at large font scales the fixed sheet
              pushed its top rows off-screen (audit-found). */}
          <View style={[st.modal, { backgroundColor: G.sheet, borderColor: G.edge, maxHeight: '86%' }]}>
            <View style={[st.grab, { backgroundColor: colors.border }]} />
            <Text style={[st.modalTitle, { color: colors.text }]}>Announcement</Text>
            <ScrollView bounces={false} keyboardShouldPersistTaps="handled">
            <Text style={{ color: colors.textDim, fontSize: 12.5, textAlign: 'center', marginBottom: 8 }}>
              Pinned to everyone&apos;s dashboard and raised as an alert.
            </Text>
            <TextInput
              value={announceTxt} onChangeText={setAnnounceTxt} multiline
              placeholder="What should everyone know?" placeholderTextColor={colors.textFaint}
              style={[st.noteInput, { color: colors.text, borderColor: colors.glassStroke, backgroundColor: colors.glassSoft, height: 96, paddingTop: 12 }]}
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
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Manage circle sheet ── */}
      <Modal visible={manage} transparent animationType="slide" onRequestClose={() => setManage(false)}>
        <KeyboardAvoidingView behavior={'padding'} style={st.modalWrap}>
          <Pressable style={{ flex: 1 }} onPress={() => setManage(false)} />
          {/* maxHeight + an inner scroll: this sheet holds 20+ actions, and on
              a short phone the top rows were pushed clean off the screen.
              Every action is unchanged — now they are all reachable. */}
          <View style={[st.modal, { backgroundColor: G.sheet, borderColor: G.edge, maxHeight: '86%' }]}>
            <View style={[st.grab, { backgroundColor: colors.border }]} />
            <Text style={[st.modalTitle, { color: colors.text }]}>{active?.name}</Text>
            {/* Indicator stays visible: 20+ rows, and without it nothing says
                the sheet scrolls at all. */}
            <ScrollView bounces={false} keyboardShouldPersistTaps="handled">

            {canManage && (
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 4 }}>
                <TextInput value={renameTxt} onChangeText={setRenameTxt} placeholder="Rename circle" placeholderTextColor={colors.textFaint}
                  style={[st.noteInput, { flex: 1, marginTop: 0, color: colors.text, borderColor: colors.glassStroke, backgroundColor: colors.glassSoft }]}
                  returnKeyType="done" onSubmitEditing={doRename} />
                <TouchableOpacity onPress={doRename} disabled={!renameTxt.trim() || busy}
                  style={[st.saveBtn, { backgroundColor: renameTxt.trim() ? colors.primary : colors.border }]}>
                  {busy ? <ActivityIndicator color="#fff" size="small" /> : <Ionicons name="checkmark" size={20} color="#fff" />}
                </TouchableOpacity>
              </View>
            )}

            <TouchableOpacity onPress={() => { setManage(false); openAdd(); }} style={[st.mRow, { borderColor: G.line }]}>
              <Ionicons name="person-add" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>Invite from contacts</Text>
            </TouchableOpacity>
            {canInvite && <TouchableOpacity onPress={() => { setManage(false); active && router.push({ pathname: '/group-invites' as any, params: { chatId: active.id, name: active.name } }); }} style={[st.mRow, { borderColor: G.line }]}>
              <Ionicons name="mail-open-outline" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>Sent invitations &amp; requests</Text>
            </TouchableOpacity>}
            <TouchableOpacity onPress={() => { setManage(false); active && router.push({ pathname: '/group-members' as any, params: { groupId: active.id, name: active.name } }); }} style={[st.mRow, { borderColor: G.line }]}>
              <Ionicons name="people-outline" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>Members &amp; roles</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setManage(false); router.push('/group-invitations' as any); }} style={[st.mRow, { borderColor: G.line }]}>
              <Ionicons name="mail-outline" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>My invitations</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setManage(false); router.push('/group-create' as any); }} style={[st.mRow, { borderColor: G.line }]}>
              <Ionicons name="add-circle-outline" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>Create or join another group</Text>
            </TouchableOpacity>
            {canAnnounce && (
              <TouchableOpacity onPress={() => { setManage(false); setAnnounceTxt(''); setAnnouncing(true); }} style={[st.mRow, { borderColor: G.line }]}>
                <Ionicons name="megaphone-outline" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>Post an announcement</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={() => { setManage(false); active && router.push({ pathname: '/group-calendar' as any, params: { groupId: active.id, name: active.name } }); }} style={[st.mRow, { borderColor: G.line }]}>
              <Ionicons name="calendar-outline" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>Shared calendar</Text>
            </TouchableOpacity>
            {/* The admin console. Offered only to someone who actually runs this
                space, and it carries their RESOLVED permissions across so the
                console draws only what they can use — a tile that fails on tap
                teaches people to distrust the whole screen. The permission list
                is presentation; every endpoint behind it re-checks server-side. */}
            {canOps && <TouchableOpacity onPress={() => { setManage(false); active && router.push({ pathname: '/space-admin' as any, params: { spaceId: active.id, name: active.name, groupType: active.groupType ?? '', perms: Array.from(perms).join(',') } }); }} style={[st.mRow, { borderColor: G.line }]}>
              <Ionicons name="shield-checkmark-outline" size={18} color={colors.primary} />
              <Text style={[st.mTxt, { color: G.accentText, fontWeight: '700' }]}>Admin console</Text>
            </TouchableOpacity>}
            {/* Attendance is only meaningful where someone oversees others, so
                it is offered on the same permission that shows the runs card
                rather than to every member of every household. */}
            {canOps && <TouchableOpacity onPress={() => { setManage(false); active && router.push({ pathname: '/space-attendance' as any, params: { spaceId: active.id, name: active.name } }); }} style={[st.mRow, { borderColor: G.line }]}>
              <Ionicons name="calendar-number-outline" size={18} color={colors.text} />
              <Text style={[st.mTxt, { color: colors.text }]}>Attendance</Text>
            </TouchableOpacity>}
            {/* The roster is offered to EVERYONE in an ops space, not just ops:
                a parent's "roster" is their own child, and that is the screen
                that tells them so. The server decides what is in it. */}
            {(canOps || hasPerm(perms, 'manage_roster') || !!active?.groupType?.includes('school') || !!active?.groupType?.includes('transport')) &&
              <TouchableOpacity onPress={() => { setManage(false); active && router.push({ pathname: '/space-roster' as any, params: { spaceId: active.id, name: active.name, canManage: hasPerm(perms, 'manage_roster') ? '1' : '0' } }); }} style={[st.mRow, { borderColor: G.line }]}>
                <Ionicons name="people-outline" size={18} color={colors.text} />
                <Text style={[st.mTxt, { color: colors.text }]}>Roster</Text>
              </TouchableOpacity>}
            <TouchableOpacity onPress={() => { setManage(false); active && router.push({ pathname: '/group-insights' as any, params: { groupId: active.id, name: active.name } }); }} style={[st.mRow, { borderColor: G.line }]}>
              <Ionicons name="stats-chart-outline" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>Insights</Text>
            </TouchableOpacity>
            {canNavigate && (
              <TouchableOpacity onPress={() => { setManage(false); active && router.push({ pathname: '/group-trip' as any, params: { groupId: active.id, name: active.name } }); }} style={[st.mRow, { borderColor: G.line }]}>
                <Ionicons name="navigate-outline" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>Start a group trip</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={() => { setManage(false); active && router.push({ pathname: '/media-gallery' as any, params: { chatId: active.id, peerName: active.name } }); }} style={[st.mRow, { borderColor: G.line }]}>
              <Ionicons name="images-outline" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>Shared album</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setManage(false); active && router.push({ pathname: '/group-notes' as any, params: { groupId: active.id, name: active.name } }); }} style={[st.mRow, { borderColor: G.line }]}>
              <Ionicons name="document-text-outline" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>Shared notes</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setManage(false); active && router.push({ pathname: '/group-tasks' as any, params: { groupId: active.id, name: active.name } }); }} style={[st.mRow, { borderColor: G.line }]}>
              <Ionicons name="checkbox-outline" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>Shared tasks</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setManage(false); active && router.push({ pathname: '/group-privacy' as any, params: { groupId: active.id, name: active.name } }); }} style={[st.mRow, { borderColor: G.line }]}>
              <Ionicons name="eye-off-outline" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>What this group can see</Text>
            </TouchableOpacity>
            {/* High-speed alert for MY OWN device (spec: speed alerts). Tap the
                threshold to cycle it. Off by default; detected on this phone —
                the server never sees a speed. */}
            <View style={[st.mRow, { borderColor: G.line }]}>
              <Ionicons name="speedometer-outline" size={19} color={colors.primary} />
              <Text style={[st.mTxt, { color: colors.text, flex: 1 }]}>High-speed alert</Text>
              {speedAlert.enabled && (
                <TouchableOpacity onPress={cycleSpeedThreshold} style={{ paddingHorizontal: 8 }} hitSlop={{ top: 12, bottom: 12 }} accessibilityRole="button" accessibilityLabel={`High-speed alert threshold ${speedAlert.thresholdKmh} kilometres per hour, tap to change`}>
                  <Text style={{ color: G.accentText, fontWeight: '800', fontSize: 13 }}>{speedAlert.thresholdKmh} km/h</Text>
                </TouchableOpacity>
              )}
              <Switch value={speedAlert.enabled} onValueChange={toggleSpeedAlert} trackColor={{ true: colors.primary }} />
            </View>
            <TouchableOpacity onPress={() => { setManage(false); active && router.push({ pathname: '/chat', params: { id: active.id } } as any); }} style={[st.mRow, { borderColor: G.line }]}>
              <Ionicons name="chatbubbles" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>Open circle chat</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setManage(false); router.push('/family-setup' as any); }} style={[st.mRow, { borderColor: G.line }]}>
              <Ionicons name="key" size={19} color={colors.primary} /><Text style={[st.mTxt, { color: colors.text }]}>Create or join another circle</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setManage(false); router.push('/emergency-sos' as any); }} style={[st.mRow, { borderColor: G.line }]}>
              <Ionicons name="medkit" size={19} color={colors.danger} /><Text style={[st.mTxt, { color: colors.text }]}>Emergency SOS (trusted contacts)</Text>
            </TouchableOpacity>
            <Text style={{ color: colors.textDim, fontSize: 12, paddingVertical: 8 }}>
              Tap a member for their details and history. Long-press to change their role or remove them.
            </Text>
            <TouchableOpacity onPress={doLeave} style={[st.mRow, { borderColor: G.line }]}>
              <Ionicons name="exit-outline" size={19} color={G.dangerText} /><Text style={[st.mTxt, { color: G.dangerText }]}>Leave circle</Text>
            </TouchableOpacity>
            {canManage && (
              <TouchableOpacity onPress={doDelete} disabled={busy} style={[st.mRow, { borderColor: G.line }]}>
                <Ionicons name="trash" size={19} color={G.dangerText} /><Text style={[st.mTxt, { color: G.dangerText, fontWeight: '800' }]}>Delete circle</Text>
              </TouchableOpacity>
            )}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Crash detected: loud, full-screen, and biased toward asking for
          help. Doing nothing sends the SOS; only "I'm OK" stops it. ── */}
      <Modal visible={crashAsk} transparent animationType="fade" onRequestClose={() => setCrashAsk(false)}>
        <View style={[st.crashWrap, { backgroundColor: 'rgba(0,0,0,0.82)' }]}>
          {/* maxHeight + inner scroll for the EXPLANATION only — the two
              buttons stay pinned below it. At large font scales the old fixed
              stack could push "I'm OK" off-screen, and an unreachable "I'm OK"
              means the countdown fires a false SOS. Button fills are the deep
              green/red (the light-scheme goodText/dangerText hues): white
              15.5px labels on #22C55E were 2.3:1 — the one button that stops
              a false alarm was the least readable thing on the screen. */}
          <View style={[st.crashCard, { backgroundColor: G.sheet, borderColor: colors.danger }]}>
            <ScrollView style={{ alignSelf: 'stretch', flexGrow: 0 }} bounces={false} contentContainerStyle={{ alignItems: 'center', gap: 10 }}>
              <Text style={{ fontSize: 40 }}>🚨</Text>
              <Text style={[st.crashTitle, { color: colors.text }]}>Possible crash detected</Text>
              <Text style={{ color: colors.textDim, fontSize: 13.5, textAlign: 'center', lineHeight: 19 }}>
                A hard impact was detected while driving. If you don’t respond,
                your circle gets an SOS with your live location.
              </Text>
              <Text style={[st.crashCount, { color: colors.danger }]}>{crashLeft}</Text>
            </ScrollView>
            <TouchableOpacity
              onPress={() => setCrashAsk(false)}
              accessibilityRole="button"
              style={[st.crashBtn, { backgroundColor: 'rgba(34,197,94,0.20)' }]}
            >
              <Text style={st.crashBtnTxt}>I’m OK</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => { setCrashAsk(false); fireSos(); }}
              accessibilityRole="button"
              style={[st.crashBtn, { backgroundColor: '#B42318' }]}
            >
              <Text style={st.crashBtnTxt}>Send SOS now</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// Spacing rides the 4/8/12/16 grid; radii step 18 → 20 → 24 → 28 with
// importance (tiles → cards → map/sheets → modals); glass panes carry
// SPACE_SHADOW so they float instead of reading as outlined boxes.
const st = StyleSheet.create({
  screen: { flex: 1 },
  // Loading placeholders — glass shapes, no shimmer (see the loading gate).
  skel: { borderWidth: 1 },
  dash: { padding: 16 },
  greetRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderWidth: 1, borderRadius: 22, marginBottom: 12, ...SPACE_SHADOW.raised },
  statusIcon: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  avatarRow: { flexDirection: 'row', alignItems: 'center' },
  // minWidth, not width: the "+N" overflow chip grows into a pill for double
  // digits instead of clipping; single initials stay a 26dp circle.
  miniDot: { minWidth: 26, height: 26, borderRadius: 13, paddingHorizontal: 2, alignItems: 'center', justifyContent: 'center', borderWidth: 2 },
  miniDotTxt: { color: '#fff', fontWeight: '800', fontSize: 11 },
  mapCard: { height: 300, borderRadius: 24, borderWidth: 1, overflow: 'hidden', marginBottom: 12, ...SPACE_SHADOW.raised },
  mapBadge: { position: 'absolute', top: 12, right: 12, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, ...SPACE_SHADOW.rest },
  collapse: { position: 'absolute', top: 12, right: 12, width: 40, height: 40, borderRadius: 20, borderWidth: 1, alignItems: 'center', justifyContent: 'center', ...SPACE_SHADOW.rest },
  // ── design screen 5: greeting + quick-action cards ──
  greetBell: {
    width: 42, height: 42, borderRadius: 21, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center', ...SPACE_SHADOW.rest,
  },
  bellDot: {
    position: 'absolute', top: 8, right: 9, width: 9, height: 9,
    borderRadius: 5, borderWidth: 1.5,
  },
  qaGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 12 },
  // Three across on a normal phone; wraps to two on narrow screens rather than
  // squeezing the subtitle out of existence. (minWidth tracks the 16px screen
  // margin — at 104 the wider gutters pushed 360dp phones down to two-up.)
  qa: {
    flexBasis: '30%', flexGrow: 1, minWidth: 100,
    borderWidth: 1, borderRadius: 18, padding: 12, gap: 8, ...SPACE_SHADOW.rest,
  },
  qaIcon: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  qaTitle: { fontSize: 13.5, fontWeight: '700' },
  qaSub: { fontSize: 11 },
  badge: { position: 'absolute', top: 6, right: 10, minWidth: 18, height: 18, borderRadius: 9, borderWidth: 1.5, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  badgeTxt: { color: '#fff', fontSize: 10, fontWeight: '800' },
  announce: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderWidth: 1, borderRadius: 18, marginBottom: 12, ...SPACE_SHADOW.rest },
  sosBig: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderWidth: 1.5, borderRadius: 20, overflow: 'hidden', marginBottom: 12, ...SPACE_SHADOW.rest },
  sosIcon: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  // The share toggle's own pane on the dashboard.
  shareCard: { borderWidth: 1, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 2, marginBottom: 12, ...SPACE_SHADOW.rest },
  shareRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10 },
  // marginTop 4: every card above a section head now carries marginBottom 12,
  // so the total 16 lands on the grid without double-counting.
  secHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, marginBottom: 8 },
  secTitle: { fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.7 },
  // One vertical rhythm: every card in the scroll column sits 12 under its
  // neighbour — the audit found 4/10/12/14 all in play, the classic tell.
  card: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 6, marginBottom: 12, ...SPACE_SHADOW.rest },
  // Tertiary info rows: faint glass, no float — they explain, they don't lead.
  quiet: { shadowOpacity: 0, elevation: 0 },
  distRow: { flexDirection: 'row', alignItems: 'flex-start', paddingTop: 10 },
  distCell: { flex: 1, alignItems: 'center', gap: 3, paddingHorizontal: 4 },
  distVal: { fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] },
  distLbl: { fontSize: 11, textAlign: 'center' },
  distDiv: { width: 1, height: 30 },
  sortRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  // 30dp visual height reads as a chip, not a button; the 7dp vertical hitSlop
  // on every user of this style is what carries the target to the 44dp floor.
  sortChip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, minHeight: 30, justifyContent: 'center' },
  sheet: { borderTopWidth: 1, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16, gap: 6, ...SPACE_SHADOW.raised },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  dot: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  dotTxt: { color: '#fff', fontWeight: '800' },
  rowBtn: { padding: 6 },
  modalWrap: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  modal: { borderTopLeftRadius: 28, borderTopRightRadius: 28, borderWidth: 1, padding: 18, paddingBottom: 28, gap: 8 },
  grab: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, marginBottom: 10 },
  modalTitle: { fontSize: 18, fontWeight: '800', marginBottom: 6, textAlign: 'center' },
  checkGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  // minHeight, not height, on anything that holds text: at the largest system
  // font scales a fixed height clips the label, and a clipped emergency or
  // send button is worse than a slightly taller one.
  // paddingHorizontal 24 reserves the corner the selected-state checkmark
  // occupies, so it never overprints the label on narrow tiles.
  checkBtn: { flexBasis: '47%', flexGrow: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 54, paddingHorizontal: 24, borderRadius: 16, borderWidth: 1 },
  noteInput: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, minHeight: 48, marginTop: 4, fontSize: 14.5 },
  sendCheckin: { marginTop: 10, minHeight: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  btnWide: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 52, borderRadius: 16, marginTop: 12 },
  saveBtn: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  mRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth },
  mTxt: { fontSize: 15, fontWeight: '600' },
  crashWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 26 },
  crashCard: { width: '100%', maxWidth: 360, maxHeight: '90%', borderWidth: 2, borderRadius: 24, padding: 22, alignItems: 'center', gap: 10 },
  crashTitle: { fontSize: 19, fontWeight: '900', textAlign: 'center' },
  crashCount: { fontSize: 44, fontWeight: '900', fontVariant: ['tabular-nums'] },
  crashBtn: { alignSelf: 'stretch', minHeight: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  crashBtnTxt: { color: '#fff', fontSize: 15.5, fontWeight: '800' },
});
