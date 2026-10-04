// app/broadcast.tsx — Broadcast Channels (Postgres-backed, Telegram-style).
//
// Admin posts, subscribers read. Backed by /channels (list/create/join) and
// /channels/:id/posts (read/post). The open channel (posts, composer, admin
// post delete, Leave) is components/chattools/BroadcastChannelView.tsx.
// No Firestore. The iOS-only Alert.prompt
// join flow is replaced with a cross-platform modal.
//
// Invite links are vaultchat://broadcast?code=<code>: this screen reads
// `code` and opens the Join modal pre-filled (lib/pendingLink.ts replays the
// link after sign-in). There is no web route behind vaultchat.app/channel/.
// Channel posts are NOT end-to-end encrypted, and the screen says so.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, TouchableOpacity, FlatList, Alert, TextInput, Modal, ActivityIndicator, RefreshControl } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { readCache, writeCache } from '../lib/localCache';
import { listChannels, createChannel, joinChannel, type Channel } from '../lib/chatService';
import { AuroraBackground } from '../components/ui';
import { KeyboardSafe } from '../components/ui/KeyboardSafe';
import { BroadcastChannelView } from '../components/chattools/BroadcastChannelView';
import { userErrorText } from '../lib/userErrorText';
import { useBroadcastStyles } from '../components/chattools/broadcastStyles';

const CACHE_KEY = 'broadcasts';

export default function BroadcastScreen() {
  const { colors } = useTheme();
  const s = useBroadcastStyles();
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
  // Synchronous twin of `busy`: two taps in one frame both see false.
  const busyRef = useRef(false);

  // The open channel; its posts live in BroadcastChannelView.
  const [selected, setSelected] = useState<Channel | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  // An invite link (vaultchat://broadcast?code=…) lands here: offer to join.
  useEffect(() => {
    if (typeof linkCode === 'string' && linkCode.trim()) { setJoinCode(linkCode.trim()); setShowJoin(true); }
  }, [linkCode]);

  const load = useCallback(async () => {
    try {
      const list = await listChannels();
      setChannels(list);
      setLoadErr(null);
      writeCache(CACHE_KEY, list);
    }
    // Shown inline: with no cache it replaces the empty state (with a retry);
    // over cached channels it says they may be out of date.
    catch (e: any) { setLoadErr(userErrorText(e, 'Your channels could not be loaded.')); }
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

  const create = async () => {
    if (!name.trim() || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const ch = await createChannel(name.trim(), desc.trim());
      setShowCreate(false); setName(''); setDesc('');
      setChannels(prev => [ch, ...prev]);
      Alert.alert('Channel created', `Invite code: ${ch.inviteCode}\nShare it to let people subscribe.`);
    } catch (e: any) { Alert.alert('Could not create the channel', userErrorText(e, 'Try again.')); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const join = async () => {
    const code = joinCode.trim();
    if (!code || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const ch = await joinChannel(code);
      setShowJoin(false); setJoinCode('');
      setChannels(prev => prev.some(c => c.id === ch.id) ? prev : [ch, ...prev]);
      Alert.alert('Joined', `You are now subscribed to ${ch.name}.`);
    } catch (e: any) { Alert.alert('Could not join', userErrorText(e, 'Check the invite code and try again.')); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const closeChannel = useCallback(() => setSelected(null), []);
  const onLeft = useCallback((id: string) => {
    setSelected(null);
    setChannels(prev => {
      const next = prev.filter(c => c.id !== id);
      writeCache(CACHE_KEY, next);
      return next;
    });
  }, []);

  // ── Channel detail view ──
  if (selected) {
    return <BroadcastChannelView key={selected.id} channel={selected} onClose={closeChannel} onLeft={onLeft} />;
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
            <TouchableOpacity style={s.chRow} onPress={() => setSelected(item)} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={`${item.name}, ${item.subscriberCount ?? 1} subscribers${item.isAdmin ? ', admin' : ''}`}>
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
            <TextInput style={[s.modalInput, s.modalInputTall]} value={desc} onChangeText={setDesc} placeholder="Description (optional)" placeholderTextColor={colors.textFaint} multiline maxLength={500} accessibilityLabel="Channel description" />
            <TouchableOpacity style={[s.modalBtn, (!name.trim() || busy) && s.modalBtnOff]} onPress={create} disabled={!name.trim() || busy} accessibilityRole="button" accessibilityLabel="Create channel" accessibilityState={{ disabled: !name.trim() || busy, busy }}>
              {busy ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={s.modalBtnTxt}>Create</Text>}
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
            <TouchableOpacity style={[s.modalBtn, (!joinCode.trim() || busy) && s.modalBtnOff]} onPress={join} disabled={!joinCode.trim() || busy} accessibilityRole="button" accessibilityLabel="Join channel" accessibilityState={{ disabled: !joinCode.trim() || busy, busy }}>
              {busy ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={s.modalBtnTxt}>Join</Text>}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowJoin(false)} style={s.modalCancelBtn} accessibilityRole="button"><Text style={s.modalCancel}>Cancel</Text></TouchableOpacity>
          </View>
        </View>
        </KeyboardSafe>
      </Modal>
    </View>
  );
}
