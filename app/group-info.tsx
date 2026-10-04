// app/group-info.tsx — Day 14 group info screen.
//
// Shows:
//   * group photo + name (editable by admin/owner; tap → image picker / rename)
//   * member list with name + email + presence dot
//   * "Add member" (admin/owner only) — contact picker that SENDS AN INVITATION;
//     the invitee accepts or declines in /group-invitations before joining
//   * Per-row "Remove" (admin/owner only; owner can't be removed)
//   * "Leave group" (any member)
//
// Backend: GET /chats/:id, PATCH /chats/:id, POST /chats/:id/members,
// DELETE /chats/:id/members/:userId

import { useAuthHeader } from '../hooks/useAuthHeader';
import { userErrorText } from '../lib/userErrorText';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { getShareViewing, setShareViewing } from '../lib/viewerPrefs';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { getCurrentUserAsync } from './(constants)/authService';
import { initialOf } from '../lib/format';
import { readCache, writeCache } from '../lib/localCache';
import {
  attachmentUrl,
  getChat,
  removeChatMember,
  updateChat,
  uploadAttachment,
  getMessages,
  type ChatDetail,
  type ChatMember,
  type Message,
} from '../lib/chatService';
import { unionWithLocalHistory } from '../lib/messageHistory';
import { recentServerMedia } from '../lib/groups/mediaPageCache';
import { AuroraBackground, KeyboardSafe, AppText as Text } from '../components/ui';
import { permissionDenied } from '../lib/permissionDenied';
import { memberActions } from '../lib/groups/permissions';
import { GroupNotFound } from '../components/groups/GroupNotFound';
import { GroupInfoTools, MemberRow } from '../components/groups/GroupInfoSections';
import { useGroupInfoStyles as useS } from '../components/groups/groupInfoStyles';

// The paint-first cache is plain AsyncStorage (lib/localCache), so members'
// email addresses are left out of it: a cached member with no name shows a
// short id until the refresh lands. Names and photos stay, as the chat list's
// own cache keeps them.
function forCache(c: ChatDetail): ChatDetail {
  return { ...c, members: c.members.map(({ email: _email, ...m }) => m) };
}

export default function GroupInfoScreen() {
  const { colors } = useTheme();
  const S = useS();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const chatId = (id ?? '').toString();

  const { width: SW } = useWindowDimensions();
  const mediaSize = (SW - 32 - 8) / 3;   // section padding 16*2, two 4px gaps

  const [chat, setChat]   = useState<ChatDetail | null>(null);
  const [media, setMedia] = useState<Message[]>([]);
  const [meId, setMeId]   = useState<string | null>(null);
  const authHeader = useAuthHeader();

  const [loading,   setLoading]   = useState(true);
  // First load failed with no cache: an error screen with Retry and Back.
  const [loadError, setLoadError] = useState<string | null>(null);
  // A refresh failed while the cached copy is on screen: a banner with Retry.
  const [stale, setStale] = useState(false);
  // Rename / description save in flight (double-submit guard).
  const [saving,    setSaving]    = useState(false);
  const [renaming,  setRenaming]  = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [photoBusy, setPhotoBusy] = useState(false);
  const [memberQuery, setMemberQuery] = useState('');
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState('');
  const [shareViewing, setShareViewingState] = useState(true);   // Live Chat Viewers (#58) — group default ON
  useEffect(() => { if (chatId) getShareViewing(chatId, true).then(setShareViewingState).catch(() => {}); }, [chatId]);
  const shareSeq = useRef(0);
  const toggleShareViewing = useCallback(async (on: boolean) => {
    const mine = ++shareSeq.current;
    setShareViewingState(on);
    // setShareViewing rejects when the write fails: put the switch back and say
    // so. Only the latest toggle reverts, so a quick on-off is not undone.
    try {
      await setShareViewing(chatId, on);
    } catch {
      if (mine !== shareSeq.current) return;
      setShareViewingState(!on);
      Alert.alert('Could not save', 'Your viewing-status setting was not changed. Try again.');
    }
  }, [chatId]);

  const load = useCallback(async () => {
    // No id — a malformed deep link, or a push whose payload lost the chat id.
    // Without this the screen called getChat('') → GET /chats/ , which matches
    // no route and comes back as the Go gateway's catch-all: the user saw an
    // alert reading "route not migrated to go backend". That is a message for
    // whoever wired the proxy, not for the person holding the phone.
    //
    // The rest of this function already knows the id can be empty (it guards the
    // cache read and write on `chatId`) — only the fetch between them did not.
    if (!chatId) { setLoading(false); return; }

    // Cache key includes the chat id so different groups don't collide.
    const cacheKey = 'group-info:' + chatId;
    let painted = false;
    try {
      // Local-first: paint the last-known group detail instantly, then refresh.
      const cached = chatId ? await readCache<ChatDetail>(cacheKey) : null;
      if (cached) {
        setChat(cached);
        setNameDraft(cached.name ?? '');
        setLoading(false);
        painted = true;
      } else {
        setLoading(true);
      }

      const [c, me] = await Promise.all([
        getChat(chatId), getCurrentUserAsync(),
      ]);
      setChat(c);
      setMeId(me?.id ?? null);
      setNameDraft(c.name ?? '');
      setLoadError(null);
      setStale(false);
      if (chatId) writeCache<ChatDetail>(cacheKey, forCache(c));
    } catch (e) {
      // Keep painted cache on error; only surface failure when nothing is shown.
      // Rendered as a screen (not an Alert) so there is a Back and a Retry —
      // the bare spinner used to trap the user.
      if (!painted) setLoadError(userErrorText(e, 'Check your connection and try again.'));
      else setStale(true);
    } finally {
      if (!painted) setLoading(false);
    }
  }, [chatId]);

  useEffect(() => { load(); }, [load]);

  // Stale-banner Retry in flight: the banner shows a spinner (and stays, so a
  // second failure keeps the warning) until the refresh settles.
  const [retrying, setRetrying] = useState(false);
  const retryStale = useCallback(async () => {
    if (retrying) return;
    setRetrying(true);
    try { await load(); } finally { setRetrying(false); }
  }, [retrying, load]);

  // Shared-media strip: the newest 9 images/videos. The device's own history
  // paints first (no network, and delete-on-delivery nulls a delivered body
  // server-side, so the server list alone drops media this phone can still
  // render); then one server page is merged in the background, so media this
  // phone has not synced yet still shows. That page is read at most once per
  // few minutes per group (lib/groups/mediaPageCache), not on every visit.
  // Best-effort: if the server page fails, the local strip stays as it is.
  useEffect(() => {
    if (!chatId) return;
    let active = true;
    const pick = (list: Message[]) =>
      list.filter(m => !m.deletedAt && (m.type === 'image' || m.type === 'video')).slice(0, 9);
    (async () => {
      const local = pick(await unionWithLocalHistory(chatId, [], 400).catch(() => [] as Message[]));
      if (active && local.length) setMedia(local);
      // Keyed by the signed-in user as well, so an account switch never reuses another account's page.
      const viewer = await getCurrentUserAsync().then(u => (u?.id != null ? String(u.id) : null), () => null);
      const server = await recentServerMedia(viewer, chatId, () => getMessages(chatId, { limit: 200 }));
      if (!server) return;
      const merged = await unionWithLocalHistory(chatId, server, 400).catch(() => null);
      if (active && merged) setMedia(pick(merged));
    })();
    return () => { active = false; };
  }, [chatId]);

  // Apply an optimistic update to `chat` AND persist it so re-opens stay accurate.
  const patchChat = useCallback((fn: (prev: ChatDetail) => ChatDetail) => {
    setChat(prev => {
      if (!prev) return prev;
      const next = fn(prev);
      if (chatId) writeCache<ChatDetail>('group-info:' + chatId, forCache(next));
      return next;
    });
  }, [chatId]);

  const myRole = chat?.members.find(m => m.userId === meId)?.role;
  const isAdmin = myRole === 'admin' || myRole === 'owner';

  const onRename = useCallback(async () => {
    if (!chat || !isAdmin || saving) return;
    const n = nameDraft.trim();
    if (!n || n === chat.name) { setRenaming(false); return; }
    setSaving(true);
    try {
      await updateChat(chat.id, { name: n });
      patchChat(prev => ({ ...prev, name: n }));
    } catch (e) {
      Alert.alert('Rename failed', userErrorText(e, 'Try again'));
    } finally {
      setSaving(false);
      setRenaming(false);
    }
  }, [chat, isAdmin, nameDraft, saving, patchChat]);

  const onSaveDesc = useCallback(async () => {
    if (saving) return;
    if (!chat || !isAdmin) { setEditingDesc(false); return; }
    const d = descDraft.trim();
    setSaving(true);
    try {
      await updateChat(chat.id, { description: d });
      patchChat(prev => ({ ...prev, description: d || null }));
    } catch (e) { Alert.alert('Could not save', userErrorText(e, 'Try again')); }
    finally { setSaving(false); setEditingDesc(false); }
  }, [chat, isAdmin, descDraft, saving, patchChat]);

  const onChangePhoto = useCallback(async () => {
    if (!chat || !isAdmin || photoBusy) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      permissionDenied('Permission needed', 'Allow photo library access to set the group photo.', perm.canAskAgain);
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'], quality: 0.7, allowsEditing: true, aspect: [1, 1],
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    setPhotoBusy(true);
    try {
      const up = await uploadAttachment(
        asset.uri,
        asset.fileName || `group-${Date.now()}.jpg`,
        asset.mimeType || 'image/jpeg',
      );
      await updateChat(chat.id, { photoURL: up.id });
      patchChat(prev => ({ ...prev, photoURL: up.id }));
    } catch (e) {
      Alert.alert('Photo upload failed', userErrorText(e, 'Try again'));
    } finally {
      setPhotoBusy(false);
    }
  }, [chat, isAdmin, photoBusy, patchChat]);

  // Leave and Remove: one at a time, taken when the confirmation OPENS (two
  // taps opened two dialogs and sent two requests); released by Cancel, an
  // Android outside-tap dismiss, or when the request settles.
  // `memberBusy` mirrors the latch for drawing: the row being removed shows a
  // spinner and every other Remove is disabled while it is held.
  const memberActionOpen = useRef(false);
  const [memberBusy, setMemberBusy] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const onRemoveMember = useCallback((m: ChatMember) => {
    // Gated where the button is drawn (memberActions); the server re-checks.
    if (!chat || memberActionOpen.current) return;
    memberActionOpen.current = true;
    setMemberBusy(true);
    const release = () => { memberActionOpen.current = false; setMemberBusy(false); setRemovingId(null); };
    Alert.alert(
      'Remove from group?',
      `${m.name || m.email || 'This user'} will no longer be a member.`,
      [
        { text: 'Cancel', style: 'cancel', onPress: release },
        { text: 'Remove', style: 'destructive', onPress: async () => {
            setRemovingId(m.userId);
            try {
              await removeChatMember(chat.id, m.userId);
              patchChat(prev => ({
                ...prev,
                members: prev.members.map(x => x.userId === m.userId ? { ...x, leftAt: new Date().toISOString() } : x),
              }));
            } catch (e) {
              Alert.alert('Remove failed', userErrorText(e, 'Try again'));
            } finally { release(); }
          }
        },
      ],
      { cancelable: true, onDismiss: release },
    );
  }, [chat, patchChat]);

  const [leaving, setLeaving] = useState(false);
  // Opened from a cold-start link there is nothing underneath to go back to.
  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back(); else router.replace('/(tabs)/chats');
  }, [router]);
  const onLeave = useCallback(() => {
    if (!chat || !meId || memberActionOpen.current) return;
    memberActionOpen.current = true;
    setMemberBusy(true);
    const release = () => { memberActionOpen.current = false; setMemberBusy(false); };
    Alert.alert('Leave group?', 'You will lose access to future messages.', [
      { text: 'Cancel', style: 'cancel', onPress: release },
      { text: 'Leave', style: 'destructive', onPress: async () => {
          setLeaving(true);
          try {
            await removeChatMember(chat.id, meId);
            router.replace('/(tabs)/chats');
          } catch (e) {
            setLeaving(false);
            release();
            Alert.alert('Leave failed', userErrorText(e, 'Try again'));
          }
        }
      },
    ], { cancelable: true, onDismiss: release });
  }, [chat, meId, router]);

  // Pick from contacts → send an INVITATION (the person accepts or declines in
  // /group-invitations before they join). Same screen and same consent path as
  // Family Space, so "add member" behaves identically wherever you do it.
  //
  // This replaced a prompt that asked the ADMIN to paste the invitee's user id
  // on iOS and, on Android, just opened /contacts — which starts a direct chat
  // and never touched this group. Neither asked the invitee anything.
  const onAddMember = useCallback(() => {
    if (!chat || !isAdmin) return;
    router.push({
      pathname: '/family-add',
      params: { chatId: chat.id, name: chat.name ?? 'Group' },
    });
  }, [chat, isAdmin, router]);

  // No id at all — a malformed deep link or a push that lost its chat id.
  // Falling through to the spinner below would leave a screen that spins
  // forever with nothing to press: `loading` is false and `chat` is null, so it
  // never resolves and there is no header to go back from. Say what happened and
  // give a way out.
  if (!chatId) return <GroupNotFound title="Group info" />;

  if (!loading && !chat && loadError) {
    return (
      <View style={[S.screen, S.center]}>
        <AuroraBackground />
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: 6 }}>Couldn’t load this group</Text>
        <Text style={{ color: colors.textDim, fontSize: 13, textAlign: 'center', marginBottom: 16, paddingHorizontal: 32 }}>{loadError}</Text>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Retry loading the group" onPress={() => { setLoadError(null); load(); }} style={S.saveBtn}>
          <Text style={S.saveBtnTxt}>Retry</Text>
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Go back" onPress={goBack} activeOpacity={0.8} style={{ marginTop: 16, padding: 8 }}>
          <Text style={{ color: colors.primary, fontSize: 15, fontWeight: '700' }}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (loading || !chat) {
    return (
      <View style={[S.screen, S.center]}>
        <AuroraBackground />
        <View style={[S.header, { position: 'absolute', top: 0, left: 0, right: 0 }]}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Go back" onPress={goBack} hitSlop={10} style={S.backBtn}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>
        </View>
        <ActivityIndicator color={colors.primary} size="large" accessibilityLabel="Loading group" />
      </View>
    );
  }

  const activeMembers = chat.members.filter(m => !m.leftAt);
  const mq = memberQuery.trim().toLowerCase();
  const shownMembers = mq
    ? activeMembers.filter(m => (m.name || m.email || m.userId).toLowerCase().includes(mq))
    : activeMembers;

  // One FlatList is the screen's only scroller: everything above the member
  // list is its header, Leave is its footer. A non-scrolling FlatList nested
  // in a ScrollView rendered every member at once.
  const header = (
    <>
      <View style={S.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Go back" onPress={goBack} hitSlop={10} style={S.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.titleBar} accessibilityRole="header">Group info</Text>
      </View>

      <View style={S.heroWrap}>
        <TouchableOpacity onPress={onChangePhoto} disabled={!isAdmin || photoBusy} activeOpacity={0.85}
          accessibilityRole={isAdmin ? 'button' : 'image'} accessibilityLabel={isAdmin ? 'Change group photo' : 'Group photo'}
          accessibilityState={isAdmin ? { busy: photoBusy, disabled: photoBusy } : undefined}>
          <View style={S.hero}>
            {chat.photoURL && authHeader ? (
              <Image
                source={{ uri: attachmentUrl(chat.photoURL), headers: { Authorization: authHeader } }}
                style={S.heroImg}
              />
            ) : (
              <Text style={S.heroTxt}>{initialOf(chat.name, '#')}</Text>
            )}
            {photoBusy && (
              <View style={S.heroBusy}><ActivityIndicator color={colors.onPrimary} /></View>
            )}
            {isAdmin && <View style={S.heroEditPill}><Ionicons name="camera" size={15} color={colors.onPrimary} /></View>}
          </View>
        </TouchableOpacity>

        {renaming ? (
          <View style={S.renameRow}>
            <TextInput
              style={S.renameInput}
              value={nameDraft}
              onChangeText={setNameDraft}
              placeholder="Group name"
              placeholderTextColor={colors.textDim}
              autoFocus
              maxLength={100}
              onSubmitEditing={onRename}
              accessibilityLabel="Group name"
            />
            <TouchableOpacity onPress={onRename} disabled={saving} style={[S.saveBtn, saving && { opacity: 0.6 }]}
              accessibilityRole="button" accessibilityLabel="Save group name" accessibilityState={{ disabled: saving, busy: saving }}>
              {saving ? <ActivityIndicator color={colors.onPrimary} size="small" /> : <Text style={S.saveBtnTxt}>Save</Text>}
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity disabled={!isAdmin} onPress={() => setRenaming(true)} activeOpacity={isAdmin ? 0.7 : 1}
            accessibilityRole={isAdmin ? 'button' : 'header'} accessibilityLabel={isAdmin ? `${chat.name || 'Untitled group'}. Rename group` : chat.name || 'Untitled group'}>
            <Text numberOfLines={1} style={S.groupName}>{chat.name || 'Untitled group'}</Text>
          </TouchableOpacity>
        )}
        <Text style={S.subInfo}>{activeMembers.length} members</Text>
      </View>

      {stale && (
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Couldn't refresh this group. Showing the saved copy. Retry"
          accessibilityState={{ busy: retrying, disabled: retrying }} disabled={retrying}
          onPress={retryStale} style={S.staleBar}>
          {retrying
            ? <ActivityIndicator size="small" color={colors.danger} accessibilityLabel="Retrying" />
            : <Ionicons name="cloud-offline-outline" size={15} color={colors.danger} />}
          <Text style={S.staleTxt}>Couldn’t refresh — this may be out of date. Tap to retry.</Text>
        </TouchableOpacity>
      )}

      {/* Group description (WhatsApp) */}
      <View style={S.section}>
        {editingDesc ? (
          <View style={S.descEditRow}>
            <TextInput
              style={S.descInput}
              value={descDraft}
              onChangeText={setDescDraft}
              placeholder="Add a group description"
              placeholderTextColor={colors.textDim}
              multiline
              maxLength={512}
              autoFocus
              accessibilityLabel="Group description"
            />
            <TouchableOpacity onPress={onSaveDesc} disabled={saving} style={[S.saveBtn, saving && { opacity: 0.6 }]}
              accessibilityRole="button" accessibilityLabel="Save description" accessibilityState={{ disabled: saving, busy: saving }}>
              {saving ? <ActivityIndicator color={colors.onPrimary} size="small" /> : <Text style={S.saveBtnTxt}>Save</Text>}
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            disabled={!isAdmin}
            activeOpacity={isAdmin ? 0.7 : 1}
            accessibilityRole={isAdmin ? 'button' : undefined}
            accessibilityHint={isAdmin ? 'Edit the group description' : undefined}
            onPress={() => { setDescDraft(chat.description ?? ''); setEditingDesc(true); }}
          >
            <Text style={S.label} accessibilityRole="header">DESCRIPTION</Text>
            <Text style={chat.description ? S.descText : S.descPlaceholder}>
              {chat.description || (isAdmin ? 'Add a group description' : 'No description')}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {isAdmin && (
        <TouchableOpacity style={S.addBtn} onPress={onAddMember} activeOpacity={0.85} accessibilityRole="button">
          <Ionicons name="person-add-outline" size={18} color={colors.primary} />
          <Text style={S.addBtnTxt}>Add member</Text>
        </TouchableOpacity>
      )}

      <GroupInfoTools chat={chat} isAdmin={isAdmin} media={media} mediaSize={mediaSize}
        authHeader={authHeader} shareViewing={shareViewing} onShareViewing={toggleShareViewing} />

      <View style={S.section}>
        <Text style={S.label} accessibilityRole="header">{activeMembers.length} MEMBERS</Text>
        {activeMembers.length > 8 && (
          <View style={S.memberSearch}>
            <Ionicons name="search" size={16} color={colors.textDim} />
            <TextInput
              style={S.memberSearchInput}
              value={memberQuery}
              onChangeText={setMemberQuery}
              placeholder="Search members"
              placeholderTextColor={colors.textDim}
              accessibilityLabel="Search members"
            />
            {memberQuery.length > 0 && (
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Clear member search" onPress={() => setMemberQuery('')} hitSlop={14}>
                <Ionicons name="close-circle" size={16} color={colors.textDim} />
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>
    </>
  );

  return (
    <KeyboardSafe style={S.screen}>
      <AuroraBackground />
      <FlatList
        data={shownMembers}
        keyExtractor={m => m.userId}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 64 }}
        ListHeaderComponent={header}
        renderItem={({ item: m }) => (
          <View style={S.memberItem}>
            <MemberRow
              member={m}
              meId={meId}
              canRemove={memberActions({
                actorRole: myRole ?? 'member', targetRole: m.role, isMe: m.userId === meId,
                typed: !!chat.groupType, permissions: chat.permissions,
              }).canRemove}
              authHeader={authHeader}
              onRemove={() => onRemoveMember(m)}
              removing={removingId === m.userId}
              locked={memberBusy}
            />
          </View>
        )}
        ListEmptyComponent={mq ? <Text style={[S.descPlaceholder, S.memberItem]}>No members match “{memberQuery.trim()}”.</Text> : null}
        ListFooterComponent={
          <TouchableOpacity style={S.leaveBtn} onPress={onLeave} activeOpacity={0.85} accessibilityRole="button"
            disabled={leaving || memberBusy} accessibilityState={{ busy: leaving, disabled: leaving || memberBusy }}>
            {leaving
              ? <ActivityIndicator size="small" color={colors.danger} />
              : <Text style={S.leaveTxt}>Leave group</Text>}
          </TouchableOpacity>
        }
      />
    </KeyboardSafe>
  );
}
