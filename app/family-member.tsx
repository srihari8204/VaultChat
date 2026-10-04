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

import { AppText as Text } from '../components/ui/Text';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, TouchableOpacity, ScrollView, Alert, ActivityIndicator } from 'react-native';
import { Stack, useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { brandAlpha } from '../constants/theme';
import SpaceGround, { useSpaceGlass } from '../components/spaces/SpaceGround';
import { SPACE_SHADOW } from '../constants/spaceTheme';
import { getTrack, summarize, type TrackSample } from '../lib/family/history';
import { useFamilyAlerts, loadAlerts, type FamilyAlert } from '../lib/family/alerts';
import { getPlaces } from '../lib/family/store';
import { historyAccess } from '../lib/groups/store';
import { groupWithHistoryAccess } from '../lib/family/historyGate';
import { getCurrentUserAsync } from './(constants)/authService';
import { type Geofence } from '../lib/family/geofence';
import { createDirectChat } from '../lib/chatService';
import { navigateTo } from '../lib/nav/openNavigation';
import { haversine } from '../lib/nav/geo';
import { freshnessOf } from '../lib/family/status';
import { getRelations, setRelation, RELATION_PRESETS } from '../lib/family/relations';
import { colorFor, ago } from '../lib/family/memberFormat';
// A namespace import, not named: lib/locationEgress.selftest.ts pins that the
// first mention of the trace call in this file sits after the empty-track guard.
import * as routing from '../lib/nav/routing';
import { traceShape } from '../lib/family/traceShape';
import { formatMetres as dist } from '../lib/family/distance';
import {
  MemberIdentityCard, MemberActivityList, MemberFixRow, MemberPlaceRow,
} from '../components/family/MemberSections';

const REFRESH_MS = 15_000;
/** At most one /nav/trace map-matching upload per this much track time. The
 *  screen polls every 15 s and each poll can add a sample; re-sending the whole
 *  day's polyline on every one of them was a steady stream of the member's
 *  track to the routing server for a number that barely moves. */
const TRACE_EVERY_MS = 60_000;

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

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
  // here when the group withholds it. Starts UNKNOWN, not denied: a first pull
  // that fails has decided nothing, and reading it as "denied" told the viewer
  // a false permission fact about themselves.
  const [access, setAccess] = useState<'unknown' | 'allowed' | 'denied'>('unknown');
  const mayViewHistory = access === 'allowed';
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

  /** The last pull threw — shown, and the 15 s poll keeps retrying. */
  const [pullFailed, setPullFailed] = useState(false);
  /** A Retry tap is in flight — the button shows it and ignores repeats. */
  const [retrying, setRetrying] = useState(false);
  /** One identity lookup per screen, shared by the effect below and every
   *  pull (each pull used to ask again). A failed lookup resolves to null. */
  const meP = useRef<Promise<{ id: string | number } | null> | null>(null);
  const getMe = () => (meP.current ??= getCurrentUserAsync().catch(() => null));
  /** undefined = not resolved yet; null = lookup failed. Resolved on its own,
   *  so a failed pull cannot bring Message/Call back onto your own row. */
  const [selfId, setSelfId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    getMe().then((me) => { if (live) setSelfId(me ? String(me.id) : null); });
    return () => { live = false; };
  }, []);

  /** The current render's pullOnce, so `pull` can stay keyed on the ids alone
   *  (the focus poll restarts only when the circle or member changes). */
  const pullOnceRef = useRef<() => Promise<void>>(async () => {});
  const pull = useCallback(async () => {
    if (!circleId || !userId) { setLoading(false); return; }
    try { await pullOnceRef.current(); if (alive.current) setPullFailed(false); }
    catch {
      // getPlaces/getGroup/getTrack rejected: no endless spinner, no
      // unhandled rejection every 15 s from the interval.
      if (alive.current) { setPullFailed(true); setLoading(false); }
    }
  }, [circleId, userId]);

  const pullOnce = async () => {
    const [ps, g, me] = await Promise.all([
      getPlaces(circleId),
      // UNKNOWN IS ASKED, not assumed: a missing cached permission is resolved
      // against the server first, and if that cannot be reached this throws —
      // the screen then says "not loaded" rather than allowing or denying.
      groupWithHistoryAccess(circleId),
      getMe(),
    ]);
    // Untyped legacy groups keep their previous behaviour: any member could see
    // the circle's history, so do not start withholding it from them now.
    //
    // UNKNOWN IS NOT DENIED (2026-09-17) — and no longer allowed either.
    // `g.permissions` is a cache of server truth and it is absent until a
    // getChat has landed — a migrated circle never had one, nor does a space
    // you have not made active. Reading that absence as an empty set denied
    // every member, its OWNER included; reading it as allowed loaded other
    // people's tracks on a guess. groupWithHistoryAccess() asks the server
    // when the cache is silent, so by here the answer is a real one.
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
    setAccess(denied ? 'denied' : 'allowed');
    setToday(track);
    setPlaces(ps);
    setLoading(false);
  };
  pullOnceRef.current = pullOnce;

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
  const withheld = access === 'denied' && !!circleId && !!userId;
  /** Nothing has loaded yet and the last attempt failed: no claim either way. */
  const unknown = access === 'unknown' && pullFailed;

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
  // Keyed on the track's start and the MINUTE of its newest sample, not on
  // every sample: the figure re-matches at most once per TRACE_EVERY_MS of
  // track (it may trail the newest fixes by that long).
  const trackKey = useMemo(
    () => (today.length < 2 ? '' : `${today[0]?.ts}:${Math.floor(today[today.length - 1].ts / TRACE_EVERY_MS)}`),
    [today]);

  useEffect(() => {
    if (!trackKey) { setRoadTravelledM(null); return; }
    let cancel = false;
    (async () => {
      try {
        // Rounded to ~11 m and de-duplicated before it leaves the phone.
        const r = await routing.fetchTraceDistance(traceShape(today));
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
        // Places are the ORIGINS and the member is the single target: the
        // matrix endpoint takes many-to-one, and road distance is symmetric
        // enough for a display figure. Both rounded to ~110 m, like the key:
        // the figure needs no more, and the routing server need not see the
        // member's exact fix or my places' exact centres.
        const q = (n: number) => Math.round(n * 1000) / 1000;
        const res = await routing.fetchMatrix(
          places.map((p) => ({ lat: q(p.center.lat), lng: q(p.center.lng) })), { lat: q(last.lat), lng: q(last.lng) }, 'auto');
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
        ? { pathname: '/chat', params: { id: chat.id } }
        : { pathname: '/voicecall', params: { chatId: chat.id, peerUid: userId, peerName: name } });
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

  const loadFailedAlert = () => Alert.alert(
    'Not loaded', `${name}'s location could not be loaded. Check your connection and try again.`,
  );

  const route = () => {
    if (withheld) { lockedAlert(); return; }
    if (unknown) { loadFailedAlert(); return; }
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
    if (unknown) { loadFailedAlert(); return; }
    if (!last || tier === 'unavailable') {
      Alert.alert('Cannot follow', `${name} has no location to follow right now.`);
      return;
    }
    router.push({
      pathname: '/family-map',
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
        {pullFailed && !unknown && (
          <Text accessibilityLiveRegion="polite" style={{ color: G.dangerText, fontSize: 12.5, marginBottom: 10 }}>
            Couldn&apos;t refresh {name}&apos;s details — retrying automatically.
          </Text>
        )}

        {/* identity card */}
        <MemberIdentityCard name={name} userId={userId} isGuardian={isGuardian} withheld={withheld}
          unknown={unknown} tier={tier} last={last} currentPlace={currentPlace} />

        {/* The honest version of the denied state. Same shape and the same
            plain wording as the lock notice on group-insights.tsx, because it
            is the same fact. Message and Call are untouched by it, so say so
            rather than leaving the screen looking broken. */}
        {unknown && (
          <View style={[st.notice, { backgroundColor: G.pane, borderColor: G.edge }]} accessibilityLiveRegion="polite">
            <Ionicons name="cloud-offline-outline" size={15} color={G.dangerText} />
            <Text style={{ color: colors.textDim, fontSize: 12.5, flex: 1 }}>
              Couldn&apos;t load {name}&apos;s location and places. Check your connection.
            </Text>
            <TouchableOpacity
              onPress={async () => { if (retrying) return; setRetrying(true); await pull(); setRetrying(false); }}
              disabled={retrying}
              accessibilityRole="button" accessibilityLabel={`Retry loading ${name}'s details`}
              accessibilityState={{ busy: retrying, disabled: retrying }} hitSlop={10}
            >
              {retrying
                ? <ActivityIndicator size="small" color={colors.primary} />
                : <Text style={{ color: G.accentText, fontSize: 12.5, fontWeight: '800' }}>Retry</Text>}
            </TouchableOpacity>
          </View>
        )}
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
          {/* Not on your own row: these opened a "direct chat" with yourself.
              Shown only once WHO YOU ARE is known — a failed lookup (null)
              cannot tell your row from anyone else's, so it hides them too. */}
          {!!selfId && userId !== selfId && action('chatbubble-ellipses', 'Message', () => openDirect('chat'))}
          {!!selfId && userId !== selfId && action('call', 'Call', () => openDirect('voicecall'))}
          {action('navigate-circle', 'Route', route)}
          {action('locate', 'Follow', follow)}
          {mayViewHistory && action('time', 'History', () => router.push({
            pathname: '/family-history',
            params: { circleId, name, userId, circleName: params.circleName ?? '' },
          }))}
        </View>

        {/* RELATIONSHIP. Stored per (space, viewer, member) on the server, so
            what I call someone is mine — the same person is "Mother" to me and
            "Wife" to someone else in this circle, both true at once. */}
        <Text accessibilityRole="header" style={[st.h, { color: colors.textDim }]}>Relationship</Text>
        <View style={st.relWrap} accessibilityRole="radiogroup" accessibilityLabel={`${name}'s relationship to you`}>
          {RELATION_PRESETS.map((r) => {
            const on = relation === r;
            return (
              <TouchableOpacity
                key={r}
                onPress={() => chooseRelation(r)}
                disabled={savingRel}
                accessibilityRole="radio"
                accessibilityState={{ checked: on, selected: on, disabled: savingRel }}
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
        {/* A failed first load has no track and no places: every section below
            would state "0 m / nothing today / no places" as fact, so none render. */}
        {!unknown && (<>
        {!withheld && (<>
        <Text accessibilityRole="header" style={[st.h, { color: colors.textDim }]}>Today</Text>
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
        {/* Said where it happens, as family-history does: the travelled figure
            is the one part of this screen that sends the track off the phone. */}
        {!!trackKey && (
          <Text style={{ color: colors.textDim, fontSize: 11.5, marginTop: 6, lineHeight: 16 }}>
            {roadTravelledM != null
              ? 'Travelled is matched to roads by crazzychat’s routing server, which receives today’s track (rounded to about 10 m) and does not store it.'
              : 'Travelled is summed from the track points. Road matching uses crazzychat’s routing server, which does not store the track.'}
          </Text>
        )}

        {/* activity timeline */}
        <Text accessibilityRole="header" style={[st.h, { color: colors.textDim, marginTop: 22 }]}>Today&apos;s Activity</Text>
        <MemberActivityList activity={todaysActivity} />
        </>)}

        {/* location diagnostics (v3) — same data language as the lock engine */}
        {last && <MemberFixRow last={last} />}

        {/* places — zone status per place from the SHARED classifier, so a
            member's chip means exactly what Navigate's lock states mean */}
        <Text accessibilityRole="header" style={[st.h, { color: colors.textDim, marginTop: 22 }]}>Safe Zones</Text>
        {places.length === 0 ? (
          <Text style={{ color: colors.textDim, fontSize: 13.5 }}>
            No places yet. Add one in Places to get arrive/leave alerts.
          </Text>
        ) : places.map((p) => (
          <MemberPlaceRow key={p.id} place={p} here={currentPlace?.id === p.id} last={last} fresh={fresh}
            today={today} roadM={roadToPlace[p.id]} />
        ))}
        </>)}
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
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
  relWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  relChip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, minHeight: 32, justifyContent: 'center' },
});
