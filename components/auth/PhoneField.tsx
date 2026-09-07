// components/auth/PhoneField.tsx — country code + national number → E.164.
// Pragmatic validation (E.164 = '+' then 8–15 digits) without pulling in
// libphonenumber-js; the small country list covers the common cases, default +91.

import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { type Palette } from '../../constants/theme';
import { useTheme } from '../../lib/theme';

const COUNTRIES = [
  { code: '+91', flag: '🇮🇳', name: 'India' },
  { code: '+1',  flag: '🇺🇸', name: 'USA / Canada' },
  { code: '+44', flag: '🇬🇧', name: 'UK' },
  { code: '+61', flag: '🇦🇺', name: 'Australia' },
  { code: '+971', flag: '🇦🇪', name: 'UAE' },
  { code: '+65', flag: '🇸🇬', name: 'Singapore' },
  { code: '+49', flag: '🇩🇪', name: 'Germany' },
  { code: '+33', flag: '🇫🇷', name: 'France' },
  { code: '+81', flag: '🇯🇵', name: 'Japan' },
  { code: '+880', flag: '🇧🇩', name: 'Bangladesh' },
  { code: '+92', flag: '🇵🇰', name: 'Pakistan' },
  { code: '+94', flag: '🇱🇰', name: 'Sri Lanka' },
];

// Returns the full E.164 string, or '' if invalid.
export function toE164(dialCode: string, national: string): string {
  const n = national.replace(/\D/g, '');
  const e164 = `${dialCode}${n}`;
  return /^\+\d{8,15}$/.test(e164) ? e164 : '';
}

export function PhoneField({
  dialCode, national, onChange, autoFocus,
}: {
  dialCode: string;
  national: string;
  onChange: (dialCode: string, national: string) => void;
  autoFocus?: boolean;
}) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [pick, setPick] = useState(false);
  const country = COUNTRIES.find(c => c.code === dialCode) ?? COUNTRIES[0];

  return (
    <View style={s.row}>
      <TouchableOpacity style={s.code} onPress={() => setPick(true)} activeOpacity={0.7}>
        <Text style={s.flag}>{country.flag}</Text>
        <Text style={s.codeTxt}>{country.code}</Text>
        <Text style={s.chev}>▾</Text>
      </TouchableOpacity>
      <TextInput
        style={s.input}
        value={national}
        onChangeText={(t) => onChange(dialCode, t.replace(/\D/g, '').slice(0, 14))}
        placeholder="Mobile number"
        placeholderTextColor={colors.textFaint}
        keyboardType="phone-pad"
        autoFocus={autoFocus}
        maxLength={14}
      />

      <Modal visible={pick} transparent animationType="fade" onRequestClose={() => setPick(false)}>
        <Pressable style={s.backdrop} onPress={() => setPick(false)}>
          <View style={s.sheet}>
            <Text style={s.sheetTitle}>Select country</Text>
            <ScrollView>
              {COUNTRIES.map(c => (
                <TouchableOpacity
                  key={c.code}
                  style={[s.countryRow, c.code === dialCode && s.countryActive]}
                  onPress={() => { onChange(c.code, national); setPick(false); }}
                >
                  <Text style={s.flag}>{c.flag}</Text>
                  <Text numberOfLines={1} style={s.countryName}>{c.name}</Text>
                  <Text style={s.codeTxt}>{c.code}</Text>
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
  row: { flexDirection: 'row', gap: 10 },
  code: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, height: 52, borderRadius: 12, borderWidth: 1, borderColor: c.glassStroke, backgroundColor: c.glassSoft },
  flag: { fontSize: 18 },
  codeTxt: { color: c.text, fontSize: 16, fontWeight: '700' },
  chev: { color: c.textDim, fontSize: 12 },
  input: { flex: 1, minHeight: 52, borderRadius: 12, borderWidth: 1, borderColor: c.glassStroke, backgroundColor: c.glassSoft, paddingHorizontal: 14, color: c.text, fontSize: 16 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: c.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 16, maxHeight: '70%' },
  sheetTitle: { color: c.text, fontSize: 16, fontWeight: '800', marginBottom: 12 },
  countryRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  countryActive: { backgroundColor: c.glassSoft },
  countryName: { color: c.text, fontSize: 15, flex: 1 },
});
