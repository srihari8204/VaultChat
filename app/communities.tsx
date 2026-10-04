// app/communities.tsx — WhatsApp-style Communities (real, Postgres-backed).
//
// A community is an umbrella over group chats with an auto-created Announcements
// group. List your communities → open one → see its groups → tap to chat.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, ScrollView, FlatList, TouchableOpacity, Alert, ActivityIndicator, BackHandler,
} from 'react-native';
import { useRouter, useFocusEffect, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import {
  listCommunities, createCommunity, getCommunity, createCommunityGroup, listChats,
  type Community, type CommunityDetail, type ChatSummary,
} from '../lib/chatService';
import { clearCache, readCache, writeCache } from '../lib/localCache';
import { AuroraBackground } from '../components/ui';
import { AppText as Text } from '../components/ui/Text';
import { makeCommunityStyles } from '../components/groups/communityStyles';
import { CommunityNameModal, type NameModalMode } from '../components/groups/CommunityNameModal';
import { CommunityDetailView, type CommunityAction, type ManageSupport } from '../components/groups/CommunityDetailView';
import { CommunityAttachSheet } from '../components/groups/CommunityAttachSheet';
import {
  editCommunity, deleteCommunity, leaveCommunity, attachGroupToCommunity, NotAvailableYet,
  communityManagementSupported,
} from '../lib/groups/serverContracts';

export default function CommunitiesScreen() {
  const { colors } = useTheme();
  const S = useMemo(() => makeCommunityStyles(colors), [colors]);
  const router = useRouter();

  const [list, setList] = useState<Community[]>([]);
  const [detail, setDetail] = useState<CommunityDetail | null>(null);
  // The detail on screen is the saved copy: its refresh failed.
  const [detailStale, setDetailStale] = useState(false);
  const [loading, setLoading] = useState(true);
  // Set when the network refresh failed; the cached list (if any) stays shown.
  const [loadError, setLoadError] = useState(false);
  // Single name/desc modal: "new community", "new group" and "edit community".
  const [modal, setModal] = useState<NameModalMode | null>(null);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  // Error-bar retry in flight: the bar shows a spinner instead of looking dead.
  const [retrying, setRetrying] = useState(false);
  // A management request in flight (edit / delete / leave / attach).
  const [acting, setActing] = useState<CommunityAction | null>(null);
  // "Add a group you manage" picker.
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachState, setAttachState] = useState<'loading' | 'ok' | 'failed'>('loading');
  const [myGroups, setMyGroups] = useState<ChatSummary[]>([]);
  // Only the latest openCommunity may write: tapping A then B must end on B.
  const openSeq = useRef(0);
  // Edit / delete / leave / attach are new server routes (R4 backend C9, not
  // deployed yet). Asked once per app session; while missing, the detail view
  // shows a note instead of four actions that would fail after a confirm.
  const [manage, setManage] = useState<ManageSupport>('probing');
  const detailId = detail?.id;
  useEffect(() => {
    if (!detailId) return;
    let live = true;
    communityManagementSupported(detailId).then(
      (k) => { if (live) setManage(k === null ? 'unknown' : k ? 'yes' : 'no'); },
      () => { if (live) setManage('unknown'); },
    );
    return () => { live = false; };
  }, [detailId]);

  /** A C9 route turned out to be missing (the probe could not tell earlier). */
  const notYet = useCallback((e: unknown, what: string) => {
    if (!(e instanceof NotAvailableYet)) return false;
    setManage('no');
    Alert.alert('Not available yet', `${what} needs a server update that has not been released. Nothing was changed.`);
    return true;
  }, []);

  const loadList = useCallback(async () => {
    // Local-first: paint cached list instantly, then refresh in background.
    try {
      const cached = await readCache<Community[]>('communities');
      if (cached) { setList(cached); setLoading(false); }
    } catch { /* unreadable cache: fall through to the network */ }
    try {
      const l = await listCommunities();
      setList(l);
      setLoadError(false);
      writeCache('communities', l);
    } catch { setLoadError(true); /* keep cached list for offline read */ }
    finally { setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { if (!detail) loadList(); }, [detail, loadList]));

  const closeDetail = useCallback(() => { openSeq.current++; setDetail(null); setDetailStale(false); }, []);

  // Detail is in-screen state, not a route: Android back returns to the list.
  useEffect(() => {
    if (!detail) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { closeDetail(); return true; });
    return () => sub.remove();
  }, [detail, closeDetail]);

  const openCommunity = useCallback(async (id: string) => {
    const seq = ++openSeq.current;
    let cached: CommunityDetail | null = null;
    try {
      // Local-first: paint cached detail instantly, else show spinner. Read
      // inside the try: an unreadable cache must fall through to the network.
      cached = await readCache<CommunityDetail>('community:' + id).catch(() => null);
      if (seq !== openSeq.current) return;
      if (cached) { setDetail(cached); setLoading(false); }
      else setLoading(true);
      const d = await getCommunity(id);
      if (seq !== openSeq.current) return;
      setDetail(d);
      setDetailStale(false);
      writeCache('community:' + id, d);
    } catch {
      if (seq !== openSeq.current) return;
      if (cached) setDetailStale(true);
      else Alert.alert('Could not open this community', 'Check your connection and try again.');
    }
    finally { if (seq === openSeq.current) setLoading(false); }
  }, []);

  const retryList = useCallback(async () => {
    if (retrying) return;
    setRetrying(true);
    try { await loadList(); } finally { setRetrying(false); }
  }, [retrying, loadList]);

  const retryDetail = useCallback(async () => {
    if (!detail || retrying) return;
    setRetrying(true);
    try { await openCommunity(detail.id); } finally { setRetrying(false); }
  }, [detail, retrying, openCommunity]);

  const loadMyGroups = useCallback(async () => {
    setAttachState('loading');
    try {
      const inHere = new Set(detail?.groups.map((g) => g.id) ?? []);
      setMyGroups((await listChats()).filter((c) =>
        c.type === 'group' && (c.myRole === 'owner' || c.myRole === 'admin') && !inHere.has(c.id)));
      setAttachState('ok');
    } catch { setAttachState('failed'); }
  }, [detail]);

  const attach = useCallback(async (g: ChatSummary) => {
    if (!detail || acting) return;
    setAttachOpen(false);
    setActing('attach');
    try {
      await attachGroupToCommunity(detail.id, g.id);
      await openCommunity(detail.id);
    } catch (e: any) {
      if (!notYet(e, 'Adding an existing group')) Alert.alert('Could not add the group', e?.message ?? 'Try again.');
    } finally { setActing(null); }
  }, [detail, acting, openCommunity, notYet]);

  const onAction = useCallback((a: CommunityAction) => {
    if (!detail || acting) return;
    const d = detail;
    if (a === 'edit') { setName(d.name); setDesc(d.description ?? ''); setModal('edit'); return; }
    if (a === 'attach') { setAttachOpen(true); loadMyGroups(); return; }
    const run = async () => {
      setActing(a);
      try {
        if (a === 'delete') await deleteCommunity(d.id); else await leaveCommunity(d.id);
        // The saved copy would reopen a community that is gone (or left).
        clearCache('community:' + d.id).catch(() => {});
        closeDetail();
        loadList();
      } catch (e: any) {
        if (!notYet(e, a === 'delete' ? 'Deleting a community' : 'Leaving a community')) {
          Alert.alert(a === 'delete' ? 'Could not delete' : 'Could not leave', e?.message ?? 'Try again.');
        }
      } finally { setActing(null); }
    };
    if (a === 'delete') {
      Alert.alert(`Delete ${d.name}?`,
        'The community is removed for everyone. Its groups stay as ordinary groups, with their members and messages.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: run },
        ]);
    } else {
      Alert.alert(`Leave ${d.name}?`, 'You leave every group of this community you are in.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Leave', style: 'destructive', onPress: run },
      ]);
    }
  }, [detail, acting, loadMyGroups, closeDetail, loadList, notYet]);

  const submitModal = useCallback(async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    try {
      if (modal === 'edit' && detail) {
        try {
          await editCommunity(detail.id, { name: n, description: desc.trim() });
        } catch (e) {
          if (notYet(e, 'Editing a community')) { setModal(null); return; }
          throw e;
        }
        setModal(null);
        await openCommunity(detail.id);
      } else if (modal === 'community') {
        const r = await createCommunity(n, desc.trim() || undefined);
        setModal(null); setName(''); setDesc('');
        await openCommunity(r.id);
        loadList();
      } else if (modal === 'group' && detail) {
        await createCommunityGroup(detail.id, n);
        setModal(null); setName('');
        await openCommunity(detail.id);
      }
    } catch (e: any) { Alert.alert(modal === 'edit' ? 'Could not save' : 'Could not create', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  }, [name, desc, modal, detail, busy, openCommunity, loadList, notYet]);

  const nameModal = (
      <CommunityNameModal S={S} mode={modal} name={name} desc={desc} onName={setName} onDesc={setDesc}
        busy={busy} onCancel={() => setModal(null)} onSubmit={submitModal} />
  );

  // ── Community detail view ──────────────────────────────────────────
  if (detail) {
    return (
      <>
        <CommunityDetailView
          S={S} detail={detail} stale={detailStale} retrying={retrying} acting={acting} manage={manage}
          onBack={closeDetail} onRetry={retryDetail}
          onOpenGroup={(id) => router.push({ pathname: '/chat', params: { id } })}
          onNewGroup={() => { setName(''); setModal('group'); }}
          onAction={onAction}
        />
        <CommunityAttachSheet S={S} visible={attachOpen} state={attachState} groups={myGroups}
          onPick={attach} onRetry={loadMyGroups} onClose={() => setAttachOpen(false)} />
        {nameModal}
      </>
    );
  }

  // ── Communities list ───────────────────────────────────────────────
  return (
    <View style={S.screen}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />
      <View style={S.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={S.hBtn} hitSlop={8}><Ionicons name="arrow-back" size={24} color={colors.text} /></TouchableOpacity>
        <Text style={S.hTitle} accessibilityRole="header">Communities</Text>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="New community" onPress={() => { setName(''); setDesc(''); setModal('community'); }} style={S.hBtn} hitSlop={8}><Ionicons name="add" size={24} color={colors.text} /></TouchableOpacity>
      </View>

      {loadError && !loading && list.length > 0 && (
        <TouchableOpacity style={S.errBar} accessibilityRole="button" accessibilityLabel="Couldn't refresh communities. Showing saved list. Retry"
          accessibilityState={{ busy: retrying, disabled: retrying }} disabled={retrying} onPress={retryList}>
          {retrying
            ? <ActivityIndicator color={colors.danger} size="small" accessibilityLabel="Retrying" />
            : <Text style={S.errTxt}>Couldn’t refresh — showing saved list. Tap to retry.</Text>}
        </TouchableOpacity>
      )}
      {loading ? (
        <View style={S.center}><ActivityIndicator color={colors.primary} size="large" /></View>
      ) : list.length === 0 && loadError ? (
        <ScrollView contentContainerStyle={S.center}>
          <Ionicons name="cloud-offline-outline" size={56} color={colors.textDim} />
          <Text style={S.emptyTitle}>Couldn’t load communities</Text>
          <Text style={S.emptySub}>Check your connection and try again.</Text>
          <TouchableOpacity style={S.cta} accessibilityRole="button" accessibilityLabel="Retry loading communities" onPress={() => { setLoading(true); loadList(); }}><Text style={S.ctaTxt}>Retry</Text></TouchableOpacity>
        </ScrollView>
      ) : list.length === 0 ? (
        <ScrollView contentContainerStyle={S.center}>
          <Ionicons name="people-circle-outline" size={56} color={colors.textDim} />
          <Text style={S.emptyTitle}>No communities yet</Text>
          <Text style={S.emptySub}>Communities bring related groups together under one roof.</Text>
          <TouchableOpacity style={S.cta} accessibilityRole="button" accessibilityLabel="Create a new community" onPress={() => { setName(''); setDesc(''); setModal('community'); }}><Text style={S.ctaTxt}>New community</Text></TouchableOpacity>
        </ScrollView>
      ) : (
        <FlatList
          data={list}
          keyExtractor={c => c.id}
          contentContainerStyle={S.listContent}
          renderItem={({ item: c }) => (
            <TouchableOpacity style={S.row} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={`${c.name}, ${c.groupCount} group${c.groupCount === 1 ? '' : 's'}`} onPress={() => openCommunity(c.id)}>
              <View style={S.commIconSm}><Ionicons name="people" size={22} color={colors.onPrimary} /></View>
              <View style={{ flex: 1 }}>
                <Text style={S.rowName} numberOfLines={1}>{c.name}</Text>
                <Text style={S.rowSub} numberOfLines={1}>{c.description || `${c.groupCount} group${c.groupCount === 1 ? '' : 's'}`}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
            </TouchableOpacity>
          )}
        />
      )}
      {nameModal}
    </View>
  );
}
