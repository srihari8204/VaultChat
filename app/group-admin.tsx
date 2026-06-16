/**
 * app/group-admin.tsx — Group Admin Controls (Postgres-backed).
 *
 * Scoped to what the backend actually persists today:
 *   - Group Info: rename the group (admin/owner only) via PATCH /chats/:id
 *   - Members: per-member role + actions via /chats/:id/members*
 *       • promote member → admin / demote admin → member (owner-gated)
 *       • remove member (admin/owner)
 *
 * Permission-matrix, slow-mode and moderation toggles from the old Firebase
 * screen are intentionally omitted: there are no Postgres tables backing them
 * yet, so rendering fake switches would be dishonest. They return when the
 * backend grows the tables to support them.
 */

import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState , useMemo} from 'react';
import {
  ActivityIndicator, Alert, Platform, ScrollView, StatusBar, Switch,
  StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { getCurrentUserAsync } from './(constants)/authService';
import {
  getChat, removeChatMember, setMemberRole, updateChat,
  listJoinRequests, approveJoinRequest, rejectJoinRequest,
  type ChatMember, type JoinRequest,
} from '../lib/chatService';

type Policy = 'everyone' | 'admins';

const TOP = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 44;

type Role = 'owner' | 'admin' | 'member';

const SLOW_OPTS = [
  { label: 'Off', value: 0 },
  { label: '10s', value: 10 },
  { label: '30s', value: 30 },
  { label: '1m', value: 60 },
  { label: '5m', value: 300 },
  { label: '15m', value: 900 },
];
const ROLE_COLORS: Record<Role, string> = {
  owner: '#F59E0B',
  admin: '#06B6D4',
  member: '#9CA3AF',
};
const ROLE_LABELS: Record<Role, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function GroupAdminScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const { chatId, groupName: initialName } = useLocalSearchParams<{ chatId: string; groupName: string }>();

  const [myId, setMyId] = useState('');
  const [myRole, setMyRole] = useState<Role>('member');
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

  const flash = useCallback((kind: 'ok' | 'err', text: string) => {
    setBanner({ kind, text });
    setTimeout(() => setBanner(null), 2600);
  }, []);

  const load = useCallback(async () => {
    if (!chatId) { setLoading(false); return; }
    try {
      const [chat, me] = await Promise.all([getChat(chatId), getCurrentUserAsync()]);
      const active = chat.members.filter(m => !m.leftAt);
      setMembers(active);
      setMyId(me?.id ?? '');
      setMyRole((chat.myRole as Role) ?? 'member');
      setSlowMode(chat.slowModeSeconds ?? 0);
      setSendPolicy((chat.sendPolicy as Policy) ?? 'everyone');
      setMediaPolicy((chat.mediaPolicy as Policy) ?? 'everyone');
      setAddPolicy((chat.addMembersPolicy as Policy) ?? 'admins');
      setAntiSpam(!!chat.antiSpamLinks);
      setApprove(!!chat.approveMembers);
      if (chat.approveMembers) listJoinRequests(chatId).then(setJoinReqs).catch(() => {});
      if (chat.name) { setGroupName(chat.name); setSavedName(chat.name); }
    } catch (e: any) {
      flash('err', e?.message ?? 'Failed to load group');
    } finally {
      setLoading(false);
    }
  }, [chatId, flash]);

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
      if (v) listJoinRequests(chatId!).then(setJoinReqs).catch(() => {}); else setJoinReqs([]);
    } catch (e: any) { setApprove(prev); flash('err', e?.message ?? 'Failed'); }
  };

  const approveReq = async (uid: string) => {
    setJoinReqs(list => list.filter(r => r.userId !== uid));
    try { await approveJoinRequest(chatId!, uid); flash('ok', 'Approved'); load(); }
    catch (e: any) { flash('err', e?.message ?? 'Failed'); listJoinRequests(chatId!).then(setJoinReqs).catch(() => {}); }
  };

  const rejectReq = async (uid: string) => {
    setJoinReqs(list => list.filter(r => r.userId !== uid));
    try { await rejectJoinRequest(chatId!, uid); }
    catch (e: any) { flash('err', e?.message ?? 'Failed'); listJoinRequests(chatId!).then(setJoinReqs).catch(() => {}); }
  };

  const PolicyToggle = ({ value, onChange }: { value: Policy; onChange: (p: Policy) => void }) => (
    <View style={s.policyRow}>
      {(['everyone', 'admins'] as const).map(p => (
        <TouchableOpacity key={p} style={[s.policyBtn, value === p && s.policyBtnActive]} onPress={() => onChange(p)}>
          <Text style={[s.policyTxt, value === p && s.policyTxtActive]}>{p === 'everyone' ? 'Everyone' : 'Admins only'}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );

  const changeRole = async (m: ChatMember, role: 'admin' | 'member') => {
    setRoleMenuUid(null);
    if (m.role === role) return;
    const prev = members;
    setMembers(list => list.map(x => x.userId === m.userId ? { ...x, role } : x));
    try {
      await setMemberRole(chatId!, m.userId, role);
      flash('ok', `${m.name || 'Member'} is now ${ROLE_LABELS[role]}`);
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
        <Stack.Screen options={{ headerShown: false }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const nameDirty = groupName.trim() !== savedName && groupName.trim().length > 0;

  return (
    <View style={s.container}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Group Admin</Text>
        <View style={{ width: 40 }} />
      </View>

      {banner && (
        <View style={[s.banner, banner.kind === 'err' ? s.bannerErr : s.bannerOk]}>
          <Text style={s.bannerTxt}>{banner.text}</Text>
        </View>
      )}

      <ScrollView contentContainerStyle={{ paddingBottom: 60 }} showsVerticalScrollIndicator={false}>
        {/* Group Info */}
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
          />
          {!isAdmin && <Text style={s.hint}>Only admins can edit group info.</Text>}
          {isAdmin && nameDirty && (
            <TouchableOpacity style={s.saveNameBtn} onPress={saveName} disabled={savingName}>
              {savingName
                ? <ActivityIndicator size="small" color="#04130D" />
                : <Text style={s.saveNameTxt}>Save name</Text>}
            </TouchableOpacity>
          )}
        </View>

        {/* Group Controls (admin only) */}
        {isAdmin && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Group Controls</Text>

            <Text style={s.ctrlLabel}>Who can send messages</Text>
            <View style={s.policyRow}>
              {(['everyone', 'admins'] as const).map(p => (
                <TouchableOpacity
                  key={p}
                  style={[s.policyBtn, sendPolicy === p && s.policyBtnActive]}
                  onPress={() => changeSendPolicy(p)}
                >
                  <Text style={[s.policyTxt, sendPolicy === p && s.policyTxtActive]}>
                    {p === 'everyone' ? 'Everyone' : 'Admins only'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={[s.ctrlLabel, { marginTop: 14 }]}>Slow mode (between messages)</Text>
            <View style={s.slowRow}>
              {SLOW_OPTS.map(opt => (
                <TouchableOpacity
                  key={opt.value}
                  style={[s.slowChip, slowMode === opt.value && s.slowChipActive]}
                  onPress={() => changeSlowMode(opt.value)}
                >
                  <Text style={[s.slowTxt, slowMode === opt.value && s.slowTxtActive]}>{opt.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={[s.ctrlLabel, { marginTop: 14 }]}>Who can send media</Text>
            <PolicyToggle value={mediaPolicy} onChange={changeMediaPolicy} />

            <Text style={[s.ctrlLabel, { marginTop: 14 }]}>Who can add members</Text>
            <PolicyToggle value={addPolicy} onChange={changeAddPolicy} />

            <View style={s.switchRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.switchLabel}>Approve new members</Text>
                <Text style={s.switchSub}>Invite-link joins wait for an admin.</Text>
              </View>
              <Switch value={approve} onValueChange={toggleApprove}
                trackColor={{ false: colors.surface, true: 'rgba(16,185,129,0.5)' }} thumbColor={approve ? colors.primary : '#888'} />
            </View>

            <View style={s.switchRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.switchLabel}>Block links from new members</Text>
                <Text style={s.switchSub}>Members &lt; 24h old can’t post links.</Text>
              </View>
              <Switch value={antiSpam} onValueChange={toggleAntiSpam}
                trackColor={{ false: colors.surface, true: 'rgba(16,185,129,0.5)' }} thumbColor={antiSpam ? colors.primary : '#888'} />
            </View>

            <Text style={s.hint}>Admins are exempt from these limits.</Text>
          </View>
        )}

        {/* Pending join requests (admin, approve-members on) */}
        {isAdmin && approve && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Join Requests ({joinReqs.length})</Text>
            {joinReqs.length === 0 ? (
              <Text style={s.hint}>No pending requests.</Text>
            ) : joinReqs.map(r => (
              <View key={r.userId} style={s.memberRow}>
                <View style={s.avatar}><Text style={s.avatarText}>{(r.name || '?').charAt(0).toUpperCase()}</Text></View>
                <Text style={[s.memberName, { flex: 1 }]} numberOfLines={1}>{r.name || r.userId.slice(0, 8)}</Text>
                <TouchableOpacity style={s.reqApprove} onPress={() => approveReq(r.userId)}><Text style={s.reqApproveTxt}>Approve</Text></TouchableOpacity>
                <TouchableOpacity style={s.reqReject} onPress={() => rejectReq(r.userId)} hitSlop={6}><Ionicons name="close" size={18} color={colors.danger} /></TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        {/* Members */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>Members ({members.length})</Text>
          {members.length === 0 && (
            <Text style={[s.hint, { textAlign: 'center', marginVertical: 16 }]}>No members.</Text>
          )}
          {members.map(m => {
            const role = (m.role as Role) ?? 'member';
            const isMe = m.userId === myId;
            const label = m.name || m.email || m.userId.slice(0, 8);
            // Admins can manage non-owner members other than themselves.
            const canManage = isAdmin && role !== 'owner' && !isMe;
            return (
              <View key={m.userId}>
                <TouchableOpacity
                  style={s.memberRow}
                  activeOpacity={canManage ? 0.6 : 1}
                  onPress={() => canManage && setRoleMenuUid(roleMenuUid === m.userId ? null : m.userId)}
                >
                  <View style={s.avatar}><Text style={s.avatarText}>{label.charAt(0).toUpperCase()}</Text></View>
                  <View style={{ flex: 1 }}>
                    <Text style={s.memberName} numberOfLines={1}>{label}{isMe ? ' (You)' : ''}</Text>
                    <Text style={[s.roleBadgeText, { color: ROLE_COLORS[role] }]}>{ROLE_LABELS[role]}</Text>
                  </View>
                  {canManage && (
                    <TouchableOpacity onPress={() => removeMember(m)} style={s.removeBtn} hitSlop={8}>
                      <Ionicons name="close-circle" size={22} color={colors.danger} />
                    </TouchableOpacity>
                  )}
                </TouchableOpacity>

                {roleMenuUid === m.userId && canManage && (
                  <View style={s.roleMenu}>
                    {(['admin', 'member'] as const).map(r => (
                      <TouchableOpacity
                        key={r}
                        style={[s.roleOption, role === r && s.roleOptionActive]}
                        onPress={() => changeRole(m, r)}
                      >
                        <View style={[s.roleDot, { backgroundColor: ROLE_COLORS[r] }]} />
                        <Text style={[s.roleOptionText, role === r && { color: colors.accent }]}>
                          {role === r ? `${ROLE_LABELS[r]} ✓` : `Make ${ROLE_LABELS[r]}`}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>
            );
          })}
          {isAdmin && (
            <Text style={s.hint}>Tap a member to change their role or remove them.</Text>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  center: { justifyContent: 'center', alignItems: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: TOP + 8, paddingHorizontal: 16, paddingBottom: 12,
  },
  backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { fontSize: 18, fontWeight: '700', color: c.text },

  banner: { marginHorizontal: 16, marginBottom: 8, padding: 10, borderRadius: 10, borderWidth: 1 },
  bannerOk: { backgroundColor: 'rgba(16,185,129,0.12)', borderColor: 'rgba(16,185,129,0.4)' },
  bannerErr: { backgroundColor: 'rgba(239,68,68,0.12)', borderColor: 'rgba(239,68,68,0.4)' },
  bannerTxt: { color: c.text, fontSize: 12 },

  section: {
    marginHorizontal: 16, marginTop: 16, backgroundColor: c.card,
    borderRadius: 16, padding: 16, borderWidth: 1, borderColor: c.border,
  },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: c.text, marginBottom: 12 },
  label: { fontSize: 13, color: c.textDim, marginTop: 4, marginBottom: 4 },
  hint: { fontSize: 12, color: c.textDim, marginTop: 8 },
  input: {
    backgroundColor: c.surface, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10,
    color: c.text, fontSize: 15, borderWidth: 1, borderColor: c.border,
  },
  inputDisabled: { opacity: 0.6 },
  saveNameBtn: {
    marginTop: 12, backgroundColor: c.primary, borderRadius: 10,
    paddingVertical: 11, alignItems: 'center',
  },
  saveNameTxt: { color: '#04130D', fontWeight: '800', fontSize: 14 },

  memberRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 10,
    borderBottomWidth: 0.5, borderBottomColor: c.separator,
  },
  avatar: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: c.surface,
    justifyContent: 'center', alignItems: 'center', marginRight: 12,
    borderWidth: 1, borderColor: c.border,
  },
  avatarText: { fontSize: 16, fontWeight: '700', color: c.accent },
  memberName: { fontSize: 14, fontWeight: '600', color: c.text },
  roleBadgeText: { fontSize: 11, fontWeight: '700', marginTop: 2 },
  removeBtn: { padding: 6 },

  ctrlLabel: { color: c.textDim, fontSize: 13, marginBottom: 8 },
  switchRow: { flexDirection: 'row', alignItems: 'center', marginTop: 16, gap: 12 },
  switchLabel: { color: c.text, fontSize: 14, fontWeight: '600' },
  switchSub: { color: c.textDim, fontSize: 12, marginTop: 2 },
  reqApprove: { backgroundColor: c.primary, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7, marginRight: 8 },
  reqApproveTxt: { color: '#04130D', fontSize: 12, fontWeight: '800' },
  reqReject: { padding: 6 },
  policyRow: { flexDirection: 'row', gap: 8 },
  policyBtn: { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center', backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  policyBtnActive: { backgroundColor: c.primary, borderColor: c.primary },
  policyTxt: { color: c.textDim, fontSize: 13, fontWeight: '600' },
  policyTxtActive: { color: '#04130D', fontWeight: '800' },
  slowRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  slowChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  slowChipActive: { backgroundColor: 'rgba(6,182,212,0.15)', borderColor: c.accent },
  slowTxt: { color: c.textDim, fontSize: 13, fontWeight: '600' },
  slowTxtActive: { color: c.accent },
  roleMenu: { flexDirection: 'row', backgroundColor: c.surface, borderRadius: 10, marginBottom: 8, padding: 6, gap: 4 },
  roleOption: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 8, borderRadius: 8 },
  roleOptionActive: { backgroundColor: 'rgba(6,182,212,0.12)' },
  roleDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  roleOptionText: { fontSize: 12, color: c.textDim, fontWeight: '600' },
});
