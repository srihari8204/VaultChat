// app/communities.tsx — WhatsApp-style Communities (real, Postgres-backed).
//
// A community is an umbrella over group chats with an auto-created Announcements
// group. List your communities → open one → see its groups → tap to chat.

import { HEADER_TOP } from '../constants/layout';
import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, Modal, TextInput, Alert, ActivityIndicator,
} from 'react-native';
import { useRouter, useFocusEffect, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';
import {
  listCommunities, createCommunity, getCommunity, createCommunityGroup,
  type Community, type CommunityDetail,
} from '../lib/chatService';
import { readCache, writeCache } from '../lib/localCache';
import { AuroraBackground } from '../components/ui';

export default function CommunitiesScreen() {
  const { colors } = useTheme();
  const S = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();

  const [list, setList] = useState<Community[]>([]);
  const [detail, setDetail] = useState<CommunityDetail | null>(null);
  const [loading, setLoading] = useState(true);
  // Single name/desc modal, reused for "new community" and "new group".
  const [modal, setModal] = useState<null | 'community' | 'group'>(null);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(async () => {
    // Local-first: paint cached list instantly, then refresh in background.
    const cached = await readCache<Community[]>('communities');
    if (cached) { setList(cached); setLoading(false); }
    try {
      const l = await listCommunities();
      setList(l);
      writeCache('communities', l);
    } catch { /* keep cached list for offline read */ }
    finally { setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { if (!detail) loadList(); }, [detail, loadList]));

  const openCommunity = useCallback(async (id: string) => {
    // Local-first: paint cached detail instantly, else show spinner.
    const cached = await readCache<CommunityDetail>('community:' + id);
    if (cached) { setDetail(cached); setLoading(false); }
    else setLoading(true);
    try {
      const d = await getCommunity(id);
      setDetail(d);
      writeCache('community:' + id, d);
    } catch {
      if (!cached) Alert.alert('Error', 'Could not open this community.');
    }
    finally { setLoading(false); }
  }, []);

  const submitModal = useCallback(async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    try {
      if (modal === 'community') {
        const r = await createCommunity(n, desc.trim() || undefined);
        setModal(null); setName(''); setDesc('');
        await openCommunity(r.id);
        loadList();
      } else if (modal === 'group' && detail) {
        await createCommunityGroup(detail.id, n);
        setModal(null); setName('');
        await openCommunity(detail.id);
      }
    } catch (e: any) { Alert.alert('Could not create', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  }, [name, desc, modal, detail, busy, openCommunity, loadList]);

  // ── Community detail view ──────────────────────────────────────────
  if (detail) {
    return (
      <View style={S.screen}>
      <AuroraBackground />
        <Stack.Screen options={{ headerShown: false }} />
        <View style={S.header}>
          <TouchableOpacity onPress={() => setDetail(null)} style={S.hBtn} hitSlop={8}><Ionicons name="arrow-back" size={24} color={colors.text} /></TouchableOpacity>
          <Text style={S.hTitle} numberOfLines={1}>{detail.name}</Text>
        </View>

        <FlatList
          data={detail.groups}
          keyExtractor={g => g.id}
          ListHeaderComponent={
            <View>
              <View style={S.commHero}>
                <View style={S.commIcon}><Ionicons name="people" size={32} color="#fff" /></View>
                <Text style={S.commName}>{detail.name}</Text>
                {!!detail.description && <Text style={S.commDesc}>{detail.description}</Text>}
              </View>
              <Text style={S.sectionLabel}>GROUPS</Text>
            </View>
          }
          renderItem={({ item: g }) => (
            <TouchableOpacity style={S.row} activeOpacity={0.7} onPress={() => router.push({ pathname: '/chat', params: { id: g.id } } as any)}>
              <View style={[S.groupIcon, g.isAnnouncement && { backgroundColor: colors.primary }]}>
                <Ionicons name={g.isAnnouncement ? 'megaphone' : 'people-outline'} size={20} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={S.rowName} numberOfLines={1}>{g.name}</Text>
                <Text style={S.rowSub}>{g.isAnnouncement ? 'Announcements' : `${g.members} member${g.members === 1 ? '' : 's'}`}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
            </TouchableOpacity>
          )}
          ListFooterComponent={
            <TouchableOpacity style={S.addRow} activeOpacity={0.7} onPress={() => { setName(''); setModal('group'); }}>
              <View style={S.addIcon}><Ionicons name="add" size={22} color={colors.primary} /></View>
              <Text style={S.addTxt}>New group</Text>
            </TouchableOpacity>
          }
        />
        {nameModal()}
      </View>
    );
  }

  // ── Communities list ───────────────────────────────────────────────
  return (
    <View style={S.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} style={S.hBtn} hitSlop={8}><Ionicons name="arrow-back" size={24} color={colors.text} /></TouchableOpacity>
        <Text style={S.hTitle}>Communities</Text>
        <TouchableOpacity onPress={() => { setName(''); setDesc(''); setModal('community'); }} style={S.hBtn} hitSlop={8}><Ionicons name="add" size={24} color={colors.text} /></TouchableOpacity>
      </View>

      {loading ? (
        <View style={S.center}><ActivityIndicator color={colors.primary} size="large" /></View>
      ) : list.length === 0 ? (
        <View style={S.center}>
          <Ionicons name="people-circle-outline" size={56} color={colors.textDim} />
          <Text style={S.emptyTitle}>No communities yet</Text>
          <Text style={S.emptySub}>Communities bring related groups together under one roof.</Text>
          <TouchableOpacity style={S.cta} onPress={() => { setName(''); setDesc(''); setModal('community'); }}><Text style={S.ctaTxt}>New community</Text></TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={list}
          keyExtractor={c => c.id}
          contentContainerStyle={{ paddingVertical: 6 }}
          renderItem={({ item: c }) => (
            <TouchableOpacity style={S.row} activeOpacity={0.7} onPress={() => openCommunity(c.id)}>
              <View style={S.commIconSm}><Ionicons name="people" size={22} color="#fff" /></View>
              <View style={{ flex: 1 }}>
                <Text style={S.rowName} numberOfLines={1}>{c.name}</Text>
                <Text style={S.rowSub} numberOfLines={1}>{c.description || `${c.groupCount} group${c.groupCount === 1 ? '' : 's'}`}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
            </TouchableOpacity>
          )}
        />
      )}
      {nameModal()}
    </View>
  );

  function nameModal() {
    return (
      <Modal visible={modal != null} transparent animationType="fade" onRequestClose={() => setModal(null)}>
        <View style={S.modalBackdrop}>
          <View style={S.modalCard}>
            <Text style={S.modalTitle}>{modal === 'group' ? 'New group' : 'New community'}</Text>
            <TextInput style={S.modalInput} value={name} onChangeText={setName} placeholder={modal === 'group' ? 'Group name' : 'Community name'} placeholderTextColor={colors.textDim} autoFocus maxLength={100} />
            {modal === 'community' && (
              <TextInput style={[S.modalInput, { minHeight: 60, textAlignVertical: 'top' }]} value={desc} onChangeText={setDesc} placeholder="Description (optional)" placeholderTextColor={colors.textDim} multiline maxLength={512} />
            )}
            <View style={S.modalBtns}>
              <TouchableOpacity onPress={() => setModal(null)} style={S.modalBtn}><Text style={S.modalCancel}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity onPress={submitModal} disabled={!name.trim() || busy} style={[S.modalBtn, S.modalBtnPrimary, (!name.trim() || busy) && { opacity: 0.5 }]}>
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={S.modalCreate}>Create</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    );
  }
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  center:  { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 40 },
  header:  { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingTop: HEADER_TOP, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  hBtn:    { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  hTitle:  { flex: 1, color: c.text, fontSize: 18, fontWeight: '700' },

  commHero: { alignItems: 'center', paddingVertical: 24, gap: 8 },
  commIcon: { width: 80, height: 80, borderRadius: 24, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  commName: { color: c.text, fontSize: 22, fontWeight: '800', marginTop: 8 },
  commDesc: { color: c.textDim, fontSize: 14, textAlign: 'center', lineHeight: 20, paddingHorizontal: 24 },
  sectionLabel: { color: c.textDim, fontSize: 12, fontWeight: '700', letterSpacing: 1, marginHorizontal: 16, marginTop: 8, marginBottom: 4 },

  row:      { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 12 },
  rowName:  { color: c.text, fontSize: 16, fontWeight: '600' },
  rowSub:   { color: c.textDim, fontSize: 13, marginTop: 2 },
  commIconSm: { width: 48, height: 48, borderRadius: 16, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  groupIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: c.surfaceSolid, alignItems: 'center', justifyContent: 'center' },
  addRow:   { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 12 },
  addIcon:  { width: 44, height: 44, borderRadius: 22, borderWidth: 1.5, borderColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  addTxt:   { color: c.primary, fontSize: 16, fontWeight: '600' },

  emptyTitle: { color: c.text, fontSize: 18, fontWeight: '700' },
  emptySub: { color: c.textDim, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  cta:      { marginTop: 8, backgroundColor: c.primary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 14 },
  ctaTxt:   { color: '#fff', fontWeight: '800', fontSize: 14 },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 28 },
  modalCard: { width: '100%', maxWidth: 360, backgroundColor: c.surfaceSolid, borderRadius: 18, padding: 18, gap: 12 },
  modalTitle: { color: c.text, fontSize: 17, fontWeight: '800' },
  modalInput: { color: c.text, backgroundColor: c.glassSoft, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
  modalBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  modalBtn:  { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12 },
  modalBtnPrimary: { backgroundColor: c.primary, minWidth: 84, alignItems: 'center' },
  modalCancel: { color: c.textDim, fontWeight: '700' },
  modalCreate: { color: '#fff', fontWeight: '800' },
});
