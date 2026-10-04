// app/broadcast.tsx — Broadcast Channels (Postgres-backed, Telegram-style).
//
// Admin posts, subscribers read. Backed by /channels (list/create/join) and
// /channels/:id/posts (read/post). No Firestore. The iOS-only Alert.prompt
// join flow is replaced with a cross-platform modal.
//
// Invite links are vaultchat://broadcast?code=<code>: this screen reads
// `code` and opens the Join modal pre-filled (lib/pendingLink.ts replays the
// link after sign-in). There is no web route behind vaultchat.app/channel/.
// Channel posts are NOT end-to-end encrypted, and the screen says so.

import { HEADER_TOP } from '../constants/layout';
import { brandAlpha, type Palette } from '../constants/theme';
import React, { useState, useEffect, useCallback , useMemo, useRef} from 'react';
import { View, Text, TouchableOpacity, StyleSheet, FlatList, Alert, TextInput, Modal, Share, ActivityIndicator, BackHandler, RefreshControl } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { getSocket } from '../lib/socket';
import { readCache, writeCache } from '../lib/localCache';
import {
  listChannels, createChannel, joinChannel, listChannelPosts, postToChannel,
  type Channel, type ChannelPost,
} from '../lib/chatService';
import { AuroraBackground } from '../components/ui';
import { KeyboardSafe } from '../components/ui/KeyboardSafe';

const CACHE_KEY = 'broadcasts';
const POSTS_PAGE = 50;

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function BroadcastScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const { code: linkCode } = useLocalSearchParams<{ code?: string }>();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [busy, setBusy] = useState(false);

  const [selected, setSelected] = useState<Channel | null>(null);
  const [posts, setPosts] = useState<ChannelPost[]>([]);
  const [postText, setPostText] = useState('');
  const [posting, setPosting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  // Older posts: loaded page by page with `before` as the list scrolls up.
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // The channel whose posts may be applied; a slower load for a channel the
  // user already left must not overwrite the one now open.
  const openId = useRef<string | null>(null);

  // An invite link (vaultchat://broadcast?code=…) lands here: offer to join.
  useEffect(() => {
    if (typeof linkCode === 'string' && linkCode.trim()) { setJoinCode(linkCode.trim()); setShowJoin(true); }
  }, [linkCode]);

  // The channel view is an in-screen mode, so Android back must close it
  // rather than leave the whole screen.
  useEffect(() => {
    if (!selected) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      closeChannel();
      return true;
    });
    return () => sub.remove();
  }, [selected]);

  const load = useCallback(async () => {
    try {
      const list = await listChannels();
      setChannels(list);
      setLoadErr(null);
      writeCache(CACHE_KEY, list);
    }
    // Shown inline: with no cache it replaces the empty state (with a retry);
    // over cached channels it says they may be out of date.
    catch (e: any) { setLoadErr(e?.message ?? 'Failed to load channels'); }
    finally { setLoading(false); }
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  useEffect(() => {
    (async () => {
      const cached = await readCache<Channel[]>(CACHE_KEY);
      if (cached) { setChannels(cached); setLoading(false); }
      await load();
    })();
  }, [load]);

  // Realtime: while viewing a channel, join its room and prepend live posts.
  useEffect(() => {
    if (!selected) return;
    const channelId = selected.id;
    let active = true;
    let cleanup = () => {};
    (async () => {
      try {
        const s = await getSocket();
        if (!active) return;
        s.emit('channel_join', { channelId });
        const onPost = (p: ChannelPost) => {
          setPosts(prev => prev.some(x => x.id === p.id) ? prev : [p, ...prev]);
        };
        s.on('channel_post', onPost);
        cleanup = () => { s.off('channel_post', onPost); s.emit('channel_leave', { channelId }); };
      } catch { /* realtime optional */ }
    })();
    return () => { active = false; cleanup(); };
  }, [selected?.id]);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const ch = await createChannel(name.trim(), desc.trim());
      setShowCreate(false); setName(''); setDesc('');
      setChannels(prev => [ch, ...prev]);
      Alert.alert('Channel created', `Invite code: ${ch.inviteCode}\nShare it to let people subscribe.`);
    } catch (e: any) { Alert.alert('Error', e?.message ?? 'Could not create channel'); }
    finally { setBusy(false); }
  };

  const join = async () => {
    const code = joinCode.trim();
    if (!code) return;
    setBusy(true);
    try {
      const ch = await joinChannel(code);
      setShowJoin(false); setJoinCode('');
      setChannels(prev => prev.some(c => c.id === ch.id) ? prev : [ch, ...prev]);
      Alert.alert('Joined', `You are now subscribed to ${ch.name}.`);
    } catch (e: any) { Alert.alert('Error', e?.message ?? 'Could not join'); }
    finally { setBusy(false); }
  };

  const closeChannel = () => { openId.current = null; setSelected(null); setPosts([]); setHasMore(false); };

  const openChannel = async (ch: Channel) => {
    openId.current = ch.id;
    setSelected(ch);
    setPosts([]);
    setHasMore(false);
    try {
      const page = await listChannelPosts(ch.id, { limit: POSTS_PAGE });
      if (openId.current !== ch.id) return;
      setPosts(page);
      setHasMore(page.length >= POSTS_PAGE);
    } catch (e: any) {
      if (openId.current === ch.id) Alert.alert('Error', e?.message ?? 'Failed to load posts');
    }
  };

  const loadOlder = async () => {
    const ch = selected;
    const oldest = posts[posts.length - 1];
    if (!ch || !oldest || !hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await listChannelPosts(ch.id, { before: oldest.id, limit: POSTS_PAGE });
      if (openId.current !== ch.id) return;
      setPosts(prev => [...prev, ...page.filter(p => !prev.some(x => x.id === p.id))]);
      setHasMore(page.length >= POSTS_PAGE);
    } catch { /* stays scrollable; the next end-reached retries */ }
    finally { setLoadingMore(false); }
  };

  const sendPost = async () => {
    if (!postText.trim() || !selected) return;
    setPosting(true);
    try {
      const post = await postToChannel(selected.id, postText.trim());
      setPosts(prev => [post, ...prev]);
      setPostText('');
    } catch (e: any) { Alert.alert('Error', e?.message ?? 'Could not post'); }
    finally { setPosting(false); }
  };

  const shareInvite = (ch: Channel) =>
    Share.share({ message: `Join my crazzychat channel "${ch.name}"!\nOpen crazzychat → Broadcast Channels → Join Channel and enter: ${ch.inviteCode}\nOr open: vaultchat://broadcast?code=${encodeURIComponent(ch.inviteCode)}` });

  // ── Channel detail view ──
  if (selected) {
    return (
      <View style={s.container}>
      <AuroraBackground />
        <Stack.Screen options={{ headerShown: false }} />
        <View style={s.header}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={closeChannel} style={s.backBtn} hitSlop={10}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={s.title} numberOfLines={1} accessibilityRole="header">{selected.name}</Text>
          <TouchableOpacity onPress={() => shareInvite(selected)} style={s.shareBtn} accessibilityRole="button" accessibilityLabel="Share invite code">
            <Text style={s.shareLink}>Share</Text>
          </TouchableOpacity>
        </View>

        <View style={s.channelInfo}>
          <Text style={s.channelMeta}>
            {(selected.subscriberCount ?? 1)} subscribers{selected.isAdmin ? ' • You are admin' : ''}
          </Text>
          {!!selected.description && <Text style={s.channelDesc}>{selected.description}</Text>}
          <Text style={s.channelMeta}>Channel posts are not end-to-end encrypted.</Text>
        </View>

        <FlatList
          data={posts}
          inverted
          keyExtractor={p => String(p.id)}
          renderItem={({ item }) => (
            <View style={s.postCard}>
              {!!item.authorName && <Text style={s.postAuthor}>{item.authorName}</Text>}
              <Text style={s.postText}>{item.text}</Text>
              <Text style={s.postTime}>{(() => { try { return new Date(item.createdAt).toLocaleString(); } catch { return ''; } })()}</Text>
            </View>
          )}
          ListEmptyComponent={<View style={s.emptyBox}><Text style={s.emptyTxt}>No posts yet</Text></View>}
          onEndReached={loadOlder}
          onEndReachedThreshold={0.3}
          ListFooterComponent={loadingMore ? <ActivityIndicator color={colors.primary} style={{ margin: 12 }} accessibilityLabel="Loading older posts" /> : null}
          contentContainerStyle={{ padding: 12 }}
        />

        {selected.isAdmin ? (
          <KeyboardSafe keyboardOnly style={{ flex: 0 }}>
          <View style={s.postBar}>
            <TextInput
              style={s.postInput}
              value={postText}
              onChangeText={setPostText}
              placeholder="Write a broadcast…"
              placeholderTextColor={colors.textFaint}
              accessibilityLabel="Broadcast message"
              multiline
            />
            <TouchableOpacity style={[s.postBtn, !postText.trim() && { opacity: 0.4 }]} onPress={sendPost} disabled={!postText.trim() || posting} accessibilityRole="button" accessibilityLabel="Post broadcast" accessibilityState={{ disabled: !postText.trim() || posting, busy: posting }}>
              {posting ? <ActivityIndicator color={colors.bubbleOutText} size="small" /> : <Text style={s.postBtnTxt}>POST</Text>}
            </TouchableOpacity>
          </View>
          </KeyboardSafe>
        ) : (
          <View style={s.readOnly}><Text style={s.readOnlyTxt}>Only the admin can post in this channel</Text></View>
        )}
      </View>
    );
  }

  // ── Channel list view ──
  return (
    <View style={s.container}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />

      <View style={s.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={s.backBtn} hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.title} accessibilityRole="header">Broadcast Channels</Text>
        <View style={{ width: 44 }} />
      </View>

      <View style={s.topBtns}>
        <TouchableOpacity style={s.createBtn} onPress={() => setShowCreate(true)} accessibilityRole="button">
          <Ionicons name="add" size={16} color={colors.accent} />
          <Text style={s.createTxt}>  Create Channel</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.createBtn, s.joinBtn]} onPress={() => setShowJoin(true)} accessibilityRole="button">
          <Ionicons name="link" size={16} color={colors.primary} />
          <Text style={[s.createTxt, { color: colors.primary }]}>  Join Channel</Text>
        </TouchableOpacity>
      </View>

      {!!loadErr && channels.length > 0 && (
        <Text style={s.staleTxt} accessibilityRole="alert">{"Couldn't refresh — pull down to try again."}</Text>
      )}

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 30 }} />
      ) : (
        <FlatList
          data={channels}
          keyExtractor={c => c.id}
          refreshControl={<RefreshControl tintColor={colors.primary} refreshing={refreshing} onRefresh={onRefresh} />}
          renderItem={({ item }) => (
            <TouchableOpacity style={s.chRow} onPress={() => openChannel(item)} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={`${item.name}, ${item.subscriberCount ?? 1} subscribers${item.isAdmin ? ', admin' : ''}`}>
              <View style={s.chAvatar}><Ionicons name="megaphone-outline" size={22} color={colors.textDim} /></View>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={s.chName} numberOfLines={1}>{item.name}</Text>
                  <Text style={s.chSubs}>{item.subscriberCount ?? 1} subs</Text>
                </View>
                <Text style={s.chLast} numberOfLines={1}>{item.lastPost || 'No posts yet'}</Text>
              </View>
              {item.isAdmin && <View style={s.adminBadge}><Text style={s.adminTxt}>Admin</Text></View>}
            </TouchableOpacity>
          )}
          ListEmptyComponent={loadErr ? (
            // A failed load is not "No channels yet".
            <View style={s.emptyBox}>
              <Text style={s.emptyTxt}>{"Couldn't load channels"}</Text>
              <Text style={s.emptySub} accessibilityRole="alert">{loadErr}</Text>
              <TouchableOpacity accessibilityRole="button" accessibilityState={{ busy: refreshing }} disabled={refreshing} onPress={onRefresh} style={s.retryBtn}>
                <Text style={s.modalBtnTxt}>Try again</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={s.emptyBox}>
              <Text style={s.emptyTxt}>No channels yet</Text>
              <Text style={s.emptySub}>Create one or join with an invite code</Text>
            </View>
          )}
        />
      )}

      {/* Create modal */}
      <Modal visible={showCreate} transparent animationType="slide" onRequestClose={() => setShowCreate(false)}>
        <KeyboardSafe keyboardOnly>
        <View style={s.modalBg}>
          <View style={s.modal}>
            <Text style={s.modalTitle} accessibilityRole="header">Create Broadcast Channel</Text>
            <TextInput style={s.modalInput} value={name} onChangeText={setName} placeholder="Channel name" placeholderTextColor={colors.textFaint} maxLength={80} accessibilityLabel="Channel name" />
            <TextInput style={[s.modalInput, { height: 80, textAlignVertical: 'top' }]} value={desc} onChangeText={setDesc} placeholder="Description (optional)" placeholderTextColor={colors.textFaint} multiline maxLength={500} accessibilityLabel="Channel description" />
            <TouchableOpacity style={[s.modalBtn, (!name.trim() || busy) && { opacity: 0.5 }]} onPress={create} disabled={!name.trim() || busy} accessibilityRole="button" accessibilityLabel="Create channel" accessibilityState={{ disabled: !name.trim() || busy, busy }}>
              {busy ? <ActivityIndicator color={colors.bubbleOutText} /> : <Text style={s.modalBtnTxt}>Create</Text>}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowCreate(false)} style={s.modalCancelBtn} accessibilityRole="button"><Text style={s.modalCancel}>Cancel</Text></TouchableOpacity>
          </View>
        </View>
        </KeyboardSafe>
      </Modal>

      {/* Join modal */}
      <Modal visible={showJoin} transparent animationType="slide" onRequestClose={() => setShowJoin(false)}>
        <KeyboardSafe keyboardOnly>
        <View style={s.modalBg}>
          <View style={s.modal}>
            <Text style={s.modalTitle} accessibilityRole="header">Join a Channel</Text>
            <TextInput
              style={s.modalInput}
              value={joinCode}
              onChangeText={setJoinCode}
              placeholder="Invite code (e.g. ABCD-2F9K)"
              placeholderTextColor={colors.textFaint}
              autoCapitalize="characters"
              autoCorrect={false}
              accessibilityLabel="Invite code"
            />
            <TouchableOpacity style={[s.modalBtn, (!joinCode.trim() || busy) && { opacity: 0.5 }]} onPress={join} disabled={!joinCode.trim() || busy} accessibilityRole="button" accessibilityLabel="Join channel" accessibilityState={{ disabled: !joinCode.trim() || busy, busy }}>
              {busy ? <ActivityIndicator color={colors.bubbleOutText} /> : <Text style={s.modalBtnTxt}>Join</Text>}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowJoin(false)} style={s.modalCancelBtn} accessibilityRole="button"><Text style={s.modalCancel}>Cancel</Text></TouchableOpacity>
          </View>
        </View>
        </KeyboardSafe>
      </Modal>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: HEADER_TOP, paddingHorizontal: 16, paddingBottom: 12, gap: 12 },
  backBtn: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
  shareBtn: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' },
  staleTxt: { color: c.textDim, fontSize: 12, paddingHorizontal: 16, paddingBottom: 6 },
  retryBtn: { marginTop: 16, minHeight: 44, paddingHorizontal: 24, borderRadius: 12, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  title: { color: c.text, fontSize: 18, fontWeight: '800', flex: 1 },
  shareLink: { color: c.accent, fontSize: 14, fontWeight: '700' },
  topBtns: { flexDirection: 'row', gap: 8, padding: 12 },
  createBtn: { flex: 1, flexDirection: 'row', backgroundColor: c.glassSoft, borderRadius: 12, paddingVertical: 12, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.glassStroke },
  joinBtn: { backgroundColor: brandAlpha(0.13), borderColor: brandAlpha(0.3) },
  createTxt: { color: c.accent, fontSize: 13, fontWeight: '700' },
  chRow: { flexDirection: 'row', alignItems: 'center', padding: 14, marginHorizontal: 12, marginBottom: 6, backgroundColor: c.glassSoft, borderRadius: 14, borderWidth: 1, borderColor: c.glassStroke },
  chAvatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: c.surfaceSolid, justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  chName: { color: c.text, fontSize: 15, fontWeight: '700', flex: 1, marginRight: 8 },
  chSubs: { color: c.textDim, fontSize: 11 },
  chLast: { color: c.textDim, fontSize: 12, marginTop: 2 },
  adminBadge: { backgroundColor: brandAlpha(0.15), borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2, marginLeft: 8 },
  adminTxt: { color: c.accent, fontSize: 10, fontWeight: '800' },
  channelInfo: { padding: 12, backgroundColor: c.glassSoft, borderBottomWidth: 1, borderBottomColor: c.hairline },
  channelMeta: { color: c.textDim, fontSize: 12 },
  channelDesc: { color: c.textDim, fontSize: 12, marginTop: 4 },
  postCard: { backgroundColor: c.glassSoft, borderRadius: 14, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: c.glassStroke },
  postAuthor: { color: c.accent, fontSize: 12, fontWeight: '700', marginBottom: 4 },
  postText: { color: c.text, fontSize: 15, lineHeight: 22 },
  postTime: { color: c.textFaint, fontSize: 10, marginTop: 6, textAlign: 'right' },
  postBar: { flexDirection: 'row', alignItems: 'flex-end', padding: 10, backgroundColor: c.bg, borderTopWidth: 1, borderTopColor: c.hairline },
  postInput: { flex: 1, backgroundColor: c.glassSoft, color: c.text, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, maxHeight: 100, marginRight: 8, borderWidth: 1, borderColor: c.glassStroke },
  postBtn: { backgroundColor: c.primary, borderRadius: 12, paddingHorizontal: 18, paddingVertical: 11, minHeight: 44, justifyContent: 'center' },
  postBtnTxt: { color: c.bubbleOutText, fontWeight: '900' },
  readOnly: { padding: 14, alignItems: 'center', backgroundColor: c.glassSoft, borderTopWidth: 1, borderTopColor: c.hairline },
  readOnlyTxt: { color: c.textDim, fontSize: 13 },
  emptyBox: { alignItems: 'center', padding: 40 },
  emptyTxt: { color: c.textDim, fontSize: 14 },
  emptySub: { color: c.textFaint, fontSize: 12, marginTop: 8 },
  // Fixed scrim: dims whatever is behind the sheet the same way in both themes (no scrim token exists).
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  modal: { backgroundColor: c.surfaceSolid, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 40, borderTopWidth: 1, borderColor: c.glassStroke },
  modalTitle: { color: c.text, fontSize: 18, fontWeight: '900', marginBottom: 16 },
  modalInput: { backgroundColor: c.glassSoft, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, color: c.text, fontSize: 14, marginBottom: 12, borderWidth: 1, borderColor: c.glassStroke },
  modalBtn: { backgroundColor: c.primary, borderRadius: 12, paddingVertical: 14, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  modalBtnTxt: { color: c.bubbleOutText, fontWeight: '800' },
  modalCancelBtn: { minHeight: 44, justifyContent: 'center', marginTop: 4 },
  modalCancel: { color: c.textDim, textAlign: 'center' },
});
