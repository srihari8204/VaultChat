// components/family/HubTop.tsx — the top of the Family hub dashboard, moved out
// of app/family.tsx unchanged: greeting + alerts bell, the space switcher, the
// pinned announcement and the status card. Also the loading skeleton, drawn in
// the same shapes so the layout does not jump when content arrives.

import React from 'react';
import { View, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { AppText as Text } from '../ui/Text';
import SpaceGround, { useSpaceGlass } from '../spaces/SpaceGround';
import { useTheme } from '../../lib/theme';
import { groupIdentity } from '../../lib/groups/catalog';
import { type GroupRef } from '../../lib/groups/store';
import { initialOf } from '../../lib/format';
import { colorFor, ago, AVATAR_INK } from '../../lib/family/memberFormat';
import { type CircleMember } from '../../lib/family/types';
import { st } from './hubStyles';
import { tint } from '../../lib/tintColor';

function greeting(): string {
  const h = new Date().getHours();
  // Local device time on purpose: a family dashboard is a local object, and
  // "good morning" is about the light outside the window, not a server clock.
  // The small-hours branch matters — this screen gets opened at 2am by someone
  // checking whether a teenager got home, and "Good evening" reads as wrong.
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 21) return 'Good evening';
  return 'Good night';
}

/** Static glass skeleton in the dashboard's own shapes. */
export function HubSkeleton() {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  return (
    <View style={[st.screen, { backgroundColor: G.bgMid }]} accessible accessibilityLabel="Loading your spaces" accessibilityState={{ busy: true }}>
      <SpaceGround />
      {/* Deliberately unanimated — this gate is one local settings read, and a
          shimmer loop spends GPU on a state that lasts under a second. The
          spinner in the map slot is the only motion. */}
      <View style={st.dash}>
        <View style={[st.skel, { width: '55%', height: 30, borderRadius: 10, backgroundColor: G.paneFaint, borderColor: G.edge }]} />
        <View style={[st.skel, { width: '35%', height: 14, borderRadius: 7, marginTop: 8, backgroundColor: G.paneFaint, borderColor: G.edge }]} />
        <View style={[st.skel, { height: 76, borderRadius: 22, marginTop: 20, backgroundColor: G.pane, borderColor: G.edge }]} />
        <View style={[st.skel, { height: 300, borderRadius: 24, marginTop: 12, backgroundColor: G.paneFaint, borderColor: G.edge, alignItems: 'center', justifyContent: 'center' }]}>
          <ActivityIndicator color={colors.primary} />
        </View>
        {/* Same wrap metrics as the real quick-action grid, so the layout
            does not jump when content arrives on a narrow screen. */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
          {[0, 1, 2].map((k) => (
            <View key={k} style={[st.skel, { flexBasis: '30%', flexGrow: 1, minWidth: 100, height: 92, borderRadius: 18, backgroundColor: G.paneFaint, borderColor: G.edge }]} />
          ))}
        </View>
      </View>
    </View>
  );
}

/** "Couldn't load members" + Retry, or "Loading members…" — never a fabricated roster. */
export function RosterLoadState({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 }} accessibilityLiveRegion="polite">
      <Text style={{ color: colors.textDim, fontSize: 12.5, flex: 1 }}>
        {failed ? 'Couldn’t load members' : 'Loading members…'}
      </Text>
      {failed && (
        <TouchableOpacity
          onPress={onRetry}
          accessibilityRole="button" accessibilityLabel="Retry loading members"
          hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
        >
          <Text style={{ color: G.accentText, fontSize: 12.5, fontWeight: '800' }}>Retry</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

export default function HubTop({
  firstName, active, circles, onSelect, unread, announcement,
  allGood, membersLoaded, membersFailed, liveCount, roster, sharingOn, presentIds, onRetryMembers,
}: {
  firstName: string;
  active: GroupRef | null;
  circles: GroupRef[];
  onSelect: (g: GroupRef) => void;
  unread: number;
  announcement: { text: string; at: number } | null;
  allGood: boolean;
  membersLoaded: boolean;
  membersFailed: boolean;
  liveCount: number;
  roster: CircleMember[];
  sharingOn: boolean;
  /** Members this device holds a position for (their avatars draw solid). */
  presentIds: Set<string>;
  onRetryMembers: () => void;
}) {
  const { colors, scheme } = useTheme();
  const G = useSpaceGlass();
  const router = useRouter();
  const ident = groupIdentity(active ?? {});
  return (
    <>
      {/* greeting (design screen 5) — the bell is the one thing the mockup
          adds here: a standing route to the alerts centre with an unread
          dot, so a new alert is visible without opening a tile. */}
      <View style={st.greetRow}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text accessibilityRole="header" style={{ color: colors.text, fontSize: 28, lineHeight: 34, fontWeight: '800', letterSpacing: -0.4 }}>
            {greeting()}, {firstName} 👋
          </Text>
          <Text style={{ color: colors.textDim, fontSize: 13, marginTop: 3 }} numberOfLines={1}>
            {active?.name}{active?.groupType && ident.label !== active.name ? ` · ${ident.label}` : ''}
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => active && router.push({ pathname: '/family-alerts', params: { circleId: active.id, circleName: active.name } })}
          style={[st.greetBell, { backgroundColor: G.pane, borderColor: G.edge }]}
          accessibilityRole="button"
          accessibilityLabel={`Alerts${unread > 0 ? `, ${unread} unread` : ''}`}
        >
          <Ionicons name="notifications-outline" size={19} color={colors.text} />
          {unread > 0 && <View style={[st.bellDot, { backgroundColor: colors.danger, borderColor: G.sheet }]} />}
        </TouchableOpacity>
      </View>

      {/* Space switcher.
          Shown whenever there is anywhere to go — including with a single
          space, where the "New space" chip is the only route to creating a
          School or Employee one. Hiding it below two spaces meant a family
          with one circle had no visible way to reach anything else. */}
      {circles.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, marginBottom: 10 }} contentContainerStyle={{ gap: 8 }}>
          {circles.map((c) => {
            const on = active?.id === c.id;
            const gi = groupIdentity(c);
            return (
              <TouchableOpacity key={c.id} onPress={() => onSelect(c)}
                accessibilityRole="button" accessibilityState={{ selected: on }}
                accessibilityLabel={`${c.name} space`}
                hitSlop={{ top: 4, bottom: 4 }}
                style={[st.chip, { flexDirection: 'row', alignItems: 'center', gap: 6,
                  borderColor: on ? gi.color : G.chipEdge,
                  backgroundColor: on ? tint(gi.color, 0.15) : G.paneFaint }]}>
                <Ionicons name={gi.icon} size={13} color={on ? gi.color : colors.textDim} />
                <Text numberOfLines={1} style={{ color: on ? colors.text : colors.textDim, fontWeight: on ? '700' : '500', fontSize: 13 }}>{c.name}</Text>
              </TouchableOpacity>
            );
          })}
          {/* Always last: the only visible route to a School, Office or
              Transport space. Without it a user with one Family circle can
              never discover that other space types exist. */}
          <TouchableOpacity
            onPress={() => router.push('/group-create')}
            accessibilityRole="button" accessibilityLabel="New space"
            hitSlop={{ top: 4, bottom: 4 }}
            style={[st.chip, { flexDirection: 'row', alignItems: 'center', gap: 6, borderColor: colors.primary, backgroundColor: G.paneFaint }]}
          >
            <Ionicons name="add" size={14} color={colors.primary} />
            <Text style={{ color: G.accentText, fontWeight: '700', fontSize: 13 }}>New space</Text>
          </TouchableOpacity>
        </ScrollView>
      )}

      {/* pinned announcement */}
      {!!announcement && (
        <View style={[st.announce, { backgroundColor: G.pane, borderColor: G.edge, borderLeftWidth: 3, borderLeftColor: colors.primary }]}>
          <Ionicons name="megaphone" size={17} color={colors.primary} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.text, fontSize: 13.5, fontWeight: '600' }} numberOfLines={3}>
              {announcement.text}
            </Text>
            <Text style={{ color: colors.textDim, fontSize: 11 }}>{ago(announcement.at)}</Text>
          </View>
        </View>
      )}

      {/* status card — the hero pane: the strongest glass on the screen,
          with the identity aura bleeding through from the ground behind. */}
      <View style={[st.status, { backgroundColor: G.paneStrong, borderColor: G.edge }]}>
        <View style={[st.statusIcon, { backgroundColor: tint(allGood ? colors.success : ident.color, 0.15) }]}>
          <Ionicons name={allGood ? 'shield-checkmark' : ident.icon} size={21} color={allGood ? colors.success : ident.color} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.textDim, fontSize: 11, fontWeight: '800', letterSpacing: 0.7 }}>
            {(ident.label || 'Family').toUpperCase()} STATUS
          </Text>
          <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16.5 }}>{allGood ? 'All good' : 'Nobody live yet'}</Text>
          <Text style={{ color: colors.textDim, fontSize: 12 }}>
            {/* "Loading" is its own state. Counting against a roster that
                has not arrived is how this line claimed "1 of 1" for a
                three-person space. */}
            {!membersLoaded ? (membersFailed ? 'Couldn’t load members' : 'Loading members…')
              : liveCount ? `${liveCount} of ${roster.length} sharing live`
                : sharingOn ? 'Waiting for locations…'
                  : 'Turn on sharing to appear on the map'}
          </Text>
          {!membersLoaded && membersFailed && (
            <TouchableOpacity
              onPress={onRetryMembers}
              accessibilityRole="button" accessibilityLabel="Retry loading members"
              hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
              style={{ alignSelf: 'flex-start', marginTop: 4 }}
            >
              <Text style={{ color: G.accentText, fontSize: 12.5, fontWeight: '800' }}>Retry</Text>
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity
          onPress={() => active && router.push({ pathname: '/group-members', params: { groupId: active.id, name: active.name } })}
          accessibilityRole="button"
          accessibilityLabel={`View all members${membersLoaded ? `, ${roster.length}` : ''}`}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          style={{ alignItems: 'flex-end', gap: 6 }}
        >
          <View style={st.avatarRow}>
            {roster.slice(0, 4).map((m, i) => (
              <View key={m.id} style={[st.miniDot, { backgroundColor: colorFor(m.id), marginLeft: i ? -8 : 0, borderColor: G.sheet, opacity: presentIds.has(m.id) ? 1 : 0.45 }]}>
                <Text style={[st.miniDotTxt, { color: AVATAR_INK[scheme] }]}>{initialOf(m.name)}</Text>
              </View>
            ))}
            {roster.length > 4 && <View style={[st.miniDot, { backgroundColor: colors.border, marginLeft: -8, borderColor: G.sheet }]}><Text style={[st.miniDotTxt, { color: colors.text }]}>+{roster.length - 4}</Text></View>}
          </View>
          <Text style={{ color: G.accentText, fontSize: 12.5, fontWeight: '700' }}>View All</Text>
        </TouchableOpacity>
      </View>
    </>
  );
}
