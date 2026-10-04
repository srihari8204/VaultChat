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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Buffer } from 'buffer';
import { ErrorBoundary } from '../components/ErrorBoundary';
import {
  ActivityIndicator, FlatList, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';
import { unzip, type Unzipped, type UnzipFileInfo } from 'fflate';
import { useTheme } from '../lib/theme';
import { type Palette, brandAlpha } from '../constants/theme';
import {
  listDir, parentDir, refuseDeclared, safeEntryPath, toEntries, tooLargeToOpen,
  totalUncompressed, unsupportedArchiveFormat, type ArchiveEntry,
} from '../lib/archive';
import { VIEWER_TEMP_PREFIX } from '../lib/mediaCacheGC';
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
  const [entryError, setEntryError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const unsupported = unsupportedArchiveFormat(archiveName);

  // Everything this screen writes (the downloaded archive, extracted entries)
  // is plaintext in one per-visit cache folder, removed when the screen
  // closes. lib/mediaCacheGC sweeps VIEWER_TEMP_PREFIX at boot/logout for the
  // crash case. The file viewer opened from here is popped before this unmounts.
  const workDir = useRef(`${FileSystem.cacheDirectory || ''}${VIEWER_TEMP_PREFIX}arc_${Date.now()}/`).current;
  useEffect(() => () => {
    FileSystem.deleteAsync(workDir, { idempotent: true }).catch(() => {});
  }, [workDir]);

  useEffect(() => {
    let alive = true;
    if (unsupported) { setLoading(false); return; }
    setLoading(true);
    setError('');
    (async () => {
      try {
        let local = fileUri;
        if (fileUri.startsWith('http')) {
          // Authenticated endpoint — without the token this downloads a 401
          // body and fflate then reports "invalid zip", which points at the
          // archive rather than at the missing credential.
          const token = await getAccessToken();
          const safeName = (archiveName || 'archive.zip').replace(/[/\\:*?"<>|]/g, '_');
          await FileSystem.makeDirectoryAsync(workDir, { intermediates: true }).catch(() => {});
          const dl = await FileSystem.downloadAsync(
            fileUri,
            workDir + safeName,
            token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
          );
          if (dl.status >= 400) throw new Error(`Could not download the archive (${dl.status})`);
          local = dl.uri;
        }
        const b64 = await FileSystem.readAsStringAsync(local, { encoding: FileSystem.EncodingType.Base64 });
        const bytes = Uint8Array.from(Buffer.from(b64, 'base64'));

        // ZIP-BOMB GUARD: read the central directory only (the filter refuses
        // every entry, so nothing is inflated) and check the DECLARED sizes and
        // entry count before decompressing anything. The old check ran after
        // unzip had already inflated the whole archive into memory.
        const declared: UnzipFileInfo[] = [];
        await new Promise<void>((resolve, reject) => {
          unzip(bytes, { filter: (f) => { declared.push(f); return false; } }, (err) => (err ? reject(err) : resolve()));
        });
        if (!alive) return;
        const refusal = refuseDeclared(declared);
        if (refusal) {
          setError(refusal.reason === 'size'
            ? `This archive expands to ${formatSize(refusal.bytes)}, which is too large to open on the device.`
            : `This archive holds ${refusal.count.toLocaleString()} entries, which is too many to open on the device.`);
          return;
        }

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
        // Do NOT interpolate e.message. expo-file-system rejects with the raw
        // platform text, so opening this screen without a usable uri put
        //   "Call to function 'ExponentFileSystem.readAsStringAsync' has been
        //    rejected. -> Caused by: java.io.IOException: Unsupported scheme
        //    for location ''."
        // on screen, verbatim, as the user-facing error (Honor ELI-NX9,
        // 2026-09-19). A Java stack trace is not an error message.
        //
        // The detail is kept for whoever has to debug it, just not in the UI.
        if (alive) {
          console.warn('[archive-viewer] read failed:', e?.message ?? e);
          setError('Could not read this archive. It may be damaged, or the file is no longer on this device.');
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [fileUri, archiveName, unsupported, workDir, reloadKey]);

  const rows = useMemo(() => listDir(entries, dir), [entries, dir]);

  /** Extract ONE entry to the cache and hand it to the existing file viewer. */
  const openEntry = useCallback(async (e: ArchiveEntry) => {
    if (!raw || busyPath) return;
    const safe = safeEntryPath(e.path);
    // Entry-level problems are shown above the list; they used to replace it.
    if (!safe) {
      setEntryError(`"${e.path}" tries to write outside the archive and was refused.`);
      return;
    }
    setEntryError('');
    setBusyPath(e.path);
    try {
      const bytes = raw[e.path];
      if (!bytes) throw new Error('entry missing from the archive');
      // Flatten into one cache folder per archive: the entry's own directories
      // are not recreated, so a deep path cannot become a deep write.
      const outDir = `${workDir}x/`;
      await FileSystem.makeDirectoryAsync(outDir, { intermediates: true }).catch(() => {});
      const outPath = outDir + safe.split('/').pop();
      await FileSystem.writeAsStringAsync(
        outPath,
        Buffer.from(bytes).toString('base64'),
        { encoding: FileSystem.EncodingType.Base64 },
      );
      router.push({ pathname: '/file-viewer', params: { uri: outPath, filename: e.name } } as any);
    } catch (err: any) {
      console.warn('[archive-viewer] extract failed:', err?.message ?? err);
      setEntryError(`Could not extract "${e.name}".`);
    } finally {
      setBusyPath(null);
    }
  }, [raw, busyPath, workDir, router]);

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

      {unsupported ? (
        // lib/docOpen routes every archive here, but fflate reads ZIP only.
        <View style={S.empty}>
          <Ionicons name="file-tray-full-outline" size={44} color={colors.textDim} />
          <Text style={S.emptyTitle}>{`${unsupported} archives can't be opened here`}</Text>
          <Text style={S.emptyBody}>VaultChat can browse ZIP archives only. Open this file in another app on your device.</Text>
          <TouchableOpacity
            style={S.action}
            accessibilityRole="button"
            accessibilityLabel="Open in another app"
            onPress={() => router.replace({ pathname: '/file-viewer', params: { uri: fileUri, filename: archiveName } } as any)}
          >
            <Text style={S.actionTxt}>Open in another app</Text>
          </TouchableOpacity>
        </View>
      ) : loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
      ) : error ? (
        <View style={S.empty}>
          <Ionicons name="alert-circle-outline" size={44} color={colors.danger} />
          <Text style={S.emptyBody}>{error}</Text>
          <TouchableOpacity style={S.action} accessibilityRole="button" accessibilityLabel="Retry opening the archive"
            onPress={() => setReloadKey(k => k + 1)}>
            <Text style={S.actionTxt}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
        {!!entryError && (
          <View style={S.banner} accessibilityRole="alert">
            <Ionicons name="alert-circle-outline" size={16} color={colors.danger} />
            <Text style={S.bannerTxt}>{entryError}</Text>
            <TouchableOpacity onPress={() => setEntryError('')} hitSlop={10} accessibilityRole="button" accessibilityLabel="Dismiss">
              <Ionicons name="close" size={16} color={colors.textDim} />
            </TouchableOpacity>
          </View>
        )}
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
              accessibilityRole="button"
              accessibilityLabel={item.isDirectory
                ? `Folder ${item.name}, ${item.size} item${item.size === 1 ? '' : 's'}`
                : `File ${item.name}, ${formatSize(item.size)}`}
              accessibilityState={{ busy: busyPath === item.path }}
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
        </>
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
  emptyTitle: { color: c.text, fontSize: 16, fontWeight: '700', textAlign: 'center' },
  action: { marginTop: 4, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 20, backgroundColor: brandAlpha(0.16) },
  actionTxt: { color: c.primary, fontSize: 14, fontWeight: '700' },
  banner: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginBottom: 8,
    padding: 10, borderRadius: 10, backgroundColor: c.glassSoft,
  },
  bannerTxt: { flex: 1, color: c.text, fontSize: 13 },
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
