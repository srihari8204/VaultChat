// app/chat-backup.tsx — Chat backup (WhatsApp-style, single simple screen).
//
// One BACK UP button (no passphrase — the key is account-managed), Last Backup
// times, and a few settings: frequency and network. Restore happens
// automatically on reinstall (prompted at sign-in) but is also available here.

import { HEADER_TOP } from '../constants/layout';
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert, ActivityIndicator,
  Modal, TextInput, Platform,
} from 'react-native';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';
import {
  backupToGoogleDrive, restoreFromGoogleDrive,
  writeLocalBackup, restoreLocalBackup, listLocalBackups, type LocalBackup,
  uploadCloudBackup, restoreCloudBackup, cloudBackupMeta, type BackupMeta,
  getBackupMode, isSecretRequired, isBackupSettingsUnreadable, isWrongSecret,
  hasRestoreDecisionFlag, resolveRestoreDecision, isRestorePending,
} from '../lib/cloudBackup';
import { backupErrorText } from '../lib/backupSecretSwitch';
import { driveBackupMeta, getDriveEmail, getDriveToken } from '../lib/googleDrive';
import {
  getBackupSettings, saveBackupSettings, markBackupDone, type BackupSettings,
} from '../lib/backupScheduler';
import { AuroraBackground } from '../components/ui';
import { KeyboardSafe } from '../components/ui/KeyboardSafe';

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

// Restore order: the account copy first — it is the only one that exists after
// a reinstall, which is the case this button is for.
type Source = 'cloud' | 'drive' | 'local';
const SOURCES: Source[] = ['cloud', 'drive', 'local'];
const SOURCE_NAME: Record<Source, string> = { cloud: 'your account', drive: 'Google Drive', local: 'this device' };
const restoreFrom = (src: Source, secret?: string) => (src === 'cloud' ? restoreCloudBackup(secret)
  : src === 'drive' ? restoreFromGoogleDrive(secret) : restoreLocalBackup(undefined, secret));
const isNoBackup = (e: any) => e?.message === 'No backup found' || e?.message === 'No local backup found';

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
  // 'unknown': this phone's e2ee settings could not be read. Never shown as
  // "Off" — backups are paused (lib/cloudBackup fails closed) until it can.
  const [mode, setMode] = useState<'account' | 'password' | 'key' | 'unknown'>('account');
  // Set when a restore hits a blob this device holds no key for — the secret
  // lives only with the user, so the only way forward is to ask. `from` is the
  // copy that asked: the typed secret is tried on that copy only.
  const [ask, setAsk] = useState<{ mode: 'password' | 'key'; from: Source } | null>(null);
  const askSecret = ask?.mode ?? null;
  const [secretInput, setSecretInput] = useState('');
  // The secret is masked by default (shoulder-surfing); Show reveals it to check a long key.
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState<'backup' | 'restore' | 'signin' | null>(null);
  // This phone has not restored the account's backup or chosen to replace it
  // (lib/cloudBackup "restore decision pending"): automatic backups are paused
  // so they cannot overwrite it, and BACK UP asks first.
  const [restorePending, setRestorePending] = useState(false);

  const [loadErr, setLoadErr] = useState(false);
  // The metadata reads below are fire-and-forget; none may set state after
  // the screen has closed.
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const refresh = useCallback(async () => {
    const live = <T,>(set: (v: T) => void) => (v: T) => { if (mounted.current) set(v); };
    try {
      const st = await getBackupSettings();
      if (mounted.current) { setSettings(st); setLoadErr(false); }
    } catch { if (mounted.current) setLoadErr(true); }
    driveBackupMeta().then(live(setDrive)).catch(() => {});
    getDriveEmail().then(live(setGEmail)).catch(() => {});
    listLocalBackups().then(live(setLocal)).catch(() => {});
    cloudBackupMeta().then(live(setCloud)).catch(() => {});
    getBackupMode().then(live(setMode)).catch(() => { if (mounted.current) setMode('unknown'); });
    hasRestoreDecisionFlag().then(live(setRestorePending)).catch(() => {});
  }, []);

  const connectGoogle = async () => {
    setBusy('signin');
    try {
      await getDriveToken(true);          // triggers the Google sign-in dialog
      setGEmail(await getDriveEmail());
      setDrive(await driveBackupMeta());
    } catch (e: any) {
      Alert.alert('Google sign-in failed', backupErrorText(e));
    } finally { setBusy(null); }
  };
  // On focus, not just mount: returning from /backup-e2ee must refresh `mode`.
  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));

  const patch = async (p: Partial<BackupSettings>) => {
    const prev = settings as BackupSettings;
    const next = { ...prev, ...p };
    setSettings(next);
    try { await saveBackupSettings(next); }
    catch (e: any) {
      setSettings(prev);
      Alert.alert('Could not save', backupErrorText(e));
    }
  };

  // An undecided phone (see restorePending) replaces the online copy only after
  // the user is told so and agrees.
  const onBackUp = () => {
    if (!(restorePending && cloud.exists)) { runBackUp(); return; }
    const what = [
      cloud.messageCount ? `${cloud.messageCount.toLocaleString()} messages` : '',
      cloud.updatedAt ? `from ${fmt(new Date(cloud.updatedAt).getTime())}` : '',
    ].filter(Boolean).join(', ');
    Alert.alert(
      'Replace your online backup?',
      `This phone hasn't restored the backup in your account${what ? ` (${what})` : ''}. Backing up now replaces it with this phone's chats, and that can't be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Restore instead', onPress: onRestore },
        { text: 'Replace', style: 'destructive', onPress: async () => {
            try { await resolveRestoreDecision(); }
            catch (e) { Alert.alert('Backup failed', `Nothing was uploaded. ${backupErrorText(e)}`); return; }
            setRestorePending(false);
            runBackUp();
          } },
      ],
    );
  };

  const runBackUp = async () => {
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
      let cloudErr: unknown = null;
      // Reported below as "Partly backed up" / "Backup failed".
      try { await uploadCloudBackup(); cloudOk = true; } catch (e) { cloudErr = e; }
      const localOk = await writeLocalBackup(new Date()).then(() => true, () => false);
      let driveOk = false;
      try { await backupToGoogleDrive(true); driveOk = true; } catch { /* not signed in / cancelled */ }
      // Only a real backup resets the due-timer, and only a real backup is
      // reported as one — telling someone they are covered when they are not is
      // worse than telling them nothing, because this is the copy they will
      // reach for exactly once, after everything else is already gone.
      if (cloudOk || driveOk) await markBackupDone();
      await refresh();
      const onDevice = localOk ? ' and this device' : '';
      if (isBackupSettingsUnreadable(cloudErr)) {
        // Every destination refused: nothing may be written without the
        // secret, and nothing was.
        Alert.alert('Backup paused', backupErrorText(cloudErr));
      } else if (isRestorePending(cloudErr)) {
        // The online copies were protected; only a device file may exist.
        Alert.alert('Not backed up online', backupErrorText(cloudErr)
          + (localOk ? ' A copy was saved on this device only.' : ''));
      } else if (cloudOk) {
        Alert.alert('Backup complete', driveOk
          ? `Backed up to your account, Google Drive${onDevice}.`
          : `Backed up to your account${onDevice}. You can restore it when you reinstall.`);
      } else if (driveOk) {
        Alert.alert('Partly backed up',
          `Saved to Google Drive${onDevice}, but the backup to your account failed. ${backupErrorText(cloudErr)}`);
      } else {
        Alert.alert('Backup failed', (localOk
          ? 'Saved to this device only — that copy is deleted if you uninstall the app. '
          : 'Nothing was saved. ') + backupErrorText(cloudErr));
      }
    } catch (e: any) {
      Alert.alert('Backup failed', backupErrorText(e));
    } finally { setBusy(null); }
  };

  const savedAt = (src: Source): string | null => {
    const t = src === 'cloud' ? (cloud.updatedAt ? new Date(cloud.updatedAt).getTime() : 0)
      : src === 'drive' ? (drive.modifiedTime ? new Date(drive.modifiedTime).getTime() : 0) : local[0]?.mtime;
    return t ? fmt(t) : null;
  };

  const closeAsk = () => { setAsk(null); setSecretInput(''); setShowSecret(false); };

  // `only`: retry the copy that asked for a secret, with the secret — never fall
  // through to an older copy because the typed secret was wrong.
  const doRestore = async (userSecret?: string, only?: Source) => {
    setBusy('restore');
    try {
      // "This backup needs a secret" is NOT a reason to try the next
      // destination — the user is asked for it, for THAT copy. Any other
      // failure (none there, offline) moves on to the next copy, and the result
      // names which copy was applied, so an older one is never restored silently.
      let n = 0;
      let from: Source | null = null;
      let lastErr: unknown = null;
      for (const src of only ? [only] : SOURCES) {
        try { n = await restoreFrom(src, userSecret); from = src; break; }
        catch (e) {
          if (isSecretRequired(e)) { setAsk({ mode: e.mode, from: src }); return; }
          // Report the first real failure (offline, server), not a later "none here".
          if (!lastErr || isNoBackup(lastErr)) lastErr = e;
        }
      }
      if (!from) throw lastErr;
      closeAsk();
      const when = savedAt(from);
      // An end-to-end encrypted copy keeps this phone end-to-end encrypted
      // (lib/cloudBackup adopts the secret that opened it).
      const nowMode = await getBackupMode().catch(() => null);
      refresh();
      // Restored rows go straight into the local store, which every chat reads
      // when it opens, and the Chats list re-reads itself on focus — so going
      // back to Chats shows them; no restart needed.
      Alert.alert('Restore complete',
        `${n} messages restored from ${SOURCE_NAME[from]}${when ? ` (backup from ${when})` : ''}.`
        + (from !== 'cloud' ? ' The copy in your account could not be used.' : '')
        + (nowMode === 'password' || nowMode === 'key' ? ' Backups from this phone stay end-to-end encrypted.' : ''), [
          { text: 'Stay here', style: 'cancel' },
          { text: 'Open chats', onPress: () => router.dismissTo('/(tabs)/chats') },
        ]);
    } catch (e: any) {
      // lib/cloudBackup marks a typed secret that did not open the copy (a
      // different key id, or AES-GCM refusing it) — anything else is reported
      // as what it is, not guessed to be a wrong password.
      if (userSecret && isWrongSecret(e)) {
        Alert.alert('Could not unlock the backup',
          askSecret === 'key' ? 'That key did not work. If you have made a new key since this backup, use the key you had then.'
                              : 'That password did not work. If you have changed it since this backup, use the password you had then.');
        return;
      }
      Alert.alert('Restore failed', isNoBackup(e)
        ? 'No backup found for this account yet.' : backupErrorText(e));
    } finally { setBusy(null); }
  };

  const onRestore = () => {
    Alert.alert(
      'Restore chats?',
      'Restore your messages from the latest backup.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Restore', onPress: () => { doRestore(); } },
      ],
    );
  };

  const header = (
    <>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />
      <View style={s.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={s.iconBtn} hitSlop={8}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle} accessibilityRole="header">Chat backup</Text>
      </View>
    </>
  );

  if (!settings) {
    return (
      <View style={s.root}>
        {header}
        <View style={s.loadBox}>
          {loadErr ? (
            <>
              <Text style={s.topDesc}>Backup settings could not be loaded.</Text>
              <TouchableOpacity onPress={refresh} accessibilityRole="button" style={s.linkBtn}>
                <Text style={s.restoreLink}>Try again</Text>
              </TouchableOpacity>
            </>
          ) : <ActivityIndicator color={colors.primary} accessibilityLabel="Loading backup settings" />}
        </View>
      </View>
    );
  }

  return (
    <View style={s.root}>
      {header}

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

          {restorePending && cloud.exists && (
            <View style={s.notice}>
              <Ionicons name="pause-circle-outline" size={20} color={colors.warning} />
              <Text style={s.noticeTxt}>
                Automatic backup is paused on this phone. It hasn&apos;t restored the backup in your account,
                and backing up would replace it. Restore it below, or tap BACK UP to replace it with this
                phone&apos;s chats.
              </Text>
            </View>
          )}

          <TouchableOpacity style={[s.backupBtn, busy && s.btnOff]} onPress={onBackUp} disabled={!!busy} activeOpacity={0.85} accessibilityRole="button" accessibilityLabel="Back up now" accessibilityState={{ disabled: !!busy, busy: busy === 'backup' }}>
            {busy === 'backup'
              ? <ActivityIndicator color={colors.onPrimary} />
              : <Text style={s.backupTxt}>BACK UP</Text>}
          </TouchableOpacity>
          <TouchableOpacity onPress={onRestore} disabled={!!busy} style={s.linkBtn} accessibilityRole="button" accessibilityLabel="Restore from backup" accessibilityState={{ disabled: !!busy, busy: busy === 'restore' }}>
            <Text style={s.restoreLink}>{busy === 'restore' ? 'Restoring…' : 'Restore'}</Text>
          </TouchableOpacity>
        </View>

        <View style={s.divider} />

        {/* Auto backup */}
        <Text style={s.section}>AUTO BACKUP</Text>
        {FREQ.map(f => (
          <TouchableOpacity key={f.id} style={s.optRow} onPress={() => patch({ frequency: f.id })} activeOpacity={0.7} accessibilityRole="radio" accessibilityLabel={`Auto backup: ${f.label}`} accessibilityState={{ checked: settings.frequency === f.id }}>
            <Ionicons name={settings.frequency === f.id ? 'radio-button-on' : 'radio-button-off'} size={22} color={settings.frequency === f.id ? colors.primary : colors.textDim} />
            <Text style={s.optLabel}>{f.label}</Text>
          </TouchableOpacity>
        ))}

        <View style={s.divider} />
        <Text style={s.section}>END-TO-END ENCRYPTED BACKUP</Text>
        <TouchableOpacity
          style={s.optRow}
          onPress={() => router.push('/backup-e2ee')}
          disabled={!!busy}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`End-to-end encrypted backup: ${mode === 'account' ? 'off' : mode === 'unknown' ? 'could not be read' : 'on'}`}
          accessibilityHint="Opens end-to-end encrypted backup settings"
          accessibilityState={{ disabled: !!busy }}
        >
          <Ionicons name={mode === 'account' ? 'lock-open-outline' : mode === 'unknown' ? 'alert-circle-outline' : 'lock-closed'} size={22}
                    color={mode === 'account' ? colors.textDim : mode === 'unknown' ? colors.danger : colors.primary} />
          <View style={{ flex: 1 }}>
            <Text style={s.optLabel}>{mode === 'account' ? 'Off' : mode === 'unknown' ? "Couldn't read this setting" : 'On'}</Text>
            <Text style={s.optSub} numberOfLines={3}>
              {mode === 'account'
                ? 'Your backup is encrypted with a key stored by your account, so it can be restored automatically.'
                : mode === 'unknown'
                  ? 'Backups are paused until this phone can read your encryption settings. Tap to try again.'
                : mode === 'key'
                  ? 'Only your 64-character key can unlock this backup.'
                  : 'Only your password can unlock this backup.'}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
        </TouchableOpacity>

        <View style={s.divider} />
        <Text style={s.section}>GOOGLE ACCOUNT</Text>
        <TouchableOpacity
          style={s.optRow}
          onPress={connectGoogle}
          disabled={!!busy}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={gEmail ? `Google account: ${gEmail}` : 'Connect a Google account'}
          accessibilityState={{ disabled: !!busy, busy: busy === 'signin' }}
        >
          <Ionicons name="logo-google" size={20} color={colors.primary} />
          <Text style={[s.optLabel, { flex: 1 }]} numberOfLines={1}>{gEmail || 'Connect a Google account'}</Text>
          {busy === 'signin'
            ? <ActivityIndicator color={colors.primary} />
            : <Ionicons name="chevron-forward" size={18} color={colors.textDim} />}
        </TouchableOpacity>

        <View style={s.divider} />
        <Text style={s.section}>BACK UP USING</Text>
        {NET.map(n => (
          <TouchableOpacity key={n.id} style={s.optRow} onPress={() => patch({ network: n.id })} activeOpacity={0.7} accessibilityRole="radio" accessibilityLabel={`Back up using ${n.label}`} accessibilityState={{ checked: settings.network === n.id }}>
            <Ionicons name={settings.network === n.id ? 'radio-button-on' : 'radio-button-off'} size={22} color={settings.network === n.id ? colors.primary : colors.textDim} />
            <Text style={s.optLabel}>{n.label}</Text>
          </TouchableOpacity>
        ))}

        {/* No "Include videos" switch: the backup bundle carries messages
            only, no media (lib/cloudBackup.ts), so the setting changed nothing. */}

        <Text style={s.note}>
          {mode === 'account'
            ? 'Backups are encrypted and restore automatically when you reinstall and sign in.'
            : mode === 'unknown'
              ? 'Backups are paused: nothing is uploaded until this phone can read your encryption settings.'
            : 'Backups are end-to-end encrypted. You will need your ' +
              (mode === 'key' ? '64-character key' : 'password') + ' to restore them.'}
        </Text>
      </ScrollView>

      {/* Restoring an end-to-end encrypted backup. Alert.prompt is iOS-only, and
          this is exactly the moment a returning Android user hits — a fresh
          install with their whole history behind one secret. */}
      <Modal visible={askSecret !== null} transparent animationType="fade"
             onRequestClose={closeAsk}>
        <KeyboardSafe keyboardOnly>
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle} accessibilityRole="header">
              {askSecret === 'key' ? 'Enter your 64-character key' : 'Enter your backup password'}
            </Text>
            <Text style={s.modalBody}>
              The copy in {ask ? SOURCE_NAME[ask.from] : 'your backup'} is end-to-end encrypted. It can only be
              unlocked with the {askSecret === 'key' ? 'key' : 'password'} it was made with — if you have changed
              it since, use the one you had then.
            </Text>
            <TextInput
              style={[s.modalInput, askSecret === 'key' && s.modalInputMono, askSecret === 'key' && showSecret && s.modalInputTall]}
              value={secretInput}
              onChangeText={setSecretInput}
              // secureTextEntry cannot be multiline, so the key wraps only when shown.
              secureTextEntry={!showSecret}
              autoFocus
              multiline={askSecret === 'key' && showSecret}
              importantForAutofill="no"
              autoComplete="off"
              placeholder={askSecret === 'key' ? '0000 0000 0000 …' : 'Password'}
              placeholderTextColor={colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel={askSecret === 'key' ? '64-character backup key' : 'Backup password'}
            />
            <TouchableOpacity
              onPress={() => setShowSecret(v => !v)}
              style={s.showBtn}
              accessibilityRole="switch"
              accessibilityLabel={askSecret === 'key' ? 'Show key' : 'Show password'}
              accessibilityState={{ checked: showSecret }}>
              <Ionicons name={showSecret ? 'eye-off-outline' : 'eye-outline'} size={18} color={colors.primary} />
              <Text style={s.restoreLink}>{showSecret ? 'Hide' : 'Show'}</Text>
            </TouchableOpacity>
            <View style={s.modalBtns}>
              <TouchableOpacity onPress={closeAsk} disabled={!!busy} style={s.modalBtn} accessibilityRole="button">
                <Text style={s.modalCancel}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => doRestore(secretInput, ask?.from)}
                disabled={!!busy || !secretInput.trim()}
                style={s.modalBtn}
                accessibilityRole="button"
                accessibilityLabel="Unlock backup"
                accessibilityState={{ disabled: !!busy || !secretInput.trim() }}>
                {busy === 'restore'
                  ? <ActivityIndicator color={colors.primary} />
                  : <Text style={[s.modalOk, !secretInput.trim() && s.btnOff]}>UNLOCK</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
        </KeyboardSafe>
      </Modal>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', paddingTop: HEADER_TOP, paddingHorizontal: 12, paddingBottom: 12, backgroundColor: c.bg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke, gap: 8 },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: c.text, fontSize: 18, fontWeight: '700' },

  top: { alignItems: 'center', paddingHorizontal: 24, paddingTop: 24 },
  topDesc: { color: c.textDim, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  timesRow: { flexDirection: 'row', justifyContent: 'space-between', alignSelf: 'stretch', marginTop: 14, paddingHorizontal: 6 },
  timeLabel: { color: c.textDim, fontSize: 14 },
  timeVal: { color: c.text, fontSize: 14, fontWeight: '600' },
  backupBtn: { backgroundColor: c.primary, borderRadius: 26, paddingVertical: 14, paddingHorizontal: 48, marginTop: 22, minWidth: 200, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  notice: {
    flexDirection: 'row', gap: 10, alignSelf: 'stretch', marginTop: 16, padding: 12, borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.warning, backgroundColor: c.glassSoft,
  },
  noticeTxt: { flex: 1, color: c.text, fontSize: 13, lineHeight: 19 },
  btnOff: { opacity: 0.6 },
  backupTxt: { color: c.onPrimary, fontSize: 15, fontWeight: '800', letterSpacing: 0.5 },
  restoreLink: { color: c.primary, fontSize: 14, fontWeight: '700' },

  divider: { height: StyleSheet.hairlineWidth, backgroundColor: c.hairline, marginVertical: 12 },
  section: { color: c.textDim, fontSize: 11, fontWeight: '800', letterSpacing: 1, paddingHorizontal: 18, paddingBottom: 6 },
  optRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 18, paddingVertical: 13 },
  optLabel: { color: c.text, fontSize: 15 },
  optSub: { color: c.textFaint, fontSize: 12, lineHeight: 16, marginTop: 2 },
  note: { color: c.textFaint, fontSize: 12, lineHeight: 17, paddingHorizontal: 18, paddingTop: 18 },

  // The theme's scrim dims whatever is behind the dialog.
  modalWrap: { flex: 1, backgroundColor: c.scrim, alignItems: 'center', justifyContent: 'center', padding: 24 },
  modalCard: { width: '100%', maxWidth: 420, backgroundColor: c.bg, borderRadius: 14, padding: 20 },
  modalTitle: { color: c.text, fontSize: 17, fontWeight: '700', marginBottom: 8 },
  modalBody: { color: c.textDim, fontSize: 13, lineHeight: 19, marginBottom: 14 },
  modalInput: {
    color: c.text, fontSize: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke,
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: Platform.OS === 'ios' ? 14 : 10,
  },
  modalInputMono: { letterSpacing: 1, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  modalInputTall: { minHeight: 92, textAlignVertical: 'top' },
  showBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', minHeight: 44 },
  loadBox: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  linkBtn: { paddingVertical: 10, paddingHorizontal: 10, minHeight: 44, justifyContent: 'center' },
  modalBtns: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 12, marginTop: 18 },
  modalBtn: { minHeight: 44, minWidth: 64, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  modalCancel: { color: c.textDim, fontSize: 14, fontWeight: '700' },
  modalOk: { color: c.primary, fontSize: 14, fontWeight: '800', letterSpacing: 0.5 },
});
