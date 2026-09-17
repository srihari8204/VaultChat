// app/archive-viewer.tsx — browse a .zip that arrived in a chat.
//
// Design: docs/design/screens/15-archive (mobile m15-archive).
//
// Reads the archive with fflate (pure JS — no native module, so this needed no
// prebuild). Nothing is written to disk until you tap a file: extraction is
// per-entry into the app cache, then handed to the existing viewers. The whole
// archive is never unpacked, so opening a 200-entry zip to read one file does
// not cost 200 files on disk.
//
// Entry paths inside an archive are untrusted (lib/archive.safeEntryPath); an
// entry that tries to escape the destination is refused rather than repaired.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorBoundary } from '../components/ErrorBoundary';
import {
  ActivityIndicator, FlatList, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';
import { unzip, type Unzipped } from 'fflate';
import { useTheme } from '../lib/theme';
import { type Palette, brandAlpha } from '../constants/theme';
import {
  listDir, parentDir, safeEntryPath, toEntries, tooLargeToOpen,
  totalUncompressed, type ArchiveEntry,
} from '../lib/archive';
import { formatSize } from '../lib/shelf';
import { getAccessToken } from '../lib/api';
import { AuroraBackground } from '../components/ui';

function ArchiveViewerScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const S = useMemo(() => makeStyles(colors), [colors]);
  const params = useLocalSearchParams<{ uri: string; filename?: string }>();

  const fileUri = (params.uri || '') + '';
  const archiveName = (params.filename || 'archive.zip') + '';

  const [raw, setRaw] = useState<Unzipped | null>(null);
  const [entries, setEntries] = useState<ArchiveEntry[]>([]);
  const [dir, setDir] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyPath, setBusyPath] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        let local = fileUri;
        if (fileUri.startsWith('http')) {
          // Authenticated endpoint — without the token this downloads a 401
          // body and fflate then reports "invalid zip", which points at the
          // archive rather than at the missing credential.
          const token = await getAccessToken();
          const safeName = (archiveName || 'archive.zip').replace(/[/\\:*?"<>|]/g, '_');
          const dl = await FileSystem.downloadAsync(
            fileUri,
            (FileSystem.cacheDirectory || '') + safeName,
            token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
          );
          if (dl.status >= 400) throw new Error(`Could not download the archive (${dl.status})`);
          local = dl.uri;
        }
        const b64 = await FileSystem.readAsStringAsync(local, { encoding: FileSystem.EncodingType.Base64 });
        const bytes = Uint8Array.from(Buffer.from(b64, 'base64'));

        const files = await new Promise<Unzipped>((resolve, reject) => {
          unzip(bytes, (err, out) => (err ? reject(err) : resolve(out)));
        });
        if (!alive) return;

        const rows = toEntries(
          Object.fromEntries(Object.entries(files).map(([p, d]) => [p, { size: d.length }])),
        );
        if (tooLargeToOpen(rows)) {
          setError(`This archive expands to ${formatSize(totalUncompressed(rows))}, which is too large to open on the device.`);
        } else {
          setRaw(files);
          setEntries(rows);
        }
      } catch (e: any) {
        if (alive) setError(e?.message ? `Could not read this archive: ${e.message}` : 'Could not read this archive.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [fileUri, archiveName]);

  const rows = useMemo(() => listDir(entries, dir), [entries, dir]);

  /** Extract ONE entry to the cache and hand it to the existing file viewer. */
  const openEntry = useCallback(async (e: ArchiveEntry) => {
    if (!raw || busyPath) return;
    const safe = safeEntryPath(e.path);
    if (!safe) {
      setError(`"${e.path}" tries to write outside the archive and was refused.`);
      return;
    }
    setBusyPath(e.path);
    try {
      const bytes = raw[e.path];
      if (!bytes) throw new Error('entry missing from the archive');
      // Flatten into one cache folder per archive: the entry's own directories
      // are not recreated, so a deep path cannot become a deep write.
      const outDir = `${FileSystem.cacheDirectory}archive/${encodeURIComponent(archiveName)}/`;
      await FileSystem.makeDirectoryAsync(outDir, { intermediates: true }).catch(() => {});
      const outPath = outDir + safe.split('/').pop();
      await FileSystem.writeAsStringAsync(
        outPath,
        Buffer.from(bytes).toString('base64'),
        { encoding: FileSystem.EncodingType.Base64 },
      );
      router.push({ pathname: '/file-viewer', params: { uri: outPath, filename: e.name } } as any);
    } catch (err: any) {
      setError(err?.message ?? 'Could not extract that file.');
    } finally {
      setBusyPath(null);
    }
  }, [raw, busyPath, archiveName, router]);

  const up = parentDir(dir);

  return (
    <View style={[S.screen, { paddingTop: insets.top }]}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />

      <View style={S.head}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => (up !== null ? setDir(up) : router.back())} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={S.title} numberOfLines={1}>{archiveName}</Text>
          <Text style={S.subtitle} numberOfLines={1}>
            {dir ? `/${dir}` : `${entries.filter(e => !e.isDirectory).length} files · ${formatSize(totalUncompressed(entries))}`}
          </Text>
        </View>
      </View>

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
      ) : error ? (
        <View style={S.empty}>
          <Ionicons name="alert-circle-outline" size={44} color={colors.danger} />
          <Text style={S.emptyBody}>{error}</Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={e => e.path}
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
          ListEmptyComponent={
            <View style={S.empty}>
              <Ionicons name="folder-open-outline" size={44} color={colors.textDim} />
              <Text style={S.emptyBody}>This folder is empty.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={S.row}
              activeOpacity={0.75}
              onPress={() => (item.isDirectory ? setDir(item.path.replace(/\/$/, '')) : openEntry(item))}
            >
              <View style={S.rowIcon}>
                <Ionicons
                  name={item.isDirectory ? 'folder' : 'document-outline'}
                  size={19}
                  color={item.isDirectory ? colors.primary : colors.textDim}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={S.rowName} numberOfLines={1}>{item.name}</Text>
                <Text style={S.rowMeta}>
                  {item.isDirectory ? `${item.size} item${item.size === 1 ? '' : 's'}` : formatSize(item.size)}
                </Text>
              </View>
              {busyPath === item.path
                ? <ActivityIndicator color={colors.primary} />
                : <Ionicons name="chevron-forward" size={17} color={colors.textFaint} />}
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
  title: { color: c.text, fontSize: 17, fontWeight: '700' },
  subtitle: { color: c.textDim, fontSize: 12, marginTop: 2 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke,
  },
  rowIcon: {
    width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    backgroundColor: brandAlpha(0.12),
  },
  rowName: { color: c.text, fontSize: 15, fontWeight: '600' },
  rowMeta: { color: c.textDim, fontSize: 12, marginTop: 2 },
  empty: { alignItems: 'center', padding: 40, gap: 12 },
  emptyBody: { color: c.textDim, fontSize: 14, textAlign: 'center', lineHeight: 20 },
});

// A render fault in a viewer used to take the WHOLE app down: these screens
// render untrusted, arbitrary media (a truncated video, a malformed PDF, an
// office file with a codec this device lacks) and none of them were wrapped.
// The boundary turns that crash into a dismissable screen with the chat intact.
export default function ArchiveViewerScreenBoundary() {
  return (
    <ErrorBoundary screen="ArchiveViewerScreen" fallbackTitle="Archive Viewer Error" fallbackMessage="This archive could not be opened.">
      <ArchiveViewerScreen />
    </ErrorBoundary>
  );
}
