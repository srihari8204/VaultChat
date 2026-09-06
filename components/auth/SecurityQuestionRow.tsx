// components/auth/SecurityQuestionRow.tsx — one of the 5 security-question rows:
// a dropdown of still-available questions + an answer field. The parent excludes
// codes already chosen in other rows so the same question can't be picked twice.

import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { type Palette } from '../../constants/theme';
import { useTheme } from '../../lib/theme';
import { SECURITY_QUESTION_POOL, questionLabel } from '../../constants/securityQuestionPool';

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
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [open, setOpen] = useState(false);

  const available = SECURITY_QUESTION_POOL.filter(q => q.code === selectedCode || !excludeCodes.includes(q.code));

  return (
    <View style={s.block}>
      <Text style={s.num}>Question {index + 1}</Text>
      <TouchableOpacity style={s.select} onPress={() => setOpen(true)} activeOpacity={0.8}>
        <Text style={[s.selectTxt, !selectedCode && { color: colors.textFaint }]} numberOfLines={2}>
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
          placeholderTextColor={colors.textFaint}
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

const makeStyles = (c: Palette) => StyleSheet.create({
  block: { marginBottom: 16 },
  num: { color: c.primary, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 6 },
  select: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.glassSoft, borderRadius: 12, borderWidth: 1, borderColor: c.glassStroke, paddingHorizontal: 14, paddingVertical: 12 },
  selectTxt: { flex: 1, color: c.text, fontSize: 14, lineHeight: 19 },
  chev: { color: c.textDim, fontSize: 12, marginLeft: 8 },
  answer: { marginTop: 8, backgroundColor: c.glassSoft, borderRadius: 12, borderWidth: 1, borderColor: c.glassStroke, paddingHorizontal: 14, paddingVertical: 12, color: c.text, fontSize: 15 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: c.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 16, maxHeight: '70%' },
  sheetTitle: { color: c.text, fontSize: 16, fontWeight: '800', marginBottom: 12 },
  qRow: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  qActive: { backgroundColor: c.glassSoft },
  qTxt: { color: c.text, fontSize: 14, lineHeight: 19 },
});
