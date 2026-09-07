// components/family/SelectedMemberSheet.tsx — what you get when you tap a
// family member on the map.
//
// Before this, tapping a marker only centred the camera (setFocusId) and every
// action lived as a 12px text link on a roster row 900px lower on the screen.
// This is the same three actions — Route, Follow, Chat — at the point of
// selection, plus Navigate once a route to them is drawn.
//
// PRESENTATION ONLY. It owns no state and fetches nothing: distance, freshness
// and the routed/following flags are handed in by app/family-map.tsx, which
// already computes every one of them for the roster. Wiring them a second way
// here would be two sources of truth for "how far is Mom".
//
// SOLID SHEET TONE over the map, not glass — the same rule NavigationLayer and
// this screen's roster follow: translucency over dense map tiles costs the
// road and buys a screenshot.

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../lib/theme';
import { useSpaceGlass } from '../spaces/SpaceGround';
import { SPACE_SHADOW } from '../../constants/spaceTheme';

export interface SelectedMemberSheetProps {
  name: string;
  /** "2.4 km from You" / "16 km • 19 min by road" — already formatted. */
  distanceLine: string | null;
  /** "LIVE" / "5 min ago" / "Sharing off · last seen 4 h ago" — already formatted. */
  statusLine: string;
  live: boolean;
  /** No usable fix: Route/Follow/Navigate are withheld rather than offered and failed. */
  locatable: boolean;
  routed: boolean;
  routeBusy: boolean;
  following: boolean;
  chatBusy: boolean;
  onRoute: () => void;
  onFollow: () => void;
  onChat: () => void;
  /** Present only when a route TO this member is drawn (me → them). */
  onNavigate?: () => void;
  onClose: () => void;
  bottomInset?: number;
}

const HIT = { top: 8, bottom: 8, left: 8, right: 8 };

export default function SelectedMemberSheet(p: SelectedMemberSheetProps) {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  const initial = (p.name || '?').trim()[0]?.toUpperCase() ?? '?';

  const action = (
    icon: React.ComponentProps<typeof Ionicons>['name'],
    label: string,
    onPress: () => void,
    opts: { on?: boolean; busy?: boolean; disabled?: boolean; a11y: string },
  ) => (
    <TouchableOpacity
      onPress={onPress}
      disabled={opts.disabled || opts.busy}
      accessibilityRole="button"
      accessibilityLabel={opts.a11y}
      accessibilityState={{ selected: !!opts.on, disabled: !!opts.disabled }}
      hitSlop={HIT}
      style={[st.action, {
        borderColor: opts.on ? colors.primary : G.chipEdge,
        backgroundColor: opts.on ? colors.primary + '22' : G.paneFaint,
        opacity: opts.disabled ? 0.45 : 1,
      }]}
    >
      {opts.busy
        ? <ActivityIndicator size="small" color={colors.primary} />
        : <Ionicons name={icon} size={18} color={opts.on ? colors.primary : colors.text} />}
      <Text style={[st.actionTxt, { color: opts.on ? G.accentText : colors.text }]}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <View
      style={[st.sheet, { backgroundColor: G.sheet, borderColor: G.edge, paddingBottom: 12 + (p.bottomInset ?? 0) }]}
      accessibilityViewIsModal={false}
    >
      <View style={st.head}>
        <View style={[st.avatar, { backgroundColor: colors.primary + '33' }]}>
          <Text style={[st.avatarTxt, { color: G.accentText }]}>{initial}</Text>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[st.name, { color: colors.text }]} numberOfLines={1}>{p.name}</Text>
          {/* Distance leads when known — it is the reason the sheet was opened. */}
          {p.distanceLine
            ? <Text style={[st.dist, { color: colors.text }]} numberOfLines={1}>{p.distanceLine}</Text>
            : null}
          <Text style={[st.status, { color: p.live ? G.goodText : colors.textDim }]} numberOfLines={1}>
            {p.live ? '● ' : '○ '}{p.statusLine}
          </Text>
        </View>
        <TouchableOpacity
          onPress={p.onClose}
          accessibilityRole="button"
          accessibilityLabel="Close member details"
          hitSlop={HIT}
          style={[st.close, { borderColor: G.chipEdge }]}
        >
          <Ionicons name="close" size={18} color={colors.textDim} />
        </TouchableOpacity>
      </View>

      <View style={st.actions}>
        {action('navigate-circle-outline', p.routed ? 'Routed' : 'Route', p.onRoute,
          { on: p.routed, busy: p.routeBusy, disabled: !p.locatable,
            a11y: p.routed ? `Clear the route to ${p.name}` : `Show the road route to ${p.name}` })}
        {action('locate-outline', p.following ? 'Following' : 'Follow', p.onFollow,
          { on: p.following, disabled: !p.locatable,
            a11y: p.following ? `Stop following ${p.name}` : `Follow ${p.name} on the map` })}
        {action('chatbubble-outline', 'Chat', p.onChat,
          { busy: p.chatBusy, a11y: `Open a chat with ${p.name}` })}
      </View>

      {/* Navigate is a PRIMARY action and only appears once there is a route
          to navigate — offering it earlier would start a session against a
          destination the user has not yet seen drawn. */}
      {p.onNavigate && (
        <TouchableOpacity
          onPress={p.onNavigate}
          accessibilityRole="button"
          accessibilityLabel={`Start navigation to ${p.name}`}
          hitSlop={HIT}
          style={[st.primary, { backgroundColor: colors.primary }]}
        >
          <Ionicons name="navigate" size={17} color="#fff" />
          <Text style={st.primaryTxt}>Start navigation</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1,
    paddingHorizontal: 16, paddingTop: 14, gap: 12, ...SPACE_SHADOW.raised,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  avatarTxt: { fontSize: 18, fontWeight: '800' },
  name: { fontSize: 17, fontWeight: '800' },
  dist: { fontSize: 14, fontWeight: '700', marginTop: 1, fontVariant: ['tabular-nums'] },
  status: { fontSize: 12.5, marginTop: 1 },
  close: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', gap: 8 },
  // 44dp minimum, three across, equal width — a thumb lands on any of them.
  action: {
    flex: 1, minHeight: 44, borderRadius: 14, borderWidth: 1,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
  },
  actionTxt: { fontSize: 13.5, fontWeight: '700' },
  primary: {
    minHeight: 48, borderRadius: 16,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  primaryTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },
});
