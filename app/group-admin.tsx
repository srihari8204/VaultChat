/**
 * app/group-admin.tsx — Group Admin Controls (Postgres-backed).
 *
 * Scoped to what the backend actually persists today:
 *   - Group Info: rename the group (admin/owner only) via PATCH /chats/:id
 *   - Send/media/add policies, slow mode, anti-spam and invite-link approval
 *   - Members: per-member role + remove via /chats/:id/members*, gated by the
 *     same rank check as app/group-members.tsx (memberActions in
 *     lib/groups/permissions.ts, mirroring the server).
 *
 * TWO APPROVAL QUEUES, because the server has two (not a client choice):
 *   - `approve_members` + /join-requests: people who open an INVITE LINK
 *     (/invite-link, POST /chats/join/:code). That is the toggle and the
 *     "Link join requests" list here.
 *   - `approval_mode` + /membership/pending: INVITATIONS and "ask to join"
 *     cards. Set under Members → How people join; approved in Add people.
 * Merging them needs the link-join path to write a chat_invitations request
 * row instead of chat_join_requests (logged as a backend handoff). Until then
 * this screen names which door each setting guards and links to the other.
 */

import { brandAlpha, type Palette } from '../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState , useMemo} from 'react';
import {
  ActivityIndicator, Alert, ScrollView, Switch,
  StyleSheet, TextInput, TouchableOpacity, View,
} from 'react-native';
import { useTheme } from '../lib/theme';
import { getCurrentUserAsync } from './(constants)/authService';
import {
  getChat, removeChatMember, setMemberRole, updateChat,
  listJoinRequests, approveJoinRequest, rejectJoinRequest,
  type ChatMember, type JoinRequest,
} from '../lib/chatService';
import { AuroraBackground, KeyboardSafe, AppText as Text } from '../components/ui';
import { HEADER_TOP } from '../constants/layout';
import { initialOf } from '../lib/format';
import { memberActions, ROLE_LABELS as GROUP_ROLE_LABELS, type GroupRole } from '../lib/groups/permissions';

type Policy = 'everyone' | 'admins';

// Was: `const TOP = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 44`.
// currentHeight ignores the display cutout on some OEM skins, the `?? 0` drew
// this header UNDER the notch (edgeToEdge is on at every API level here), and
// the module-scope read froze whichever it picked for the life of the process.
// HEADER_TOP is the live binding and already carries the gap the `+ 8` added
// (2026-09-17).

const SLOW_OPTS = [
  { label: 'Off', value: 0 },
  { label: '10s', value: 10 },
  { label: '30s', value: 30 },
  { label: '1m', value: 60 },
  { label: '5m', value: 300 },
  { label: '15m', value: 900 },
];

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

/** Everyone / Admins only — a pair of radios. */
function PolicyToggle({ label, value, onChange }: { label: string; value: Policy; onChange: (p: Policy) => void }) {
  const s = useS();
  return (
    <View style={s.policyRow} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {(['everyone', 'admins'] as const).map(p => {
        const on = value === p;
        const text = p === 'everyone' ? 'Everyone' : 'Admins only';
        return (
          <TouchableOpacity key={p} style={[s.policyBtn, on && s.policyBtnActive]} onPress={() => onChange(p)}
            accessibilityRole="radio" accessibilityLabel={`${label}: ${text}`} accessibilityState={{ selected: on, checked: on }}>
            <Text style={[s.policyTxt, on && s.policyTxtActive]}>{text}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export default function GroupAdminScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const { chatId, groupName: initialName } = useLocalSearchParams<{ chatId: string; groupName: string }>();

  const [myId, setMyId] = useState('');
  const [myRole, setMyRole] = useState<GroupRole>('member');
  const [typed, setTyped] = useState(false);
  const [perms, setPerms] = useState<string[]>([]);
  // Load failed: say so with Retry instead of "No members." and member-only controls.
  const [loadFailed, setLoadFailed] = useState(false);
  const [groupName, setGroupName] = useState(initialName || 'Group');
  const [savedName, setSavedName] = useState(initialName || 'Group');
  const [members, setMembers] = useState<ChatMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingName, setSavingName] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [roleMenuUid, setRoleMenuUid] = useState<string | null>(null);
  const [slowMode, setSlowMode] = useState(0);
  const [sendPolicy, setSendPolicy] = useState<Policy>('everyone');
  const [mediaPolicy, setMediaPolicy] = useState<Policy>('everyone');
  const [addPolicy, setAddPolicy] = useState<Policy>('admins');
  const [antiSpam, setAntiSpam] = useState(false);
  const [approve, setApprove] = useState(false);
  const [joinReqs, setJoinReqs] = useState<JoinRequest[]>([]);
  // The link-join list failed to load: say so, never "No pending requests".
  const [reqsFailed, setReqsFailed] = useState(false);

  // One banner timer, cleared on unmount so it never sets state on a dead screen.
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (bannerTimer.current) clearTimeout(bannerTimer.current); }, []);
  const flash = useCallback((kind: 'ok' | 'err', text: string) => {
    setBanner({ kind, text });
    if (bannerTimer.current) clearTimeout(bannerTimer.current);
    bannerTimer.current = setTimeout(() => setBanner(null), 2600);
  }, []);

  const loadJoinReqs = useCallback((id: string) => {
    listJoinRequests(id)
      .then((r) => { setJoinReqs(r); setReqsFailed(false); })
      .catch(() => setReqsFailed(true));
  }, []);

  const load = useCallback(async () => {
    if (!chatId) { setLoading(false); return; }
    try {
      const [chat, me] = await Promise.all([getChat(chatId), getCurrentUserAsync()]);
      const active = chat.members.filter(m => !m.leftAt);
      setMembers(active);
      setMyId(me?.id ?? '');
      setMyRole((chat.myRole as GroupRole) ?? 'member');
      setTyped(!!chat.groupType);
      setPerms((chat.permissions ?? []) as string[]);
      setLoadFailed(false);
      setSlowMode(chat.slowModeSeconds ?? 0);
      setSendPolicy((chat.sendPolicy as Policy) ?? 'everyone');
      setMediaPolicy((chat.mediaPolicy as Policy) ?? 'everyone');
      setAddPolicy((chat.addMembersPolicy as Policy) ?? 'admins');
      setAntiSpam(!!chat.antiSpamLinks);
      setApprove(!!chat.approveMembers);
      if (chat.approveMembers) loadJoinReqs(chatId);
      if (chat.name) { setGroupName(chat.name); setSavedName(chat.name); }
    } catch (e: any) {
      setLoadFailed(true);
      flash('err', e?.message ?? 'Failed to load group');
    } finally {
      setLoading(false);
    }
  }, [chatId, flash, loadJoinReqs]);

  useEffect(() => { load(); }, [load]);

  const isAdmin = myRole === 'admin' || myRole === 'owner';

  const saveName = async () => {
    const name = groupName.trim();
    if (!name || name === savedName) return;
    setSavingName(true);
    try {
      await updateChat(chatId!, { name });
      setSavedName(name);
      flash('ok', 'Group name updated');
    } catch (e: any) {
      flash('err', e?.message ?? 'Rename failed');
      setGroupName(savedName);
    } finally {
      setSavingName(false);
    }
  };

  const changeSlowMode = async (s: number) => {
    const prev = slowMode;
    setSlowMode(s);
    try { await updateChat(chatId!, { slowModeSeconds: s }); flash('ok', s ? `Slow mode: ${s < 60 ? s + 's' : s / 60 + 'm'}` : 'Slow mode off'); }
    catch (e: any) { setSlowMode(prev); flash('err', e?.message ?? 'Failed'); }
  };

  const changeSendPolicy = async (p: Policy) => {
    const prev = sendPolicy;
    setSendPolicy(p);
    try { await updateChat(chatId!, { sendPolicy: p }); flash('ok', p === 'admins' ? 'Only admins can send' : 'Everyone can send'); }
    catch (e: any) { setSendPolicy(prev); flash('err', e?.message ?? 'Failed'); }
  };

  const changeMediaPolicy = async (p: Policy) => {
    const prev = mediaPolicy; setMediaPolicy(p);
    try { await updateChat(chatId!, { mediaPolicy: p }); flash('ok', p === 'admins' ? 'Only admins send media' : 'Everyone can send media'); }
    catch (e: any) { setMediaPolicy(prev); flash('err', e?.message ?? 'Failed'); }
  };

  const changeAddPolicy = async (p: Policy) => {
    const prev = addPolicy; setAddPolicy(p);
    try { await updateChat(chatId!, { addMembersPolicy: p }); flash('ok', p === 'everyone' ? 'Anyone can add members' : 'Only admins add members'); }
    catch (e: any) { setAddPolicy(prev); flash('err', e?.message ?? 'Failed'); }
  };

  const toggleAntiSpam = async (v: boolean) => {
    const prev = antiSpam; setAntiSpam(v);
    try { await updateChat(chatId!, { antiSpamLinks: v }); flash('ok', v ? 'Link anti-spam on' : 'Link anti-spam off'); }
    catch (e: any) { setAntiSpam(prev); flash('err', e?.message ?? 'Failed'); }
  };

  const toggleApprove = async (v: boolean) => {
    const prev = approve; setApprove(v);
    try {
      await updateChat(chatId!, { approveMembers: v });
      flash('ok', v ? 'New members need approval' : 'Open joining');
      if (v) loadJoinReqs(chatId!); else { setJoinReqs([]); setReqsFailed(false); }
    } catch (e: any) { setApprove(prev); flash('err', e?.message ?? 'Failed'); }
  };

  const approveReq = async (uid: string) => {
    setJoinReqs(list => list.filter(r => r.userId !== uid));
    try { await approveJoinRequest(chatId!, uid); flash('ok', 'Approved'); load(); }
    catch (e: any) { flash('err', e?.message ?? 'Failed'); loadJoinReqs(chatId!); }
  };

  const rejectReq = async (uid: string) => {
    setJoinReqs(list => list.filter(r => r.userId !== uid));
    try { await rejectJoinRequest(chatId!, uid); }
    catch (e: any) { flash('err', e?.message ?? 'Failed'); loadJoinReqs(chatId!); }
  };

  const changeRole = async (m: ChatMember, role: Exclude<GroupRole, 'owner'>) => {
    setRoleMenuUid(null);
    if (m.role === role) return;
    const prev = members;
    setMembers(list => list.map(x => x.userId === m.userId ? { ...x, role } : x));
    try {
      await setMemberRole(chatId!, m.userId, role);
      flash('ok', `${m.name || 'Member'} is now ${GROUP_ROLE_LABELS[role]}`);
    } catch (e: any) {
      setMembers(prev);
      flash('err', e?.message ?? 'Role change failed');
    }
  };

  const removeMember = (m: ChatMember) => {
    const name = m.name || m.email || 'this member';
    Alert.alert('Remove member', `Remove ${name} from the group?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive', onPress: async () => {
          const prev = members;
          setMembers(list => list.filter(x => x.userId !== m.userId));
          try {
            await removeChatMember(chatId!, m.userId);
            flash('ok', `Removed ${name}`);
          } catch (e: any) {
            setMembers(prev);
            flash('err', e?.message ?? 'Remove failed');
          }
        },
      },
    ]);
  };

  if (loading) {
    return (
      <View style={[s.container, s.center]}>
      <AuroraBackground />
        <Stack.Screen options={{ headerShown: false }} />
        <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading group settings" />
      </View>
    );
  }

  const nameDirty = groupName.trim() !== savedName && groupName.trim().length > 0;

  return (
    <KeyboardSafe style={s.container}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />

      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} accessibilityLabel="Go back" style={s.backBtn} hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle} accessibilityRole="header">Group Admin</Text>
        <View style={{ width: 40 }} />
      </View>

      {banner && (
        <View style={[s.banner, banner.kind === 'err' ? s.bannerErr : s.bannerOk]} accessibilityLiveRegion="polite">
          <Text style={s.bannerTxt}>{banner.text}</Text>
        </View>
      )}

      <ScrollView contentContainerStyle={{ paddingBottom: 60 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {/* Group Info. Hidden after a failed load: myRole is still the default
            'member' then, and "Only admins can edit" would be a guess. */}
        {!loadFailed && (
        <View style={s.section}>
          <Text style={s.sectionTitle}>Group Info</Text>
          <Text style={s.label}>Group Name</Text>
          <TextInput
            style={[s.input, !isAdmin && s.inputDisabled]}
            value={groupName}
            onChangeText={setGroupName}
            editable={isAdmin}
            placeholderTextColor={colors.textFaint}
            placeholder="Group name"
            maxLength={100}
            accessibilityLabel="Group name"
            returnKeyType="done"
            onSubmitEditing={saveName}
          />
          {!isAdmin && <Text style={s.hint}>Only admins can edit group info.</Text>}
          {isAdmin && nameDirty && (
            <TouchableOpacity style={s.saveNameBtn} onPress={saveName} disabled={savingName}
              accessibilityRole="button" accessibilityState={{ disabled: savingName, busy: savingName }}>
              {savingName
                ? <ActivityIndicator size="small" color="#FFFFFF" />
                : <Text style={s.saveNameTxt}>Save name</Text>}
            </TouchableOpacity>
          )}
        </View>
        )}

        {/* Group Controls (admin only) */}
        {isAdmin && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Group Controls</Text>

            <Text style={s.ctrlLabel}>Who can send messages</Text>
            <PolicyToggle label="Who can send messages" value={sendPolicy} onChange={changeSendPolicy} />

            <Text style={[s.ctrlLabel, { marginTop: 14 }]}>Slow mode (between messages)</Text>
            <View style={s.slowRow} accessibilityRole="radiogroup" accessibilityLabel="Slow mode">
              {SLOW_OPTS.map(opt => (
                <TouchableOpacity
                  key={opt.value}
                  style={[s.slowChip, slowMode === opt.value && s.slowChipActive]}
                  onPress={() => changeSlowMode(opt.value)}
                  accessibilityRole="radio"
                  accessibilityLabel={opt.value ? `Slow mode ${opt.label}` : 'Slow mode off'}
                  accessibilityState={{ selected: slowMode === opt.value, checked: slowMode === opt.value }}
                >
                  <Text style={[s.slowTxt, slowMode === opt.value && s.slowTxtActive]}>{opt.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={[s.ctrlLabel, { marginTop: 14 }]}>Who can send media</Text>
            <PolicyToggle label="Who can send media" value={mediaPolicy} onChange={changeMediaPolicy} />

            <Text style={[s.ctrlLabel, { marginTop: 14 }]}>Who can add members</Text>
            <PolicyToggle label="Who can add members" value={addPolicy} onChange={changeAddPolicy} />

            <View style={s.switchRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.switchLabel}>Approve invite-link joins</Text>
                <Text style={s.switchSub}>People who open an invite link wait for an admin.</Text>
              </View>
              <Switch value={approve} onValueChange={toggleApprove} accessibilityLabel="Approve invite-link joins"
                trackColor={{ false: colors.surface, true: brandAlpha(0.5) }} thumbColor={approve ? colors.primary : colors.textFaint} />
            </View>
            {typed && (
              <TouchableOpacity
                style={s.linkRow}
                accessibilityRole="link"
                accessibilityLabel="Invitations and join requests follow How people join, in Members"
                onPress={() => router.push({ pathname: '/group-members', params: { groupId: chatId, name: savedName } } as any)}
              >
                <Text style={s.switchSub}>
                  Invitations and “ask to join” follow <Text style={{ color: colors.primary, fontWeight: '700' }}>How people join</Text> in Members.
                </Text>
                <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
              </TouchableOpacity>
            )}

            <View style={s.switchRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.switchLabel}>Block links from new members</Text>
                <Text style={s.switchSub}>Members &lt; 24h old can’t post links.</Text>
              </View>
              <Switch value={antiSpam} onValueChange={toggleAntiSpam} accessibilityLabel="Block links from new members"
                trackColor={{ false: colors.surface, true: brandAlpha(0.5) }} thumbColor={antiSpam ? colors.primary : colors.textFaint} />
            </View>

            <Text style={s.hint}>Admins are exempt from these limits.</Text>
          </View>
        )}

        {/* Pending join requests (admin, approve-members on) */}
        {isAdmin && approve && (
          <View style={s.section}>
            <Text style={s.sectionTitle} accessibilityRole="header">Link join requests ({joinReqs.length})</Text>
            {reqsFailed ? (
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Couldn't load join requests. Retry" onPress={() => loadJoinReqs(chatId!)}>
                <Text style={[s.hint, { color: colors.danger }]}>Couldn’t load join requests. Tap to retry.</Text>
              </TouchableOpacity>
            ) : joinReqs.length === 0 ? (
              <Text style={s.hint}>No pending requests.</Text>
            ) : joinReqs.map(r => (
              <View key={r.userId} style={s.memberRow}>
                <View style={s.avatar}><Text style={s.avatarText}>{initialOf(r.name)}</Text></View>
                <Text style={[s.memberName, { flex: 1 }]} numberOfLines={1}>{r.name || r.userId.slice(0, 8)}</Text>
                <TouchableOpacity style={s.reqApprove} onPress={() => approveReq(r.userId)} hitSlop={6}
                  accessibilityRole="button" accessibilityLabel={`Approve ${r.name || 'this person'}`}><Text style={s.reqApproveTxt}>Approve</Text></TouchableOpacity>
                <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Reject the join request from ${r.name || r.userId.slice(0, 8)}`} style={s.reqReject} onPress={() => rejectReq(r.userId)} hitSlop={10}><Ionicons name="close" size={18} color={colors.danger} /></TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        {/* Members */}
        <View style={s.section}>
          <Text style={s.sectionTitle} accessibilityRole="header">Members ({members.length})</Text>
          {members.length === 0 && loadFailed && (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Couldn't load members. Retry" onPress={() => { setLoading(true); load(); }}>
              <Text style={[s.hint, { textAlign: 'center', marginVertical: 16, color: colors.danger }]}>Couldn’t load members. Tap to retry.</Text>
            </TouchableOpacity>
          )}
          {members.length === 0 && !loadFailed && (
            <Text style={[s.hint, { textAlign: 'center', marginVertical: 16 }]}>No members.</Text>
          )}
          {members.map(m => {
            const role = (m.role as GroupRole) ?? 'member';
            const isMe = m.userId === myId;
            const label = m.name || m.email || m.userId.slice(0, 8);
            // The same rank-aware check as /group-members (and the server): an
            // admin cannot touch a peer admin, nobody touches the owner.
            const acts = memberActions({ actorRole: myRole, targetRole: role, isMe, typed, permissions: perms });
            const roleOptions = acts.roles.filter((r): r is Exclude<GroupRole, 'owner'> => r !== 'owner');
            const canEditRole = roleOptions.length > 0;
            return (
              <View key={m.userId}>
                {/* The row and Remove are SIBLINGS: a touchable nested in a
                    touchable is merged into one element by screen readers, so
                    Remove could not be reached on its own. */}
                <View style={s.memberRow}>
                  <TouchableOpacity
                    style={s.memberMain}
                    activeOpacity={canEditRole ? 0.6 : 1}
                    disabled={!canEditRole}
                    accessibilityRole={canEditRole ? 'button' : 'text'}
                    accessibilityLabel={`${label}${isMe ? ' (you)' : ''}, ${GROUP_ROLE_LABELS[role] ?? m.role}`}
                    accessibilityHint={canEditRole ? 'Shows role options' : undefined}
                    accessibilityState={canEditRole ? { expanded: roleMenuUid === m.userId } : undefined}
                    onPress={() => setRoleMenuUid(roleMenuUid === m.userId ? null : m.userId)}
                  >
                    <View style={s.avatar}><Text style={s.avatarText}>{initialOf(label)}</Text></View>
                    <View style={{ flex: 1 }}>
                      <Text style={s.memberName} numberOfLines={1}>{label}{isMe ? ' (You)' : ''}</Text>
                      <Text style={s.roleBadgeText}>{GROUP_ROLE_LABELS[role] ?? m.role}</Text>
                    </View>
                  </TouchableOpacity>
                  {acts.canRemove && (
                    <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Remove ${label} from the group`} onPress={() => removeMember(m)} style={s.removeBtn} hitSlop={8}>
                      <Ionicons name="close-circle" size={22} color={colors.danger} />
                    </TouchableOpacity>
                  )}
                </View>

                {roleMenuUid === m.userId && canEditRole && (
                  <View style={s.roleMenu}>
                    {roleOptions.map(r => (
                      <TouchableOpacity
                        key={r}
                        style={[s.roleOption, role === r && s.roleOptionActive]}
                        onPress={() => changeRole(m, r)}
                        accessibilityRole="radio"
                        accessibilityLabel={role === r ? GROUP_ROLE_LABELS[r] : `Make ${GROUP_ROLE_LABELS[r]}`}
                        accessibilityState={{ selected: role === r, checked: role === r }}
                      >
                        {role === r && (
                          <Ionicons name="checkmark" size={14} color={colors.primary} style={{ marginRight: 6 }} />
                        )}
                        <Text style={[s.roleOptionText, role === r && { color: colors.primary }]}>
                          {role === r ? GROUP_ROLE_LABELS[r] : `Make ${GROUP_ROLE_LABELS[r]}`}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>
            );
          })}
          {isAdmin && (
            <Text style={s.hint}>Tap a member to change their role.</Text>
          )}
        </View>
      </ScrollView>
    </KeyboardSafe>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  center: { justifyContent: 'center', alignItems: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: HEADER_TOP, paddingHorizontal: 16, paddingBottom: 12,
  },
  backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { fontSize: 18, fontWeight: '700', color: c.text },

  banner: { marginHorizontal: 16, marginBottom: 8, padding: 10, borderRadius: 10, borderWidth: 1 },
  bannerOk: { backgroundColor: brandAlpha(0.12), borderColor: brandAlpha(0.4) },
  // danger is a #RRGGBB token in both palettes, so a hex alpha suffix is valid.
  bannerErr: { backgroundColor: c.danger + '1F', borderColor: c.danger + '66' },
  bannerTxt: { color: c.text, fontSize: 12 },

  section: {
    marginHorizontal: 16, marginTop: 16, backgroundColor: c.glassSoft,
    borderRadius: 16, padding: 16, borderWidth: 1, borderColor: c.glassStroke,
  },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: c.text, marginBottom: 12 },
  label: { fontSize: 13, color: c.textDim, marginTop: 4, marginBottom: 4 },
  hint: { fontSize: 12, color: c.textDim, marginTop: 8 },
  input: {
    backgroundColor: c.glassSoft, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10,
    color: c.text, fontSize: 15, borderWidth: 1, borderColor: c.glassStroke,
  },
  inputDisabled: { opacity: 0.6 },
  saveNameBtn: {
    marginTop: 12, backgroundColor: c.primary, borderRadius: 10,
    paddingVertical: 11, alignItems: 'center',
  },
  saveNameTxt: { color: '#FFFFFF', fontWeight: '800', fontSize: 14 },

  memberRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 10,
    borderBottomWidth: 0.5, borderBottomColor: c.hairline,
  },
  memberMain: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  avatar: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: c.glassSoft,
    justifyContent: 'center', alignItems: 'center', marginRight: 12,
    borderWidth: 1, borderColor: c.glassStroke,
  },
  avatarText: { fontSize: 16, fontWeight: '700', color: c.accent },
  memberName: { fontSize: 14, fontWeight: '600', color: c.text },
  roleBadgeText: { fontSize: 11, fontWeight: '700', marginTop: 2, color: c.textDim },
  removeBtn: { padding: 6 },

  ctrlLabel: { color: c.textDim, fontSize: 13, marginBottom: 8 },
  switchRow: { flexDirection: 'row', alignItems: 'center', marginTop: 16, gap: 12 },
  switchLabel: { color: c.text, fontSize: 14, fontWeight: '600' },
  switchSub: { color: c.textDim, fontSize: 12, marginTop: 2, flexShrink: 1 },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, minHeight: 44 },
  reqApprove: { backgroundColor: c.primary, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7, marginRight: 8 },
  reqApproveTxt: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
  reqReject: { padding: 6 },
  policyRow: { flexDirection: 'row', gap: 8 },
  policyBtn: { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center', backgroundColor: c.glassSoft, borderWidth: 1, borderColor: c.glassStroke },
  policyBtnActive: { backgroundColor: c.primary, borderColor: c.primary },
  policyTxt: { color: c.textDim, fontSize: 13, fontWeight: '600' },
  policyTxtActive: { color: '#FFFFFF', fontWeight: '800' },
  slowRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  slowChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: c.glassSoft, borderWidth: 1, borderColor: c.glassStroke },
  slowChipActive: { backgroundColor: brandAlpha(0.15), borderColor: c.primary },
  slowTxt: { color: c.textDim, fontSize: 13, fontWeight: '600' },
  slowTxtActive: { color: c.primary },
  roleMenu: { flexDirection: 'row', backgroundColor: c.glassSoft, borderRadius: 10, marginBottom: 8, padding: 6, gap: 4 },
  roleOption: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 8, borderRadius: 8 },
  roleOptionActive: { backgroundColor: brandAlpha(0.12) },
  roleOptionText: { fontSize: 12, color: c.textDim, fontWeight: '600' },
});
