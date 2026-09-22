// app/create-group.tsx — Create a new group chat (Postgres-backed).
//
// Members are picked from people you already have a direct chat with
// (derived from GET /chats). This needs no contact-permission round-trip and
// resolves straight to user IDs, which POST /chats (type:group) accepts.
// The group is created on Postgres and opened in the shared /chat screen
// (which renders groups), replacing the old Firebase + group-chat flow.

import { useAuthHeader } from '../hooks/useAuthHeader';
import { HEADER_TOP, SCREEN_BOTTOM } from '../constants/layout';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, TextInput, FlatList, ScrollView, TouchableOpacity,
  StyleSheet, ActivityIndicator,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { AppText as Text, Avatar, AuroraBackground } from '../components/ui';
import { listChats, createGroupChat, attachmentUrl } from '../lib/chatService';

interface Pick { userId: string; name: string; photoURL: string | null }

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function CreateGroupScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();

  const [people, setPeople] = useState<Pick[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupName, setGroupName] = useState('');
  const [query, setQuery] = useState('');
  const authHeader = useAuthHeader();
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const chats = await listChats();
        // Direct-chat peers → dedup by userId.
        const seen = new Map<string, Pick>();
        for (const c of chats) {
          if (c.type === 'direct' && c.peerUserId) {
            if (!seen.has(c.peerUserId)) {
              seen.set(c.peerUserId, {
                userId: c.peerUserId,
                name: c.peerName || c.name || 'Direct chat',
                photoURL: c.peerPhotoURL ?? null,
              });
            }
          }
        }
        if (active) setPeople(Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name)));
      } catch (e: any) {
        if (active) setError(e?.message ?? 'Failed to load contacts');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? people.filter(p => p.name.toLowerCase().includes(q)) : people;
  }, [query, people]);
  const selectedPeople = useMemo(() => people.filter(p => selected.has(p.userId)), [people, selected]);

  const toggle = useCallback((userId: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId); else next.add(userId);
      return next;
    });
  }, []);

  const canCreate = useMemo(
    () => groupName.trim().length > 0 && selected.size > 0 && !creating,
    [groupName, selected.size, creating],
  );

  const create = async () => {
    if (!canCreate) return;
    setCreating(true);
    setError(null);
    try {
      const { id } = await createGroupChat(groupName.trim(), { ids: Array.from(selected) });
      router.replace({ pathname: '/chat', params: { id } } as any);
    } catch (e: any) {
      setError(e?.message ?? 'Could not create group');
      setCreating(false);
    }
  };

  const renderItem = ({ item }: { item: Pick }) => {
    const sel = selected.has(item.userId);
    return (
      <TouchableOpacity style={s.row} onPress={() => toggle(item.userId)} activeOpacity={0.7}>
        <Avatar uri={item.photoURL && authHeader ? attachmentUrl(item.photoURL) : null} headers={authHeader ? { Authorization: authHeader } : undefined} name={item.name} size={46} ring />
        <Text style={s.name} numberOfLines={1}>{item.name}</Text>
        <View style={[s.check, sel && s.checkSel]}>
          {sel && <Ionicons name="checkmark" size={15} color="#FFFFFF" />}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={s.screen}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />

      <View style={s.header}>
        <TouchableOpacity accessibilityLabel="Go back" onPress={() => router.back()} style={s.backBtn} hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>New Group</Text>
        <View style={{ width: 40 }} />
      </View>

      <TextInput
        style={s.nameInput}
        placeholder="Group name…"
        placeholderTextColor={colors.textFaint}
        value={groupName}
        onChangeText={setGroupName}
        maxLength={100}
      />

      {error && <View style={s.errorBar}><Text style={s.errorTxt}>{error}</Text></View>}

      {/* Selected members as removable chips (WhatsApp) */}
      {selectedPeople.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.chipRow} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
          {selectedPeople.map(p => (
            <TouchableOpacity key={p.userId} style={s.chip} onPress={() => toggle(p.userId)} activeOpacity={0.7}>
              <Avatar uri={p.photoURL && authHeader ? attachmentUrl(p.photoURL) : null} headers={authHeader ? { Authorization: authHeader } : undefined} name={p.name} size={26} />
              <Text style={s.chipTxt} numberOfLines={1}>{p.name.split(' ')[0]}</Text>
              <Ionicons name="close-circle" size={16} color={colors.textDim} />
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Search */}
      <View style={s.searchWrap}>
        <Ionicons name="search" size={18} color={colors.textDim} />
        <TextInput style={s.searchInput} value={query} onChangeText={setQuery} placeholder="Search contacts" placeholderTextColor={colors.textDim} autoCorrect={false} />
      </View>

      <Text style={s.label}>{selected.size} SELECTED</Text>

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
      ) : people.length === 0 ? (
        <View style={s.empty}>
          <Ionicons name="people-outline" size={56} color={colors.surfaceSolid} />
          <Text style={s.emptyTxt}>No contacts yet. Start a direct chat with someone first, then create a group.</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={p => p.userId}
          renderItem={renderItem}
          contentContainerStyle={{ paddingBottom: 96 }}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={<Text style={s.emptyTxt}>No contacts found</Text>}
        />
      )}

      <View style={s.bottomBar}>
        <TouchableOpacity
          style={[s.createBtn, !canCreate && s.createBtnOff]}
          onPress={create}
          disabled={!canCreate}
          activeOpacity={0.85}
        >
          {creating
            ? <ActivityIndicator color="#FFFFFF" />
            : <Text style={[s.createTxt, !canCreate && s.createTxtOff]}>
                Create Group{selected.size > 0 ? ` (${selected.size + 1})` : ''}
              </Text>}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: HEADER_TOP, paddingHorizontal: 16, paddingBottom: 8 },
  backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { color: c.text, fontSize: 18, fontWeight: '700' },
  nameInput: {
    backgroundColor: c.glass, color: c.text, fontSize: 16,
    marginHorizontal: 16, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 13,
    borderWidth: 1, borderColor: c.glassStroke,
  },
  errorBar: { backgroundColor: 'rgba(239,68,68,0.12)', borderColor: 'rgba(239,68,68,0.4)', borderWidth: 1, marginHorizontal: 16, marginTop: 10, padding: 10, borderRadius: 10 },
  errorTxt: { color: c.danger, fontSize: 12 },
  label: { color: c.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8 },
  chipRow: { maxHeight: 46, marginTop: 12 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.glass, borderRadius: 18, paddingLeft: 4, paddingRight: 10, paddingVertical: 4, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  chipTxt: { color: c.text, fontSize: 13, fontWeight: '600', maxWidth: 90 },
  // 2026-09-17: the 15sp input inside is ~30dp of line box at font scale 1.5,
  // so a pinned 40 cut the descenders. minHeight holds the same 40 at scale 1.0.
  searchWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginTop: 12, paddingHorizontal: 14, minHeight: 40, paddingVertical: 6, borderRadius: 20, backgroundColor: c.glass, borderWidth: 1, borderColor: c.glassStroke },
  searchInput: { flex: 1, color: c.text, fontSize: 15 },
  row: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 14, paddingVertical: 10, gap: 12, borderRadius: 16, backgroundColor: c.glass, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  avatar: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surfaceSolid, borderWidth: 1, borderColor: c.glassStroke },
  avatarSel: { borderColor: c.primary },
  avatarTxt: { color: c.accent, fontSize: 18, fontWeight: '800' },
  name: { flex: 1, color: c.text, fontSize: 15, fontWeight: '600' },
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: c.glassStroke, alignItems: 'center', justifyContent: 'center' },
  checkSel: { backgroundColor: c.primary, borderColor: c.primary },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40, gap: 12 },
  emptyTxt: { color: c.textDim, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  // paddingBottom carries the gesture inset (2026-09-17). The bar is pinned at
  // bottom:0 so its background correctly reaches the screen edge — but with a
  // flat padding of 16 the CREATE BUTTON ITSELF sat inside the gesture area on
  // every device, because edgeToEdge is enabled for all API levels. Padding the
  // content, not moving the bar, keeps the fill edge-to-edge and the control
  // reachable. SCREEN_BOTTOM is live, so this follows a rotation.
  bottomBar: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 16, paddingBottom: 16 + SCREEN_BOTTOM, backgroundColor: c.glass, borderTopWidth: 1, borderTopColor: c.hairline },
  createBtn: { backgroundColor: c.primary, borderRadius: 12, paddingVertical: 15, alignItems: 'center' },
  createBtnOff: { backgroundColor: c.glassSoft },
  createTxt: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },
  createTxtOff: { color: c.textFaint },
});
