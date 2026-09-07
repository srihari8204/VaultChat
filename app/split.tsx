// app/split.tsx — Split view: two chats at once.
//
// Design: docs/design/screens 04-split-vertical, 05-split-resize,
// 06-split-horizontal (mobile: m04-split, m05-split-resize, m06-split-swap).
//
// Each pane is the REAL app/chat.tsx, embedded via its chatIdProp — not a
// reduced copy. That is deliberate: a second implementation of the message
// thread would drift from the first within a release, and every fix would have
// to be made twice (the call stack in this repo is the cautionary tale).
//
// Axis is chosen by the window, not by the device name (lib/responsive):
//   wide enough for two panes  -> side by side, the designed layout
//   tall and narrow (phone portrait) -> stacked
//   neither -> the screen refuses and sends you back with an explanation
// so a phone gets split view in landscape and a tablet gets it always, from one
// code path and with no device list to maintain.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PanResponder, Platform, StyleSheet, Text, TouchableOpacity, View,
  useWindowDimensions,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../lib/theme';
import { brandAlpha } from '../constants/theme';
import { DIVIDER_DP, clampRatio, paneSizes, preferredAxis } from '../lib/responsive';
import ChatScreen from './chat';

/** Control-bar height. Shared by the style below and the pane maths, so the
 *  two can never disagree the way they did when 40 was hard-coded in one. */
const BAR_H = 40;

export default function SplitScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { width, height } = useWindowDimensions();
  const params = useLocalSearchParams<{ a?: string; b?: string }>();

  const [left, setLeft] = useState((params.a ?? '') + '');
  const [right, setRight] = useState((params.b ?? '') + '');
  const [ratio, setRatio] = useState(0.5);
  const ratioAtGrab = useRef(0.5);

  // Space actually available to the panes, excluding the system insets, so a
  // notch or gesture bar cannot push a pane under the minimum.
  //
  // BAR_H is subtracted for a stacked split: the control bar sits ABOVE the
  // panes and consumes real height, so sizing them against the full window
  // handed out 40dp that did not exist and pushed the bottom pane's composer
  // off-screen. It costs nothing side-by-side, where the bar is not on the
  // panes' axis — hence the axis check rather than a blanket subtraction.
  const usableH = height - insets.top - insets.bottom - BAR_H;
  const axis = preferredAxis(width, usableH);
  const total = axis === 'vertical' ? width : usableH;
  const sizes = useMemo(() => paneSizes(ratio, total), [ratio, total]);

  // Re-clamp when the window changes (rotation, fold, multi-window resize).
  // A ratio that was legal in landscape can put a pane under the readable
  // minimum in portrait; without this the split silently keeps the stale split
  // point and one pane collapses.
  useEffect(() => {
    setRatio(r => {
      const next = clampRatio(r, total);
      return next === r ? r : next;
    });
  }, [total, axis]);

  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { ratioAtGrab.current = ratio; },
    onPanResponderMove: (_e, g) => {
      const delta = axis === 'vertical' ? g.dx : g.dy;
      // clampRatio is what stops a drag from collapsing a pane; it is unit
      // tested in lib/responsive.selftest.ts against real device sizes.
      setRatio(clampRatio(ratioAtGrab.current + delta / Math.max(1, total - DIVIDER_DP), total));
    },
  }), [axis, ratio, total]);

  const swap = useCallback(() => {
    setLeft(right); setRight(left);
    setRatio(r => clampRatio(1 - r, total));
  }, [left, right, total]);

  const closeSplit = useCallback(() => {
    router.replace({ pathname: '/chat', params: { id: left } });
  }, [router, left]);

  // ── Refusals, stated plainly rather than rendering something broken ──
  if (!left || !right) {
    return <Refusal colors={colors} title="Split view needs two chats"
      body="Open a chat, then pick 'Open in split' on a second one." onBack={() => router.back()} />;
  }
  if (!axis) {
    return <Refusal colors={colors} title="Not enough room to split"
      body="Rotate the device, or use a larger screen. Two chats need room for both to stay readable."
      onBack={() => router.back()} />;
  }

  const vertical = axis === 'vertical';

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Split control bar — swap / close, per the design's pane header */}
      <View style={[st.bar, { borderBottomColor: colors.glassStroke }]}>
        <Ionicons name={vertical ? 'tablet-landscape-outline' : 'phone-portrait-outline'} size={15} color={colors.textDim} />
        <Text style={[st.barTxt, { color: colors.textDim }]}>Split view</Text>
        <View style={{ flex: 1 }} />
        <TouchableOpacity onPress={swap} hitSlop={10} style={st.barBtn}>
          <Ionicons name="swap-horizontal" size={17} color={colors.text} />
          <Text style={[st.barBtnTxt, { color: colors.text }]}>Swap</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={closeSplit} hitSlop={10} style={st.barBtn}>
          <Ionicons name="close" size={17} color={colors.text} />
          <Text style={[st.barBtnTxt, { color: colors.text }]}>Close</Text>
        </TouchableOpacity>
      </View>

      <View style={{ flex: 1, flexDirection: vertical ? 'row' : 'column' }}>
        <View style={vertical ? { width: sizes.a } : { height: sizes.a }}>
          <ChatScreen chatIdProp={left} embedded />
        </View>

        {/* Divider — the drag target. Kept at DIVIDER_DP so the hit area matches
            what lib/responsive reserved when sizing the panes. */}
        <View
          {...pan.panHandlers}
          style={[
            vertical ? { width: DIVIDER_DP } : { height: DIVIDER_DP },
            st.divider,
            { backgroundColor: brandAlpha(0.10) },
          ]}
        >
          <View style={[
            st.grip,
            vertical ? { width: 3, height: 34 } : { width: 34, height: 3 },
            { backgroundColor: brandAlpha(0.55) },
          ]} />
        </View>

        <View style={vertical ? { width: sizes.b } : { height: sizes.b }}>
          <ChatScreen chatIdProp={right} embedded />
        </View>
      </View>
    </View>
  );
}

function Refusal({ title, body, onBack, colors }: {
  title: string; body: string; onBack: () => void; colors: any;
}) {
  return (
    <View style={[st.refusal, { backgroundColor: colors.bg }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <Ionicons name="git-compare-outline" size={44} color={colors.textDim} />
      <Text numberOfLines={1} style={[st.refusalTitle, { color: colors.text }]}>{title}</Text>
      <Text style={[st.refusalBody, { color: colors.textDim }]}>{body}</Text>
      <TouchableOpacity onPress={onBack} style={[st.refusalBtn, { borderColor: colors.glassStroke }]}>
        <Text style={{ color: colors.text, fontWeight: '700' }}>Go back</Text>
      </TouchableOpacity>
    </View>
  );
}

const st = StyleSheet.create({
  bar: {
    height: BAR_H, flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  barTxt: { fontSize: 12, fontWeight: '700', letterSpacing: 0.4 },
  barBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4 },
  barBtnTxt: { fontSize: 12, fontWeight: '600' },
  divider: { alignItems: 'center', justifyContent: 'center' },
  grip: { borderRadius: 2 },
  refusal: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  refusalTitle: { fontSize: 18, fontWeight: '800', marginTop: 6 },
  refusalBody: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  refusalBtn: { marginTop: 14, paddingVertical: 12, paddingHorizontal: 26, borderRadius: 12, borderWidth: 1 },
});
