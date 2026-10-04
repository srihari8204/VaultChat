// app/contact-info.tsx — Contact Info (Postgres-backed).
//
// Real peer header (name / online / last seen from GET /chats/:id), mute via
// /chats/:id/mute, block via /user/blocks, and Shared Media / Files / Links
// derived from the actual message history (GET /chats/:id/messages). The old
// mocked sections and the unconditional "E2E encrypted" banner are gone — the
// encryption card now reflects the real E2EE_ENABLED flag so we don't claim a
// guarantee the build doesn't yet provide.

import { useAuthHeader } from '../hooks/useAuthHeader';
import { brandAlpha, type Palette } from '../constants/theme';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { View, TouchableOpacity, StyleSheet, ScrollView, Alert, ActivityIndicator, Linking, Switch, useWindowDimensions } from 'react-native';
import { getShareViewing, setShareViewing } from '../lib/viewerPrefs';
import LinkPreview from '../components/LinkPreview';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { E2EE_ENABLED } from '../constants/flags';
import {
  getChat, getMessages, muteChat, listBlocks, blockUser, unblockUser, reportUser,
  attachmentUrl, getCommonGroups, type Message, type ChatMember,
} from '../lib/chatService';
import SharedMediaThumb from '../components/chat/SharedMediaThumb';
import { readCache, writeCache } from '../lib/localCache';
import { unionWithLocalHistory } from '../lib/messageHistory';
import { AppText as Text, Avatar, AuroraBackground } from '../components/ui';
import { HEADER_TOP } from '../constants/layout';
import { tint } from '../lib/tintColor';
import { isChatLocked } from '../lib/chatLock';

const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message) || fallback;

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
  // Live width: the media grid re-tiles on rotation instead of keeping the
  // size the app launched with.
  const { width: SW } = useWindowDimensions();
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors, SW), [colors, SW]);
}

/** Shared media / files / links out of a message history (newest first as given). */
function classify(msgs: Message[]): { media: Message[]; files: FileHit[]; links: LinkHit[] } {
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
  return { media: med.slice(0, 9), files: fil.slice(0, 5), links: lnk.slice(0, 5) };
}

// Hoisted out of render so React keeps one component identity across renders.
function ActionButton({ icon, label, onPress, active, hint }: {
  icon: React.ComponentProps<typeof Ionicons>['name']; label: string; onPress: () => void; active?: boolean; hint?: string;
}) {
  const { colors } = useTheme();
  const s = useS();
  return (
    <TouchableOpacity style={s.actionBtn} activeOpacity={0.7} onPress={onPress}
      accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint}>
      <View style={[s.actionIcon, active && { borderColor: colors.primary, backgroundColor: brandAlpha(0.12) }]}>
        <Ionicons name={icon} size={22} color={active ? colors.primary : colors.text} />
      </View>
      <Text style={[s.actionLabel, { color: active ? colors.primary : colors.textDim }]}>{label}</Text>
    </TouchableOpacity>
  );
}

export default function ContactInfoScreen() {
  // Live metrics owned by THIS component — the hook further up belongs to the
  // useS() style helper, a different scope. Follows rotation and folds.
  const { width: SW } = useWindowDimensions();
  const MEDIA_SIZE = (SW - 32 - 8) / 3;

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
  const authHeader = useAuthHeader();
  const [media, setMedia] = useState<Message[]>([]);
  const [files, setFiles] = useState<FileHit[]>([]);
  const [links, setLinks] = useState<LinkHit[]>([]);
  const [commonGroups, setCommonGroups] = useState<{ id: string; name: string | null; photoURL: string | null }[]>([]);
  const [loading, setLoading] = useState(true);
  // The network refresh failed and there was no cached snapshot to show: the
  // empty sections below would otherwise read as "nothing was ever shared".
  const [loadFailed, setLoadFailed] = useState(false);
  // The refresh failed but a cached snapshot is on screen: it may be stale.
  const [staleShown, setStaleShown] = useState(false);
  const [groupsFailed, setGroupsFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Reachable from the Chats list avatar without opening the chat, so a locked
  // chat's shared media, files and links (message content) are not shown here.
  // null = not known yet; an unreadable lock table counts as locked.
  const [chatLocked, setChatLocked] = useState<boolean | null>(chatId ? null : false);
  useEffect(() => {
    if (!chatId) return;
    let active = true;
    isChatLocked(chatId).catch(() => true).then((l) => { if (active) setChatLocked(l); });
    return () => { active = false; };
  }, [chatId]);
  const sharedShown = chatLocked === false;

  const displayName = peer?.name || peerName || 'Contact';

  useEffect(() => {
    if (!peerUid) return;
    let active = true;
    setGroupsFailed(false);
    getCommonGroups(peerUid)
      .then((g) => { if (active) setCommonGroups(g); })
      .catch(() => { if (active) setGroupsFailed(true); });
    return () => { active = false; };
  }, [peerUid, reloadKey]);

  useEffect(() => {
    let active = true;
    // Cache key includes the chat id so different conversations don't collide.
    const cacheKey = 'contact-info:' + (chatId || peerUid || '');
    let painted = false;
    setLoadFailed(false);
    setStaleShown(false);
    (async () => {
      // Local-first: paint the last-known snapshot instantly, before the network.
      // readCache can throw (e.g. a locked DEK, see profile.tsx); outside a try
      // that rejected this IIFE and left the spinner up forever.
      let cached: ContactInfoCache | null = null;
      try { cached = chatId || peerUid ? await readCache<ContactInfoCache>(cacheKey) : null; } catch { /* fall through to the network */ }
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

        const [blocks, chat, msgs] = await Promise.all([
          listBlocks(),
          chatId ? getChat(chatId) : null,
          chatId ? getMessages(chatId, { limit: 200 }) : null,
        ]);

        if (!active) return;

        // Fallbacks are the cached snapshot, not render-time state: this effect
        // only re-runs when the chat changes, so state read here would be stale.
        let nextBlocked = cached?.blocked ?? false;
        let nextMuted = cached?.muted ?? false;
        let nextPeer = cached?.peer ?? null;
        if (peerUid) { nextBlocked = blocks.some(b => b.userId === peerUid); setBlocked(nextBlocked); }
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
        const unioned = await unionWithLocalHistory(chatId, msgs ?? [], 400);
        const buckets = unioned.length ? classify(unioned)
          : { media: cached?.media ?? [], files: cached?.files ?? [], links: cached?.links ?? [] };
        if (!active) return;
        setMedia(buckets.media);
        setFiles(buckets.files);
        setLinks(buckets.links);

        if (chatId || peerUid) {
          writeCache<ContactInfoCache>(cacheKey, {
            peer: nextPeer, muted: nextMuted, blocked: nextBlocked,
            media: buckets.media, files: buckets.files, links: buckets.links,
          });
        }
      } catch {
        // Non-fatal: header still renders from params (and cache, if painted).
        // A painted cache is said to be stale rather than passed off as fresh.
        if (active) { if (painted) setStaleShown(true); else setLoadFailed(true); }
      } finally {
        if (active && !painted) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [chatId, peerUid, reloadKey]);

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
    try { await muteChat(chatId, next); } catch (e: unknown) { setMuted(!next); Alert.alert('Error', errText(e, 'Mute failed')); }
  };

  const toggleBlock = () => {
    if (!peerUid) return;
    if (blocked) {
      Alert.alert(`Unblock ${displayName}?`, '', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Unblock', onPress: async () => {
          setBlocked(false);
          try { await unblockUser(peerUid); } catch (e: unknown) { setBlocked(true); Alert.alert('Error', errText(e, 'Failed')); }
        } },
      ]);
      return;
    }
    Alert.alert(`Block ${displayName}?`, 'Blocked contacts cannot start new chats with you.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Block', style: 'destructive', onPress: async () => {
        setBlocked(true);
        try { await blockUser(peerUid); } catch (e: unknown) { setBlocked(false); Alert.alert('Error', errText(e, 'Failed')); }
      } },
    ]);
  };

  const reportAndBlock = () => {
    if (!peerUid) return;
    Alert.alert(`Report ${displayName}?`, 'This files a report for review and blocks the contact.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Report & block', style: 'destructive', onPress: async () => {
        // Two requests, reported separately: a block that fails after the
        // report went through must not read as if nothing was filed.
        try {
          await reportUser(peerUid, 'reported_from_contact_info', chatId ? String(chatId) : undefined);
        } catch (e: unknown) {
          Alert.alert('Report not sent', `${errText(e, 'Something went wrong.')} ${displayName} was not reported or blocked.`);
          return;
        }
        setBlocked(true);
        try {
          await blockUser(peerUid);
          Alert.alert('Done', `${displayName} was reported and blocked.`);
        } catch (e: unknown) {
          setBlocked(false);
          Alert.alert('Reported, but not blocked', `Your report was sent. Blocking failed: ${errText(e, 'try again')} — you can block from this screen.`);
        }
      } },
    ]);
  };

  return (
    <View style={s.root}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />

      <ScrollView contentContainerStyle={{ paddingBottom: 60 }}>
        <View style={s.hero}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()} style={s.backBtn} hitSlop={10}>
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

          <Text numberOfLines={1} style={s.heroName} accessibilityRole="header">{displayName}</Text>
          <Text style={[s.heroStatus, peer?.online && { color: colors.online }]}>{lastSeenText()}</Text>
          {!!peer?.email && <Text style={s.heroPhone}>{peer.email}</Text>}
        </View>

        <View style={s.actionsRow}>
          <ActionButton icon="call-outline" label="Call" onPress={() => router.push({ pathname: '/voicecall', params: { chatId, peerUid, peerName: displayName } })} />
          <ActionButton icon="videocam-outline" label="Video" onPress={() => router.push({ pathname: '/videocall', params: { chatId, peerUid, peerName: displayName } })} />
          <ActionButton icon="search-outline" label="Search" onPress={() => router.push({ pathname: '/in-chat-search', params: { chatId } })} />
          <ActionButton icon={muted ? 'notifications-off-outline' : 'notifications-outline'} label={muted ? 'Unmute' : 'Mute'} active={muted} onPress={toggleMute} />
          <ActionButton icon={blocked ? 'lock-closed-outline' : 'ban-outline'} label={blocked ? 'Unblock' : 'Block'} active={blocked} onPress={toggleBlock} />
        </View>

        {/* Live Chat Viewers (#58) — share whether you're currently viewing this chat */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>Privacy</Text>
          <View style={s.prefRow}>
            <View style={s.prefBody}>
              <Text style={s.prefTitle}>Share my viewing status</Text>
              <Text style={s.prefSub}>Let {displayName} see when you’re viewing this chat right now</Text>
            </View>
            <Switch accessibilityLabel="Share my viewing status" value={shareViewing} onValueChange={toggleShareViewing} trackColor={{ true: colors.primary, false: colors.border }} thumbColor={colors.onPrimary} />
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
        {loadFailed && !loading && (
          <TouchableOpacity style={[s.section, s.loadErr]} onPress={() => setReloadKey(k => k + 1)}
            accessibilityRole="button" accessibilityLabel="Couldn't load shared media, files and links. Tap to retry.">
            <Ionicons name="cloud-offline-outline" size={18} color={colors.danger} />
            <Text style={s.loadErrTxt}>Couldn’t load shared media, files and links. Tap to retry.</Text>
          </TouchableOpacity>
        )}
        {(staleShown || groupsFailed) && !loading && (() => {
          // Names every part that failed: both can fail at once (offline).
          const what = [staleShown && 'Showing saved info — couldn’t refresh.', groupsFailed && 'Couldn’t load groups in common.']
            .filter(Boolean).join(' ');
          return (
            <TouchableOpacity style={[s.section, s.loadErr]} onPress={() => setReloadKey(k => k + 1)}
              accessibilityRole="button" accessibilityLabel={`${what} Tap to retry.`}>
              <Ionicons name="cloud-offline-outline" size={18} color={colors.textDim} />
              <Text style={s.staleTxt}>{what} Tap to retry.</Text>
            </TouchableOpacity>
          );
        })()}

        {chatLocked && (
          <View style={[s.section, s.loadErr]}>
            <Ionicons name="lock-closed-outline" size={18} color={colors.textDim} />
            <Text style={s.staleTxt}>This chat is locked, so its shared media, files and links aren’t shown here.</Text>
          </View>
        )}

        {/* Shared Media */}
        {sharedShown && media.length > 0 && (
          <View style={s.section}>
            <View style={s.sectionHeader}>
              <Text style={s.sectionTitle}>Shared Media</Text>
              <TouchableOpacity onPress={() => router.push({ pathname: '/media-gallery', params: { chatId } })}
                accessibilityRole="button" accessibilityLabel="See all shared media" hitSlop={12}>
                <Text style={s.seeAll}>See All</Text>
              </TouchableOpacity>
            </View>
            <View style={s.mediaGrid}>
              {media.map(m => (
                <SharedMediaThumb key={m.id} m={m} chatId={chatId} authHeader={authHeader} size={MEDIA_SIZE} />
              ))}
            </View>
          </View>
        )}

        {/* Shared Files */}
        {sharedShown && files.length > 0 && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Shared Files</Text>
            {/* Files open through the gallery's Files tab (`open` = this message),
                which downloads, decrypts and picks the in-app viewer (lib/docOpen)
                — one copy of that path. */}
            {files.map(f => (
              <TouchableOpacity key={f.id} style={s.fileRow} activeOpacity={0.7}
                onPress={() => router.push({ pathname: '/media-gallery', params: { chatId, tab: 'files', open: String(f.id) } })}
                accessibilityRole="button" accessibilityLabel={`Open ${f.name}`}>
                <View style={s.fileIcon}><Ionicons name="document-text-outline" size={20} color={colors.textDim} /></View>
                <Text style={s.fileName} numberOfLines={1}>{f.name}</Text>
                <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Shared Links — preview card (OG) + tappable URL */}
        {sharedShown && links.length > 0 && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Shared Links</Text>
            {links.slice(0, 20).map(l => (
              <TouchableOpacity key={`${l.id}-${l.url}`} activeOpacity={0.7} onPress={() => {
                // Peer-supplied link: show where it goes before leaving the app.
                let host = l.url;
                try { host = new URL(l.url).host || l.url; } catch { /* show the raw text */ }
                Alert.alert('Open link?', host, [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Open', onPress: () => { Linking.openURL(l.url).catch(() => {}); } },
                ]);
              }} accessibilityRole="link">
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
                onPress={() => router.push({ pathname: '/group-info', params: { id: g.id } })}
                accessibilityRole="button" accessibilityLabel={`${g.name || 'Group'}, group info`}>
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
            onPress={() => router.push({ pathname: '/verify-contact', params: { peerId: peerUid, peerName: displayName } })}
            accessibilityRole="button"
            accessibilityState={{ disabled: !E2EE_ENABLED || !peerUid }}
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
            style={[s.encryptionCard, s.ghostCard]}
            activeOpacity={0.7}
            onPress={() => router.push({ pathname: '/ghost-mode', params: { targetId: peerUid, targetName: displayName } })}
            accessibilityRole="button"
            accessibilityLabel="Ghost Mode. Hide your online status, typing, read receipts, and last seen from this contact."
          >
            <Text style={s.ghostEmoji} accessible={false} importantForAccessibility="no">{'👻'}</Text>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={[s.encTitle, { color: colors.purple }]}>Ghost Mode</Text>
              <Text style={s.encSubtitle}>Hide your online status, typing, read receipts, and last seen from this contact.</Text>
            </View>
          </TouchableOpacity>
        </View>

        {/* Block & Report */}
        <View style={[s.section, { marginBottom: 20 }]}>
          <TouchableOpacity style={s.dangerBtn} activeOpacity={0.7} onPress={toggleBlock} accessibilityRole="button">
            <Ionicons name={blocked ? 'lock-open-outline' : 'ban-outline'} size={20} color={colors.danger} />
            <Text style={s.dangerText}>{blocked ? `Unblock ${displayName}` : `Block ${displayName}`}</Text>
          </TouchableOpacity>
          {!blocked && (
            <TouchableOpacity style={[s.dangerBtn, { marginTop: 8 }]} activeOpacity={0.7} onPress={reportAndBlock} accessibilityRole="button">
              <Ionicons name="flag-outline" size={20} color={colors.danger} />
              <Text style={s.dangerText}>Report {displayName}</Text>
            </TouchableOpacity>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

// Width/height are threaded in from useWindowDimensions() rather than read
// from a module-level Dimensions.get(): orientation is 'default', so a frozen
// value survived rotation, folds and split-screen resizes.
const makeStyles = (c: Palette, SW: number) => StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  hero: { alignItems: 'center', paddingTop: HEADER_TOP, paddingBottom: 24 },
  backBtn: { position: 'absolute', top: HEADER_TOP, left: 16, zIndex: 10, minWidth: 44, minHeight: 44, justifyContent: 'center' },
  heroName: { color: c.text, fontSize: 24, fontWeight: '700', marginTop: 14 },
  heroStatus: { color: c.textDim, fontSize: 14, marginTop: 4 },
  heroPhone: { color: c.textFaint, fontSize: 14, marginTop: 4 },
  actionsRow: { flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 10, paddingVertical: 16, borderBottomWidth: 1, borderColor: c.hairline },
  actionBtn: { alignItems: 'center', gap: 6 },
  actionIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: c.glass, borderWidth: 1, borderColor: c.glassStroke, justifyContent: 'center', alignItems: 'center' },
  actionLabel: { fontSize: 12, fontWeight: '500' },
  section: { paddingHorizontal: 16, marginTop: 20 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionTitle: { color: c.textDim, fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 },
  aboutText: { color: c.text, fontSize: 15, lineHeight: 21 },
  seeAll: { color: c.accent, fontSize: 13, fontWeight: '600', marginBottom: 12 },
  mediaGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  fileRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.glass, borderRadius: 12, borderWidth: 1, borderColor: c.glassStroke, padding: 12, marginBottom: 8, gap: 12 },
  fileIcon: { width: 38, height: 38, borderRadius: 10, backgroundColor: tint(c.primary, 0.12), justifyContent: 'center', alignItems: 'center' },
  fileName: { flex: 1, color: c.text, fontSize: 14, fontWeight: '500' },
  linkRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.glass, borderRadius: 12, borderWidth: 1, borderColor: c.glassStroke, padding: 12, marginBottom: 8, gap: 12 },
  linkIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: tint(c.primary, 0.12), justifyContent: 'center', alignItems: 'center' },
  linkUrl: { flex: 1, color: c.accent, fontSize: 13 },
  encryptionCard: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: brandAlpha(0.06), borderRadius: 12, borderWidth: 1, borderColor: brandAlpha(0.2), padding: 14 },
  encTitle: { color: c.primary, fontSize: 14, fontWeight: '600' },
  encSubtitle: { color: c.textDim, fontSize: 12, lineHeight: 18, marginTop: 4 },
  ghostCard: { borderColor: tint(c.purple, 0.25), backgroundColor: tint(c.purple, 0.06) },
  dangerBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: tint(c.danger, 0.06), borderRadius: 12, borderWidth: 1, borderColor: tint(c.danger, 0.22), padding: 14, gap: 10 },
  loadErr: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  loadErrTxt: { flex: 1, color: c.danger, fontSize: 13, lineHeight: 18 },
  dangerText: { color: c.danger, fontSize: 15, fontWeight: '600' },
  staleTxt: { flex: 1, color: c.textDim, fontSize: 13, lineHeight: 18 },
  prefRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  prefBody: { flex: 1, paddingRight: 12 },
  prefTitle: { color: c.text, fontSize: 15, fontWeight: '600' },
  prefSub: { color: c.textDim, fontSize: 12, marginTop: 2 },
  ghostEmoji: { fontSize: 22 },
});
