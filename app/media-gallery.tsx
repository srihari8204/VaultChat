// app/media-gallery.tsx — Media Gallery per Chat (Postgres-backed).
//
// Photos / Videos / Files / Links shared in a conversation, pulled from the
// real message history (GET /chats/:id/messages) and filtered by type.
// Thumbnails load through the auth'd attachment endpoint; tapping a photo
// opens it in a self-contained full-screen viewer (no dependency on other
// screens). Links open externally. No Firestore.

import { HEADER_TOP } from '../constants/layout';
import React, { useState, useEffect, useCallback , useMemo, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList, SectionList, Dimensions, StatusBar,
  ActivityIndicator, Alert, Linking, Modal, useWindowDimensions } from 'react-native';
import * as Sharing from 'expo-sharing';
// expo-image: the 3-up grid recycles tiles, so cache + recyclingKey matter here.
import { Image } from 'expo-image';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { getAccessToken } from '../lib/api';
import { getMessages, getChat, decryptFromChat, attachmentUrl, type Message } from '../lib/chatService';
import { getDecryptedAttachmentUri, parseMediaContent } from '../lib/mediaAttachments';
import { resolveAttachmentFile, viewerRouteFor } from '../lib/docOpen';
import { MediaKeyMissingError } from '../lib/mediaStore';
import { getCurrentUserAsync } from './(constants)/authService';
import { readCache, writeCache } from '../lib/localCache';
import { unionWithLocalHistory } from '../lib/messageHistory';
import { AuroraBackground } from '../components/ui';

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

type ThumbSrc = { uri: string; headers?: Record<string, string> } | null;

/** Split a message list into the gallery's four buckets. */
function bucket(msgs: Message[]) {
  const photos: Message[] = [], videos: Message[] = [], files: Message[] = [], links: LinkItem[] = [];
  for (const m of msgs) {
    if (m.deletedAt) continue;
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
  style: any;
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
  return <Image source={src} style={style} contentFit={resizeMode} cachePolicy="memory-disk" recyclingKey={String(m.id)} />;
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
  // Reactive size. The module-level Dimensions.get above is captured ONCE at
  // import and never updates, so it froze the layout at the size the app
  // launched with. Shadowing it here makes every use in this component follow
  // rotation; StyleSheet.create keeps the initial value, which is fine for
  // static rules.
  const {width: SW} = useWindowDimensions();

  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function MediaGalleryScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const { chatId, id: idParam, peerName } = useLocalSearchParams<{ chatId?: string; id?: string; peerName?: string }>();
  const cid = String(chatId ?? idParam ?? '');

  const [tab, setTab] = useState<TabId>('photos');
  const [authHeader, setAuthHeader] = useState<string | null>(null);
  // Who we are, so a file WE sent resolves to the Sent/ copy already on disk
  // instead of being downloaded back from the server.
  const [meId, setMeId] = useState<string | null>(null);
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
  const [viewer, setViewer] = useState<Message | null>(null); // message being viewed full-screen
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    // Cache key includes the chat id so different chats' galleries don't collide.
    const cacheKey = 'media-gallery:' + cid;
    let painted = false;
    (async () => {
      // Local-first: paint the cached buckets instantly so the gallery opens
      // without a spinner; individual thumbnails still decrypt on demand.
      if (cid) {
        const cached = await readCache<GalleryCache>(cacheKey);
        if (active && cached) {
          setPhotos(cached.photos); setVideos(cached.videos);
          setFiles(cached.files); setLinks(cached.links);
          setLoading(false);
          painted = true;
        }
      }

      try {
        const tok = await getAccessToken();
        if (active) setAuthHeader(tok ? `Bearer ${tok}` : null);
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
        for (let i = 0; i < 5; i++) {
          const page = await getMessages(cid, { before, limit: PAGE });
          all.push(...page);
          if (page.length < PAGE) break;
          before = page[page.length - 1].id;
        }
        if (!active) return;

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
      } catch {
        // Keep painted cache on error; only "empty" when there was nothing cached.
      } finally {
        if (active && !painted) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [cid]);

  useEffect(() => {
    getCurrentUserAsync()
      .then((u: any) => setMeId(u?.id != null ? String(u.id) : null))
      .catch(() => {});
  }, []);

  const fmtDate = useCallback((iso: string) => { try { return new Date(iso).toLocaleDateString(); } catch { return ''; } }, []);

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
        const plain = await decryptFromChat(cid, m.senderId, m.content, m.id);
        await parseMediaContent(aid, plain);
        return await getDecryptedAttachmentUri(aid);
      } catch { return null; }
    }
    return { uri: attachmentUrl(aid), headers: authHeader ? { Authorization: authHeader } : undefined };
  }, [cid, authHeader]);


  const openFile = useCallback(async (m: Message) => {
    // This used to be Linking.openURL(r.uri), and it could not work either way
    // round. For a plaintext attachment `r.uri` is the /uploads URL and the
    // headers were dropped, so the file opened in the SYSTEM BROWSER — which
    // holds no bearer token and so rendered a 401, after taking a VaultChat
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
      // Encrypted attachments keep their per-file key inside the message body,
      // so the body has to be decrypted before the store can find it. Same two
      // calls resolveSrc makes, and the reason they cannot be skipped here.
      if (m.meta?.encrypted) {
        const plain = await decryptFromChat(cid, m.senderId, m.content, m.id);
        await parseMediaContent(String(aid), plain);
      }
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
      } as any);
    } catch (e: any) {
      // A missing key is a STATE, not a crash: it is the normal situation after
      // a reinstall, and saying so is the difference between an explicable
      // screen and "nothing happens when I tap".
      Alert.alert(
        'Can’t open file',
        e instanceof MediaKeyMissingError
          ? 'This file is end-to-end encrypted and this device no longer holds its key.'
          : e?.message ?? 'Try again',
      );
    } finally {
      openingRef.current = null;
    }
  }, [cid, meId, router]);

  const renderPhoto = ({ item }: { item: Message }) => (
    <TouchableOpacity style={[s.tile, { width: tileSize, height: tileSize }]} onPress={() => setViewer(item)} activeOpacity={0.8}>
      <MediaThumb m={item} style={s.tileImg} resolveSrc={resolveSrc} placeholder={colors.surfaceSolid} />
    </TouchableOpacity>
  );

  const renderVideo = ({ item }: { item: Message }) => (
    <TouchableOpacity style={[s.tile, { width: tileSize, height: tileSize }]} onPress={() => setViewer(item)} activeOpacity={0.8}>
      <MediaThumb m={item} style={s.tileImg} resolveSrc={resolveSrc} placeholder={colors.surfaceSolid} />
      <View style={s.playBadge}><Ionicons name="play" size={16} color="#fff" /></View>
    </TouchableOpacity>
  );

  const renderFile = ({ item }: { item: Message }) => (
    <TouchableOpacity style={s.fileRow} onPress={() => openFile(item)}>
      <View style={s.fileIcon}><Ionicons name="document-text-outline" size={22} color={colors.accent} /></View>
      <View style={{ flex: 1 }}>
        <Text style={s.fileName} numberOfLines={1}>{item.meta?.fileName || item.meta?.name || item.meta?.filename || 'File'}</Text>
        <Text style={s.fileDate}>{fmtDate(item.createdAt)}</Text>
      </View>
      <Ionicons name="download-outline" size={18} color={colors.textDim} />
    </TouchableOpacity>
  );

  const renderLink = ({ item }: { item: LinkItem }) => (
    <TouchableOpacity style={s.fileRow} onPress={() => Linking.openURL(item.url).catch(() => {})}>
      <View style={s.fileIcon}><Ionicons name="link-outline" size={20} color={colors.accent} /></View>
      <View style={{ flex: 1 }}>
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
      <StatusBar barStyle="light-content" />

      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.title} numberOfLines={1}>{(peerName as string) || 'Shared'} Media</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={s.tabs}>
        {TABS.map(t => (
          <TouchableOpacity key={t.id} style={[s.tab, tab === t.id && s.tabActive]} onPress={() => setTab(t.id)}>
            <Text style={[s.tabTxt, tab === t.id && s.tabTxtActive]}>{t.label}</Text>
            <Text style={[s.tabCount, tab === t.id && { color: '#FFFFFF' }]}>{t.count}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {(tab === 'photos' || tab === 'videos') && (
        <View style={s.groupBar}>
          {GROUPS.map(g => (
            <TouchableOpacity key={g.id} onPress={() => setGroupBy(g.id)}
              style={[s.groupChip, groupBy === g.id && { borderColor: colors.primary, backgroundColor: colors.primary + '1a' }]}>
              <Text style={[s.groupTxt, groupBy === g.id && { color: colors.primary, fontWeight: '700' }]}>{g.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
      ) : (tab === 'photos' || tab === 'videos') && groupBy !== 'none' ? (
        <SectionList
          sections={sections}
          keyExtractor={(row, i) => `${row.map(m => m.id).join('-')}-${i}`}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={{ padding: 8 }}
          renderSectionHeader={({ section }) => <Text numberOfLines={1} style={s.sectionHdr}>{section.title}</Text>}
          renderItem={({ item: row }) => (
            <View style={{ flexDirection: 'row' }}>
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
          contentContainerStyle={{ padding: 8 }} ListEmptyComponent={<Empty label="No photos shared yet" />} />
      ) : tab === 'videos' ? (
        <FlatList data={videos} numColumns={3} keyExtractor={m => String(m.id)} renderItem={renderVideo}
          contentContainerStyle={{ padding: 8 }} ListEmptyComponent={<Empty label="No videos shared yet" />} />
      ) : tab === 'files' ? (
        <FlatList data={files} keyExtractor={m => String(m.id)} renderItem={renderFile}
          contentContainerStyle={{ padding: 12 }} ListEmptyComponent={<Empty label="No files shared yet" />} />
      ) : (
        <FlatList data={links} keyExtractor={(l, i) => `${l.id}-${i}`} renderItem={renderLink}
          contentContainerStyle={{ padding: 12 }} ListEmptyComponent={<Empty label="No links shared yet" />} />
      )}

      {/* Self-contained full-screen photo viewer */}
      <Modal visible={!!viewer} transparent animationType="fade" onRequestClose={() => setViewer(null)}>
        <View style={s.viewerBg}>
          <TouchableOpacity style={s.viewerClose} onPress={() => setViewer(null)} hitSlop={12}>
            <Ionicons name="close" size={28} color="#fff" />
          </TouchableOpacity>
          {viewer && <MediaThumb m={viewer} style={s.viewerImg} resizeMode="contain" resolveSrc={resolveSrc} placeholder={colors.surfaceSolid} />}
        </View>
      </Modal>
    </View>
  );
}

const Empty = ({ label }: { label: string }) => {
  const { colors } = useTheme();
  return (
    <View style={{ alignItems: 'center', paddingVertical: 60 }}>
      <Text style={{ color: colors.textDim, fontSize: 14 }}>{label}</Text>
    </View>
  );
};

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: HEADER_TOP, paddingHorizontal: 16, paddingBottom: 8, gap: 12 },
  backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  title: { color: c.text, fontSize: 18, fontWeight: '800', flex: 1 },
  tabs: { flexDirection: 'row', paddingHorizontal: 12, paddingTop: 8, gap: 6 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10, backgroundColor: c.glassSoft, borderWidth: 1, borderColor: c.glassStroke },
  tabActive: { backgroundColor: c.primary, borderColor: c.primary },
  tabTxt: { color: c.textDim, fontSize: 12, fontWeight: '700' },
  tabTxtActive: { color: '#FFFFFF' },
  tabCount: { color: c.textDim, fontSize: 10, marginTop: 2 },
  groupBar: { flexDirection: 'row', gap: 7, paddingHorizontal: 12, paddingTop: 10 },
  groupChip: { paddingHorizontal: 13, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: c.glassStroke },
  groupTxt: { color: c.textDim, fontSize: 12 },
  sectionHdr: { color: c.text, fontSize: 12.5, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4, paddingHorizontal: 4, paddingTop: 16, paddingBottom: 6 },
  tile: { margin: 4, borderRadius: 8, overflow: 'hidden', backgroundColor: c.surfaceSolid },
  tileImg: { width: '100%', height: '100%' },
  playBadge: { position: 'absolute', top: '50%', left: '50%', marginLeft: -16, marginTop: -16, width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  fileRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.glassSoft, borderRadius: 12, padding: 12, marginBottom: 6, borderWidth: 1, borderColor: c.glassStroke, gap: 12 },
  fileIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: c.glassSoft, justifyContent: 'center', alignItems: 'center' },
  fileName: { color: c.text, fontSize: 13, fontWeight: '600' },
  fileDate: { color: c.textDim, fontSize: 11, marginTop: 2 },
  viewerBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.95)', justifyContent: 'center', alignItems: 'center' },
  viewerClose: { position: 'absolute', top: 54, right: 20, zIndex: 10 },
  viewerImg: { width: '100%', height: '80%' },
});
