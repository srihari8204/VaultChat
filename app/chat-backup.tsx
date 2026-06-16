// app/chat-backup.tsx — Chat Backup & Restore
// Real encrypted backup: exports local data (AsyncStorage + the local message DB)
// to an AES-256-GCM-encrypted file (passphrase-protected via lib/vaultCrypto)
// that the user saves via the OS share sheet. Restore re-imports a picked file.

import React, { useState, useEffect , useMemo} from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  StatusBar, Platform, Alert, ActivityIndicator, Switch,
  Modal, TextInput,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { Stack, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
import { vaultEncrypt, vaultDecrypt } from '../lib/vaultCrypto';
import { exportAll, importAll } from '../lib/localDb';

const TOP = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 44;


const BACKUP_KEY = 'vc_backup_data';
const BACKUP_SETTINGS_KEY = 'vc_backup_settings';

const DEFAULT_SETTINGS = {
  frequency: 'weekly', // daily | weekly | monthly | manual
  includeVideos: false,
};

type BackupEntry = {
  id: string;
  date: string;
  sizeBytes: number;
  messageCount: number;
  encrypted: boolean;
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function ChatBackupScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [backingUp, setBackingUp] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [lastBackup, setLastBackup] = useState<BackupEntry | null>(null);
  const [passModal, setPassModal] = useState<'backup' | 'restore' | null>(null);
  const [passInput, setPassInput] = useState('');

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [rawData, rawSettings] = await Promise.all([
        AsyncStorage.getItem(BACKUP_KEY),
        AsyncStorage.getItem(BACKUP_SETTINGS_KEY),
      ]);

      if (rawSettings) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(rawSettings) });

      if (rawData) {
        const list: BackupEntry[] = JSON.parse(rawData);
        setBackups(list);
        if (list.length > 0) setLastBackup(list[0]);
      }
    } catch {} finally {
      setLoading(false);
    }
  };

  const saveSetting = async (updated: typeof settings) => {
    setSettings(updated);
    await AsyncStorage.setItem(BACKUP_SETTINGS_KEY, JSON.stringify(updated));
  };

  const doBackup = async (passphrase: string) => {
    setBackingUp(true);
    try {
      // Gather real local data: all AsyncStorage + the local message DB.
      const keys = await AsyncStorage.getAllKeys();
      const pairs = await AsyncStorage.multiGet(keys);
      const store: Record<string, string | null> = {};
      for (const [k, v] of pairs) store[k] = v;
      const local = await exportAll();

      const bundle = JSON.stringify({ v: 1, createdAt: new Date().toISOString(), asyncStorage: store, messages: local.messages, chats: local.chats });
      const payload = vaultEncrypt(passphrase, bundle); // real AES-256-GCM

      const fileName = `vaultchat-backup-${Date.now()}.vcbak`;
      const uri = (FileSystem as any).cacheDirectory + fileName;
      await FileSystem.writeAsStringAsync(uri, JSON.stringify(payload), { encoding: 'utf8' });

      const entry: BackupEntry = {
        id: Date.now().toString(),
        date: new Date().toISOString(),
        sizeBytes: bundle.length,
        messageCount: local.messages.length,
        encrypted: true,
      };
      const updated = [entry, ...backups].slice(0, 10);
      setBackups(updated);
      setLastBackup(entry);
      await AsyncStorage.setItem(BACKUP_KEY, JSON.stringify(updated));

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: 'application/octet-stream', dialogTitle: 'Save your encrypted backup' });
      }
      Alert.alert('Backup ready', `${entry.messageCount} messages exported (${formatBytes(entry.sizeBytes)}). Keep your passphrase safe — it’s required to restore.`);
    } catch (e: any) {
      Alert.alert('Backup failed', e?.message ?? 'Please try again.');
    } finally {
      setBackingUp(false);
    }
  };

  const doRestore = async (passphrase: string) => {
    setRestoring(true);
    try {
      const pick = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
      if (pick.canceled) { setRestoring(false); return; }
      const raw = await FileSystem.readAsStringAsync(pick.assets[0].uri, { encoding: 'utf8' });
      const json = vaultDecrypt(passphrase, JSON.parse(raw));
      const data = JSON.parse(json);
      if (data.asyncStorage) {
        const entries = Object.entries(data.asyncStorage).filter(([, v]) => v != null) as [string, string][];
        if (entries.length) await AsyncStorage.multiSet(entries);
      }
      const n = await importAll({ messages: data.messages, chats: data.chats });
      Alert.alert('Restore complete', `${n} messages restored. Restart the app to see them.`);
    } catch {
      Alert.alert('Restore failed', 'Wrong passphrase or invalid backup file.');
    } finally {
      setRestoring(false);
    }
  };

  const submitPass = () => {
    const p = passInput;
    const mode = passModal;
    setPassModal(null); setPassInput('');
    if (!p || p.length < 4) { Alert.alert('Passphrase too short', 'Use at least 4 characters.'); return; }
    if (mode === 'backup') doBackup(p); else if (mode === 'restore') doRestore(p);
  };

  const RadioRow = ({ label, value, current, onPress }: any) => (
    <TouchableOpacity style={s.radioRow} onPress={() => onPress(value)} activeOpacity={0.7}>
      <View style={[s.radioOuter, current === value && s.radioOuterActive]}>
        {current === value && <View style={s.radioInner} />}
      </View>
      <Text style={s.radioLabel}>{label}</Text>
    </TouchableOpacity>
  );

  if (loading) {
    return (
      <View style={s.loadingWrap}>
        <Stack.Screen options={{ headerShown: false }} />
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={s.root}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />

      <LinearGradient colors={['#F9FAFB', colors.bg]} style={s.header}>
        <View style={[s.headerRow, { marginTop: TOP }]}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={16}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={s.headerTitle}>Chat Backup</Text>
          <View style={{ width: 24 }} />
        </View>
      </LinearGradient>

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} showsVerticalScrollIndicator={false}>

        {/* ── Backup Status Card ──────────────────────── */}
        <LinearGradient colors={['#0F2847', '#F9FAFB']} style={s.card}>
          <View style={s.statusRow}>
            <View style={[s.statusIcon, { backgroundColor: lastBackup ? colors.primary + '20' : '#FF9F43' + '20' }]}>
              <Ionicons name={lastBackup ? 'cloud-done' : 'cloud-offline'} size={28}
                color={lastBackup ? colors.primary : '#FF9F43'} />
            </View>
            <View style={{ flex: 1, marginLeft: 14 }}>
              <Text style={s.statusTitle}>
                {lastBackup ? 'Backup Active' : 'No Backup Found'}
              </Text>
              {lastBackup && (
                <>
                  <Text style={s.statusSub}>Last: {formatDate(lastBackup.date)}</Text>
                  <Text style={s.statusSub}>Size: {formatBytes(lastBackup.sizeBytes)}</Text>
                </>
              )}
            </View>
          </View>

          {/* Encryption badge */}
          <View style={s.encryptBadge}>
            <Ionicons name="shield-checkmark" size={16} color={colors.primary} />
            <Text style={s.encryptText}>Protected with AES-256-GCM encryption</Text>
          </View>
        </LinearGradient>

        {/* ── Backup Now ─────────────────────────────── */}
        <LinearGradient colors={['#0F2847', '#F9FAFB']} style={s.card}>
          <Text style={s.cardTitle}>Backup Now</Text>
          <Text style={s.cardDesc}>Exports your messages, chats and settings to an encrypted file you save yourself.</Text>

          <TouchableOpacity
            style={[s.primaryBtn, backingUp && s.btnDisabled]}
            onPress={() => setPassModal('backup')}
            disabled={backingUp}
            activeOpacity={0.7}
          >
            {backingUp ? (
              <ActivityIndicator size="small" color={colors.text} />
            ) : (
              <>
                <Ionicons name="cloud-upload-outline" size={20} color={colors.text} />
                <Text style={s.primaryBtnText}>Backup Now</Text>
              </>
            )}
          </TouchableOpacity>
        </LinearGradient>

        {/* ── Backup Settings ────────────────────────── */}
        <LinearGradient colors={['#0F2847', '#F9FAFB']} style={s.card}>
          <Text style={s.cardTitle}>Backup Settings</Text>

          <Text style={s.sectionLabel}>Backup Frequency</Text>
          <RadioRow label="Daily" value="daily" current={settings.frequency}
            onPress={(v: string) => saveSetting({ ...settings, frequency: v })} />
          <RadioRow label="Weekly" value="weekly" current={settings.frequency}
            onPress={(v: string) => saveSetting({ ...settings, frequency: v })} />
          <RadioRow label="Monthly" value="monthly" current={settings.frequency}
            onPress={(v: string) => saveSetting({ ...settings, frequency: v })} />
          <RadioRow label="Manual Only" value="manual" current={settings.frequency}
            onPress={(v: string) => saveSetting({ ...settings, frequency: v })} />

          <View style={s.divider} />

          <View style={s.toggleRow}>
            <Ionicons name="videocam-outline" size={18} color={colors.textDim} />
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={s.toggleLabel}>Include Videos</Text>
              <Text style={s.toggleSub}>Increases backup size significantly</Text>
            </View>
            <Switch
              value={settings.includeVideos}
              onValueChange={(v) => saveSetting({ ...settings, includeVideos: v })}
              trackColor={{ false: '#1A2A44', true: colors.accent }}
              thumbColor={settings.includeVideos ? colors.text : '#6B7280'}
            />
          </View>
        </LinearGradient>

        {/* ── Restore ────────────────────────────────── */}
        <LinearGradient colors={['#0F2847', '#F9FAFB']} style={s.card}>
          <Text style={s.cardTitle}>Restore</Text>
          <Text style={s.cardDesc}>Restore your messages and media from a previous backup.</Text>

          {restoring ? (
            <View style={s.restoringWrap}>
              <ActivityIndicator size="small" color={colors.accent} />
              <Text style={s.restoringText}>Restoring backup...</Text>
            </View>
          ) : (
            <TouchableOpacity
              style={s.restoreBtn}
              onPress={() => setPassModal('restore')}
              activeOpacity={0.7}
            >
              <Ionicons name="cloud-download-outline" size={20} color={colors.accent} />
              <Text style={s.restoreBtnText}>Restore from Backup</Text>
            </TouchableOpacity>
          )}
        </LinearGradient>

        {/* ── Backup History ─────────────────────────── */}
        {backups.length > 0 && (
          <LinearGradient colors={['#0F2847', '#F9FAFB']} style={s.card}>
            <Text style={s.cardTitle}>Backup History</Text>
            {backups.map((b, i) => (
              <TouchableOpacity key={b.id} style={s.historyRow} onPress={() => setPassModal('restore')} activeOpacity={0.7}>
                <View style={s.historyIcon}>
                  <Ionicons name="time-outline" size={18} color={colors.accent} />
                </View>
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={s.historyDate}>{formatDate(b.date)}</Text>
                  <Text style={s.historySub}>{b.messageCount} messages</Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={s.historySize}>{formatBytes(b.sizeBytes)}</Text>
                  <View style={s.encryptSmall}>
                    <Ionicons name="lock-closed" size={10} color={colors.primary} />
                    <Text style={s.encryptSmallText}>Encrypted</Text>
                  </View>
                </View>
              </TouchableOpacity>
            ))}
          </LinearGradient>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>

      <Modal visible={!!passModal} transparent animationType="fade" onRequestClose={() => setPassModal(null)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', padding: 24 }}>
          <View style={{ backgroundColor: '#0F2847', borderRadius: 18, padding: 22, borderWidth: 1, borderColor: '#112240' }}>
            <Text style={{ color: colors.text, fontSize: 17, fontWeight: '700', marginBottom: 6 }}>{passModal === 'backup' ? 'Encrypt backup' : 'Restore backup'}</Text>
            <Text style={{ color: colors.textDim, fontSize: 12, marginBottom: 16, lineHeight: 17 }}>{passModal === 'backup' ? 'Choose a passphrase to encrypt your backup file. You’ll need it to restore.' : 'Enter the passphrase the backup was created with, then pick the .vcbak file.'}</Text>
            <TextInput value={passInput} onChangeText={setPassInput} placeholder="Passphrase" placeholderTextColor={colors.textDim} secureTextEntry autoFocus style={{ backgroundColor: '#0A1A30', borderRadius: 12, padding: 14, color: colors.text, fontSize: 15, borderWidth: 1, borderColor: '#112240', marginBottom: 14 }} />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity onPress={() => { setPassModal(null); setPassInput(''); }} style={{ flex: 1, paddingVertical: 13, alignItems: 'center', borderRadius: 12, borderWidth: 1, borderColor: '#112240' }}><Text style={{ color: colors.textDim, fontWeight: '700' }}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity onPress={submitPass} style={{ flex: 1, paddingVertical: 13, alignItems: 'center', borderRadius: 12, backgroundColor: colors.accent }}><Text style={{ color: colors.text, fontWeight: '800' }}>{passModal === 'backup' ? 'Export' : 'Pick file'}</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg },
  loadingWrap: { flex: 1, backgroundColor: c.bg, justifyContent: 'center', alignItems: 'center' },
  header: { paddingBottom: 16, paddingHorizontal: 20 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerTitle: { color: c.text, fontSize: 20, fontWeight: '700' },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 40 },

  card: { borderRadius: 16, padding: 20, marginBottom: 16, borderWidth: 1, borderColor: '#112240' },
  cardTitle: { color: c.text, fontSize: 17, fontWeight: '700', marginBottom: 6 },
  cardDesc: { color: c.textDim, fontSize: 13, marginBottom: 16, lineHeight: 18 },

  statusRow: { flexDirection: 'row', alignItems: 'center' },
  statusIcon: { width: 52, height: 52, borderRadius: 26, justifyContent: 'center', alignItems: 'center' },
  statusTitle: { color: c.text, fontSize: 16, fontWeight: '700' },
  statusSub: { color: c.textDim, fontSize: 13, marginTop: 2 },

  encryptBadge: { flexDirection: 'row', alignItems: 'center', marginTop: 16, paddingTop: 14, borderTopWidth: 1, borderTopColor: '#112240' },
  encryptText: { color: c.primary, fontSize: 12, marginLeft: 8, fontWeight: '600' },

  progressWrap: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  progressBg: { flex: 1, height: 8, borderRadius: 4, backgroundColor: '#1A2A44', overflow: 'hidden' },
  progressFill: { height: 8, borderRadius: 4, backgroundColor: c.accent },
  progressText: { color: c.accent, fontSize: 13, fontWeight: '700', marginLeft: 10, width: 40 },

  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.accent, borderRadius: 12, paddingVertical: 14, gap: 8,
  },
  primaryBtnText: { color: c.text, fontSize: 16, fontWeight: '700' },
  btnDisabled: { opacity: 0.6 },

  restoreBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: c.accent, borderRadius: 12, paddingVertical: 14, gap: 8,
  },
  restoreBtnText: { color: c.accent, fontSize: 16, fontWeight: '700' },

  restoringWrap: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 14, gap: 10 },
  restoringText: { color: c.accent, fontSize: 14 },

  sectionLabel: { color: c.textDim, fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1, marginTop: 10, marginBottom: 8 },

  radioRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  radioOuter: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: c.textDim, justifyContent: 'center', alignItems: 'center' },
  radioOuterActive: { borderColor: c.accent },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: c.accent },
  radioLabel: { color: c.text, fontSize: 14, marginLeft: 10 },

  toggleRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  toggleLabel: { color: c.text, fontSize: 14 },
  toggleSub: { color: c.textDim, fontSize: 12, marginTop: 2 },

  divider: { height: 1, backgroundColor: '#112240', marginVertical: 8 },

  historyRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#112240' },
  historyIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: c.accent + '15', justifyContent: 'center', alignItems: 'center' },
  historyDate: { color: c.text, fontSize: 14, fontWeight: '600' },
  historySub: { color: c.textDim, fontSize: 12, marginTop: 2 },
  historySize: { color: c.accent, fontSize: 13, fontWeight: '600' },
  encryptSmall: { flexDirection: 'row', alignItems: 'center', marginTop: 2, gap: 3 },
  encryptSmallText: { color: c.primary, fontSize: 10 },
});
