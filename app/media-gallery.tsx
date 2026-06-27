// app/media-gallery.tsx — Media Gallery per Chat (Postgres-backed).
//
// Photos / Videos / Files / Links shared in a conversation, pulled from the
// real message history (GET /chats/:id/messages) and filtered by type.
// Thumbnails load through the auth'd attachment endpoint; tapping a photo
// opens it in a self-contained full-screen viewer (no dependency on other
// screens). Links open externally. No Firestore.

import React, { useState, useEffect, useCallback , useMemo} from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList, Dimensions, StatusBar,
  ActivityIndicator, Linking, Image, Modal,
} from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { getAccessToken } from '../lib/api';
import { getMessages, getChat, decryptFromChat, attachmentUrl, type Message } from '../lib/chatService';
import { getDecryptedAttachmentUri, parseMediaContent } from '../lib/mediaAttachments';

const { width: SW } = Dimensions.get('window');
const TILE = (SW - 40) / 3;
const PAGE = 200;

type TabId = 'photos' | 'videos' | 'files' | 'links';
interface LinkItem { id: number; url: string; createdAt: string }

function useS() {
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
  const [photos, setPhotos] = useState<Message[]>([]);
  const [videos, setVideos] = useState<Message[]>([]);
  const [files, setFiles] = useState<Message[]>([]);
  const [links, setLinks] = useState<LinkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewer, setViewer] = useState<Message | null>(null); // message being viewed full-screen

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const tok = await getAccessToken();
        if (active) setAuthHeader(tok ? `Bearer ${tok}` : null);
        if (!cid) { setLoading(false); return; }

        // Remember the chat's direct peer so encrypted media content can be
        // decrypted (to recover per-file keys) — same as the chat screen does.
        await getChat(cid).catch(() => {});

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
        const ph: Message[] = [], vd: Message[] = [], fl: Message[] = [], lk: LinkItem[] = [];
        for (const m of all) {
          if (m.deletedAt) continue;
          if (m.type === 'image' && m.meta?.attachmentId) ph.push(m);
          else if (m.type === 'video' && m.meta?.attachmentId) vd.push(m);
          else if (m.type === 'file' && m.meta?.attachmentId) fl.push(m);
          else if (m.type === 'text' && m.content) {
            const found = m.content.match(/https?:\/\/[^\s]+/gi);
            if (found) for (const u of found) lk.push({ id: m.id, url: u, createdAt: m.createdAt });
          }
        }
        setPhotos(ph); setVideos(vd); setFiles(fl); setLinks(lk);
      } catch { /* leaves empties */ } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [cid]);

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

  // Lazy thumbnail: resolves (and decrypts if needed) only when the tile mounts.
  const MediaThumb = useCallback(({ m, style, resizeMode = 'cover' as const }: {
    m: Message; style: any; resizeMode?: 'cover' | 'contain';
  }) => {
    const [src, setSrc] = useState<{ uri: string; headers?: Record<string, string> } | null>(null);
    useEffect(() => {
      let cancel = false;
      (async () => { const r = await resolveSrc(m); if (!cancel) setSrc(r); })();
      return () => { cancel = true; };
    }, [m]);
    if (!src) return <View style={[style, { backgroundColor: colors.surfaceSolid }]} />;
    return <Image source={src} style={style} resizeMode={resizeMode} />;
  }, [resolveSrc]);

  const openFile = useCallback(async (m: Message) => {
    const r = await resolveSrc(m);
    if (!r) return;
    // Decrypted local file → open directly; plaintext → open the auth'd URL.
    Linking.openURL(r.uri).catch(() => {});
  }, [resolveSrc]);

  const renderPhoto = ({ item }: { item: Message }) => (
    <TouchableOpacity style={s.tile} onPress={() => setViewer(item)} activeOpacity={0.8}>
      <MediaThumb m={item} style={s.tileImg} />
    </TouchableOpacity>
  );

  const renderVideo = ({ item }: { item: Message }) => (
    <TouchableOpacity style={s.tile} onPress={() => setViewer(item)} activeOpacity={0.8}>
      <MediaThumb m={item} style={s.tileImg} />
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

  const TABS: { id: TabId; label: string; count: number }[] = [
    { id: 'photos', label: 'Photos', count: photos.length },
    { id: 'videos', label: 'Videos', count: videos.length },
    { id: 'files', label: 'Files', count: files.length },
    { id: 'links', label: 'Links', count: links.length },
  ];

  return (
    <View style={s.container}>
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

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
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
          {viewer && <MediaThumb m={viewer} style={s.viewerImg} resizeMode="contain" />}
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
  container: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 54, paddingHorizontal: 16, paddingBottom: 8, gap: 12 },
  backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  title: { color: c.text, fontSize: 18, fontWeight: '800', flex: 1 },
  tabs: { flexDirection: 'row', paddingHorizontal: 12, paddingTop: 8, gap: 6 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  tabActive: { backgroundColor: c.primary, borderColor: c.primary },
  tabTxt: { color: c.textDim, fontSize: 12, fontWeight: '700' },
  tabTxtActive: { color: '#FFFFFF' },
  tabCount: { color: c.textDim, fontSize: 10, marginTop: 2 },
  tile: { width: TILE, height: TILE, margin: 4, borderRadius: 8, overflow: 'hidden', backgroundColor: c.surfaceSolid },
  tileImg: { width: '100%', height: '100%' },
  playBadge: { position: 'absolute', top: '50%', left: '50%', marginLeft: -16, marginTop: -16, width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  fileRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.card, borderRadius: 12, padding: 12, marginBottom: 6, borderWidth: 1, borderColor: c.border, gap: 12 },
  fileIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: c.surface, justifyContent: 'center', alignItems: 'center' },
  fileName: { color: c.text, fontSize: 13, fontWeight: '600' },
  fileDate: { color: c.textDim, fontSize: 11, marginTop: 2 },
  viewerBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.95)', justifyContent: 'center', alignItems: 'center' },
  viewerClose: { position: 'absolute', top: 54, right: 20, zIndex: 10 },
  viewerImg: { width: '100%', height: '80%' },
});
