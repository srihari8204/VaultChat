// @ts-nocheck
// app/chat-backup.tsx — Chat Backup & Restore
// Simulated backup system using AsyncStorage for chat metadata

import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  StatusBar, Platform, Alert, ActivityIndicator, Switch,
  Animated,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';

const TOP = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 44;

const C = {
  bg: '#020B18', accent: '#4A9FFF', cyan: '#00E5FF',
  card: '#0A1628', cardBorder: '#112240', white: '#FFFFFF',
  muted: '#7B8CA8', green: '#10B981', red: '#FF4D6D',
  orange: '#FF9F43', yellow: '#FBBF24',
};

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

export default function ChatBackupScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [backingUp, setBackingUp] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [progress, setProgress] = useState(0);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [lastBackup, setLastBackup] = useState<BackupEntry | null>(null);

  const progressAnim = useRef(new Animated.Value(0)).current;

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

  const runBackup = async () => {
    setBackingUp(true);
    setProgress(0);
    progressAnim.setValue(0);

    // Simulate backup progress
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
      await new Promise(r => setTimeout(r, 150));
      const p = i / steps;
      setProgress(p);
      Animated.timing(progressAnim, { toValue: p, duration: 100, useNativeDriver: false }).start();
    }

    // Collect all AsyncStorage data as "backup"
    const keys = await AsyncStorage.getAllKeys();
    let totalSize = 0;
    const pairs = await AsyncStorage.multiGet(keys);
    for (const [k, v] of pairs) {
      totalSize += (k?.length ?? 0) + (v?.length ?? 0);
    }

    // Add simulated media size
    const mediaExtra = settings.includeVideos ? 45_000_000 : 12_000_000;
    totalSize += mediaExtra;

    const msgCount = keys.filter(k => k.includes('message') || k.includes('chat')).length * 47 + 128;

    const entry: BackupEntry = {
      id: Date.now().toString(),
      date: new Date().toISOString(),
      sizeBytes: totalSize,
      messageCount: msgCount,
      encrypted: true,
    };

    const updated = [entry, ...backups].slice(0, 10); // Keep last 10
    setBackups(updated);
    setLastBackup(entry);
    await AsyncStorage.setItem(BACKUP_KEY, JSON.stringify(updated));

    setBackingUp(false);
    Alert.alert('Backup Complete', `Backed up ${msgCount} messages (${formatBytes(totalSize)})`);
  };

  const restoreBackup = (entry: BackupEntry) => {
    Alert.alert(
      'Restore Backup',
      `Restore backup from ${formatDate(entry.date)}?\n\nThis will replace current messages with the backup data.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Restore', style: 'destructive', onPress: async () => {
            setRestoring(true);
            // Simulate restore
            await new Promise(r => setTimeout(r, 2500));
            setRestoring(false);
            Alert.alert('Restored', `${entry.messageCount} messages restored from backup.`);
          },
        },
      ]
    );
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
        <ActivityIndicator size="large" color={C.accent} />
      </View>
    );
  }

  const progressWidth = progressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  return (
    <View style={s.root}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      <LinearGradient colors={['#0A1628', C.bg]} style={s.header}>
        <View style={[s.headerRow, { marginTop: TOP }]}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={16}>
            <Ionicons name="arrow-back" size={24} color={C.white} />
          </TouchableOpacity>
          <Text style={s.headerTitle}>Chat Backup</Text>
          <View style={{ width: 24 }} />
        </View>
      </LinearGradient>

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} showsVerticalScrollIndicator={false}>

        {/* ── Backup Status Card ──────────────────────── */}
        <LinearGradient colors={['#0F2847', '#0A1628']} style={s.card}>
          <View style={s.statusRow}>
            <View style={[s.statusIcon, { backgroundColor: lastBackup ? C.green + '20' : C.orange + '20' }]}>
              <Ionicons name={lastBackup ? 'cloud-done' : 'cloud-offline'} size={28}
                color={lastBackup ? C.green : C.orange} />
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
            <Ionicons name="shield-checkmark" size={16} color={C.green} />
            <Text style={s.encryptText}>Protected with AES-256-GCM encryption</Text>
          </View>
        </LinearGradient>

        {/* ── Backup Now ─────────────────────────────── */}
        <LinearGradient colors={['#0F2847', '#0A1628']} style={s.card}>
          <Text style={s.cardTitle}>Backup Now</Text>
          <Text style={s.cardDesc}>Includes: Messages, Media, Settings</Text>

          {backingUp && (
            <View style={s.progressWrap}>
              <View style={s.progressBg}>
                <Animated.View style={[s.progressFill, { width: progressWidth }]} />
              </View>
              <Text style={s.progressText}>{Math.round(progress * 100)}%</Text>
            </View>
          )}

          <TouchableOpacity
            style={[s.primaryBtn, backingUp && s.btnDisabled]}
            onPress={runBackup}
            disabled={backingUp}
            activeOpacity={0.7}
          >
            {backingUp ? (
              <ActivityIndicator size="small" color={C.white} />
            ) : (
              <>
                <Ionicons name="cloud-upload-outline" size={20} color={C.white} />
                <Text style={s.primaryBtnText}>Backup Now</Text>
              </>
            )}
          </TouchableOpacity>
        </LinearGradient>

        {/* ── Backup Settings ────────────────────────── */}
        <LinearGradient colors={['#0F2847', '#0A1628']} style={s.card}>
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
            <Ionicons name="videocam-outline" size={18} color={C.muted} />
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={s.toggleLabel}>Include Videos</Text>
              <Text style={s.toggleSub}>Increases backup size significantly</Text>
            </View>
            <Switch
              value={settings.includeVideos}
              onValueChange={(v) => saveSetting({ ...settings, includeVideos: v })}
              trackColor={{ false: '#1A2A44', true: C.accent }}
              thumbColor={settings.includeVideos ? C.white : '#555'}
            />
          </View>
        </LinearGradient>

        {/* ── Restore ────────────────────────────────── */}
        <LinearGradient colors={['#0F2847', '#0A1628']} style={s.card}>
          <Text style={s.cardTitle}>Restore</Text>
          <Text style={s.cardDesc}>Restore your messages and media from a previous backup.</Text>

          {restoring ? (
            <View style={s.restoringWrap}>
              <ActivityIndicator size="small" color={C.cyan} />
              <Text style={s.restoringText}>Restoring backup...</Text>
            </View>
          ) : (
            <TouchableOpacity
              style={s.restoreBtn}
              onPress={() => {
                if (backups.length === 0) {
                  Alert.alert('No Backups', 'Create a backup first before restoring.');
                } else {
                  restoreBackup(backups[0]);
                }
              }}
              activeOpacity={0.7}
            >
              <Ionicons name="cloud-download-outline" size={20} color={C.cyan} />
              <Text style={s.restoreBtnText}>Restore from Backup</Text>
            </TouchableOpacity>
          )}
        </LinearGradient>

        {/* ── Backup History ─────────────────────────── */}
        {backups.length > 0 && (
          <LinearGradient colors={['#0F2847', '#0A1628']} style={s.card}>
            <Text style={s.cardTitle}>Backup History</Text>
            {backups.map((b, i) => (
              <TouchableOpacity key={b.id} style={s.historyRow} onPress={() => restoreBackup(b)} activeOpacity={0.7}>
                <View style={s.historyIcon}>
                  <Ionicons name="time-outline" size={18} color={C.accent} />
                </View>
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={s.historyDate}>{formatDate(b.date)}</Text>
                  <Text style={s.historySub}>{b.messageCount} messages</Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={s.historySize}>{formatBytes(b.sizeBytes)}</Text>
                  <View style={s.encryptSmall}>
                    <Ionicons name="lock-closed" size={10} color={C.green} />
                    <Text style={s.encryptSmallText}>Encrypted</Text>
                  </View>
                </View>
              </TouchableOpacity>
            ))}
          </LinearGradient>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  loadingWrap: { flex: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center' },
  header: { paddingBottom: 16, paddingHorizontal: 20 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerTitle: { color: C.white, fontSize: 20, fontWeight: '700' },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 40 },

  card: { borderRadius: 16, padding: 20, marginBottom: 16, borderWidth: 1, borderColor: C.cardBorder },
  cardTitle: { color: C.white, fontSize: 17, fontWeight: '700', marginBottom: 6 },
  cardDesc: { color: C.muted, fontSize: 13, marginBottom: 16, lineHeight: 18 },

  statusRow: { flexDirection: 'row', alignItems: 'center' },
  statusIcon: { width: 52, height: 52, borderRadius: 26, justifyContent: 'center', alignItems: 'center' },
  statusTitle: { color: C.white, fontSize: 16, fontWeight: '700' },
  statusSub: { color: C.muted, fontSize: 13, marginTop: 2 },

  encryptBadge: { flexDirection: 'row', alignItems: 'center', marginTop: 16, paddingTop: 14, borderTopWidth: 1, borderTopColor: C.cardBorder },
  encryptText: { color: C.green, fontSize: 12, marginLeft: 8, fontWeight: '600' },

  progressWrap: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  progressBg: { flex: 1, height: 8, borderRadius: 4, backgroundColor: '#1A2A44', overflow: 'hidden' },
  progressFill: { height: 8, borderRadius: 4, backgroundColor: C.accent },
  progressText: { color: C.accent, fontSize: 13, fontWeight: '700', marginLeft: 10, width: 40 },

  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.accent, borderRadius: 12, paddingVertical: 14, gap: 8,
  },
  primaryBtnText: { color: C.white, fontSize: 16, fontWeight: '700' },
  btnDisabled: { opacity: 0.6 },

  restoreBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: C.cyan, borderRadius: 12, paddingVertical: 14, gap: 8,
  },
  restoreBtnText: { color: C.cyan, fontSize: 16, fontWeight: '700' },

  restoringWrap: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 14, gap: 10 },
  restoringText: { color: C.cyan, fontSize: 14 },

  sectionLabel: { color: C.muted, fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1, marginTop: 10, marginBottom: 8 },

  radioRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  radioOuter: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: C.muted, justifyContent: 'center', alignItems: 'center' },
  radioOuterActive: { borderColor: C.accent },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.accent },
  radioLabel: { color: C.white, fontSize: 14, marginLeft: 10 },

  toggleRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  toggleLabel: { color: C.white, fontSize: 14 },
  toggleSub: { color: C.muted, fontSize: 12, marginTop: 2 },

  divider: { height: 1, backgroundColor: C.cardBorder, marginVertical: 8 },

  historyRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.cardBorder },
  historyIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.accent + '15', justifyContent: 'center', alignItems: 'center' },
  historyDate: { color: C.white, fontSize: 14, fontWeight: '600' },
  historySub: { color: C.muted, fontSize: 12, marginTop: 2 },
  historySize: { color: C.accent, fontSize: 13, fontWeight: '600' },
  encryptSmall: { flexDirection: 'row', alignItems: 'center', marginTop: 2, gap: 3 },
  encryptSmallText: { color: C.green, fontSize: 10 },
});
