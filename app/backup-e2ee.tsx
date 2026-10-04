// app/backup-e2ee.tsx — End-to-end encrypted backup (WhatsApp's opt-in upgrade).
//
// The default backup key is account-managed, so the server can read the blob.
// This screen swaps it for a key derived from something only the user has: a
// password they choose, or a generated 64-character recovery key. While it is on,
// the password can be changed or swapped for a key (and back) — lib/cloudBackup's
// enableE2EEBackup keeps the old secret until the upload under the new one lands.
//
// The copy here does not soften the trade. There is no escrow behind this (see
// lib/backupCrypto), so a forgotten password means the backup is gone — and a
// user who is not told that plainly, before they turn it on, will find out at
// the worst possible moment. Every confirmation below states it.

import { HEADER_TOP } from '../constants/layout';
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert, ActivityIndicator,
  TextInput, Platform, BackHandler,
} from 'react-native';
import { copyAndAutoClear } from '../lib/clipboardSafe';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';
import { getBackupMode, enableE2EEBackup, disableE2EEBackup } from '../lib/cloudBackup';
import { formatRecoveryKey, passwordProblem } from '../lib/backupCrypto';
import { AuroraBackground, KeyboardSafe } from '../components/ui';
import { KEY_GROUP_LEN, keyGroupMatches, pickCheckGroups } from '../lib/recoveryKeyCheck';

type Stage = 'loading' | 'error' | 'off' | 'on' | 'password' | 'keyshown';

export default function BackupE2EEScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);

  const [stage, setStage] = useState<Stage>('loading');
  const [mode, setMode] = useState<'account' | 'password' | 'key'>('account');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [busy, setBusy] = useState(false);
  // Before leaving the show-once key: two of its groups, typed back.
  const [checkGroups, setCheckGroups] = useState<number[] | null>(null);
  const [checkTyped, setCheckTyped] = useState<string[]>([]);
  const startKeyCheck = () => {
    setCheckGroups(pickCheckGroups(Math.ceil(recoveryKey.length / KEY_GROUP_LEN)));
    setCheckTyped(['', '']);
  };
  const submitKeyCheck = () => {
    if (!checkGroups) return;
    if (checkGroups.every((g, i) => keyGroupMatches(recoveryKey, g, checkTyped[i] ?? ''))) {
      setCheckGroups(null); setRecoveryKey(''); setStage('on');
      return;
    }
    Alert.alert("That doesn't match", 'Check the key you saved, or go back and look at it again.');
  };

  // A failed read is NOT "off": a user whose backup is already end-to-end
  // encrypted would be told it is not, and invited to set it up again.
  const loadMode = useCallback(() => {
    setStage('loading');
    getBackupMode().then(m => { setMode(m); setStage(m === 'account' ? 'off' : 'on'); })
      .catch(() => setStage('error'));
  }, []);
  useEffect(() => { loadMode(); }, [loadMode]);

  // Leaving the show-once key screen loses the key for good, so every exit —
  // header back, Android back, the iOS swipe (disabled below) — asks first.
  const confirmLeaveKey = useCallback((leave: () => void) => Alert.alert(
    'Saved it?',
    'Once you leave this screen the key cannot be shown again.',
    [
      { text: 'Go back', style: 'cancel' },
      { text: "I've saved it", onPress: leave },
    ],
  ), []);
  useEffect(() => {
    if (stage !== 'keyshown') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      confirmLeaveKey(() => router.back());
      return true;
    });
    return () => sub.remove();
  }, [stage, confirmLeaveKey, router]);

  // While on, every enable is a switch: a failure leaves the old secret in place.
  const switching = mode !== 'account';
  const fail = (e: any) => Alert.alert(
    switching ? 'Nothing was changed' : 'Could not turn this on',
    switching
      ? `Your backup is still protected by ${mode === 'key' ? 'your current key' : 'your current password'}. ${e?.message ?? 'Please try again.'}`
      : e?.message ?? 'Please try again.',
  );
  // Blobs written before a switch (local backup files, Drive) still open only
  // with the old secret — restore picks the secret by the blob's own header.
  const oldCopiesNote = switching
    ? `\n\nOlder backup files on this phone or in Google Drive still need ${mode === 'key' ? 'your old key' : 'your old password'}.`
    : '';

  // Turning it on re-uploads immediately, so this is a network operation and can
  // legitimately take a while on a large history — the button stays disabled
  // rather than letting a second tap start a competing upload.
  const enablePassword = async () => {
    const problem = passwordProblem(pw);
    if (problem) { Alert.alert('Choose a stronger password', problem); return; }
    if (pw !== pw2) { Alert.alert('Passwords do not match', 'Please re-enter them.'); return; }
    Alert.alert(
      switching ? 'Use this new password?' : 'Turn on encrypted backup?',
      'Your backup will be re-uploaded, encrypted with this password.\n\nWe will not have a copy of it. If you forget this password, your backup cannot be recovered by anyone — including us.' + oldCopiesNote,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: switching ? 'Use password' : 'Turn on', style: 'destructive', onPress: async () => {
            setBusy(true);
            try {
              await enableE2EEBackup('password', pw);
              setMode('password'); setStage('on'); setPw(''); setPw2('');
              Alert.alert(switching ? 'Password changed' : 'Encrypted backup is on', 'Your backups are now readable only with this password.');
            } catch (e) { fail(e); } finally { setBusy(false); }
          } },
      ],
    );
  };

  const enableKey = async () => {
    Alert.alert(
      mode === 'key' ? 'Make a new key?' : 'Use a 64-character key?',
      'We will generate a key and show it to you once. Save it somewhere safe.\n\nWe will not have a copy of it. If you lose it, your backup cannot be recovered by anyone — including us.' + oldCopiesNote,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Generate', style: 'destructive', onPress: async () => {
            setBusy(true);
            try {
              const { recoveryKey: k } = await enableE2EEBackup('key');
              setRecoveryKey(k ?? ''); setMode('key'); setCheckGroups(null); setStage('keyshown');
            } catch (e) { fail(e); } finally { setBusy(false); }
          } },
      ],
    );
  };

  const turnOff = () => Alert.alert(
    'Turn off encrypted backup?',
    'Your backup will be re-uploaded using a key held by your account, so it can be restored without a password — and we will be able to read it.',
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Turn off', style: 'destructive', onPress: async () => {
          setBusy(true);
          try {
            await disableE2EEBackup();
            setMode('account'); setStage('off');
          } catch (e: any) {
            // disableE2EEBackup restores the secret on failure; show what the
            // device will actually do next, not what we hoped.
            const now = await getBackupMode().catch(() => null);
            if (now === 'account') {
              setMode('account'); setStage('off');
              Alert.alert('Encrypted backup is off', 'This device now backs up with your account key, but the backup could not be re-uploaded yet. It will be on the next backup.');
            } else {
              Alert.alert('Could not turn this off', `Encrypted backup is still on. ${e?.message ?? 'Please try again.'}`);
            }
          } finally { setBusy(false); }
        } },
    ],
  );

  const header = (
    <>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false, gestureEnabled: stage !== 'keyshown' }} />
      <View style={s.header}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => (stage === 'keyshown' ? confirmLeaveKey(() => router.back()) : router.back())}
          style={s.iconBtn}
          hitSlop={8}
        >
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle} accessibilityRole="header">End-to-end encrypted backup</Text>
      </View>
    </>
  );

  if (stage === 'loading') {
    return <View style={s.root}>
      {header}
      <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} accessibilityLabel="Loading backup settings" />
    </View>;
  }

  if (stage === 'error') {
    return (
      <View style={s.root}>
        {header}
        <View style={{ padding: 20 }}>
          <Text style={s.body} accessibilityRole="alert">Your backup settings could not be loaded. Check your connection and try again.</Text>
          <TouchableOpacity style={s.primaryBtn} onPress={loadMode} accessibilityRole="button" accessibilityLabel="Try again">
            <Text style={s.primaryTxt}>TRY AGAIN</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // The key is shown ONCE. There is no "show it again" anywhere, because we do
  // not keep it — only the derived secret is stored, and it is one-way.
  if (stage === 'keyshown' && checkGroups) {
    return (
      <KeyboardSafe style={s.root}>
        {header}
        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          <Text style={s.h1} accessibilityRole="header">Check your saved key</Text>
          <Text style={s.body}>
            Type these groups from the key you saved. Each group is {KEY_GROUP_LEN} characters.
          </Text>
          {checkGroups.map((g, i) => (
            <TextInput
              key={g}
              style={[s.input, s.keyInput]}
              value={checkTyped[i] ?? ''}
              onChangeText={(t) => setCheckTyped(prev => prev.map((v, j) => (j === i ? t.replace(/[^0-9a-fA-F]/g, '').slice(0, KEY_GROUP_LEN) : v)))}
              placeholder={`Group ${g + 1}`}
              placeholderTextColor={colors.textFaint}
              accessibilityLabel={`Group ${g + 1} of your key`}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={KEY_GROUP_LEN}
              autoFocus={i === 0}
            />
          ))}
          <TouchableOpacity
            style={[s.primaryBtn, checkTyped.some(t => t.length < KEY_GROUP_LEN) && s.btnOff]}
            disabled={checkTyped.some(t => t.length < KEY_GROUP_LEN)}
            accessibilityRole="button"
            accessibilityState={{ disabled: checkTyped.some(t => t.length < KEY_GROUP_LEN) }}
            onPress={submitKeyCheck}>
            <Text style={s.primaryTxt}>CHECK</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.linkRow} accessibilityRole="button" onPress={() => setCheckGroups(null)}>
            <Text style={s.link}>Show the key again</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardSafe>
    );
  }

  if (stage === 'keyshown') {
    return (
      <View style={s.root}>
        {header}
        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
          <Text style={s.h1} accessibilityRole="header">Save your 64-character key</Text>
          <Text style={s.body}>
            This is the only time it will be shown. Write it down or save it in a password manager —
            you will need it to restore your chats on a new phone.
          </Text>
          <View style={s.keyBox}><Text style={s.keyTxt}>{formatRecoveryKey(recoveryKey)}</Text></View>
          <TouchableOpacity
            style={s.secondaryBtn}
            accessibilityRole="button"
            accessibilityLabel="Copy key"
            onPress={async () => {
              try {
                await copyAndAutoClear(recoveryKey);
                Alert.alert('Copied', 'Paste it somewhere safe now — the clipboard is cleared in 30 seconds.');
              } catch (e: any) {
                Alert.alert('Could not copy', e?.message ?? 'Write the key down instead.');
              }
            }}>
            <Ionicons name="copy-outline" size={18} color={colors.primary} />
            <Text style={s.secondaryTxt}>Copy key</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={s.primaryBtn}
            accessibilityRole="button"
            onPress={startKeyCheck}>
            <Text style={s.primaryTxt}>{"I'VE SAVED IT"}</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    );
  }

  if (stage === 'password') {
    return (
      // KeyboardSafe: TURN ON sits below two inputs and would be under the keyboard.
      <KeyboardSafe style={s.root}>
        {header}
        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          <Text style={s.h1} accessibilityRole="header">{switching ? 'New backup password' : 'Create a password'}</Text>
          <Text style={s.body}>
            You will need this password to restore your chats. It is not your account password, and we
            cannot reset it for you.
          </Text>
          <TextInput
            style={s.input} value={pw} onChangeText={setPw} secureTextEntry autoFocus
            placeholder="Password" placeholderTextColor={colors.textFaint} accessibilityLabel="Backup password"
            autoCapitalize="none" autoCorrect={false}
          />
          <TextInput
            style={s.input} value={pw2} onChangeText={setPw2} secureTextEntry
            placeholder="Confirm password" placeholderTextColor={colors.textFaint} accessibilityLabel="Confirm backup password"
            autoCapitalize="none" autoCorrect={false}
          />
          <Text style={s.hint}>At least 8 characters, with a letter and a number.</Text>
          <TouchableOpacity
            style={[s.primaryBtn, (busy || !pw || !pw2) && s.btnOff]}
            disabled={busy || !pw || !pw2}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy || !pw || !pw2, busy }}
            onPress={enablePassword}>
            {busy ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={s.primaryTxt}>{switching ? 'USE THIS PASSWORD' : 'TURN ON'}</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={s.linkRow} accessibilityRole="button" onPress={() => { setPw(''); setPw2(''); setStage(switching ? 'on' : 'off'); }}>
            <Text style={s.link}>Cancel</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardSafe>
    );
  }

  if (stage === 'on') {
    return (
      <View style={s.root}>
        {header}
        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
          <View style={s.onBadge}>
            <Ionicons name="lock-closed" size={20} color={colors.primary} />
            <Text style={s.onTxt}>
              On — protected by {mode === 'key' ? 'your 64-character key' : 'your password'}
            </Text>
          </View>
          <Text style={s.body}>
            Your backups are encrypted with a key we do not have. You will be asked for
            {mode === 'key' ? ' your key' : ' your password'} when you restore on a new phone.
          </Text>
          <Text style={s.warn}>
            If you lose it, your backup cannot be recovered. Not by you, and not by us.
          </Text>
          <TouchableOpacity
            style={[s.primaryBtn, busy && s.btnOff]} disabled={busy}
            onPress={mode === 'key' ? enableKey : () => setStage('password')}
            accessibilityRole="button" accessibilityState={{ disabled: busy, busy }}>
            {busy ? <ActivityIndicator color={colors.onPrimary} />
                  : <Text style={s.primaryTxt}>{mode === 'key' ? 'MAKE A NEW KEY' : 'CHANGE PASSWORD'}</Text>}
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.secondaryBtn, busy && s.btnOff]} disabled={busy}
            onPress={mode === 'key' ? () => setStage('password') : enableKey}
            accessibilityRole="button" accessibilityState={{ disabled: busy }}>
            <Ionicons name={mode === 'key' ? 'text-outline' : 'key-outline'} size={18} color={colors.primary} />
            <Text style={s.secondaryTxt}>{mode === 'key' ? 'Switch to a password' : 'Switch to a 64-character key'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.dangerBtn, busy && s.btnOff]} disabled={busy} onPress={turnOff} accessibilityRole="button" accessibilityLabel="Turn off encrypted backup" accessibilityState={{ disabled: busy, busy }}>
            {busy ? <ActivityIndicator color={colors.danger} />
                  : <Text style={s.dangerTxt}>TURN OFF</Text>}
          </TouchableOpacity>
        </ScrollView>
      </View>
    );
  }

  // stage === 'off'
  return (
    <View style={s.root}>
      {header}
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
        <Ionicons name="lock-closed-outline" size={44} color={colors.primary} style={{ alignSelf: 'center', marginBottom: 14 }} />
        <Text style={s.body}>
          Your chat backup is currently encrypted with a key stored by your account, so it can be
          restored automatically — but it also means we are able to read it.
        </Text>
        <Text style={s.body}>
          Turn this on to encrypt your backup with a password or a 64-character key that only you hold.
        </Text>
        <Text style={s.warn}>
          There is no way to reset it. If you lose your password or key, your backup is gone
          permanently.
        </Text>

        <TouchableOpacity style={[s.primaryBtn, busy && s.btnOff]} disabled={busy} onPress={() => setStage('password')} accessibilityRole="button" accessibilityState={{ disabled: busy }}>
          <Text style={s.primaryTxt}>USE A PASSWORD</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.secondaryBtn, busy && s.btnOff]} disabled={busy} onPress={enableKey} accessibilityRole="button" accessibilityLabel="Use a 64-character key instead" accessibilityState={{ disabled: busy, busy }}>
          {busy ? <ActivityIndicator color={colors.primary} /> : <>
            <Ionicons name="key-outline" size={18} color={colors.primary} />
            <Text style={s.secondaryTxt}>Use a 64-character key instead</Text>
          </>}
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', paddingTop: HEADER_TOP, paddingHorizontal: 12, paddingBottom: 12, backgroundColor: c.bg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke, gap: 8 },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: c.text, fontSize: 18, fontWeight: '700', flexShrink: 1 },

  h1: { color: c.text, fontSize: 20, fontWeight: '700', marginBottom: 10 },
  body: { color: c.textDim, fontSize: 14, lineHeight: 21, marginBottom: 14 },
  warn: { color: c.text, fontSize: 14, lineHeight: 21, fontWeight: '600', marginBottom: 20 },
  hint: { color: c.textFaint, fontSize: 12, marginBottom: 18 },

  input: {
    color: c.text, fontSize: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke,
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: Platform.OS === 'ios' ? 14 : 10,
    marginBottom: 12, backgroundColor: c.glassSoft,
  },
  keyInput: { fontSize: 20, letterSpacing: 4, textAlign: 'center', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },

  keyBox: { borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke, borderRadius: 10, padding: 16, marginBottom: 16, backgroundColor: c.glassSoft },
  keyTxt: { color: c.text, fontSize: 16, lineHeight: 26, letterSpacing: 1, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },

  primaryBtn: { backgroundColor: c.primary, borderRadius: 26, paddingVertical: 14, minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  primaryTxt: { color: c.onPrimary, fontSize: 15, fontWeight: '800', letterSpacing: 0.5 },
  secondaryBtn: { flexDirection: 'row', gap: 8, borderRadius: 26, paddingVertical: 14, minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 10 },
  secondaryTxt: { color: c.primary, fontSize: 15, fontWeight: '700' },
  dangerBtn: { borderRadius: 26, paddingVertical: 14, minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: c.danger },
  dangerTxt: { color: c.danger, fontSize: 15, fontWeight: '800', letterSpacing: 0.5 },
  btnOff: { opacity: 0.6 },
  linkRow: { alignItems: 'center', justifyContent: 'center', paddingVertical: 14, minHeight: 44 },
  link: { color: c.primary, fontSize: 14, fontWeight: '700' },

  onBadge: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16 },
  onTxt: { color: c.text, fontSize: 16, fontWeight: '700', flexShrink: 1 },
});
