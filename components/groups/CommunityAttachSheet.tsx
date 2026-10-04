// components/groups/CommunityAttachSheet.tsx — pick one of your groups to add
// to a community (POST /communities/:id/groups/:chatId, R4 backend C9). Only
// groups you own or admin are offered; the server makes the final call (it
// checks edit_settings in that group).

import React from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../lib/theme';
import { AppText as Text } from '../ui/Text';
import type { ChatSummary } from '../../lib/chatService';
import type { CommunityStyles } from './communityStyles';

export function CommunityAttachSheet({ S, visible, state, groups, onPick, onRetry, onClose }: {
  S: CommunityStyles;
  visible: boolean;
  state: 'loading' | 'ok' | 'failed';
  groups: ChatSummary[];
  onPick: (g: ChatSummary) => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={S.modalBackdrop}>
        <Pressable style={S.modalScrim} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
        <View style={[S.modalCard, S.modalContent, { maxHeight: '80%' }]}>
          <Text style={S.modalTitle} accessibilityRole="header">Add a group you manage</Text>
          <FlatList
            data={state === 'ok' ? groups : []}
            keyExtractor={(g) => g.id}
            renderItem={({ item: g }) => (
              <TouchableOpacity style={[S.addRow, { paddingHorizontal: 0 }]} onPress={() => onPick(g)}
                accessibilityRole="button" accessibilityLabel={`Add ${g.name ?? 'this group'}`}>
                <View style={S.groupIcon}><Ionicons name="people-outline" size={20} color={colors.primary} /></View>
                <Text style={[S.rowName, { flex: 1 }]} numberOfLines={1}>{g.name ?? 'Group'}</Text>
              </TouchableOpacity>
            )}
            ListEmptyComponent={state === 'loading' ? (
              <ActivityIndicator color={colors.primary} style={{ paddingVertical: 16 }} accessibilityLabel="Loading your groups" />
            ) : state === 'failed' ? (
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Couldn't load your groups. Retry" onPress={onRetry}>
                <Text style={[S.errTxt, { paddingVertical: 12 }]}>Couldn’t load your groups. Tap to retry.</Text>
              </TouchableOpacity>
            ) : (
              <Text style={[S.emptySub, { paddingVertical: 12 }]}>
                No groups to add. Only groups you own or admin, and that are not in this community, are listed.
              </Text>
            )}
          />
          <View style={S.modalBtns}>
            <TouchableOpacity accessibilityRole="button" onPress={onClose} style={S.modalBtn}><Text style={S.modalCancel}>Close</Text></TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}
