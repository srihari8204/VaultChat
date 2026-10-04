// components/chat/ChatModals.tsx — the chat screen's small modals: Message
// Info, the profile-photo popup, the attach grid and the forward picker. Moved
// out of app/chat.tsx unchanged; the screen owns their visibility and actions.

import { ActivityIndicator, FlatList, Image, Modal, Pressable, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Avatar } from '../ui';
import { useTheme } from '../../lib/theme';
import { initialOf } from '../../lib/format';
import { forwardNotice } from '../../lib/forwardPolicy';
import { attachmentUrl, looksEncrypted, type ChatMember, type ChatSummary } from '../../lib/chatService';
import { useS, type DisplayMessage } from './chatStyles';

/** Message Info — who delivered/read this message (WhatsApp-style). */
export function MessageInfoModal({ infoMsg, onClose, otherMembers, screenAuthHeader }: {
  infoMsg: DisplayMessage | null; onClose: () => void; otherMembers: ChatMember[]; screenAuthHeader: string | null;
}) {
  const S = useS();
  const { colors } = useTheme();
  return (
    <Modal visible={infoMsg != null} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={S.infoBackdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close message info">
        <Pressable style={S.infoSheet} onPress={() => {}} accessibilityViewIsModal>
          <View style={S.sheetGrip} />
          <Text style={S.infoTitle}>Message info</Text>
          {infoMsg && (() => {
            const mid = infoMsg.id;
            // Exclude departed members so this breakdown agrees with the summary
            // tick (a left member must not show as "never delivered" under a blue tick).
            const recips = otherMembers.filter(m => !m.leftAt);
            const read = recips.filter(m => (m.lastReadMessageId ?? 0) >= mid);
            const delivered = recips.filter(m => (m.lastDeliveredMessageId ?? 0) >= mid && (m.lastReadMessageId ?? 0) < mid);
            const sent = recips.filter(m => (m.lastDeliveredMessageId ?? 0) < mid);
            const Row = (m: ChatMember) => (
              <View key={m.userId} style={S.infoRow}>
                <Avatar uri={m.photoURL && screenAuthHeader ? attachmentUrl(m.photoURL) : null} headers={screenAuthHeader ? { Authorization: screenAuthHeader } : undefined} name={m.name || m.email || '?'} size={36} ring />
                <Text style={S.infoName} numberOfLines={1}>{m.name || m.email || m.userId.slice(0, 8)}</Text>
              </View>
            );
            const Section = (title: string, icon: any, color: string, list: ChatMember[]) => list.length ? (
              <View key={title} style={{ marginTop: 14 }}>
                <View style={S.infoSecHdr}>
                  <Ionicons name={icon} size={16} color={color} />
                  <Text style={S.infoSecTitle}>{title} · {list.length}</Text>
                </View>
                {list.map(Row)}
              </View>
            ) : null;
            return (
              <ScrollView style={{ maxHeight: 420 }}>
                {Section('Read', 'checkmark-done', colors.tickRead, read)}
                {Section('Delivered', 'checkmark-done', colors.textDim, delivered)}
                {Section('Sent', 'checkmark', colors.textDim, sent)}
                {otherMembers.length === 0 && <Text style={S.infoEmpty}>No other members.</Text>}
              </ScrollView>
            );
          })()}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** Profile photo viewer (avatar tap with no active story) — WhatsApp popup. */
export function ProfilePhotoModal({ visible, onClose, headerPhotoId, screenAuthHeader, title, isDirect, onCall, onInfo }: {
  visible: boolean; onClose: () => void; headerPhotoId: string | null; screenAuthHeader: string | null;
  title: string; isDirect: boolean; onCall: (kind: 'voice' | 'video') => void; onInfo: () => void;
}) {
  const S = useS();
  const { colors } = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={S.photoBackdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close profile photo">
        <Pressable style={S.photoCard} onPress={() => {}} accessibilityViewIsModal>
          <View style={S.photoImgWrap}>
            {headerPhotoId && screenAuthHeader ? (
              <Image source={{ uri: attachmentUrl(headerPhotoId), headers: { Authorization: screenAuthHeader } }} style={S.photoImg} resizeMode="cover" />
            ) : (
              <View style={[S.photoImg, S.photoInitialsWrap]}><Text style={S.photoInitials}>{initialOf(title)}</Text></View>
            )}
            <View style={S.photoNameBar}><Text style={S.photoNameTxt} numberOfLines={1}>{title}</Text></View>
          </View>
          <View style={S.photoActions}>
            <TouchableOpacity style={S.photoActionBtn} onPress={onClose} accessibilityRole="button" accessibilityLabel="Message">
              <Ionicons name="chatbubble-ellipses" size={22} color={colors.primary} />
              <Text style={S.photoActionTxt}>Message</Text>
            </TouchableOpacity>
            {isDirect && (
              <>
                <TouchableOpacity style={S.photoActionBtn} onPress={() => { onClose(); onCall('voice'); }} accessibilityRole="button" accessibilityLabel="Audio call">
                  <Ionicons name="call" size={22} color={colors.primary} />
                  <Text style={S.photoActionTxt}>Audio</Text>
                </TouchableOpacity>
                <TouchableOpacity style={S.photoActionBtn} onPress={() => { onClose(); onCall('video'); }} accessibilityRole="button" accessibilityLabel="Video call">
                  <Ionicons name="videocam" size={22} color={colors.primary} />
                  <Text style={S.photoActionTxt}>Video</Text>
                </TouchableOpacity>
              </>
            )}
            <TouchableOpacity style={S.photoActionBtn} onPress={() => { onClose(); onInfo(); }} accessibilityRole="button" accessibilityLabel="Info">
              <Ionicons name="information-circle" size={22} color={colors.primary} />
              <Text style={S.photoActionTxt}>Info</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export type AttachAction = { label: string; icon: keyof typeof Ionicons.glyphMap; onPress: () => void };

/** Attach menu — WhatsApp-style grid of round icons. */
export function AttachMenu({ visible, onClose, actions }: { visible: boolean; onClose: () => void; actions: AttachAction[] }) {
  const S = useS();
  const { colors } = useTheme();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={S.attachBackdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close attach menu">
        <Pressable style={S.attachSheet} onPress={() => {}} accessibilityViewIsModal>
          <View style={S.attachHandle} />
          <View style={S.attachGrid}>
            {actions.map((a) => (
              <TouchableOpacity
                key={a.label}
                style={S.attachCell}
                activeOpacity={0.7}
                onPress={() => { onClose(); setTimeout(a.onPress, 120); }}
                accessibilityRole="button"
                accessibilityLabel={a.label}
              >
                <View style={S.attachIcon}>
                  <Ionicons name={a.icon} size={26} color={colors.text} />
                </View>
                <Text style={S.attachLabel} numberOfLines={1}>{a.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** Forward chat picker (single target). */
export function ForwardPicker({ forwardMsg, onClose, forwardChats, forwardLoading, meId, membersById, onPick }: {
  forwardMsg: DisplayMessage | null; onClose: () => void; forwardChats: ChatSummary[]; forwardLoading: boolean;
  meId: string | null; membersById: Map<string, ChatMember>; onPick: (target: ChatSummary) => void;
}) {
  const S = useS();
  const { colors } = useTheme();
  return (
    <Modal
      visible={forwardMsg != null}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={S.modalBackdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close forward picker">
        <Pressable style={S.forwardSheet} onPress={(e) => e.stopPropagation()} accessibilityViewIsModal>
          <Text style={S.forwardTitle}>Forward to…</Text>
          {/* AUDIT F10. Shown only for a message that has already travelled
              far — a warning on every forward is noise that trains people to
              dismiss it unread. The picker is single-select, so the "one chat
              at a time" rule it states is already true; saying it out loud is
              what makes the next hop deliberate rather than reflexive. */}
          {forwardMsg && forwardNotice(forwardMsg.meta) && (
            <Text style={S.forwardManyNotice}>{forwardNotice(forwardMsg.meta)}</Text>
          )}
          {/* Preview of the message being forwarded (which msg) */}
          {forwardMsg && (
            <View style={S.forwardPreview}>
              <View style={S.replyPreviewLine} />
              <View style={{ flex: 1 }}>
                <Text style={S.forwardPreviewWho} numberOfLines={1}>
                  {forwardMsg.senderId === meId ? 'You' : (membersById.get(forwardMsg.senderId)?.name || membersById.get(forwardMsg.senderId)?.email || 'Message')}
                </Text>
                <Text style={S.forwardPreviewBody} numberOfLines={2}>
                  {forwardMsg.type === 'image' ? '📷 Photo'
                    : forwardMsg.type === 'video' ? '🎥 Video'
                    : forwardMsg.type === 'audio' ? '🎙️ Voice message'
                    : forwardMsg.type === 'file'  ? '📎 File'
                    : forwardMsg.type === 'vaultbeam' ? '📦 File'
                    : (forwardMsg.content && !looksEncrypted(forwardMsg.content) ? forwardMsg.content : `[${forwardMsg.type}]`)}
                </Text>
              </View>
            </View>
          )}
          {forwardLoading ? (
            <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} />
          ) : forwardChats.length === 0 ? (
            <Text style={S.forwardEmpty}>No other chats yet</Text>
          ) : (
            <FlatList
              data={forwardChats}
              keyExtractor={(c) => c.id}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={S.forwardRow}
                  onPress={() => onPick(item)}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`Forward to ${item.name || 'chat'}`}
                >
                  <Text style={S.forwardRowTxt} numberOfLines={1}>
                    {item.name || item.id.slice(0, 8)}
                  </Text>
                  <Text style={S.forwardRowSub}>{item.type === 'group' ? 'Group' : 'Chat'}</Text>
                </TouchableOpacity>
              )}
            />
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
