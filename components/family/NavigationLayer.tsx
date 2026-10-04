// components/family/NavigationLayer.tsx — the navigation chrome that floats
// over the Family map.
//
// THE MAP IS THE HERO. Everything here is a thin floating bar pinned to an
// edge; nothing takes the middle of the screen except the arrival card, which
// is the one moment the map has stopped mattering. No full-width panels, no
// stacked cards, no decorative gradients.
//
// SOLID SHEET TONES, NOT TRANSLUCENT GLASS. app/family-map.tsx already
// establishes this rule for itself ("translucent panes over live map tiles
// cost readability and buy nothing") and the hub's expanded roster sheet
// follows it too. A glass maneuver capsule over a dense vector basemap is
// exactly the case where the effect wins a screenshot and loses the road. The
// premium feel here comes from weight, spacing, motion and typography instead.
//
// PRESENTATION ONLY. Every decision this draws — which camera band, what the
// off-route banner says, how a distance is spelled — is computed by
// lib/nav/navPresentation.ts, which is pure and self-checked. This file has no
// thresholds of its own.

import React, { useEffect, useMemo, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../lib/theme';
import { useSpaceGlass } from '../spaces/SpaceGround';
import { SPACE_SHADOW } from '../../constants/spaceTheme';
import { iconFor } from '../nav/NavBanner';
import {
  offRouteBanner, formatDistance, formatEta,
  type CameraPlan,
} from '../../lib/nav/navPresentation';
import type { OffRouteVerdict } from '../../lib/nav/routeProgress';
import type { HapticEvent } from '../../lib/nav/hapticLanguage';

export interface NavigationLayerProps {
  /** False hides the whole layer — the map is then unobstructed. */
  active: boolean;
  /** Next maneuver. */
  event: HapticEvent | null;
  instruction: string;
  roadName: string;
  distanceToManeuverM: number;
  /** Maneuver after next ("Then" chip, spec §17); null unless it follows closely. */
  thenEvent?: HapticEvent | null;
  thenRoadName?: string;
  /** Journey totals. */
  remainingM: number;
  etaSeconds: number;
  destinationName: string;
  /** Engine state. */
  verdict: OffRouteVerdict;
  rerouting: boolean;
  rerouteFailed: boolean;
  arrived: boolean;
  /** Camera / follow. */
  camera: CameraPlan | null;
  following: boolean;
  onFollow: () => void;
  onReroute: () => void;
  onStop: () => void;
  onDone: () => void;
  /** Bottom inset so the dock clears the gesture bar. */
  bottomInset?: number;
  topInset?: number;
}

export default function NavigationLayer(p: NavigationLayerProps) {
  const { colors } = useTheme();
  const G = useSpaceGlass();

  const banner = useMemo(
    () => offRouteBanner(p.verdict, p.rerouting, p.rerouteFailed),
    [p.verdict, p.rerouting, p.rerouteFailed],
  );

  // The capsule slides in from the top when a maneuver appears and slides out
  // when it goes. 220 ms — inside the 150–250 ms the spec asks for, and short
  // enough that it never delays the information it carries.
  const capsuleIn = useRef(new Animated.Value(0)).current;
  const showCapsule = p.active && !p.arrived && !!p.event;
  useEffect(() => {
    Animated.timing(capsuleIn, {
      toValue: showCapsule ? 1 : 0,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [showCapsule, capsuleIn]);

  if (!p.active) return null;

  const topPad = (p.topInset ?? 0) + 8;
  const botPad = (p.bottomInset ?? 0) + 12;

  // ── ARRIVED ── the one moment a card may take the centre, and even then it
  // does not cover the map: it sits above the dock and leaves the route in
  // view, because "where did I actually end up" is the next question.
  if (p.arrived) {
    return (
      <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
        <View pointerEvents="box-none" style={[st.arrivalWrap, { paddingBottom: botPad }]}>
          <View style={[st.arrival, { backgroundColor: G.sheet, borderColor: colors.success }]}>
            <View style={[st.arrivalIcon, { backgroundColor: colors.success + '22' }]}>
              <Ionicons name="flag" size={22} color={colors.success} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[st.arrivalTitle, { color: colors.text }]} numberOfLines={1}>Arrived</Text>
              <Text style={[st.arrivalSub, { color: colors.textDim }]} numberOfLines={1}>
                {p.destinationName}
              </Text>
            </View>
            <TouchableOpacity
              onPress={p.onDone}
              accessibilityRole="button"
              accessibilityLabel="Done, end navigation"
              hitSlop={HIT}
              // Outlined, not a solid #22C55E fill: white on that green is
              // ~2.3:1. goodText on the sheet clears AA in both themes.
              style={[st.arrivalBtn, { backgroundColor: G.paneStrong, borderWidth: 1.5, borderColor: colors.success }]}
            >
              <Text style={[st.arrivalBtnTxt, { color: G.goodText }]}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }

  return (
    // box-none everywhere: the map must keep receiving pans and pinches
    // everywhere the chrome is not actually drawn.
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>

      {/* ── TOP: maneuver capsule ── */}
      <Animated.View
        pointerEvents="box-none"
        style={[
          st.topWrap,
          { paddingTop: topPad },
          {
            opacity: capsuleIn,
            transform: [{
              translateY: capsuleIn.interpolate({ inputRange: [0, 1], outputRange: [-24, 0] }),
            }],
          },
        ]}
      >
        {showCapsule && (
          <View
            style={[st.capsule, { backgroundColor: G.sheet, borderColor: G.edge }]}
            accessibilityRole="header"
            accessibilityLabel={`${p.instruction} in ${formatDistance(p.distanceToManeuverM)}${p.roadName ? `, ${p.roadName}` : ''}`}
          >
            <View style={[st.capsuleIcon, { backgroundColor: colors.primary + '22' }]}>
              <Ionicons name={iconFor(p.event)} size={26} color={colors.primary} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              {/* Distance leads: at 40 km/h the number changes every second and
                  is what the eye returns to; the street name is confirmation. */}
              <Text style={[st.capsuleDist, { color: colors.text }]} numberOfLines={1}>
                {formatDistance(p.distanceToManeuverM)}
              </Text>
              <Text style={[st.capsuleRoad, { color: colors.textDim }]} numberOfLines={1}>
                {p.roadName || p.instruction}
              </Text>
            </View>
          </View>
        )}

        {showCapsule && !!p.thenEvent && (
          <View
            style={[st.thenChip, { backgroundColor: G.sheet, borderColor: G.edge }]}
            accessible
            accessibilityLabel={`Then ${p.thenRoadName || 'the next turn'}`}
          >
            <Text style={[st.thenTxt, { color: colors.textDim }]}>Then</Text>
            <Ionicons name={iconFor(p.thenEvent)} size={18} color={colors.primary} />
            {!!p.thenRoadName && (
              <Text style={[st.thenTxt, { color: colors.text, flexShrink: 1 }]} numberOfLines={1}>{p.thenRoadName}</Text>
            )}
          </View>
        )}

        {/* Off-route banner, directly under the capsule so both read as one
            stack rather than as chrome scattered around the screen. */}
        {!!banner.text && (
          <View
            style={[st.offRoute, {
              backgroundColor: G.sheet,
              borderColor: banner.tone === 'warn' ? colors.danger : G.edge,
            }]}
            accessibilityLiveRegion="polite"
            accessibilityLabel={banner.text}
          >
            {banner.busy
              ? <ActivityIndicator size="small" color={colors.primary} />
              : <Ionicons name="alert-circle" size={16} color={G.dangerText} />}
            <Text
              style={[st.offRouteTxt, { color: banner.tone === 'warn' ? G.dangerText : colors.text }]}
              numberOfLines={1}
            >
              {banner.text}
            </Text>
            {banner.showRerouteButton && (
              <TouchableOpacity
                onPress={p.onReroute}
                accessibilityRole="button"
                accessibilityLabel="Recalculate the route"
                hitSlop={HIT}
                style={[st.offRouteBtn, { backgroundColor: colors.primary }]}
              >
                <Text style={[st.offRouteBtnTxt, { color: colors.onPrimary }]}>Reroute</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </Animated.View>

      {/* ── FOLLOW: only while the camera is NOT following, i.e. only after the
          user has panned away themselves. It never fights a gesture — it waits
          to be asked (spec §15). ── */}
      {!p.following && (
        <View pointerEvents="box-none" style={[st.followWrap, { paddingBottom: botPad + 92 }]}>
          <TouchableOpacity
            onPress={p.onFollow}
            accessibilityRole="button"
            accessibilityLabel="Resume following your position"
            hitSlop={HIT}
            style={[st.follow, { backgroundColor: G.sheet, borderColor: colors.primary }]}
          >
            <Ionicons name="navigate" size={16} color={colors.primary} />
            <Text style={[st.followTxt, { color: G.accentText }]}>Follow</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── BOTTOM: navigation dock ── */}
      <View pointerEvents="box-none" style={[st.dockWrap, { paddingBottom: botPad }]}>
        <View style={[st.dock, { backgroundColor: G.sheet, borderColor: G.edge }]}>
          <View style={{ flex: 1, minWidth: 0 }}>
            {/* The number the whole screen exists to show. Tabular figures so
                it does not jitter horizontally as digits change. */}
            <Text style={[st.dockDist, { color: colors.text }]} numberOfLines={1}>
              {formatDistance(p.remainingM)}
            </Text>
            <Text style={[st.dockSub, { color: colors.textDim }]} numberOfLines={1}>
              {formatEta(p.etaSeconds)} · {p.destinationName}
            </Text>
          </View>

          <TouchableOpacity
            onPress={p.onReroute}
            accessibilityRole="button"
            accessibilityLabel="Recalculate the route"
            hitSlop={HIT}
            style={[st.dockBtn, { borderColor: G.chipEdge }]}
            disabled={p.rerouting}
          >
            {p.rerouting
              ? <ActivityIndicator size="small" color={colors.primary} />
              : <Ionicons name="refresh" size={19} color={colors.text} />}
          </TouchableOpacity>

          <TouchableOpacity
            onPress={p.onStop}
            accessibilityRole="button"
            accessibilityLabel="End navigation"
            hitSlop={HIT}
            style={[st.dockBtn, { borderColor: colors.danger + '55', backgroundColor: colors.danger + '18' }]}
          >
            <Ionicons name="close" size={19} color={G.dangerText} />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const HIT = { top: 10, bottom: 10, left: 10, right: 10 };

const st = StyleSheet.create({
  // Edges only — the middle band of the screen is left entirely to the map.
  topWrap: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 12, gap: 8 },
  dockWrap: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingHorizontal: 12 },
  followWrap: { position: 'absolute', bottom: 0, right: 0, paddingHorizontal: 12, alignItems: 'flex-end' },

  capsule: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14, paddingVertical: 12,
    borderRadius: 22, borderWidth: 1, ...SPACE_SHADOW.raised,
  },
  capsuleIcon: { width: 46, height: 46, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  // 26px: readable in a windscreen mount at a glance, which is the actual
  // viewing distance this line is designed for.
  capsuleDist: { fontSize: 26, lineHeight: 30, fontWeight: '800', fontVariant: ['tabular-nums'], letterSpacing: -0.5 },
  capsuleRoad: { fontSize: 13.5, marginTop: 1 },
  thenChip: {
    alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, minHeight: 34, borderRadius: 14, borderWidth: 1, ...SPACE_SHADOW.rest,
  },
  thenTxt: { fontSize: 13.5, fontWeight: '700' },

  offRoute: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, minHeight: 42,
    borderRadius: 14, borderWidth: 1, ...SPACE_SHADOW.rest,
  },
  offRouteTxt: { flex: 1, fontSize: 13.5, fontWeight: '600' },
  offRouteBtn: { paddingHorizontal: 12, minHeight: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  offRouteBtnTxt: { fontSize: 12.5, fontWeight: '800' },

  follow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, minHeight: 40, borderRadius: 999, borderWidth: 1.5,
    ...SPACE_SHADOW.raised,
  },
  followTxt: { fontSize: 13.5, fontWeight: '800' },

  dock: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 16, paddingVertical: 12,
    borderRadius: 24, borderWidth: 1, ...SPACE_SHADOW.raised,
  },
  dockDist: { fontSize: 24, lineHeight: 28, fontWeight: '800', fontVariant: ['tabular-nums'], letterSpacing: -0.5 },
  dockSub: { fontSize: 12.5, marginTop: 1 },
  // 44dp square: the one-handed reachability floor, and these two sit at the
  // bottom-right corner where a thumb actually lands.
  dockBtn: { width: 44, height: 44, borderRadius: 15, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },

  arrivalWrap: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingHorizontal: 12 },
  arrival: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingVertical: 14,
    borderRadius: 24, borderWidth: 1.5, ...SPACE_SHADOW.raised,
  },
  arrivalIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  arrivalTitle: { fontSize: 18, fontWeight: '800' },
  arrivalSub: { fontSize: 13 },
  arrivalBtn: { paddingHorizontal: 18, minHeight: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  arrivalBtnTxt: { fontSize: 14.5, fontWeight: '800' },
});
