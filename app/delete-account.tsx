// app/delete-account.tsx — permanently delete this account.
//
// Play requires any app with accounts to offer in-app deletion, and this is
// that screen. It replaces the pair of Alert dialogs Settings used to show,
// because a destructive-styled button in a native alert is one mis-tap from
// erasing everything and gives no chance to say what is actually lost.
//
// Modelled on WhatsApp's delete-account screen, and for the same reasons:
//   • the consequences are listed BEFORE the input, not inside a dialog;
//   • you type your own number back to arm the button — a deliberate act that
//     a mis-tap cannot produce, and the one gesture people already know;
//   • "why are you leaving" is optional feedback, never a gate.
//
// The final native confirm is still there. Two deliberate acts, no more.
//
// RE-AUTHENTICATION (2026-10-04). Typing the number back is a confirmation,
// not proof of who is holding the phone (lib/confirmIdentity.ts says so), and
// the number is on the profile for anyone with the unlocked phone to read. The
// account MPIN is sent IN the DELETE /user/account body and the server checks
// it there (400 mpin_required, 403 invalid_mpin, 423 locked + retryAfter).
// The deployed server does not check it yet, so the MPIN is ALSO verified
// first with verifyMpinRemote (which keeps this account's cached profile).

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, ScrollView,
  StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { HEADER_TOP } from '../constants/layout';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { api, getCachedUser } from '../lib/api';
import { onboardingError, retryAfterSec, verifyMpinRemote } from '../lib/onboarding';
import { deleteAccount } from '../lib/chatService';
import { profileFromProtobuf } from '../lib/userProfilePolicy';
import { identityMatches, type AccountIdentity } from '../lib/confirmIdentity';
import { unregisterPushToken } from '../lib/push';
import { disconnect as disconnectSocket } from '../lib/socket';
import { resetTo } from '../lib/authNav';
import { logoutUser } from './(constants)/authService';
import { AuroraBackground, KeyboardSafe } from '../components/ui';

// What actually happens, in the order a person cares about. Every line here is
// backed by DELETE /user/account — do not add a promise the server does not keep.
const CONSEQUENCES = [
  'Delete your account and free up your number',
  'Erase your profile, PIN and recovery answers',
  'Remove you from all of your groups',
  'Delete your encryption keys and server backup',
  'Erase chats and media on this phone',
];

const REASONS = [
  'I don’t use crazzychat',
  'I’m missing a feature',
  'I have privacy concerns',
  'Too many notifications',
  'I’m changing my number',
  'Other',
];

export default function DeleteAccountScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const S = useS();

  const [me, setMe] = useState<AccountIdentity | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [mpin, setMpin] = useState('');
  const [authErr, setAuthErr] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadErr(false);
    try {
      const u: any = await api('/user/profile', { proto: profileFromProtobuf });
      const id: AccountIdentity = {
        phone: u?.phone || undefined, email: u?.email || undefined, vaultId: u?.vaultId || undefined,
      };
      // Nothing to confirm against is a FAILED LOAD, not an account that cannot
      // be deleted. Rendering the form anyway leaves a button that can never
      // arm; the retry at least has a way forward.
      if (!id.phone && !id.email && !id.vaultId) { setLoadErr(true); return; }
      const uid = u?.id || u?.userId || (await getCachedUser().catch(() => null))?.id || null;
      // No user id means the MPIN cannot be pre-checked — a failed load, not a
      // form that skips re-authentication.
      if (!uid) { setLoadErr(true); return; }
      setUserId(String(uid));
      setMe(id);
    } catch {
      setLoadErr(true);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Whatever identifies the account to its owner, in the order confirmIdentity
  // checks it: phone (the account, since sign-in is mobile-only), then email for
  // accounts that predate that, then the @handle.
  const mode: 'phone' | 'email' | 'vaultId' = me?.phone ? 'phone' : me?.email ? 'email' : 'vaultId';
  const byPhone = mode === 'phone';

  const identityOk = useMemo(() => identityMatches(me, typed), [me, typed]);
  const armed = identityOk && /^\d{6}$/.test(mpin);

  const run = useCallback(async () => {
    if (!userId) return;
    setBusy(true);
    setAuthErr(null);
    // ponytail: client-side MPIN pre-check because the deployed DELETE
    // /user/account ignores `mpin` (the checking route in vaultchat-backend-go
    // is written, not deployed). Once that server is live this spends one extra
    // attempt of the shared /auth/mpin/verify budget per delete; drop this
    // block then and rely on the server's 400/403/423 below.
    try {
      await verifyMpinRemote(userId, mpin);
    } catch (e: unknown) {
      setBusy(false);
      setMpin('');
      setAuthErr(`${onboardingError(e, 'Incorrect MPIN.')} Your account was not deleted.`);
      return;
    }
    try {
      await deleteAccount(mpin, reason ?? undefined);
      // Order matters: the account is gone, so these are best-effort cleanups
      // of this device. A failure here must not strand the user on a screen for
      // an account that no longer exists.
      try { await unregisterPushToken(); } catch {}
      try { disconnectSocket(); } catch {}
      await logoutUser();          // wipes local chats, media and backups
      // resetTo, not replace: Settings (and everything else the user walked
      // through to get here) must not survive the deletion — replace swaps only
      // the top entry, so BACK led straight back into an account that is gone.
      resetTo('/onboard');
    } catch (e: unknown) {
      setBusy(false);
      // The MPIN answers belong next to the MPIN field; anything else is a
      // failed request, said in words rather than a raw error. Keyed on the
      // server's error code only: a bare 403/400 from anything else on the way
      // (a proxy, an expired session) is not "wrong MPIN".
      const code = (e as { body?: { error?: { code?: unknown } } } | null)?.body?.error?.code;
      if (code === 'invalid_mpin') {
        setMpin('');
        setAuthErr('Incorrect MPIN. Your account was not deleted.');
        return;
      }
      if (code === 'locked') {
        setMpin('');
        const mins = Math.max(1, Math.ceil(retryAfterSec(e) / 60));
        setAuthErr(`Too many MPIN attempts. Try again in about ${mins} minute${mins === 1 ? '' : 's'}. Your account was not deleted.`);
        return;
      }
      if (code === 'mpin_required') {
        setAuthErr('Enter your 6-digit MPIN to delete this account.');
        return;
      }
      Alert.alert('Delete failed', onboardingError(e, 'Check your connection and try again.'));
    }
  }, [reason, mpin, userId]);

  const confirm = useCallback(() => {
    if (!armed || busy) return;
    Alert.alert(
      'Delete account?',
      'This cannot be undone. Your account is erased now, and every device signed into it is signed out for good.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: run },
      ],
    );
  }, [armed, busy, run]);

  return (
    <KeyboardSafe style={S.screen} >
      <AuroraBackground />
      <View style={S.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={S.backBtn} activeOpacity={0.7} hitSlop={6}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.title} accessibilityRole="header">Delete account</Text>
      </View>

      <ScrollView contentContainerStyle={S.body} keyboardShouldPersistTaps="handled">
        <View style={S.warnCard}>
          <View style={S.warnHead}>
            <Ionicons name="warning" size={20} color={colors.danger} />
            <Text style={S.warnTitle}>Deleting your account will:</Text>
          </View>
          {CONSEQUENCES.map(line => (
            <View key={line} style={S.bullet}>
              <Text style={S.dot}>•</Text>
              <Text style={S.bulletTxt}>{line}</Text>
            </View>
          ))}
        </View>

        {/* Said plainly because people assume deletion recalls what they sent.
            It does not, and finding that out afterwards is worse. */}
        <Text style={S.note}>
          Messages you already sent stay on the phones of the people you sent them to — those
          copies are theirs. Nobody will be able to reach you here again.
        </Text>

        {loadErr ? (
          <TouchableOpacity style={S.retry} onPress={load} activeOpacity={0.8} accessibilityRole="button">
            <Ionicons name="refresh" size={18} color={colors.primary} />
            <Text style={S.retryTxt}>Couldn’t load your account. Tap to retry.</Text>
          </TouchableOpacity>
        ) : !me ? (
          <ActivityIndicator style={{ marginTop: 28 }} color={colors.primary} />
        ) : (
          <>
            <Text style={S.sectionLabel}>
              {mode === 'phone' ? 'CONFIRM YOUR PHONE NUMBER'
                : mode === 'email' ? 'CONFIRM YOUR EMAIL' : 'CONFIRM YOUR VAULTID'}
            </Text>
            <TextInput
              style={S.input}
              value={typed}
              onChangeText={setTyped}
              placeholder={mode === 'phone' ? 'Your number' : mode === 'email' ? 'you@example.com' : '@yourvaultid'}
              placeholderTextColor={colors.textFaint}
              keyboardType={byPhone ? 'phone-pad' : 'email-address'}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
              accessibilityLabel={mode === 'phone' ? 'Your phone number' : mode === 'email' ? 'Your email' : 'Your VaultID'}
            />
            <Text style={S.hint}>
              {mode === 'phone'
                ? 'Type the number on this account to turn on the button below.'
                : mode === 'email'
                  ? 'Type the email on this account to turn on the button below.'
                  : 'Type your VaultID — it is on your Profile — to turn on the button below.'}
            </Text>

            {identityOk && (
              <>
                <Text style={S.sectionLabel} accessibilityRole="header">ENTER YOUR MPIN</Text>
                <TextInput
                  style={S.input}
                  value={mpin}
                  onChangeText={(t) => { setMpin(t.replace(/\D/g, '').slice(0, 6)); setAuthErr(null); }}
                  placeholder="6-digit MPIN"
                  placeholderTextColor={colors.textFaint}
                  keyboardType="number-pad"
                  secureTextEntry
                  maxLength={6}
                  editable={!busy}
                  accessibilityLabel="Your 6-digit MPIN"
                />
                <Text style={S.hint}>The MPIN you sign in with. It proves this is you before anything is erased.</Text>
                {!!authErr && <Text style={S.err} accessibilityLiveRegion="polite">{authErr}</Text>}
              </>
            )}

            <Text style={S.sectionLabel} accessibilityRole="header">WHY ARE YOU LEAVING? (OPTIONAL)</Text>
            <View style={S.chips}>
              {REASONS.map(r => (
                <TouchableOpacity
                  key={r}
                  style={[S.chip, reason === r && S.chipOn]}
                  onPress={() => setReason(reason === r ? null : r)}
                  activeOpacity={0.8}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: reason === r }}>
                  <Text style={[S.chipTxt, reason === r && S.chipTxtOn]}>{r}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <TouchableOpacity
              style={[S.cta, (!armed || busy) && S.ctaOff]}
              onPress={confirm}
              disabled={!armed || busy}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityState={{ disabled: !armed || busy, busy }}>
              {busy ? <ActivityIndicator color={colors.onDanger} />
                    : <Text style={S.ctaTxt}>Delete my account</Text>}
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </KeyboardSafe>
  );
}

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: HEADER_TOP + 40, paddingBottom: 12, gap: 8 },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { color: c.text, fontSize: 20, fontWeight: '800' },

  body: { paddingHorizontal: 18, paddingBottom: 48 },

  warnCard: { marginTop: 6, padding: 16, borderRadius: 16, backgroundColor: c.glassSoft, borderWidth: 1, borderColor: c.danger },
  warnHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  warnTitle: { color: c.danger, fontSize: 15, fontWeight: '800', flexShrink: 1 },
  bullet: { flexDirection: 'row', gap: 8, paddingVertical: 3 },
  dot: { color: c.danger, fontSize: 14, lineHeight: 20 },
  bulletTxt: { color: c.text, fontSize: 14, lineHeight: 20, flex: 1 },

  note: { color: c.textDim, fontSize: 13, lineHeight: 19, marginTop: 14 },

  sectionLabel: { color: c.textDim, fontSize: 12, fontWeight: '700', letterSpacing: 1, paddingTop: 24, paddingBottom: 8 },
  input: { minHeight: 52, borderRadius: 14, paddingHorizontal: 16, backgroundColor: c.glassSoft, color: c.text, fontSize: 17, fontWeight: '700' },
  hint: { color: c.textFaint, fontSize: 12, marginTop: 8, lineHeight: 17 },
  err: { color: c.danger, fontSize: 13, marginTop: 8, fontWeight: '600' },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 20, backgroundColor: c.glassSoft, borderWidth: 1, borderColor: 'transparent' },
  chipOn: { borderColor: c.primary },
  chipTxt: { color: c.textDim, fontSize: 13, fontWeight: '600' },
  chipTxtOn: { color: c.text },

  cta: { marginTop: 26, minHeight: 50, borderRadius: 14, backgroundColor: c.danger, alignItems: 'center', justifyContent: 'center', paddingVertical: 12 },
  ctaOff: { opacity: 0.4 },
  ctaTxt: { color: c.onDanger, fontSize: 16, fontWeight: '800' },

  retry: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 28 },
  retryTxt: { color: c.primary, fontSize: 13.5, fontWeight: '700' },
});
