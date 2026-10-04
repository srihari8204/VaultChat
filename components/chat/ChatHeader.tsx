// components/chat/ChatHeader.tsx — the chat screen's glass header: back,
// avatar, title + presence/encryption line, self-destruct countdown, call
// buttons and the overflow trigger. Moved out of app/chat.tsx unchanged; the
// screen still owns every action, this only draws them.

import { useEffect, useMemo, useState } from 'react';
import { Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Avatar, GlassView } from '../ui';
import { useTheme } from '../../lib/theme';
import { useVisionComfort } from '../../lib/visionComfort';
import { attachmentUrl, type ChatDetail } from '../../lib/chatService';
import { formatLastSeen } from './chatFormat';
import { useS } from './chatStyles';

export function ChatHeader({
  embedded, compactHeader, chat, meId, chatId, title, headerPhotoId, screenAuthHeader,
  onAvatarTap, openProfile, onPressMenu,
}: {
  embedded?: boolean;
  compactHeader?: boolean;
  chat: ChatDetail | null;
  meId: string | null;
  chatId: string;
  title: string;
  headerPhotoId: string | null;
  screenAuthHeader: string | null;
  onAvatarTap: () => void;
  openProfile: () => void;
  onPressMenu: () => void;
}) {
  const S = useS();
  const { colors } = useTheme();
  const router = useRouter();
  const { fontScale } = useWindowDimensions();
  const { metrics: visionMetrics } = useVisionComfort();

  // Direct-chat peer presence — drives the "online" / "last seen X" sub-text
  // and the green dot on the header avatar.
  const peerPresence = useMemo(() => {
    if (!chat || chat.type !== 'direct' || !meId) return null;
    const other = chat.members.find(m => m.userId !== meId);
    if (!other) return null;
    return { online: !!other.online, lastSeenAt: other.lastSeenAt ?? null };
  }, [chat, meId]);

  const headerSub = useMemo(() => {
    if (!chat) return '';
    if (chat.type === 'group') return `${chat.members.length} members`;
    if (peerPresence?.online) return 'online';
    if (peerPresence?.lastSeenAt) return `last seen ${formatLastSeen(peerPresence.lastSeenAt)}`;
    return 'Direct chat';
  }, [chat, peerPresence]);

  // ── self-destruct countdown (migration 120) ────────────────
  //
  // A chat opened by a 1h/3h code DELETES ITSELF — every message, and the
  // conversation with them. Until this existed the server knew the deadline and
  // the person in the chat did not: it simply vanished mid-conversation, which
  // reads as data loss rather than as the feature working.
  //
  // Ticks every 30s rather than every second. The number people act on is "how
  // many minutes have I got", and a per-second re-render of this screen to
  // animate a value that changes once a minute is the kind of cost that shows
  // up on an old phone for nothing.
  const [expiresIn, setExpiresIn] = useState<number | null>(null);
  const expiresAt = chat?.expiresAt ?? null;
  useEffect(() => {
    if (!expiresAt) { setExpiresIn(null); return; }
    const tick = () => setExpiresIn(Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000)));
    tick();
    const h = setInterval(tick, 30_000);
    return () => clearInterval(h);
  }, [expiresAt]);

  // Minutes until about an hour out, then hours. "in 92 min" is a worse answer
  // than "in 2h" for deciding whether to keep talking.
  const expiryLabel = useMemo(() => {
    if (expiresIn == null) return null;
    if (expiresIn <= 600) return 'deleting now';
    const m = Math.ceil(expiresIn / 60);
    return m < 60 ? `deletes itself in ${m} min` : `deletes itself in ${Math.round(m / 60)}h`;
  }, [expiresIn]);

  return (
    <>
      {/* Header — glass, so the thread scrolls visibly beneath it */}
      <GlassView kind="chrome" bordered={false} style={S.headerGlass}>
      <View style={S.header}>
        {/* An embedded split-view pane has no screen of its own to go back
            from; router.back() there would pop the whole split screen. */}
        {!embedded && (
          <TouchableOpacity onPress={() => router.back()} style={S.backBtn} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Back">
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={S.headerAvatarWrap}
          activeOpacity={0.7}
          onPress={onAvatarTap}
          accessibilityRole="button"
          accessibilityLabel={`${title} profile photo`}
        >
          <Avatar
            ring
            uri={headerPhotoId && screenAuthHeader ? attachmentUrl(headerPhotoId) : null}
            headers={screenAuthHeader ? { Authorization: screenAuthHeader } : undefined}
            name={title}
            size={40}
            presence={chat?.type === 'direct' && peerPresence?.online ? 'online' : null}
            anon={!!chat?.anonMasked}
          />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <TouchableOpacity
            activeOpacity={0.6}
            onPress={openProfile}
            accessibilityRole="button"
            accessibilityLabel={`${title}${headerSub ? `, ${headerSub}` : ''}, end-to-end encrypted`}
            accessibilityHint={chat?.type === 'group' ? 'Opens group info' : 'Opens contact info'}
          >
            <Text style={S.title} numberOfLines={fontScale * visionMetrics.textScale > 1.2 ? 2 : 1}>{title}</Text>
            {chat && (
              <Text style={S.sub}>
                {headerSub}
                <Text style={S.e2eBadge}>  ·  </Text>
                <Ionicons name="lock-closed" size={11} color={colors.success} />
                <Text style={S.e2eBadge}> secured</Text>
              </Text>
            )}
          </TouchableOpacity>
          {/* Self-destruct countdown. Sits under the name because that is where
              the eye already is when you open a chat, and because this is the
              one fact about the conversation that changes what you do next.
              Red under ten minutes — the point where "I'll reply later" stops
              being an option. */}
          {expiryLabel && (
            <View style={S.expiryRow}>
              <Ionicons
                name="timer-outline"
                size={12}
                color={expiresIn != null && expiresIn <= 600 ? colors.danger : colors.textDim}
              />
              <Text style={[S.expiryTxt, expiresIn != null && expiresIn <= 600 && { color: colors.danger }]}>
                {expiryLabel}
              </Text>
            </View>
          )}
        </View>
        {!compactHeader && chat?.type === 'direct' && meId && (() => {
          const peer = chat.members.find(m => m.userId !== meId);
          if (!peer) return null;
          const params = { chatId, peerUid: peer.userId, peerName: peer.name || peer.email || 'crazzychat user' };
          return (
            <>
              <TouchableOpacity
                style={S.headerIconBtn} hitSlop={4}
                onPress={() => router.push({ pathname: '/videocall' as any, params })} accessibilityRole="button" accessibilityLabel="Video call"
                activeOpacity={0.7}
              >
                <Ionicons name="videocam" size={23} color={colors.text} />
              </TouchableOpacity>
              <TouchableOpacity
                style={S.headerIconBtn} hitSlop={4}
                onPress={() => router.push({ pathname: '/voicecall' as any, params })} accessibilityRole="button" accessibilityLabel="Voice call"
                activeOpacity={0.7}
              >
                <Ionicons name="call" size={20} color={colors.text} />
              </TouchableOpacity>
            </>
          );
        })()}
        {/* Group call. Mirrors the direct-chat pair above and opens the group
            call hub, which rings every member and joins the mesh room. The hub
            takes `mode`, so both icons land in the right place. */}
        {!compactHeader && chat?.type === 'group' && (() => {
          const params = { chatId, groupName: chat.name ?? 'Group' };
          return (
            <>
              <TouchableOpacity
                style={S.headerIconBtn} hitSlop={4}
                onPress={() => router.push({ pathname: '/group-calls' as any, params: { ...params, mode: 'video' } })} accessibilityRole="button" accessibilityLabel="Group video call"
                activeOpacity={0.7}
              >
                <Ionicons name="videocam" size={23} color={colors.text} />
              </TouchableOpacity>
              <TouchableOpacity
                style={S.headerIconBtn} hitSlop={4}
                onPress={() => router.push({ pathname: '/group-calls' as any, params: { ...params, mode: 'voice' } })} accessibilityRole="button" accessibilityLabel="Group voice call"
                activeOpacity={0.7}
              >
                <Ionicons name="call" size={20} color={colors.text} />
              </TouchableOpacity>
            </>
          );
        })()}
        <TouchableOpacity style={S.headerIconBtn} hitSlop={4} onPress={onPressMenu} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="More options">
          <Ionicons name="ellipsis-vertical" size={20} color={colors.text} />
        </TouchableOpacity>
      </View>
      </GlassView>
    </>
  );
}
