// app/chat-backup.tsx — Chat backup (WhatsApp-style, single simple screen).
//
// One BACK UP button (no passphrase — the key is account-managed), Last Backup
// times, and a few settings: frequency, network, include videos. Restore happens
// automatically on reinstall (prompted at sign-in) but is also available here.

import React, { useState, useEffect, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert, ActivityIndicator, Switch,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';
import {
  backupToGoogleDrive, restoreFromGoogleDrive,
  writeLocalBackup, restoreLocalBackup, listLocalBackups, type LocalBackup,
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
  const [busy, setBusy] = useState<'backup' | 'restore' | 'signin' | null>(null);

  const refresh = async () => {
    setSettings(await getBackupSettings());
    driveBackupMeta().then(setDrive).catch(() => {});
    getDriveEmail().then(setGEmail).catch(() => {});
    listLocalBackups().then(setLocal).catch(() => {});
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
      await writeLocalBackup(new Date());           // device copy always
      let driveOk = false;
      try { await backupToGoogleDrive(true); driveOk = true; } catch { /* not signed in / cancelled */ }
      await markBackupDone();
      await refresh();
      Alert.alert('Backup complete', driveOk
        ? 'Backed up to Google Drive and this device.'
        : 'Saved to this device. Connect a Google Account below to also back up to Drive.');
    } catch (e: any) {
      Alert.alert('Backup failed', e?.message ?? 'Please try again.');
    } finally { setBusy(null); }
  };

  const onRestore = () => {
    Alert.alert(
      'Restore chats?',
      'Restore your messages from the latest backup. Restart the app afterwards.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Restore', onPress: async () => {
            setBusy('restore');
            try {
              let n = 0;
              try { n = await restoreFromGoogleDrive(); }
              catch { n = await restoreLocalBackup(); }   // fall back to local file
              Alert.alert('Restore complete', `${n} messages restored. Restart the app to see them.`);
            } catch (e: any) {
              Alert.alert('Restore failed', e?.message === 'No backup found' || e?.message === 'No local backup found'
                ? 'No backup found for this account yet.' : (e?.message ?? 'Please try again.'));
            } finally { setBusy(null); }
          } },
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
            Back up your messages. You can restore them when you reinstall the app. Messages are also
            saved to your phone’s storage.
          </Text>
          <View style={s.timesRow}>
            <Text style={s.timeLabel}>On device</Text>
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
          Backups are encrypted and restore automatically when you reinstall and sign in.
        </Text>
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', paddingTop: 54, paddingHorizontal: 12, paddingBottom: 12, backgroundColor: c.bg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border, gap: 8 },
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
  note: { color: c.textFaint, fontSize: 12, lineHeight: 17, paddingHorizontal: 18, paddingTop: 18 },
});
