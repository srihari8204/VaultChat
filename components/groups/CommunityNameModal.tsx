// components/groups/CommunityNameModal.tsx — the one name/description sheet of
// app/communities.tsx: new community, new group in a community, or edit a
// community (owner). Tapping outside the card dismisses it.

import React from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, TextInput, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../../lib/theme';
import { KeyboardSafe } from '../ui/KeyboardSafe';
import { AppText as Text } from '../ui/Text';
import type { CommunityStyles } from './communityStyles';

export type NameModalMode = 'community' | 'group' | 'edit';

const TITLE: Record<NameModalMode, string> = { community: 'New community', group: 'New group', edit: 'Edit community' };

export function CommunityNameModal({ S, mode, name, desc, onName, onDesc, busy, onCancel, onSubmit }: {
  S: CommunityStyles;
  mode: NameModalMode | null;
  name: string;
  desc: string;
  onName: (v: string) => void;
  onDesc: (v: string) => void;
  busy: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { colors } = useTheme();
  const off = !name.trim() || busy;
  const isGroup = mode === 'group';
  return (
    <Modal visible={mode != null} transparent animationType="fade" onRequestClose={onCancel}>
      <KeyboardSafe keyboardOnly>
        <View style={S.modalBackdrop}>
          <Pressable style={S.modalScrim} onPress={onCancel} accessibilityRole="button" accessibilityLabel="Close without saving" />
          <ScrollView style={S.modalCard} contentContainerStyle={S.modalContent} keyboardShouldPersistTaps="handled">
            <Text style={S.modalTitle} accessibilityRole="header">{mode ? TITLE[mode] : ''}</Text>
            <TextInput style={S.modalInput} value={name} onChangeText={onName}
              placeholder={isGroup ? 'Group name' : 'Community name'} accessibilityLabel={isGroup ? 'Group name' : 'Community name'}
              placeholderTextColor={colors.textDim} autoFocus maxLength={100} />
            {!isGroup && (
              <TextInput style={[S.modalInput, { minHeight: 60, textAlignVertical: 'top' }]} value={desc} onChangeText={onDesc}
                placeholder="Description (optional)" accessibilityLabel="Description, optional"
                placeholderTextColor={colors.textDim} multiline maxLength={512} />
            )}
            <View style={S.modalBtns}>
              <TouchableOpacity accessibilityRole="button" onPress={onCancel} style={S.modalBtn}><Text style={S.modalCancel}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel={mode === 'edit' ? 'Save' : 'Create'}
                accessibilityState={{ disabled: off, busy }} onPress={onSubmit} disabled={off}
                style={[S.modalBtn, S.modalBtnPrimary, off && { opacity: 0.5 }]}>
                {busy ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={S.modalCreate}>{mode === 'edit' ? 'Save' : 'Create'}</Text>}
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </KeyboardSafe>
    </Modal>
  );
}
