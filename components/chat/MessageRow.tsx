// components/chat/MessageRow.tsx — one row of the chat thread: the "load
// newer" pill, Exit-Kit seam, date chip, unread divider and the bubble (or an
// album scroller) inside swipe-to-reply. Moved out of app/chat.tsx's renderItem
// unchanged; the screen passes everything it decides.

import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { brandAlpha } from '../../constants/theme';
import { IMPORT_SOURCE } from '../../constants/importSources';
import { useTheme } from '../../lib/theme';
import type { ChatMember, PollVoteSummary, ReactionSummary } from '../../lib/chatService';
import { MemoBubble } from './MessageBubble';
import { DateChip, UnreadDivider, ImportedDivider, SwipeToReply } from './ThreadDecor';
import { isSameCalendarDay } from './chatFormat';
import type { DisplayMessage } from './chatStyles';

export function MessageRow({
  item, older, unreadInfo, newerGapBeforeId, loadingNewer, onStartReached, flashId,
  resolveReply, membersById, meId, chatId, otherMembers, onLongPressMessage, jumpToMessage,
  mergedReactions, toggleReaction, highlight, tiltRevealed, bubbleColors, pollVotesForMsg,
  onPollVoteChange, onReply,
}: {
  item: DisplayMessage;
  /** The row drawn above this one — the older neighbour in the inverted list. */
  older: DisplayMessage | undefined;
  unreadInfo: { boundaryId: number; count: number } | null;
  newerGapBeforeId: number | null;
  loadingNewer: boolean;
  onStartReached: () => void;
  flashId: number | null;
  resolveReply: (id?: number | null) => DisplayMessage | null;
  membersById: Map<string, ChatMember>;
  meId: string | null;
  chatId: string;
  otherMembers: ChatMember[];
  onLongPressMessage: (msg: DisplayMessage, plain: string) => void;
  jumpToMessage: (targetId: number) => void;
  mergedReactions: Record<number, ReactionSummary[]>;
  toggleReaction: (msg: DisplayMessage, emoji: string) => void;
  highlight: string | null;
  tiltRevealed: boolean;
  bubbleColors: { mine: string; peer: string } | null;
  pollVotesForMsg: PollVoteSummary | undefined;
  onPollVoteChange: (id: number, next: PollVoteSummary) => void;
  onReply: (msg: DisplayMessage) => void;
}) {
  const { colors } = useTheme();
  // Inverted list: `older` is the row at index+1. Show a date chip
  // above the first (oldest) message of each calendar day.
  const showDate = !older || !isSameCalendarDay(item.createdAt, older.createdAt);
  // Group with the older message when it's the same sender, same day, and
  // within 5 minutes (suppresses the repeated sender tag + tightens spacing).
  const grouped = !showDate && !!older && older.senderId === item.senderId &&
    item.type !== 'system' && older.type !== 'system' &&
    Math.abs(new Date(item.createdAt).getTime() - new Date(older.createdAt).getTime()) < 5 * 60 * 1000;
  // Unread separator above the first message newer than the read boundary.
  const showUnread = !!unreadInfo && item.id > unreadInfo.boundaryId &&
    (!older || older.id <= unreadInfo.boundaryId);
  // Resolve once per row — this used to run twice (once for the target,
  // once inside an IIFE for its member), doubling the lookup per bubble.
  const replyTarget = resolveReply(item.replyToId);
  // Exit Kit: imported history carries negative ids, so the seam between
  // it and real crazzychat messages is exactly where the sign flips. Two
  // cases — the transition, and the top of a chat that is ALL imported
  // (nothing has been sent here yet), which has no transition to mark.
  const mine   = item.meta?.origin as string | undefined;
  const theirs = older?.meta?.origin as string | undefined;
  const importMark = !IMPORT_SOURCE[mine!] && IMPORT_SOURCE[theirs!] ? { origin: theirs!, atStart: false }
    : IMPORT_SOURCE[mine!] && !older ? { origin: mine!, atStart: true }
    : null;
  // Swipe-to-reply, and the bubble's Reply accessibility action.
  const replyToItem = () => { if (!item.deletedAt && item.type !== 'system') onReply(item); };
  return (
    <View>
      {newerGapBeforeId === item.id && (
        <TouchableOpacity
          onPress={onStartReached}
          disabled={loadingNewer}
          accessibilityRole="button"
          accessibilityLabel="Load newer messages"
          style={{ alignSelf: 'center', marginVertical: 8, paddingHorizontal: 14, paddingVertical: 7,
            borderRadius: 16, backgroundColor: colors.surfaceSolid }}
        >
          {loadingNewer
            ? <ActivityIndicator size="small" color={colors.primary} />
            : <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '600' }}>Load newer messages</Text>}
        </TouchableOpacity>
      )}
      {importMark && <ImportedDivider origin={importMark.origin} atStart={importMark.atStart} />}
      {showDate && <DateChip iso={item.createdAt} />}
      {showUnread && <UnreadDivider count={unreadInfo!.count} />}
      <SwipeToReply onReply={replyToItem}>
      <View style={item.id === flashId ? { backgroundColor: brandAlpha(0.18), borderRadius: 12 } : undefined}>
      {item._album ? (
        // Album: several media picked in one action, laid out in a
        // HORIZONTAL scroller inside this vertical list. Horizontal is
        // the only safe nesting direction — a vertical child would fight
        // the list for the pan gesture.
        //
        // Each tile is a full MemoBubble rather than a bespoke thumbnail:
        // encrypted media resolution, key handling, view-once, download
        // progress and retry already live there, and each tile owning its
        // own hooks is exactly what lets them resolve independently.
        // Duplicating that pipeline for a grid is how view-once or a
        // missing key quietly behaves differently in one place.
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          // The parent list keeps the vertical gesture; this keeps the
          // horizontal one, and taps still reach the tiles.
          directionalLockEnabled
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ gap: 6, paddingRight: 12 }}
        >
          {item._album.map((am) => (
            <View key={am._tempId ?? String(am.id)} style={{ maxWidth: 260 }}>
              <MemoBubble
                msg={am}
                meId={meId}
                member={membersById.get(am.senderId)}
                chatId={chatId}
                otherMembers={otherMembers}
                onLongPress={onLongPressMessage}
                onJumpTo={jumpToMessage}
                reactionsForMsg={mergedReactions[am.id]}
                onToggleReaction={(emoji) => toggleReaction(am, emoji)}
                replyTarget={null}
                highlight={null}
                tiltRevealed={tiltRevealed}
                grouped
                bubbleColors={bubbleColors}
              />
            </View>
          ))}
        </ScrollView>
      ) : (
      <MemoBubble
        msg={item}
        meId={meId}
        member={membersById.get(item.senderId)}
        chatId={chatId}
        otherMembers={otherMembers}
        onLongPress={onLongPressMessage}
        onJumpTo={jumpToMessage}
        onReply={replyToItem}
        reactionsForMsg={mergedReactions[item.id]}
        onToggleReaction={(emoji) => toggleReaction(item, emoji)}
        replyTarget={replyTarget}
        replyTargetMember={replyTarget ? membersById.get(replyTarget.senderId) : undefined}
        highlight={highlight}
        tiltRevealed={tiltRevealed}
        grouped={grouped}
        bubbleColors={bubbleColors}
        pollVotesForMsg={pollVotesForMsg}
        onPollVoteChange={(next) => onPollVoteChange(item.id, next)}
      />
      )}
      </View>
      </SwipeToReply>
    </View>
  );
}
