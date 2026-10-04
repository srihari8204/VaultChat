// app/shelf.tsx — The Bookshelf: every file shared in any chat, in one place.
//
// Design: docs/design/screens/17-bookshelf (mobile m17-shelf).
//
// The index comes from the LOCAL message cache (localDb.listAllAttachments), so
// the shelf opens instantly, works offline, and needs no server support. It is
// exactly as complete as the cache — which is the honest behaviour, and why the
// empty state says so rather than pretending the account has no files.
// Locked and hidden chats are left out (their file names are their content).
//
// Pins live in the localDb kv table, not on the server: "keep this at the top of
// my shelf" is a per-device view preference, not shared state.

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../lib/theme';
import { type Palette, brandAlpha } from '../constants/theme';
import { getMeta, listAllAttachments, setMeta } from '../lib/localDb';
import { isLockedIn, lockedChatIds } from '../lib/lockedChats';
import {
  classify, countsByKind, formatSize, queryShelf,
  type ShelfFile, type ShelfKind, type ShelfSort,
} from '../lib/shelf';
import { AuroraBackground } from '../components/ui';
import { shelfListable, shelfOpenParams } from '../lib/shelfOpen';
import { getCurrentUserAsync } from './(constants)/authService';

const PINS_KEY = 'vc_shelf_pins_v1';

const KIND_ICON: Record<ShelfKind, keyof typeof Ionicons.glyphMap> = {
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
  const [loadFailed, setLoadFailed] = useState(false);
  // The lock table could not be read, so every file was held back (fail
  // closed). The list is empty for that reason, not because there are no files.
  const [lockUnknown, setLockUnknown] = useState(false);
  const [myId, setMyId] = useState<string | null>(null);
  const [pins, setPins] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<ShelfKind | 'all'>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<ShelfSort>('recent');

  // The live pin set, so overlapping toggles on two rows each start from the
  // other's result, and a failed write undoes only its OWN row (restoring a
  // snapshot taken at tap time used to undo the other row's toggle too).
  // Writes are chained so an older set can never land after a newer one.
  const pinsRef = useRef(pins);
  pinsRef.current = pins;
  const pinWrites = useRef<Promise<unknown>>(Promise.resolve());
  // A focus reload must not put back a pin set older than the live one: a
  // load whose storage read started before a toggle, or that finishes while
  // a pin write is still queued, keeps the live set (pinEdits counts toggles,
  // pinWritesPending counts queued writes).
  const pinEdits = useRef(0);
  const pinWritesPending = useRef(0);

  const load = useCallback(async () => {
    const editsAtStart = pinEdits.current;
    try {
      // listAllAttachments already skips hidden chats; a locked chat's file
      // names stay off the shelf too (lockedChatIds: null = unreadable lock
      // table, so every chat counts as locked — fail closed).
      const [rows, pinRaw, me, locked] = await Promise.all([
        listAllAttachments(), getMeta(PINS_KEY), getCurrentUserAsync().catch(() => null), lockedChatIds(),
      ]);
      let pinList: string[] = [];
      try { pinList = pinRaw ? JSON.parse(pinRaw) : []; } catch { /* corrupt pins: start empty */ }
      const stale = pinEdits.current !== editsAtStart || pinWritesPending.current > 0;
      const pinned = stale ? pinsRef.current : new Set<string>(pinList);
      if (!stale) setPins(pinned);
      setMyId(me?.id != null ? String(me.id) : null);
      setLockUnknown(locked === null);
      setFiles(rows.filter(r => shelfListable(r) && !isLockedIn(locked, r.chatId)).map(r => ({
        ...r,
        kind: classify(r.filename, r.mime),
        pinned: pinned.has(r.attachmentId),
      })));
      setLoadFailed(false);
    } catch {
      // Say so: an unreadable cache used to look exactly like "no files".
      setLoadFailed(true);
    }
    finally { setLoading(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const togglePin = useCallback((id: string) => {
    const was = pinsRef.current.has(id);
    const withPin = (set: Set<string>, on: boolean) => {
      const n = new Set(set);
      if (on) n.add(id); else n.delete(id);
      return n;
    };
    const setRow = (on: boolean) => {
      pinsRef.current = withPin(pinsRef.current, on);
      setPins(pinsRef.current);
      setFiles(fs => fs.map(f => (f.attachmentId === id ? { ...f, pinned: on } : f)));
    };
    setRow(!was);
    pinEdits.current++;
    pinWritesPending.current++;
    pinWrites.current = pinWrites.current.then(() =>
      setMeta(PINS_KEY, JSON.stringify([...pinsRef.current])).catch(() => {
        // The pin only looked saved: put this row back and say so.
        setRow(was);
        Alert.alert('Couldn’t save the pin', 'The change could not be written to this device. Please try again.');
      }).finally(() => { pinWritesPending.current--; }));
  }, []);

  const counts = useMemo(() => countsByKind(files), [files]);
  const shown = useMemo(() => queryShelf(files, { kind, search, sort }), [files, kind, search, sort]);

  const open = useCallback((f: ShelfFile) => {
    // Reuse the viewers that already exist rather than adding a third one.
    // media-viewer routes archives on to app/archive-viewer itself. queryShelf
    // returns the same row objects, so the protection flags are still on them.
    router.push({ pathname: '/media-viewer', params: shelfOpenParams(f, myId) });
  }, [router, myId]);

  return (
    <View style={[S.screen, { paddingTop: insets.top }]}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />

      <View style={S.head}>
        <TouchableOpacity onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Go back" hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.title} accessibilityRole="header">Shelf</Text>
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
          accessibilityLabel="Filter files by name"
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => setSearch('')} accessibilityRole="button" accessibilityLabel="Clear the filter" hitSlop={10}>
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
            <TouchableOpacity onPress={() => setKind(item.id)} style={[S.chip, on && S.chipOn]} activeOpacity={0.8}
              accessibilityRole="tab" accessibilityLabel={`${item.label}, ${n} file${n === 1 ? '' : 's'}`}
              accessibilityState={{ selected: on }}>
              <Text style={[S.chipTxt, on && S.chipTxtOn]}>{item.label}</Text>
              <Text style={[S.chipCount, on && S.chipTxtOn]}>{n}</Text>
            </TouchableOpacity>
          );
        }}
      />

      <View style={S.sortRow}>
        {SORTS.map(s => (
          <TouchableOpacity key={s.id} onPress={() => setSort(s.id)} hitSlop={6}
            accessibilityRole="radio" accessibilityLabel={`Sort by ${s.label}`}
            accessibilityState={{ selected: sort === s.id }}>
            <Text style={[S.sortTxt, sort === s.id && S.sortTxtOn]}>{s.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* A refresh that failed while older rows are still shown: say the list
          may be stale instead of presenting it as current. */}
      {!loading && loadFailed && files.length > 0 && (
        <View style={S.staleBar} accessibilityLiveRegion="polite">
          <Text style={S.staleTxt}>{"Couldn't refresh — showing the last list read."}</Text>
          <TouchableOpacity onPress={() => load()} hitSlop={10} accessibilityRole="button" accessibilityLabel="Retry loading the shelf">
            <Text style={S.retryLink}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {loading ? (
        <ActivityIndicator color={colors.primary} style={S.spinner} />
      ) : loadFailed && files.length === 0 ? (
        <View style={S.empty}>
          <Ionicons name="alert-circle-outline" size={44} color={colors.textDim} />
          <Text style={S.emptyTitle}>{"Couldn't read the shelf"}</Text>
          <Text style={S.emptyBody}>The file index on this device could not be read.</Text>
          <TouchableOpacity onPress={() => { setLoading(true); load(); }} style={S.retry}
            accessibilityRole="button" accessibilityLabel="Retry loading the shelf">
            <Text style={S.retryTxt}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : lockUnknown ? (
        <View style={S.empty} accessibilityLiveRegion="polite">
          <Ionicons name="lock-closed-outline" size={44} color={colors.textDim} />
          <Text style={S.emptyTitle}>{"Couldn't check which chats are locked"}</Text>
          <Text style={S.emptyBody}>Files stay hidden until the lock settings on this device can be read, so nothing from a locked chat is shown by mistake.</Text>
          <TouchableOpacity onPress={() => { setLoading(true); load(); }} style={S.retry}
            accessibilityRole="button" accessibilityLabel="Try reading the lock settings again">
            <Text style={S.retryTxt}>Try again</Text>
          </TouchableOpacity>
        </View>
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
                  ? 'The shelf is built from chats cached on this device, so files appear here as you open the chats that contain them. Files from locked and hidden chats are not shown.'
                  : 'Try a different filter or search.'}
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity style={S.row} activeOpacity={0.75} onPress={() => open(item)}
              accessibilityRole="button"
              accessibilityLabel={`Open ${item.filename}, ${formatSize(item.size)}${item.pinned ? ', pinned' : ''}`}
              // The pin button sits inside this row, where a screen reader may
              // not reach it: offer it as an action on the row as well.
              accessibilityActions={[{ name: 'pin', label: item.pinned ? 'Unpin' : 'Pin' }]}
              onAccessibilityAction={e => { if (e.nativeEvent.actionName === 'pin') togglePin(item.attachmentId); }}>
              <View style={S.rowIcon}>
                <Ionicons name={KIND_ICON[item.kind]} size={20} color={colors.primary} />
              </View>
              <View style={S.flex}>
                <Text style={S.rowName} numberOfLines={1}>{item.filename}</Text>
                <Text style={S.rowMeta} numberOfLines={1}>
                  {[formatSize(item.size), item.createdAt ? new Date(item.createdAt).toLocaleDateString() : '']
                    .filter(Boolean).join(' · ')}
                </Text>
              </View>
              <TouchableOpacity accessibilityRole="button" accessibilityState={{ selected: !!item.pinned }} accessibilityLabel={item.pinned ? `Unpin ${item.filename}` : `Pin ${item.filename}`} onPress={() => togglePin(item.attachmentId)} hitSlop={12}>
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
  screen: { flex: 1, backgroundColor: 'transparent' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  title: { color: c.text, fontSize: 22, fontWeight: '800' },
  subtitle: { color: c.textDim, fontSize: 12, marginLeft: 'auto' },
  // 2026-09-18: the 14sp filter input outgrows a pinned 40 at font scale 1.5
  // and loses its descenders. minHeight keeps the pill at 40 on a normal phone.
  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16,
    paddingHorizontal: 12, minHeight: 40, paddingVertical: 6, borderRadius: 12,
    backgroundColor: c.glassSoft, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke,
  },
  searchInput: { flex: 1, color: c.text, fontSize: 14, padding: 0 },
  chipRow: { gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 30, paddingHorizontal: 12,
    borderRadius: 15, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke,
  },
  chipOn: { backgroundColor: brandAlpha(0.16), borderColor: brandAlpha(0.5) },
  chipTxt: { color: c.textDim, fontSize: 13, fontWeight: '600' },
  chipTxtOn: { color: c.text },
  chipCount: { color: c.textFaint, fontSize: 11, fontWeight: '700' },
  sortRow: { flexDirection: 'row', gap: 18, paddingHorizontal: 16, paddingBottom: 10 },
  sortTxt: { color: c.textDim, fontSize: 12, fontWeight: '600' },
  sortTxtOn: { color: c.accentOn },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke,
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
  retry: { marginTop: 6, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 20, backgroundColor: brandAlpha(0.16) },
  retryTxt: { color: c.accentOn, fontSize: 14, fontWeight: '700' },
  spinner: { marginTop: 40 },
  flex: { flex: 1 },
  staleBar: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: c.glassSoft },
  staleTxt: { flex: 1, color: c.textDim, fontSize: 12 },
  retryLink: { color: c.accentOn, fontSize: 13, fontWeight: '700' },
});
