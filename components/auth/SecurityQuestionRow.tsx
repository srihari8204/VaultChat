// components/auth/SecurityQuestionRow.tsx — one of the 5 security-question rows:
// a dropdown of still-available questions + an answer field. The parent excludes
// codes already chosen in other rows so the same question can't be picked twice.
//
// Follows the same selected appearance as its parent auth screen.

import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SECURITY_QUESTION_POOL, questionLabel } from '../../constants/securityQuestionPool';
import { type AuthPalette } from '../../constants/authTheme';
import { useAuthTheme } from '../../lib/useAuthTheme';

export function SecurityQuestionRow({
  index, selectedCode, answer, excludeCodes, onSelect, onAnswer,
}: {
  index: number;
  selectedCode: string | null;
  answer: string;
  excludeCodes: string[];           // codes chosen by OTHER rows
  onSelect: (code: string) => void;
  onAnswer: (text: string) => void;
}) {
  const AUTH = useAuthTheme();
  const s = useMemo(() => makeStyles(AUTH), [AUTH]);
  const [open, setOpen] = useState(false);

  const available = SECURITY_QUESTION_POOL.filter(q => q.code === selectedCode || !excludeCodes.includes(q.code));

  return (
    <View style={s.block}>
      <Text style={s.num}>Question {index + 1}</Text>
      <TouchableOpacity
        style={s.select}
        onPress={() => setOpen(true)}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel={`Security question ${index + 1}: ${selectedCode ? questionLabel(selectedCode) : 'choose a question'}`}
      >
        <Text style={[s.selectTxt, !selectedCode && s.selectEmpty]} numberOfLines={2}>
          {selectedCode ? questionLabel(selectedCode) : 'Choose a question'}
        </Text>
        <Text style={s.chev}>▾</Text>
      </TouchableOpacity>

      {selectedCode && (
        <TextInput
          style={s.answer}
          value={answer}
          onChangeText={onAnswer}
          placeholder="Your answer"
          placeholderTextColor={AUTH.faint}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
      )}

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={s.backdrop} onPress={() => setOpen(false)}>
          <View style={s.sheet}>
            <Text style={s.sheetTitle}>Security question {index + 1}</Text>
            <ScrollView>
              {available.map(q => (
                <TouchableOpacity
                  key={q.code}
                  style={[s.qRow, q.code === selectedCode && s.qActive]}
                  onPress={() => { onSelect(q.code); setOpen(false); }}
                >
                  <Text style={s.qTxt}>{q.label}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const makeStyles = (AUTH: AuthPalette) => StyleSheet.create({
  block: { marginBottom: 16 },
  num: { color: AUTH.dim, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 6 },
  // These sit INSIDE the screen's glass card, so the fill is the fainter
  // hairline tint — card-on-card at the same alpha reads as a rendering bug.
  select: { flexDirection: 'row', alignItems: 'center', backgroundColor: AUTH.hairline, borderRadius: 12, borderWidth: 1, borderColor: AUTH.stroke, paddingHorizontal: 14, paddingVertical: 12 },
  selectTxt: { flex: 1, color: AUTH.text, fontSize: 14, lineHeight: 19 },
  selectEmpty: { color: AUTH.faint },
  chev: { color: AUTH.dim, fontSize: 12, marginLeft: 8 },
  answer: { marginTop: 8, backgroundColor: AUTH.hairline, borderRadius: 12, borderWidth: 1, borderColor: AUTH.stroke, paddingHorizontal: 14, paddingVertical: 12, color: AUTH.text, fontSize: 15 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: AUTH.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 16, maxHeight: '70%' },
  sheetTitle: { color: AUTH.text, fontSize: 16, fontWeight: '800', marginBottom: 12 },
  qRow: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: AUTH.stroke },
  qActive: { backgroundColor: AUTH.card },
  qTxt: { color: AUTH.text, fontSize: 14, lineHeight: 19 },
});
