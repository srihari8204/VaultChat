// components/chat/ChatModals.tsx — the chat screen's small modals: Message
// Info, the profile-photo popup, the attach grid and the forward picker. Moved
// out of app/chat.tsx unchanged; the screen owns their visibility and actions.
//
// Each backdrop's dismiss target is a SIBLING behind the sheet, not its parent
// (as in MessageActionSheet): an accessible Pressable wrapping the sheet folds
// every control in it into one VoiceOver element.

import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Avatar, KeyboardSafe } from '../ui';
import { useTheme } from '../../lib/theme';
import { initialOf } from '../../lib/format';
import { forwardNotice } from '../../lib/forwardPolicy';
import { attachmentUrl, looksEncrypted, type ChatMember, type ChatSummary } from '../../lib/chatService';
import { getMessageReceipts, receiptSections, receiptTime, type MemberReceipt, type MessageReceipts } from '../../lib/chatReceipts';
import { useS, type DisplayMessage } from './chatStyles';

/** Message Info — who delivered/read this message (WhatsApp-style).
 *
 * Per-member times come from GET .../receipts (lib/chatReceipts) when the
 * server has it. Until that endpoint is deployed it answers 404 and this falls
 * back to the member read/delivered pointers from GET /chats/:id, with no times. */
export function MessageInfoModal({ infoMsg, onClose, otherMembers, screenAuthHeader, chatId }: {
  infoMsg: DisplayMessage | null; onClose: () => void; otherMembers: ChatMember[]; screenAuthHeader: string | null;
  chatId: string;
}) {
  const S = useS();
  const { colors } = useTheme();
  // undefined = not asked / loading, null = not available (fallback), else the answer.
  const [receipts, setReceipts] = useState<MessageReceipts | null | undefined>(undefined);
  const [timesFailed, setTimesFailed] = useState(false);
  const mid = infoMsg?.id ?? 0;
  useEffect(() => {
    setReceipts(undefined); setTimesFailed(false);
    if (!(mid > 0)) return;
    let cancel = false;
    getMessageReceipts(chatId, mid)
      .then(r => { if (!cancel) setReceipts(r); })
      .catch(() => { if (!cancel) { setReceipts(null); setTimesFailed(true); } });
    return () => { cancel = true; };
  }, [chatId, mid]);
  const byId = useMemo(() => new Map(otherMembers.map(m => [m.userId, m])), [otherMembers]);

  const Row = (m: ChatMember, detail?: string) => (
    <View key={m.userId} style={S.infoRow} accessible accessibilityLabel={`${m.name || m.email || 'Member'}${detail ? `, ${detail}` : ''}`}>
      <Avatar uri={m.photoURL && screenAuthHeader ? attachmentUrl(m.photoURL) : null} headers={screenAuthHeader ? { Authorization: screenAuthHeader } : undefined} name={m.name || m.email || '?'} size={36} ring />
      <View style={{ flex: 1 }}>
        <Text style={[S.infoName, { flex: 0 }]} numberOfLines={1}>{m.name || m.email || m.userId.slice(0, 8)}</Text>
        {!!detail && <Text style={S.infoDetail} numberOfLines={1}>{detail}</Text>}
      </View>
    </View>
  );
  const Section = (title: string, icon: any, color: string, rows: React.ReactNode[]) => rows.length ? (
    <View key={title} style={{ marginTop: 14 }}>
      <View style={S.infoSecHdr} accessibilityRole="header">
        <Ionicons name={icon} size={16} color={color} />
        <Text style={S.infoSecTitle}>{title} · {rows.length}</Text>
      </View>
      {rows}
    </View>
  ) : null;

  let body: React.ReactNode = null;
  if (infoMsg && receipts === undefined) {
    body = <ActivityIndicator color={colors.primary} style={{ marginVertical: 24 }} accessibilityLabel="Loading message info" />;
  } else if (infoMsg && receipts) {
    const sec = receiptSections(receipts);
    // Names come from the members we already hold (anon-masked chats stay masked).
    const who = (r: MemberReceipt): ChatMember => byId.get(r.userId) ?? ({ userId: r.userId, name: null, email: null, photoURL: null } as unknown as ChatMember);
    const at = (label: string, iso: string | null) => (receiptTime(iso) ? `${label} ${receiptTime(iso)}` : '');
    body = (
      <ScrollView style={{ maxHeight: 420 }}>
        {Section('Read', 'checkmark-done', colors.accentOn, sec.read.map(r => Row(who(r), [at('Read', r.readAt), at('Delivered', r.deliveredAt)].filter(Boolean).join(' · '))))}
        {Section('Delivered', 'checkmark-done', colors.textDim, sec.delivered.map(r => Row(who(r), at('Delivered', r.deliveredAt))))}
        {Section('Sent', 'checkmark', colors.textDim, sec.sent.map(r => Row(who(r))))}
        {sec.readReceiptsHidden && <Text style={S.infoEmpty}>Read receipts are off in this chat.</Text>}
        {receipts.members.length === 0 && <Text style={S.infoEmpty}>No other members.</Text>}
      </ScrollView>
    );
  } else if (infoMsg) {
    // Fallback: the pointers from GET /chats/:id. Exclude departed members so
    // this breakdown agrees with the summary tick (a left member must not show
    // as "never delivered" under a blue tick).
    const recips = otherMembers.filter(m => !m.leftAt);
    const read = recips.filter(m => (m.lastReadMessageId ?? 0) >= mid);
    const delivered = recips.filter(m => (m.lastDeliveredMessageId ?? 0) >= mid && (m.lastReadMessageId ?? 0) < mid);
    const sent = recips.filter(m => (m.lastDeliveredMessageId ?? 0) < mid);
    body = (
      <ScrollView style={{ maxHeight: 420 }}>
        {Section('Read', 'checkmark-done', colors.accentOn, read.map(m => Row(m)))}
        {Section('Delivered', 'checkmark-done', colors.textDim, delivered.map(m => Row(m)))}
        {Section('Sent', 'checkmark', colors.textDim, sent.map(m => Row(m)))}
        {otherMembers.length === 0 && <Text style={S.infoEmpty}>No other members.</Text>}
        {timesFailed && <Text style={S.infoEmpty}>Could not load delivery times right now.</Text>}
      </ScrollView>
    );
  }

  return (
    <Modal visible={infoMsg != null} transparent animationType="slide" onRequestClose={onClose}>
      <View style={S.infoBackdrop} accessibilityViewIsModal>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close message info" />
        <View style={S.infoSheet}>
          <View style={S.sheetGrip} />
          <Text style={S.infoTitle} accessibilityRole="header">Message info</Text>
          {body}
        </View>
      </View>
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
      <View style={S.photoBackdrop} accessibilityViewIsModal>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close profile photo" />
        <View style={S.photoCard}>
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
        </View>
      </View>
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
      <View style={S.attachBackdrop} accessibilityViewIsModal>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close attach menu" />
        <View style={S.attachSheet}>
          <View style={S.attachHandle} />
          <View style={S.attachGrid}>
            {actions.map((a) => (
              <TouchableOpacity
                key={a.label}
                style={S.attachCell}
                activeOpacity={0.7}
                // ponytail: a fixed 120 ms lets this sheet finish closing before the
                // action opens a picker or screen (iOS will not present one over a
                // dismissing modal). Modal onDismiss is iOS-only; replace this with
                // it plus an Android path if a slow device ever shows the race.
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
        </View>
      </View>
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
  // Filter by chat name; a fresh forward starts with an empty filter.
  const [q, setQ] = useState('');
  useEffect(() => { setQ(''); }, [forwardMsg]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? forwardChats.filter(c => (c.name || '').toLowerCase().includes(needle)) : forwardChats;
  }, [forwardChats, q]);
  return (
    <Modal
      visible={forwardMsg != null}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      {/* KeyboardSafe: the sheet has a search field, so it lifts above the keyboard. */}
      <KeyboardSafe keyboardOnly>
      <View style={S.modalBackdrop} accessibilityViewIsModal>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close forward picker" />
        <View style={S.forwardSheet}>
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
          ) : (<>
            <TextInput
              style={[S.inChatSearchInput, { flex: 0 }]}
              placeholder="Search chats"
              placeholderTextColor={colors.textDim}
              value={q}
              onChangeText={setQ}
              maxLength={100}
              accessibilityLabel="Search chats to forward to"
              returnKeyType="search"
            />
            {shown.length === 0 && <Text style={S.forwardEmpty}>No chat matches “{q.trim()}”</Text>}
            <FlatList
              data={shown}
              keyboardShouldPersistTaps="handled"
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
          </>)}
        </View>
      </View>
      </KeyboardSafe>
    </Modal>
  );
}
