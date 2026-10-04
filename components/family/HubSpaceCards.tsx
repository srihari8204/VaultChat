// components/family/HubSpaceCards.tsx — the Family hub's status cards, moved out
// of app/family.tsx unchanged: the "no location from…" note, the FAMILY NOW
// board, the operations (runs) cards, the active-trip card and today's
// highlights.

import React from 'react';
import { View, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { AppText as Text } from '../ui/Text';
import { useTheme } from '../../lib/theme';
import { useSpaceGlass } from '../spaces/SpaceGround';
import { statusBoard } from '../../lib/family/status';
import { type Geofence } from '../../lib/family/geofence';
import { type CircleMember, type MemberPresence } from '../../lib/family/types';
import { type GroupRef } from '../../lib/groups/store';
import { ago } from '../../lib/family/memberFormat';
import { type Highlight } from './useHubFeeds';
import { type Run as SpaceRun } from '../../lib/spaces/runs';
import { foldParticipants, lastEta, everyoneArrived, minutesUntil, type Trip, type TripPing } from '../../lib/groups/trips';
import { st } from './hubStyles';
import { tint } from '../../lib/tintColor';

type IconName = keyof typeof Ionicons.glyphMap;

/**
 * FAMILY NOW — member statuses derived ON THIS DEVICE (spec §31): decrypted
 * presences × this device's saved Places. The server cannot read positions,
 * so it cannot compute these; and a board may only assert counts once the
 * roster is actually known (the caller gates on that). Zero rows are dropped
 * rather than shown as a wall of noise — except "No location", which is the
 * honest count that keeps the rest in context.
 */
export function FamilyNowBoard({ familySpace, rosterIds, presences, myId, sharingOn, places }: {
  /** 'family' says FAMILY NOW; a generic space says RIGHT NOW. */
  familySpace: boolean;
  rosterIds: string[];
  presences: Record<string, MemberPresence>;
  myId: string | null;
  sharingOn: boolean;
  places: Geofence[];
}) {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  // My own entry counts as sharing-off when MY switch is off, so the
  // board agrees with my row's caption instead of counting my
  // private dot as one of the family's live members.
  const forBoard = (myId && !sharingOn && presences[myId])
    ? { ...presences, [myId]: { ...presences[myId], sharingOff: true } }
    : presences;
  const b = statusBoard(rosterIds, forBoard, places, Date.now());
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
      <Text accessibilityRole="header" style={[st.secTitle, { color: colors.textDim, marginBottom: 8 }]}>
        {familySpace ? 'FAMILY NOW' : 'RIGHT NOW'} · {b.total} {b.total === 1 ? 'MEMBER' : 'MEMBERS'}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {chips.map((c) => (
          <View key={c.label} accessible accessibilityLabel={`${c.label}: ${c.n}`}
            style={[st.chip, { backgroundColor: G.paneFaint, borderColor: G.chipEdge, flexDirection: 'row', alignItems: 'center', gap: 5 }]}>
            <Ionicons name={c.icon as IconName} size={13} color={colors.primary} />
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
              <View key={c.label} accessible accessibilityLabel={`${c.label}: ${c.n}`}
                style={[st.chip, { backgroundColor: G.paneFaint, borderColor: G.chipEdge, flexDirection: 'row', alignItems: 'center', gap: 5 }]}>
                <Ionicons name={c.icon as IconName} size={13} color={colors.textDim} />
                <Text style={{ color: colors.textDim, fontSize: 12.5, fontWeight: '600' }}>{c.label}</Text>
                <Text style={{ color: colors.text, fontSize: 12.5, fontWeight: '800' }}>{c.n}</Text>
              </View>
            ))}
          </View>
        </>
      )}
    </View>
  );
}

/**
 * Operations (Spaces & Operations, S3.1 / S3.4). A driver's own run comes
 * FIRST and is styled as the primary action: S3.4 says a driver never lands
 * on a dashboard, and the honest way to honour that on a shared screen is to
 * put their manifest above everything else rather than to hide the rest.
 */
export function RunCards({ runs, active, myId, canDrive, canOps }: {
  runs: SpaceRun[];
  active: GroupRef;
  myId: string | null;
  canDrive: boolean;
  canOps: boolean;
}) {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  const router = useRouter();
  const mineFirst = (r: SpaceRun) => canDrive && r.driverId === myId;
  const others = runs.filter((r) => !mineFirst(r));
  return (
    <>
      {runs.filter(mineFirst).map((r) => (
        <TouchableOpacity
          key={r.id}
          onPress={() => router.push({ pathname: '/space-run-driver', params: { spaceId: active.id, runId: r.id, groupType: active.groupType ?? '' } })}
          accessibilityRole="button"
          accessibilityLabel={`${r.vehicleLabel || r.name}, ${r.status === 'started' ? 'your run is in progress' : 'start your run'}`}
          style={[st.card, { backgroundColor: G.pane, borderColor: colors.primary, flexDirection: 'row', alignItems: 'center', gap: 12 }]}
        >
          <View style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: tint(colors.primary, 0.13) }}>
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
      {others.length > 0 && (
        <View style={[st.card, { backgroundColor: G.pane, borderColor: G.edge }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
            <Text accessibilityRole="header" style={{ color: colors.text, fontWeight: '700', fontSize: 14.5, flex: 1 }}>
              {canOps ? 'Runs in progress' : 'Today’s run'}
            </Text>
            {canOps && (
              <TouchableOpacity
                onPress={() => router.push({ pathname: '/space-ops-map', params: { spaceId: active.id, name: active.name, groupType: active.groupType ?? '' } })}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
                hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
                accessibilityRole="button" accessibilityLabel="Operations map"
              >
                <Ionicons name="map-outline" size={15} color={colors.primary} />
                <Text style={{ color: G.accentText, fontSize: 12.5, fontWeight: '700' }}>Map</Text>
              </TouchableOpacity>
            )}
          </View>
          {others.map((r) => (
            <TouchableOpacity
              key={r.id}
              onPress={() => router.push({ pathname: '/space-run', params: { spaceId: active.id, runId: r.id, groupType: active.groupType ?? '' } })}
              accessibilityRole="button"
              accessibilityLabel={`${r.vehicleLabel || r.name}${r.stale && r.status === 'started' ? ', not reporting' : ''}`}
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
    </>
  );
}

/** Active trip (G5.7) — the caller renders this only while one is running. */
export function TripCard({ trip, tripPings, members, myId, active }: {
  trip: Trip;
  tripPings: TripPing[];
  members: CircleMember[];
  myId: string | null;
  active: GroupRef;
}) {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  const router = useRouter();
  const parts = foldParticipants(
    tripPings,
    Object.fromEntries(members.map((m) => [m.id, m.id === myId ? 'You' : m.name])),
    Date.now(),
  );
  const eta = lastEta(parts);
  const done = everyoneArrived(parts);
  return (
    <TouchableOpacity
      onPress={() => router.push({ pathname: '/group-trip', params: { groupId: active.id, name: active.name } })}
      accessibilityRole="button"
      accessibilityLabel={`Trip to ${trip.destinationName}. Opens the trip`}
      style={[st.card, { backgroundColor: G.pane, borderColor: done ? colors.success : colors.primary, flexDirection: 'row', alignItems: 'center', gap: 12 }]}
    >
      <View style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: tint(done ? colors.success : colors.primary, 0.13) }}>
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
}

/**
 * Why the map is emptier than the member list. Markers come only from
 * presences, so a member who has not turned sharing on simply does not appear
 * — and location sharing is opt-in on EACH device, so one phone sharing does
 * not make the other appear. Without this line an empty map looks like a
 * fault rather than a setting.
 */
export function NotVisibleNote({ names }: { names: string[] }) {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  return (
    <View style={[st.card, st.quiet, { backgroundColor: G.paneFaint, borderColor: G.edge, flexDirection: 'row', alignItems: 'center', gap: 10 }]}>
      <Ionicons name="location-outline" size={17} color={colors.textDim} />
      <Text style={{ color: colors.textDim, fontSize: 12.5, flex: 1, lineHeight: 17 }}>
        No location from {names.slice(0, 3).join(', ')}
        {names.length > 3 ? ` and ${names.length - 3} more` : ''}.
        {' '}Each person turns sharing on from their own phone.
      </Text>
    </View>
  );
}

/** Today's highlights — recent check-ins and SOS from the circle chat. */
export function HighlightsCard({ highlights, active }: { highlights: Highlight[]; active: GroupRef | null }) {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  const router = useRouter();
  return (
    <>
      {/* design screen 5: section header carries a View All to the
          alerts centre, which is where the full stream already lives. */}
      <View style={st.secHead}>
        <Text accessibilityRole="header" style={[st.secTitle, { color: colors.textDim, flex: 1 }]}>Today&apos;s Highlights</Text>
        <TouchableOpacity onPress={() => active && router.push({ pathname: '/family-alerts', params: { circleId: active.id, circleName: active.name } })} hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
          accessibilityRole="button" accessibilityLabel="View all alerts">
          <Text style={{ color: G.accentText, fontSize: 12.5, fontWeight: '700' }}>View All</Text>
        </TouchableOpacity>
      </View>
      <View style={[st.card, { backgroundColor: G.pane, borderColor: G.edge }]}>
        {highlights.map((h, i) => (
          <View key={`${h.at}:${h.text}`} style={[st.row, { borderColor: G.line }, i === 0 && { borderTopWidth: 0 }]}>
            <Text style={{ fontSize: 16 }}>{h.icon}</Text>
            <Text style={{ flex: 1, color: colors.text, fontSize: 13.5 }} numberOfLines={2}>{h.text}</Text>
            <Text style={{ color: colors.textDim, fontSize: 11 }}>{ago(h.at)}</Text>
          </View>
        ))}
      </View>
    </>
  );
}
