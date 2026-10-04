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
//
// WHAT REACHES THE ROUTING SERVER: one /nav/matrix call for the distance
// figures on the connectors, with every position rounded to ~110 m; a full
// route only for what the user asks for (a member's Route — both ends rounded
// to ~11 m — the From-Home route, a Meet Here / trip destination).

import { AppText as Text } from '../components/ui/Text';
import React, { useEffect, useMemo, useState } from 'react';
import { View, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../lib/theme';
import { useSpaceGlass } from '../components/spaces/SpaceGround';
import FamilyMap, { type FamilyMarker } from '../components/family/FamilyMap';
import MeetHereSheet, { type MeetDestination } from '../components/family/MeetHereSheet';
import { type MemberInput, formatMetres } from '../lib/family/distance';
import { circleMembers } from '../lib/family/circle';
import { subscribeCircle, type PresenceEvent } from '../lib/family/presence';
import { freshnessOf, zoomForSpeed } from '../lib/family/status';
import { subscribeSpaceLocations, fetchSpaceSnapshot } from '../lib/location/live';
import { foldPoint, foldSealed } from '../lib/family/presenceFold';
import { startRefreshController } from '../lib/family/refresh';
import { useVisibleNow } from '../lib/family/useVisibleTick';
import { type CircleMember, type MemberPresence } from '../lib/family/types';
import { getPlaces, getDefaultRef } from '../lib/family/store';
import { type Geofence } from '../lib/family/geofence';
import { mapSlots } from '../lib/family/mapSlots';
import { haversine } from '../lib/nav/geo';
import NavigationLayer from '../components/family/NavigationLayer';
import SelectedMemberSheet from '../components/family/SelectedMemberSheet';
import { useMapNavigation } from '../components/family/useMapNavigation';
import { useMemberRoute, useDestRoute, useHomeRoute, useRoadLabels, useMemberTurn } from '../components/family/useMapRoutes';
import { createDirectChat } from '../lib/chatService';
import {
  startTrip, joinTrip, endTrip, leaveTrip, subscribeTrip, currentTrip,
} from '../lib/groups/tripSession';
import { foldParticipants, lastEta, minutesUntil, type Trip, type TripPing } from '../lib/groups/trips';
import { leavePlan } from '../lib/family/leaveNow';
import { armLeaveNow, cancelLeaveNow } from '../lib/family/leaveNowAlarm';
import { getCurrentUserAsync } from './(constants)/authService';
import MapRosterSheet, { freshLabel } from '../components/family/MapRosterSheet';
import { BarAction, TripBar, LeaveBar, FollowBar, TurnBar, RouteBar } from '../components/family/MapBars';

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
  /** The roster request failed — shown with a Retry, not an endless spinner. */
  const [membersFailed, setMembersFailed] = useState(false);
  const [membersTry, setMembersTry] = useState(0);
  const [presences, setPresences] = useState<Record<string, MemberPresence>>({});
  const [focusId, setFocusId] = useState<string | null>(null);
  // Follow mode (spec: Follow member). Null = free map interaction. Seeded
  // from the route param so "Follow" on a member's detail screen lands here
  // already following them.
  const [followId, setFollowId] = useState<string | null>(params.followId ? String(params.followId) : null);
  /** Meet Here (§40). A mode over the same map, never a separate screen (§4). */
  const [meetOpen, setMeetOpen] = useState(false);
  const [destination, setDestination] = useState<MeetDestination | null>(null);
  // My own turn-by-turn, its follow camera and reroute state
  // (components/family/useMapNavigation).
  const {
    navBanner, camera, following, setFollowing, rerouteFailed, reroute, resetCam,
    navTargetName, startNavTo, startNav, stopNav, stopIfOurs,
  } = useMapNavigation(destination);
  /**
   * The circle's live FAMILY TRIP (shared destination). Discovered from the
   * same announcement channel the hub watches; while one is running it OWNS
   * the destination pin, so every member's map shows the same place without
   * anyone typing it.
   */
  const [trip, setTrip] = useState<Trip | null>(currentTrip());
  const [tripPings, setTripPings] = useState<TripPing[]>([]);
  /** Dashed distance lines to every member. On by default — it is the picture
   *  the screen exists to show — but dismissible when the map gets busy. */
  const [showLinks, setShowLinks] = useState(true);
  // Render tick so "LIVE" decays to "5 min ago" without a new ping arriving.
  //
  // Gated on visibility: backgrounded, this screen was re-rendering the map,
  // every member row and every distance every 30 s for pixels nobody could
  // see. `now` is re-taken on every tick, and the tick fires at once on
  // returning to the foreground, so freshness is recomputed immediately
  // instead of showing a timestamp frozen at the moment the user left.
  const now = useVisibleNow(30_000);

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

  // Roster, separately from the presence subscription so Retry re-asks for
  // the roster alone. Never asserts an empty roster on failure.
  useEffect(() => {
    if (!circleId) return;
    let live = true;
    setMembersFailed(false);
    circleMembers(circleId)
      .then((m) => { if (live) { setMembers(m); setMembersLoaded(true); } })
      .catch(() => { if (live) setMembersFailed(true); });
    return () => { live = false; };
  }, [circleId, membersTry]);

  useEffect(() => {
    if (!circleId) return;
    let live = true;
    let off: (() => void) | null = null;
    (async () => {
      const u = await getCurrentUserAsync().catch(() => null);
      if (!live) return;
      const myId = u ? String(u.id) : null;
      setMe(myId);
      if (!myId) return;
      try {
        const un = await subscribeCircle(circleId, myId, (e: PresenceEvent) => {
          if (!live) return;
          setPresences((prev) => foldSealed(prev, e));
        });
        if (live) off = un; else un();
      } catch { /* map degrades to "nobody live yet" */ }
      // Dedicated location service (no chat-E2EE dependency): snapshot + live.
      try {
        const un2 = await subscribeSpaceLocations(circleId, myId, (e) => {
          if (!live) return;
          setPresences((prev) => foldPoint(prev, e));
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
   *
   * Keyed on the trip's ID and destination: a manual Meet Here destination
   * (trip never set) must not be clobbered by re-renders, and a join/leave
   * (a copy of the same trip) changes none of these.
   */
  const tripId = trip?.id;
  const tripDestName = trip?.destinationName, tripDestLat = trip?.destination.lat, tripDestLng = trip?.destination.lng;
  useEffect(() => {
    if (tripId && tripDestName != null && tripDestLat != null && tripDestLng != null) {
      setDestination({ name: tripDestName, lat: tripDestLat, lng: tripDestLng });
    } else {
      setDestination(null);
      // The trip is over — guidance started for it stops with it.
      stopIfOurs();
    }
  }, [tripId, tripDestName, tripDestLat, tripDestLng, stopIfOurs]);

  /** MY saved places, for the From-Home route. Device-local by doctrine —
   *  the coordinate never leaves this phone, so this route can only ever be
   *  drawn for MY OWN home, never another member's. */
  const [myPlaces, setMyPlaces] = useState<Geofence[]>([]);
  const [homeName, setHomeName] = useState<string | null>(null);
  useEffect(() => {
    if (!circleId) return;
    let live = true;
    // A failed read leaves the place chips and From-Home off — nothing on
    // this map depends on them, and there is no list here to show as empty.
    Promise.all([getPlaces(circleId), getDefaultRef(circleId)])
      .then(([ps, ref]) => {
        if (!live) return;
        setMyPlaces(ps);
        setHomeName(ref ?? ps[0]?.name ?? null);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [circleId]);
  const homePlace = homeName ? myPlaces.find((p) => p.name === homeName) ?? null : null;

  /** The member whose road route is drawn (Route on their sheet or row). */
  const [routeTo, setRouteTo] = useState<string | null>(null);
  /**
   * The member whose sheet is open. Tapping a marker used to only centre the
   * camera; every action lived as a 12px link on a roster row far below.
   * Independent of focusId on purpose: closing the sheet must not un-centre
   * the map the user just tapped on.
   */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const { routeShape, routeMans, routeInfo, routeBusy, clearShape } = useMemberRoute({ routeTo, presences, mine, destination });
  const { destRoute, destInfo, destSecs } = useDestRoute({ destination, mine });
  /** From-Home: the road from MY reference place to where I am now. */
  const [showHomeRoute, setShowHomeRoute] = useState(false);
  const { homeRoute, homeInfo } = useHomeRoute({ show: showHomeRoute, homePlace, mine });
  // Road figures for the connectors: one coarse /nav/matrix call.
  const roadLabel = useRoadLabels({ enabled: showLinks, mine, presences, me, now });
  const memberTurn = useMemberTurn({ routeTo, routeShape, routeMans, presences });

  /** Chat with a member — the same createDirectChat path family-member.tsx uses. */
  const openChat = async (userId: string) => {
    if (chatBusy) return;
    setChatBusy(true);
    try {
      const chat = await createDirectChat({ userId });
      router.push({ pathname: '/chat', params: { id: chat.id } });
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

  // Bar positions: lib/family/mapSlots (stacking order and pitch there).
  // BOT_0 carries the gesture inset. NavigationLayer already applies whatever
  // it is handed (components/family/NavigationLayer.tsx:92), but the literal 10
  // fed into it had none, so the dock, the follow button and the arrival card
  // all sat inside the 48dp swipe strip on a gesture-nav device — edgeToEdge is
  // on at every API level. One value, all three consumers (2026-09-17).
  const BOT_0 = 10 + insets.bottom;
  const showTrip = !!trip && !meetOpen;
  const showFollowBar = !!followId && !meetOpen;
  const showLeave = !!destination && !meetOpen && destSecs != null;
  // While guiding, the top belongs to the maneuver capsule: the search bar
  // (and the place chips under it) used to render after NavigationLayer at the
  // same top offset and cover it.
  const showSearch = !meetOpen && !navBanner.active;
  const showPlaces = showSearch && !trip && myPlaces.length > 0;
  const slots = mapSlots({
    search: showSearch, places: showPlaces, trip: showTrip, follow: showFollowBar, leave: showLeave,
    bottom0: BOT_0, routeBar: !!(routeShape || homeRoute || destRoute), turnBar: !!(memberTurn && routeShape),
  });
  const { routeBarBottom, turnBarBottom, chipsBottom } = slots;

  const nameOf = useMemo(() => new Map(members.map((m) => [m.id, m.name])), [members]);
  const markers: FamilyMarker[] = useMemo(() => Object.entries(presences)
    .filter(([, p]) => freshnessOf(p.ts, now) !== 'unavailable')
    .map(([uid, p]) => ({
      id: uid,
      name: uid === me ? 'You' : (nameOf.get(uid) || 'Member'),
      lat: p.pos.lat, lng: p.pos.lng, battery: p.battery,
      self: uid === me,
      stale: freshnessOf(p.ts, now) !== 'live' || !!p.sharingOff,
      // Drawn on this member's connector: the road figure once the matrix has
      // answered (it says "by road"), the straight line until then — computed
      // here from positions already decrypted; the map itself measures nothing.
      label: mine && uid !== me ? (roadLabel[uid] ?? formatMetres(haversine(mine.pos, p.pos))) : '',
    })), [presences, nameOf, me, now, mine, roadLabel]);

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
          setPresences((prev) => foldPoint(prev, e));
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
    () => (tripId ? lastEta(foldParticipants(tripPings, {}, now)) : null),
    [tripId, tripPings, now],
  );

  const beginTrip = (d: MeetDestination) => {
    if (!me) return;
    // Confirmed: a trip changes EVERY member's map, not just this one.
    Alert.alert('Start a family trip?', `Everyone in the circle will see a trip to ${d.name} on their map.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Start trip', onPress: async () => {
        try {
          const t = await startTrip(circleId, me, { lat: d.lat, lng: d.lng }, d.name);
          setTrip(t);
          setMeetOpen(false);
        } catch (e: any) { Alert.alert('Family trip', e?.message ?? 'Could not start the trip.'); }
      } },
    ]);
  };

  const tripAction = async () => {
    if (!trip || !me) return;
    if (trip.startedBy === me) {
      Alert.alert('End the trip?', 'The trip is over for everyone in the circle.', [
        { text: 'Cancel', style: 'cancel' },
        // Clearing local state only when the server agreed: a silent throw
        // here left the trip on screen and the tap looking like a no-op.
        { text: 'End trip', style: 'destructive', onPress: async () => {
          try { await endTrip(trip); setTrip(null); setTripPings([]); }
          catch (e: any) { Alert.alert('Family trip', e?.message ?? 'Could not end the trip.'); }
        } },
      ]);
    } else if (joined) {
      try { await leaveTrip(); setTrip({ ...trip }); }   // re-render: the button flips to JOIN
      catch (e: any) { Alert.alert('Family trip', e?.message ?? 'Could not leave the trip.'); }
    } else {
      try { await joinTrip(trip, me); setTrip({ ...trip }); }
      catch (e: any) { Alert.alert('Family trip', e?.message ?? 'Could not join the trip.'); }
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
          // Dashed connectors to every member, labelled with the road figure
          // from the one matrix call (straight-line until it answers). A road
          // SHAPE is drawn only for the member whose Route was tapped.
          linkFrom={showLinks && !routeShape && !homeRoute && mine ? mine.pos : null}
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
          thenEvent={navBanner.thenEvent}
          thenRoadName={navBanner.thenRoadName}
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
          onReroute={reroute}
          onStop={stopNav}
          onDone={stopNav}
          bottomInset={chipsBottom}
          topInset={slots.barsBottom}
        />

        {/* SEARCH BAR, not a button. Meet Here is a search — it belongs at the
            top of the map looking like one, the way every maps app puts it. */}
        {showSearch && (
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
              ? <View style={{ width: 20 }} /> /* room for the clear button laid over this end */
              : <Ionicons name="people" size={16} color={colors.primary} />}
          </TouchableOpacity>
        )}
        {/* The clear control is its own labelled button, laid OVER the search
            bar's right end rather than nested in it: nested, a screen reader
            could never reach it. */}
        {showSearch && destination && !trip && (
          <TouchableOpacity
            onPress={() => setDestination(null)}
            accessibilityRole="button"
            accessibilityLabel={`Clear ${destination.name} as the destination`}
            hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
            style={[st.searchClear, { top: slots.searchTop }]}
          >
            <Ionicons name="close-circle" size={17} color={colors.textDim} />
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
        {showPlaces && (
          <View style={[st.placeRow, { top: slots.placesTop }]}>
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
          <TripBar
            top={slots.tripTop}
            destinationName={trip.destinationName}
            startedBy={trip.startedBy === me ? 'you' : (nameOf.get(trip.startedBy) || 'a member')}
            etaMin={tripEta != null ? minutesUntil(tripEta, now) : null}
            action={trip.startedBy === me ? 'END' : joined ? 'LEAVE' : 'JOIN'}
            actionA11y={trip.startedBy === me ? 'End the family trip' : joined ? 'Leave the family trip' : 'Join the family trip'}
            danger={trip.startedBy === me || joined}
            onAction={tripAction}
          />
        )}

        {/* LEAVE NOW. Only offered once a road duration exists — without one
            there is no honest leave time, and this refuses to invent one
            (leaveNow.leavePlan returns null and nothing renders). */}
        {!!destination && !meetOpen && destSecs != null && (
          <LeaveBar top={slots.leaveTop} leave={leave} arriveBy={arriveBy} choices={arriveChoices} onArriveBy={setArriveBy} />
        )}

        {/* Connector toggle — ten dashed lines are the point on one screen and
            clutter on another, so it is the user's call, not a fixed choice. */}
        {/* Both FABs step aside for the nav dock and the selected-member
            sheet, which occupy the same bottom-left corner. */}
        {!meetOpen && !routeShape && !navBanner.active && !selectedId && (
          <TouchableOpacity
            onPress={() => setShowLinks((v) => !v)}
            accessibilityRole="button"
            accessibilityState={{ selected: showLinks }}
            accessibilityLabel={showLinks ? 'Hide the distance lines' : 'Show a distance line to every member'}
            style={[st.linkFab, { bottom: chipsBottom, backgroundColor: G.sheet, borderColor: showLinks ? colors.primary : G.edge }]}
          >
            <Ionicons name="git-network" size={17} color={showLinks ? colors.primary : colors.textDim} />
            <Text style={{ color: showLinks ? G.accentText : colors.textDim, fontSize: 11, fontWeight: '800' }}>
              Lines
            </Text>
          </TouchableOpacity>
        )}

        {/* FROM-HOME: the road from MY reference place to me, while traveling.
            My own place only — place coordinates never leave a device, so no
            such route can exist for another member (their published number
            "1.2 km from Home" already rides their pings). */}
        {!meetOpen && homePlace && !!mine && !navBanner.active && !selectedId && (
          <TouchableOpacity
            onPress={() => setShowHomeRoute((v) => !v)}
            accessibilityRole="button"
            accessibilityState={{ selected: showHomeRoute }}
            accessibilityLabel={showHomeRoute ? `Hide the route from ${homeName}` : `Show the road from ${homeName} to you`}
            style={[st.linkFab, { bottom: chipsBottom + 52, backgroundColor: G.sheet, borderColor: showHomeRoute ? colors.primary : G.edge }]}
          >
            <Ionicons name="home" size={16} color={showHomeRoute ? colors.primary : colors.textDim} />
            <Text style={{ color: showHomeRoute ? G.accentText : colors.textDim, fontSize: 11, fontWeight: '800' }} numberOfLines={1}>
              From {homeName}
            </Text>
          </TouchableOpacity>
        )}

        {/* NEXT TURN of the routed member — the watcher's indicator. Their
            route, their live pings; the buzz fires from the effect above. */}
        {memberTurn && routeShape && (
          <TurnBar bottom={turnBarBottom} name={nameOf.get(routeTo ?? '') || 'Member'} turn={memberTurn} />
        )}

        {/* Active road route: says whose it is, what it costs BY ROAD, and how
            to get rid of it. Trip routes have no CLEAR — they end with the
            trip; instead they carry NAVIGATE, which starts real turn-by-turn
            guidance (banner + vibration + voice per nav settings). */}
        {(routeShape || homeRoute || destRoute) && (
          <RouteBar bottom={routeBarBottom} label={routeShape
            ? `${nameOf.get(routeTo ?? '') || 'Member'}${destination ? ` → ${destination.name}` : ''}${routeInfo ? ` · ${routeInfo}` : ''}`
            : homeRoute
              ? `${homeName} → You${homeInfo ? ` · ${homeInfo}` : ''}`
              : `You → ${destination?.name ?? 'destination'}${destInfo ? ` · ${destInfo}` : ''}`}>
            {routeShape ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                {/* Me -> member: this route can be DRIVEN, so offer it. A member ->
                    place route is THEIR road, not mine, and stays clear-only. */}
                {!destination && routeTo && presences[routeTo] && !navBanner.active && (
                  <BarAction
                    onPress={() => startNavTo(nameOf.get(routeTo) || 'Member', presences[routeTo].pos.lat, presences[routeTo].pos.lng)}
                    label="NAVIGATE" a11y={`Navigate to ${nameOf.get(routeTo) || 'member'}`}
                    style={{ color: G.accentText, fontWeight: '800', fontSize: 12 }} />
                )}
                {!destination && navBanner.active && (
                  <BarAction onPress={stopNav} label="STOP NAV" a11y="Stop navigation"
                    style={{ color: G.dangerText, fontWeight: '800', fontSize: 12 }} />
                )}
                <BarAction onPress={() => { setRouteTo(null); clearShape(); }}
                  label="CLEAR" a11y="Clear the route"
                  style={{ color: G.accentText, fontWeight: '800', fontSize: 12 }} />
              </View>
            ) : homeRoute ? (
              <BarAction onPress={() => setShowHomeRoute(false)} label="CLEAR" a11y="Clear the route"
                style={{ color: G.accentText, fontWeight: '800', fontSize: 12 }} />
            ) : navBanner.active ? (
              <BarAction onPress={stopNav} label="STOP NAV" a11y="Stop navigation"
                style={{ color: G.dangerText, fontWeight: '800', fontSize: 12 }} />
            ) : (
              <BarAction onPress={startNav} label="NAVIGATE" a11y={`Navigate to ${destination?.name ?? 'the destination'}`}
                style={{ color: G.accentText, fontWeight: '800', fontSize: 12 }} />
            )}
          </RouteBar>
        )}
        {/* Following banner (spec: "Following X" + "Stop following"). Only
            shown while a follow is active, and it is the way OUT — a map that
            keeps recentring with no visible reason feels broken. */}
        {/* Only where its slot exists: with Meet Here open no slot is
            allocated, and the bar used to render at top 0 over the header. */}
        {showFollowBar && (
          <FollowBar top={slots.followTop} name={nameOf.get(followId) || 'member'} onStop={() => setFollowId(null)} />
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
      <MapRosterSheet
        members={members} me={me} mine={mine} presences={presences} now={now}
        loaded={membersLoaded} failed={membersFailed} onRetry={() => setMembersTry((n) => n + 1)}
        trip={trip} tripPings={tripPings} followId={followId} routeTo={routeTo} routeBusy={routeBusy}
        canRoute={!!mine || !!destination}
        onFocus={(id) => setFocusId(id)}
        onRoute={(id) => { setRouteTo(routeTo === id ? null : id); setFocusId(id); }}
        onFollow={(id) => { setFollowId(followId === id ? null : id); setFocusId(id); }}
      />
      )}
    </View>
  );
}

const st = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
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
  // Sits over the right end of the search bar (minHeight 40), centred on it.
  searchClear: {
    position: 'absolute', right: 12, width: 44, minHeight: 40, alignItems: 'center', justifyContent: 'center',
    elevation: 5,
  },
  searchBar: {
    position: 'absolute', left: 12, right: 12, top: 12, flexDirection: 'row', alignItems: 'center', gap: 9,
    borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, minHeight: 40, elevation: 4,
  },
  linkFab: {
    position: 'absolute', left: 12, bottom: 12, alignItems: 'center', justifyContent: 'center',
    gap: 1, borderWidth: 1, borderRadius: 12, paddingHorizontal: 8, minHeight: 44, maxWidth: 180, elevation: 3,
  },
});
