// app/split-chat.tsx — two conversations on screen at once.
//
// A phone cannot hold two readable columns side by side, so the panes stack:
// one above the other, separated by a divider you can drag. Each pane is a full
// chat screen in its own right, so anything that works in a single chat (typing,
// attachments, opening a file) works in either half.

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  Dimensions,
  PanResponder,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { BRAND_ACCENT } from '../constants/theme';
import SplitChatPane from '../components/chat/SplitChatPane';

const { height: SH } = Dimensions.get('window');

const C = {
  bg: '#080710',
  text: '#FFFFFF',
  dim: 'rgba(255,255,255,0.58)',
  faint: 'rgba(255,255,255,0.30)',
  line: 'rgba(255,255,255,0.10)',
  accent: BRAND_ACCENT,
  accentSoft: 'rgba(124,77,255,0.16)',
  accentLine: 'rgba(124,77,255,0.45)',
  panel: 'rgba(255,255,255,0.05)',
};

const BAR_H = 52;
const DIVIDER_H = 26;
/** Never shrink a pane past this — its header and composer must stay usable. */
const MIN_RATIO = 0.22;
const MAX_RATIO = 0.78;
const SNAPS = [0.3, 0.5, 0.7];
/** Snap when the drag lands within this distance of a snap point. */
const SNAP_TOLERANCE = 0.04;

export default function SplitChatScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    topId?: string; topName?: string;
    bottomId?: string; bottomName?: string;
  }>();

  // Pane identities live in state so "swap" is a pure state change — no
  // remount, so both conversations keep their scroll position and drafts.
  const [top, setTop] = useState({
    id: (params.topId ?? '') as string,
    name: (params.topName ?? 'Chat') as string,
  });
  const [bottom, setBottom] = useState({
    id: (params.bottomId ?? '') as string,
    name: (params.bottomName ?? 'Chat') as string,
  });

  const [ratio, setRatio] = useState(0.5);
  const [dragging, setDragging] = useState(false);
  const ratioRef = useRef(0.5);
  const availableRef = useRef(SH - BAR_H - DIVIDER_H);

  const onLayout = useCallback((e: any) => {
    availableRef.current = Math.max(1, e.nativeEvent.layout.height - DIVIDER_H);
  }, []);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 2,
        onPanResponderGrant: () => setDragging(true),
        onPanResponderMove: (_e, g) => {
          const delta = g.dy / availableRef.current;
          const next = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratioRef.current + delta));
          setRatio(next);
        },
        onPanResponderRelease: () => {
          // Settle onto a snap point when the finger lands close to one.
          const snapped = SNAPS.find((s) => Math.abs(s - ratioRef.current) < SNAP_TOLERANCE);
          const final = snapped ?? ratioRef.current;
          ratioRef.current = final;
          setRatio(final);
          setDragging(false);
        },
        onPanResponderTerminate: () => setDragging(false),
      }),
    []
  );

  // Keep the ref in step so the next drag starts from where this one ended.
  ratioRef.current = ratio;

  const swap = useCallback(() => {
    setTop(bottom);
    setBottom(top);
    setRatio((r) => 1 - r);
  }, [top, bottom]);

  const close = useCallback(() => {
    // Leaving the split returns to the pane the user was reading on top.
    router.replace({ pathname: '/chat', params: { id: top.id } } as any);
  }, [router, top.id]);

  const pct = (v: number) => `${Math.round(v * 100)}%`;

  return (
    <View style={s.root}>
      <Stack.Screen options={{ headerShown: false, animation: 'fade' }} />
      <StatusBar barStyle="light-content" />

      {/* Split control bar */}
      <View style={s.bar}>
        <View style={s.badge}>
          <Ionicons name="git-compare-outline" size={14} color={C.accent} />
          <Text style={s.badgeText}>Split view</Text>
        </View>
        <Text style={s.ratioText}>
          Stacked · {pct(ratio)} / {pct(1 - ratio)}
        </Text>
        <View style={s.barActions}>
          <TouchableOpacity onPress={swap} style={s.iconBtn} activeOpacity={0.8} accessibilityLabel="Swap panes">
            <Ionicons name="swap-vertical" size={19} color={C.text} />
          </TouchableOpacity>
          <TouchableOpacity onPress={close} style={s.iconBtn} activeOpacity={0.8} accessibilityLabel="Close split view">
            <Ionicons name="close" size={20} color={C.text} />
          </TouchableOpacity>
        </View>
      </View>

      <View style={s.panes} onLayout={onLayout}>
        <View style={{ flex: ratio }}>
          <SplitChatPane chatId={top.id} title={top.name} share={pct(ratio)} />
        </View>

        {/* Drag handle */}
        <View {...pan.panHandlers} style={[s.divider, dragging && s.dividerActive]}>
          <View style={[s.grip, dragging && s.gripActive]} />
          {dragging ? (
            <View style={s.dragPill}>
              <Text style={s.dragPillText}>
                {pct(ratio)} · {pct(1 - ratio)}
              </Text>
            </View>
          ) : null}
        </View>

        <View style={{ flex: 1 - ratio }}>
          <SplitChatPane chatId={bottom.id} title={bottom.name} share={pct(1 - ratio)} />
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg, paddingTop: Platform.OS === 'ios' ? 54 : (StatusBar.currentHeight ?? 24) },

  bar: {
    height: BAR_H,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.line,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: C.accentSoft,
    borderWidth: 1,
    borderColor: C.accentLine,
  },
  badgeText: { color: C.accent, fontSize: 12.5, fontWeight: '700' },
  ratioText: { color: C.faint, fontSize: 12, fontVariant: ['tabular-nums'] },
  barActions: { flexDirection: 'row', gap: 6, marginLeft: 'auto' },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.panel,
    borderWidth: 1,
    borderColor: C.line,
  },

  panes: { flex: 1 },

  divider: {
    height: DIVIDER_H,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(20,18,34,0.85)',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: C.line,
  },
  dividerActive: { backgroundColor: C.accentSoft, borderColor: C.accentLine },
  grip: { width: 46, height: 4, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.28)' },
  gripActive: { backgroundColor: C.accent, width: 58 },
  dragPill: {
    position: 'absolute',
    top: -34,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: '#1F1D30',
    borderWidth: 1,
    borderColor: C.accentLine,
  },
  dragPillText: { color: C.text, fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
