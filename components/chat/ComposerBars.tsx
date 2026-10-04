// components/chat/ComposerBars.tsx — everything stacked directly above the
// composer: the @mention picker, live viewers, typing line, and the edit /
// Vanish Mode / Invisible Ink / link-preview / reply bars. Moved out of
// app/chat.tsx unchanged; the screen owns all of their state.

import { Image, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Avatar } from '../ui';
import { useTheme } from '../../lib/theme';
import { attachmentUrl, type ChatMember } from '../../lib/chatService';
import type { LinkPreviewData } from '../../lib/linkPreview';
import type { Viewer } from '../../hooks/useChatViewers';
import { ViewerStack, type ResolvedViewer } from './ViewerStack';
import { useS, type DisplayMessage } from './chatStyles';
import { previewText } from './protectedText';

/** @mention picker (W15) — appears while typing "@name" in a group. */
export function MentionPicker({ candidates, onPick, screenAuthHeader }: {
  candidates: ChatMember[]; onPick: (m: ChatMember) => void; screenAuthHeader: string | null;
}) {
  const S = useS();
  if (!candidates.length) return null;
  return (
    <View style={S.mentionBar}>
      {candidates.map(m => (
        <TouchableOpacity key={m.userId} style={S.mentionRow} onPress={() => onPick(m)} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={`Mention ${m.name || m.email || 'member'}`}>
          <Avatar
            uri={m.photoURL && screenAuthHeader ? attachmentUrl(m.photoURL) : null}
            headers={screenAuthHeader ? { Authorization: screenAuthHeader } : undefined}
            name={m.name || m.email || 'member'}
            size={28}
          />
          <Text style={S.mentionName} numberOfLines={1}>{m.name || m.email}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

export function ComposerBars({
  chatViewers, resolveViewer, typingUids, membersById, editingId, editingText, onCancelEdit,
  vanishMode, nextInvisibleInk, onDisarmInk, composerLp, onDismissLp, replyTo, meId, onCancelReply,
}: {
  chatViewers: Viewer[];
  resolveViewer: (userId: string) => ResolvedViewer;
  typingUids: Set<string>;
  membersById: Map<string, ChatMember>;
  editingId: number | null;
  /** Current text of the message being edited, quoted in the edit bar. */
  editingText: string | null | undefined;
  onCancelEdit: () => void;
  vanishMode?: boolean;
  nextInvisibleInk: boolean;
  onDisarmInk: () => void;
  composerLp: { url: string; data: LinkPreviewData } | null;
  onDismissLp: () => void;
  replyTo: DisplayMessage | null;
  meId: string | null;
  onCancelReply: () => void;
}) {
  const S = useS();
  const { colors } = useTheme();
  return (
    <>
      {/* Live Chat Viewers (#58): who's viewing right now — tap for details.
          MOVED OUT OF THE HEADER. It sat under the title, where it pushed the
          header taller the moment anyone opened the chat — a header that grows
          when a second person looks at it is the worst place for it on a small
          screen. Down here it sits with the typing line, directly above the
          composer: both answer "what is the other person doing right now", and
          both belong next to where you are about to reply. */}
      {chatViewers.length > 0 && (
        <View style={S.typingBar}>
          <ViewerStack viewers={chatViewers} resolve={resolveViewer} />
        </View>
      )}

      {/* Typing indicator */}
      {typingUids.size > 0 && (
        <View style={S.typingBar} accessibilityLiveRegion="polite">
          <Text style={S.typingTxt}>
            {Array.from(typingUids).map(uid => {
              const m = membersById.get(uid);
              return m?.name || m?.email || 'Someone';
            }).join(', ')} {typingUids.size === 1 ? 'is' : 'are'} typing…
          </Text>
        </View>
      )}

      {/* Edit-mode banner */}
      {editingId != null && (
        <View style={S.editBar}>
          <Text style={S.editTxt} numberOfLines={1}>
            Editing: “{editingText ?? 'message'}”
          </Text>
          <TouchableOpacity onPress={onCancelEdit} hitSlop={8} accessibilityRole="button" accessibilityLabel="Cancel editing">
            <Text style={S.editCancelTxt}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Vanish Mode banner — shown above the composer when ON */}
      {vanishMode && (
        <View style={S.vanishBar}>
          <Text style={S.vanishBarTxt}>
            💨 Vanish Mode — new messages disappear after everyone reads them
          </Text>
        </View>
      )}

      {/* Invisible Ink banner — armed for one message; tap to disarm */}
      {nextInvisibleInk && (
        <TouchableOpacity
          style={S.inkBar}
          onPress={onDisarmInk}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityHint="Disarms Invisible Ink for the next message"
        >
          <Text style={S.inkBarTxt}>
            ✨ Next message will be Invisible Ink — recipient must tilt phone to read. Tap to disarm.
          </Text>
        </TouchableOpacity>
      )}

      {/* Compose-time link preview (F5) — resolved on the sender's device,
          travels inside the E2EE payload. Tap ✕ to send without a preview. */}
      {composerLp && (
        <View style={S.lpBar}>
          {composerLp.data.i ? <Image source={{ uri: composerLp.data.i }} style={S.lpBarImg} /> : null}
          <View style={{ flex: 1, marginHorizontal: 8 }}>
            <Text style={S.lpBarTitle} numberOfLines={1}>{composerLp.data.t}</Text>
            {composerLp.data.d ? <Text style={S.lpBarDesc} numberOfLines={1}>{composerLp.data.d}</Text> : null}
          </View>
          <TouchableOpacity hitSlop={10} onPress={onDismissLp} accessibilityRole="button" accessibilityLabel="Remove link preview">
            <Ionicons name="close" size={18} color={colors.textDim} />
          </TouchableOpacity>
        </View>
      )}

      {/* Reply-to banner */}
      {replyTo && (
        <View style={S.replyBar}>
          <View style={S.replyBarLine} />
          <View style={{ flex: 1 }}>
            <Text style={S.replyBarTitle} numberOfLines={1}>
              Replying to {replyTo.senderId === meId ? 'You' : (membersById.get(replyTo.senderId)?.name || 'message')}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              {replyTo.type === 'image' ? <Ionicons name="image" size={13} color={colors.textDim} />
                : replyTo.type === 'audio' ? <Ionicons name="mic" size={13} color={colors.textDim} />
                : replyTo.type === 'video' ? <Ionicons name="videocam" size={13} color={colors.textDim} />
                : replyTo.type === 'file'  ? <Ionicons name="document" size={13} color={colors.textDim} />
                : replyTo.type === 'vaultbeam' ? <Ionicons name="cube" size={13} color={colors.textDim} /> : null}
              <Text style={S.replyBarBody} numberOfLines={1}>
                {replyTo.type === 'image' ? 'Photo'
                  : replyTo.type === 'audio' ? 'Voice message'
                  : replyTo.type === 'video' ? 'Video'
                  : replyTo.type === 'file'  ? 'File'
                  : replyTo.type === 'vaultbeam' ? 'File'
                  : previewText(replyTo, replyTo.content ?? '')}
              </Text>
            </View>
          </View>
          <TouchableOpacity onPress={onCancelReply} hitSlop={8} accessibilityRole="button" accessibilityLabel="Cancel reply">
            <Ionicons name="close" size={20} color={colors.textDim} />
          </TouchableOpacity>
        </View>
      )}
    </>
  );
}
