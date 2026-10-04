// components/family/MapRosterSheet.tsx — the family live map's roster sheet,
// moved out of app/family-map.tsx unchanged: every member's honest freshness
// line, distance from me, trip ETA, their published reference distances, and
// the Route / Follow actions. Also the freshness wording the selected-member
// sheet shares.

import React from 'react';
import { View, ScrollView, ActivityIndicator, StyleSheet, useWindowDimensions } from 'react-native';
import { AppText as Text } from '../ui/Text';
import { useTheme } from '../../lib/theme';
import { useSpaceGlass } from '../spaces/SpaceGround';
import { freshnessOf, type Freshness } from '../../lib/family/status';
import { formatMetres } from '../../lib/family/distance';
import { haversine } from '../../lib/nav/geo';
import { minutesUntil, type Trip, type TripPing } from '../../lib/groups/trips';
import { type CircleMember, type MemberPresence } from '../../lib/family/types';
import { BarAction } from './MapBars';

const AGO = (ms: number) => {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return `${h} h ago`;
};

/** Honest per-member line: never "LIVE" without a fresh fix, and an explicit
 *  sharing-off outranks freshness however new the retained fix is. */
export const freshLabel = (f: Freshness, ts?: number, now?: number, sharingOff?: boolean): string => {
  if (sharingOff) return ts && now ? `Sharing off · last seen ${AGO(now - ts)}` : 'Location sharing off';
  switch (f) {
    case 'live': return 'LIVE';
    case 'recent': return ts && now ? AGO(now - ts) : 'recent';
    case 'stale': return ts && now ? `Last known · ${AGO(now - ts)}` : 'last known';
    default: return 'Location unavailable';
  }
};

export default function MapRosterSheet({
  members, me, mine, presences, now, loaded, failed, onRetry,
  trip, tripPings, followId, routeTo, routeBusy, canRoute, onFocus, onRoute, onFollow,
}: {
  members: CircleMember[];
  me: string | null;
  /** My own position from the OS cache — this screen never starts a watcher. */
  mine: MemberPresence | null;
  presences: Record<string, MemberPresence>;
  now: number;
  loaded: boolean;
  failed: boolean;
  onRetry: () => void;
  trip: Trip | null;
  tripPings: TripPing[];
  followId: string | null;
  routeTo: string | null;
  routeBusy: boolean;
  /** There is something to route from: my position, or a destination. */
  canRoute: boolean;
  onFocus: (id: string) => void;
  onRoute: (id: string) => void;
  onFollow: (id: string) => void;
}) {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  // Sized to the window like the hub's roster (which takes 40%): a bit less
  // here because the map above is the point of this screen. Never below the
  // old fixed 148 dp, so a short phone keeps what it had.
  const { height: winH } = useWindowDimensions();
  const listMax = Math.max(148, Math.round(winH * 0.35));
  return (
    <View style={[st.sheet, { backgroundColor: G.sheet, borderColor: G.edge }]}>
      {!loaded && failed ? (
        <View style={st.center} accessibilityLiveRegion="polite">
          <Text style={{ color: colors.textDim, fontSize: 13 }}>Couldn&apos;t load the circle.</Text>
          <BarAction onPress={onRetry} label="RETRY" a11y="Retry loading the circle"
            style={{ color: G.accentText, fontWeight: '800', fontSize: 12.5, paddingVertical: 6 }} />
        </View>
      ) : !loaded ? (
        <View style={st.center}><ActivityIndicator color={colors.primary} accessibilityLabel="Loading the circle" /></View>
      ) : (
        <ScrollView style={{ maxHeight: listMax }} contentContainerStyle={{ paddingBottom: 4 }}>
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
            const tripLine = tp && trip
              ? (tp.arrived ? `Arrived at ${trip.destinationName}`
                : tp.etaAt != null ? `${minutesUntil(tp.etaAt, now)} min to ${trip.destinationName}` : null)
              : null;
            return (
              <View key={m.id} style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: G.line }}>
                <View style={st.rowWrap}>
                  <Text
                    onPress={p ? () => onFocus(m.id) : undefined}
                    accessibilityRole={p ? 'button' : 'text'}
                    accessibilityHint={p ? 'Centres the map on them' : undefined}
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
                  {canFollow && canRoute && (
                    <BarAction
                      onPress={() => onRoute(m.id)}
                      label={routeBusy && routeTo === m.id ? '…' : routeTo === m.id ? 'ROUTED' : 'Route'}
                      a11y={routeTo === m.id ? `Clear the route to ${m.name}` : `Show the road route to ${m.name}`}
                      style={{ color: routeTo === m.id ? G.accentText : colors.textDim, fontWeight: '700', fontSize: 12, paddingHorizontal: 6 }}
                    />
                  )}
                  {canFollow && (
                    <BarAction
                      onPress={() => onFollow(m.id)}
                      label={following ? 'FOLLOWING' : 'Follow'}
                      a11y={following ? `Stop following ${m.name}` : `Follow ${m.name}`}
                      style={{ color: following ? G.accentText : colors.textDim, fontWeight: '700', fontSize: 12, paddingHorizontal: 6 }}
                    />
                  )}
                </View>
                {/* EVERY reference this member published, not one at a time —
                    the spec's example is the whole list per person
                      Mother   Home 1.2 km · Shop 2.8 km · Other 4.5 km
                    readable without opening another screen (§4). Their chosen
                    default leads and is marked; the rest follow. Every value
                    was computed on THEIR device, so we hold the names and the
                    metres and never the coordinates. */}
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
  );
}

const st = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  sheet: {
    borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1,
    paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8,
  },
  rowWrap: { flexDirection: 'row', alignItems: 'center' },
  row: { paddingVertical: 7, fontSize: 14, fontWeight: '600' },
  refWrap: { paddingBottom: 6, paddingLeft: 12, gap: 1 },
  refLine: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});
