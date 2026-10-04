// components/family/AnnouncementSheet.tsx — compose a group announcement,
// moved out of app/family.tsx. The hub posts it (onPost); the server
// re-checks the permission, so a post can fail even though the button drew.

import React from 'react';
import { View, Modal, Pressable, ScrollView, TouchableOpacity, TextInput, ActivityIndicator, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppText as Text } from '../ui/Text';
import { KeyboardSafe } from '../ui';
import { useTheme } from '../../lib/theme';
import { useSpaceGlass } from '../spaces/SpaceGround';
import { sheetSt } from './sheetStyles';

export default function AnnouncementSheet({ visible, onClose, text, onText, busy, onPost }: {
  visible: boolean;
  onClose: () => void;
  text: string;
  onText: (t: string) => void;
  busy: boolean;
  onPost: () => void;
}) {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  const ready = !!text.trim() && !busy;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardSafe keyboardOnly style={sheetSt.modalWrap}>
        <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close announcement" />
        {/* Height-capped with an inner scroll: with the keyboard up at large
            font scales the fixed sheet pushed its top rows off-screen. */}
        <View style={[sheetSt.modal, { backgroundColor: G.sheet, borderColor: G.edge, maxHeight: '86%' }]}>
          <View style={[sheetSt.grab, { backgroundColor: colors.border }]} />
          <Text style={[sheetSt.modalTitle, { color: colors.text }]} accessibilityRole="header">Announcement</Text>
          <ScrollView bounces={false} keyboardShouldPersistTaps="handled">
            <Text style={{ color: colors.textDim, fontSize: 12.5, textAlign: 'center', marginBottom: 8 }}>
              Pinned to everyone&apos;s dashboard and raised as an alert.
            </Text>
            <TextInput
              value={text} onChangeText={onText} multiline
              placeholder="What should everyone know?" placeholderTextColor={colors.textFaint}
              accessibilityLabel="Announcement text"
              style={[sheetSt.noteInput, { color: colors.text, borderColor: colors.glassStroke, backgroundColor: colors.glassSoft, height: 96, paddingTop: 12 }]}
              maxLength={500}
            />
            <TouchableOpacity
              onPress={onPost}
              disabled={!ready}
              accessibilityRole="button"
              accessibilityLabel="Post to group"
              accessibilityState={{ disabled: !ready, busy }}
              style={[st.btnWide, { backgroundColor: ready ? colors.primary : colors.border }]}
            >
              {busy ? <ActivityIndicator color="#fff" />
                : <><Ionicons name="megaphone" size={17} color="#fff" /><Text style={{ color: '#fff', fontWeight: '800', fontSize: 15 }}>Post to group</Text></>}
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardSafe>
    </Modal>
  );
}

const st = StyleSheet.create({
  btnWide: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 52, borderRadius: 16, marginTop: 12 },
});
