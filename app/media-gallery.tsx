// app/media-gallery.tsx — Media Gallery per Chat (Postgres-backed).
//
// Photos / Videos / Files / Links shared in a conversation, pulled from the
// real message history (GET /chats/:id/messages) and filtered by type.
// Thumbnails load through the auth'd attachment endpoint; tapping a photo or a
// video opens it in /media-viewer (zoom, playback, share, save), with the same
// params the Shelf uses. Links open externally. No Firestore.

import { useAuthHeader } from '../hooks/useAuthHeader';
import React, { useState, useEffect, useCallback , useMemo, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList, SectionList, ActivityIndicator, Alert, Linking,
  useWindowDimensions, type ImageStyle, type StyleProp,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Sharing from 'expo-sharing';
// expo-image: the 3-up grid recycles tiles, so cache + recyclingKey matter here.
import { Image } from 'expo-image';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { AuroraDark, type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { getMessages, getChat, decryptFromChat, attachmentUrl, type Message } from '../lib/chatService';
import { getDecryptedAttachmentUri, parseMediaContent } from '../lib/mediaAttachments';
import { resolveAttachmentFile, viewerRouteFor } from '../lib/docOpen';
import { MediaKeyMissingError } from '../lib/mediaStore';
import { getCurrentUserAsync } from './(constants)/authService';
import { readCache, writeCache } from '../lib/localCache';
import { unionWithLocalHistory } from '../lib/messageHistory';
import { AuroraBackground } from '../components/ui';
import { shelfOpenParams } from '../lib/shelfOpen';

// No module-level Dimensions.get: it is read ONCE at import, so the 3-up grid
// kept its launch-time tile size through every rotation, fold and split-screen
// resize — tiles overflowed the row in one direction and left a dead gutter in
// the other. The size is computed per render from useWindowDimensions instead.
const GRID_GUTTER = 40;
const GRID_COLS = 3;
export function gridTileSize(windowWidth: number): number {
  return Math.max(48, (windowWidth - GRID_GUTTER) / GRID_COLS);
}
const PAGE = 200;
const MAX_PAGES = 5;

type ThumbSrc = { uri: string; headers?: Record<string, string> } | null;

/** Split a message list into the gallery's four buckets. */
function bucket(msgs: Message[]) {
  const photos: Message[] = [], videos: Message[] = [], files: Message[] = [], links: LinkItem[] = [];
  for (const m of msgs) {
    if (m.deletedAt) continue;
    // View-once media is shown once, in the protected viewer, from the chat
    // bubble only. Listed here it became a grid thumbnail that opened in the
    // unprotected photo Modal (and could be viewed again and again).
    if (m.meta?.viewOnce) continue;
    if (m.type === 'image' && m.meta?.attachmentId) photos.push(m);
    else if (m.type === 'video' && m.meta?.attachmentId) videos.push(m);
    else if (m.type === 'file' && m.meta?.attachmentId) files.push(m);
    else if (m.type === 'text' && m.content) {
      const found = m.content.match(/https?:\/\/[^\s]+/gi);
      if (found) for (const u of found) links.push({ id: m.id, url: u, createdAt: m.createdAt });
    }
  }
  return { photos, videos, files, links };
}

/**
 * Lazy thumbnail: resolves (and decrypts if needed) only when the tile mounts.
 *
 * Declared at module scope on purpose. It used to be built with useCallback
 * INSIDE the screen component while calling useState/useEffect itself — a
 * rules-of-hooks violation, and a remount hazard: React compares element types
 * by reference, so any render that produced a new function identity would tear
 * down and rebuild every tile, re-running the decrypt for each one.
 */
function MediaThumb({ m, style, resizeMode = 'cover', resolveSrc, placeholder }: {
  m: Message;
  style: StyleProp<ImageStyle>;
  resizeMode?: 'cover' | 'contain';
  resolveSrc: (m: Message) => Promise<ThumbSrc>;
  placeholder: string;
}) {
  const [src, setSrc] = useState<ThumbSrc>(null);
  useEffect(() => {
    let cancel = false;
    (async () => { const r = await resolveSrc(m); if (!cancel) setSrc(r); })();
    return () => { cancel = true; };
  }, [m, resolveSrc]);
  if (!src) return <View style={[style, { backgroundColor: placeholder }]} />;
  // A file:// source is a decrypted local copy: keep its thumbnail in memory
  // only, so no decoded copy lands in the image library's disk cache.
  return <Image source={src} style={style} contentFit={resizeMode} recyclingKey={String(m.id)}
    cachePolicy={/^https?:/i.test(src.uri) ? 'memory-disk' : 'memory'} />;
}

type TabId = 'photos' | 'videos' | 'files' | 'links';

// Groups & Circles G4.4: the shared album. A group IS a chat, so its media is
// already here — the album is not a second store, it is this gallery with the
// organisation the album needs. Building a parallel screen would have meant
// duplicating the thumbnail decryption, the cache and the viewer below.
type GroupBy = 'none' | 'date' | 'member';

/** Chunk a flat list into rows of three, so sections can render a 3-up grid. */
function toRows<T>(items: T[], per = 3): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += per) rows.push(items.slice(i, i + per));
  return rows;
}

const dayKey = (iso: string) => {
  const d = new Date(iso), now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (new Date(now.getTime() - 86400_000).toDateString() === d.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
};
interface LinkItem { id: number; url: string; createdAt: string }

// Per-chat media buckets persisted so the gallery opens instantly on re-entry.
interface GalleryCache {
  photos: Message[];
  videos: Message[];
  files: Message[];
  links: LinkItem[];
}

function useS() {
  const { colors } = useTheme();
  const { top } = useSafeAreaInsets();
  return useMemo(() => makeStyles(colors, top), [colors, top]);
}

export default function MediaGalleryScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  // `open`: a message id whose file opens once the Files list has loaded
  // (contact-info's Shared Files rows).
  const { chatId, id: idParam, peerName, tab: tabParam, open: openParam } = useLocalSearchParams<{ chatId?: string; id?: string; peerName?: string; tab?: string; open?: string }>();
  const cid = String(chatId ?? idParam ?? '');

  // Callers may open a specific tab (contact-info opens Files); anything else
  // falls back to Photos.
  const [tab, setTab] = useState<TabId>(() =>
    (['photos', 'videos', 'files', 'links'] as const).includes(tabParam as TabId) ? (tabParam as TabId) : 'photos');
  const authHeader = useAuthHeader();
  // Who we are, so a file WE sent resolves to the Sent/ copy already on disk
  // instead of being downloaded back from the server.
  const [meId, setMeId] = useState<string | null>(null);
  // The lookup has answered (meId may still be null when it failed).
  const [meKnown, setMeKnown] = useState(false);
  // One open at a time. Repeated taps on a row otherwise start a second
  // download of the same attachment and push a second viewer on top.
  const openingRef = useRef<string | null>(null);
  // Recomputed on every window change (rotate, fold, split-screen), which is
  // the whole point — see gridTileSize.
  const { width: winW } = useWindowDimensions();
  const tileSize = gridTileSize(winW);
  const [photos, setPhotos] = useState<Message[]>([]);
  const [videos, setVideos] = useState<Message[]>([]);
  const [files, setFiles] = useState<Message[]>([]);
  const [links, setLinks] = useState<LinkItem[]>([]);
  const [loading, setLoading] = useState(true);
  // 'none' | the network refresh failed with nothing cached ('empty') or with
  // a cached gallery still shown ('stale'). A failure must never read as
  // "No photos shared yet".
  const [loadError, setLoadError] = useState<'none' | 'empty' | 'stale'>('none');
  const [capped, setCapped] = useState(false);
  // The network walk for this chat finished and the lists hold its result.
  const [walked, setWalked] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    // Cache key includes the chat id so different chats' galleries don't collide.
    const cacheKey = 'media-gallery:' + cid;
    let painted = false;
    setLoadError('none');
    setWalked(false);
    (async () => {
      // Local-first: paint the cached buckets instantly so the gallery opens
      // without a spinner; individual thumbnails still decrypt on demand.
      if (cid) {
        const cached = await readCache<GalleryCache>(cacheKey);
        if (active && cached) {
          // Re-bucket: a cache written before the view-once filter may hold some.
          const c = bucket([...cached.photos, ...cached.videos, ...cached.files]);
          setPhotos(c.photos); setVideos(c.videos);
          setFiles(c.files); setLinks(cached.links);
          setLoading(false);
          painted = true;
        }
      }

      try {
        if (!cid) { setLoading(false); return; }

        // Remember the chat's direct peer so encrypted media content can be
        // decrypted (to recover per-file keys) — same as the chat screen does.
        // We already fetch the chat; keep its member names so the album can
        // label sections without another request.
        const chat = await getChat(cid).catch(() => null);
        if (chat?.members) {
          const map: Record<string, string> = {};
          for (const mem of chat.members) map[String(mem.userId)] = mem.name || mem.email || 'Member';
          setNames(map);
        }

        // Walk the history (cap a few pages) and bucket by type.
        const all: Message[] = [];
        let before: number | undefined;
        let full = false;
        for (let i = 0; i < MAX_PAGES; i++) {
          const page = await getMessages(cid, { before, limit: PAGE });
          all.push(...page);
          full = page.length >= PAGE;
          if (!full) break;
          before = page[page.length - 1].id;
        }
        if (!active) return;
        // Every page came back full: older history exists that was not walked.
        setCapped(full);

        // UNION with the local cache, never replace it.
        //
        // The server is not the whole truth here. delete-on-delivery sets
        // `content = NULL` once every recipient has acked, and the media
        // retention sweep purges the attachment bytes — so an older photo can
        // be perfectly visible in the chat (served from the device's own
        // media/ dir) while the server row that described it is gone. Taking
        // the network result as the answer therefore ERASED a good gallery the
        // moment the retention window passed: the chat still showed the media,
        // the gallery went empty, and the cache was overwritten with nothing.
        const merged = await unionWithLocalHistory(cid, all, 1000);

        const { photos: ph, videos: vd, files: fl, links: lk } = bucket(merged);
        setPhotos(ph); setVideos(vd); setFiles(fl); setLinks(lk);
        writeCache<GalleryCache>(cacheKey, { photos: ph, videos: vd, files: fl, links: lk });
        setWalked(true);
      } catch {
        // Keep the painted cache on error, but say it may be out of date; with
        // nothing cached, show an error with Retry instead of an empty tab.
        if (active) setLoadError(painted ? 'stale' : 'empty');
      } finally {
        if (active && !painted) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [cid, reloadKey]);

  useEffect(() => {
    getCurrentUserAsync()
      .then((u: { id?: string | number } | null) => setMeId(u?.id != null ? String(u.id) : null))
      .catch(() => {})
      .finally(() => setMeKnown(true));
  }, []);

  const fmtDate = useCallback((iso: string) => { try { return new Date(iso).toLocaleDateString(); } catch { return ''; } }, []);

  // An encrypted attachment keeps its per-file key inside the message body, so
  // the body is decrypted first and the key handed to the media store — the
  // step every open below needs before the file itself can be read.
  const unlockKey = useCallback(async (m: Message, aid: string) => {
    if (!m.meta?.encrypted) return;
    const plain = await decryptFromChat(cid, m.senderId, m.content, m.id);
    await parseMediaContent(aid, plain);
  }, [cid]);

  // Resolve a renderable source for a media message: for encrypted attachments,
  // decrypt the content to recover the per-file key, then return a decrypted
  // local file:// URI; for plaintext, return the auth-gated /uploads URL.
  const resolveSrc = useCallback(async (
    m: Message,
  ): Promise<{ uri: string; headers?: Record<string, string> } | null> => {
    const aid = m.meta?.attachmentId;
    if (!aid) return null;
    if (m.meta?.encrypted) {
      try {
        await unlockKey(m, String(aid));
        return await getDecryptedAttachmentUri(aid);
      } catch { return null; }
    }
    return { uri: attachmentUrl(aid), headers: authHeader ? { Authorization: authHeader } : undefined };
  }, [unlockKey, authHeader]);


  const openFile = useCallback(async (m: Message) => {
    // This used to be Linking.openURL(r.uri), and it could not work either way
    // round. For a plaintext attachment `r.uri` is the /uploads URL and the
    // headers were dropped, so the file opened in the SYSTEM BROWSER — which
    // holds no bearer token and so rendered a 401, after taking a crazzychat
    // attachment URL out of the app. For an encrypted one `r.uri` is a file://
    // path, and handing that to another app is what Android's StrictMode kills
    // with FileUriExposedException. The Files tab was broken in both branches.
    //
    // Route through the same resolver the chat bubble uses instead: download
    // once with the Authorization header into the persistent media store,
    // decrypt if we hold a key, then open one of the in-app viewers.
    const aid = m.meta?.attachmentId;
    if (!aid || openingRef.current) return;
    openingRef.current = String(aid);
    const filename = m.meta?.fileName || m.meta?.name || m.meta?.filename || 'File';
    try {
      await unlockKey(m, String(aid));
      const uri = await resolveAttachmentFile({
        attachmentId: String(aid),
        filename,
        mime: m.meta?.mime ?? null,
        isMine: !!meId && String(m.senderId) === meId,
        encrypted: !!m.meta?.encrypted,
      });
      const route = viewerRouteFor(filename, m.meta?.mime);
      if (route === 'handoff') {
        // Nothing in-app renders this type. The OS is the better renderer, and
        // expo-sharing does the FileProvider work that a raw file:// cannot.
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(uri, { mimeType: m.meta?.mime || undefined, dialogTitle: filename });
        } else {
          Alert.alert('Can’t open file', 'No app on this device can open this file type.');
        }
        return;
      }
      router.push({
        pathname: route,
        params: { uri, filename, mimeType: m.meta?.mime || '', msgType: 'file' },
      });
    } catch (e: unknown) {
      // A missing key is a STATE, not a crash: it is the normal situation after
      // a reinstall, and saying so is the difference between an explicable
      // screen and "nothing happens when I tap".
      Alert.alert(
        'Can’t open file',
        e instanceof MediaKeyMissingError
          ? 'This file is end-to-end encrypted and this device no longer holds its key.'
          : 'The file could not be downloaded. Check your connection and try again.',
      );
    } finally {
      openingRef.current = null;
    }
  }, [unlockKey, meId, router]);

  // Open the requested file once, after the list holds it (cache or network)
  // and after we know who we are — so a file we sent opens from the Sent/ copy
  // instead of being downloaded back. A file the walked history does not hold
  // says so instead of doing nothing.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (!openParam || autoOpened.current || !meKnown) return;
    const row = files.find((m) => String(m.id) === String(openParam));
    if (!row) {
      if (walked) {
        autoOpened.current = true;
        Alert.alert('File not found', capped
          ? 'That file is older than the history loaded here, or it was deleted. Open it from the chat instead.'
          : 'That file is no longer in this chat. It may have been deleted.');
      }
      return;
    }
    autoOpened.current = true;
    openFile(row);
  }, [openParam, files, openFile, meKnown, walked, capped]);

  // Photos and videos open in /media-viewer: it plays video (the old in-screen
  // Modal could only show a still), zooms, shares and saves. Encrypted media
  // needs its per-file key from the message body first — the same two calls
  // resolveSrc and openFile make — after which media-viewer's getMedia
  // decrypts it from the persistent store.
  const openMedia = useCallback(async (m: Message) => {
    const aid = m.meta?.attachmentId;
    if (!aid || openingRef.current) return;
    openingRef.current = String(aid);
    try {
      try {
        await unlockKey(m, String(aid));
      } catch {
        Alert.alert('Can’t open', 'This item could not be decrypted on this device.');
        return;
      }
      router.push({
        pathname: '/media-viewer',
        params: shelfOpenParams({
          attachmentId: String(aid), chatId: cid, senderId: m.senderId != null ? String(m.senderId) : null,
          filename: m.meta?.fileName || m.meta?.name || m.meta?.filename || (m.type === 'video' ? 'Video' : 'Photo'),
          mime: m.meta?.mime ?? null, kind: m.type, encrypted: !!m.meta?.encrypted,
        }, meId),
      });
    } catch (e: unknown) {
      console.warn('[media-gallery] open failed:', e instanceof Error ? e.message : e);
      Alert.alert('Can’t open', 'The viewer could not be opened. Please try again.');
    } finally {
      openingRef.current = null;
    }
  }, [unlockKey, cid, meId, router]);

  const renderPhoto = ({ item }: { item: Message }) => (
    <TouchableOpacity style={[s.tile, { width: tileSize, height: tileSize }]} onPress={() => openMedia(item)} activeOpacity={0.8}
      accessibilityRole="button" accessibilityLabel={`Photo, ${fmtDate(item.createdAt)}`}>
      <MediaThumb m={item} style={s.tileImg} resolveSrc={resolveSrc} placeholder={colors.surfaceSolid} />
    </TouchableOpacity>
  );

  const renderVideo = ({ item }: { item: Message }) => (
    <TouchableOpacity style={[s.tile, { width: tileSize, height: tileSize }]} onPress={() => openMedia(item)} activeOpacity={0.8}
      accessibilityRole="button" accessibilityLabel={`Video, ${fmtDate(item.createdAt)}`}>
      <MediaThumb m={item} style={s.tileImg} resolveSrc={resolveSrc} placeholder={colors.surfaceSolid} />
      {/* Light ink on a dark scrim over the thumbnail: fixed in both themes. */}
      <View style={s.playBadge}><Ionicons name="play" size={16} color={AuroraDark.text} /></View>
    </TouchableOpacity>
  );

  const fileLabel = (m: Message) => m.meta?.fileName || m.meta?.name || m.meta?.filename || 'File';
  const renderFile = ({ item }: { item: Message }) => (
    <TouchableOpacity style={s.fileRow} onPress={() => openFile(item)}
      accessibilityRole="button" accessibilityLabel={`${fileLabel(item)}, ${fmtDate(item.createdAt)}`} accessibilityHint="Opens the file">
      <View style={s.fileIcon}><Ionicons name="document-text-outline" size={22} color={colors.accent} /></View>
      <View style={s.flex}>
        <Text style={s.fileName} numberOfLines={1}>{fileLabel(item)}</Text>
        <Text style={s.fileDate}>{fmtDate(item.createdAt)}</Text>
      </View>
      <Ionicons name="download-outline" size={18} color={colors.textDim} />
    </TouchableOpacity>
  );

  const renderLink = ({ item }: { item: LinkItem }) => (
    <TouchableOpacity style={s.fileRow}
      onPress={() => Linking.openURL(item.url).catch(() => Alert.alert('Can’t open link', 'No app on this device can open this link.'))}
      accessibilityRole="link" accessibilityLabel={`${item.url}, ${fmtDate(item.createdAt)}`}>
      <View style={s.fileIcon}><Ionicons name="link-outline" size={20} color={colors.accent} /></View>
      <View style={s.flex}>
        <Text style={[s.fileName, { color: colors.accent }]} numberOfLines={2}>{item.url}</Text>
        <Text style={s.fileDate}>{fmtDate(item.createdAt)}</Text>
      </View>
    </TouchableOpacity>
  );

  // Sections for the active media tab. Memoised so scrolling does not re-chunk
  // on every render — and so the tile elements keep their identity, which is
  // what stops MediaThumb from re-running its decrypt (see its comment).
  const sections = useMemo(() => {
    if (groupBy === 'none') return [];
    const items = tab === 'photos' ? photos : tab === 'videos' ? videos : [];
    const buckets = new Map<string, Message[]>();
    for (const m of items) {
      const key = groupBy === 'date' ? dayKey(m.createdAt) : (names[String(m.senderId)] ?? 'Member');
      const arr = buckets.get(key);
      if (arr) arr.push(m); else buckets.set(key, [m]);
    }
    return [...buckets.entries()].map(([title, list]) => ({ title, data: toRows(list) }));
  }, [groupBy, tab, photos, videos, names]);

  const GROUPS: { id: GroupBy; label: string }[] = [
    { id: 'none', label: 'All' },
    { id: 'date', label: 'By date' },
    { id: 'member', label: 'By member' },
  ];

  const TABS: { id: TabId; label: string; count: number }[] = [
    { id: 'photos', label: 'Photos', count: photos.length },
    { id: 'videos', label: 'Videos', count: videos.length },
    { id: 'files', label: 'Files', count: files.length },
    { id: 'links', label: 'Links', count: links.length },
  ];

  return (
    <View style={s.container}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />

      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={10} accessibilityRole="button" accessibilityLabel="Back">
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.title} numberOfLines={1} accessibilityRole="header">{(peerName as string) || 'Shared'} Media</Text>
        <View style={s.headSpacer} />
      </View>

      <View style={s.tabs} accessibilityRole="tablist">
        {TABS.map(t => (
          <TouchableOpacity key={t.id} style={[s.tab, tab === t.id && s.tabActive]} onPress={() => setTab(t.id)}
            accessibilityRole="tab" accessibilityLabel={`${t.label}, ${t.count}`} accessibilityState={{ selected: tab === t.id }}>
            <Text style={[s.tabTxt, tab === t.id && s.tabTxtActive]}>{t.label}</Text>
            <Text style={[s.tabCount, tab === t.id && s.tabTxtActive]}>{t.count}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {(tab === 'photos' || tab === 'videos') && (
        <View style={s.groupBar}>
          {GROUPS.map(g => (
            <TouchableOpacity key={g.id} onPress={() => setGroupBy(g.id)}
              accessibilityRole="radio" accessibilityLabel={`Group ${g.label}`} accessibilityState={{ selected: groupBy === g.id }}
              style={[s.groupChip, groupBy === g.id && { borderColor: colors.primary, backgroundColor: colors.primary + '1a' }]}>
              <Text style={[s.groupTxt, groupBy === g.id && { color: colors.primary, fontWeight: '700' }]}>{g.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {loadError === 'stale' && (
        <View style={s.staleBar} accessibilityLiveRegion="polite">
          <Ionicons name="cloud-offline-outline" size={16} color={colors.textDim} />
          <Text style={s.staleTxt}>Showing saved media. Couldn’t refresh.</Text>
          <TouchableOpacity onPress={() => setReloadKey(k => k + 1)} hitSlop={10}
            accessibilityRole="button" accessibilityLabel="Retry loading media">
            <Text style={s.retryLink}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {loading ? (
        <ActivityIndicator color={colors.primary} style={s.spinner} />
      ) : loadError === 'empty' ? (
        <View style={s.errorBox}>
          <Ionicons name="cloud-offline-outline" size={36} color={colors.textDim} />
          <Text style={s.errorTitle}>Couldn’t load shared media</Text>
          <Text style={s.errorBody}>Check your connection and try again.</Text>
          <TouchableOpacity style={s.retryBtn} onPress={() => { setLoading(true); setReloadKey(k => k + 1); }}
            accessibilityRole="button" accessibilityLabel="Retry loading media">
            <Text style={s.retryBtnTxt}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (tab === 'photos' || tab === 'videos') && groupBy !== 'none' ? (
        <SectionList
          sections={sections}
          keyExtractor={(row, i) => `${row.map(m => m.id).join('-')}-${i}`}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={s.gridPad}
          renderSectionHeader={({ section }) => <Text numberOfLines={1} style={s.sectionHdr}>{section.title}</Text>}
          renderItem={({ item: row }) => (
            <View style={s.row}>
              {row.map(m => (
                <React.Fragment key={m.id}>
                  {tab === 'photos' ? renderPhoto({ item: m }) : renderVideo({ item: m })}
                </React.Fragment>
              ))}
            </View>
          )}
          ListEmptyComponent={<Empty label={tab === 'photos' ? 'No photos shared yet' : 'No videos shared yet'} />}
        />
      ) : tab === 'photos' ? (
        <FlatList data={photos} numColumns={3} keyExtractor={m => String(m.id)} renderItem={renderPhoto}
          contentContainerStyle={s.gridPad} ListEmptyComponent={<Empty label="No photos shared yet" />} />
      ) : tab === 'videos' ? (
        <FlatList data={videos} numColumns={3} keyExtractor={m => String(m.id)} renderItem={renderVideo}
          contentContainerStyle={s.gridPad} ListEmptyComponent={<Empty label="No videos shared yet" />} />
      ) : tab === 'files' ? (
        <FlatList data={files} keyExtractor={m => String(m.id)} renderItem={renderFile}
          contentContainerStyle={s.listPad} ListEmptyComponent={<Empty label="No files shared yet" />} />
      ) : (
        <FlatList data={links} keyExtractor={(l, i) => `${l.id}-${i}`} renderItem={renderLink}
          contentContainerStyle={s.listPad} ListEmptyComponent={<Empty label="No links shared yet" />} />
      )}

      {capped && !loading && loadError !== 'empty' && (
        <Text style={s.capNote}>Showing media from the most recent {PAGE * MAX_PAGES} messages.</Text>
      )}
    </View>
  );
}

const Empty = ({ label }: { label: string }) => {
  const s = useS();
  return (
    <View style={s.empty}>
      <Text style={s.emptyTxt}>{label}</Text>
    </View>
  );
};

const makeStyles = (c: Palette, insetTop: number) => StyleSheet.create({
  flex: { flex: 1 },
  headSpacer: { width: 40 },
  spinner: { marginTop: 40 },
  row: { flexDirection: 'row' },
  gridPad: { padding: 8 },
  listPad: { padding: 12 },
  empty: { alignItems: 'center', paddingVertical: 60 },
  emptyTxt: { color: c.textDim, fontSize: 14 },
  container: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: insetTop + 8, paddingHorizontal: 16, paddingBottom: 8, gap: 12 },
  backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  title: { color: c.text, fontSize: 18, fontWeight: '800', flex: 1 },
  tabs: { flexDirection: 'row', paddingHorizontal: 12, paddingTop: 8, gap: 6 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10, backgroundColor: c.glassSoft, borderWidth: 1, borderColor: c.glassStroke },
  tabActive: { backgroundColor: c.primary, borderColor: c.primary },
  tabTxt: { color: c.textDim, fontSize: 12, fontWeight: '700' },
  tabTxtActive: { color: c.onPrimary },   // on the solid primary fill
  tabCount: { color: c.textDim, fontSize: 10, marginTop: 2 },
  groupBar: { flexDirection: 'row', gap: 7, paddingHorizontal: 12, paddingTop: 10 },
  groupChip: { paddingHorizontal: 13, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: c.glassStroke },
  groupTxt: { color: c.textDim, fontSize: 12 },
  sectionHdr: { color: c.text, fontSize: 12.5, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4, paddingHorizontal: 4, paddingTop: 16, paddingBottom: 6 },
  tile: { margin: 4, borderRadius: 8, overflow: 'hidden', backgroundColor: c.surfaceSolid },
  tileImg: { width: '100%', height: '100%' },
  // A scrim over the photo, so it is dark in both themes.
  playBadge: { position: 'absolute', top: '50%', left: '50%', marginLeft: -16, marginTop: -16, width: 32, height: 32, borderRadius: 16, backgroundColor: AuroraDark.scrim, justifyContent: 'center', alignItems: 'center' },   // fixed dark scrim under the fixed light play glyph, over any photo
  fileRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.glassSoft, borderRadius: 12, padding: 12, marginBottom: 6, borderWidth: 1, borderColor: c.glassStroke, gap: 12 },
  fileIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: c.glassSoft, justifyContent: 'center', alignItems: 'center' },
  fileName: { color: c.text, fontSize: 13, fontWeight: '600' },
  fileDate: { color: c.textDim, fontSize: 11, marginTop: 2 },
  staleBar: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 12, marginTop: 10, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: c.glassSoft, borderWidth: 1, borderColor: c.glassStroke },
  staleTxt: { flex: 1, color: c.textDim, fontSize: 12 },
  retryLink: { color: c.accentOn, fontSize: 13, fontWeight: '700' },
  errorBox: { alignItems: 'center', paddingVertical: 60, paddingHorizontal: 24, gap: 8 },
  errorTitle: { color: c.text, fontSize: 16, fontWeight: '700', textAlign: 'center' },
  errorBody: { color: c.textDim, fontSize: 13, textAlign: 'center' },
  retryBtn: { marginTop: 8, paddingHorizontal: 22, paddingVertical: 10, borderRadius: 20, backgroundColor: c.primary },
  retryBtnTxt: { color: c.onPrimary, fontSize: 14, fontWeight: '700' },
  capNote: { color: c.textFaint, fontSize: 11, textAlign: 'center', paddingVertical: 8 },
});
