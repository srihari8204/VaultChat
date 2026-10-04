// components/family/MemberSections.tsx — the drawn parts of the member detail
// screen, moved out of app/family-member.tsx unchanged: the identity card, the
// rows of today's activity, the latest-fix diagnostics row and one Safe Zones
// row. The screen keeps every gate (withheld / not loaded), every fetch and
// the section headings; these only render what they are handed.

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppText as Text } from '../ui/Text';
import { useTheme } from '../../lib/theme';
import { brandAlpha } from '../../constants/theme';
import { useSpaceGlass } from '../spaces/SpaceGround';
import { SPACE_SHADOW } from '../../constants/spaceTheme';
import { timeAtPlace, type TrackSample } from '../../lib/family/history';
import { type FamilyAlert } from '../../lib/family/alerts';
import { type Geofence } from '../../lib/family/geofence';
import { type Freshness } from '../../lib/family/status';
import { haversine } from '../../lib/nav/geo';
import { classifyDistance, zoneColor } from '../../lib/lock/zoneMachine';
import { fmtSpeed, gpsQuality, QUALITY_LABEL, QUALITY_COLOR } from '../../lib/lock/format';
import { initialOf } from '../../lib/format';
import { colorFor, ago, AVATAR_INK } from '../../lib/family/memberFormat';
import { formatMetres as dist } from '../../lib/family/distance';
import { tint } from '../../lib/tintColor';

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const ICON_FOR: Record<string, keyof typeof Ionicons.glyphMap> = {
  enter: 'enter-outline', leave: 'exit-outline', sos: 'alert-circle',
  checkin: 'checkmark-done-circle', battery: 'battery-dead', sharing: 'navigate-circle',
};

/** Avatar, name, the honest freshness line and the battery figure. */
export function MemberIdentityCard({ name, userId, isGuardian, withheld, unknown, tier, last, currentPlace }: {
  name: string;
  userId: string;
  isGuardian: boolean;
  withheld: boolean;
  unknown: boolean;
  tier: Freshness;
  last: TrackSample | null;
  currentPlace: Geofence | null;
}) {
  const { colors, scheme } = useTheme();
  const G = useSpaceGlass();
  const fresh = tier === 'live';
  return (
    <View style={[st.card, { backgroundColor: G.paneStrong, borderColor: G.edge }]}>
      <View style={[st.avatar, { backgroundColor: colorFor(userId) }]}>
        <Text style={[st.avatarTxt, { color: AVATAR_INK[scheme] }]}>{initialOf(name)}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={{ color: colors.text, fontSize: 17, fontWeight: '800' }} numberOfLines={1}>{name}</Text>
          {isGuardian && <Ionicons name="star" size={13} color={colors.primary} accessible accessibilityLabel="Guardian" />}
        </View>
        <Text style={{ color: fresh ? G.goodText : colors.textDim, fontSize: 12.5, marginTop: 2 }}>
          {withheld ? 'Location not shared with you'
            : unknown ? 'Location not loaded'
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
  );
}

/** Today's arrivals, departures and check-ins for this member, or the empty line. */
export function MemberActivityList({ activity }: { activity: FamilyAlert[] }) {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  if (activity.length === 0) {
    return (
      <Text style={{ color: colors.textDim, fontSize: 13.5 }}>
        Nothing yet today. Arrivals, departures and check-ins show up here.
      </Text>
    );
  }
  return (
    <>
      {activity.map((a) => (
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
    </>
  );
}

/** Location diagnostics (v3) — same data language as the lock engine. */
export function MemberFixRow({ last }: { last: TrackSample }) {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  return (
    <View style={[st.evt, { borderColor: G.line }]}>
      <View style={[st.evtIcon, { backgroundColor: brandAlpha(0.1) }]}>
        <Ionicons name="speedometer" size={15} color={colors.primary} />
      </View>
      <Text style={{ color: colors.text, fontSize: 13.5, flex: 1 }}>
        {fmtSpeed((last.spd ?? 0) * 3.6)} · updated {ago(last.ts)}
        {last.bat != null ? ` · battery ${Math.round(last.bat)}%` : ''}
      </Text>
      {last.acc != null && (
        <View style={{ borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, backgroundColor: tint(QUALITY_COLOR[gpsQuality(last.acc)], 0.13) }}>
          <Text style={{ color: colors.text, fontSize: 11, fontWeight: '800' }}>
            GPS {QUALITY_LABEL[gpsQuality(last.acc)].toUpperCase()} ±{Math.round(last.acc)}m
          </Text>
        </View>
      )}
    </View>
  );
}

/** One Safe Zones row: zone status per place from the SHARED classifier, so a
 *  member's chip means exactly what Navigate's lock states mean. */
export function MemberPlaceRow({ place: p, here, last, fresh, today, roadM }: {
  place: Geofence;
  /** The member is sitting in this place right now. */
  here: boolean;
  last: TrackSample | null;
  fresh: boolean;
  today: TrackSample[];
  /** Road distance from the member's last fix, when the router answered. */
  roadM: number | undefined;
}) {
  const { colors } = useTheme();
  const G = useSpaceGlass();
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
    <View style={[st.evt, { borderColor: G.line }]}>
      <View style={[st.evtIcon, { backgroundColor: tint(here ? colors.success : colors.textFaint, 0.13) }]}>
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
          {roadM != null ? ` · ${dist(roadM)} by road` : ''}
          {tpTxt}
        </Text>
      </View>
      {zoneLabel && (
        <View style={{ borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, backgroundColor: tint(zc, 0.13) }}>
          <Text style={{ color: colors.text, fontSize: 11, fontWeight: '800' }}>{zoneLabel}</Text>
        </View>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: 22, padding: 16, ...SPACE_SHADOW.raised },
  avatar: { width: 50, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center' },
  avatarTxt: { fontWeight: '800', fontSize: 20 },
  evt: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth },
  evtIcon: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
});
