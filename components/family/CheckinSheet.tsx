// components/family/CheckinSheet.tsx — "Let your family know you're safe",
// moved out of app/family.tsx. Choose a status, optionally add a note, then
// send. The hub owns sending; this is the sheet.

import React from 'react';
import { View, Modal, Pressable, ScrollView, TouchableOpacity, TextInput, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppText as Text } from '../ui/Text';
import { KeyboardSafe } from '../ui';
import { useTheme } from '../../lib/theme';
import { useSpaceGlass } from '../spaces/SpaceGround';
import { sheetSt } from './sheetStyles';
import { tint } from '../../lib/tintColor';
import type { Palette } from '../../constants/theme';

/** Each status's colour is a semantic theme token (safe / on the way / late /
 *  help), so its tile edge and checkmark keep their contrast in both themes;
 *  the label text on each tile is theme text. */
export const CHECKINS: { label: string; emoji: string; tone: keyof Pick<Palette, 'success' | 'primary' | 'warning' | 'danger'> }[] = [
  { label: "I'm Safe",     emoji: '✅', tone: 'success' },
  { label: 'On My Way',    emoji: '🚗', tone: 'primary' },
  { label: 'Running Late', emoji: '⏳', tone: 'warning' },
  { label: 'Need Help',    emoji: '🆘', tone: 'danger' },
];
export type Checkin = typeof CHECKINS[number];

export default function CheckinSheet({ visible, onClose, picked, onPick, note, onNote, onSend, onImOk }: {
  visible: boolean;
  onClose: () => void;
  picked: Checkin | null;
  onPick: (c: Checkin | null) => void;
  note: string;
  onNote: (t: string) => void;
  onSend: (c: Checkin) => void;
  onImOk: () => void;
}) {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {/* KeyboardSafe, not KeyboardAvoidingView (2026-09-17): a React Native
          <Modal> is its own Android window and never receives the activity's
          adjustResize. keyboardOnly: this sheet already sets its own bottom
          padding. */}
      <KeyboardSafe keyboardOnly style={sheetSt.modalWrap}>
        <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close check-in" />
        <View style={[sheetSt.modal, { backgroundColor: G.sheet, borderColor: G.edge }]}>
          {/* Design screen 20: choose a status, then send. Tapping a status
              used to send immediately, silently dropping a note typed after. */}
          <View style={[sheetSt.grab, { backgroundColor: colors.border }]} />
          <Text style={[sheetSt.modalTitle, { color: colors.text }]} accessibilityRole="header">Let your family know you&apos;re safe</Text>
          <ScrollView bounces={false} keyboardShouldPersistTaps="handled">
            <View style={st.checkGrid} accessibilityRole="radiogroup">
              {CHECKINS.map((c) => {
                const on = picked?.label === c.label;
                const color = colors[c.tone];
                return (
                  <TouchableOpacity
                    key={c.label}
                    onPress={() => onPick(on ? null : c)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on, checked: on }}
                    accessibilityLabel={c.label}
                    style={[st.checkBtn, {
                      backgroundColor: tint(color, on ? 0.2 : 0.12),
                      borderColor: on ? color : tint(color, 0.33),
                      borderWidth: on ? 2 : 1,
                    }]}
                  >
                    <Text style={{ fontSize: 18 }}>{c.emoji}</Text>
                    <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13.5 }}>{c.label}</Text>
                    {on && <Ionicons name="checkmark-circle" size={16} color={color} style={{ position: 'absolute', top: 8, right: 8 }} />}
                  </TouchableOpacity>
                );
              })}
            </View>
            <TextInput value={note} onChangeText={onNote} placeholder="Add a note (optional)" placeholderTextColor={colors.textFaint}
              accessibilityLabel="Add a note (optional)" maxLength={200}
              style={[sheetSt.noteInput, { color: colors.text, borderColor: colors.glassStroke, backgroundColor: colors.glassSoft }]} />
            <TouchableOpacity
              onPress={() => picked && onSend(picked)}
              disabled={!picked}
              accessibilityRole="button"
              accessibilityState={{ disabled: !picked }}
              style={[st.sendCheckin, { backgroundColor: picked ? colors.primary : colors.border }]}
            >
              <Text style={{ color: picked ? colors.onPrimary : colors.textDim, fontWeight: '800', fontSize: 15 }}>
                {picked ? `Send “${picked.label}”` : 'Choose a status'}
              </Text>
            </TouchableOpacity>
            {/* Answers a guardian's check-in request and stops its ladder. Shown
                always: the request arrives as a notification, and the member
                should be able to answer it without hunting for context. */}
            <TouchableOpacity onPress={onImOk} accessibilityRole="button" accessibilityLabel="I'm OK, answer a check-in request"
              style={[st.okBtn, { borderColor: colors.success }]}>
              <Text style={{ fontSize: 16 }} accessible={false}>👍</Text>
              <Text style={{ color: colors.success, fontWeight: '800', fontSize: 14 }}>I&apos;m OK — answer a check-in request</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardSafe>
    </Modal>
  );
}

const st = StyleSheet.create({
  checkGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  // minHeight, not height: a fixed height clips the label at large font
  // scales. paddingHorizontal 24 reserves the selected-state checkmark corner.
  checkBtn: { flexBasis: '47%', flexGrow: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 54, paddingHorizontal: 24, borderRadius: 16, borderWidth: 1 },
  okBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 48, borderRadius: 16, borderWidth: 1.5, marginTop: 10 },
  sendCheckin: { marginTop: 10, minHeight: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
});
