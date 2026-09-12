// app/contact-info.tsx — Contact Info (Postgres-backed).
//
// Real peer header (name / online / last seen from GET /chats/:id), mute via
// /chats/:id/mute, block via /user/blocks, and Shared Media / Files / Links
// derived from the actual message history (GET /chats/:id/messages). The old
// mocked sections and the unconditional "E2E encrypted" banner are gone — the
// encryption card now reflects the real E2EE_ENABLED flag so we don't claim a
// guarantee the build doesn't yet provide.

import { brandAlpha, type Palette } from '../constants/theme';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, StatusBar, ScrollView, Dimensions, Alert, Image, ActivityIndicator, Linking, Switch, useWindowDimensions } from 'react-native';
import { getShareViewing, setShareViewing } from '../lib/viewerPrefs';
import LinkPreview from '../components/LinkPreview';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { E2EE_ENABLED } from '../constants/flags';
import { getAccessToken } from '../lib/api';
import {
  getChat, getMessages, muteChat, listBlocks, blockUser, unblockUser, reportUser,
  decryptFromChat, attachmentUrl, getCommonGroups, type Message, type ChatMember,
} from '../lib/chatService';
import { getDecryptedAttachmentUri, parseMediaContent } from '../lib/mediaAttachments';
import { readCache, writeCache } from '../lib/localCache';
import { unionWithLocalHistory } from '../lib/messageHistory';
import { Avatar, AuroraBackground } from '../components/ui';

const { width: SW } = Dimensions.get('window');
const MEDIA_SIZE = (SW - 32 - 8) / 3;
const URL_RE = /(https?:\/\/[^\s]+)/gi;

interface LinkHit { id: number; url: string }
interface FileHit { id: number; name: string }

// Shape persisted to the local-first cache so a re-open paints instantly.
interface ContactInfoCache {
  peer: ChatMember | null;
  muted: boolean;
  blocked: boolean;
  media: Message[];
  files: FileHit[];
  links: LinkHit[];
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

export default function ContactInfoScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const s = useS();
  const { peerUid, peerName, chatId } = useLocalSearchParams<{ peerUid: string; peerName: string; chatId: string }>();

  const [peer, setPeer] = useState<ChatMember | null>(null);
  const [muted, setMuted] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [shareViewing, setShareViewingState] = useState(true);   // Live Chat Viewers (#58)
  useEffect(() => { if (chatId) getShareViewing(chatId, false).then(setShareViewingState).catch(() => {}); }, [chatId]);
  const toggleShareViewing = useCallback((on: boolean) => {
    setShareViewingState(on);
    setShareViewing(chatId, on).catch(() => {});
  }, [chatId]);
  const [authHeader, setAuthHeader] = useState<string | null>(null);
  const [media, setMedia] = useState<Message[]>([]);
  const [files, setFiles] = useState<FileHit[]>([]);
  const [links, setLinks] = useState<LinkHit[]>([]);
  const [commonGroups, setCommonGroups] = useState<{ id: string; name: string | null; photoURL: string | null }[]>([]);
  const [loading, setLoading] = useState(true);

  const displayName = peer?.name || peerName || 'Contact';

  useEffect(() => { if (peerUid) getCommonGroups(peerUid).then(setCommonGroups).catch(() => {}); }, [peerUid]);

  useEffect(() => {
    let active = true;
    // Cache key includes the chat id so different conversations don't collide.
    const cacheKey = 'contact-info:' + (chatId || peerUid || '');
    let painted = false;
    (async () => {
      // Local-first: paint the last-known snapshot instantly, before the network.
      const cached = chatId || peerUid ? await readCache<ContactInfoCache>(cacheKey) : null;
      if (active && cached) {
        if (cached.peer) setPeer(cached.peer);
        setMuted(cached.muted);
        setBlocked(cached.blocked);
        setMedia(cached.media);
        setFiles(cached.files);
        setLinks(cached.links);
        setLoading(false);
        painted = true;
      }

      try {
        const tok = await getAccessToken();
        if (active) setAuthHeader(tok ? `Bearer ${tok}` : null);

        const tasks: Promise<any>[] = [listBlocks()];
        if (chatId) tasks.push(getChat(chatId), getMessages(chatId, { limit: 200 }));
        const [blocks, chat, msgs] = await Promise.all(tasks);

        if (!active) return;

        let nextBlocked = blocked;
        let nextMuted = muted;
        let nextPeer = peer;
        if (peerUid) { nextBlocked = (blocks as any[]).some(b => b.userId === peerUid); setBlocked(nextBlocked); }
        if (chat) {
          nextMuted = !!chat.muted;
          setMuted(nextMuted);
          const p = chat.members.find((m: ChatMember) => m.userId === peerUid && !m.leftAt)
            ?? chat.members.find((m: ChatMember) => m.userId === peerUid);
          if (p) { nextPeer = p; setPeer(p); }
        }
        // Union with the local cache before classifying. delete-on-delivery
        // nulls a delivered body and the media sweep purges its bytes, so the
        // server list alone drops shared media the device can still render —
        // and writing that back to the cache erased it for good.
        const unioned = await unionWithLocalHistory(chatId, (msgs as Message[]) ?? [], 400);
        const buckets = unioned.length ? classify(unioned) : { media, files, links };

        if (chatId || peerUid) {
          writeCache<ContactInfoCache>(cacheKey, {
            peer: nextPeer, muted: nextMuted, blocked: nextBlocked,
            media: buckets.media, files: buckets.files, links: buckets.links,
          });
        }
      } catch {
        // Non-fatal: header still renders from params (and cache, if painted).
      } finally {
        if (active && !painted) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [chatId, peerUid]);

  const classify = (msgs: Message[]) => {
    const med: Message[] = [], fil: FileHit[] = [], lnk: LinkHit[] = [];
    for (const m of msgs) {
      if (m.deletedAt) continue;
      if (m.type === 'image' || m.type === 'video') med.push(m);
      else if (m.type === 'file') fil.push({ id: m.id, name: m.meta?.fileName || m.meta?.name || 'File' });
      else if (m.type === 'text' && m.content) {
        const found = m.content.match(URL_RE);
        if (found) for (const u of found) lnk.push({ id: m.id, url: u });
      }
    }
    const out = { media: med.slice(0, 9), files: fil.slice(0, 5), links: lnk.slice(0, 5) };
    setMedia(out.media);
    setFiles(out.files);
    setLinks(out.links);
    return out;
  };

  const lastSeenText = useCallback(() => {
    if (peer?.online) return 'Online';
    if (peer?.lastSeenAt) {
      try { return 'Last seen ' + new Date(peer.lastSeenAt).toLocaleString(); } catch { /* noop */ }
    }
    return 'Last seen recently';
  }, [peer]);

  const toggleMute = async () => {
    if (!chatId) return;
    const next = !muted;
    setMuted(next);
    try { await muteChat(chatId, next); } catch (e: any) { setMuted(!next); Alert.alert('Error', e?.message ?? 'Mute failed'); }
  };

  const toggleBlock = () => {
    if (!peerUid) return;
    if (blocked) {
      Alert.alert(`Unblock ${displayName}?`, '', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Unblock', onPress: async () => {
          setBlocked(false);
          try { await unblockUser(peerUid); } catch (e: any) { setBlocked(true); Alert.alert('Error', e?.message ?? 'Failed'); }
        } },
      ]);
      return;
    }
    Alert.alert(`Block ${displayName}?`, 'Blocked contacts cannot start new chats with you.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Block', style: 'destructive', onPress: async () => {
        setBlocked(true);
        try { await blockUser(peerUid); } catch (e: any) { setBlocked(false); Alert.alert('Error', e?.message ?? 'Failed'); }
      } },
    ]);
  };

  const reportAndBlock = () => {
    if (!peerUid) return;
    Alert.alert(`Report ${displayName}?`, 'This files a report for review and blocks the contact.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Report & block', style: 'destructive', onPress: async () => {
        setBlocked(true);
        try {
          await reportUser(peerUid, 'reported_from_contact_info', chatId ? String(chatId) : undefined);
          await blockUser(peerUid);
          Alert.alert('Done', `${displayName} was reported and blocked.`);
        } catch (e: any) {
          setBlocked(false);
          Alert.alert('Error', e?.message ?? 'Failed');
        }
      } },
    ]);
  };

  const initials = (displayName).split(' ').map(w => w[0]).join('').toUpperCase().substring(0, 2) || '?';

  const ActionButton = ({ icon, label, onPress, active }: { icon: any; label: string; onPress: () => void; active?: boolean }) => (
    <TouchableOpacity style={s.actionBtn} activeOpacity={0.7} onPress={onPress}>
      <View style={[s.actionIcon, active && { borderColor: colors.primary, backgroundColor: brandAlpha(0.12) }]}>
        <Ionicons name={icon} size={22} color={active ? colors.primary : colors.text} />
      </View>
      <Text style={[s.actionLabel, { color: active ? colors.primary : colors.textDim }]}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <View style={s.root}>
      <AuroraBackground />
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <Stack.Screen options={{ headerShown: false }} />

      <ScrollView contentContainerStyle={{ paddingBottom: 60 }}>
        <View style={s.hero}>
          <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={10}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>

          <View style={{ marginTop: 12 }}>
            <Avatar
              uri={peer?.photoURL && authHeader ? attachmentUrl(peer.photoURL) : null}
              headers={authHeader ? { Authorization: authHeader } : undefined}
              name={displayName}
              size={100}
              presence={peer?.online ? 'online' : null} ring />
          </View>

          <Text numberOfLines={1} style={s.heroName}>{displayName}</Text>
          <Text style={[s.heroStatus, peer?.online && { color: colors.online }]}>{lastSeenText()}</Text>
          {!!peer?.email && <Text style={s.heroPhone}>{peer.email}</Text>}
        </View>

        <View style={s.actionsRow}>
          <ActionButton icon="call-outline" label="Call" onPress={() => router.push({ pathname: '/voicecall', params: { chatId, peerUid, peerName: displayName } } as any)} />
          <ActionButton icon="videocam-outline" label="Video" onPress={() => router.push({ pathname: '/videocall', params: { chatId, peerUid, peerName: displayName } } as any)} />
          <ActionButton icon="search-outline" label="Search" onPress={() => router.push({ pathname: '/in-chat-search', params: { chatId } } as any)} />
          <ActionButton icon={muted ? 'notifications-off-outline' : 'notifications-outline'} label={muted ? 'Unmute' : 'Mute'} active={muted} onPress={toggleMute} />
          <ActionButton icon={blocked ? 'lock-closed-outline' : 'ban-outline'} label={blocked ? 'Unblock' : 'Block'} active={blocked} onPress={toggleBlock} />
        </View>

        {/* Live Chat Viewers (#58) — share whether you're currently viewing this chat */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>Privacy</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8 }}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>Share my viewing status</Text>
              <Text style={{ color: colors.textDim, fontSize: 12, marginTop: 2 }}>Let {displayName} see when you’re viewing this chat right now</Text>
            </View>
            <Switch value={shareViewing} onValueChange={toggleShareViewing} trackColor={{ true: colors.primary, false: colors.border }} thumbColor="#fff" />
          </View>
        </View>

        {/* About (peer's status text) */}
        {!!peer?.status && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>About</Text>
            <Text style={s.aboutText}>{peer.status}</Text>
          </View>
        )}

        {loading && <ActivityIndicator color={colors.primary} style={{ marginTop: 20 }} />}

        {/* Shared Media */}
        {media.length > 0 && (
          <View style={s.section}>
            <View style={s.sectionHeader}>
              <Text style={s.sectionTitle}>Shared Media</Text>
              <TouchableOpacity onPress={() => router.push({ pathname: '/media-gallery', params: { chatId } } as any)}>
                <Text style={s.seeAll}>See All</Text>
              </TouchableOpacity>
            </View>
            <View style={s.mediaGrid}>
              {media.map(m => (
                <View key={m.id} style={s.mediaTile}>
                  <SharedMediaThumb m={m} chatId={chatId} authHeader={authHeader} />
                  {m.type === 'video' && <View style={s.videoBadge}><Ionicons name="play" size={12} color="#fff" /></View>}
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Shared Files */}
        {files.length > 0 && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Shared Files</Text>
            {files.map(f => (
              <View key={f.id} style={s.fileRow}>
                <View style={s.fileIcon}><Ionicons name="document-text-outline" size={20} color={colors.textDim} /></View>
                <Text style={s.fileName} numberOfLines={1}>{f.name}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Shared Links — preview card (OG) + tappable URL */}
        {links.length > 0 && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Shared Links</Text>
            {links.slice(0, 20).map(l => (
              <TouchableOpacity key={`${l.id}-${l.url}`} activeOpacity={0.7} onPress={() => Linking.openURL(l.url).catch(() => {})}>
                <View style={s.linkRow}>
                  <View style={s.linkIcon}><Ionicons name="link-outline" size={18} color={colors.textDim} /></View>
                  <Text style={s.linkUrl} numberOfLines={1}>{l.url}</Text>
                </View>
                <LinkPreview url={l.url} />
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Groups in common (WhatsApp) */}
        {commonGroups.length > 0 && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>{commonGroups.length} group{commonGroups.length > 1 ? 's' : ''} in common</Text>
            {commonGroups.map(g => (
              <TouchableOpacity key={g.id} style={s.fileRow} activeOpacity={0.7}
                onPress={() => router.push({ pathname: '/group-info', params: { id: g.id } } as any)}>
                <Avatar uri={g.photoURL && authHeader ? attachmentUrl(g.photoURL) : null} headers={authHeader ? { Authorization: authHeader } : undefined} name={g.name || 'Group'} size={40} ring />
                <Text style={s.fileName} numberOfLines={1}>{g.name || 'Group'}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Encryption status — honest about the current flag state. Tapping
            opens the safety-number verification (WhatsApp's "Verify"). */}
        <View style={s.section}>
          <TouchableOpacity
            style={s.encryptionCard}
            activeOpacity={E2EE_ENABLED && peerUid ? 0.7 : 1}
            disabled={!E2EE_ENABLED || !peerUid}
            onPress={() => router.push({ pathname: '/verify-contact' as any, params: { peerId: peerUid, peerName: displayName } })}
          >
            <MaterialCommunityIcons name={E2EE_ENABLED ? 'shield-lock' : 'lock-outline'} size={22} color={colors.primary} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={s.encTitle}>{E2EE_ENABLED ? 'End-to-End Encrypted' : 'Encrypted in Transit'}</Text>
              <Text style={s.encSubtitle}>
                {E2EE_ENABLED
                  ? 'Messages are end-to-end encrypted. Tap to verify the security code.'
                  : 'Messages are encrypted in transit (TLS). End-to-end encryption is rolling out.'}
              </Text>
            </View>
            {E2EE_ENABLED && !!peerUid && <Ionicons name="chevron-forward" size={18} color={colors.textDim} />}
          </TouchableOpacity>
        </View>

        {/* Ghost Mode */}
        <View style={s.section}>
          <TouchableOpacity
            style={[s.encryptionCard, { borderColor: 'rgba(139,92,246,0.25)', backgroundColor: 'rgba(139,92,246,0.06)' }]}
            activeOpacity={0.7}
            onPress={() => router.push({ pathname: '/ghost-mode' as any, params: { contactUid: peerUid, contactName: displayName } })}
          >
            <Text style={{ fontSize: 22 }}>{'👻'}</Text>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={[s.encTitle, { color: colors.purple }]}>Ghost Mode</Text>
              <Text style={s.encSubtitle}>Hide your online status, typing, read receipts, and last seen from this contact.</Text>
            </View>
          </TouchableOpacity>
        </View>

        {/* Block & Report */}
        <View style={[s.section, { marginBottom: 20 }]}>
          <TouchableOpacity style={s.dangerBtn} activeOpacity={0.7} onPress={toggleBlock}>
            <Ionicons name={blocked ? 'lock-open-outline' : 'ban-outline'} size={20} color={colors.danger} />
            <Text style={s.dangerText}>{blocked ? `Unblock ${displayName}` : `Block ${displayName}`}</Text>
          </TouchableOpacity>
          {!blocked && (
            <TouchableOpacity style={[s.dangerBtn, { marginTop: 8 }]} activeOpacity={0.7} onPress={reportAndBlock}>
              <Ionicons name="flag-outline" size={20} color={colors.danger} />
              <Text style={s.dangerText}>Report {displayName}</Text>
            </TouchableOpacity>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

// Shared-media thumbnail. Decrypts encrypted attachments (recovering the per-file
// key from the message content) to a local file; renders plaintext via the auth'd
// /uploads URL. Falls back to a placeholder icon while resolving / on failure.
function SharedMediaThumb({ m, chatId, authHeader }: {
  m: Message; chatId?: string; authHeader: string | null;
}) {
  const { colors } = useTheme();
  const s = useS();
  const [src, setSrc] = useState<{ uri: string; headers?: Record<string, string> } | null>(null);
  useEffect(() => {
    let cancel = false;
    (async () => {
      const aid = m.meta?.attachmentId;
      if (!aid) return;
      if (m.meta?.encrypted) {
        try {
          const plain = await decryptFromChat(String(chatId || ''), m.senderId, m.content, m.id);
          await parseMediaContent(aid, plain);
          const r = await getDecryptedAttachmentUri(aid);
          if (!cancel) setSrc(r);
        } catch { /* leave placeholder */ }
      } else if (authHeader) {
        if (!cancel) setSrc({ uri: attachmentUrl(aid), headers: { Authorization: authHeader } });
      }
    })();
    return () => { cancel = true; };
  }, [m, chatId, authHeader]);
  if (!src) return <Ionicons name={m.type === 'video' ? 'videocam' : 'image'} size={24} color={colors.textFaint} />;
  return <Image source={src} style={s.mediaImg} />;
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  hero: { alignItems: 'center', paddingTop: 54, paddingBottom: 24 },
  backBtn: { position: 'absolute', top: 54, left: 16, zIndex: 10 },
  avatar: { width: 100, height: 100, borderRadius: 50, marginTop: 12, backgroundColor: c.surfaceSolid, borderWidth: 1, borderColor: c.glassStroke, justifyContent: 'center', alignItems: 'center', overflow: 'visible' },
  avatarImg: { width: 100, height: 100, borderRadius: 50 },
  avatarText: { color: c.accent, fontSize: 32, fontWeight: '700' },
  onlineDot: { width: 16, height: 16, borderRadius: 8, backgroundColor: c.online, borderWidth: 3, borderColor: c.bg, position: 'absolute', bottom: 4, right: 4 },
  heroName: { color: c.text, fontSize: 24, fontWeight: '700', marginTop: 14 },
  heroStatus: { color: c.textDim, fontSize: 14, marginTop: 4 },
  heroPhone: { color: c.textFaint, fontSize: 14, marginTop: 4 },
  actionsRow: { flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 10, paddingVertical: 16, borderBottomWidth: 1, borderColor: c.hairline },
  actionBtn: { alignItems: 'center', gap: 6 },
  actionIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: c.glassSoft, borderWidth: 1, borderColor: c.glassStroke, justifyContent: 'center', alignItems: 'center' },
  actionLabel: { fontSize: 12, fontWeight: '500' },
  section: { paddingHorizontal: 16, marginTop: 20 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionTitle: { color: c.textDim, fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 },
  aboutText: { color: c.text, fontSize: 15, lineHeight: 21 },
  seeAll: { color: c.accent, fontSize: 13, fontWeight: '600', marginBottom: 12 },
  mediaGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  mediaTile: { width: MEDIA_SIZE, height: MEDIA_SIZE, borderRadius: 8, backgroundColor: c.surfaceSolid, justifyContent: 'center', alignItems: 'center', overflow: 'hidden' },
  mediaImg: { width: '100%', height: '100%' },
  videoBadge: { position: 'absolute', width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  fileRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.glassSoft, borderRadius: 12, borderWidth: 1, borderColor: c.glassStroke, padding: 12, marginBottom: 6, gap: 12 },
  fileIcon: { width: 38, height: 38, borderRadius: 10, backgroundColor: 'rgba(6,182,212,0.12)', justifyContent: 'center', alignItems: 'center' },
  fileName: { flex: 1, color: c.text, fontSize: 14, fontWeight: '500' },
  linkRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.glassSoft, borderRadius: 12, borderWidth: 1, borderColor: c.glassStroke, padding: 12, marginBottom: 6, gap: 12 },
  linkIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: 'rgba(6,182,212,0.12)', justifyContent: 'center', alignItems: 'center' },
  linkUrl: { flex: 1, color: c.accent, fontSize: 13 },
  encryptionCard: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: brandAlpha(0.06), borderRadius: 12, borderWidth: 1, borderColor: brandAlpha(0.2), padding: 14 },
  encTitle: { color: c.primary, fontSize: 14, fontWeight: '600' },
  encSubtitle: { color: c.textDim, fontSize: 12, lineHeight: 18, marginTop: 4 },
  dangerBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(239,68,68,0.06)', borderRadius: 12, borderWidth: 1, borderColor: 'rgba(239,68,68,0.22)', padding: 14, gap: 10 },
  dangerText: { color: c.danger, fontSize: 15, fontWeight: '600' },
});
