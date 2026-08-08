// app/shelf.tsx — The Bookshelf: every file shared in any chat, in one place.
//
// Design: docs/design/screens/17-bookshelf (mobile m17-shelf).
//
// The index comes from the LOCAL message cache (localDb.listAllAttachments), so
// the shelf opens instantly, works offline, and needs no server support. It is
// exactly as complete as the cache — which is the honest behaviour, and why the
// empty state says so rather than pretending the account has no files.
//
// Pins live in the localDb kv table, not on the server: "keep this at the top of
// my shelf" is a per-device view preference, not shared state.

import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator, FlatList, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../lib/theme';
import { type Palette, brandAlpha } from '../constants/theme';
import { getMeta, listAllAttachments, setMeta } from '../lib/localDb';
import {
  classify, countsByKind, formatSize, queryShelf,
  type ShelfFile, type ShelfKind, type ShelfSort,
} from '../lib/shelf';

const PINS_KEY = 'vc_shelf_pins_v1';

const KIND_ICON: Record<ShelfKind, any> = {
  document: 'document-text-outline',
  image: 'image-outline',
  video: 'videocam-outline',
  audio: 'musical-notes-outline',
  archive: 'file-tray-full-outline',
  code: 'code-slash-outline',
  other: 'attach-outline',
};

const CHIPS: { id: ShelfKind | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'document', label: 'Docs' },
  { id: 'image', label: 'Photos' },
  { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Audio' },
  { id: 'archive', label: 'Archives' },
  { id: 'code', label: 'Code' },
];

const SORTS: { id: ShelfSort; label: string }[] = [
  { id: 'recent', label: 'Last shared' },
  { id: 'name', label: 'Name' },
  { id: 'size', label: 'Size' },
];

export default function ShelfScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const S = useMemo(() => makeStyles(colors), [colors]);

  const [files, setFiles] = useState<ShelfFile[]>([]);
  const [pins, setPins] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<ShelfKind | 'all'>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<ShelfSort>('recent');

  const load = useCallback(async () => {
    try {
      const [rows, pinRaw] = await Promise.all([listAllAttachments(), getMeta(PINS_KEY)]);
      const pinned = new Set<string>(pinRaw ? JSON.parse(pinRaw) : []);
      setPins(pinned);
      setFiles(rows.map(r => ({
        ...r,
        kind: classify(r.filename, r.mime),
        pinned: pinned.has(r.attachmentId),
      })));
    } catch { /* an unreadable cache shows the empty state, not a crash */ }
    finally { setLoading(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const togglePin = useCallback(async (id: string) => {
    const next = new Set(pins);
    next.has(id) ? next.delete(id) : next.add(id);
    setPins(next);
    setFiles(fs => fs.map(f => (f.attachmentId === id ? { ...f, pinned: next.has(id) } : f)));
    await setMeta(PINS_KEY, JSON.stringify([...next])).catch(() => {});
  }, [pins]);

  const counts = useMemo(() => countsByKind(files), [files]);
  const shown = useMemo(() => queryShelf(files, { kind, search, sort }), [files, kind, search, sort]);

  const open = useCallback((f: ShelfFile) => {
    // Reuse the viewers that already exist rather than adding a third one.
    // media-viewer routes archives on to app/archive-viewer itself.
    router.push({
      pathname: '/media-viewer',
      params: {
        attachmentId: f.attachmentId, filename: f.filename, mime: f.mime ?? '',
        msgType: f.kind === 'image' ? 'image' : f.kind === 'video' ? 'video' : f.kind === 'audio' ? 'audio' : 'file',
        chatId: f.chatId,
      },
    } as any);
  }, [router]);

  return (
    <View style={[S.screen, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={S.head}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.title}>Shelf</Text>
        <Text style={S.subtitle}>{counts.all} file{counts.all === 1 ? '' : 's'}</Text>
      </View>

      <View style={S.searchWrap}>
        <Ionicons name="search" size={16} color={colors.textDim} />
        <TextInput
          style={S.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Filter this shelf"
          placeholderTextColor={colors.textFaint}
          autoCorrect={false}
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => setSearch('')} hitSlop={10}>
            <Ionicons name="close-circle" size={16} color={colors.textDim} />
          </TouchableOpacity>
        )}
      </View>

      <FlatList
        horizontal
        data={CHIPS}
        keyExtractor={c => c.id}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={S.chipRow}
        renderItem={({ item }) => {
          const n = counts[item.id];
          const on = kind === item.id;
          return (
            <TouchableOpacity onPress={() => setKind(item.id)} style={[S.chip, on && S.chipOn]} activeOpacity={0.8}>
              <Text style={[S.chipTxt, on && S.chipTxtOn]}>{item.label}</Text>
              <Text style={[S.chipCount, on && S.chipTxtOn]}>{n}</Text>
            </TouchableOpacity>
          );
        }}
      />

      <View style={S.sortRow}>
        {SORTS.map(s => (
          <TouchableOpacity key={s.id} onPress={() => setSort(s.id)} hitSlop={6}>
            <Text style={[S.sortTxt, sort === s.id && S.sortTxtOn]}>{s.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={shown}
          keyExtractor={f => f.attachmentId}
          contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
          ListEmptyComponent={
            <View style={S.empty}>
              <Ionicons name="folder-open-outline" size={44} color={colors.textDim} />
              <Text style={S.emptyTitle}>
                {files.length === 0 ? 'No files on this device yet' : 'Nothing matches'}
              </Text>
              <Text style={S.emptyBody}>
                {files.length === 0
                  ? 'The shelf is built from chats cached on this device, so files appear here as you open the chats that contain them.'
                  : 'Try a different filter or search.'}
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity style={S.row} activeOpacity={0.75} onPress={() => open(item)}>
              <View style={S.rowIcon}>
                <Ionicons name={KIND_ICON[item.kind]} size={20} color={colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={S.rowName} numberOfLines={1}>{item.filename}</Text>
                <Text style={S.rowMeta} numberOfLines={1}>
                  {[formatSize(item.size), item.createdAt ? new Date(item.createdAt).toLocaleDateString() : '']
                    .filter(Boolean).join(' · ')}
                </Text>
              </View>
              <TouchableOpacity onPress={() => togglePin(item.attachmentId)} hitSlop={12}>
                <Ionicons
                  name={item.pinned ? 'pin' : 'pin-outline'}
                  size={18}
                  color={item.pinned ? colors.primary : colors.textDim}
                />
              </TouchableOpacity>
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  title: { color: c.text, fontSize: 22, fontWeight: '800' },
  subtitle: { color: c.textDim, fontSize: 12, marginLeft: 'auto' },
  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16,
    paddingHorizontal: 12, height: 40, borderRadius: 12,
    backgroundColor: c.card, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
  },
  searchInput: { flex: 1, color: c.text, fontSize: 14, padding: 0 },
  chipRow: { gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, height: 30, paddingHorizontal: 12,
    borderRadius: 15, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
  },
  chipOn: { backgroundColor: brandAlpha(0.16), borderColor: brandAlpha(0.5) },
  chipTxt: { color: c.textDim, fontSize: 13, fontWeight: '600' },
  chipTxtOn: { color: c.text },
  chipCount: { color: c.textFaint, fontSize: 11, fontWeight: '700' },
  sortRow: { flexDirection: 'row', gap: 18, paddingHorizontal: 16, paddingBottom: 10 },
  sortTxt: { color: c.textDim, fontSize: 12, fontWeight: '600' },
  sortTxtOn: { color: c.primary },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border,
  },
  rowIcon: {
    width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    backgroundColor: brandAlpha(0.12),
  },
  rowName: { color: c.text, fontSize: 15, fontWeight: '600' },
  rowMeta: { color: c.textDim, fontSize: 12, marginTop: 2 },
  empty: { alignItems: 'center', padding: 40, gap: 10 },
  emptyTitle: { color: c.text, fontSize: 16, fontWeight: '700' },
  emptyBody: { color: c.textDim, fontSize: 13, textAlign: 'center', lineHeight: 19 },
});
