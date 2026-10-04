// components/chats/ChatListRow.tsx — one row of the Chats tab (app/(tabs)/chats.tsx).
// (Not named ChatRow: that was components/ui/ChatRow.tsx, deleted with the dead
// screens it linked to, and lib/orphanRoutes.selftest.ts guards the name.)
//
// Moved out of the screen unchanged, with one fix: the handlers now take the
// chat they act on and the screen passes STABLE callbacks, so the plain memo
// below holds. The old comparator ignored the handler props (they were fresh
// closures every render), which kept the memo working only by trusting that
// every closure it skipped was still current.

import { memo, useRef } from 'react';
// RN Text, not AppText: the styles already apply the vision-comfort scale.
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../lib/theme';
import { Avatar } from '../ui';
import { attachmentUrl, type ChatSummary } from '../../lib/chatService';
import { isFamEvent } from '../../lib/family/alerts';
import { NOTE_PREFIX } from '../../lib/groups/notes';
import { TASK_PREFIX } from '../../lib/groups/tasks';
import { useChatListStyles } from './chatListStyles';

export type LastMsg = { content: string | null; type: string | null; senderId: string | null; id: number };

type RowAction = (chat: ChatSummary) => void;

export function ChatListSeparator() {
  const S = useChatListStyles();
  return <View style={S.separator} />;
}

export const ChatListRow = memo(function ChatListRow({
  chat, authHeader, draft, lastMsg, meId, isTyping, selectMode, isSelected, avatarBusy,
  onPress, onAvatarPress, onLongPress, onPin, onMute, onArchive, onDelete,
}: {
  chat: ChatSummary; authHeader: string | null; draft?: string; lastMsg?: LastMsg; meId?: string | null; isTyping?: boolean;
  selectMode?: boolean; isSelected?: boolean;
  /** The first avatar tap is looking up whether this person has a story. */
  avatarBusy?: boolean;
  onPress: RowAction; onAvatarPress: RowAction; onLongPress: RowAction;
  onPin: RowAction; onMute: RowAction; onArchive: RowAction; onDelete: RowAction;
}) {
  const { colors } = useTheme();
  const S = useChatListStyles();
  const swipeRef = useRef<Swipeable>(null);
  const title = chat.type === 'direct' ? (chat.peerName || chat.name || 'Direct chat') : (chat.name || 'Group chat');
  const photoId = chat.type === 'direct' ? chat.peerPhotoURL : chat.photoURL;
  const showPhoto = !!photoId && !!authHeader;
  const time = chat.lastMessageAt ? formatRelative(chat.lastMessageAt) : '';
  const draftText = draft && draft.trim() ? draft.trim() : '';
  // Real last-message preview from the local plaintext cache (WhatsApp-style).
  const previewBody = (() => {
    if (!lastMsg) return chat.lastMessageId ? 'Tap to open chat' : 'No messages yet';
    // famEvent envelopes are hidden from the thread, so they must not become a
    // row's "last message" TEXT either. This is a PREVIEW-ONLY fix: the row's
    // sort position and unread badge come from the server's chat.lastMessageAt/
    // unreadCount, which the server cannot correct for famEvent specifically —
    // it never sees plaintext content (E2EE), so it cannot tell a famEvent
    // system message apart from any other. A crossing can still bump a chat to
    // the top and mark it unread; opening it then shows nothing new. Accepted
    // trade-off, not silently swept: the alternative (client-side markRead up
    // to the famEvent's id) would also retroactively mark any REAL unread
    // message with a lower id as read, which is worse.
    // Group notes/tasks ops are hidden from the thread for the same reason.
    if (isFamEvent(lastMsg.type, lastMsg.content)
      || (typeof lastMsg.content === 'string'
        && (lastMsg.content.startsWith(NOTE_PREFIX) || lastMsg.content.startsWith(TASK_PREFIX)))) {
      return 'Tap to open chat';
    }
    const t = lastMsg.type;
    // content is null for a text message whose ciphertext couldn't be decrypted
    // (the cache layer withholds raw envelopes) — show a lock, never blank/JSON.
    const textFallback = lastMsg.content || (chat.lastMessageId ? '🔒 Encrypted message' : '');
    const label = t === 'image' ? '📷 Photo'
      : t === 'video' ? '🎥 Video'
      : t === 'audio' ? '🎙️ Voice message'
      : t === 'file' ? '📎 File'
      : t === 'vaultbeam' ? '📦 File'
      : t === 'location' ? '📍 Location'
      : t === 'poll' ? '📊 Poll'
      : t === 'sticker' ? 'Sticker'
      : textFallback;
    const mine = !!meId && lastMsg.senderId === meId;
    return (mine ? 'You: ' : '') + label;
  })();
  const preview = draftText || previewBody;

  const close = () => swipeRef.current?.close();
  const act = (fn: RowAction) => { close(); fn(chat); };

  const leftActions = () => (
    <View style={S.actionsRow}>
      <TouchableOpacity style={[S.action, { backgroundColor: colors.primary }]} onPress={() => act(onPin)} accessibilityRole="button">
        <Ionicons name={chat.pinned ? 'pin' : 'pin-outline'} size={20} color={colors.onPrimary} /><Text style={S.actionLbl}>{chat.pinned ? 'Unpin' : 'Pin'}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[S.action, { backgroundColor: colors.purple }]} onPress={() => act(onMute)} accessibilityRole="button">
        <Ionicons name={chat.muted ? 'notifications-outline' : 'notifications-off-outline'} size={20} color={colors.onPrimary} /><Text style={S.actionLbl}>{chat.muted ? 'Unmute' : 'Mute'}</Text>
      </TouchableOpacity>
    </View>
  );
  const rightActions = () => (
    <View style={S.actionsRow}>
      {/* Neutral, not accent: the ink is the theme's text colour, so it holds
          contrast on surfaceSolid in both themes (white vanished in light). */}
      <TouchableOpacity style={[S.action, { backgroundColor: colors.surfaceSolid }]} onPress={() => act(onArchive)} accessibilityRole="button">
        <Ionicons name={chat.archived ? 'archive' : 'archive-outline'} size={20} color={colors.text} /><Text style={[S.actionLbl, { color: colors.text }]}>{chat.archived ? 'Unarchive' : 'Archive'}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[S.action, { backgroundColor: colors.danger }]} onPress={() => act(onDelete)} accessibilityRole="button">
        <Ionicons name="trash-outline" size={20} color={colors.onDanger} /><Text style={[S.actionLbl, { color: colors.onDanger }]}>Delete</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <Swipeable ref={swipeRef} enabled={!selectMode} renderLeftActions={leftActions} renderRightActions={rightActions} overshootLeft={false} overshootRight={false} friction={2}>
      <TouchableOpacity style={[S.row, isSelected && S.rowSelected]} onPress={() => onPress(chat)} onLongPress={() => onLongPress(chat)} delayLongPress={250} activeOpacity={0.7}
        accessibilityRole="button"
        // Name, preview, time and unread in one announcement; the swipe-only
        // actions are offered as accessibility actions too.
        accessibilityLabel={`${title}${chat.unreadCount > 0 ? `, ${chat.unreadCount} unread` : ''}${draftText ? ', draft' : ''}. ${preview}${time ? `. ${time}` : ''}`}
        accessibilityState={selectMode ? { selected: !!isSelected } : undefined}
        accessibilityHint={selectMode ? 'Toggles selection' : 'Opens the chat. Long-press for more options'}
        accessibilityActions={selectMode ? undefined : [
          { name: 'pin', label: 'Pin or unpin' },
          { name: 'mute', label: 'Mute or unmute' },
          { name: 'archive', label: 'Archive' },
          { name: 'delete', label: 'Delete' },
        ]}
        onAccessibilityAction={(e) => {
          const n = e.nativeEvent.actionName;
          if (n === 'pin') onPin(chat); else if (n === 'mute') onMute(chat); else if (n === 'archive') onArchive(chat); else if (n === 'delete') onDelete(chat);
        }}>
        <TouchableOpacity style={S.avatarWrap} activeOpacity={0.7} onPress={() => onAvatarPress(chat)} disabled={avatarBusy}
          accessibilityRole="button" accessibilityLabel={selectMode ? `Select ${title}` : `${title}: story or profile photo`}
          accessibilityState={{ busy: !!avatarBusy }}>
          <Avatar
            ring
            uri={showPhoto ? attachmentUrl(photoId!) : null}
            headers={authHeader ? { Authorization: authHeader } : undefined}
            name={title}
            size={50}
            presence={chat.type === 'direct' && chat.peerOnline ? 'online' : null}
            anon={!!chat.anonMasked}
          />
          {avatarBusy && <View style={S.avatarBusy}><ActivityIndicator size="small" color={colors.primary} /></View>}
          {selectMode && (
            <View style={[S.selBadge, isSelected ? S.selBadgeOn : S.selBadgeOff]}>
              {isSelected && <Ionicons name="checkmark" size={13} color={colors.onPrimary} />}
            </View>
          )}
        </TouchableOpacity>

        <View style={S.rowBody}>
          <View style={S.rowTop}>
            <Text style={S.rowName} numberOfLines={1}>{title}</Text>
            {/* THE FLAGS SHARE ONE BOX, and it is not decoration.
                rowTop has `gap`, which applies between EVERY child — so three
                loose icons cost four gaps plus their own marginLefts, ~31dp of
                spacing in the row where the name is competing for width. The
                name is the only flexible child, so every one of those pixels
                came out of it and turned readable names into ellipses.
                Grouped, the outer row has three children and two gaps, and the
                cluster spaces itself tightly. flexShrink: 0 because status must
                not be squeezed away — the NAME is what may truncate. */}
            {(chat.expiresAt || chat.muted || chat.pinned) && (
              <View style={S.rowFlags}>
                {/* This chat deletes itself (migration 120). A timer icon in the
                    list, not just inside the chat: the whole conversation is
                    about to go, and finding that out only by opening it is
                    finding out too late. */}
                {chat.expiresAt && (
                  <Ionicons
                    name="timer-outline"
                    size={14}
                    color={new Date(chat.expiresAt).getTime() - Date.now() <= 600_000 ? colors.danger : colors.textFaint}
                  />
                )}
                {chat.muted && <Ionicons name="volume-mute" size={15} color={colors.textFaint} />}
                {chat.pinned && <Ionicons name="pin" size={14} color={colors.textFaint} />}
              </View>
            )}
            {/* Capped and unshrinkable. A timestamp is a fixed-width fact, but
                at a 130% system font scale it grew ~25% wider and took that
                width straight off the name. 1.15 keeps it legible without
                letting it eat the thing people actually read. */}
            <Text
              style={[S.rowTime, chat.unreadCount > 0 && { color: colors.primary, fontWeight: '700' }]}
              numberOfLines={1}
              maxFontSizeMultiplier={1.15}
            >
              {time}
            </Text>
          </View>
          <View style={S.rowBottom}>
            {isTyping ? (
              <Text style={[S.rowPreview, { color: colors.primary }]} numberOfLines={1}>typing…</Text>
            ) : (
              <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                {!draftText && !!lastMsg && !!meId && lastMsg.senderId === meId && chat.type === 'direct' && (
                  <Ionicons
                    name={((chat.peerLastReadMessageId ?? 0) >= lastMsg.id || (chat.peerLastDeliveredMessageId ?? 0) >= lastMsg.id) ? 'checkmark-done' : 'checkmark'}
                    size={15}
                    color={(chat.peerLastReadMessageId ?? 0) >= lastMsg.id ? colors.accentOn : colors.textDim}
                    style={{ marginRight: 3 }}
                  />
                )}
                <Text style={[S.rowPreview, chat.unreadCount > 0 && S.rowPreviewUnread]} numberOfLines={1}>
                  {draftText ? <Text style={S.draftLabel}>Draft: </Text> : null}{preview}
                </Text>
              </View>
            )}
            {chat.unreadCount > 0 && (
              <View style={S.unreadBadge}><Text style={S.unreadTxt}>{chat.unreadCount > 99 ? '99+' : chat.unreadCount}</Text></View>
            )}
          </View>
        </View>
      </TouchableOpacity>
    </Swipeable>
  );
});

function formatRelative(iso: string): string {
  try {
    const d = new Date(iso); const diff = Date.now() - d.getTime();
    if (diff < 60_000) return 'now';
    if (diff < 86400_000) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (diff < 7 * 86400_000) return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { day: '2-digit', month: 'short' });
  } catch { return ''; }
}
