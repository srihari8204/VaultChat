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

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, ActivityIndicator, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../lib/theme';
import { useSpaceGlass } from '../components/spaces/SpaceGround';
import FamilyMap, { type FamilyMarker } from '../components/family/FamilyMap';
import MeetHereSheet, { type MeetDestination } from '../components/family/MeetHereSheet';
import { type MemberInput, formatMetres, formatRoute } from '../lib/family/distance';
import { circleMembers } from '../lib/family/circle';
import { subscribeCircle, type PresenceEvent } from '../lib/family/presence';
import { freshnessOf, markSharingOff, type Freshness, zoomForSpeed } from '../lib/family/status';
import { subscribeSpaceLocations, mergePresence, fetchSpaceSnapshot } from '../lib/location/live';
import { startRefreshController } from '../lib/family/refresh';
import { useVisibleTick } from '../lib/family/useVisibleTick';
import { type CircleMember, type MemberPresence } from '../lib/family/types';
import { getPlaces, getDefaultRef } from '../lib/family/store';
import { type Geofence } from '../lib/family/geofence';
import { fetchRoute, nextTurnAlong, type Maneuver } from '../lib/nav/routing';
import { haversine } from '../lib/nav/geo';
import { startNavigation, stopNavigation, forceReroute, useNavBanner } from '../lib/nav/navigationService';
import { loadNavSettings, getNavSettings } from '../lib/nav/navSettings';
import { playHaptic } from '../lib/nav/hapticPlayer';
import { iconFor } from '../components/nav/NavBanner';
import NavigationLayer from '../components/family/NavigationLayer';
import SelectedMemberSheet from '../components/family/SelectedMemberSheet';
import { createDirectChat } from '../lib/chatService';
import { cameraForManeuver, type CameraPlan } from '../lib/nav/navPresentation';
import {
  startTrip, joinTrip, endTrip, leaveTrip, subscribeTrip, currentTrip, setTripRoute,
} from '../lib/groups/tripSession';
import { foldParticipants, lastEta, minutesUntil, type Trip, type TripPing } from '../lib/groups/trips';
import { leavePlan, formatLeaveIn } from '../lib/family/leaveNow';
import { armLeaveNow, cancelLeaveNow } from '../lib/family/leaveNowAlarm';
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
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  // The map owns the whole ground here, so no SpaceGround — the glass system
  // shows up as SOLID sheet-toned floating bars: translucent panes over live
  // map tiles cost readability and buy nothing (same rule as the hub's
  // expanded roster sheet).
  const G = useSpaceGlass();
  const router = useRouter();
  const params = useLocalSearchParams<{ circleId?: string; circleName?: string; followId?: string }>();
  const circleId = String(params.circleId || '');

  const [me, setMe] = useState<string | null>(null);
  const [members, setMembers] = useState<CircleMember[]>([]);
  const [membersLoaded, setMembersLoaded] = useState(false);
  const [presences, setPresences] = useState<Record<string, MemberPresence>>({});
  const [focusId, setFocusId] = useState<string | null>(null);
  // Follow mode (spec: Follow member). Null = free map interaction. Seeded
  // from the route param so "Follow" on a member's detail screen lands here
  // already following them.
  const [followId, setFollowId] = useState<string | null>(params.followId ? String(params.followId) : null);
  /** Meet Here (§40). A mode over the same map, never a separate screen (§4). */
  const [meetOpen, setMeetOpen] = useState(false);
  const [destination, setDestination] = useState<MeetDestination | null>(null);
  /**
   * The circle's live FAMILY TRIP (shared destination). Discovered from the
   * same announcement channel the hub watches; while one is running it OWNS
   * the destination pin, so every member's map shows the same place without
   * anyone typing it.
   */
  const [trip, setTrip] = useState<Trip | null>(currentTrip());
  const [tripPings, setTripPings] = useState<TripPing[]>([]);
  /** True while a navigation session started FROM THIS SCREEN is running —
   *  so ending the trip stops OUR guidance and never someone's unrelated
   *  Navigate-app session. */
  const navHere = useRef(false);
  /** Dashed distance lines to every member. On by default — it is the picture
   *  the screen exists to show — but dismissible when the map gets busy. */
  const [showLinks, setShowLinks] = useState(true);
  // Render tick so "LIVE" decays to "5 min ago" without a new ping arriving.
  //
  // Gated on visibility: backgrounded, this screen was re-rendering the map,
  // every member row and every distance every 30 s for pixels nobody could
  // see. `now` is derived from the tick rather than stored, so returning to
  // the foreground recomputes freshness immediately instead of showing a
  // timestamp frozen at the moment the user left.
  const visibleTick = useVisibleTick(30_000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), [visibleTick]);

  /**
   * My own position, for "1.2 km from You".
   *
   * getLastKnownPositionAsync READS THE OS CACHE — it starts no watcher, powers
   * up no GPS, and never prompts. That matters here: this screen is read-only by
   * design (see the header), so acquiring a position must not turn opening a map
   * into a permission request or a publisher. Without the permission it simply
   * returns null and the from-me distances stay hidden, which is correct.
   */
  const [mine, setMine] = useState<MemberPresence | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const loc = await Location.getLastKnownPositionAsync();
        if (live && loc) {
          setMine({
            userId: me ?? 'me',
            pos: { lat: loc.coords.latitude, lng: loc.coords.longitude },
            ts: loc.timestamp || Date.now(),
          });
        }
      } catch { /* no permission, or no cached fix — from-me distances stay hidden */ }
    })();
    return () => { live = false; };
  }, [me, now]);

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
      // The circle's family trip: discover it, AUTO-JOIN it, and keep its
      // per-member ETAs flowing into the rows below. Auto-join is deliberate —
      // a member a trip was started for should see their route and share their
      // ETA without a joining ceremony. Only DERIVED numbers ride the trip
      // channel; the circle already sees this member's position via presence.
      try {
        const un3 = await subscribeTrip(
          circleId, myId,
          (e) => {
            if (!live) return;
            setTripPings((prev) => (e.ping
              ? [...prev.filter((p) => p.userId !== e.userId), e.ping]
              : prev.filter((p) => p.userId !== e.userId)));
          },
          (t) => {
            if (!live) return;
            if (t === null) { setTrip(null); setTripPings([]); return; }
            setTrip(t);
            if (!currentTrip()) joinTrip(t, myId).catch(() => {});
          },
        );
        if (live) { const prevOff = off; off = () => { prevOff?.(); un3(); }; } else un3();
      } catch { /* trips degrade to a plain map */ }
    })();
    return () => { live = false; off?.(); };
  }, [circleId]);

  /**
   * A live trip OWNS the destination pin: every member's map shows the same
   * place, nobody types it. Ending the trip releases it.
   */
  useEffect(() => {
    if (trip) setDestination({ name: trip.destinationName, lat: trip.destination.lat, lng: trip.destination.lng });
    else {
      setDestination(null);
      // The trip is over — guidance started for it stops with it.
      if (navHere.current) { stopNavigation(); navHere.current = false; }
    }
  // Keyed on the trip's ID: a manual Meet Here destination (trip never set)
  // must not be clobbered by re-renders.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip?.id]);

  /** MY saved places, for the From-Home route. Device-local by doctrine —
   *  the coordinate never leaves this phone, so this route can only ever be
   *  drawn for MY OWN home, never another member's. */
  const [myPlaces, setMyPlaces] = useState<Geofence[]>([]);
  const [homeName, setHomeName] = useState<string | null>(null);
  useEffect(() => {
    if (!circleId) return;
    let live = true;
    (async () => {
      const [ps, ref] = await Promise.all([getPlaces(circleId), getDefaultRef(circleId)]);
      if (!live) return;
      setMyPlaces(ps);
      setHomeName(ref ?? ps[0]?.name ?? null);
    })();
    return () => { live = false; };
  }, [circleId]);
  const homePlace = homeName ? myPlaces.find((p) => p.name === homeName) ?? null : null;

  /**
   * Road route to ONE member, fetched on demand (spec §8/§42).
   *
   * Deliberately not fetched for everyone: ten members would be ten Valhalla
   * routings for lines nobody asked to see. The dashed connectors already
   * answer "who is where and how far"; this answers "how do I actually get to
   * THIS one", and only when asked.
   *
   * WITH A DESTINATION SET the same tap answers the trip's question instead:
   * THAT member's own road to the destination ("individual route path"), not
   * my road to them.
   */
  const [routeTo, setRouteTo] = useState<string | null>(null);
  /**
   * The member whose sheet is open. Tapping a marker used to only centre the
   * camera; every action lived as a 12px link on a roster row far below.
   * Independent of focusId on purpose: closing the sheet must not un-centre
   * the map the user just tapped on.
   */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  /** What the navigation dock calls the place we are going. A member route
   *  has no `destination` object, so the name has to travel separately. */
  const [navTargetName, setNavTargetName] = useState<string | null>(null);
  const [routeShape, setRouteShape] = useState<{ lat: number; lng: number }[] | null>(null);
  /** The tapped route's maneuvers — they feed the member turn indicator. */
  const [routeMans, setRouteMans] = useState<Maneuver[] | null>(null);
  const [routeInfo, setRouteInfo] = useState<string | null>(null);
  const [routeBusy, setRouteBusy] = useState(false);

  useEffect(() => {
    const target = routeTo ? presences[routeTo] : undefined;
    const from = destination ? target?.pos : mine?.pos;
    const to = destination ? { lat: destination.lat, lng: destination.lng } : target?.pos;
    if (!routeTo || !target || !from || !to) { setRouteShape(null); setRouteMans(null); setRouteInfo(null); return; }
    let live = true;
    setRouteBusy(true);
    fetchRoute(from, to, 'auto')
      .then((r) => {
        if (!live) return;
        setRouteShape(r.shape);
        setRouteMans(r.maneuvers);
        // Road figures, explicitly labelled as such — never mixed with the
        // straight-line numbers on the connectors (§8).
        setRouteInfo(formatRoute(r.lengthM, r.timeS));
      })
      .catch(() => {
        if (!live) return;
        setRouteShape(null);
        setRouteMans(null);
        setRouteInfo('Route unavailable');
      })
      .finally(() => { if (live) setRouteBusy(false); });
    return () => { live = false; };
  // Keyed on the target's COORDINATES: re-route when they actually move, not on
  // every ping that repeats the same position.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeTo, mine?.pos.lat, mine?.pos.lng, presences[routeTo ?? '']?.pos.lat, presences[routeTo ?? '']?.pos.lng, destination?.lat, destination?.lng]);

  /**
   * MY OWN road to the destination, drawn automatically the moment one exists
   * (a trip landing, or a Meet Here pick). This is the "your route" half of a
   * family trip — no tap required. Also feeds the trip's deviation check, so
   * "left the route" is measured against the road actually drawn.
   */
  const [destRoute, setDestRoute] = useState<{ lat: number; lng: number }[] | null>(null);
  const [destInfo, setDestInfo] = useState<string | null>(null);
  /** Road seconds to the destination — what "leave now" is computed from.
   *  Kept separate from destInfo, which is a formatted human string. */
  const [destSecs, setDestSecs] = useState<number | null>(null);
  useEffect(() => {
    if (!destination || !mine) { setDestRoute(null); setDestInfo(null); setDestSecs(null); return; }
    let live = true;
    fetchRoute(mine.pos, { lat: destination.lat, lng: destination.lng }, 'auto')
      .then((r) => {
        if (!live) return;
        setDestRoute(r.shape);
        setDestInfo(formatRoute(r.lengthM, r.timeS));
        setDestSecs(r.timeS);
        const t = currentTrip();
        // Never override a leader's shared route — that is the road the group
        // agreed on; mine only stands in when nobody is leading.
        if (t && !t.leaderId) setTripRoute(r.shape);
      })
      .catch(() => { if (live) { setDestRoute(null); setDestInfo(null); setDestSecs(null); } });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination?.lat, destination?.lng, mine?.pos.lat, mine?.pos.lng]);

  /** From-Home: the road from MY reference place to where I am now. */
  const [showHomeRoute, setShowHomeRoute] = useState(false);
  const [homeRoute, setHomeRoute] = useState<{ lat: number; lng: number }[] | null>(null);
  const [homeInfo, setHomeInfo] = useState<string | null>(null);
  useEffect(() => {
    if (!showHomeRoute || !homePlace || !mine) { setHomeRoute(null); setHomeInfo(null); return; }
    let live = true;
    fetchRoute(homePlace.center, mine.pos, 'auto')
      .then((r) => { if (live) { setHomeRoute(r.shape); setHomeInfo(formatRoute(r.lengthM, r.timeS)); } })
      .catch(() => { if (live) { setHomeRoute(null); setHomeInfo('Route unavailable'); } });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHomeRoute, homePlace?.center.lat, homePlace?.center.lng, mine?.pos.lat, mine?.pos.lng]);

  /**
   * ALWAYS-ON member road routes (owner, 2026-08-21): the road from me to EVERY
   * member, with "2.4 km · 6 min" on the line — visible without any tap.
   *
   * One Valhalla call per member, but re-fetched only when either endpoint has
   * moved ≥250 m — a stationary family costs one call each and then nothing.
   * A failed routing falls back to the straight line, drawn dashed and
   * labelled with the straight-line figure so a fallback never reads as road.
   */
  const MR_MOVE_M = 250;
  const mrCache = useRef<Record<string, {
    from: { lat: number; lng: number }; to: { lat: number; lng: number };
    pts: { lat: number; lng: number }[]; label: string; road: boolean;
  }>>({});
  const mrInflight = useRef<Set<string>>(new Set());
  const [mrVersion, setMrVersion] = useState(0);
  useEffect(() => {
    if (!showLinks || !mine) return;
    for (const [uid, p] of Object.entries(presences)) {
      if (uid === me || freshnessOf(p.ts, now) === 'unavailable') continue;
      const c = mrCache.current[uid];
      if (c && haversine(c.from, mine.pos) < MR_MOVE_M && haversine(c.to, p.pos) < MR_MOVE_M) continue;
      if (mrInflight.current.has(uid)) continue;
      mrInflight.current.add(uid);
      const from = mine.pos, to = p.pos;
      fetchRoute(from, to, 'auto')
        .then((r) => { mrCache.current[uid] = { from, to, pts: r.shape, label: formatRoute(r.lengthM, r.timeS), road: true }; })
        .catch(() => { mrCache.current[uid] = { from, to, pts: [from, to], label: formatMetres(haversine(from, to)), road: false }; })
        .finally(() => { mrInflight.current.delete(uid); setMrVersion((v) => v + 1); });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presences, mine?.pos.lat, mine?.pos.lng, showLinks, me, now]);

  const memberRoutes = useMemo(() => {
    if (!showLinks || !mine) return [];
    return Object.entries(mrCache.current)
      .filter(([uid]) => uid !== me && presences[uid] && freshnessOf(presences[uid].ts, now) !== 'unavailable')
      .map(([uid, c]) => ({ id: uid, pts: c.pts, label: c.label, road: c.road }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mrVersion, showLinks, me, presences, now, mine]);

  /**
   * NEXT TURN of the member whose route is on screen — the watcher's
   * indicator: their route, their live pings, their next left/right. The cue
   * also FIRES (sound per nav settings' mode, vibration per profile) once per
   * maneuver as they close within the trigger distance.
   */
  useEffect(() => { loadNavSettings().catch(() => {}); }, []);
  const routedPos = routeTo ? presences[routeTo]?.pos : null;
  const memberTurn = useMemo(() => {
    if (!routeTo || !routeShape || !routeMans || !routedPos) return null;
    return nextTurnAlong(routeShape, routeMans, routedPos);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeTo, routeShape, routeMans, routedPos?.lat, routedPos?.lng]);
  const TURN_FIRE_M = 250;
  const firedTurn = useRef<string | null>(null);
  useEffect(() => {
    if (!memberTurn || !routeTo) return;
    const key = `${routeTo}:${memberTurn.index}`;
    if (memberTurn.distM <= TURN_FIRE_M && firedTurn.current !== key) {
      firedTurn.current = key;
      const s = getNavSettings();
      playHaptic(memberTurn.event, s.profile, { mode: s.mode });
    }
  }, [memberTurn, routeTo]);

  /**
   * MY OWN turn-by-turn to the destination — the REAL navigation loop
   * (navigationService): GPS, adaptive haptic timeline, voice per the user's
   * nav settings, missed-turn reroute — rendered here through the same
   * NavBanner the Navigate app uses. Left running on navigate-away on
   * purpose; STOP (or the trip ending) ends it.
   */
  const navBanner = useNavBanner();
  /**
   * AUTO-FOLLOW. On by default while guiding; the map reports the user's own
   * pan/rotate/pinch (FamilyMap onUserMove) and we step out of the way rather
   * than fighting the gesture. The Follow control puts it back — an explicit
   * way in, instead of waiting out the map's silent 10 s timeout.
   */
  const [following, setFollowing] = useState(true);
  /** A reroute that came back empty, so the UI can offer a manual retry
   *  instead of looping. Cleared the moment a fresh route arrives. */
  const [rerouteFailed, setRerouteFailed] = useState(false);
  /**
   * The camera band from the previous frame. Passing it back into
   * cameraForManeuver is what applies the hysteresis — without it the zoom
   * oscillates every time the distance wobbles across a band edge.
   */
  const camRef = useRef<CameraPlan | null>(null);
  const camera = useMemo(() => {
    if (!navBanner.active) { camRef.current = null; return null; }
    const next = cameraForManeuver(navBanner.distanceToManeuver, navBanner.remainingM, camRef.current);
    camRef.current = next;
    return next;
  }, [navBanner.active, navBanner.distanceToManeuver, navBanner.remainingM]);
  // A new route (or the session ending) clears a stale failure.
  useEffect(() => { if (!navBanner.rerouting) setRerouteFailed(false); }, [navBanner.rerouting]);
  // Re-arm follow whenever a session starts, so a previous journey's manual
  // pan does not leave the next one un-followed.
  useEffect(() => { if (navBanner.active) setFollowing(true); }, [navBanner.active]);
  /**
   * PUT THE CAMERA BACK WHEN THE JOURNEY ENDS.
   *
   * Found on the Honor: navigation leaves the map in the pitched, heading-up
   * chase camera, and ending the session used to leave it there — the map
   * stayed rotated with no journey to justify it, which reads as broken. The
   * cameraMode prop is declarative, so simply dropping to `undefined` changes
   * nothing (FamilyMap keeps its last mode); it has to be told 'north' once.
   *
   * One-shot, and only after a session we actually ran: passing 'north'
   * permanently would override the camera the user chose themselves on a map
   * they never navigated from.
   */
  const wasNavigating = useRef(false);
  const [resetCam, setResetCam] = useState(false);
  useEffect(() => {
    if (wasNavigating.current && !navBanner.active) {
      setResetCam(true);
      const t = setTimeout(() => setResetCam(false), 900);
      wasNavigating.current = false;
      return () => clearTimeout(t);
    }
    wasNavigating.current = navBanner.active;
  }, [navBanner.active]);
  /** Start real turn-by-turn to any point. `startNav` below is the Meet-Here
   *  destination form of this and is unchanged; member routes use it directly
   *  with the member's CURRENT position, which is the honest target — a person
   *  is not a fixed point, and a reroute picks up their newer fix. */
  const startNavTo = async (name: string, lat: number, lng: number) => {
    try {
      const s = await loadNavSettings();
      await startNavigation({
        to: { lat, lng },
        profile: s.profile, mode: s.mode, timing: s.timing,
        costing: s.costing, custom: s.custom, routeOpts: s.routeOpts,
      });
      navHere.current = true;
      setNavTargetName(name);
    } catch (e: any) { Alert.alert('Navigation', e?.message ?? 'Could not start navigation.'); }
  };
  const startNav = async () => {
    if (!destination) return;
    await startNavTo(destination.name, destination.lat, destination.lng);
  };
  const stopNav = () => { stopNavigation(); navHere.current = false; setNavTargetName(null); };
  /** Chat with a member — the same createDirectChat path family-member.tsx uses. */
  const openChat = async (userId: string) => {
    if (chatBusy) return;
    setChatBusy(true);
    try {
      const chat = await createDirectChat({ userId });
      router.push({ pathname: '/chat' as any, params: { id: chat.id } });
    } catch (e: any) { Alert.alert('Message', e?.message ?? 'Could not open a direct chat.'); }
    finally { setChatBusy(false); }
  };

  /**
   * LEAVE NOW (§ Life360 parity). The trip knows where; the road route knows
   * how long. Given an arrival time, this is the only number a family
   * actually plans around: when to walk out of the door.
   *
   * The alarm is AlarmManager-backed (leaveNowAlarm), so it survives Doze and
   * the app being closed — a reminder that only fires while the screen is on
   * is not a reminder.
   */
  const [arriveBy, setArriveBy] = useState<number | null>(null);
  const leave = useMemo(() => leavePlan(arriveBy, destSecs, now), [arriveBy, destSecs, now]);
  const destName = destination?.name;
  const destLat = destination?.lat;
  const destLng = destination?.lng;
  useEffect(() => {
    if (!circleId) return;
    if (!destName || arriveBy == null || destSecs == null) { cancelLeaveNow(circleId); return; }
    armLeaveNow(circleId, destName, arriveBy, destSecs).catch(() => {});
    // Re-armed whenever the ROUTE or the deadline changes: a re-route that
    // adds twenty minutes must move the alarm, not leave it on the old road.
    // destLat/destLng are dependencies on purpose — two different places can
    // share a name, and the alarm must follow the COORDINATE, not the label.
  }, [circleId, destName, destLat, destLng, arriveBy, destSecs]);
  // The destination going away (trip ended, pin cleared) takes the alarm with it.
  useEffect(() => { if (!destination) setArriveBy(null); }, [destination]);

  /** Offer round arrival times: +30m, +1h, +2h from now. One tap, no picker —
   *  a family setting off decides in seconds, not in a date dialog. */
  const arriveChoices = useMemo(() => {
    const base = Math.ceil(now / (15 * 60_000)) * (15 * 60_000);   // next quarter hour
    return [30, 60, 120].map((m) => base + m * 60_000);
  }, [now]);

  /**
   * OVERLAY SLOTS. Every floating bar used to carry a hardcoded offset, and
   * three pairs collided the moment their conditions were both true: the
   * follow banner sat exactly on the search bar, the Routes chip sat under
   * the full-width route bar, and the From-Home chip sat on the turn strip.
   * Offsets are computed from what is actually on screen instead, so bars
   * stack in a fixed reading order and never share a pixel.
   */
  // Compact by intent: every pixel of chrome is a pixel of map the family
  // cannot see. Bars are sized to their content and stacked at that pitch.
  const TOP_0 = 8, TOP_PITCH = 46;
  // BOT_0 carries the gesture inset. NavigationLayer already applies whatever
  // it is handed (components/family/NavigationLayer.tsx:92), but the literal 10
  // fed into it had none, so the dock, the follow button and the arrival card
  // all sat inside the 48dp swipe strip on a gesture-nav device — edgeToEdge is
  // on at every API level. One value, all three consumers (2026-09-17).
  const BOT_0 = 10 + insets.bottom, BOT_PITCH = 44;
  const showTrip = !!trip && !meetOpen;
  const showFollowBar = !!followId && !meetOpen;
  const showLeave = !!destination && !meetOpen && destSecs != null;
  const showSearch = !meetOpen;
  const slots = useMemo(() => {
    let i = 0;
    const searchTop = showSearch ? TOP_0 + TOP_PITCH * i++ : 0;
    const tripTop = showTrip ? TOP_0 + TOP_PITCH * i++ : 0;
    const followTop = showFollowBar ? TOP_0 + TOP_PITCH * i++ : 0;
    const leaveTop = showLeave ? TOP_0 + TOP_PITCH * i++ : 0;
    return { searchTop, tripTop, followTop, leaveTop };
  }, [showSearch, showTrip, showFollowBar, showLeave]);

  const anyRouteBar = !!(routeShape || homeRoute || destRoute);
  const showTurnBar = !!(memberTurn && routeShape);
  // Bottom bars claim the floor first; the chips and the map's own controls
  // then start above whatever is there.
  const routeBarBottom = BOT_0;
  const turnBarBottom = BOT_0 + (anyRouteBar ? BOT_PITCH : 0);
  const chipsBottom = BOT_0 + (anyRouteBar ? BOT_PITCH : 0) + (showTurnBar ? BOT_PITCH : 0);

  const nameOf = useMemo(() => new Map(members.map((m) => [m.id, m.name])), [members]);
  const markers: FamilyMarker[] = useMemo(() => Object.entries(presences)
    .filter(([, p]) => freshnessOf(p.ts, now) !== 'unavailable')
    .map(([uid, p]) => ({
      id: uid,
      name: uid === me ? 'You' : (nameOf.get(uid) || 'Member'),
      lat: p.pos.lat, lng: p.pos.lng, battery: p.battery,
      self: uid === me,
      stale: freshnessOf(p.ts, now) !== 'live' || !!p.sharingOff,
      // Drawn on this member's connector. Straight-line, computed here from
      // positions already decrypted — the map itself measures nothing.
      label: mine && uid !== me ? formatMetres(haversine(mine.pos, p.pos)) : '',
    })), [presences, nameOf, me, now, mine]);

  /**
   * The same never-frozen watchdog the hub runs (§59/§60). This screen is the
   * one most likely to be left open and looked at, so a silently dead socket
   * here is the most visible version of the bug.
   *
   * Reconciling re-fetches the snapshot and folds it through mergePresence —
   * only changed members move, the MapView is never remounted, and the camera
   * (including an active follow) is untouched.
   */
  useEffect(() => {
    if (!circleId || !me) return;
    const myId = me;
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
  }, [circleId, me]);

  /**
   * The roster as Meet Here needs it — ONE stable order, because the routing
   * matrix maps its results back by index into exactly this array. Self is
   * included: you are one of the people who has to get to the meeting.
   */
  const meetMembers: MemberInput[] = useMemo(() => {
    const rows: MemberInput[] = members.map((m) => {
      const p = presences[m.id];
      const usable = !!p && !p.sharingOff && freshnessOf(p.ts, now) !== 'unavailable';
      return {
        id: m.id, name: m.id === me ? 'You' : m.name,
        pos: usable ? p.pos : null, ts: p?.ts, self: m.id === me, unavailable: !usable,
      };
    });
    // This screen never starts a watcher, so my own position comes from the OS
    // cache rather than presences — without this I would be listed as
    // "location unavailable" on my own family's meeting screen.
    if (mine && me) {
      const i = rows.findIndex((r) => r.id === me);
      if (i >= 0) rows[i] = { ...rows[i], pos: mine.pos, ts: mine.ts, unavailable: false };
      else rows.unshift({ id: me, name: 'You', pos: mine.pos, ts: mine.ts, self: true });
    }
    return rows;
  }, [members, presences, me, mine, now]);

  /** Am I an active participant of the shown trip (sharing my ETA)? */
  const joined = !!trip && currentTrip()?.id === trip.id;
  const tripEta = useMemo(
    () => (trip ? lastEta(foldParticipants(tripPings, {}, now)) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trip?.id, tripPings, now],
  );

  const beginTrip = async (d: MeetDestination) => {
    if (!me) return;
    try {
      const t = await startTrip(circleId, me, { lat: d.lat, lng: d.lng }, d.name);
      setTrip(t);
      setMeetOpen(false);
    } catch (e: any) { Alert.alert('Family trip', e?.message ?? 'Could not start the trip.'); }
  };

  const tripAction = async () => {
    if (!trip || !me) return;
    if (trip.startedBy === me) {
      Alert.alert('End the trip?', 'The trip is over for everyone in the circle.', [
        { text: 'Cancel', style: 'cancel' },
        // Clearing local state only when the server agreed: a silent throw
        // here left the trip on screen and the tap looking like a no-op.
        { text: 'End trip', style: 'destructive', onPress: async () => {
          try { await endTrip(); setTrip(null); setTripPings([]); }
          catch (e: any) { Alert.alert('Family trip', e?.message ?? 'Could not end the trip.'); }
        } },
      ]);
    } else if (joined) {
      await leaveTrip();
      setTrip({ ...trip });   // re-render: the button flips to JOIN
    } else {
      await joinTrip(trip, me).catch(() => {});
      setTrip({ ...trip });
    }
  };

  if (!circleId) {
    return (
      <View style={[st.center, { backgroundColor: G.bgMid }]}>
        <Stack.Screen options={{ headerShown: true, title: 'Live map' }} />
        <Text style={{ color: colors.textDim }}>Open this map from a space.</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: G.bgMid }}>
      <Stack.Screen options={{
        headerShown: true,
        title: params.circleName ? `${params.circleName} · Live map` : 'Live map',
        headerStyle: { backgroundColor: G.bgTop }, headerTintColor: colors.text,
        headerShadowVisible: false,
      }} />
      {/* The turn-by-turn strip used to be <NavBanner /> here, above the map.
          NavigationLayer replaces it INSIDE the map below: same engine, same
          numbers, but floating over the map instead of stealing a band of it,
          plus the follow / off-route / arrival states the strip never had.
          NavBanner itself is untouched and still serves app/navigate.tsx. */}
      <View style={{ flex: 1 }}>
        <FamilyMap
          members={markers} focusId={focusId} followId={followId}
          // Auto-zoom while traveling: the follow camera widens with the
          // followed member's live speed (highway = wide, parked = close).
          followZoom={followId ? zoomForSpeed(presences[followId]?.speed) : null}
          destination={destination}
          // ROAD ROUTES to every member are the default picture now; the
          // dashed straight-line connectors only stand in until the first
          // routes arrive (memberRoutes empty), and per member on a routing
          // failure (road:false entries, drawn dashed).
          linkFrom={showLinks && !routeShape && !homeRoute && !memberRoutes.length && mine ? mine.pos : null}
          memberRoutes={memberRoutes}
          // One highlighted-route channel, by priority: an explicitly
          // requested member route beats the From-Home route beats my
          // automatic route to the destination.
          route={routeShape ?? homeRoute ?? destRoute}
          // Lift the map's own camera/fit controls above whatever bars are
          // currently occupying the bottom of the screen.
          controlsBottom={chipsBottom}
          onSelect={(id) => { setFocusId(id); if (id !== me) setSelectedId(id); }} style={{ flex: 1 }}
          // Stepping out of the way of a real gesture (spec: never fight the user).
          onUserMove={() => setFollowing(false)}
          // Only take the camera while actually guiding AND still following;
          // outside navigation the map keeps whatever camera the user chose.
          cameraMode={navBanner.active && following ? 'follow' : (resetCam ? 'north' : undefined)}
        />

        {/* Premium navigation chrome — floats over the map, never over the
            middle of it. Driven entirely by the existing navigationService
            session; it starts and stops with that session and renders nothing
            when one is not running, so every non-navigating behaviour on this
            screen is exactly as it was. */}
        {/* SELECTED MEMBER SHEET (spec section 2). The roster's Route/Follow
            links still exist and still work; this is the same three actions at
            the point of selection. Hidden while navigating — the dock owns the
            bottom of the screen then — and while Meet Here is open. */}
        {selectedId && !navBanner.active && !meetOpen && (() => {
          const m = members.find((x) => x.id === selectedId);
          if (!m) return null;
          const p = presences[m.id];
          const f = freshnessOf(p?.ts, now);
          const liveNow = f === 'live' && !p?.sharingOff;
          const locatable = !!p && !p.sharingOff && f !== 'unavailable';
          const fromMe = p && mine && f !== 'unavailable' ? haversine(mine.pos, p.pos) : null;
          const routed = routeTo === m.id && !!routeShape;
          const distanceLine = routed && routeInfo
            ? `${routeInfo} by road`
            : fromMe != null ? `${formatMetres(fromMe)} from You` : null;
          return (
            <SelectedMemberSheet
              name={m.name}
              distanceLine={distanceLine}
              statusLine={freshLabel(f, p?.ts, now, p?.sharingOff)}
              live={liveNow}
              locatable={locatable}
              routed={routeTo === m.id}
              routeBusy={routeBusy && routeTo === m.id}
              following={followId === m.id}
              chatBusy={chatBusy}
              onRoute={() => { setRouteTo(routeTo === m.id ? null : m.id); setFocusId(m.id); }}
              onFollow={() => { setFollowId(followId === m.id ? null : m.id); setFocusId(m.id); }}
              onChat={() => openChat(m.id)}
              onNavigate={routed && !destination && p
                ? () => { setSelectedId(null); startNavTo(m.name, p.pos.lat, p.pos.lng); }
                : undefined}
              onClose={() => setSelectedId(null)}
              bottomInset={chipsBottom}
            />
          );
        })()}

        <NavigationLayer
          active={navBanner.active}
          event={navBanner.event}
          instruction={navBanner.instruction}
          roadName={navBanner.roadName}
          distanceToManeuverM={navBanner.distanceToManeuver}
          remainingM={navBanner.remainingM}
          etaSeconds={Math.max(0, (navBanner.etaEpochMs - Date.now()) / 1000)}
          destinationName={navTargetName ?? destination?.name ?? 'Destination'}
          verdict={navBanner.verdict}
          rerouting={navBanner.rerouting}
          rerouteFailed={rerouteFailed}
          arrived={navBanner.arrived}
          camera={camera}
          following={following}
          onFollow={() => setFollowing(true)}
          onReroute={() => {
            setRerouteFailed(false);
            forceReroute().catch(() => setRerouteFailed(true));
          }}
          onStop={stopNav}
          onDone={stopNav}
          bottomInset={chipsBottom}
        />

        {/* SEARCH BAR, not a button. Meet Here is a search — it belongs at the
            top of the map looking like one, the way every maps app puts it. */}
        {!meetOpen && (
          <TouchableOpacity
            onPress={() => setMeetOpen(true)}
            accessibilityRole="search"
            accessibilityLabel="Search a place for the family to meet"
            style={[st.searchBar, { top: slots.searchTop, backgroundColor: G.sheet, borderColor: G.edge }]}
          >
            <Ionicons name="search" size={17} color={colors.textDim} />
            <Text style={{ color: destination ? colors.text : colors.textDim, fontSize: 14, flex: 1 }} numberOfLines={1}>
              {destination ? destination.name : 'Search a place to meet'}
            </Text>
            {/* During a trip the destination belongs to the trip — it is ended
                from the trip bar, never silently un-pinned here. */}
            {destination && !trip
              ? <Ionicons name="close-circle" size={17} color={colors.textDim} onPress={() => setDestination(null)} />
              : <Ionicons name="people" size={16} color={colors.primary} />}
          </TouchableOpacity>
        )}

        {/* SAVED PLACES — one tap to a destination, instead of typing a name
            the phone already knows (spec §11).
            ONLY REAL PLACES. There are no fixed Home / School / Office chips:
            a chip for a place nobody saved is a button that cannot work, and
            these coordinates are device-local by doctrine (lib/family/store),
            so this row can only ever offer MY OWN places — never another
            member's, whose coordinates this device does not have and must not
            display. Hidden entirely while navigating: the destination is
            settled by then and the map belongs to the guidance. */}
        {!meetOpen && !trip && !navBanner.active && myPlaces.length > 0 && (
          <View style={[st.placeRow, { top: slots.searchTop + 52 }]}>
            {myPlaces.slice(0, 4).map((pl) => {
              const on = destination?.name === pl.name;
              return (
                <TouchableOpacity
                  key={pl.id}
                  onPress={() => setDestination(on
                    ? null
                    : { name: pl.name, lat: pl.center.lat, lng: pl.center.lng })}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={on ? `Clear ${pl.name} as the destination` : `Route to ${pl.name}`}
                  hitSlop={{ top: 8, bottom: 8 }}
                  style={[st.placeChip, {
                    backgroundColor: G.sheet,
                    borderColor: on ? colors.primary : G.chipEdge,
                    borderWidth: on ? 1.5 : 1,
                  }]}
                >
                  <Ionicons
                    name={on ? 'location' : 'location-outline'}
                    size={13}
                    color={on ? colors.primary : colors.textDim}
                  />
                  <Text
                    style={{
                      color: on ? G.accentText : colors.textDim,
                      fontSize: 12.5, fontWeight: on ? '800' : '600',
                    }}
                    numberOfLines={1}
                  >
                    {pl.name}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {/* FAMILY TRIP BAR: whose trip, where to, when everyone is in — and
            the way out of it. */}
        {trip && !meetOpen && (
          <View style={[st.tripBar, { top: slots.tripTop, backgroundColor: G.sheet, borderColor: colors.primary }]}>
            <Ionicons name="car" size={16} color={colors.primary} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: colors.text, fontWeight: '800', fontSize: 13 }} numberOfLines={1}>
                Trip to {trip.destinationName}
              </Text>
              <Text style={{ color: colors.textDim, fontSize: 11 }} numberOfLines={1}>
                started by {trip.startedBy === me ? 'you' : (nameOf.get(trip.startedBy) || 'a member')}
                {tripEta != null ? ` · all in by ~${minutesUntil(tripEta, now)} min` : ''}
              </Text>
            </View>
            <Text onPress={tripAction} style={{ color: trip.startedBy === me || joined ? G.dangerText : G.accentText, fontWeight: '800', fontSize: 12 }}>
              {trip.startedBy === me ? 'END' : joined ? 'LEAVE' : 'JOIN'}
            </Text>
          </View>
        )}

        {/* LEAVE NOW. Only offered once a road duration exists — without one
            there is no honest leave time, and this refuses to invent one
            (leaveNow.leavePlan returns null and nothing renders). */}
        {!!destination && !meetOpen && destSecs != null && (
          <View style={[st.leaveBar, { top: slots.leaveTop, backgroundColor: G.sheet, borderColor: leave?.warn ? colors.danger : G.edge }]}>
            <Ionicons name="alarm-outline" size={15} color={leave?.warn ? colors.danger : colors.primary} />
            {leave ? (
              <>
                <Text style={{ color: colors.text, fontWeight: '700', fontSize: 11.5, flex: 1 }} numberOfLines={1}>
                  {leave.late ? 'Running late' : `Leave ${formatLeaveIn(leave.inMs)}`}
                  <Text style={{ color: colors.textDim, fontWeight: '400' }}>
                    {'  ·  arrive '}{new Date(arriveBy!).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  </Text>
                </Text>
                <Text onPress={() => setArriveBy(null)}
                  style={{ color: G.accentText, fontWeight: '800', fontSize: 11 }}>CLEAR</Text>
              </>
            ) : (
              <>
                <Text style={{ color: colors.textDim, fontSize: 11.5 }}>Arrive by</Text>
                {arriveChoices.map((t) => (
                  <Text
                    key={t}
                    onPress={() => setArriveBy(t)}
                    accessibilityRole="button"
                    style={{ color: G.accentText, fontWeight: '800', fontSize: 11.5, paddingHorizontal: 7 }}
                  >
                    {new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  </Text>
                ))}
              </>
            )}
          </View>
        )}

        {/* Connector toggle — ten dashed lines are the point on one screen and
            clutter on another, so it is the user's call, not a fixed choice. */}
        {!meetOpen && !routeShape && (
          <TouchableOpacity
            onPress={() => setShowLinks((v) => !v)}
            accessibilityRole="button"
            accessibilityState={{ selected: showLinks }}
            accessibilityLabel={showLinks ? 'Hide member routes' : 'Show road routes to every member'}
            style={[st.linkFab, { bottom: chipsBottom, backgroundColor: G.sheet, borderColor: showLinks ? colors.primary : G.edge }]}
          >
            <Ionicons name="git-network" size={17} color={showLinks ? colors.primary : colors.textDim} />
            <Text style={{ color: showLinks ? G.accentText : colors.textDim, fontSize: 10, fontWeight: '800' }}>
              Routes
            </Text>
          </TouchableOpacity>
        )}

        {/* FROM-HOME: the road from MY reference place to me, while traveling.
            My own place only — place coordinates never leave a device, so no
            such route can exist for another member (their published number
            "1.2 km from Home" already rides their pings). */}
        {!meetOpen && homePlace && !!mine && (
          <TouchableOpacity
            onPress={() => setShowHomeRoute((v) => !v)}
            accessibilityRole="button"
            accessibilityState={{ selected: showHomeRoute }}
            accessibilityLabel={showHomeRoute ? `Hide the route from ${homeName}` : `Show the road from ${homeName} to you`}
            style={[st.linkFab, { bottom: chipsBottom + 52, backgroundColor: G.sheet, borderColor: showHomeRoute ? colors.primary : G.edge }]}
          >
            <Ionicons name="home" size={16} color={showHomeRoute ? colors.primary : colors.textDim} />
            <Text style={{ color: showHomeRoute ? G.accentText : colors.textDim, fontSize: 10, fontWeight: '800' }} numberOfLines={1}>
              From {homeName}
            </Text>
          </TouchableOpacity>
        )}

        {/* NEXT TURN of the routed member — the watcher's indicator. Their
            route, their live pings; the buzz fires from the effect above. */}
        {memberTurn && routeShape && (
          <View style={[st.turnBar, { bottom: turnBarBottom, backgroundColor: G.sheet, borderColor: G.edge }]}>
            <Ionicons name={iconFor(memberTurn.event)} size={16} color={colors.primary} />
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 12, flex: 1 }} numberOfLines={1}>
              {nameOf.get(routeTo ?? '') || 'Member'} · {memberTurn.instruction || memberTurn.event}
            </Text>
            <Text style={{ color: G.accentText, fontWeight: '800', fontSize: 12, fontVariant: ['tabular-nums'] }}>
              {formatMetres(memberTurn.distM)}
            </Text>
          </View>
        )}

        {/* Active road route: says whose it is, what it costs BY ROAD, and how
            to get rid of it. Trip routes have no CLEAR — they end with the
            trip; instead they carry NAVIGATE, which starts real turn-by-turn
            guidance (banner + vibration + voice per nav settings). */}
        {(routeShape || homeRoute || destRoute) && (
          <View style={[st.routeBar, { bottom: routeBarBottom, backgroundColor: G.sheet, borderColor: colors.primary }]}>
            <Ionicons name="navigate-circle" size={16} color={colors.primary} />
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13, flex: 1 }} numberOfLines={1}>
              {routeShape
                ? `${nameOf.get(routeTo ?? '') || 'Member'}${destination ? ` → ${destination.name}` : ''}${routeInfo ? ` · ${routeInfo}` : ''}`
                : homeRoute
                  ? `${homeName} → You${homeInfo ? ` · ${homeInfo}` : ''}`
                  : `You → ${destination?.name ?? 'destination'}${destInfo ? ` · ${destInfo}` : ''}`}
            </Text>
            {routeShape ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                {/* Me -> member: this route can be DRIVEN, so offer it. A member ->
                    place route is THEIR road, not mine, and stays clear-only. */}
                {!destination && routeTo && presences[routeTo] && !navBanner.active && (
                  <Text
                    onPress={() => startNavTo(nameOf.get(routeTo) || 'Member', presences[routeTo].pos.lat, presences[routeTo].pos.lng)}
                    style={{ color: G.accentText, fontWeight: '800', fontSize: 12 }}>NAVIGATE</Text>
                )}
                {!destination && navBanner.active && (
                  <Text onPress={stopNav} style={{ color: G.dangerText, fontWeight: '800', fontSize: 12 }}>STOP NAV</Text>
                )}
                <Text onPress={() => { setRouteTo(null); setRouteShape(null); setRouteMans(null); }}
                  style={{ color: G.accentText, fontWeight: '800', fontSize: 12 }}>CLEAR</Text>
              </View>
            ) : homeRoute ? (
              <Text onPress={() => setShowHomeRoute(false)}
                style={{ color: G.accentText, fontWeight: '800', fontSize: 12 }}>CLEAR</Text>
            ) : navBanner.active ? (
              <Text onPress={stopNav}
                style={{ color: G.dangerText, fontWeight: '800', fontSize: 12 }}>STOP NAV</Text>
            ) : (
              <Text onPress={startNav}
                style={{ color: G.accentText, fontWeight: '800', fontSize: 12 }}>NAVIGATE</Text>
            )}
          </View>
        )}
        {/* Following banner (spec: "Following X" + "Stop following"). Only
            shown while a follow is active, and it is the way OUT — a map that
            keeps recentring with no visible reason feels broken. */}
        {followId && (
          <View style={[st.followBar, { top: slots.followTop, backgroundColor: G.sheet, borderColor: colors.primary }]}>
            <Ionicons name="navigate-circle" size={16} color={colors.primary} />
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13, flex: 1 }} numberOfLines={1}>
              Following {nameOf.get(followId) || 'member'}
            </Text>
            <Text
              onPress={() => setFollowId(null)}
              style={{ color: G.accentText, fontWeight: '800', fontSize: 12.5 }}
            >
              STOP
            </Text>
          </View>
        )}
      </View>
      {meetOpen ? (
        <MeetHereSheet
          members={meetMembers}
          myPos={mine?.pos ?? null}
          destination={destination}
          onDestination={setDestination}
          // Closing keeps the destination: the pin stays on the map and
          // reopening returns to the same meeting rather than a blank search.
          onClose={() => setMeetOpen(false)}
          // One tap turns the picked place into a circle-wide family trip.
          onStartTrip={beginTrip}
          tripActive={!!trip}
        />
      ) : (
      <View style={[st.sheet, { backgroundColor: G.sheet, borderColor: G.edge }]}>
        {!membersLoaded ? (
          <View style={st.center}><ActivityIndicator color={colors.primary} /></View>
        ) : (
          <ScrollView style={{ maxHeight: 148 }} contentContainerStyle={{ paddingBottom: 4 }}>
            {members.map((m) => {
              // My own row falls back to the OS's last known position. This
              // screen never starts a watcher (read-only by design), so
              // presences never contains me — and the row said "Location
              // unavailable" while the rows beneath it were computing "17 km
              // from You". Seen on the Honor: the screen contradicted itself in
              // adjacent lines.
              const p = presences[m.id] ?? (m.id === me ? mine ?? undefined : undefined);
              const f = freshnessOf(p?.ts, now);
              const liveNow = f === 'live' && !p?.sharingOff;
              const following = followId === m.id;
              // Straight-line from ME. Explicitly not a road distance — see
              // formatRoute in lib/family/distance for the other kind.
              const fromMe = p && mine && m.id !== me && f !== 'unavailable'
                ? haversine(mine.pos, p.pos) : null;
              // What they published about their own reference places. A member
              // who stopped sharing keeps their last-known dot but loses the
              // reference line: the number described where they were, not
              // where they are, and there is no fresh one to replace it.
              const refs = p?.sharingOff ? [] : (p?.refs ?? []);
              const showRef = refs.length > 0 && f !== 'unavailable' && f !== 'stale';
              // Following needs a position to follow. A member with no usable
              // fix (silent, or sharing off) cannot be followed — offering it
              // would promise something the map cannot do.
              const canFollow = !!p && !p.sharingOff && f !== 'unavailable' && m.id !== me;
              // This member's own trip report: THEIR device computed the ETA
              // and sealed it; we only render it. Never invented from distance.
              const tp = trip ? tripPings.find((x) => x.userId === m.id) : undefined;
              const tripLine = tp
                ? (tp.arrived ? `Arrived at ${trip!.destinationName}`
                  : tp.etaAt != null ? `${minutesUntil(tp.etaAt, now)} min to ${trip!.destinationName}` : null)
                : null;
              return (
                <View key={m.id} style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: G.line }}>
                  <View style={st.rowWrap}>
                    <Text
                      onPress={() => p && setFocusId(m.id)}
                      style={[st.row, { color: colors.text, flex: 1 }]}
                    >
                      <Text style={{ color: liveNow ? G.goodText : colors.textDim }}>● </Text>
                      {m.id === me ? 'You' : m.name}
                      <Text style={{ color: liveNow ? G.goodText : colors.textDim, fontSize: 12 }}>
                        {'   '}{freshLabel(f, p?.ts, now, p?.sharingOff)}
                        {fromMe != null ? `   ·   ${formatMetres(fromMe)} from You` : ''}
                        {tripLine ? `   ·   ${tripLine}` : ''}
                      </Text>
                    </Text>
                    {/* Road route — to THIS member normally; with a trip or
                        Meet Here destination set, THEIR road to it instead. */}
                    {canFollow && (!!mine || !!destination) && (
                      <Text
                        onPress={() => { setRouteTo(routeTo === m.id ? null : m.id); setFocusId(m.id); }}
                        style={{ color: routeTo === m.id ? G.accentText : colors.textDim, fontWeight: '700', fontSize: 12, paddingHorizontal: 6 }}
                      >
                        {routeBusy && routeTo === m.id ? '…' : routeTo === m.id ? 'ROUTED' : 'Route'}
                      </Text>
                    )}
                    {canFollow && (
                      <Text
                        onPress={() => { setFollowId(following ? null : m.id); setFocusId(m.id); }}
                        style={{ color: following ? G.accentText : colors.textDim, fontWeight: '700', fontSize: 12, paddingHorizontal: 6 }}
                      >
                        {following ? 'FOLLOWING' : 'Follow'}
                      </Text>
                    )}
                  </View>
                  {/* Distance from THEIR reference place, with the picker over
                      the references they chose to publish. Tapping a name only
                      re-reads a number they already sent — nothing is fetched,
                      and no coordinate for these places exists on this device. */}
                  {/* EVERY reference this member published, not one at a time.
                      The spec's example is the whole list per person —
                        Mother   Home 1.2 km · Shop 2.8 km · Other 4.5 km
                      — readable without opening another screen (§4). Their
                      chosen default leads and is marked; the rest follow.
                      Every value was computed on THEIR device, so we hold the
                      names and the metres and never the coordinates. */}
                  {showRef && (
                    <View style={st.refWrap}>
                      {refs.map((r, ri) => (
                        <View key={r.n} style={st.refLine}>
                          <Text
                            style={{ color: ri === 0 ? colors.text : colors.textDim, fontSize: 12, fontWeight: ri === 0 ? '700' : '400', flex: 1 }}
                            numberOfLines={1}
                          >
                            {r.n}
                          </Text>
                          <Text style={{ color: ri === 0 ? colors.text : colors.textDim, fontSize: 12, fontWeight: ri === 0 ? '700' : '400' }}>
                            {formatMetres(r.d)}
                          </Text>
                        </View>
                      ))}
                    </View>
                  )}
                </View>
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
      )}
    </View>
  );
}

const st = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  sheet: {
    borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1,
    paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8,
  },
  // Sits just under the search bar; horizontal, wraps rather than scrolls
  // because four chips always fit and a scroll view here would swallow the
  // map's own pan gesture at the top of the screen.
  placeRow: {
    position: 'absolute', left: 12, right: 12,
    flexDirection: 'row', flexWrap: 'wrap', gap: 8,
  },
  placeChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 12, minHeight: 32, borderRadius: 999,
  },
  searchBar: {
    position: 'absolute', left: 12, right: 12, top: 12, flexDirection: 'row', alignItems: 'center', gap: 9,
    borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, minHeight: 40, elevation: 4,
  },
  linkFab: {
    position: 'absolute', left: 12, bottom: 12, alignItems: 'center', justifyContent: 'center',
    gap: 1, borderWidth: 1, borderRadius: 12, paddingHorizontal: 8, minHeight: 38, elevation: 3,
  },
  routeBar: {
    position: 'absolute', left: 12, right: 12, bottom: 12, flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, minHeight: 32, elevation: 3,
  },
  rowWrap: { flexDirection: 'row', alignItems: 'center' },
  row: { paddingVertical: 7, fontSize: 14, fontWeight: '600' },
  refWrap: { paddingBottom: 6, paddingLeft: 12, gap: 1 },
  refLine: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  followBar: {
    position: 'absolute', left: 12, right: 12, top: 12,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1, borderRadius: 999, paddingHorizontal: 13, paddingVertical: 6,
  },
  // Sits UNDER the search bar — the trip is context, the search stays a search.
  tripBar: {
    position: 'absolute', left: 12, right: 12, top: 64,
    flexDirection: 'row', alignItems: 'center', gap: 9,
    borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 5, elevation: 4,
  },
  // Between the trip bar and the map: the leave-now countdown / arrive-by picker.
  leaveBar: {
    position: 'absolute', left: 12, right: 12, top: 122,
    flexDirection: 'row', alignItems: 'center', gap: 7,
    borderWidth: 1, borderRadius: 11, paddingHorizontal: 11, minHeight: 32, elevation: 3,
  },
  // Rides just above the route bar: the routed member's next left/right.
  turnBar: {
    position: 'absolute', left: 12, right: 12, bottom: 58,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1, borderRadius: 999, paddingHorizontal: 13, minHeight: 36, elevation: 3,
  },
});
