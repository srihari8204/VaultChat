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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert, ActivityIndicator } from 'react-native';
import { Stack, useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { brandAlpha } from '../constants/theme';
import SpaceGround, { useSpaceGlass } from '../components/spaces/SpaceGround';
import { SPACE_SHADOW } from '../constants/spaceTheme';
import { getTrack, summarize, type TrackSample, timeAtPlace } from '../lib/family/history';
import { useFamilyAlerts, loadAlerts, type FamilyAlert } from '../lib/family/alerts';
import { getPlaces } from '../lib/family/store';
import { getGroup, historyAccess } from '../lib/groups/store';
import { getCurrentUserAsync } from './(constants)/authService';
import { type Geofence } from '../lib/family/geofence';
import { createDirectChat } from '../lib/chatService';
import { navigateTo } from '../lib/nav/openNavigation';
import { haversine } from '../lib/nav/geo';
import { freshnessOf } from '../lib/family/status';
import { getRelations, setRelation, RELATION_PRESETS } from '../lib/family/relations';
// v3 — shared Location Lock engine classifiers/formatters (same bands as Navigate)
import { classifyDistance, zoneColor } from '../lib/lock/zoneMachine';
import { fmtSpeed, gpsQuality, QUALITY_LABEL, QUALITY_COLOR } from '../lib/lock/format';

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
  const G = useSpaceGlass();
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
  // Same gate as the history screen, so History cannot be reached sideways from
  // here when the group withholds it. Starts denied.
  const [mayViewHistory, setMayViewHistory] = useState(false);
  // Blur has to cancel the write-back too: pull()'s awaits outlive the screen,
  // so without this it setStates onto a tree that is gone (2026-09-17).
  const alive = useRef(true);
  /** What this person is to me. Server-owned; this screen is where it is set. */
  const [relation, setRelationState] = useState('');
  const [savingRel, setSavingRel] = useState(false);

  useEffect(() => {
    if (!circleId || !userId) return;
    let live = true;
    getRelations(circleId).then((r) => { if (live) setRelationState(r[userId] ?? ''); });
    return () => { live = false; };
  }, [circleId, userId]);

  /** Tap a preset to set it, tap the active one to clear. Optimistic, but it
   *  REVERTS if the server refuses — a label that looks saved and is not is
   *  worse than one that visibly did not take. */
  const chooseRelation = async (next: string) => {
    if (savingRel) return;
    const prev = relation;
    const value = relation === next ? '' : next;
    setRelationState(value);
    setSavingRel(true);
    const ok = await setRelation(circleId, userId, value);
    setSavingRel(false);
    if (!ok) {
      setRelationState(prev);
      Alert.alert('Could not save', 'The relationship was not saved. Check your connection and try again.');
    }
  };

  const alerts = useFamilyAlerts(circleId || null, 'all');
  useEffect(() => { loadAlerts(); }, []);

  const pull = useCallback(async () => {
    if (!circleId || !userId) { setLoading(false); return; }
    const [ps, g, me] = await Promise.all([
      getPlaces(circleId),
      getGroup(circleId),
      getCurrentUserAsync().catch(() => null),
    ]);
    // Untyped legacy groups keep their previous behaviour: any member could see
    // the circle's history, so do not start withholding it from them now.
    //
    // UNKNOWN IS NOT DENIED (2026-09-17). `g.permissions` is a cache of server
    // truth and it is absent until a getChat has landed — a migrated circle
    // never had one, nor does a space you have not made active, nor does
    // anything at all when you are offline. Reading that absence as an empty
    // permission set denied every member of every such circle, its OWNER
    // included, and the screen then reported the withheld track as facts about
    // the person. historyAccess() keeps the three cases apart; only a cached
    // answer that really lacks view_history withholds anything.
    const allowed = historyAccess(g) !== 'denied';
    // Withhold the LOAD, not just the render (2026-09-17) — the same fix
    // family-history.tsx already carries. `mayViewHistory` only hid the History
    // button while getTrack ran alongside getGroup regardless, and the travelled
    // -distance effect below then POSTed the resulting polyline to /nav/trace
    // (lib/nav/routing.ts) — so a denied viewer both saw and UPLOADED another
    // member's day. Decide first, then fetch.
    //
    // The one reading that is unconditionally yours is your own track, so the
    // gate is "others", not "no data". Fails closed when selfId is unknown.
    const denied = !allowed && userId !== (me ? String(me.id) : null);
    const track = denied ? [] : await getTrack(circleId, { from: startOfToday(), userId });
    if (!alive.current) return;   // blurred mid-flight — nothing below may set state
    setMayViewHistory(!denied);
    setToday(track);
    setPlaces(ps);
    setLoading(false);
  }, [circleId, userId]);

  // Poll while focused: presence.ts keeps writing pings into history behind us.
  useFocusEffect(useCallback(() => {
    alive.current = true;
    const tick = () => { if (alive.current) pull(); };
    tick();
    const t = setInterval(tick, REFRESH_MS);
    return () => { alive.current = false; clearInterval(t); };
  }, [pull]));

  /**
   * The track was withheld by the group's permissions, not missing.
   *
   * These are two completely different sentences and the screen used to say the
   * wrong one (2026-09-17): an empty track rendered as "No recent location",
   * "0 m travelled", "0 km/h", no zones, and Follow saying the member "is not
   * sharing a location right now" — every one of those a claim ABOUT THE PERSON
   * that this device has no basis for. Nothing is broken and the viewer has
   * done nothing wrong; the space simply does not share other members' history
   * with their role. group-insights.tsx says so in a lock notice, so say it
   * here in the same voice instead of inventing facts.
   *
   * A screen opened without a circle or a member is NOT a denied one — pull()
   * returns before deciding anything — so it is excluded rather than shown a
   * lock it did not earn.
   */
  const withheld = !mayViewHistory && !!circleId && !!userId;

  const last = today.length ? today[today.length - 1] : null;
  // Freshness tier (LIVE / RECENT / STALE / UNAVAILABLE) — a fix past the
  // recent window is "Last known", and this screen never says Online on it.
  const tier = freshnessOf(last?.ts, Date.now());
  const fresh = tier === 'live';
  const stats = useMemo(() => summarize(today), [today]);

  /**
   * TRAVELLED distance, map-matched onto the roads.
   *
   * `summarize` sums straight lines between consecutive fixes, which
   * understates the real distance and by more the sparser the fixes are —
   * every bend between two points becomes a chord. /nav/trace snaps the track
   * to the road network and measures along it, which is what an odometer
   * shows.
   *
   * Falls back to the summed figure whenever matching fails or the track is
   * too short to match: a slightly short number beats a blank stat, and zero
   * would read as "went nowhere".
   */
  const [roadTravelledM, setRoadTravelledM] = useState<number | null>(null);
  const trackKey = useMemo(
    () => (today.length < 2 ? '' : `${today.length}:${today[0]?.ts}:${today[today.length - 1]?.ts}`),
    [today]);

  useEffect(() => {
    if (!trackKey) { setRoadTravelledM(null); return; }
    let cancel = false;
    (async () => {
      try {
        const { fetchTraceDistance } = require('../lib/nav/routing');
        const r = await fetchTraceDistance(today.map((s2: any) => ({ lat: s2.lat, lng: s2.lng })));
        if (!cancel) setRoadTravelledM(r?.distanceM ?? null);
      } catch {
        if (!cancel) setRoadTravelledM(null);
      }
    })();
    return () => { cancel = true; };
  }, [trackKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Road distance from this member's last fix to each of MY places.
   *
   * One /nav/matrix call covers every place at once. Keyed on the position
   * rounded to ~110m and the place ids, so the ordinary refresh tick does not
   * re-route for a few metres of GPS jitter.
   *
   * This does NOT feed the zone badge — that still compares the straight line
   * against the circle's radius, which is what a radius means.
   */
  const [roadToPlace, setRoadToPlace] = useState<Record<string, number>>({});
  const roadKey = useMemo(() => {
    if (!last || !places.length) return '';
    return `${last.lat.toFixed(3)},${last.lng.toFixed(3)}|${places.map((p) => p.id).sort().join(',')}`;
  }, [last, places]);

  useEffect(() => {
    if (!roadKey || !last || !places.length) { setRoadToPlace({}); return; }
    let cancel = false;
    (async () => {
      try {
        const { fetchMatrix } = require('../lib/nav/routing');
        // Places are the ORIGINS and the member is the single target: the
        // matrix endpoint takes many-to-one, and road distance is symmetric
        // enough for a display figure.
        const res = await fetchMatrix(
          places.map((p) => p.center), { lat: last.lat, lng: last.lng }, 'auto');
        if (cancel) return;
        const next: Record<string, number> = {};
        for (const r of res) {
          const pl = places[r.index];
          if (pl) next[pl.id] = r.distanceM;
        }
        setRoadToPlace(next);
      } catch {
        if (!cancel) setRoadToPlace({});   // the direct figure still shows
      }
    })();
    return () => { cancel = true; };
  }, [roadKey]);   // eslint-disable-line react-hooks/exhaustive-deps

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

  /** "Locked" and "not sharing" are different answers — never give the second
   *  one when the truth is the first. */
  const lockedAlert = () => Alert.alert(
    'Not shared with you',
    `This space does not share other members' location history with your role, so ${name}'s position is not available here.`,
  );

  const route = () => {
    if (withheld) { lockedAlert(); return; }
    if (!last) { Alert.alert('No location', `${name} is not sharing a location right now.`); return; }
    // Say WHICH position is being navigated to. A stale fix is a legitimate
    // destination, but calling it "live" when it is 20 minutes old is exactly
    // the lie the freshness tiers exist to prevent.
    if (tier === 'stale') {
      Alert.alert(
        'Navigate to last known location?',
        `${name}'s position is from ${ago(last.ts)}. They may have moved since.`,
        [{ text: 'Cancel', style: 'cancel' },
          { text: 'Navigate', onPress: () => navigateTo(last.lat, last.lng, name) }],
      );
      return;
    }
    navigateTo(last.lat, last.lng, name);
  };

  /** Follow on the circle map (spec: Follow member). Needs a usable fix. */
  const follow = () => {
    if (withheld) { lockedAlert(); return; }
    if (!last || tier === 'unavailable') {
      Alert.alert('Cannot follow', `${name} has no location to follow right now.`);
      return;
    }
    router.push({
      pathname: '/family-map' as any,
      params: { circleId, circleName: params.circleName ?? '', followId: userId },
    });
  };

  const action = (icon: keyof typeof Ionicons.glyphMap, label: string, onPress: () => void, tint?: string) => (
    <TouchableOpacity onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={[st.action, { backgroundColor: G.pane, borderColor: G.edge }]}>
      <Ionicons name={icon} size={20} color={tint ?? colors.primary} />
      <Text style={[st.actionTxt, { color: colors.text }]}>{label}</Text>
    </TouchableOpacity>
  );

  if (loading) {
    return (
      <View style={[st.center, { backgroundColor: G.bgMid }]}>
        <SpaceGround />
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: G.bgMid }}>
      {/* Native header opted back in — owns the status-bar inset and gives the
          screen a back button; the root layout hides headers app-wide. */}
      <Stack.Screen options={{
        headerShown: true, title: name, headerTitleAlign: 'center',
        headerStyle: { backgroundColor: G.bgTop }, headerTintColor: colors.text, headerShadowVisible: false,
      }} />
      <SpaceGround aura={colorFor(userId)} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>

        {/* identity card */}
        <View style={[st.card, { backgroundColor: G.paneStrong, borderColor: G.edge }]}>
          <View style={[st.avatar, { backgroundColor: colorFor(userId) }]}>
            <Text style={st.avatarTxt}>{name.trim()[0]?.toUpperCase() ?? '?'}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={{ color: colors.text, fontSize: 17, fontWeight: '800' }} numberOfLines={1}>{name}</Text>
              {isGuardian && <Ionicons name="star" size={13} color={colors.primary} />}
            </View>
            <Text style={{ color: fresh ? G.goodText : colors.textDim, fontSize: 12.5, marginTop: 2 }}>
              {withheld ? 'Location not shared with you'
                : tier === 'live' ? 'Online'
                  : tier === 'recent' ? `Updated ${ago(last!.ts)}`
                    : tier === 'stale' ? `Last known · ${ago(last!.ts)}`
                      // Neutral on silence: this device cannot tell sharing-off
                      // from offline/permission/no-GPS for another member.
                      : 'No recent location'}
              {currentPlace && tier !== 'unavailable' && tier !== 'stale' ? ` · at ${currentPlace.name}` : ''}
            </Text>
          </View>
          {last?.bat != null && (
            <View style={{ alignItems: 'center' }}>
              <Ionicons
                name={last.bat <= 20 ? 'battery-dead' : 'battery-half'}
                size={20}
                color={last.bat <= 20 ? G.dangerText : colors.textDim}
              />
              <Text style={{ color: last.bat <= 20 ? G.dangerText : colors.textDim, fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] }}>
                {Math.round(last.bat)}%
              </Text>
            </View>
          )}
        </View>

        {/* The honest version of the denied state. Same shape and the same
            plain wording as the lock notice on group-insights.tsx, because it
            is the same fact. Message and Call are untouched by it, so say so
            rather than leaving the screen looking broken. */}
        {withheld && (
          <View style={[st.notice, { backgroundColor: G.pane, borderColor: G.edge }]}>
            <Ionicons name="lock-closed-outline" size={15} color={colors.textDim} />
            <Text style={{ color: colors.textDim, fontSize: 12.5, flex: 1 }}>
              This space does not share other members&apos; location history with your role, so
              {' '}{name}&apos;s position, travel and safe-zone status are not shown here.
              Messaging and calling still work.
            </Text>
          </View>
        )}

        {/* actions */}
        <View style={st.actions}>
          {action('chatbubble-ellipses', 'Message', () => openDirect('chat'))}
          {action('call', 'Call', () => openDirect('voicecall'))}
          {action('navigate-circle', 'Route', route)}
          {action('locate', 'Follow', follow)}
          {mayViewHistory && action('time', 'History', () => router.push({
            pathname: '/family-history' as any,
            params: { circleId, name, userId, circleName: params.circleName ?? '' },
          }))}
        </View>

        {/* RELATIONSHIP. Stored per (space, viewer, member) on the server, so
            what I call someone is mine — the same person is "Mother" to me and
            "Wife" to someone else in this circle, both true at once. */}
        <Text style={[st.h, { color: colors.textDim }]}>Relationship</Text>
        <View style={st.relWrap}>
          {RELATION_PRESETS.map((r) => {
            const on = relation === r;
            return (
              <TouchableOpacity
                key={r}
                onPress={() => chooseRelation(r)}
                disabled={savingRel}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${name} is my ${r}`}
                style={[st.relChip, {
                  borderColor: on ? colors.primary : G.chipEdge,
                  backgroundColor: on ? brandAlpha(0.14) : G.paneFaint,
                  opacity: savingRel ? 0.6 : 1,
                }]}
              >
                <Text style={{ color: on ? G.accentText : colors.textDim, fontSize: 12.5, fontWeight: on ? '800' : '600' }}>
                  {r}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <Text style={{ color: colors.textDim, fontSize: 11.5, marginTop: 8 }}>
          {relation
            ? `Shown as “${relation} · ${name}” on your family map. Only you see this label.`
            : 'Tap one to show it beside their name on your family map.'}
        </Text>

        {/* today at a glance — and the whole of it, stats and timeline alike, is
            DERIVED from the track this viewer may not have. Rendering it while
            the track is withheld is how "0 m travelled · 0 km/h · nothing yet
            today" got stated as fact about someone whose day we never saw. The
            notice above is the answer for this viewer; these sections are not. */}
        {!withheld && (<>
        <Text style={[st.h, { color: colors.textDim }]}>Today</Text>
        <View style={[st.statRow, { backgroundColor: G.pane, borderColor: G.edge }]}>
          <View style={st.stat}>
            <Text style={[st.statVal, { color: colors.text }]}>
              {dist(roadTravelledM ?? stats.distanceM)}
            </Text>
            <Text style={[st.statLbl, { color: colors.textDim }]}>Travelled</Text>
          </View>
          <View style={[st.statDiv, { backgroundColor: G.line }]} />
          <View style={st.stat}>
            <Text style={[st.statVal, { color: colors.text }]}>{Math.round(stats.maxSpeed * 3.6)} km/h</Text>
            <Text style={[st.statLbl, { color: colors.textDim }]}>Top speed</Text>
          </View>
          <View style={[st.statDiv, { backgroundColor: G.line }]} />
          <View style={st.stat}>
            <Text style={[st.statVal, { color: colors.text }]}>{todaysActivity.length}</Text>
            <Text style={[st.statLbl, { color: colors.textDim }]}>Events</Text>
          </View>
        </View>

        {/* activity timeline */}
        <Text style={[st.h, { color: colors.textDim, marginTop: 22 }]}>Today&apos;s Activity</Text>
        {todaysActivity.length === 0 ? (
          <Text style={{ color: colors.textDim, fontSize: 13.5 }}>
            Nothing yet today. Arrivals, departures and check-ins show up here.
          </Text>
        ) : todaysActivity.map((a) => (
          <View key={a.id} style={[st.evt, { borderColor: G.line }]}>
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
        </>)}

        {/* location diagnostics (v3) — same data language as the lock engine */}
        {last && (
          <View style={[st.evt, { borderColor: G.line }]}>
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
        <Text style={[st.h, { color: colors.textDim, marginTop: 22 }]}>Safe Zones</Text>
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
            <View key={p.id} style={[st.evt, { borderColor: G.line }]}>
              <View style={[st.evtIcon, { backgroundColor: (here ? colors.success : colors.textFaint) + '22' }]}>
                <Ionicons name="location" size={15} color={here ? colors.success : colors.textDim} />
              </View>
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={{ color: colors.text, fontSize: 14, fontWeight: '600' }}>{p.name}</Text>
                <Text style={{ color: colors.textDim, fontSize: 11.5 }}>
                  {p.enabled === false ? 'Alerts off' : `${p.radiusM} m radius`}
                  {/* BOTH numbers, each labelled, because they answer different
                      questions and one cannot replace the other. The radius
                      figure is a straight line — it is the value compared
                      against the circle to produce the INSIDE/OUTSIDE badge
                      beside it, and swapping in a road distance would let the
                      row read "500 m radius · 2.1 km away · INSIDE" and
                      contradict itself. The road figure is what it actually
                      takes to get there, which is the useful number and the
                      one that was missing. */}
                  {d != null ? ` · ${dist(d)} direct` : ''}
                  {roadToPlace[p.id] != null ? ` · ${dist(roadToPlace[p.id])} by road` : ''}
                  {tpTxt}
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
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: 22, padding: 16, ...SPACE_SHADOW.raised },
  avatar: { width: 50, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center' },
  avatarTxt: { color: '#fff', fontWeight: '800', fontSize: 20 },
  // No fixed height and the text takes flex:1 beside the icon, so it simply
  // grows at font scale 1.5 and wraps on a 320dp screen.
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, padding: 12, borderWidth: 1, borderRadius: 16, marginTop: 12 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  action: { flex: 1, minWidth: 62, alignItems: 'center', justifyContent: 'center', gap: 5, minHeight: 62, borderWidth: 1, borderRadius: 18, ...SPACE_SHADOW.rest },
  actionTxt: { fontSize: 11.5, fontWeight: '600' },
  h: { fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.7, marginTop: 24, marginBottom: 10 },
  statRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 20, paddingVertical: 14, ...SPACE_SHADOW.rest },
  stat: { flex: 1, alignItems: 'center', gap: 3 },
  statVal: { fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] },
  statLbl: { fontSize: 11 },
  statDiv: { width: 1, height: 28 },
  evt: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth },
  evtIcon: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  relWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  relChip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, minHeight: 32, justifyContent: 'center' },
});
