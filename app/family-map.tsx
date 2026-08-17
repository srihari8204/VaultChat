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
import { View, Text, ScrollView, ActivityIndicator, StyleSheet, TouchableOpacity } from 'react-native';
import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useTheme } from '../lib/theme';
import FamilyMap, { type FamilyMarker } from '../components/family/FamilyMap';
import MeetHereSheet, { type MeetDestination } from '../components/family/MeetHereSheet';
import { type MemberInput } from '../lib/family/distance';
import { circleMembers } from '../lib/family/circle';
import { subscribeCircle, type PresenceEvent } from '../lib/family/presence';
import { freshnessOf, foldPresence, markSharingOff, type Freshness } from '../lib/family/status';
import { subscribeSpaceLocations, mergePresence, fetchSpaceSnapshot } from '../lib/location/live';
import { startRefreshController } from '../lib/family/refresh';
import { type CircleMember, type MemberPresence } from '../lib/family/types';
import { formatMetres, formatRoute } from '../lib/family/distance';
import { fetchRoute } from '../lib/nav/routing';
import { haversine } from '../lib/nav/geo';
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
  /** Dashed distance lines to every member. On by default — it is the picture
   *  the screen exists to show — but dismissible when the map gets busy. */
  const [showLinks, setShowLinks] = useState(true);
  // Render tick so "LIVE" decays to "5 min ago" without a new ping arriving.
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);

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
    })();
    return () => { live = false; off?.(); };
  }, [circleId]);

  /**
   * Road route to ONE member, fetched on demand (spec §8/§42).
   *
   * Deliberately not fetched for everyone: ten members would be ten Valhalla
   * routings for lines nobody asked to see. The dashed connectors already
   * answer "who is where and how far"; this answers "how do I actually get to
   * THIS one", and only when asked.
   */
  const [routeTo, setRouteTo] = useState<string | null>(null);
  const [routeShape, setRouteShape] = useState<{ lat: number; lng: number }[] | null>(null);
  const [routeInfo, setRouteInfo] = useState<string | null>(null);
  const [routeBusy, setRouteBusy] = useState(false);

  useEffect(() => {
    if (!routeTo || !mine) { setRouteShape(null); setRouteInfo(null); return; }
    const target = presences[routeTo];
    if (!target) { setRouteShape(null); setRouteInfo(null); return; }
    let live = true;
    setRouteBusy(true);
    fetchRoute(mine.pos, target.pos, 'auto')
      .then((r) => {
        if (!live) return;
        setRouteShape(r.shape);
        // Road figures, explicitly labelled as such — never mixed with the
        // straight-line numbers on the connectors (§8).
        setRouteInfo(formatRoute(r.lengthM, r.timeS));
      })
      .catch(() => {
        if (!live) return;
        setRouteShape(null);
        setRouteInfo('Route unavailable');
      })
      .finally(() => { if (live) setRouteBusy(false); });
    return () => { live = false; };
  // Keyed on the target's COORDINATES: re-route when they actually move, not on
  // every ping that repeats the same position.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeTo, mine?.pos.lat, mine?.pos.lng, presences[routeTo ?? '']?.pos.lat, presences[routeTo ?? '']?.pos.lng]);

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
      <View style={{ flex: 1 }}>
        <FamilyMap
          members={markers} focusId={focusId} followId={followId}
          destination={destination}
          // Connectors fan out from ME to every member, each labelled with its
          // straight-line distance — the "ten members, ten distances" picture.
          // Dropped while a road route is on screen so the two line styles
          // never compete for the same reading.
          linkFrom={showLinks && !routeShape && mine ? mine.pos : null}
          route={routeShape}
          onSelect={(id) => setFocusId(id)} style={{ flex: 1 }}
        />

        {/* SEARCH BAR, not a button. Meet Here is a search — it belongs at the
            top of the map looking like one, the way every maps app puts it. */}
        {!meetOpen && (
          <TouchableOpacity
            onPress={() => setMeetOpen(true)}
            accessibilityRole="search"
            accessibilityLabel="Search a place for the family to meet"
            style={[st.searchBar, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <Ionicons name="search" size={17} color={colors.textDim} />
            <Text style={{ color: destination ? colors.text : colors.textDim, fontSize: 14, flex: 1 }} numberOfLines={1}>
              {destination ? destination.name : 'Search a place to meet'}
            </Text>
            {destination
              ? <Ionicons name="close-circle" size={17} color={colors.textFaint} onPress={() => setDestination(null)} />
              : <Ionicons name="people" size={16} color={colors.primary} />}
          </TouchableOpacity>
        )}

        {/* Connector toggle — ten dashed lines are the point on one screen and
            clutter on another, so it is the user's call, not a fixed choice. */}
        {!meetOpen && !routeShape && (
          <TouchableOpacity
            onPress={() => setShowLinks((v) => !v)}
            accessibilityRole="button"
            accessibilityState={{ selected: showLinks }}
            accessibilityLabel={showLinks ? 'Hide distance lines' : 'Show distance lines to every member'}
            style={[st.linkFab, { backgroundColor: colors.card, borderColor: showLinks ? colors.primary : colors.border }]}
          >
            <Ionicons name="git-network" size={17} color={showLinks ? colors.primary : colors.textDim} />
            <Text style={{ color: showLinks ? colors.primary : colors.textDim, fontSize: 10, fontWeight: '800' }}>
              Distances
            </Text>
          </TouchableOpacity>
        )}

        {/* Active road route: says whose it is, what it costs BY ROAD, and how
            to get rid of it. */}
        {routeShape && (
          <View style={[st.routeBar, { backgroundColor: colors.card, borderColor: colors.primary }]}>
            <Ionicons name="navigate-circle" size={16} color={colors.primary} />
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13, flex: 1 }} numberOfLines={1}>
              {nameOf.get(routeTo ?? '') || 'Member'}{routeInfo ? ` · ${routeInfo}` : ''}
            </Text>
            <Text onPress={() => { setRouteTo(null); setRouteShape(null); }}
              style={{ color: colors.primary, fontWeight: '800', fontSize: 12 }}>CLEAR</Text>
          </View>
        )}
        {/* Following banner (spec: "Following X" + "Stop following"). Only
            shown while a follow is active, and it is the way OUT — a map that
            keeps recentring with no visible reason feels broken. */}
        {followId && (
          <View style={[st.followBar, { backgroundColor: colors.card, borderColor: colors.primary }]}>
            <Ionicons name="navigate-circle" size={16} color={colors.primary} />
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13, flex: 1 }} numberOfLines={1}>
              Following {nameOf.get(followId) || 'member'}
            </Text>
            <Text
              onPress={() => setFollowId(null)}
              style={{ color: colors.primary, fontWeight: '800', fontSize: 12.5 }}
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
        />
      ) : (
      <View style={[st.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
        {!membersLoaded ? (
          <View style={st.center}><ActivityIndicator color={colors.primary} /></View>
        ) : (
          <ScrollView style={{ maxHeight: 210 }} contentContainerStyle={{ paddingBottom: 6 }}>
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
              return (
                <View key={m.id} style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }}>
                  <View style={st.rowWrap}>
                    <Text
                      onPress={() => p && setFocusId(m.id)}
                      style={[st.row, { color: colors.text, flex: 1 }]}
                    >
                      <Text style={{ color: liveNow ? colors.success : colors.textFaint }}>● </Text>
                      {m.id === me ? 'You' : m.name}
                      <Text style={{ color: liveNow ? colors.success : colors.textDim, fontSize: 12 }}>
                        {'   '}{freshLabel(f, p?.ts, now, p?.sharingOff)}
                        {fromMe != null ? `   ·   ${formatMetres(fromMe)} from You` : ''}
                      </Text>
                    </Text>
                    {/* Road route to THIS member — one Valhalla call, on
                        request. Needs my own position to route from. */}
                    {canFollow && !!mine && (
                      <Text
                        onPress={() => { setRouteTo(routeTo === m.id ? null : m.id); setFocusId(m.id); }}
                        style={{ color: routeTo === m.id ? colors.primary : colors.textDim, fontWeight: '700', fontSize: 12, paddingHorizontal: 6 }}
                      >
                        {routeBusy && routeTo === m.id ? '…' : routeTo === m.id ? 'ROUTED' : 'Route'}
                      </Text>
                    )}
                    {canFollow && (
                      <Text
                        onPress={() => { setFollowId(following ? null : m.id); setFocusId(m.id); }}
                        style={{ color: following ? colors.primary : colors.textDim, fontWeight: '700', fontSize: 12, paddingHorizontal: 6 }}
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
    borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1,
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 14,
  },
  searchBar: {
    position: 'absolute', left: 12, right: 12, top: 12, flexDirection: 'row', alignItems: 'center', gap: 9,
    borderWidth: 1, borderRadius: 14, paddingHorizontal: 13, minHeight: 46, elevation: 4,
  },
  linkFab: {
    position: 'absolute', left: 12, bottom: 12, alignItems: 'center', justifyContent: 'center',
    gap: 1, borderWidth: 1, borderRadius: 14, paddingHorizontal: 9, minHeight: 44, elevation: 3,
  },
  routeBar: {
    position: 'absolute', left: 12, right: 12, bottom: 12, flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, minHeight: 42, elevation: 3,
  },
  rowWrap: { flexDirection: 'row', alignItems: 'center' },
  row: { paddingVertical: 10, fontSize: 14.5, fontWeight: '600' },
  refWrap: { paddingBottom: 10, paddingLeft: 14, gap: 2 },
  refLine: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  followBar: {
    position: 'absolute', left: 12, right: 12, top: 12,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9,
  },
});
