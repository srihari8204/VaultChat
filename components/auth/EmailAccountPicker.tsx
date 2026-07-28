// components/auth/EmailAccountPicker.tsx — pick a Google account on the device,
// then keep the email as editable text ("use a different email" without re-opening
// the picker). Ownership is still proven later by the email OTP, so a typed-in
// address is safe — it just won't pass profile/init until the OTP is verified.

import { useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { type Palette } from '../../constants/theme';
import { useTheme } from '../../lib/theme';
import { pickGoogleAccount, type GoogleAccount } from '../../lib/onboarding';

export function EmailAccountPicker({
  email, onEmailChange, onAccountPicked,
}: {
  email: string;
  onEmailChange: (email: string) => void;
  onAccountPicked: (acct: GoogleAccount) => void;
}) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const choose = async () => {
    setBusy(true); setErr(null);
    try {
      const acct = await pickGoogleAccount();
      onAccountPicked(acct);
      onEmailChange(acct.email);
    } catch (e: any) {
      if (e?.message !== 'Cancelled') setErr(e?.message ?? 'Could not pick account');
    } finally { setBusy(false); }
  };

  return (
    <View>
      <TextInput
        style={s.input}
        value={email}
        onChangeText={(t) => { onEmailChange(t.trim()); setErr(null); }}
        placeholder="you@example.com"
        placeholderTextColor={colors.textFaint}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <TouchableOpacity style={s.pickBtn} onPress={choose} disabled={busy} activeOpacity={0.8}>
        {busy
          ? <ActivityIndicator size="small" color={colors.primary} />
          : <Text style={s.pickTxt}>{email ? '↺ Use a different account' : 'G  Choose a Google account'}</Text>}
      </TouchableOpacity>
      {err && <Text style={s.err}>{err}</Text>}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  input: { height: 52, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.card, paddingHorizontal: 14, color: c.text, fontSize: 16 },
  pickBtn: { marginTop: 8, alignSelf: 'flex-start', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: c.border },
  pickTxt: { color: c.primary, fontSize: 13, fontWeight: '700' },
  err: { color: c.danger, fontSize: 12, marginTop: 6 },
});
