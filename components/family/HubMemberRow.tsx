// components/family/HubMemberRow.tsx — one roster row on the Family hub (the
// dashboard card and the expanded map's sheet), moved out of app/family.tsx.
//
// The row is ONE accessible element (a Pressable groups its children), so on
// iOS VoiceOver cannot reach the small buttons inside it. Every one of them —
// show on map, navigate, manage — is therefore ALSO a named accessibility
// action on the row, next to the default activate (open their details).

import React from 'react';
import { View, Pressable, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppText as Text } from '../ui/Text';
import { useTheme } from '../../lib/theme';
import { useSpaceGlass } from '../spaces/SpaceGround';
import { freshnessOf, speedBand } from '../../lib/family/status';
import { defaultRef, formatMetres } from '../../lib/family/distance';
import { haversine } from '../../lib/nav/geo';
import { initialOf } from '../../lib/format';
import { colorFor, ago, AVATAR_INK } from '../../lib/family/memberFormat';
import { type CircleMember, type MemberPresence } from '../../lib/family/types';
import { st } from './hubStyles';

const ROW_SLOP = { top: 10, bottom: 10, left: 6, right: 6 };

export default function HubMemberRow({
  m, index, p, mine, isMe, label, share, locDenied, roadD, manageable,
  onOpen, onManage, onShowOnMap, onNavigate,
}: {
  m: CircleMember;
  index: number;
  /** This member's presence, if any has arrived. */
  p?: MemberPresence;
  /** My own presence — the origin of the "· 2 km away" figure. */
  mine?: MemberPresence;
  isMe: boolean;
  /** "Mother · Arun" when a relation is set, else their name. */
  label: string;
  share: boolean;
  locDenied: boolean;
  /** Road metres from the hub's one matrix call, when it has answered. */
  roadD?: number;
  manageable: boolean;
  onOpen: () => void;
  onManage: () => void;
  onShowOnMap: () => void;
  onNavigate: () => void;
}) {
  const { colors, scheme } = useTheme();
  const G = useSpaceGlass();
  // The reference distance THIS MEMBER published ("1.2 km from Home").
  // Derived on their device from their own places — we hold the number and
  // the place's name, never its coordinate. Absent for members on older
  // builds, for anyone who has saved no places, and once they stop sharing.
  const ref = p && !p.sharingOff ? defaultRef(p.refs) : null;
  // BY ROAD when the router has answered for this member, straight line only
  // until it does. Reads from the same roadM the distance list uses, so the
  // row and the summary can never disagree about how far someone is.
  const d = p && mine && !isMe
    ? formatMetres(roadD != null && Number.isFinite(roadD) && roadD >= 0 ? roadD : haversine(mine.pos, p.pos))
    : null;
  // Freshness tier for the row's caption (spec: LIVE / RECENT / STALE /
  // UNAVAILABLE). A fix past the recent window is "Last known", never live.
  //
  // SILENCE IS NOT A REASON. For another member, this device only ever
  // receives sealed pings — sharing-off, app-killed, offline, permission
  // missing and no-GPS all look identical (nothing arrives), so the caption
  // must not assert a cause ("Location off" accused people who were merely
  // offline). For MYSELF the device does know which it is, and says so.
  const fresh = freshnessOf(p?.ts, Date.now());
  const band = speedBand(p?.speed);
  const rowCaption = (isMe && !share)
    // MY OWN row while sharing is off. The watcher keeps running so my dot
    // stays on my own map — but the caption must never claim I am
    // broadcasting. Found on device: the switch read OFF while this row
    // still said LIVE, which is the one thing a sharing control must not do.
    ? (p ? `Location sharing off · my last fix ${ago(p.ts)}` : 'Location sharing off')
    : p?.sharingOff
      // An EXPLICIT stop by ANOTHER member: the one silence whose reason we
      // truly know — they said so. Last-known retained, never shown as LIVE.
      ? `Location sharing off · last seen ${ago(p.ts)}`
      : !p || fresh === 'unavailable'
      ? (isMe
        ? (!share ? 'Location sharing off'
          : locDenied ? 'Location permission needed'
            : 'Waiting for GPS fix…')
        : 'No location received')
      : fresh === 'stale'
        ? `Last known · ${ago(p.ts)}`
        : `${fresh === 'live' ? 'LIVE' : ago(p.ts)}${d ? ` · ${d} away` : ''}${band && band !== 'stationary' ? ' · moving' : ''}`;
  // Manage (role / remove / ask to check in) used to be long-press only —
  // invisible to sighted users and unreachable with a screen reader. It is
  // now also a visible ⋯ button and a named accessibility action.
  const roleWord = m.role === 'guardian' ? 'guardian' : 'member';
  const mapLabel = `Show ${isMe ? 'yourself' : m.name} on the map`;
  const actions = [
    { name: 'activate' },
    ...(p ? [{ name: 'showOnMap', label: mapLabel }] : []),
    ...(p && !isMe ? [{ name: 'navigate', label: `Navigate to ${m.name}` }] : []),
    ...(manageable ? [{ name: 'manage', label: `Manage ${m.name}` }] : []),
  ];
  return (
    <Pressable
      onLongPress={manageable ? onManage : undefined}
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${roleWord}. ${rowCaption}`}
      accessibilityHint="Opens their details and history"
      accessibilityActions={actions.length > 1 ? actions : undefined}
      onAccessibilityAction={(e) => {
        const a = e.nativeEvent.actionName;
        if (a === 'manage') onManage();
        else if (a === 'showOnMap') onShowOnMap();
        else if (a === 'navigate') onNavigate();
        else onOpen();
      }}
      onPress={onOpen}
      style={({ pressed }) => [st.row, { borderColor: G.line }, index === 0 && { borderTopWidth: 0 },
        pressed && { backgroundColor: G.press, borderRadius: 12 }]}
    >
      <View style={[st.dot, { backgroundColor: colorFor(m.id), opacity: p ? 1 : 0.5 }]}>
        <Text style={[st.dotTxt, { color: AVATAR_INK[scheme] }]}>{initialOf(m.name)}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={{ color: colors.text, fontWeight: '600' }} numberOfLines={1}>{label}</Text>
          {m.role === 'guardian' && <Ionicons name="star" size={11} color={colors.primary} accessible accessibilityLabel="Guardian" />}
        </View>
        <Text style={{ color: fresh === 'live' ? G.goodText : colors.textDim, fontSize: 12 }} numberOfLines={1}>
          {rowCaption}
        </Text>
        {/* Their own reference distance, on its own line so the freshness
            caption above keeps its meaning. Only shown with a usable fix —
            a distance-from-Home computed for a position we no longer trust
            is exactly the stale number the freshness tiers exist to prevent. */}
        {ref && fresh !== 'unavailable' && fresh !== 'stale' && (
          <Text style={{ color: colors.textDim, fontSize: 12 }} numberOfLines={1}>
            {formatMetres(ref.d)} from {ref.n}
          </Text>
        )}
      </View>
      {p?.battery != null && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
          <Ionicons name={p.charging ? 'battery-charging' : p.battery <= 20 ? 'battery-dead' : 'battery-half'} size={15}
            color={p.battery <= 20 && !p.charging ? G.dangerText : colors.textDim} />
          <Text style={{ color: p.battery <= 20 && !p.charging ? G.dangerText : colors.textDim, fontSize: 11, fontVariant: ['tabular-nums'] }}>{Math.round(p.battery)}%</Text>
        </View>
      )}
      {p && (
        <TouchableOpacity onPress={onShowOnMap} style={st.rowBtn} hitSlop={ROW_SLOP}
          accessibilityRole="button" accessibilityLabel={mapLabel}
        ><Ionicons name="locate" size={18} color={colors.primary} /></TouchableOpacity>
      )}
      {p && !isMe && (
        <TouchableOpacity onPress={onNavigate} style={st.rowBtn} hitSlop={ROW_SLOP}
          accessibilityRole="button" accessibilityLabel={`Navigate to ${m.name}`}
        ><Ionicons name="navigate-circle" size={20} color={colors.primary} /></TouchableOpacity>
      )}
      {manageable && (
        <TouchableOpacity onPress={onManage} style={st.rowBtn} hitSlop={ROW_SLOP}
          accessibilityRole="button" accessibilityLabel={`Manage ${m.name}`}
        ><Ionicons name="ellipsis-horizontal" size={18} color={colors.textDim} /></TouchableOpacity>
      )}
    </Pressable>
  );
}
