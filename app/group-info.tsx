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

import { HEADER_TOP } from '../constants/layout';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState , useMemo} from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { getShareViewing, setShareViewing } from '../lib/viewerPrefs';
import { Ionicons } from '@expo/vector-icons';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { getCurrentUserAsync } from './(constants)/authService';
import { getAccessToken } from '../lib/api';
import { readCache, writeCache } from '../lib/localCache';
import {
  attachmentUrl,
  getChat,
  removeChatMember,
  updateChat,
  uploadAttachment,
  type ChatDetail,
  type ChatMember,
} from '../lib/chatService';
import { AuroraBackground } from '../components/ui';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function GroupInfoScreen() {
  const { colors } = useTheme();
  const S = useS();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const chatId = (id ?? '').toString();

  const [chat, setChat]   = useState<ChatDetail | null>(null);
  const [meId, setMeId]   = useState<string | null>(null);
  const [authHeader, setAuthHeader] = useState<string | null>(null);

  const [loading,   setLoading]   = useState(true);
  const [renaming,  setRenaming]  = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [photoBusy, setPhotoBusy] = useState(false);
  const [memberQuery, setMemberQuery] = useState('');
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState('');
  const [shareViewing, setShareViewingState] = useState(true);   // Live Chat Viewers (#58) — group default ON
  useEffect(() => { if (chatId) getShareViewing(chatId, true).then(setShareViewingState).catch(() => {}); }, [chatId]);
  const toggleShareViewing = useCallback((on: boolean) => {
    setShareViewingState(on);
    setShareViewing(chatId, on).catch(() => {});
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

      const [c, me, tok] = await Promise.all([
        getChat(chatId), getCurrentUserAsync(), getAccessToken(),
      ]);
      setChat(c);
      setMeId(me?.id ?? null);
      setAuthHeader(tok ? `Bearer ${tok}` : null);
      setNameDraft(c.name ?? '');
      if (chatId) writeCache<ChatDetail>(cacheKey, c);
    } catch (e: any) {
      // Keep painted cache on error; only surface failure when nothing is shown.
      if (!painted) Alert.alert('Could not load group', e?.message ?? 'Try again');
    } finally {
      if (!painted) setLoading(false);
    }
  }, [chatId]);

  useEffect(() => { load(); }, [load]);

  // Apply an optimistic update to `chat` AND persist it so re-opens stay accurate.
  const patchChat = useCallback((fn: (prev: ChatDetail) => ChatDetail) => {
    setChat(prev => {
      if (!prev) return prev;
      const next = fn(prev);
      if (chatId) writeCache<ChatDetail>('group-info:' + chatId, next);
      return next;
    });
  }, [chatId]);

  const myRole = chat?.members.find(m => m.userId === meId)?.role;
  const isAdmin = myRole === 'admin' || myRole === 'owner';

  const onRename = useCallback(async () => {
    if (!chat || !isAdmin) return;
    const n = nameDraft.trim();
    if (!n || n === chat.name) { setRenaming(false); return; }
    try {
      await updateChat(chat.id, { name: n });
      patchChat(prev => ({ ...prev, name: n }));
    } catch (e: any) {
      Alert.alert('Rename failed', e?.message ?? 'Try again');
    } finally {
      setRenaming(false);
    }
  }, [chat, isAdmin, nameDraft]);

  const onSaveDesc = useCallback(async () => {
    if (!chat || !isAdmin) { setEditingDesc(false); return; }
    const d = descDraft.trim();
    try {
      await updateChat(chat.id, { description: d });
      patchChat(prev => ({ ...prev, description: d || null }));
    } catch (e: any) { Alert.alert('Could not save', e?.message ?? 'Try again'); }
    finally { setEditingDesc(false); }
  }, [chat, isAdmin, descDraft]);

  const onChangePhoto = useCallback(async () => {
    if (!chat || !isAdmin || photoBusy) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Allow photo library access to set the group photo.');
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
    } catch (e: any) {
      Alert.alert('Photo upload failed', e?.message ?? 'Try again');
    } finally {
      setPhotoBusy(false);
    }
  }, [chat, isAdmin, photoBusy]);

  const onRemoveMember = useCallback((m: ChatMember) => {
    if (!chat || !isAdmin) return;
    Alert.alert(
      'Remove from group?',
      `${m.name || m.email || 'This user'} will no longer be a member.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: async () => {
            try {
              await removeChatMember(chat.id, m.userId);
              patchChat(prev => ({
                ...prev,
                members: prev.members.map(x => x.userId === m.userId ? { ...x, leftAt: new Date().toISOString() } : x),
              }));
            } catch (e: any) {
              Alert.alert('Remove failed', e?.message ?? 'Try again');
            }
          }
        },
      ],
    );
  }, [chat, isAdmin]);

  const onLeave = useCallback(() => {
    if (!chat || !meId) return;
    Alert.alert('Leave group?', 'You will lose access to future messages.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Leave', style: 'destructive', onPress: async () => {
          try {
            await removeChatMember(chat.id, meId);
            router.replace('/(tabs)/chats' as any);
          } catch (e: any) {
            Alert.alert('Leave failed', e?.message ?? 'Try again');
          }
        }
      },
    ]);
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
      pathname: '/family-add' as any,
      params: { chatId: chat.id, name: chat.name ?? 'Group' },
    });
  }, [chat, isAdmin, router]);

  // No id at all — a malformed deep link or a push that lost its chat id.
  // Falling through to the spinner below would leave a screen that spins
  // forever with nothing to press: `loading` is false and `chat` is null, so it
  // never resolves and there is no header to go back from. Say what happened and
  // give a way out.
  if (!chatId) {
    return (
      <View style={[S.screen, S.center]}>
      <AuroraBackground />
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: 6 }}>
          Group not found
        </Text>
        <Text style={{ color: colors.textDim, fontSize: 13, textAlign: 'center', marginBottom: 16 }}>
          This link did not say which group to open.
        </Text>
        <TouchableOpacity onPress={() => router.back()} activeOpacity={0.8}>
          <Text style={{ color: colors.primary, fontSize: 15, fontWeight: '700' }}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (loading || !chat) {
    return <View style={[S.screen, S.center]}><ActivityIndicator color={colors.primary} size="large" /></View>;
  }

  const activeMembers = chat.members.filter(m => !m.leftAt);
  const mq = memberQuery.trim().toLowerCase();
  const shownMembers = mq
    ? activeMembers.filter(m => (m.name || m.email || m.userId).toLowerCase().includes(mq))
    : activeMembers;

  return (
    <ScrollView style={S.screen} contentContainerStyle={{ paddingBottom: 64 }}>
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={S.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.titleBar}>Group info</Text>
      </View>

      <View style={S.heroWrap}>
        <TouchableOpacity onPress={onChangePhoto} disabled={!isAdmin || photoBusy} activeOpacity={0.85}>
          <View style={S.hero}>
            {chat.photoURL && authHeader ? (
              <Image
                source={{ uri: attachmentUrl(chat.photoURL), headers: { Authorization: authHeader } }}
                style={S.heroImg}
              />
            ) : (
              <Text style={S.heroTxt}>{(chat.name?.trim()[0] ?? '#').toUpperCase()}</Text>
            )}
            {photoBusy && (
              <View style={S.heroBusy}><ActivityIndicator color="#fff" /></View>
            )}
            {isAdmin && <View style={S.heroEditPill}><Ionicons name="camera" size={15} color="#fff" /></View>}
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
            />
            <TouchableOpacity onPress={onRename} style={S.saveBtn}>
              <Text style={S.saveBtnTxt}>Save</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity disabled={!isAdmin} onPress={() => setRenaming(true)} activeOpacity={isAdmin ? 0.7 : 1}>
            <Text numberOfLines={1} style={S.groupName}>{chat.name || 'Untitled group'}</Text>
          </TouchableOpacity>
        )}
        <Text style={S.subInfo}>{activeMembers.length} members</Text>
      </View>

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
            />
            <TouchableOpacity onPress={onSaveDesc} style={S.saveBtn}><Text style={S.saveBtnTxt}>Save</Text></TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            disabled={!isAdmin}
            activeOpacity={isAdmin ? 0.7 : 1}
            onPress={() => { setDescDraft(chat.description ?? ''); setEditingDesc(true); }}
          >
            <Text style={S.label}>DESCRIPTION</Text>
            <Text style={chat.description ? S.descText : S.descPlaceholder}>
              {chat.description || (isAdmin ? 'Add a group description' : 'No description')}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {isAdmin && (
        <TouchableOpacity style={S.addBtn} onPress={onAddMember} activeOpacity={0.85}>
          <Ionicons name="person-add-outline" size={18} color={colors.primary} />
          <Text style={S.addBtnTxt}>Add member</Text>
        </TouchableOpacity>
      )}

      {/* Group call — rings every member, then joins the mesh call room. */}
      <View style={S.section}>
        <TouchableOpacity
          style={S.navRow}
          activeOpacity={0.7}
          onPress={() => router.push({ pathname: '/group-calls', params: { chatId: chat.id, groupName: chat.name ?? 'Group' } } as any)}
        >
          <Ionicons name="call-outline" size={22} color={colors.text} style={S.navIcon} />
          <View style={{ flex: 1 }}>
            <Text style={S.navTitle}>Group call</Text>
            <Text style={S.navSub}>Voice or video with this group</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
        </TouchableOpacity>
      </View>

      {/* Media, links and docs — WhatsApp-style row → shared media gallery */}
      <View style={S.section}>
        <TouchableOpacity
          style={S.navRow}
          activeOpacity={0.7}
          onPress={() => router.push({ pathname: '/media-gallery', params: { chatId: chat.id } } as any)}
        >
          <Ionicons name="images-outline" size={22} color={colors.text} style={S.navIcon} />
          <View style={{ flex: 1 }}>
            <Text style={S.navTitle}>Media, links and docs</Text>
            <Text style={S.navSub}>Everything shared in this group</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
        </TouchableOpacity>
      </View>

      {/* Live Chat Viewers (#58) — share whether you're currently viewing this chat */}
      <View style={S.section}>
        <Text style={S.label}>PRIVACY</Text>
        <View style={S.navRow}>
          <Ionicons name="eye-outline" size={22} color={colors.text} style={S.navIcon} />
          <View style={{ flex: 1 }}>
            <Text style={S.navTitle}>Share my viewing status</Text>
            <Text style={S.navSub}>Let members see when you’re viewing this chat now</Text>
          </View>
          <Switch
            value={shareViewing}
            onValueChange={toggleShareViewing}
            trackColor={{ true: colors.primary, false: colors.border }}
            thumbColor="#fff"
          />
        </View>
      </View>

      {isAdmin && (
        <View style={S.section}>
          <Text style={S.label}>ADMIN</Text>
          <TouchableOpacity
            style={S.navRow}
            activeOpacity={0.7}
            onPress={() => router.push({ pathname: '/group-admin', params: { chatId: chat.id, groupName: chat.name ?? '' } } as any)}
          >
            <Ionicons name="shield-checkmark-outline" size={22} color={colors.text} style={S.navIcon} />
            <View style={{ flex: 1 }}>
              <Text style={S.navTitle}>Group settings & permissions</Text>
              <Text style={S.navSub}>Roles, slow mode, who can send, join requests</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
          </TouchableOpacity>
          <TouchableOpacity
            style={S.navRow}
            activeOpacity={0.7}
            onPress={() => router.push({ pathname: '/invite-link', params: { chatId: chat.id, groupName: chat.name ?? '' } } as any)}
          >
            <Ionicons name="link-outline" size={22} color={colors.text} style={S.navIcon} />
            <View style={{ flex: 1 }}>
              <Text style={S.navTitle}>Invite links</Text>
              <Text style={S.navSub}>Create & share links to invite people</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
          </TouchableOpacity>
        </View>
      )}

      <View style={S.section}>
        <Text style={S.label}>{activeMembers.length} MEMBERS</Text>
        {activeMembers.length > 8 && (
          <View style={S.memberSearch}>
            <Ionicons name="search" size={16} color={colors.textDim} />
            <TextInput
              style={S.memberSearchInput}
              value={memberQuery}
              onChangeText={setMemberQuery}
              placeholder="Search members"
              placeholderTextColor={colors.textDim}
            />
            {memberQuery.length > 0 && (
              <TouchableOpacity onPress={() => setMemberQuery('')} hitSlop={8}>
                <Ionicons name="close-circle" size={16} color={colors.textDim} />
              </TouchableOpacity>
            )}
          </View>
        )}
        <FlatList
          data={shownMembers}
          scrollEnabled={false}
          keyExtractor={m => m.userId}
          renderItem={({ item: m }) => (
            <MemberRow
              member={m}
              meId={meId}
              isAdmin={isAdmin}
              authHeader={authHeader}
              onRemove={() => onRemoveMember(m)}
            />
          )}
        />
      </View>

      <TouchableOpacity style={S.leaveBtn} onPress={onLeave} activeOpacity={0.85}>
        <Text style={S.leaveTxt}>Leave group</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function MemberRow({
  member, meId, isAdmin, authHeader, onRemove,
}: {
  member:     ChatMember;
  meId:       string | null;
  isAdmin:    boolean;
  authHeader: string | null;
  onRemove:   () => void;
}) {
  const S = useS();
  const { colors } = useTheme();
  const isMe = member.userId === meId;
  const showRemove = isAdmin && !isMe && member.role !== 'owner';
  const letter = (member.name?.trim()[0] || member.email?.trim()[0] || '?').toUpperCase();
  return (
    <View style={S.memberRow}>
      <View style={S.memberAvatarWrap}>
        <View style={S.memberAvatar}>
          {member.photoURL && authHeader ? (
            <Image
              source={{ uri: attachmentUrl(member.photoURL), headers: { Authorization: authHeader } }}
              style={S.memberAvatarImg}
            />
          ) : (
            <Text style={S.memberAvatarTxt}>{letter}</Text>
          )}
        </View>
        {member.online && <View style={S.memberPresenceDot} />}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={S.memberName} numberOfLines={1}>
          {member.name || member.email || member.userId.slice(0, 8)}
          {isMe && <Text style={S.memberMeTag}> (you)</Text>}
        </Text>
        <Text style={S.memberSub} numberOfLines={1}>
          {member.role !== 'member' && `${member.role} · `}
          {member.email || member.userId.slice(0, 12)}
        </Text>
      </View>
      {showRemove && (
        <TouchableOpacity onPress={onRemove} style={S.removeBtn} activeOpacity={0.7}>
          <Text style={S.removeBtnTxt}>Remove</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}


const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  center:        { justifyContent: 'center', alignItems: 'center' },

  header:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: HEADER_TOP, paddingBottom: 8, gap: 8 },
  backBtn:       { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  backTxt:       { color: c.text, fontSize: 26, fontWeight: '600' },
  titleBar:      { color: c.text, fontSize: 22, fontWeight: '800' },

  heroWrap:      { alignItems: 'center', paddingVertical: 20, gap: 8 },
  hero:          { width: 112, height: 112, borderRadius: 56, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  heroImg:       { width: '100%', height: '100%' },
  heroTxt:       { color: '#fff', fontSize: 48, fontWeight: '800' },
  heroBusy:      { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.4)' },
  heroEditPill:  { position: 'absolute', right: 0, bottom: 0, backgroundColor: c.primary, borderRadius: 16, padding: 6, borderWidth: 2, borderColor: c.bg },
  groupName:     { color: c.text, fontSize: 22, fontWeight: '700' },
  subInfo:       { color: c.textDim, fontSize: 12 },

  renameRow:     { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, width: '100%' },
  renameInput:   { flex: 1, color: c.text, backgroundColor: c.glassSoft, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  saveBtn:       { backgroundColor: c.primary, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10 },
  saveBtnTxt:    { color: '#fff', fontWeight: '700' },

  addBtn:        { flexDirection: 'row', gap: 8, marginHorizontal: 16, marginTop: 8, padding: 12, borderRadius: 12, backgroundColor: c.glassSoft, borderWidth: 1, borderColor: c.glassStroke, alignItems: 'center', justifyContent: 'center' },
  addBtnTxt:     { color: c.primary, fontWeight: '700' },

  section:       { paddingHorizontal: 16, marginTop: 16 },
  label:         { color: c.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, marginBottom: 8 },

  navRow:        { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  navIcon:       { width: 28, textAlign: 'center' },
  navTitle:      { color: c.text, fontSize: 15, fontWeight: '600' },
  navSub:        { color: c.textDim, fontSize: 12, marginTop: 2 },
  navChevron:    { color: c.textDim, fontSize: 22, fontWeight: '300' },

  descText:      { color: c.text, fontSize: 15, lineHeight: 21, marginTop: 4 },
  descPlaceholder: { color: c.textDim, fontSize: 15, marginTop: 4 },
  descEditRow:   { gap: 8 },
  descInput:     { color: c.text, backgroundColor: c.glassSoft, borderRadius: 12, padding: 12, fontSize: 15, minHeight: 70, textAlignVertical: 'top' },
  memberSearch:  { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: c.glassSoft, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 6 },
  memberSearchInput: { flex: 1, color: c.text, fontSize: 14, padding: 0 },
  memberRow:     { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  memberAvatarWrap: { width: 44, height: 44 },
  memberAvatar:  { width: 44, height: 44, borderRadius: 22, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  memberAvatarImg: { width: '100%', height: '100%' },
  memberAvatarTxt: { color: '#fff', fontWeight: '700', fontSize: 17 },
  memberPresenceDot: { position: 'absolute', right: 0, bottom: 0, width: 12, height: 12, borderRadius: 6, backgroundColor: '#22C55E', borderWidth: 2, borderColor: c.bg },
  memberName:    { color: c.text, fontSize: 15, fontWeight: '600' },
  memberMeTag:   { color: c.textDim, fontSize: 12, fontWeight: '400' },
  memberSub:     { color: c.textDim, fontSize: 12, marginTop: 2 },
  removeBtn:     { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, borderWidth: 1, borderColor: c.danger },
  removeBtnTxt:  { color: c.danger, fontSize: 11, fontWeight: '700' },

  leaveBtn:      { marginHorizontal: 16, marginTop: 32, padding: 14, borderRadius: 24, borderWidth: 1, borderColor: c.danger, alignItems: 'center' },
  leaveTxt:      { color: c.danger, fontWeight: '700' },
});
