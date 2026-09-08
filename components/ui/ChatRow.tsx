// components/ui/ChatRow.tsx — the chat-list row, from Figma `ChatRow` (5:2).
//
// The most-seen surface in the app, and the one the WhatsApp spec is most
// specific about (§6.4): a 72pt row, a 50pt avatar, name and timestamp on
// one baseline, preview and unread badge on the next. Density is the point —
// 72pt shows ~9 chats on a 6.1" screen, and airy rows are the fastest way to
// make a messenger feel like a prototype.
//
// GEOMETRY IS FROM THE DESIGN FILE, NOT FROM TASTE
// ------------------------------------------------
// Every number below is the Figma node: 72 tall, padding 12, gap 12, avatar
// 50, body gap 3, meta gap 6/8, badge 22 at radius 11. The shipped list had
// drifted to minHeight 76 / padding 22 / gap 14, which is why rows looked
// looser than the design and than WhatsApp. Change these HERE, against the
// design file, not in a screen.
//
// Type comes from the Figma text styles: h3 = Sora Bold 17/22 (name),
// caption = Nunito Sans 14/19 (preview), 12.5/16 (time), 11/14 SemiBold
// (badge). AppText already owns the families and the font-scale cap.
//
// Colour comes from the live palette, never from the hexes in the Figma export
// — that file is dark-first with no light variant built, so its literals would
// break Light mode. The token NAMES line up (brand/primary → colors.primary,
// text/text → colors.text, text/textdim → colors.textDim).

import React from 'react';
import { View, StyleSheet, TouchableOpacity, type StyleProp, type ViewStyle } from 'react-native';
import { Avatar } from './Avatar';
import { AppText } from './Text';
import { useColors } from '../../lib/theme';
import type { Palette } from '../../constants/theme';

export interface ChatRowProps {
  name: string;
  /** Last-message line. Rendered dim, one line, ellipsised. */
  preview?: string | null;
  /** Pre-formatted — the row does not know about date formats. */
  time?: string | null;
  unreadCount?: number;
  avatarUri?: string | null;
  avatarHeaders?: Record<string, string>;
  presence?: 'online' | 'offline' | null;
  /** Anonymous peer (chat-code chats) — silhouette instead of an initial. */
  anon?: boolean;
  /** Replaces the preview line — typing indicators, drafts, "photo" etc. */
  previewSlot?: React.ReactNode;
  /** Trailing decoration on the name line — mute icon, pin, verified tick. */
  nameSlot?: React.ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  selected?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** 99+ rather than a badge that grows and shoves the preview off the row. */
function badgeLabel(n: number): string {
  return n > 99 ? '99+' : String(n);
}

export function ChatRow({
  name, preview, time, unreadCount = 0, avatarUri, avatarHeaders, presence, anon,
  previewSlot, nameSlot, onPress, onLongPress, selected, style, testID,
}: ChatRowProps) {
  const c = useColors();
  const s = React.useMemo(() => makeStyles(c), [c]);
  const unread = unreadCount > 0;

  return (
    <TouchableOpacity
      style={[s.row, selected && s.rowSelected, style]}
      onPress={onPress}
      onLongPress={onLongPress}
      activeOpacity={0.75}
      testID={testID}
      accessibilityRole="button"
      // One label for the whole row: a screen reader should say who, what and
      // how many — not walk four separate text nodes (spec §10).
      accessibilityLabel={[
        name,
        preview ?? undefined,
        time ?? undefined,
        unread ? `${unreadCount} unread` : undefined,
      ].filter(Boolean).join(', ')}
    >
      <Avatar
        uri={avatarUri}
        headers={avatarHeaders}
        name={name}
        size={50}
        presence={presence}
        anon={anon}
        ring
      />

      <View style={s.body}>
        <View style={s.top}>
          {/* numberOfLines + flex:1 together: without the flex the name pushes
              the timestamp off the row instead of truncating against it. */}
          <AppText style={[s.name, unread && s.nameUnread]} numberOfLines={1}>
            {name}
          </AppText>
          {nameSlot}
          {!!time && (
            <AppText style={[s.time, unread && s.timeUnread]} numberOfLines={1}>
              {time}
            </AppText>
          )}
        </View>

        <View style={s.bottom}>
          {previewSlot ?? (
            <AppText style={s.preview} numberOfLines={1}>
              {preview ?? ''}
            </AppText>
          )}
          {unread && (
            <View style={s.badge}>
              <AppText style={s.badgeTxt} numberOfLines={1}>{badgeLabel(unreadCount)}</AppText>
            </View>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  // minHeight, NOT height. The design says 72 and lib/responsiveLayout's
  // guard says never pin a row that holds text: at 130% OS font scale a
  // fixed 72 clips the name and the preview, which spec §10 forbids and
  // which this repo already has a failing test for. 72 is the resting
  // height — the rhythm the design wants — and the row grows only for a
  // reader who needs it.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 72,
    paddingHorizontal: 12,
    gap: 12,
    backgroundColor: 'transparent',
  },
  rowSelected: { backgroundColor: c.glassSoft },

  body: { flex: 1, gap: 3, minWidth: 0 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  bottom: { flexDirection: 'row', alignItems: 'center', gap: 8 },

  name: { flex: 1, minWidth: 0, fontSize: 17, lineHeight: 22, fontWeight: '600', color: c.text },
  nameUnread: { fontWeight: '700' },
  time: { fontSize: 12.5, lineHeight: 16, color: c.textFaint },
  timeUnread: { color: c.primary, fontWeight: '600' },

  preview: { flex: 1, minWidth: 0, fontSize: 14, lineHeight: 19, color: c.textDim },

  // 22 tall with a matching radius; minWidth keeps "1" circular and lets "99+"
  // grow sideways instead of squashing.
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 7,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.primary,
  },
  badgeTxt: { fontSize: 11, lineHeight: 14, fontWeight: '600', color: '#FFFFFF' },
});

export default ChatRow;
