// app/family.tsx — Family Space: the single hub that absorbed the old Family
// Circle + SOS mini-apps (mockup screen 5). One screen, two modes:
//   dashboard — greeting, status card, map preview, quick tiles, hold-to-SOS,
//               members, today's highlights (decrypted check-ins/SOS)
//   expanded  — full-screen live map + roster sheet
// Circle CRUD (rename/roles/remove/leave/delete) lives in the ⋯ manage sheet;
// all of it rides existing group endpoints. Live pings ride the sealed E2EE
// relay; the same privacy-reduced points are ALSO uploaded in plain form to the
// space location store (lib/family/presence.ts → lib/location/publisher.ts),
// which only circle members may read.
//
// This file holds the hub's state and actions. The pieces it draws, and the
// effects that feed it, live in components/family/Hub*.tsx and use*.ts.

import { AppText as Text } from '../components/ui/Text';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, TouchableOpacity, ScrollView, Alert, Animated, Vibration, Linking, useWindowDimensions,
} from 'react-native';
import * as Location from 'expo-location';
import { Stack, useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import ChatDoorButton from '../components/spaces/ChatDoorButton';
import SpaceGround from '../components/spaces/SpaceGround';
import { useTheme } from '../lib/theme';
import { SPACE_GLASS } from '../constants/spaceTheme';
import FamilyMap, { type FamilyMarker } from '../components/family/FamilyMap';
// removeCircle stays: hetzner-deploy added a path that forgets a circle locally
// when the server starts 403/404ing it (kicked, or deleted). That is orthogonal
// to the group registry and must survive the switch — dropping it would bring
// back a phone retrying a dead circle on every focus.
import { getSettings, removeCircle, getPlaces } from '../lib/family/store';
import { canShareInBackground } from '../lib/family/presence';
import { memberLabel } from '../lib/family/relations';
import { useVisibleTick } from '../lib/family/useVisibleTick';
import { type Geofence } from '../lib/family/geofence';
// Groups & Circles: the registry is now typed groups. A Family Space circle is
// one of them (migrated on first load by lib/groups/store), so this screen is
// the group dashboard and no longer assumes there is exactly one family.
import { listGroups, resolveActiveGroup, saveGroup, setActiveGroupId, type GroupRef } from '../lib/groups/store';
import { groupIdentity } from '../lib/groups/catalog';
import { can as hasPerm, type Permission } from '../lib/groups/permissions';
import { familyOf, isOperational, sectionsFor, memberHeading } from '../lib/spaces/layout';
import {
  circleMembers, renameCircle, leaveCircle, deleteCircle,
  removeCircleMember, setGuardian,
} from '../lib/family/circle';
import { loadGroupsReconciled } from '../lib/family/hubGroups';
import { loadAlerts, recordAlert, useUnreadCount } from '../lib/family/alerts';
import { requestCheckin, confirmImOk } from '../lib/family/escalationService';
import { MISSES_BEFORE_EMERGENCY } from '../lib/family/escalation';
import { type CircleMember, STALE_MS, DEFAULT_SPEED_ALERT_KMH } from '../lib/family/types';
import { sendMessage, getChat, sendAnnouncement } from '../lib/chatService';
import { getCurrentUserAsync } from './(constants)/authService';
import { navigateTo } from '../lib/nav/openNavigation';
import { type SortMode } from '../lib/family/distance';
import CrashCountdown from '../components/family/CrashCountdown';
import { HubShareRow, HubSosButton } from '../components/family/HubControls';
import { useHubSharing } from '../components/family/useHubSharing';
import CheckinSheet, { type Checkin } from '../components/family/CheckinSheet';
import AnnouncementSheet from '../components/family/AnnouncementSheet';
import HubManageSheet from '../components/family/HubManageSheet';
import HubMemberRow from '../components/family/HubMemberRow';
import HubQuickActions from '../components/family/HubQuickActions';
import HubDistancePanel from '../components/family/HubDistancePanel';
import HubTop, { HubSkeleton, RosterLoadState } from '../components/family/HubTop';
import { FamilyNowBoard, RunCards, TripCard, NotVisibleNote, HighlightsCard } from '../components/family/HubSpaceCards';
import { st } from '../components/family/hubStyles';
import { useHubPresence } from '../components/family/useHubPresence';
import { useHubDistances } from '../components/family/useHubDistances';
import { useHubTrip, useHubHighlights, useHubRuns, useHubRelations } from '../components/family/useHubFeeds';
import { useWatchAlerts, useCrashDetection } from '../components/family/useHubSafety';

const SOS_HOLD_MS = 1500;
/** Oldest cached fix an SOS message may quote as the sender's position. */
const SOS_FIX_MAX_AGE_MS = 5 * 60_000;

// The dusk-glass ground (gradient + identity aura) is shared with every other
// Space screen — see components/spaces/SpaceGround.tsx. Switching spaces
// re-colours the room, nothing else moves.

export default function FamilySpaceScreen() {
  const { colors, scheme } = useTheme();
  const G = SPACE_GLASS[scheme];
  const router = useRouter();
  const { height: winH } = useWindowDimensions();
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
  /** The last roster request failed for a reason other than "you are out" —
   *  shown with a Retry instead of an endless "Loading members…". */
  const [membersFailed, setMembersFailed] = useState(false);
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
  const [loading, setLoading] = useState(true);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [manage, setManage] = useState(false);
  const [checkin, setCheckin] = useState(false);
  const [renameTxt, setRenameTxt] = useState('');
  const [note, setNote] = useState('');
  /** Selected check-in status, held until Send (design screen 20). */
  const [picked, setPicked] = useState<Checkin | null>(null);
  const [busy, setBusy] = useState(false);
  const [bump, setBump] = useState(0); // re-pull highlights after we send something
  const unread = useUnreadCount(active?.id ?? null);
  // THIS USER's permissions in the active group, as resolved by the server.
  // Presentation only — every mutating endpoint re-checks. A stale or absent
  // set must never widen what is shown, so it starts empty.
  const [perms, setPerms] = useState<Set<Permission>>(new Set());
  const [announcing, setAnnouncing] = useState(false);
  const [announceTxt, setAnnounceTxt] = useState('');
  // This circle's saved Places (device-local geofences) — they name the FAMILY
  // NOW board's "At Home / At School" rows. Statuses are derived here on the
  // viewing device from decrypted presences: Places never leave this device, so
  // the server cannot compute "at school", and this screen never invents one.
  const [places, setPlacesState] = useState<Geofence[]>([]);
  const {
    share, setShare, locDenied, setLocDenied, speedAlert, setSpeedAlert, bgAsked,
    toggleShare, toggleSpeedAlert, cycleSpeedThreshold, enableBackgroundSharing,
  } = useHubSharing({ spaceName: active?.name, inSpace: !!active && !!me });

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
    if (!cs.length) { router.replace('/family-setup'); return; }
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
  })(); }, [router, setShare, setSpeedAlert]);

  const { trip, tripPings } = useHubTrip(active?.id, me?.id);
  const { highlights, announcement } = useHubHighlights(active?.id, bump);
  const relations = useHubRelations(active?.id);
  const { presences } = useHubPresence({ active, me, circles, share, onLocDenied: setLocDenied });

  // ── Circle management ────────────────────────────────────────────────
  const afterCircleGone = useCallback(async () => {
    setManage(false);
    const cs = await listGroups();
    setCircles(cs);
    if (!cs.length) { router.replace('/family-setup'); return; }
    setActive(cs[0]);
  }, [router]);

  // Keeps hetzner-deploy's dead-circle handling: a kicked member's phone must
  // not retry a 403 circle on every focus and highlights poll.
  const activeId = active?.id;
  const refreshMembers = useCallback(() => {
    if (!activeId) return;
    const id = activeId;
    setMembersFailed(false);
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
      // false so the UI never asserts a roster of one; the status card then
      // says the load failed and offers Retry.
      console.warn('[family] could not load members:', e?.status ?? '', e?.message ?? e);
      setMembersFailed(true);
    });
  }, [activeId, afterCircleGone]);
  // refreshMembers changes only with the active id (or router), so this runs
  // once per space, exactly as before.
  useEffect(() => { setMembersLoaded(false); refreshMembers(); }, [refreshMembers]);

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

  // Refresh on focus — /family-add and /family-setup both mutate state this
  // screen already has in memory, and neither changes active.id, so nothing
  // else would re-read it. Places too: /family-places edits them and comes
  // straight back here, where the FAMILY NOW board is derived from them.
  useFocusEffect(useCallback(() => {
    let live = true;
    (async () => {
      const cs = await loadGroupsReconciled();
      if (!live) return;
      setCircles(cs);
      if (!cs.length) { router.replace('/family-setup'); return; }
      // Keep the user on the space they were looking at unless it is gone.
      setActive(prev => (prev && cs.some(c => c.id === prev.id)) ? prev : cs[0]);
    })();
    refreshMembers();
    if (activeId) getPlaces(activeId).then((p) => { if (live) setPlacesState(p); }).catch(() => {});
    return () => { live = false; };
  }, [router, activeId, refreshMembers]));

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

  // Members this device has no position for. Markers come only from
  // `presences`, so a member who has not turned sharing on simply does not
  // appear — and an absent marker is indistinguishable from a broken map.
  // This device cannot tell "not sharing" from "no fix has reached us yet", so
  // the wording covers both rather than accusing anyone of having it off.
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

  // Space type drives the dashboard. isOperational is also the runs gate: a
  // school parent is an ordinary `member` with NO permissions (migration 084),
  // so gating the fetch on ops rights meant they never asked for the run their
  // own child is on. The server is the authority on what a caller may see
  // (vc_run_visible); the client must not overrule it by not asking.
  const spaceFamily = familyOf(active?.groupType);
  const familyLike = spaceFamily === 'family' || spaceFamily === 'generic';
  const opsSpace = isOperational(active?.groupType);
  const sections = useMemo(
    () => sectionsFor(active?.groupType, perms),
    [active?.groupType, perms],
  );
  const runs = useHubRuns(active?.id, canDrive || canOps || opsSpace);

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
  const activeType = active?.groupType ?? '';
  useEffect(() => {
    if (droveOnce.current || canOps || !canDrive || !activeId || !me?.id) return;
    const mine = runs.find((r) => r.driverId === me.id && r.status === 'started');
    if (!mine) return;
    droveOnce.current = true;
    router.push({ pathname: '/space-run-driver', params: { spaceId: activeId, runId: mine.id, groupType: activeType } });
  }, [runs, canDrive, canOps, activeId, activeType, me?.id, router]);
  // Identity for this group's type — its accent tints the ground.
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

  const { roadM, summary: distanceSummary, anyoneLocatable, sortedIds } = useHubDistances({
    presences, members, myId: me?.id ?? null, tick, originName, places, relations, sortMode,
  });

  // Contact picker: add someone straight from the phone's contacts. Invite
  // codes and the sent-invitations manager live on /family-add and
  // /group-invites.
  const openAdd = () => {
    if (!active) return;
    router.push({ pathname: '/family-add', params: { circleId: active.id, circleName: active.name } });
  };

  // ── SOS: hold-to-activate ────────────────────────────────────────────
  const sosProg = useRef(new Animated.Value(0)).current;
  const sosTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fireSos = async () => {
    sosProg.setValue(0);
    if (!active || !me) return;
    Vibration.vibrate([0, 400, 150, 400]);
    // THE MESSAGE GOES FIRST. Turning sharing on can raise the location,
    // background-location and battery-exemption system dialogs, and a high-
    // accuracy fix can take tens of seconds — none of that may stand between
    // the user and the alert. The OS's cached fix is instant and prompt-free
    // (it throws without permission, which just means no coordinates); live
    // sharing, started right after, supplies the real position.
    // The cache can be hours old, and a stale fix sent as "where I am" sends
    // the circle to the wrong place — so it only goes when it is recent.
    try {
      let where = ' (location unavailable)';
      try {
        const c = await Location.getLastKnownPositionAsync({ maxAge: SOS_FIX_MAX_AGE_MS });
        if (c && Date.now() - c.timestamp <= SOS_FIX_MAX_AGE_MS) {
          where = ` (${c.coords.latitude.toFixed(5)}, ${c.coords.longitude.toFixed(5)})`;
        }
      } catch {}
      await sendMessage(active.id, `🆘 ${me.name} triggered an SOS — please respond${where}`, 'system');
    } catch (e: any) { Alert.alert('SOS', e?.message ?? 'Could not send SOS.'); return; }
    recordAlert({
      circleId: active.id, kind: 'sos', actorId: me.id, actorName: me.name,
      text: `${me.name} triggered an SOS`,
    }).catch(() => {});
    setBump((b) => b + 1);
    const live = await toggleShare(true, true).catch(() => false);
    // The one dialog after an SOS: what happened, plus the single fix that
    // matters — location access when sharing could not start, or always-on
    // location when it only runs while this screen is open — instead of the
    // stack of dialogs toggleShare would otherwise raise.
    const bgMissing = live && !(await canShareInBackground().catch(() => true));
    if (bgMissing) bgAsked.current = true;
    const fix = !live
      ? [{ text: 'Open settings', onPress: () => { Linking.openSettings().catch(() => {}); } }]
      : bgMissing
        ? [{ text: 'Keep sharing when locked', onPress: () => { enableBackgroundSharing(); } }]
        : [];
    Alert.alert('SOS sent', !live
      ? 'Your circle has been alerted. Your live location is NOT being shared — check that location access is on.'
      : bgMissing
        ? 'Your circle has been alerted and your live location is on while crazzychat is open.'
        : 'Your circle has been alerted and your live location is on.', [
      ...fix,
      { text: 'Also alert trusted contacts', onPress: () => router.push('/emergency-sos') },
      { text: 'OK' },
    ]);
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

  useWatchAlerts({ activeId, myId: me?.id, members, membersLoaded, presences, tick });
  const crash = useCrashDetection({ armed: share, presences, myId: me?.id, onSos: fireSos });

  // ── Check-in ─────────────────────────────────────────────────────────
  const sendCheckin = async (c: Checkin) => {
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

  // ── Escalation ladder (F6) ───────────────────────────────────────────
  /** Guardian asks a member to check in; the ladder escalates if they don't. */
  const askCheckin = (m: CircleMember) => {
    if (!active || !me) return;
    Alert.alert(
      `Ask ${m.name} to check in?`,
      `They'll be asked now, reminded twice if there's no reply, and after ${MISSES_BEFORE_EMERGENCY} missed reminders the circle gets an emergency alert.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Ask', onPress: async () => {
          try {
            await requestCheckin({
              circleId: active.id, subjectId: m.id, subjectName: m.name,
              meId: me.id, meName: me.name,
            });
            setBump((b) => b + 1);
          } catch (e: any) { Alert.alert('Check-in', e?.message ?? 'Could not send the request.'); }
        } },
      ],
    );
  };

  /** Member answers a request. Harmless when no ladder is running for them. */
  const sendImOk = async () => {
    if (!active || !me) return;
    setCheckin(false);
    try {
      await confirmImOk(active.id, me.id, me.name);
      setBump((b) => b + 1);
    } catch (e: any) { Alert.alert('Check-in', e?.message ?? 'Could not send.'); }
  };

  // ── Announcement ─────────────────────────────────────────────────────
  const postAnnouncement = async () => {
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
      // The server re-checks the permission, so this can legitimately fail
      // even though the button was drawn.
      Alert.alert('Not posted', e?.message ?? 'Could not post the announcement.');
    } finally { setBusy(false); }
  };

  // ── Member management (guardians) ────────────────────────────────────
  const memberActions = (m: CircleMember) => {
    if (!active || !me || m.id === me.id || !canRemove) return;
    Alert.alert(m.name, 'Manage this member', [
      { text: 'Ask to check in', onPress: () => askCheckin(m) },
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
        // leaveCircle throws when the server refused; the circle then stays
        // listed (the user is still in it) and they are told why.
        try { await leaveCircle(active.id, me.id); await afterCircleGone(); }
        catch (e: any) { Alert.alert('Leave', e?.message ?? 'Could not leave the circle. Try again.'); }
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

  if (loading) return <HubSkeleton />;

  const mine = me ? presences[me.id] : undefined;
  // Only stand in for the roster once we KNOW it is empty. `members` is empty
  // while the fetch is in flight and after an error, and a fabricated
  // one-person roster ("1 of 1 sharing live" for a space of three) is what
  // "family is not working" looks like from the outside. Not-yet-known and
  // known-empty are different states, and only one of them may be asserted.
  const unsortedRoster = members.length
    ? members
    : (membersLoaded && me ? [{ id: me.id, name: 'You', role: 'guardian' as const, avatar: null }] : []);
  // Apply the chosen order (spec §9). A member the distance layer has not seen
  // sorts LAST rather than first — an unranked row floating to the top would
  // read as "nearest", which is the one thing it is not known to be.
  const rank = new Map(sortedIds.map((id, i) => [id, i]));
  const roster = [...unsortedRoster].sort(
    (a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity),
  );
  const allGood = liveCount > 0;
  const firstName = (me?.name || 'there').split(/\s+/)[0];

  const openMember = (m: CircleMember) => {
    if (!active) return;
    router.push({
      pathname: '/family-member',
      params: { circleId: active.id, circleName: active.name, userId: m.id, name: m.id === me?.id ? 'You' : m.name, role: m.role },
    });
  };

  const memberRow = (m: CircleMember, i: number) => {
    const p = presences[m.id];
    const isMe = m.id === me?.id;
    return (
      <HubMemberRow
        key={m.id} m={m} index={i} p={p} mine={mine} isMe={isMe}
        label={isMe ? 'You' : memberLabel(m.name, relations[m.id])}
        share={share} locDenied={locDenied} roadD={roadM[m.id]}
        manageable={!!active && !!me && !isMe && canRemove}
        onOpen={() => openMember(m)}
        onManage={() => memberActions(m)}
        onShowOnMap={() => { setFocusId(m.id); setExpanded(true); }}
        onNavigate={() => { if (p) navigateTo(p.pos.lat, p.pos.lng, m.name); }}
      />
    );
  };

  const shareToggleRow = (
    <HubShareRow share={share} onToggle={(v) => { toggleShare(v); }} locDenied={locDenied} groupType={active?.groupType} />
  );

  return (
    // bgMid under the gradient: if the ground ever misses a frame during a
    // transition, the fallback is the mid dusk tone, not the theme's black.
    <View style={[st.screen, { backgroundColor: G.bgMid }]}>
      <SpaceGround aura={ident.color || colors.primary} />
      {/* The space's own name when there is one; otherwise the module's name.
          NOT "Family Space" — family is one type among sixteen. */}
      <Stack.Screen options={{
        // headerShown is FALSE app-wide (root layout); without opting back in,
        // the back chevron, invite button and ⋯ manage-sheet trigger never
        // render on a device and everything behind the sheet is unreachable.
        headerShown: true,
        // The header sits on the same dusk ground as the screen — bgTop keeps
        // the seam invisible without the layout risk of a transparent header.
        headerStyle: { backgroundColor: G.bgTop }, headerTintColor: colors.text, headerShadowVisible: false,
        title: active?.name || 'Spaces', headerTitleAlign: 'center',
        // A way OUT: a parent moves between their family and their child's
        // school transport space, and the system back gesture is not obvious.
        headerLeft: () => (
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back"
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/mini'))}
            style={{ paddingHorizontal: 8 }}
          >
            <Ionicons name="chevron-back" size={24} color={colors.primary} />
          </TouchableOpacity>
        ),
        headerRight: () => (
          <View style={{ flexDirection: 'row' }}>
            {/* The door to this group's ONE thread — same history and unread
                state as the chats tab (chat-map-separation D5). */}
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
              over that much detail costs readability and buys nothing. The
              roster grows with the screen (40% of its height) instead of a
              fixed 190 dp, so a tall phone or a big circle shows more rows. */}
          <View style={[st.sheet, { backgroundColor: G.sheet, borderColor: G.edge }]}>
            {shareToggleRow}
            <ScrollView style={{ maxHeight: Math.round(winH * 0.4) }} contentContainerStyle={{ paddingBottom: 6 }}>
              {!membersLoaded && <RosterLoadState failed={membersFailed} onRetry={refreshMembers} />}
              {roster.map(memberRow)}
            </ScrollView>
          </View>
        </>
      ) : (
        /* ── dashboard ── */
        <ScrollView contentContainerStyle={st.dash} showsVerticalScrollIndicator={false}>
          <HubTop
            firstName={firstName} active={active} circles={circles} onSelect={setActive}
            unread={unread} announcement={announcement} allGood={allGood}
            membersLoaded={membersLoaded} membersFailed={membersFailed} liveCount={liveCount}
            roster={roster} sharingOn={share} presentIds={new Set(Object.keys(presences))}
            onRetryMembers={refreshMembers}
          />

          {/* map preview */}
          <TouchableOpacity activeOpacity={0.9} onPress={() => setExpanded(true)}
            accessibilityRole="button"
            accessibilityLabel={`Live map, ${liveCount} sharing live. Opens the full-screen map`}
            style={[st.mapCard, { borderColor: G.edge }]}>
            <FamilyMap members={markers} focusId={focusId} onSelect={() => setExpanded(true)} style={{ flex: 1 }} />
            <View style={[st.mapBadge, { backgroundColor: G.paneStrong, borderColor: G.edge }]}>
              <Ionicons name="expand" size={13} color={colors.text} /><Text style={{ color: colors.text, fontSize: 12, fontWeight: '700' }}>Live Map</Text>
            </View>
          </TouchableOpacity>

          {notVisible.length > 0 && <NotVisibleNote names={notVisible} />}

          {familyLike && membersLoaded && roster.length > 1 && (
            <FamilyNowBoard
              familySpace={spaceFamily === 'family'} rosterIds={roster.map((m) => m.id)}
              presences={presences} myId={me?.id ?? null} sharingOn={share} places={places}
            />
          )}

          {/* A SCHOOL, OFFICE OR CAB SPACE GETS ITS OWN SECTIONS — the same
              screen, header, switcher, map and members, with the middle band
              routed by space type (lib/spaces/layout.ts decides). */}
          <HubQuickActions
            active={active} opsSections={!familyLike} sections={sections} perms={perms}
            liveCount={liveCount} unread={unread} canZones={canZones} canHistory={canHistory}
            onExpand={() => setExpanded(true)} onCheckin={() => setCheckin(true)}
          />

          {/* hold-to-SOS — a family/friends affordance. A school parent holding
              their phone down to raise an alarm to a whole school is not the
              same gesture, and a bus space has its own incident flow. */}
          {familyLike && (
            <HubSosButton progress={sosProg} onPressIn={sosStart} onPressOut={sosEnd} onSend={() => { fireSos(); }} />
          )}

          {/* Same row, its own pane on the dashboard (in the expanded sheet it
              sits directly on the sheet surface). */}
          <View style={[st.shareCard, { backgroundColor: G.pane, borderColor: G.edge }]}>
            {shareToggleRow}
          </View>

          {!!active && <RunCards runs={runs} active={active} myId={me?.id ?? null} canDrive={canDrive} canOps={canOps} />}
          {!!trip && !!active && <TripCard trip={trip} tripPings={tripPings} members={members} myId={me?.id ?? null} active={active} />}

          {/* members */}
          <View style={st.secHead}>
            <Text accessibilityRole="header" style={[st.secTitle, { color: colors.textDim }]}>{memberHeading(active?.groupType)}</Text>
            {/* "+ Invite" opens the CONTACT PICKER; the sent-invitations
                manager is one tap away in the ⋯ sheet. */}
            {canInvite && active && (
              <TouchableOpacity onPress={openAdd} hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
                accessibilityRole="button" accessibilityLabel="Invite from contacts">
                <Text style={{ color: G.accentText, fontWeight: '700', fontSize: 12.5 }}>+ Invite</Text>
              </TouchableOpacity>
            )}
          </View>
          <HubDistancePanel
            summary={distanceSummary} originName={originName} onOrigin={setOriginName} places={places}
            showOrigins={places.length > 0 && anyoneLocatable} showSort={roster.length > 2}
            sortMode={sortMode} onSort={setSortMode}
          />

          <View style={[st.card, { backgroundColor: G.pane, borderColor: G.edge }]}>
            {roster.map(memberRow)}
          </View>

          {highlights.length > 0 && <HighlightsCard highlights={highlights} active={active} />}
          <View style={{ height: 24 }} />
        </ScrollView>
      )}

      <CheckinSheet
        visible={checkin} onClose={() => setCheckin(false)}
        picked={picked} onPick={setPicked}
        note={note} onNote={setNote}
        onSend={sendCheckin} onImOk={sendImOk}
      />

      <AnnouncementSheet
        visible={announcing} onClose={() => setAnnouncing(false)}
        text={announceTxt} onText={setAnnounceTxt} busy={busy}
        onPost={postAnnouncement}
      />

      <HubManageSheet
        visible={manage} onClose={() => setManage(false)} active={active} perms={perms}
        can={{ manage: canManage, invite: canInvite, announce: canAnnounce, ops: canOps, navigate: canNavigate }}
        renameTxt={renameTxt} onRenameTxt={setRenameTxt} onRename={doRename} busy={busy}
        speedAlert={speedAlert} onToggleSpeedAlert={toggleSpeedAlert} onCycleSpeed={cycleSpeedThreshold}
        onInvite={openAdd} onAnnounce={() => { setAnnounceTxt(''); setAnnouncing(true); }}
        onLeave={doLeave} onDelete={doDelete}
      />

      <CrashCountdown
        visible={crash.crashAsk} secondsLeft={crash.crashLeft}
        onOk={crash.dismiss}
        onSendNow={crash.sendNow}
      />
    </View>
  );
}
