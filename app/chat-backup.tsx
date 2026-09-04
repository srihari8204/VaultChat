// app/chat-backup.tsx — Chat backup (WhatsApp-style, single simple screen).
//
// One BACK UP button (no passphrase — the key is account-managed), Last Backup
// times, and a few settings: frequency, network, include videos. Restore happens
// automatically on reinstall (prompted at sign-in) but is also available here.

import { HEADER_TOP } from '../constants/layout';
import React, { useState, useEffect, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert, ActivityIndicator, Switch,
  Modal, TextInput, Platform,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';
import {
  backupToGoogleDrive, restoreFromGoogleDrive,
  writeLocalBackup, restoreLocalBackup, listLocalBackups, type LocalBackup,
  uploadCloudBackup, restoreCloudBackup, cloudBackupMeta, type BackupMeta,
  getBackupMode, isSecretRequired,
} from '../lib/cloudBackup';
import { driveBackupMeta, getDriveEmail, getDriveToken } from '../lib/googleDrive';
import {
  getBackupSettings, saveBackupSettings, markBackupDone, type BackupSettings,
} from '../lib/backupScheduler';

const FREQ = [
  { id: 'manual', label: 'Off' },
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
] as const;
const NET = [
  { id: 'wifi', label: 'Wi-Fi only' },
  { id: 'any', label: 'Wi-Fi or mobile data' },
] as const;

function fmt(ms: number | undefined | null): string {
  if (!ms) return 'Never';
  const d = new Date(ms);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function ChatBackupScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);

  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [drive, setDrive] = useState<{ exists: boolean; modifiedTime?: string }>({ exists: false });
  const [gEmail, setGEmail] = useState<string | null>(null);
  const [local, setLocal] = useState<LocalBackup[]>([]);
  const [cloud, setCloud] = useState<BackupMeta>({ exists: false });
  const [mode, setMode] = useState<'account' | 'password' | 'key'>('account');
  // Set when a restore hits a blob this device holds no key for — the secret
  // lives only with the user, so the only way forward is to ask.
  const [askSecret, setAskSecret] = useState<'password' | 'key' | null>(null);
  const [secretInput, setSecretInput] = useState('');
  const [busy, setBusy] = useState<'backup' | 'restore' | 'signin' | null>(null);

  const refresh = async () => {
    setSettings(await getBackupSettings());
    driveBackupMeta().then(setDrive).catch(() => {});
    getDriveEmail().then(setGEmail).catch(() => {});
    listLocalBackups().then(setLocal).catch(() => {});
    cloudBackupMeta().then(setCloud).catch(() => {});
    getBackupMode().then(setMode).catch(() => {});
  };

  const connectGoogle = async () => {
    setBusy('signin');
    try {
      await getDriveToken(true);          // triggers the Google sign-in dialog
      setGEmail(await getDriveEmail());
      setDrive(await driveBackupMeta());
    } catch (e: any) {
      Alert.alert('Google sign-in failed', e?.message ?? 'Please try again.');
    } finally { setBusy(null); }
  };
  useEffect(() => { refresh(); }, []);

  const patch = async (p: Partial<BackupSettings>) => {
    const next = { ...(settings as BackupSettings), ...p };
    setSettings(next);
    await saveBackupSettings(next);
  };

  const onBackUp = async () => {
    setBusy('backup');
    try {
      // The account copy FIRST, and it is the one whose failure is reported.
      //
      // This button used to write only the device file and Drive. BACKUP_ROOT is
      // inside the app sandbox, so the device copy is deleted by an uninstall —
      // it restores a wiped cache on the same install and nothing more — and
      // Drive is unavailable on the no-GMS handsets this app supports. So the
      // one destination that can actually answer "I reinstalled, give me my
      // chats back" was the one destination never written, and the screen
      // reported "Backup complete" regardless.
      let cloudOk = false;
      try { await uploadCloudBackup(); cloudOk = true; }
      catch (e) { console.warn('[backup] cloud upload failed:', (e as any)?.message); }
      await writeLocalBackup(new Date()).catch(() => {});
      let driveOk = false;
      try { await backupToGoogleDrive(true); driveOk = true; } catch { /* not signed in / cancelled */ }
      // Only a real backup resets the due-timer, and only a real backup is
      // reported as one — telling someone they are covered when they are not is
      // worse than telling them nothing, because this is the copy they will
      // reach for exactly once, after everything else is already gone.
      if (cloudOk || driveOk) await markBackupDone();
      await refresh();
      if (cloudOk) {
        Alert.alert('Backup complete', driveOk
          ? 'Backed up to your account, Google Drive and this device.'
          : 'Backed up to your account and this device. You can restore it when you reinstall.');
      } else if (driveOk) {
        Alert.alert('Partly backed up',
          'Saved to Google Drive and this device, but the backup to your account failed. Tap Back Up again when you have a stable connection.');
      } else {
        Alert.alert('Backup failed',
          'Saved to this device only — that copy is deleted if you uninstall the app. Tap Back Up again when you have a stable connection.');
      }
    } catch (e: any) {
      Alert.alert('Backup failed', e?.message ?? 'Please try again.');
    } finally { setBusy(null); }
  };

  const doRestore = async (userSecret?: string) => {
    setBusy('restore');
    try {
      // ACCOUNT COPY FIRST — it is the only one that exists after a reinstall,
      // which is the case this button is for. The old order tried Drive then the
      // local file: on a fresh install the local file was deleted with the
      // previous install and Drive needs both GMS and a prior sign-in, so the
      // restore prompt led here and then failed for most users while their
      // backup sat on the server.
      //
      // "This backup needs a secret" is NOT a reason to try the next
      // destination — the other copies are encrypted the same way, so falling
      // through would just fail twice more and report "no backup found" for a
      // backup that is sitting right there, intact.
      let n = 0;
      try { n = await restoreCloudBackup(userSecret); }
      catch (e) {
        if (isSecretRequired(e)) throw e;
        try { n = await restoreFromGoogleDrive(userSecret); }
        catch (e2) {
          if (isSecretRequired(e2)) throw e2;
          n = await restoreLocalBackup(undefined, userSecret);
        }
      }
      setAskSecret(null); setSecretInput('');
      Alert.alert('Restore complete', `${n} messages restored. Restart the app to see them.`);
    } catch (e: any) {
      if (isSecretRequired(e)) { setAskSecret(e.mode); return; }
      // A supplied secret that did not open it is the overwhelmingly likely
      // cause here, and AES-GCM's failure surfaces as an opaque decrypt error.
      // Saying "wrong password" is both the truthful reading and the only one
      // the user can act on.
      if (userSecret) {
        Alert.alert('Could not unlock the backup',
          askSecret === 'key' ? 'That key did not work. Check it and try again.'
                              : 'That password did not work. Check it and try again.');
        return;
      }
      Alert.alert('Restore failed', e?.message === 'No backup found' || e?.message === 'No local backup found'
        ? 'No backup found for this account yet.' : (e?.message ?? 'Please try again.'));
    } finally { setBusy(null); }
  };

  const onRestore = () => {
    Alert.alert(
      'Restore chats?',
      'Restore your messages from the latest backup. Restart the app afterwards.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Restore', onPress: () => { doRestore(); } },
      ],
    );
  };

  if (!settings) return <View style={s.root} />;

  return (
    <View style={s.root}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.iconBtn} hitSlop={8}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Chat backup</Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {/* Last backup + BACK UP */}
        <View style={s.top}>
          <Ionicons name="cloud-upload-outline" size={44} color={colors.primary} style={{ marginBottom: 12 }} />
          <Text style={s.topDesc}>
            Back up your messages so you can restore them when you reinstall the app or move to a new
            phone. Without a backup, your chat history cannot be recovered.
          </Text>
          {/* Account first — it is the only row that means anything after an
              uninstall. "On device" reads like reassurance and is not: that file
              lives in the app's private storage and Android deletes it with the
              app. Listing it first was quietly the most misleading thing here. */}
          <View style={s.timesRow}>
            <Text style={s.timeLabel}>Your account</Text>
            <Text style={s.timeVal}>{cloud.updatedAt ? fmt(new Date(cloud.updatedAt).getTime()) : 'Never'}</Text>
          </View>
          <View style={s.timesRow}>
            <Text style={s.timeLabel}>On device only</Text>
            <Text style={s.timeVal}>{fmt(local[0]?.mtime)}</Text>
          </View>
          <View style={s.timesRow}>
            <Text style={s.timeLabel}>Google Drive</Text>
            <Text style={s.timeVal}>{drive.modifiedTime ? fmt(new Date(drive.modifiedTime).getTime()) : 'Never'}</Text>
          </View>

          <TouchableOpacity style={[s.backupBtn, busy && s.btnOff]} onPress={onBackUp} disabled={!!busy} activeOpacity={0.85}>
            {busy === 'backup'
              ? <ActivityIndicator color="#fff" />
              : <Text style={s.backupTxt}>BACK UP</Text>}
          </TouchableOpacity>
          <TouchableOpacity onPress={onRestore} disabled={!!busy} style={{ paddingVertical: 10 }}>
            <Text style={s.restoreLink}>{busy === 'restore' ? 'Restoring…' : 'Restore'}</Text>
          </TouchableOpacity>
        </View>

        <View style={s.divider} />

        {/* Auto backup */}
        <Text style={s.section}>AUTO BACKUP</Text>
        {FREQ.map(f => (
          <TouchableOpacity key={f.id} style={s.optRow} onPress={() => patch({ frequency: f.id })} activeOpacity={0.7}>
            <Ionicons name={settings.frequency === f.id ? 'radio-button-on' : 'radio-button-off'} size={22} color={settings.frequency === f.id ? colors.primary : colors.textDim} />
            <Text style={s.optLabel}>{f.label}</Text>
          </TouchableOpacity>
        ))}

        <View style={s.divider} />
        <Text style={s.section}>END-TO-END ENCRYPTED BACKUP</Text>
        <TouchableOpacity style={s.optRow} onPress={() => router.push('/backup-e2ee' as any)} disabled={!!busy} activeOpacity={0.7}>
          <Ionicons name={mode === 'account' ? 'lock-open-outline' : 'lock-closed'} size={22}
                    color={mode === 'account' ? colors.textDim : colors.primary} />
          <View style={{ flex: 1 }}>
            <Text style={s.optLabel}>{mode === 'account' ? 'Off' : 'On'}</Text>
            <Text style={s.optSub} numberOfLines={2}>
              {mode === 'account'
                ? 'Your backup is encrypted with a key stored by your account, so it can be restored automatically.'
                : mode === 'key'
                  ? 'Only your 64-digit key can unlock this backup.'
                  : 'Only your password can unlock this backup.'}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
        </TouchableOpacity>

        <View style={s.divider} />
        <Text style={s.section}>GOOGLE ACCOUNT</Text>
        <TouchableOpacity style={s.optRow} onPress={connectGoogle} disabled={!!busy} activeOpacity={0.7}>
          <Ionicons name="logo-google" size={20} color={colors.primary} />
          <Text style={[s.optLabel, { flex: 1 }]} numberOfLines={1}>{gEmail || 'Connect a Google account'}</Text>
          {busy === 'signin'
            ? <ActivityIndicator color={colors.primary} />
            : <Ionicons name="chevron-forward" size={18} color={colors.textDim} />}
        </TouchableOpacity>

        <View style={s.divider} />
        <Text style={s.section}>BACK UP USING</Text>
        {NET.map(n => (
          <TouchableOpacity key={n.id} style={s.optRow} onPress={() => patch({ network: n.id })} activeOpacity={0.7}>
            <Ionicons name={settings.network === n.id ? 'radio-button-on' : 'radio-button-off'} size={22} color={settings.network === n.id ? colors.primary : colors.textDim} />
            <Text style={s.optLabel}>{n.label}</Text>
          </TouchableOpacity>
        ))}

        <View style={s.divider} />
        <View style={[s.optRow, { paddingRight: 18 }]}>
          <Ionicons name="videocam-outline" size={22} color={colors.text} />
          <Text style={[s.optLabel, { flex: 1 }]}>Include videos</Text>
          <Switch
            value={settings.includeVideos}
            onValueChange={(v) => patch({ includeVideos: v })}
            trackColor={{ true: colors.primary, false: colors.border }}
            thumbColor="#fff"
          />
        </View>

        <Text style={s.note}>
          {mode === 'account'
            ? 'Backups are encrypted and restore automatically when you reinstall and sign in.'
            : 'Backups are end-to-end encrypted. You will need your ' +
              (mode === 'key' ? '64-digit key' : 'password') + ' to restore them.'}
        </Text>
      </ScrollView>

      {/* Restoring an end-to-end encrypted backup. Alert.prompt is iOS-only, and
          this is exactly the moment a returning Android user hits — a fresh
          install with their whole history behind one secret. */}
      <Modal visible={askSecret !== null} transparent animationType="fade"
             onRequestClose={() => { setAskSecret(null); setSecretInput(''); }}>
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>
              {askSecret === 'key' ? 'Enter your 64-digit key' : 'Enter your backup password'}
            </Text>
            <Text style={s.modalBody}>
              This backup is end-to-end encrypted. It can only be unlocked with the
              {askSecret === 'key' ? ' key' : ' password'} you set when you turned it on.
            </Text>
            <TextInput
              style={[s.modalInput, askSecret === 'key' && s.modalInputMono]}
              value={secretInput}
              onChangeText={setSecretInput}
              secureTextEntry={askSecret === 'password'}
              autoFocus
              multiline={askSecret === 'key'}
              placeholder={askSecret === 'key' ? '0000 0000 0000 …' : 'Password'}
              placeholderTextColor={colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={s.modalBtns}>
              <TouchableOpacity onPress={() => { setAskSecret(null); setSecretInput(''); }} disabled={!!busy}>
                <Text style={s.modalCancel}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => doRestore(secretInput)}
                disabled={!!busy || !secretInput.trim()}>
                {busy === 'restore'
                  ? <ActivityIndicator color={colors.primary} />
                  : <Text style={[s.modalOk, !secretInput.trim() && s.btnOff]}>UNLOCK</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', paddingTop: HEADER_TOP, paddingHorizontal: 12, paddingBottom: 12, backgroundColor: c.bg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border, gap: 8 },
  iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: c.text, fontSize: 18, fontWeight: '700' },

  top: { alignItems: 'center', paddingHorizontal: 24, paddingTop: 24 },
  topDesc: { color: c.textDim, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  timesRow: { flexDirection: 'row', justifyContent: 'space-between', alignSelf: 'stretch', marginTop: 14, paddingHorizontal: 6 },
  timeLabel: { color: c.textDim, fontSize: 14 },
  timeVal: { color: c.text, fontSize: 14, fontWeight: '600' },
  backupBtn: { backgroundColor: c.primary, borderRadius: 26, paddingVertical: 14, paddingHorizontal: 48, marginTop: 22, minWidth: 200, alignItems: 'center' },
  btnOff: { opacity: 0.6 },
  backupTxt: { color: '#fff', fontSize: 15, fontWeight: '800', letterSpacing: 0.5 },
  restoreLink: { color: c.primary, fontSize: 14, fontWeight: '700' },

  divider: { height: StyleSheet.hairlineWidth, backgroundColor: c.separator, marginVertical: 12 },
  section: { color: c.textDim, fontSize: 11, fontWeight: '800', letterSpacing: 1, paddingHorizontal: 18, paddingBottom: 6 },
  optRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 18, paddingVertical: 13 },
  optLabel: { color: c.text, fontSize: 15 },
  optSub: { color: c.textFaint, fontSize: 12, lineHeight: 16, marginTop: 2 },
  note: { color: c.textFaint, fontSize: 12, lineHeight: 17, paddingHorizontal: 18, paddingTop: 18 },

  modalWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  modalCard: { width: '100%', maxWidth: 420, backgroundColor: c.bg, borderRadius: 14, padding: 20 },
  modalTitle: { color: c.text, fontSize: 17, fontWeight: '700', marginBottom: 8 },
  modalBody: { color: c.textDim, fontSize: 13, lineHeight: 19, marginBottom: 14 },
  modalInput: {
    color: c.text, fontSize: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: Platform.OS === 'ios' ? 14 : 10,
  },
  modalInputMono: { minHeight: 92, textAlignVertical: 'top', letterSpacing: 1, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  modalBtns: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 26, marginTop: 18 },
  modalCancel: { color: c.textDim, fontSize: 14, fontWeight: '700' },
  modalOk: { color: c.primary, fontSize: 14, fontWeight: '800', letterSpacing: 0.5 },
});
