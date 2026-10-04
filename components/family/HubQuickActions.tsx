// components/family/HubQuickActions.tsx — the Family hub's middle band, moved
// out of app/family.tsx: a school, office or cab space gets its own sections
// (lib/spaces/layout decides which); a family or generic space gets the quick
// action tiles. Every tile keeps its permission gate and destination.

import React from 'react';
import { View, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { AppText as Text } from '../ui/Text';
import { useTheme } from '../../lib/theme';
import { useSpaceGlass } from '../spaces/SpaceGround';
import { type SpaceSection } from '../../lib/spaces/layout';
import { type Permission } from '../../lib/groups/permissions';
import { type GroupRef } from '../../lib/groups/store';
import { st } from './hubStyles';

type IconName = keyof typeof Ionicons.glyphMap;

/** Icon in a tinted rounded square, title, and a subtitle saying what it does. */
function Tile({ icon, tint, title, sub, onPress, badge }: {
  icon: IconName; tint?: string; title: string; sub: string; onPress: () => void; badge?: string;
}) {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  const c = tint ?? colors.primary;
  return (
    <TouchableOpacity onPress={onPress} accessibilityRole="button"
      accessibilityLabel={`${title}, ${sub}`}
      style={[st.qa, { backgroundColor: G.pane, borderColor: G.edge }]}>
      <View style={[st.qaIcon, { backgroundColor: c + '22' }]}>
        <Ionicons name={icon} size={19} color={c} />
      </View>
      <Text style={[st.qaTitle, { color: colors.text }]}>{title}</Text>
      <Text style={[st.qaSub, { color: colors.textDim }]} numberOfLines={1}>{sub}</Text>
      {!!badge && (
        <View style={[st.badge, { backgroundColor: colors.danger, borderColor: G.sheet }]}>
          <Text style={[st.badgeTxt, { color: colors.onDanger }]}>{badge}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

export default function HubQuickActions({
  active, opsSections, sections, perms, liveCount, unread, canZones, canHistory, onExpand, onCheckin,
}: {
  active: GroupRef | null;
  /** True for a school, office or cab space: draw `sections`, not the tiles. */
  opsSections: boolean;
  sections: SpaceSection[];
  perms: Set<Permission>;
  liveCount: number;
  unread: number;
  canZones: boolean;
  canHistory: boolean;
  onExpand: () => void;
  onCheckin: () => void;
}) {
  const { colors } = useTheme();
  const router = useRouter();
  const unreadTxt = unread > 99 ? '99+' : String(unread);

  if (opsSections) {
    return (
      <View style={st.qaGrid}>
        {sections.map((s) => (
          <Tile
            key={s.key}
            icon={s.icon as IconName} title={s.label} sub={s.hint}
            onPress={() => active && router.push({
              pathname: s.route,
              params: {
                spaceId: active.id, circleId: active.id,
                name: active.name, circleName: active.name,
                groupType: active.groupType ?? '',
                perms: Array.from(perms).join(','),
              },
            })}
          />
        ))}
      </View>
    );
  }

  return (
    <View style={st.qaGrid}>
      <Tile icon="map" title="Live Map" sub={liveCount ? `${liveCount} sharing` : 'See all'} onPress={onExpand} />

      {/* MEET HERE (§40). This tile exists because without it the whole
          feature was unreachable: the Live Map tile above expands the map
          INLINE (setExpanded) and never routes, and the only other path to
          /family-map is a member's "Follow", which refuses unless that
          member has a same-day fix. Found on the Honor — Meet Here and
          Family Center were built and shipped behind a door with no
          handle, which no self-check could ever have caught. */}
      <Tile icon="search" title="Meet Here" sub="Pick a place to meet"
        onPress={() => active && router.push({ pathname: '/family-map', params: { circleId: active.id, circleName: active.name } })} />

      <Tile icon="medkit" tint={colors.danger} title="SOS" sub="Emergency" onPress={() => router.push('/emergency-sos')} />

      <Tile icon="checkmark-done-circle" tint={colors.success} title="Check-in" sub="Share status" onPress={onCheckin} />

      {canZones && (
        <Tile icon="location" title="Safe Zones" sub="Places that matter"
          onPress={() => active && router.push({ pathname: '/family-places', params: { circleId: active.id, name: active.name } })} />
      )}

      <Tile icon="notifications" title="Alerts" sub={unread > 0 ? `${unreadTxt} unread` : 'All caught up'}
        badge={unread > 0 ? unreadTxt : undefined}
        onPress={() => active && router.push({ pathname: '/family-alerts', params: { circleId: active.id, circleName: active.name } })} />

      {/* FIND MY THINGS — BLE item finder. Offered to every member: a
          person's keys are their own business, and it needs no
          permission the space grants. */}
      <Tile icon="key" title="Find Things" sub="Keys, wallet, bag"
        onPress={() => active && router.push({ pathname: '/family-items', params: { circleId: active.id } })} />

      {canHistory && (
        <Tile icon="time" title="History" sub="Where everyone was"
          onPress={() => active && router.push({ pathname: '/family-history', params: { circleId: active.id, circleName: active.name } })} />
      )}
    </View>
  );
}
