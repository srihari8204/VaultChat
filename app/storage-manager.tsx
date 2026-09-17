// app/storage-manager.tsx — Storage Manager (real on-disk usage).
//
// Walks every root the app writes to (lib/storageRoots.measuredRoots) and sums
// real file sizes, bucketed by type. Free space comes from the OS. "Clear cache"
// really deletes cached files; "Delete old media" deletes cache files older than
// N days by their real modification time. No fabricated sizes, no hardcoded chat
// list, and no auto-download/quality toggles that nothing enforced.
//
// The roots come from the shared authority rather than being listed here. This
// screen used to hardcode document+cache, which silently excluded the media tree
// (then on external storage) — so it under-reported usage and offered no way to
// delete the files that actually took up the space (audit F-6).

import React, { useState, useEffect, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Platform, Alert, ActivityIndicator } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { Stack, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { getAttachmentChatMap } from '../lib/localDb';
import { listChats } from '../lib/chatService';
import { measuredRoots, purgeMedia, toUri } from '../lib/storageRoots';
import { AuroraBackground } from '../components/ui';
import { HEADER_TOP } from '../constants/layout';

type ChatStore = { id: string; name: string; size: number };

// Was: StatusBar.currentHeight on Android, a hardcoded 44 elsewhere, read
// ONCE at module scope. currentHeight ignores display cutouts, the 44 is a
// guess, and the module read froze whichever it picked for the life of the
// process. HEADER_TOP is the live binding and is applied at the element
// below, so it follows a rotation like every other screen (2026-09-17).

type Category = { label: string; size: number; color: string; icon: string };

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 1) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

const EXT = {
  img: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp'],
  vid: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'],
  aud: ['m4a', 'mp3', 'wav', 'aac', 'ogg', 'opus'],
  file: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'zip', 'enc'],
};

// Recursively walk a directory, accumulating bytes per bucket. Optionally delete
// files older than `olderThan` (epoch seconds) instead of measuring.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function walk(
  dir: string,
  acc: Record<string, number>,
  olderThan?: number,
  perChat?: { map: Record<string, string>; sizes: Record<string, number> },
): Promise<void> {
  let names: string[] = [];
  try { names = await FileSystem.readDirectoryAsync(dir); } catch { return; }
  for (const name of names) {
    const uri = dir + (dir.endsWith('/') ? '' : '/') + name;
    let info: any;
    try { info = await FileSystem.getInfoAsync(uri); } catch { continue; }
    if (!info?.exists) continue;
    if (info.isDirectory) { await walk(uri, acc, olderThan, perChat); continue; }
    if (olderThan != null) {
      if (info.modificationTime && info.modificationTime < olderThan) {
        await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      }
      continue;
    }
    const size = info.size ?? 0;
    const ext = name.toLowerCase().split('.').pop() || '';
    if (EXT.img.includes(ext)) acc.img += size;
    else if (EXT.vid.includes(ext)) acc.vid += size;
    else if (EXT.aud.includes(ext)) acc.aud += size;
    else if (EXT.file.includes(ext)) acc.file += size;
    else acc.other += size;
    // Attribute media files (named by attachment id) to their chat.
    if (perChat) {
      const m = name.match(UUID_RE);
      if (m) { const cid = perChat.map[m[0]]; if (cid) perChat.sizes[cid] = (perChat.sizes[cid] || 0) + size; }
    }
  }
}

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function StorageManagerScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [totalUsed, setTotalUsed] = useState(0);
  const [freeSpace, setFreeSpace] = useState(0);
  const [categories, setCategories] = useState<Category[]>([]);
  const [chatStores, setChatStores] = useState<ChatStore[]>([]);

  useEffect(() => { loadStorageData(); }, []);

  const loadStorageData = async () => {
    setLoading(true);
    try {
      const acc: Record<string, number> = { img: 0, vid: 0, aud: 0, file: 0, other: 0 };
      const attMap = await getAttachmentChatMap().catch(() => ({} as Record<string, string>));
      const perChat = { map: attMap, sizes: {} as Record<string, number> };
      for (const root of measuredRoots()) await walk(toUri(root), acc, undefined, perChat);

      // Rank chats by how much media they hold (WhatsApp "Manage storage").
      try {
        const chats = await listChats();
        const nameById = new Map(chats.map(c => [c.id, c.type === 'direct' ? (c.peerName || 'Direct chat') : (c.name || 'Group')]));
        const ranked = Object.entries(perChat.sizes)
          .map(([id, size]) => ({ id, size, name: nameById.get(id) || 'Chat' }))
          .filter(c => c.size > 0)
          .sort((a, b) => b.size - a.size)
          .slice(0, 12);
        setChatStores(ranked);
      } catch { setChatStores([]); }

      // App key/value data (AsyncStorage) counts toward "Other".
      try {
        const keys = await AsyncStorage.getAllKeys();
        const pairs = await AsyncStorage.multiGet(keys);
        for (const [k, v] of pairs) acc.other += (k?.length ?? 0) + (v?.length ?? 0);
      } catch {}

      const total = acc.img + acc.vid + acc.aud + acc.file + acc.other;
      setCategories([
        { label: 'Images', size: acc.img, color: colors.primary, icon: 'image-outline' },
        { label: 'Videos', size: acc.vid, color: colors.accent, icon: 'videocam-outline' },
        { label: 'Audio', size: acc.aud, color: colors.purple, icon: 'musical-notes-outline' },
        { label: 'Files', size: acc.file, color: '#FF9F43', icon: 'document-outline' },
        { label: 'Other', size: acc.other, color: colors.textDim, icon: 'ellipsis-horizontal-outline' },
      ]);
      setTotalUsed(total);

      try { setFreeSpace(await FileSystem.getFreeDiskStorageAsync()); } catch { setFreeSpace(0); }
    } catch {
      /* leave zeros */
    } finally {
      setLoading(false);
    }
  };

  const clearCache = () => {
    Alert.alert(
      'Clear Cache',
      'This deletes temporary files only — decrypted previews and interrupted uploads. Your messages and downloaded media stay on this device. To remove those, use “Delete all media” above.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear', style: 'destructive', onPress: async () => {
            setClearing(true);
            try {
              const dir = FileSystem.cacheDirectory;
              if (dir) {
                const names = await FileSystem.readDirectoryAsync(dir).catch(() => [] as string[]);
                for (const n of names) {
                  await FileSystem.deleteAsync(dir + n, { idempotent: true }).catch(() => {});
                }
              }
              Alert.alert('Done', 'Cache cleared.');
              await loadStorageData();
            } catch {
              Alert.alert('Error', 'Failed to clear cache.');
            } finally {
              setClearing(false);
            }
          },
        },
      ],
    );
  };

  // The counterpart to "Clear Cache": this removes the media the app actually
  // keeps — downloaded photos/videos/files, thumbnails and local .vcbak backups.
  // Before this existed there was no in-app way to delete any of it (audit F-6).
  const deleteAllMedia = () => {
    Alert.alert(
      'Delete all media?',
      'Removes every photo, video, voice note and document this app has downloaded or sent from this device. Messages stay. Media the server still holds re-downloads when you open a chat; older media is gone for good.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive', onPress: async () => {
            setClearing(true);
            try {
              const n = await purgeMedia();
              Alert.alert('Done', n > 0 ? `Removed ${n} file${n === 1 ? '' : 's'}.` : 'No media files to remove.');
              await loadStorageData();
            } catch {
              Alert.alert('Error', 'Failed to delete media.');
            } finally {
              setClearing(false);
            }
          },
        },
      ],
    );
  };

  const deleteOldMedia = (days: number) => {
    Alert.alert(
      'Delete Old Cached Media',
      `Delete cached files older than ${days} days? Saved media in chats is not affected.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive', onPress: async () => {
            setClearing(true);
            try {
              const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
              if (FileSystem.cacheDirectory) await walk(FileSystem.cacheDirectory, {}, cutoff);
              Alert.alert('Done', `Removed cached files older than ${days} days.`);
              await loadStorageData();
            } catch {
              Alert.alert('Error', 'Failed to delete old media.');
            } finally {
              setClearing(false);
            }
          },
        },
      ],
    );
  };

  const maxCatSize = Math.max(...categories.map(c => c.size), 1);

  if (loading) {
    return (
      <View style={s.loadingWrap}>
        <Stack.Screen options={{ headerShown: false }} />
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={{ color: colors.textDim, marginTop: 12 }}>Measuring storage…</Text>
      </View>
    );
  }

  return (
    <View style={s.root}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />

      <LinearGradient colors={['#F9FAFB', colors.bg]} style={s.header}>
        <View style={[s.headerRow, { marginTop: HEADER_TOP }]}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} hitSlop={16}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={s.headerTitle}>Storage Manager</Text>
          <View style={{ width: 24 }} />
        </View>
      </LinearGradient>

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} showsVerticalScrollIndicator={false}>

        {/* Total */}
        <LinearGradient colors={['#0F2847', '#F9FAFB']} style={s.card}>
          <View style={s.storageHeader}>
            <Ionicons name="pie-chart-outline" size={28} color={colors.accent} />
            <View style={{ marginLeft: 12, flex: 1 }}>
              <Text style={s.cardTitle}>crazzychat Storage Used</Text>
              <Text style={s.storageBig}>{formatBytes(totalUsed)}</Text>
            </View>
          </View>
          {freeSpace > 0 && (
            <View style={s.freeRow}>
              <Ionicons name="cloud-done-outline" size={16} color={colors.primary} />
              <Text style={s.freeText}>{formatBytes(freeSpace)} free on device</Text>
            </View>
          )}
        </LinearGradient>

        {/* Breakdown */}
        <LinearGradient colors={['#0F2847', '#F9FAFB']} style={s.card}>
          <Text style={s.cardTitle}>Storage Breakdown</Text>
          {totalUsed === 0 ? (
            <Text style={{ color: colors.textDim, fontSize: 13 }}>No app files on disk yet.</Text>
          ) : categories.map((cat, i) => (
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

        {/* Per-chat (WhatsApp "Manage storage") */}
        {chatStores.length > 0 && (
          <LinearGradient colors={['#0F2847', '#F9FAFB']} style={s.card}>
            <Text style={s.cardTitle}>Storage by Chat</Text>
            {chatStores.map(c => (
              <TouchableOpacity key={c.id} style={s.catRow} activeOpacity={0.7}
                onPress={() => router.push({ pathname: '/chat', params: { id: c.id } } as any)}>
                <View style={s.catInfo}>
                  <Ionicons name="chatbubble-ellipses-outline" size={18} color={colors.primary} />
                  <Text style={s.catLabel} numberOfLines={1}>{c.name}</Text>
                  <Text style={s.catSize}>{formatBytes(c.size)}</Text>
                </View>
                <View style={s.barBg}>
                  <View style={[s.barFill, { width: `${(c.size / chatStores[0].size) * 100}%`, backgroundColor: colors.primary }]} />
                </View>
              </TouchableOpacity>
            ))}
          </LinearGradient>
        )}

        {/* Media */}
        <LinearGradient colors={['#0F2847', '#F9FAFB']} style={s.card}>
          <Text style={s.cardTitle}>Media on this device</Text>
          <Text style={s.cardNote}>
            Downloaded and sent media is stored privately in the app and is removed when
            crazzychat is uninstalled. Use “Save to gallery” on a photo to keep your own copy.
          </Text>

          <TouchableOpacity style={s.actionBtn} onPress={deleteAllMedia} disabled={clearing} activeOpacity={0.7}>
            <Ionicons name="images-outline" size={20} color={colors.danger} />
            <Text style={[s.actionText, { color: colors.danger }]}>
              {clearing ? 'Working…' : 'Delete all media'}
            </Text>
          </TouchableOpacity>
        </LinearGradient>

        {/* Cache */}
        <LinearGradient colors={['#0F2847', '#F9FAFB']} style={s.card}>
          <Text style={s.cardTitle}>Cache Management</Text>

          <TouchableOpacity style={s.actionBtn} onPress={() => router.push('/cache-cleanup' as any)} activeOpacity={0.7}>
            <Ionicons name="sparkles-outline" size={20} color={colors.primary} />
            <Text style={[s.actionText, { color: colors.primary }]}>Cache cleanup — by category, Smart &amp; auto</Text>
          </TouchableOpacity>

          <TouchableOpacity style={s.actionBtn} onPress={clearCache} disabled={clearing} activeOpacity={0.7}>
            <Ionicons name="trash-outline" size={20} color={colors.danger} />
            <Text style={[s.actionText, { color: colors.danger }]}>
              {clearing ? 'Working…' : 'Clear Cache'}
            </Text>
          </TouchableOpacity>

          <Text style={s.sectionLabel}>Delete Old Cached Media</Text>
          <View style={s.daysRow}>
            {[30, 60, 90].map(d => (
              <TouchableOpacity
                key={d}
                style={s.dayBtn}
                onPress={() => deleteOldMedia(d)}
                disabled={clearing}
                activeOpacity={0.7}
              >
                <Text style={s.dayBtnText}>{d} days</Text>
              </TouchableOpacity>
            ))}
          </View>
        </LinearGradient>

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  loadingWrap: { flex: 1, backgroundColor: c.bg, justifyContent: 'center', alignItems: 'center' },
  header: { paddingBottom: 16, paddingHorizontal: 20 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerTitle: { color: c.text, fontSize: 20, fontWeight: '700' },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 40 },

  card: { borderRadius: 16, padding: 20, marginBottom: 16, borderWidth: 1, borderColor: '#112240' },
  cardTitle: { color: c.text, fontSize: 17, fontWeight: '700', marginBottom: 16 },

  storageHeader: { flexDirection: 'row', alignItems: 'center' },
  storageBig: { color: c.accent, fontSize: 28, fontWeight: '800', marginTop: 2 },
  freeRow: { flexDirection: 'row', alignItems: 'center', marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: '#112240' },
  freeText: { color: c.primary, fontSize: 13, marginLeft: 8 },

  catRow: { marginBottom: 14 },
  catInfo: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  catLabel: { color: c.text, fontSize: 14, marginLeft: 8, flex: 1 },
  catSize: { color: c.textDim, fontSize: 13 },
  barBg: { height: 8, borderRadius: 4, backgroundColor: c.surfaceSolid, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4 },

  actionBtn: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#112240' },
  actionText: { fontSize: 15, fontWeight: '600', marginLeft: 10 },

  cardNote:     { color: c.textDim, fontSize: 12, lineHeight: 17, marginTop: 8 },
  sectionLabel: { color: c.textDim, fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1, marginTop: 14, marginBottom: 10 },
  daysRow: { flexDirection: 'row', gap: 10 },
  dayBtn: { flex: 1, paddingVertical: 10, borderRadius: 10, backgroundColor: c.surfaceSolid, alignItems: 'center' },
  dayBtnText: { color: c.textDim, fontSize: 13, fontWeight: '600' },
});
