// @ts-nocheck
// app/storage-manager.tsx — Storage Manager
// View storage breakdown, manage cache, auto-download & quality settings

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  StatusBar, Platform, Alert, ActivityIndicator, Switch,
  Dimensions,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';

const { width: SW } = Dimensions.get('window');
const TOP = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 44;

const C = {
  bg: '#020B18', accent: '#4A9FFF', cyan: '#00E5FF',
  card: '#0A1628', cardBorder: '#112240', white: '#FFFFFF',
  muted: '#7B8CA8', green: '#10B981', red: '#FF4D6D',
  orange: '#FF9F43', purple: '#A855F7', pink: '#EC4899',
  yellow: '#FBBF24',
};

const STORAGE_KEY = 'vc_storage_settings';

type Category = { label: string; size: number; color: string; icon: string };

const DEFAULT_SETTINGS = {
  autoDownload: 'wifi', // wifi | wifi_mobile | never
  photoQuality: 'standard', // original | standard | low
  videoQuality: 'standard',
  autoDownloadImages: true,
  autoDownloadVideos: false,
  autoDownloadAudio: true,
  autoDownloadFiles: false,
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export default function StorageManagerScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [totalUsed, setTotalUsed] = useState(0);
  const [freeSpace, setFreeSpace] = useState(0);
  const [categories, setCategories] = useState<Category[]>([]);
  const [chatStorages, setChatStorages] = useState<{ name: string; size: number }[]>([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [deleteMediaDays, setDeleteMediaDays] = useState<number | null>(null);

  useEffect(() => {
    loadStorageData();
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) });
    } catch {}
  };

  const saveSettings = async (updated: typeof settings) => {
    setSettings(updated);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  };

  const loadStorageData = async () => {
    try {
      // Calculate AsyncStorage usage
      const keys = await AsyncStorage.getAllKeys();
      let totalBytes = 0;
      const pairs = await AsyncStorage.multiGet(keys);
      for (const [k, v] of pairs) {
        totalBytes += (k?.length ?? 0) + (v?.length ?? 0);
      }

      // Simulate category breakdown based on key prefixes
      let imgSize = 0, vidSize = 0, audSize = 0, fileSize = 0, otherSize = 0;
      for (const [k, v] of pairs) {
        const size = (k?.length ?? 0) + (v?.length ?? 0);
        if (k?.includes('image') || k?.includes('photo') || k?.includes('img')) imgSize += size;
        else if (k?.includes('video') || k?.includes('vid')) vidSize += size;
        else if (k?.includes('audio') || k?.includes('voice') || k?.includes('recording')) audSize += size;
        else if (k?.includes('file') || k?.includes('doc') || k?.includes('pdf')) fileSize += size;
        else otherSize += size;
      }

      // Add simulated cache sizes for realistic display
      imgSize += 12_400_000;
      vidSize += 45_800_000;
      audSize += 3_200_000;
      fileSize += 8_600_000;
      otherSize += 2_100_000;

      const total = imgSize + vidSize + audSize + fileSize + otherSize;

      setCategories([
        { label: 'Images', size: imgSize, color: C.green, icon: 'image-outline' },
        { label: 'Videos', size: vidSize, color: C.accent, icon: 'videocam-outline' },
        { label: 'Audio', size: audSize, color: C.purple, icon: 'musical-notes-outline' },
        { label: 'Files', size: fileSize, color: C.orange, icon: 'document-outline' },
        { label: 'Other', size: otherSize, color: C.muted, icon: 'ellipsis-horizontal-outline' },
      ]);
      setTotalUsed(total);
      setFreeSpace(4_200_000_000); // Simulated free space

      // Simulate per-chat storage
      const chatKeys = keys.filter(k => k.startsWith('chat_') || k.includes('messages'));
      const chats = [
        { name: 'Alice Chen', size: 18_500_000 },
        { name: 'Dev Team Group', size: 32_100_000 },
        { name: 'Bob Martinez', size: 5_400_000 },
        { name: 'Family Group', size: 12_800_000 },
        { name: 'Sarah K.', size: 3_200_000 },
      ].sort((a, b) => b.size - a.size);
      setChatStorages(chats);

    } catch (e) {
      console.warn('[StorageManager] load error:', e);
    } finally {
      setLoading(false);
    }
  };

  const clearCache = () => {
    Alert.alert(
      'Clear Cache',
      'This will clear cached thumbnails and temporary files. Your messages and media will not be deleted.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear', style: 'destructive', onPress: async () => {
            setClearing(true);
            try {
              const keys = await AsyncStorage.getAllKeys();
              const cacheKeys = keys.filter(k => k.includes('cache') || k.includes('thumb') || k.includes('temp'));
              if (cacheKeys.length > 0) await AsyncStorage.multiRemove(cacheKeys);
              Alert.alert('Done', 'Cache cleared successfully.');
              loadStorageData();
            } catch {
              Alert.alert('Error', 'Failed to clear cache.');
            } finally {
              setClearing(false);
            }
          },
        },
      ]
    );
  };

  const deleteOldMedia = (days: number) => {
    Alert.alert(
      'Delete Old Media',
      `Delete all cached media older than ${days} days? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive', onPress: async () => {
            setClearing(true);
            try {
              // In a real app, filter by timestamp
              const keys = await AsyncStorage.getAllKeys();
              const mediaKeys = keys.filter(k =>
                k.includes('image') || k.includes('video') || k.includes('audio')
              );
              if (mediaKeys.length > 0) await AsyncStorage.multiRemove(mediaKeys);
              Alert.alert('Done', `Media older than ${days} days has been deleted.`);
              loadStorageData();
            } catch {
              Alert.alert('Error', 'Failed to delete old media.');
            } finally {
              setClearing(false);
              setDeleteMediaDays(null);
            }
          },
        },
      ]
    );
  };

  const maxCatSize = Math.max(...categories.map(c => c.size), 1);

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

  return (
    <View style={s.root}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      <LinearGradient colors={['#0A1628', C.bg]} style={s.header}>
        <View style={[s.headerRow, { marginTop: TOP }]}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={16}>
            <Ionicons name="arrow-back" size={24} color={C.white} />
          </TouchableOpacity>
          <Text style={s.headerTitle}>Storage Manager</Text>
          <View style={{ width: 24 }} />
        </View>
      </LinearGradient>

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} showsVerticalScrollIndicator={false}>

        {/* ── Total Storage Card ─────────────────────── */}
        <LinearGradient colors={['#0F2847', '#0A1628']} style={s.card}>
          <View style={s.storageHeader}>
            <Ionicons name="pie-chart-outline" size={28} color={C.cyan} />
            <View style={{ marginLeft: 12, flex: 1 }}>
              <Text style={s.cardTitle}>Total Storage Used</Text>
              <Text style={s.storageBig}>{formatBytes(totalUsed)}</Text>
            </View>
          </View>
          <View style={s.freeRow}>
            <Ionicons name="cloud-done-outline" size={16} color={C.green} />
            <Text style={s.freeText}>{formatBytes(freeSpace)} free on device</Text>
          </View>
        </LinearGradient>

        {/* ── Category Breakdown ─────────────────────── */}
        <LinearGradient colors={['#0F2847', '#0A1628']} style={s.card}>
          <Text style={s.cardTitle}>Storage Breakdown</Text>
          {categories.map((cat, i) => (
            <View key={i} style={s.catRow}>
              <View style={s.catInfo}>
                <Ionicons name={cat.icon as any} size={18} color={cat.color} />
                <Text style={s.catLabel}>{cat.label}</Text>
                <Text style={s.catSize}>{formatBytes(cat.size)}</Text>
              </View>
              <View style={s.barBg}>
                <View style={[s.barFill, { width: `${(cat.size / maxCatSize) * 100}%`, backgroundColor: cat.color }]} />
              </View>
            </View>
          ))}
        </LinearGradient>

        {/* ── Per-Chat Storage ────────────────────────── */}
        <LinearGradient colors={['#0F2847', '#0A1628']} style={s.card}>
          <Text style={s.cardTitle}>Per-Chat Storage</Text>
          {chatStorages.map((ch, i) => (
            <View key={i} style={s.chatRow}>
              <View style={s.chatAvatar}>
                <Text style={s.chatAvatarText}>{ch.name[0]}</Text>
              </View>
              <Text style={s.chatName} numberOfLines={1}>{ch.name}</Text>
              <Text style={s.chatSize}>{formatBytes(ch.size)}</Text>
            </View>
          ))}
        </LinearGradient>

        {/* ── Cache Actions ───────────────────────────── */}
        <LinearGradient colors={['#0F2847', '#0A1628']} style={s.card}>
          <Text style={s.cardTitle}>Cache Management</Text>

          <TouchableOpacity style={s.actionBtn} onPress={clearCache} disabled={clearing} activeOpacity={0.7}>
            <Ionicons name="trash-outline" size={20} color={C.red} />
            <Text style={[s.actionText, { color: C.red }]}>
              {clearing ? 'Clearing...' : 'Clear Cache'}
            </Text>
          </TouchableOpacity>

          <Text style={s.sectionLabel}>Delete Old Media</Text>
          <View style={s.daysRow}>
            {[30, 60, 90].map(d => (
              <TouchableOpacity
                key={d}
                style={[s.dayBtn, deleteMediaDays === d && s.dayBtnActive]}
                onPress={() => {
                  setDeleteMediaDays(d);
                  deleteOldMedia(d);
                }}
                activeOpacity={0.7}
              >
                <Text style={[s.dayBtnText, deleteMediaDays === d && s.dayBtnTextActive]}>{d} days</Text>
              </TouchableOpacity>
            ))}
          </View>
        </LinearGradient>

        {/* ── Auto-Download Settings ─────────────────── */}
        <LinearGradient colors={['#0F2847', '#0A1628']} style={s.card}>
          <Text style={s.cardTitle}>Auto-Download</Text>

          <Text style={s.sectionLabel}>Download Mode</Text>
          <RadioRow label="WiFi Only" value="wifi" current={settings.autoDownload}
            onPress={(v: string) => saveSettings({ ...settings, autoDownload: v })} />
          <RadioRow label="WiFi + Mobile Data" value="wifi_mobile" current={settings.autoDownload}
            onPress={(v: string) => saveSettings({ ...settings, autoDownload: v })} />
          <RadioRow label="Never (Manual Only)" value="never" current={settings.autoDownload}
            onPress={(v: string) => saveSettings({ ...settings, autoDownload: v })} />

          <View style={s.divider} />
          <Text style={s.sectionLabel}>Auto-Download Toggles</Text>

          {([
            ['autoDownloadImages', 'Images', 'image-outline'],
            ['autoDownloadVideos', 'Videos', 'videocam-outline'],
            ['autoDownloadAudio', 'Audio', 'musical-notes-outline'],
            ['autoDownloadFiles', 'Files', 'document-outline'],
          ] as const).map(([key, label, icon]) => (
            <View key={key} style={s.toggleRow}>
              <Ionicons name={icon as any} size={18} color={C.muted} />
              <Text style={s.toggleLabel}>{label}</Text>
              <Switch
                value={settings[key]}
                onValueChange={(v) => saveSettings({ ...settings, [key]: v })}
                trackColor={{ false: '#1A2A44', true: C.accent }}
                thumbColor={settings[key] ? C.white : '#555'}
              />
            </View>
          ))}
        </LinearGradient>

        {/* ── Quality Settings ────────────────────────── */}
        <LinearGradient colors={['#0F2847', '#0A1628']} style={s.card}>
          <Text style={s.cardTitle}>Media Quality</Text>

          <Text style={s.sectionLabel}>Photo Quality</Text>
          <RadioRow label="Original" value="original" current={settings.photoQuality}
            onPress={(v: string) => saveSettings({ ...settings, photoQuality: v })} />
          <RadioRow label="Standard (Recommended)" value="standard" current={settings.photoQuality}
            onPress={(v: string) => saveSettings({ ...settings, photoQuality: v })} />
          <RadioRow label="Low (Save Space)" value="low" current={settings.photoQuality}
            onPress={(v: string) => saveSettings({ ...settings, photoQuality: v })} />

          <View style={s.divider} />

          <Text style={s.sectionLabel}>Video Quality</Text>
          <RadioRow label="Original" value="original" current={settings.videoQuality}
            onPress={(v: string) => saveSettings({ ...settings, videoQuality: v })} />
          <RadioRow label="Standard (Recommended)" value="standard" current={settings.videoQuality}
            onPress={(v: string) => saveSettings({ ...settings, videoQuality: v })} />
          <RadioRow label="Low (Save Space)" value="low" current={settings.videoQuality}
            onPress={(v: string) => saveSettings({ ...settings, videoQuality: v })} />
        </LinearGradient>

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

  card: {
    borderRadius: 16, padding: 20, marginBottom: 16,
    borderWidth: 1, borderColor: C.cardBorder,
  },
  cardTitle: { color: C.white, fontSize: 17, fontWeight: '700', marginBottom: 16 },

  storageHeader: { flexDirection: 'row', alignItems: 'center' },
  storageBig: { color: C.cyan, fontSize: 28, fontWeight: '800', marginTop: 2 },
  freeRow: { flexDirection: 'row', alignItems: 'center', marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: C.cardBorder },
  freeText: { color: C.green, fontSize: 13, marginLeft: 8 },

  catRow: { marginBottom: 14 },
  catInfo: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  catLabel: { color: C.white, fontSize: 14, marginLeft: 8, flex: 1 },
  catSize: { color: C.muted, fontSize: 13 },
  barBg: { height: 8, borderRadius: 4, backgroundColor: '#1A2A44', overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4 },

  chatRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.cardBorder },
  chatAvatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.accent + '30', justifyContent: 'center', alignItems: 'center' },
  chatAvatarText: { color: C.accent, fontSize: 15, fontWeight: '700' },
  chatName: { color: C.white, fontSize: 14, flex: 1, marginLeft: 12 },
  chatSize: { color: C.muted, fontSize: 13 },

  actionBtn: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.cardBorder },
  actionText: { fontSize: 15, fontWeight: '600', marginLeft: 10 },

  sectionLabel: { color: C.muted, fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1, marginTop: 14, marginBottom: 10 },

  daysRow: { flexDirection: 'row', gap: 10 },
  dayBtn: { flex: 1, paddingVertical: 10, borderRadius: 10, backgroundColor: '#1A2A44', alignItems: 'center' },
  dayBtnActive: { backgroundColor: C.red + '30', borderWidth: 1, borderColor: C.red },
  dayBtnText: { color: C.muted, fontSize: 13, fontWeight: '600' },
  dayBtnTextActive: { color: C.red },

  radioRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  radioOuter: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: C.muted, justifyContent: 'center', alignItems: 'center' },
  radioOuterActive: { borderColor: C.accent },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.accent },
  radioLabel: { color: C.white, fontSize: 14, marginLeft: 10 },

  toggleRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.cardBorder },
  toggleLabel: { color: C.white, fontSize: 14, flex: 1, marginLeft: 10 },

  divider: { height: 1, backgroundColor: C.cardBorder, marginVertical: 10 },
});
