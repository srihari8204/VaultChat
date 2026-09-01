// app/broadcast.tsx — Broadcast Channels (Postgres-backed, Telegram-style).
//
// Admin posts, subscribers read. Backed by /channels (list/create/join) and
// /channels/:id/posts (read/post). No Firestore. The iOS-only Alert.prompt
// join flow is replaced with a cross-platform modal.

import { HEADER_TOP } from '../constants/layout';
import { brandAlpha } from '../constants/theme';
import React, { useState, useEffect, useCallback , useMemo} from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList, Alert, StatusBar, TextInput, Modal, Share, ActivityIndicator,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { getSocket } from '../lib/socket';
import { readCache, writeCache } from '../lib/localCache';
import {
  listChannels, createChannel, joinChannel, listChannelPosts, postToChannel,
  type Channel, type ChannelPost,
} from '../lib/chatService';

const CACHE_KEY = 'broadcasts';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function BroadcastScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
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

  const load = useCallback(async (hasCache: boolean) => {
    try {
      const list = await listChannels();
      setChannels(list);
      writeCache(CACHE_KEY, list);
    }
    // Keep cached channels if we have them; only alert on a cold load.
    catch (e: any) { if (!hasCache) Alert.alert('Error', e?.message ?? 'Failed to load channels'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    (async () => {
      const cached = await readCache<Channel[]>(CACHE_KEY);
      if (cached) { setChannels(cached); setLoading(false); }
      await load(!!cached);
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

  const openChannel = async (ch: Channel) => {
    setSelected(ch);
    setPosts([]);
    try { setPosts(await listChannelPosts(ch.id, { limit: 50 })); }
    catch (e: any) { Alert.alert('Error', e?.message ?? 'Failed to load posts'); }
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
    Share.share({ message: `Join my VaultChat channel "${ch.name}"!\nCode: ${ch.inviteCode}\nhttps://vaultchat.app/channel/${ch.inviteCode}` });

  // ── Channel detail view ──
  if (selected) {
    return (
      <View style={s.container}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={s.header}>
          <TouchableOpacity onPress={() => { setSelected(null); setPosts([]); }} style={s.backBtn} hitSlop={10}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={s.title} numberOfLines={1}>{selected.name}</Text>
          <TouchableOpacity onPress={() => shareInvite(selected)} hitSlop={10}>
            <Text style={s.shareLink}>Share</Text>
          </TouchableOpacity>
        </View>

        <View style={s.channelInfo}>
          <Text style={s.channelMeta}>
            {(selected.subscriberCount ?? 1)} subscribers{selected.isAdmin ? ' • You are admin' : ''}
          </Text>
          {!!selected.description && <Text style={s.channelDesc}>{selected.description}</Text>}
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
          contentContainerStyle={{ padding: 12 }}
        />

        {selected.isAdmin ? (
          <View style={s.postBar}>
            <TextInput
              style={s.postInput}
              value={postText}
              onChangeText={setPostText}
              placeholder="Write a broadcast…"
              placeholderTextColor={colors.textFaint}
              multiline
            />
            <TouchableOpacity style={[s.postBtn, !postText.trim() && { opacity: 0.4 }]} onPress={sendPost} disabled={!postText.trim() || posting}>
              {posting ? <ActivityIndicator color={colors.bubbleOutText} size="small" /> : <Text style={s.postBtnTxt}>POST</Text>}
            </TouchableOpacity>
          </View>
        ) : (
          <View style={s.readOnly}><Text style={s.readOnlyTxt}>Only the admin can post in this channel</Text></View>
        )}
      </View>
    );
  }

  // ── Channel list view ──
  return (
    <View style={s.container}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="light-content" />

      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.title}>Broadcast Channels</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={s.topBtns}>
        <TouchableOpacity style={s.createBtn} onPress={() => setShowCreate(true)}>
          <Ionicons name="add" size={16} color={colors.accent} />
          <Text style={s.createTxt}>  Create Channel</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.createBtn, s.joinBtn]} onPress={() => setShowJoin(true)}>
          <Ionicons name="link" size={16} color={colors.primary} />
          <Text style={[s.createTxt, { color: colors.primary }]}>  Join Channel</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 30 }} />
      ) : (
        <FlatList
          data={channels}
          keyExtractor={c => c.id}
          renderItem={({ item }) => (
            <TouchableOpacity style={s.chRow} onPress={() => openChannel(item)} activeOpacity={0.7}>
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
          ListEmptyComponent={
            <View style={s.emptyBox}>
              <Text style={s.emptyTxt}>No channels yet</Text>
              <Text style={s.emptySub}>Create one or join with an invite code</Text>
            </View>
          }
        />
      )}

      {/* Create modal */}
      <Modal visible={showCreate} transparent animationType="slide" onRequestClose={() => setShowCreate(false)}>
        <View style={s.modalBg}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>Create Broadcast Channel</Text>
            <TextInput style={s.modalInput} value={name} onChangeText={setName} placeholder="Channel name" placeholderTextColor={colors.textFaint} />
            <TextInput style={[s.modalInput, { height: 80, textAlignVertical: 'top' }]} value={desc} onChangeText={setDesc} placeholder="Description (optional)" placeholderTextColor={colors.textFaint} multiline />
            <TouchableOpacity style={[s.modalBtn, (!name.trim() || busy) && { opacity: 0.5 }]} onPress={create} disabled={!name.trim() || busy}>
              {busy ? <ActivityIndicator color={colors.bubbleOutText} /> : <Text style={s.modalBtnTxt}>Create</Text>}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowCreate(false)}><Text style={s.modalCancel}>Cancel</Text></TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Join modal */}
      <Modal visible={showJoin} transparent animationType="slide" onRequestClose={() => setShowJoin(false)}>
        <View style={s.modalBg}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>Join a Channel</Text>
            <TextInput
              style={s.modalInput}
              value={joinCode}
              onChangeText={setJoinCode}
              placeholder="Invite code (e.g. ABCD-2F9K)"
              placeholderTextColor={colors.textFaint}
              autoCapitalize="characters"
              autoCorrect={false}
            />
            <TouchableOpacity style={[s.modalBtn, (!joinCode.trim() || busy) && { opacity: 0.5 }]} onPress={join} disabled={!joinCode.trim() || busy}>
              {busy ? <ActivityIndicator color={colors.bubbleOutText} /> : <Text style={s.modalBtnTxt}>Join</Text>}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowJoin(false)}><Text style={s.modalCancel}>Cancel</Text></TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: HEADER_TOP, paddingHorizontal: 16, paddingBottom: 12, gap: 12 },
  backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  title: { color: c.text, fontSize: 18, fontWeight: '800', flex: 1 },
  shareLink: { color: c.accent, fontSize: 14, fontWeight: '700' },
  topBtns: { flexDirection: 'row', gap: 8, padding: 12 },
  createBtn: { flex: 1, flexDirection: 'row', backgroundColor: c.surface, borderRadius: 12, paddingVertical: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.border },
  joinBtn: { backgroundColor: brandAlpha(0.13), borderColor: brandAlpha(0.3) },
  createTxt: { color: c.accent, fontSize: 13, fontWeight: '700' },
  chRow: { flexDirection: 'row', alignItems: 'center', padding: 14, marginHorizontal: 12, marginBottom: 6, backgroundColor: c.card, borderRadius: 14, borderWidth: 1, borderColor: c.border },
  chAvatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: c.surfaceSolid, justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  chName: { color: c.text, fontSize: 15, fontWeight: '700', flex: 1, marginRight: 8 },
  chSubs: { color: c.textDim, fontSize: 11 },
  chLast: { color: c.textDim, fontSize: 12, marginTop: 2 },
  adminBadge: { backgroundColor: brandAlpha(0.15), borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2, marginLeft: 8 },
  adminTxt: { color: c.accent, fontSize: 10, fontWeight: '800' },
  channelInfo: { padding: 12, backgroundColor: c.card, borderBottomWidth: 1, borderBottomColor: c.separator },
  channelMeta: { color: c.textDim, fontSize: 12 },
  channelDesc: { color: c.textDim, fontSize: 12, marginTop: 4 },
  postCard: { backgroundColor: c.card, borderRadius: 14, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: c.border },
  postAuthor: { color: c.accent, fontSize: 12, fontWeight: '700', marginBottom: 4 },
  postText: { color: c.text, fontSize: 15, lineHeight: 22 },
  postTime: { color: c.textFaint, fontSize: 10, marginTop: 6, textAlign: 'right' },
  postBar: { flexDirection: 'row', alignItems: 'flex-end', padding: 10, backgroundColor: c.bg, borderTopWidth: 1, borderTopColor: c.separator },
  postInput: { flex: 1, backgroundColor: c.surface, color: c.text, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, maxHeight: 100, marginRight: 8, borderWidth: 1, borderColor: c.border },
  postBtn: { backgroundColor: c.primary, borderRadius: 12, paddingHorizontal: 18, paddingVertical: 11 },
  postBtnTxt: { color: c.bubbleOutText, fontWeight: '900' },
  readOnly: { padding: 14, alignItems: 'center', backgroundColor: c.surface, borderTopWidth: 1, borderTopColor: c.separator },
  readOnlyTxt: { color: c.textDim, fontSize: 13 },
  emptyBox: { alignItems: 'center', padding: 40 },
  emptyTxt: { color: c.textDim, fontSize: 14 },
  emptySub: { color: c.textFaint, fontSize: 12, marginTop: 8 },
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  modal: { backgroundColor: c.surfaceSolid, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 40, borderTopWidth: 1, borderColor: c.border },
  modalTitle: { color: c.text, fontSize: 18, fontWeight: '900', marginBottom: 16 },
  modalInput: { backgroundColor: c.surface, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, color: c.text, fontSize: 14, marginBottom: 12, borderWidth: 1, borderColor: c.border },
  modalBtn: { backgroundColor: c.primary, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  modalBtnTxt: { color: c.bubbleOutText, fontWeight: '800' },
  modalCancel: { color: c.textDim, textAlign: 'center', marginTop: 12 },
});
