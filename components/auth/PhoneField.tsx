// components/auth/PhoneField.tsx — country code + national number → E.164.
// Pragmatic validation without pulling in libphonenumber-js: the generic E.164
// shape ('+' then 8–15 digits) PLUS the national-number length for the country
// that was picked. The small country list covers the common cases, default +91.
//
// THE GENERIC RULE ALONE IS TOO LOOSE FOR AN IDENTITY FIELD. '+91 12345678'
// passed it — eight digits, so E.164-shaped, and no Indian number is eight
// digits long. That was tolerable while the number was a secondary field and
// the email carried the OTP; now the number IS the login, and a number that
// cannot receive an SMS is an account nobody can ever sign into. The lengths
// below are the national-number lengths, not counting the dial code; a country
// missing from the table falls back to the generic rule rather than blocking.
//
// onDark preserves the auth night styling; light appearance uses app colors.

import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { AUTH_FIELDS, type FieldColors } from '../../constants/authTheme';
import { useTheme } from '../../lib/theme';

// `len` = [min, max] digits in the NATIONAL number (dial code excluded).
const COUNTRIES = [
  { code: '+91', flag: '🇮🇳', name: 'India',        len: [10, 10] },
  { code: '+1',  flag: '🇺🇸', name: 'USA / Canada', len: [10, 10] },
  { code: '+44', flag: '🇬🇧', name: 'UK',           len: [10, 10] },
  { code: '+61', flag: '🇦🇺', name: 'Australia',    len: [9, 9] },
  { code: '+971', flag: '🇦🇪', name: 'UAE',         len: [9, 9] },
  { code: '+65', flag: '🇸🇬', name: 'Singapore',    len: [8, 8] },
  { code: '+49', flag: '🇩🇪', name: 'Germany',      len: [10, 11] },
  { code: '+33', flag: '🇫🇷', name: 'France',       len: [9, 9] },
  { code: '+81', flag: '🇯🇵', name: 'Japan',        len: [10, 10] },
  { code: '+880', flag: '🇧🇩', name: 'Bangladesh',  len: [10, 10] },
  { code: '+92', flag: '🇵🇰', name: 'Pakistan',     len: [10, 10] },
  { code: '+94', flag: '🇱🇰', name: 'Sri Lanka',    len: [9, 9] },
] as const;

const MAX_NATIONAL = 14;   // generic ceiling for a country not in the table

// Returns the full E.164 string, or '' if invalid.
export function toE164(dialCode: string, national: string): string {
  const n = national.replace(/\D/g, '');
  const e164 = `${dialCode}${n}`;
  if (!/^\+\d{8,15}$/.test(e164)) return '';
  const c = COUNTRIES.find(x => x.code === dialCode);
  if (c && (n.length < c.len[0] || n.length > c.len[1])) return '';
  return e164;
}

export function PhoneField({
  dialCode, national, onChange, autoFocus, onDark = false,
}: {
  dialCode: string;
  national: string;
  onChange: (dialCode: string, national: string) => void;
  autoFocus?: boolean;
  onDark?: boolean;
}) {
  const { colors, scheme } = useTheme();
  const c = onDark && scheme === 'dark' ? AUTH_FIELDS : colors;
  const s = useMemo(() => makeStyles(c), [c]);
  const [pick, setPick] = useState(false);
  const country = COUNTRIES.find(x => x.code === dialCode) ?? COUNTRIES[0];
  // Stop the typing at the country's own ceiling rather than a flat 14: on a
  // 10-digit country the 11th keypress is always a mistake, and refusing it is
  // quieter than accepting it and greying out the button with no reason given.
  const maxDigits = country.code === dialCode ? country.len[1] : MAX_NATIONAL;

  return (
    <View style={s.row}>
      <TouchableOpacity
        style={s.code}
        onPress={() => setPick(true)}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`Country code, ${country.name} ${country.code}`}
      >
        <Text style={s.flag}>{country.flag}</Text>
        <Text style={s.codeTxt}>{country.code}</Text>
        <Text style={s.chev}>▾</Text>
      </TouchableOpacity>
      <TextInput
        style={s.input}
        value={national}
        onChangeText={(t) => onChange(dialCode, t.replace(/\D/g, '').slice(0, maxDigits))}
        placeholder="Mobile number"
        placeholderTextColor={c.textFaint}
        keyboardType="phone-pad"
        autoFocus={autoFocus}
        maxLength={maxDigits}
      />

      <Modal visible={pick} transparent animationType="fade" onRequestClose={() => setPick(false)}>
        <Pressable style={s.backdrop} onPress={() => setPick(false)}>
          <View style={s.sheet}>
            <Text style={s.sheetTitle}>Select country</Text>
            <ScrollView>
              {COUNTRIES.map(item => (
                <TouchableOpacity
                  key={item.code}
                  style={[s.countryRow, item.code === dialCode && s.countryActive]}
                  // Trim to the new country's ceiling — 10 Indian digits are not
                  // a Singapore number, and carrying them over silently is how
                  // the CTA ends up dead with nothing on screen explaining it.
                  onPress={() => { onChange(item.code, national.slice(0, item.len[1])); setPick(false); }}
                >
                  <Text style={s.flag}>{item.flag}</Text>
                  <Text numberOfLines={1} style={s.countryName}>{item.name}</Text>
                  <Text style={s.codeTxt}>{item.code}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const makeStyles = (c: FieldColors) => StyleSheet.create({
  row: { flexDirection: 'row', gap: 10 },
  // 2026-09-17: minHeight, not height — this sits on the signup path, and at font
  // scale 1.5 a pinned 52 clipped the dial code the user is typing to make an
  // account. 52 is also the tap floor, and the padding keeps it visually
  // identical at scale 1.0 while letting it grow. Matches `input` below.
  code: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, minHeight: 52, paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: c.glassStroke, backgroundColor: c.glassSoft },
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
