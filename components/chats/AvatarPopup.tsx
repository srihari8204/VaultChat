// components/chats/AvatarPopup.tsx — the Chats tab's avatar photo popup
// (WhatsApp-style): the photo, the name, and Message / Audio / Video / Info.
// Moved out of app/(tabs)/chats.tsx. One fix in the move: the scrim is now a
// SIBLING of the card instead of wrapping it, so a screen reader reaches the
// card's own buttons rather than one big "Close" around them (calls.tsx uses
// the same shape).

import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useTheme } from '../../lib/theme';
import { attachmentUrl, type ChatSummary } from '../../lib/chatService';
import { initialOf } from '../../lib/format';
import { useChatListStyles } from './chatListStyles';

export function AvatarPopup({ chat, authHeader, onClose, onMessage }: {
  chat: ChatSummary | null;
  authHeader: string | null;
  onClose: () => void;
  onMessage: (chatId: string) => void;
}) {
  const { colors } = useTheme();
  const S = useChatListStyles();
  const router = useRouter();
  return (
    <Modal visible={!!chat} transparent animationType="fade" onRequestClose={onClose}>
      <View style={S.avBackdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
        {chat && (() => {
          const isDirect = chat.type === 'direct';
          const avTitle = isDirect ? (chat.peerName || chat.name || 'Direct chat') : (chat.name || 'Group chat');
          const avPhoto = isDirect ? chat.peerPhotoURL : chat.photoURL;
          const peerUid = chat.peerUserId ?? '';
          const go = (fn: () => void) => { onClose(); fn(); };
          return (
            <View style={S.avCard} accessibilityViewIsModal>
              <View style={S.avImgWrap}>
                {avPhoto && authHeader ? (
                  <Image source={{ uri: attachmentUrl(avPhoto), headers: { Authorization: authHeader } }} style={S.avImg} contentFit="cover" cachePolicy="memory-disk" />
                ) : (
                  <View style={[S.avImg, S.avInitials]}><Text style={S.avInitialsTxt}>{initialOf(avTitle)}</Text></View>
                )}
                <View style={S.avNameBar}><Text style={S.avNameTxt} numberOfLines={1}>{avTitle}</Text></View>
              </View>
              <View style={S.avActions}>
                <TouchableOpacity style={S.avActionBtn} onPress={() => go(() => onMessage(chat.id))} accessibilityRole="button" accessibilityLabel={`Message ${avTitle}`}>
                  <Ionicons name="chatbubble-ellipses" size={22} color={colors.primary} /><Text style={S.avActionTxt}>Message</Text>
                </TouchableOpacity>
                {isDirect && (
                  <>
                    <TouchableOpacity style={S.avActionBtn} onPress={() => go(() => router.push({ pathname: '/voicecall', params: { chatId: chat.id, peerUid, peerName: avTitle } }))} accessibilityRole="button" accessibilityLabel={`Voice call ${avTitle}`}>
                      <Ionicons name="call" size={22} color={colors.primary} /><Text style={S.avActionTxt}>Audio</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={S.avActionBtn} onPress={() => go(() => router.push({ pathname: '/videocall', params: { chatId: chat.id, peerUid, peerName: avTitle } }))} accessibilityRole="button" accessibilityLabel={`Video call ${avTitle}`}>
                      <Ionicons name="videocam" size={22} color={colors.primary} /><Text style={S.avActionTxt}>Video</Text>
                    </TouchableOpacity>
                  </>
                )}
                <TouchableOpacity style={S.avActionBtn} accessibilityRole="button" accessibilityLabel={`${avTitle} info`} onPress={() => go(() => isDirect
                  ? router.push({ pathname: '/contact-info', params: { chatId: chat.id, peerUid, peerName: avTitle } })
                  // group-info reads `id`, not `chatId` — see app/chat.tsx.
                  : router.push({ pathname: '/group-info', params: { id: chat.id } }))}>
                  <Ionicons name="information-circle" size={22} color={colors.primary} /><Text style={S.avActionTxt}>Info</Text>
                </TouchableOpacity>
              </View>
            </View>
          );
        })()}
      </View>
    </Modal>
  );
}
