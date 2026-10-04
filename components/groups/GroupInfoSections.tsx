// components/groups/GroupInfoSections.tsx — parts of app/group-info.tsx: the
// row of group tools (call, media, shared calendar/notes/tasks, viewing-status
// privacy, admin links) and one member row. The screen owns state and requests.

import React from 'react';
import { Image, Switch, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../lib/theme';
import { AppText as Text } from '../ui/Text';
import SharedMediaThumb from '../chat/SharedMediaThumb';
import { attachmentUrl, type ChatDetail, type ChatMember, type Message } from '../../lib/chatService';
import { initialOf } from '../../lib/format';
import { ROLE_LABELS } from '../../lib/groups/permissions';
import { useGroupInfoStyles } from './groupInfoStyles';

export function GroupInfoTools({
  chat, isAdmin, media, mediaSize, authHeader, shareViewing, onShareViewing,
}: {
  chat: ChatDetail;
  isAdmin: boolean;
  /** The newest shared images/videos (at most 9). */
  media: Message[];
  mediaSize: number;
  authHeader: string | null;
  shareViewing: boolean;
  onShareViewing: (on: boolean) => void;
}) {
  const { colors } = useTheme();
  const S = useGroupInfoStyles();
  const router = useRouter();
  return (
    <>
    {/* Group call — rings every member, then joins the mesh call room. */}
    <View style={S.section}>
      <TouchableOpacity
        style={S.navRow}
        activeOpacity={0.7}
        accessibilityRole="button"
        onPress={() => router.push({ pathname: '/group-calls', params: { chatId: chat.id, groupName: chat.name ?? 'Group' } })}
      >
        <Ionicons name="call-outline" size={22} color={colors.text} style={S.navIcon} />
        <View style={{ flex: 1 }}>
          <Text style={S.navTitle}>Group call</Text>
          <Text style={S.navSub}>Voice or video with this group</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
      </TouchableOpacity>
    </View>

    {/* Media, links and docs — WhatsApp-style row → shared media gallery */}
    <View style={S.section}>
      <TouchableOpacity
        style={S.navRow}
        activeOpacity={0.7}
        accessibilityRole="button"
        onPress={() => router.push({ pathname: '/media-gallery', params: { chatId: chat.id } })}
      >
        <Ionicons name="images-outline" size={22} color={colors.text} style={S.navIcon} />
        <View style={{ flex: 1 }}>
          <Text style={S.navTitle}>Media, links and docs</Text>
          <Text style={S.navSub}>Everything shared in this group</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
      </TouchableOpacity>
      {media.length > 0 && (
        <View style={S.mediaGrid}>
          {media.map(m => (
            <SharedMediaThumb
              key={m.id}
              m={m}
              chatId={chat.id}
              authHeader={authHeader}
              size={mediaSize}
              onPress={() => router.push({ pathname: '/media-gallery', params: { chatId: chat.id } })}
            />
          ))}
        </View>
      )}
    </View>

    {/* Shared tools. These screens take only the group id and run on the
        group's own message thread / calendar endpoint, so they work for any
        group, not just a Family Space. Location tools (trip, insights,
        location privacy) stay in Family Space, where location is shared. */}
    <View style={S.section}>
      <Text style={S.label}>SHARED</Text>
      {([
        { path: '/group-calendar', icon: 'calendar-outline', title: 'Shared calendar', sub: 'Events everyone in the group can see' },
        { path: '/group-notes', icon: 'document-text-outline', title: 'Shared notes', sub: 'Lists and notes, encrypted end to end' },
        { path: '/group-tasks', icon: 'checkbox-outline', title: 'Shared tasks', sub: 'To-dos with due dates and reminders' },
      ] as const).map(t => (
        <TouchableOpacity
          key={t.path}
          style={S.navRow}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={t.title}
          accessibilityHint={t.sub}
          onPress={() => router.push({ pathname: t.path, params: { groupId: chat.id, name: chat.name ?? 'Group' } })}
        >
          <Ionicons name={t.icon} size={22} color={colors.text} style={S.navIcon} />
          <View style={{ flex: 1 }}>
            <Text style={S.navTitle}>{t.title}</Text>
            <Text style={S.navSub}>{t.sub}</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
        </TouchableOpacity>
      ))}
    </View>

    {/* Live Chat Viewers (#58) — share whether you're currently viewing this chat */}
    <View style={S.section}>
      <Text style={S.label}>PRIVACY</Text>
      <View style={S.navRow}>
        <Ionicons name="eye-outline" size={22} color={colors.text} style={S.navIcon} />
        <View style={{ flex: 1 }}>
          <Text style={S.navTitle}>Share my viewing status</Text>
          <Text style={S.navSub}>Let members see when you’re viewing this chat now</Text>
        </View>
        <Switch
          accessibilityLabel="Share my viewing status"
          value={shareViewing}
          onValueChange={onShareViewing}
          trackColor={{ true: colors.primary, false: colors.border }}
          thumbColor={colors.onPrimary}
        />
      </View>
    </View>

    {isAdmin && (
      <View style={S.section}>
        <Text style={S.label}>ADMIN</Text>
        <TouchableOpacity
          style={S.navRow}
          activeOpacity={0.7}
          accessibilityRole="button"
          onPress={() => router.push({ pathname: '/group-admin', params: { chatId: chat.id, groupName: chat.name ?? '' } })}
        >
          <Ionicons name="shield-checkmark-outline" size={22} color={colors.text} style={S.navIcon} />
          <View style={{ flex: 1 }}>
            <Text style={S.navTitle}>Group settings & permissions</Text>
            <Text style={S.navSub}>Roles, slow mode, who can send, join requests</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
        </TouchableOpacity>
        <TouchableOpacity
          style={S.navRow}
          activeOpacity={0.7}
          accessibilityRole="button"
          onPress={() => router.push({ pathname: '/invite-link', params: { chatId: chat.id, groupName: chat.name ?? '' } })}
        >
          <Ionicons name="link-outline" size={22} color={colors.text} style={S.navIcon} />
          <View style={{ flex: 1 }}>
            <Text style={S.navTitle}>Invite links</Text>
            <Text style={S.navSub}>Anyone with a link can join, or ask to if approval is on</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
        </TouchableOpacity>
      </View>
    )}
    </>
  );
}

export function MemberRow({
  member, meId, canRemove, authHeader, onRemove,
}: {
  member:     ChatMember;
  meId:       string | null;
  /** From memberActions (lib/groups/permissions.ts), the check group-admin/group-members use. */
  canRemove:  boolean;
  authHeader: string | null;
  onRemove:   () => void;
}) {
  const S = useGroupInfoStyles();
  const isMe = member.userId === meId;
  const showRemove = canRemove;
  const letter = initialOf(member.name, member.email);
  // A member with no name and no email used to be shown as eight hex digits of
  // their user id — which reads as a bug, not as a person. Email is optional now,
  // so this is an ordinary row, and it says so in words.
  const display = member.name?.trim() || member.email?.trim() || 'crazzychat user';
  return (
    <View style={S.memberRow}>
      <View style={S.memberAvatarWrap}>
        <View style={S.memberAvatar}>
          {member.photoURL && authHeader ? (
            <Image
              source={{ uri: attachmentUrl(member.photoURL), headers: { Authorization: authHeader } }}
              style={S.memberAvatarImg}
            />
          ) : (
            <Text style={S.memberAvatarTxt}>{letter}</Text>
          )}
        </View>
        {member.online && <View style={S.memberPresenceDot} />}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={S.memberName} numberOfLines={1}>
          {display}
          {isMe && <Text style={S.memberMeTag}> (you)</Text>}
        </Text>
        {/* Sub-line only when there is something to say. Without an email it was
            a second UUID fragment under the first — noise, not information. */}
        {(member.role !== 'member' || !!member.email) && (
          <Text style={S.memberSub} numberOfLines={1}>
            {member.role !== 'member' && `${ROLE_LABELS[member.role as keyof typeof ROLE_LABELS] ?? member.role}${member.email ? ' · ' : ''}`}
            {member.email}
          </Text>
        )}
      </View>
      {showRemove && (
        <TouchableOpacity onPress={onRemove} style={S.removeBtn} activeOpacity={0.7} hitSlop={10} accessibilityRole="button" accessibilityLabel={`Remove ${display} from the group`}>
          <Text style={S.removeBtnTxt}>Remove</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}
