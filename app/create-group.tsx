// app/create-group.tsx — Create a new group chat (Postgres-backed).
//
// People are picked from those you already have a direct chat with (derived
// from GET /chats). Anyone else is found by phone or email in Add people
// (/group-invites), which needs the group to exist first — so creating with
// nobody picked opens it straight away. The group is created with only you in
// it, and each picked person gets an INVITATION they accept or decline in
// /group-invitations — the same consent path as Group info → Add member (/family-add) and
// /group-create. Nobody is added to a group without agreeing to join.
//
// WHY TWO "NEW GROUP" SCREENS. This one makes a plain chat group from New chat.
// /group-create makes a typed Family Space group (type, icon, member cap,
// permissions), saves it to the local space registry and makes it the active
// space. Different products sharing one consent model; merging them is a
// product decision, not a refactor.

import { useAuthHeader } from '../hooks/useAuthHeader';
import { HEADER_TOP, SCREEN_BOTTOM } from '../constants/layout';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, TextInput, FlatList, ScrollView, TouchableOpacity,
  StyleSheet, ActivityIndicator, Alert,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { AppText as Text, Avatar, AuroraBackground, KeyboardSafe } from '../components/ui';
import { useKeyboardInset } from '../lib/useKeyboardInset';
import { listChats, createGroupChat, createInvitation, attachmentUrl } from '../lib/chatService';
import { tint } from '../lib/tintColor';

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
  // The contact list itself failed to load (vs. a failed create).
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  // With the keyboard up, KeyboardSafe lifts the bar; it then drops its own
  // gesture-bar padding, which the keyboard already covers.
  const kb = useKeyboardInset();

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        setLoadFailed(false);
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
      } catch {
        if (active) setLoadFailed(true);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [reload]);

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

  // Nobody picked is allowed: Add people opens next, with search by phone/email.
  const canCreate = useMemo(
    () => groupName.trim().length > 0 && !creating,
    [groupName, creating],
  );

  const create = async () => {
    if (!canCreate) return;
    setCreating(true);
    setError(null);
    try {
      // Created with only me in it; everyone picked is INVITED, not added.
      const name = groupName.trim();
      const { id } = await createGroupChat(name, { allowEmpty: true });
      if (selected.size === 0) {
        // Back from Add people lands in the new group, not on this form.
        router.replace({ pathname: '/chat', params: { id } });
        // `fresh`: Add people says the group already exists, even if nobody is added.
        router.push({ pathname: '/group-invites', params: { chatId: id, name, fresh: '1' } });
        return;
      }
      const ids = Array.from(selected);
      const results = await Promise.allSettled(ids.map(userId => createInvitation(id, { userId })));
      const nameOf = (uid: string) => people.find(p => p.userId === uid)?.name ?? 'Someone';
      const failed = ids.filter((_, i) => results[i].status === 'rejected').map(nameOf);
      router.replace({ pathname: '/chat', params: { id } });
      if (failed.length > 0) {
        Alert.alert(
          'Some invitations were not sent',
          `Not invited: ${failed.join(', ')}. Open Group info → Add member to try again.`,
        );
      }
    } catch (e: any) {
      setError(e?.message ?? 'Could not create group');
      setCreating(false);
    }
  };

  const renderItem = ({ item }: { item: Pick }) => {
    const sel = selected.has(item.userId);
    return (
      <TouchableOpacity style={s.row} onPress={() => toggle(item.userId)} activeOpacity={0.7}
        accessibilityRole="checkbox" accessibilityLabel={item.name} accessibilityState={{ checked: sel }}>
        <Avatar uri={item.photoURL && authHeader ? attachmentUrl(item.photoURL) : null} headers={authHeader ? { Authorization: authHeader } : undefined} name={item.name} size={46} ring />
        <Text style={s.name} numberOfLines={1}>{item.name}</Text>
        <View style={[s.check, sel && s.checkSel]}>
          {sel && <Ionicons name="checkmark" size={15} color={colors.onPrimary} />}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <KeyboardSafe keyboardOnly style={s.screen}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />

      <View style={s.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()} style={s.backBtn} hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle} accessibilityRole="header">New Group</Text>
        <View style={{ width: 40 }} />
      </View>

      <TextInput
        style={s.nameInput}
        placeholder="Group name…"
        placeholderTextColor={colors.textFaint}
        value={groupName}
        onChangeText={setGroupName}
        maxLength={100}
        accessibilityLabel="Group name"
      />

      {error && <View style={s.errorBar} accessibilityLiveRegion="polite"><Text style={s.errorTxt}>{error}</Text></View>}

      {/* Selected members as removable chips (WhatsApp) */}
      {selectedPeople.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.chipRow} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
          {selectedPeople.map(p => (
            <TouchableOpacity key={p.userId} style={s.chip} onPress={() => toggle(p.userId)} activeOpacity={0.7}
              accessibilityRole="button" accessibilityLabel={`Remove ${p.name}`}>
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
        <TextInput style={s.searchInput} value={query} onChangeText={setQuery} placeholder="Search contacts" placeholderTextColor={colors.textDim} autoCorrect={false} accessibilityLabel="Search contacts" />
      </View>

      {/* A count that changes as you pick: a polite live region, not a header. */}
      <Text style={s.label} accessibilityLiveRegion="polite"
        accessibilityLabel={`${selected.size} selected. They join when they accept.`}>
        {selected.size} SELECTED · THEY JOIN WHEN THEY ACCEPT
      </Text>
      <Text style={s.hint}>Not in your chats? Create the group, then add anyone by phone number or email.</Text>

      {/* The list region takes the remaining height, so the Create bar below it
          sits in normal flow and KeyboardSafe can lift it above the keyboard. */}
      <View style={{ flex: 1 }}>
      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} accessibilityLabel="Loading contacts" />
      ) : loadFailed && people.length === 0 ? (
        <View style={s.empty}>
          <Ionicons name="cloud-offline-outline" size={56} color={colors.textDim} />
          <Text style={s.emptyTxt}>Couldn’t load your contacts.</Text>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Retry loading contacts" onPress={() => { setLoading(true); setReload(n => n + 1); }}>
            <Text style={[s.emptyTxt, { color: colors.primary, fontWeight: '700' }]}>Retry</Text>
          </TouchableOpacity>
        </View>
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
          contentContainerStyle={{ paddingBottom: 16 }}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={<Text style={s.emptyTxt}>No contacts found</Text>}
        />
      )}
      </View>

      <View style={[s.bottomBar, kb > 0 && { paddingBottom: 16 }]}>
        <TouchableOpacity
          style={[s.createBtn, !canCreate && s.createBtnOff]}
          onPress={create}
          disabled={!canCreate}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canCreate, busy: creating }}
        >
          {creating
            ? <ActivityIndicator color={colors.onPrimary} />
            : <Text style={[s.createTxt, !canCreate && s.createTxtOff]}>
                {selected.size > 0 ? `Create & invite (${selected.size})` : 'Create & add people'}
              </Text>}
        </TouchableOpacity>
      </View>
    </KeyboardSafe>
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
  // danger is #RRGGBB in both palettes, so a hex alpha suffix is valid.
  errorBar: { backgroundColor: tint(c.danger, 0.12), borderColor: tint(c.danger, 0.4), borderWidth: 1, marginHorizontal: 16, marginTop: 10, padding: 10, borderRadius: 10 },
  errorTxt: { color: c.danger, fontSize: 12 },
  label: { color: c.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 4 },
  hint: { color: c.textFaint, fontSize: 12, lineHeight: 16, paddingHorizontal: 16, paddingBottom: 8 },
  chipRow: { maxHeight: 46, marginTop: 12 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.glass, borderRadius: 18, paddingLeft: 4, paddingRight: 10, paddingVertical: 4, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  chipTxt: { color: c.text, fontSize: 13, fontWeight: '600', maxWidth: 90 },
  // 2026-09-17: the 15sp input inside is ~30dp of line box at font scale 1.5,
  // so a pinned 40 cut the descenders. minHeight holds the same 40 at scale 1.0.
  searchWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginTop: 12, paddingHorizontal: 14, minHeight: 40, paddingVertical: 6, borderRadius: 20, backgroundColor: c.glass, borderWidth: 1, borderColor: c.glassStroke },
  searchInput: { flex: 1, color: c.text, fontSize: 15 },
  row: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 14, paddingVertical: 10, gap: 12, borderRadius: 16, backgroundColor: c.glass, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  name: { flex: 1, color: c.text, fontSize: 15, fontWeight: '600' },
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: c.glassStroke, alignItems: 'center', justifyContent: 'center' },
  checkSel: { backgroundColor: c.primary, borderColor: c.primary },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40, gap: 12 },
  emptyTxt: { color: c.textDim, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  // paddingBottom carries the gesture inset (2026-09-17): the bar's fill
  // reaches the screen edge while the CREATE BUTTON stays out of the gesture
  // area (edgeToEdge is on at every API level). SCREEN_BOTTOM is live, so this
  // follows a rotation. In normal flow (not absolute) since 2026-10-04, so
  // KeyboardSafe lifts it above the keyboard instead of the keyboard covering it.
  bottomBar: { padding: 16, paddingBottom: 16 + SCREEN_BOTTOM, backgroundColor: c.glass, borderTopWidth: 1, borderTopColor: c.hairline },
  createBtn: { backgroundColor: c.primary, borderRadius: 12, paddingVertical: 15, alignItems: 'center' },
  createBtnOff: { backgroundColor: c.glassSoft },
  createTxt: { color: c.onPrimary, fontSize: 16, fontWeight: '800' },
  createTxtOff: { color: c.textFaint },
});
