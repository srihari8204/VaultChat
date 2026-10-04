// components/auth/SecurityQuestionRow.tsx — one of the 5 security-question rows:
// a dropdown of still-available questions + an answer field. The parent excludes
// codes already chosen in other rows so the same question can't be picked twice.
//
// Follows the same selected appearance as its parent auth screen. The picker is
// the shared components/ui/Sheet (roles, selected mark, insets, modal scrim).

import { useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Sheet } from '../ui/Sheet';
import { SECURITY_QUESTION_POOL, questionLabel } from '../../constants/securityQuestionPool';
import { type AuthPalette } from '../../constants/authTheme';
import { useAuthTheme } from '../../lib/useAuthTheme';

/** Shortest answer accepted (app/onboard-security.tsx checks the same). */
export const MIN_ANSWER = 2;

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
          accessibilityLabel={`Answer to: ${questionLabel(selectedCode)}`}
          accessibilityHint={`At least ${MIN_ANSWER} characters`}
        />
      )}
      {/* Why Next is still off: an answer that is started but too short. */}
      {selectedCode && answer.length > 0 && answer.trim().length < MIN_ANSWER && (
        <Text style={s.hint} accessibilityLiveRegion="polite">Use at least {MIN_ANSWER} characters.</Text>
      )}

      <Sheet
        visible={open}
        title={`Security question ${index + 1}`}
        onClose={() => setOpen(false)}
        actions={available.map(q => ({
          label: q.label,
          selected: q.code === selectedCode,
          onPress: () => onSelect(q.code),
        }))}
      />
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
  hint: { color: AUTH.danger, fontSize: 12, marginTop: 6 },
});
