// app/contact-info.tsx — Contact Info (Postgres-backed).
//
// Real peer header (name / online / last seen from GET /chats/:id), mute via
// /chats/:id/mute, block via /user/blocks, and Shared Media / Files / Links
// derived from the actual message history (GET /chats/:id/messages). The old
// mocked sections and the unconditional "E2E encrypted" banner are gone — the
// encryption card now reflects the real E2EE_ENABLED flag so we don't claim a
// guarantee the build doesn't yet provide.

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, StatusBar, ScrollView, Dimensions, Alert, Image, ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Aurora } from '../constants/theme';
import { E2EE_ENABLED } from '../constants/flags';
import { getAccessToken } from '../lib/api';
import {
  getChat, getMessages, muteChat, listBlocks, blockUser, unblockUser, reportUser,
  attachmentUrl, type Message, type ChatMember,
} from '../lib/chatService';

const { width: SW } = Dimensions.get('window');
const MEDIA_SIZE = (SW - 32 - 8) / 3;
const URL_RE = /(https?:\/\/[^\s]+)/gi;

interface LinkHit { id: number; url: string }
interface FileHit { id: number; name: string }

export default function ContactInfoScreen() {
  const router = useRouter();
  const { peerUid, peerName, chatId } = useLocalSearchParams<{ peerUid: string; peerName: string; chatId: string }>();

  const [peer, setPeer] = useState<ChatMember | null>(null);
  const [muted, setMuted] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [authHeader, setAuthHeader] = useState<string | null>(null);
  const [media, setMedia] = useState<Message[]>([]);
  const [files, setFiles] = useState<FileHit[]>([]);
  const [links, setLinks] = useState<LinkHit[]>([]);
  const [loading, setLoading] = useState(true);

  const displayName = peer?.name || peerName || 'Contact';

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const tok = await getAccessToken();
        if (active) setAuthHeader(tok ? `Bearer ${tok}` : null);

        const tasks: Promise<any>[] = [listBlocks()];
        if (chatId) tasks.push(getChat(chatId), getMessages(chatId, { limit: 200 }));
        const [blocks, chat, msgs] = await Promise.all(tasks);

        if (!active) return;
        if (peerUid) setBlocked((blocks as any[]).some(b => b.userId === peerUid));
        if (chat) {
          setMuted(!!chat.muted);
          const p = chat.members.find((m: ChatMember) => m.userId === peerUid && !m.leftAt)
            ?? chat.members.find((m: ChatMember) => m.userId === peerUid);
          if (p) setPeer(p);
        }
        if (msgs) classify(msgs as Message[]);
      } catch {
        // Non-fatal: header still renders from params.
      } finally {
        if (active) setLoading(false);
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
    setMedia(med.slice(0, 9));
    setFiles(fil.slice(0, 5));
    setLinks(lnk.slice(0, 5));
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
      <View style={[s.actionIcon, active && { borderColor: Aurora.primary, backgroundColor: 'rgba(16,185,129,0.12)' }]}>
        <Ionicons name={icon} size={22} color={active ? Aurora.primary : Aurora.accent} />
      </View>
      <Text style={[s.actionLabel, { color: active ? Aurora.primary : Aurora.textDim }]}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={Aurora.bg} />
      <Stack.Screen options={{ headerShown: false }} />

      <ScrollView contentContainerStyle={{ paddingBottom: 60 }}>
        <View style={s.hero}>
          <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={10}>
            <Ionicons name="arrow-back" size={24} color={Aurora.text} />
          </TouchableOpacity>

          <View style={s.avatar}>
            {peer?.photoURL && authHeader
              ? <Image source={{ uri: attachmentUrl(peer.photoURL), headers: { Authorization: authHeader } }} style={s.avatarImg} />
              : <Text style={s.avatarText}>{initials}</Text>}
            {peer?.online && <View style={s.onlineDot} />}
          </View>

          <Text style={s.heroName}>{displayName}</Text>
          <Text style={[s.heroStatus, peer?.online && { color: Aurora.online }]}>{lastSeenText()}</Text>
          {!!peer?.email && <Text style={s.heroPhone}>{peer.email}</Text>}
        </View>

        <View style={s.actionsRow}>
          <ActionButton icon="search-outline" label="Search" onPress={() => router.push({ pathname: '/in-chat-search', params: { chatId } } as any)} />
          <ActionButton icon="images-outline" label="Media" onPress={() => router.push({ pathname: '/media-gallery', params: { chatId } } as any)} />
          <ActionButton icon={muted ? 'notifications-off-outline' : 'notifications-outline'} label={muted ? 'Unmute' : 'Mute'} active={muted} onPress={toggleMute} />
          <ActionButton icon={blocked ? 'lock-closed-outline' : 'ban-outline'} label={blocked ? 'Unblock' : 'Block'} active={blocked} onPress={toggleBlock} />
        </View>

        {loading && <ActivityIndicator color={Aurora.primary} style={{ marginTop: 20 }} />}

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
              {media.map(m => {
                const aid = m.meta?.attachmentId;
                return (
                  <View key={m.id} style={s.mediaTile}>
                    {aid && authHeader
                      ? <Image source={{ uri: attachmentUrl(aid), headers: { Authorization: authHeader } }} style={s.mediaImg} />
                      : <Ionicons name={m.type === 'video' ? 'videocam' : 'image'} size={24} color={Aurora.textFaint} />}
                    {m.type === 'video' && <View style={s.videoBadge}><Ionicons name="play" size={12} color="#fff" /></View>}
                  </View>
                );
              })}
            </View>
          </View>
        )}

        {/* Shared Files */}
        {files.length > 0 && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Shared Files</Text>
            {files.map(f => (
              <View key={f.id} style={s.fileRow}>
                <View style={s.fileIcon}><Ionicons name="document-text-outline" size={20} color={Aurora.accent} /></View>
                <Text style={s.fileName} numberOfLines={1}>{f.name}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Shared Links */}
        {links.length > 0 && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Shared Links</Text>
            {links.map(l => (
              <View key={`${l.id}-${l.url}`} style={s.linkRow}>
                <View style={s.linkIcon}><Ionicons name="link-outline" size={18} color={Aurora.accent} /></View>
                <Text style={s.linkUrl} numberOfLines={1}>{l.url}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Encryption status — honest about the current flag state. */}
        <View style={s.section}>
          <View style={s.encryptionCard}>
            <MaterialCommunityIcons name={E2EE_ENABLED ? 'shield-lock' : 'lock-outline'} size={22} color={Aurora.primary} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={s.encTitle}>{E2EE_ENABLED ? 'End-to-End Encrypted' : 'Encrypted in Transit'}</Text>
              <Text style={s.encSubtitle}>
                {E2EE_ENABLED
                  ? 'Messages in this chat are end-to-end encrypted. No one outside this chat can read them.'
                  : 'Messages are encrypted in transit (TLS). End-to-end encryption is rolling out.'}
              </Text>
            </View>
          </View>
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
              <Text style={[s.encTitle, { color: Aurora.purple }]}>Ghost Mode</Text>
              <Text style={s.encSubtitle}>Hide your online status, typing, read receipts, and last seen from this contact.</Text>
            </View>
          </TouchableOpacity>
        </View>

        {/* Block & Report */}
        <View style={[s.section, { marginBottom: 20 }]}>
          <TouchableOpacity style={s.dangerBtn} activeOpacity={0.7} onPress={toggleBlock}>
            <Ionicons name={blocked ? 'lock-open-outline' : 'ban-outline'} size={20} color={Aurora.danger} />
            <Text style={s.dangerText}>{blocked ? `Unblock ${displayName}` : `Block ${displayName}`}</Text>
          </TouchableOpacity>
          {!blocked && (
            <TouchableOpacity style={[s.dangerBtn, { marginTop: 8 }]} activeOpacity={0.7} onPress={reportAndBlock}>
              <Ionicons name="flag-outline" size={20} color={Aurora.danger} />
              <Text style={s.dangerText}>Report {displayName}</Text>
            </TouchableOpacity>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Aurora.bg },
  hero: { alignItems: 'center', paddingTop: 54, paddingBottom: 24 },
  backBtn: { position: 'absolute', top: 54, left: 16, zIndex: 10 },
  avatar: { width: 100, height: 100, borderRadius: 50, marginTop: 12, backgroundColor: Aurora.surfaceSolid, borderWidth: 1, borderColor: Aurora.border, justifyContent: 'center', alignItems: 'center', overflow: 'visible' },
  avatarImg: { width: 100, height: 100, borderRadius: 50 },
  avatarText: { color: Aurora.accent, fontSize: 32, fontWeight: '700' },
  onlineDot: { width: 16, height: 16, borderRadius: 8, backgroundColor: Aurora.online, borderWidth: 3, borderColor: Aurora.bg, position: 'absolute', bottom: 4, right: 4 },
  heroName: { color: Aurora.text, fontSize: 24, fontWeight: '700', marginTop: 14 },
  heroStatus: { color: Aurora.textDim, fontSize: 14, marginTop: 4 },
  heroPhone: { color: Aurora.textFaint, fontSize: 14, marginTop: 4 },
  actionsRow: { flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 24, paddingVertical: 16, borderBottomWidth: 1, borderColor: Aurora.separator },
  actionBtn: { alignItems: 'center', gap: 6 },
  actionIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: Aurora.surface, borderWidth: 1, borderColor: Aurora.border, justifyContent: 'center', alignItems: 'center' },
  actionLabel: { fontSize: 12, fontWeight: '500' },
  section: { paddingHorizontal: 16, marginTop: 20 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionTitle: { color: Aurora.textDim, fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 },
  seeAll: { color: Aurora.accent, fontSize: 13, fontWeight: '600', marginBottom: 12 },
  mediaGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  mediaTile: { width: MEDIA_SIZE, height: MEDIA_SIZE, borderRadius: 8, backgroundColor: Aurora.surfaceSolid, justifyContent: 'center', alignItems: 'center', overflow: 'hidden' },
  mediaImg: { width: '100%', height: '100%' },
  videoBadge: { position: 'absolute', width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  fileRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: Aurora.card, borderRadius: 12, borderWidth: 1, borderColor: Aurora.border, padding: 12, marginBottom: 6, gap: 12 },
  fileIcon: { width: 38, height: 38, borderRadius: 10, backgroundColor: 'rgba(6,182,212,0.12)', justifyContent: 'center', alignItems: 'center' },
  fileName: { flex: 1, color: Aurora.text, fontSize: 14, fontWeight: '500' },
  linkRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: Aurora.card, borderRadius: 12, borderWidth: 1, borderColor: Aurora.border, padding: 12, marginBottom: 6, gap: 12 },
  linkIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: 'rgba(6,182,212,0.12)', justifyContent: 'center', alignItems: 'center' },
  linkUrl: { flex: 1, color: Aurora.accent, fontSize: 13 },
  encryptionCard: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: 'rgba(16,185,129,0.06)', borderRadius: 12, borderWidth: 1, borderColor: 'rgba(16,185,129,0.2)', padding: 14 },
  encTitle: { color: Aurora.primary, fontSize: 14, fontWeight: '600' },
  encSubtitle: { color: Aurora.textDim, fontSize: 12, lineHeight: 18, marginTop: 4 },
  dangerBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(239,68,68,0.06)', borderRadius: 12, borderWidth: 1, borderColor: 'rgba(239,68,68,0.22)', padding: 14, gap: 10 },
  dangerText: { color: Aurora.danger, fontSize: 15, fontWeight: '600' },
});
