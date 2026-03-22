/**
 * app/group-admin.tsx
 * Group Admin Controls — manage members, permissions, slow mode, anti-spam.
 */

import { Ionicons } from '@expo/vector-icons';
import firestore from '@react-native-firebase/firestore';
import auth from '@react-native-firebase/auth';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

const C = {
  bg: '#020B18',
  card: '#0A1628',
  cardAlt: '#111D32',
  accent: '#4A9FFF',
  cyan: '#00E5FF',
  green: '#10B981',
  red: '#EF4444',
  orange: '#F59E0B',
  text: '#FFFFFF',
  textDim: 'rgba(255,255,255,0.5)',
  textFaint: 'rgba(255,255,255,0.22)',
  border: 'rgba(74,159,255,0.15)',
};

const TOP = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 44;

type MemberRole = 'owner' | 'admin' | 'moderator' | 'member';
interface Member {
  uid: string;
  name: string;
  avatar?: string;
  role: MemberRole;
}

const ROLE_COLORS: Record<MemberRole, string> = {
  owner: '#F59E0B',
  admin: '#4A9FFF',
  moderator: '#10B981',
  member: 'rgba(255,255,255,0.4)',
};

const ROLE_LABELS: Record<MemberRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  moderator: 'Moderator',
  member: 'Member',
};

const ROLE_ORDER: MemberRole[] = ['owner', 'admin', 'moderator', 'member'];

type PermOption = 'everyone' | 'admins';
interface GroupPermissions {
  sendMessages: PermOption;
  addMembers: PermOption;
  editGroupInfo: PermOption;
  pinMessages: PermOption;
  sendMedia: PermOption;
  mentionAll: PermOption;
}

const SLOW_MODE_OPTIONS = [
  { label: 'Off', value: 0 },
  { label: '10s', value: 10 },
  { label: '30s', value: 30 },
  { label: '1 min', value: 60 },
  { label: '5 min', value: 300 },
  { label: '15 min', value: 900 },
];

export default function GroupAdminScreen() {
  const router = useRouter();
  const { chatId, groupName: initialName } = useLocalSearchParams<{ chatId: string; groupName: string }>();

  const [groupName, setGroupName] = useState(initialName || 'Group');
  const [description, setDescription] = useState('');
  const [members, setMembers] = useState<Member[]>([]);
  const [permissions, setPermissions] = useState<GroupPermissions>({
    sendMessages: 'everyone',
    addMembers: 'everyone',
    editGroupInfo: 'everyone',
    pinMessages: 'everyone',
    sendMedia: 'everyone',
    mentionAll: 'everyone',
  });
  const [slowMode, setSlowMode] = useState(0);
  const [approveNewMembers, setApproveNewMembers] = useState(false);
  const [antiSpamLinks, setAntiSpamLinks] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [roleMenuUid, setRoleMenuUid] = useState<string | null>(null);

  const fadeIn = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeIn, { toValue: 1, duration: 400, useNativeDriver: true }).start();
    const loadGroupData = async () => {
      try {
        if (!chatId) return;
        const doc = await firestore().collection('groups').doc(chatId).get();
        if (doc.exists) {
          const data = doc.data()!;
          if (data.name) setGroupName(data.name);
          if (data.description) setDescription(data.description);
          if (data.permissions) setPermissions(prev => ({ ...prev, ...data.permissions }));
          if (data.slowMode !== undefined) setSlowMode(data.slowMode);
          if (data.approveNewMembers !== undefined) setApproveNewMembers(data.approveNewMembers);
          if (data.antiSpamLinks !== undefined) setAntiSpamLinks(data.antiSpamLinks);
          if (data.members && Array.isArray(data.members)) setMembers(data.members);
        }
      } catch (e) {
        console.warn('[GroupAdmin] Load error:', e);
      } finally {
        setLoading(false);
      }
    };
    loadGroupData();
  }, [fadeIn, chatId]);

  const saveSettings = async () => {
    setSaving(true);
    try {
      await firestore().collection('groups').doc(chatId).set(
        {
          name: groupName,
          description,
          permissions,
          slowMode,
          approveNewMembers,
          antiSpamLinks,
          members,
          updatedAt: firestore.FieldValue.serverTimestamp(),
          updatedBy: auth().currentUser?.uid,
        },
        { merge: true }
      );
      Alert.alert('Saved', 'Group settings updated successfully.');
    } catch (e) {
      Alert.alert('Error', 'Failed to save settings.');
      console.warn('[GroupAdmin] Save error:', e);
    } finally {
      setSaving(false);
    }
  };

  const changeRole = (uid: string, newRole: MemberRole) => {
    setMembers(prev => prev.map(m => (m.uid === uid ? { ...m, role: newRole } : m)));
    setRoleMenuUid(null);
  };

  const removeMember = (uid: string, name: string) => {
    Alert.alert('Remove Member', `Remove ${name} from the group?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => setMembers(prev => prev.filter(m => m.uid !== uid)),
      },
    ]);
  };

  const togglePerm = (key: keyof GroupPermissions) => {
    setPermissions(prev => ({
      ...prev,
      [key]: prev[key] === 'everyone' ? 'admins' : 'everyone',
    }));
  };

  // ── Section renderers ──

  const renderHeader = () => (
    <View style={s.header}>
      <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
        <Ionicons name="arrow-back" size={24} color={C.text} />
      </TouchableOpacity>
      <Text style={s.headerTitle}>Group Admin</Text>
      <View style={{ width: 40 }} />
    </View>
  );

  const renderGroupInfo = () => (
    <View style={s.section}>
      <Text style={s.sectionTitle}>Group Info</Text>

      <TouchableOpacity style={s.photoCircle}>
        <Ionicons name="camera" size={28} color={C.accent} />
        <Text style={s.photoLabel}>Change Photo</Text>
      </TouchableOpacity>

      <Text style={s.label}>Group Name</Text>
      <TextInput
        style={s.input}
        value={groupName}
        onChangeText={setGroupName}
        placeholderTextColor={C.textFaint}
        placeholder="Group name"
        maxLength={50}
      />

      <Text style={s.label}>Description</Text>
      <TextInput
        style={[s.input, { height: 80, textAlignVertical: 'top' }]}
        value={description}
        onChangeText={setDescription}
        placeholderTextColor={C.textFaint}
        placeholder="What's this group about?"
        multiline
        maxLength={200}
      />
    </View>
  );

  const renderPermissions = () => {
    const perms: { key: keyof GroupPermissions; label: string; icon: string }[] = [
      { key: 'sendMessages', label: 'Who can send messages', icon: 'chatbubble' },
      { key: 'addMembers', label: 'Who can add members', icon: 'person-add' },
      { key: 'editGroupInfo', label: 'Who can edit group info', icon: 'create' },
      { key: 'pinMessages', label: 'Who can pin messages', icon: 'pin' },
      { key: 'sendMedia', label: 'Who can send media', icon: 'image' },
      { key: 'mentionAll', label: '@Mention settings', icon: 'at' },
    ];

    return (
      <View style={s.section}>
        <Text style={s.sectionTitle}>Permissions</Text>
        {perms.map(p => (
          <TouchableOpacity key={p.key} style={s.permRow} onPress={() => togglePerm(p.key)}>
            <View style={s.permLeft}>
              <Ionicons name={p.icon as any} size={20} color={C.accent} style={{ marginRight: 12 }} />
              <Text style={s.permLabel}>{p.label}</Text>
            </View>
            <View style={[s.permBadge, permissions[p.key] === 'admins' && { backgroundColor: 'rgba(74,159,255,0.2)' }]}>
              <Text style={[s.permBadgeText, permissions[p.key] === 'admins' && { color: C.accent }]}>
                {permissions[p.key] === 'everyone' ? 'Everyone' : 'Admins Only'}
              </Text>
            </View>
          </TouchableOpacity>
        ))}
      </View>
    );
  };

  const renderSlowMode = () => (
    <View style={s.section}>
      <Text style={s.sectionTitle}>Slow Mode</Text>
      <Text style={s.hint}>Limit how often members can send messages.</Text>
      <View style={s.slowRow}>
        {SLOW_MODE_OPTIONS.map(opt => (
          <TouchableOpacity
            key={opt.value}
            style={[s.slowChip, slowMode === opt.value && s.slowChipActive]}
            onPress={() => setSlowMode(opt.value)}
          >
            <Text style={[s.slowChipText, slowMode === opt.value && s.slowChipTextActive]}>
              {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );

  const renderModeration = () => (
    <View style={s.section}>
      <Text style={s.sectionTitle}>Moderation</Text>

      <View style={s.toggleRow}>
        <View style={{ flex: 1 }}>
          <Text style={s.toggleLabel}>Approve New Members</Text>
          <Text style={s.hint}>Admin must approve before new members can join.</Text>
        </View>
        <Switch
          value={approveNewMembers}
          onValueChange={setApproveNewMembers}
          trackColor={{ false: '#333', true: 'rgba(74,159,255,0.4)' }}
          thumbColor={approveNewMembers ? C.accent : '#666'}
        />
      </View>

      <View style={s.toggleRow}>
        <View style={{ flex: 1 }}>
          <Text style={s.toggleLabel}>Anti-Spam: Auto-delete Links</Text>
          <Text style={s.hint}>Automatically remove links from members who joined less than 24h ago.</Text>
        </View>
        <Switch
          value={antiSpamLinks}
          onValueChange={setAntiSpamLinks}
          trackColor={{ false: '#333', true: 'rgba(74,159,255,0.4)' }}
          thumbColor={antiSpamLinks ? C.accent : '#666'}
        />
      </View>
    </View>
  );

  const renderMembers = () => (
    <View style={s.section}>
      <Text style={s.sectionTitle}>Members ({members.length})</Text>
      {members.length === 0 && (
        <Text style={[s.hint, { textAlign: 'center', marginVertical: 16 }]}>
          No members loaded. Members will appear once group data is synced.
        </Text>
      )}
      {members.map(m => (
        <View key={m.uid}>
          <TouchableOpacity
            style={s.memberRow}
            onLongPress={() => m.role !== 'owner' && setRoleMenuUid(m.uid === roleMenuUid ? null : m.uid)}
          >
            <View style={s.avatar}>
              <Text style={s.avatarText}>{m.name.charAt(0).toUpperCase()}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.memberName}>{m.name}</Text>
              <Text style={[s.roleBadgeText, { color: ROLE_COLORS[m.role] }]}>
                {ROLE_LABELS[m.role]}
              </Text>
            </View>
            {m.role !== 'owner' && (
              <TouchableOpacity onPress={() => removeMember(m.uid, m.name)} style={s.removeBtn}>
                <Ionicons name="close-circle" size={22} color={C.red} />
              </TouchableOpacity>
            )}
          </TouchableOpacity>

          {roleMenuUid === m.uid && (
            <View style={s.roleMenu}>
              {ROLE_ORDER.filter(r => r !== 'owner').map(r => (
                <TouchableOpacity
                  key={r}
                  style={[s.roleOption, m.role === r && s.roleOptionActive]}
                  onPress={() => changeRole(m.uid, r)}
                >
                  <View style={[s.roleDot, { backgroundColor: ROLE_COLORS[r] }]} />
                  <Text style={[s.roleOptionText, m.role === r && { color: C.accent }]}>
                    {ROLE_LABELS[r]}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>
      ))}
    </View>
  );

  if (loading) {
    return (
      <View style={[s.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <ActivityIndicator size="large" color={C.accent} />
      </View>
    );
  }

  return (
    <View style={s.container}>
      <Stack.Screen options={{ headerShown: false }} />
      <LinearGradient colors={[C.bg, '#0A1628', C.bg]} style={StyleSheet.absoluteFill} />

      <Animated.View style={{ flex: 1, opacity: fadeIn }}>
        {renderHeader()}

        <ScrollView contentContainerStyle={{ paddingBottom: 120 }} showsVerticalScrollIndicator={false}>
          {renderGroupInfo()}
          {renderPermissions()}
          {renderSlowMode()}
          {renderModeration()}
          {renderMembers()}
        </ScrollView>

        {/* Save Button */}
        <View style={s.bottomBar}>
          <TouchableOpacity style={s.saveBtn} onPress={saveSettings} disabled={saving}>
            <LinearGradient
              colors={[C.accent, '#2B7FE0']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={s.saveBtnGrad}
            >
              {saving ? (
                <ActivityIndicator size="small" color="#FFF" />
              ) : (
                <>
                  <Ionicons name="checkmark-circle" size={20} color="#FFF" style={{ marginRight: 8 }} />
                  <Text style={s.saveBtnText}>Save Settings</Text>
                </>
              )}
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: TOP + 8,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { fontSize: 18, fontWeight: '700', color: C.text },

  section: {
    marginHorizontal: 16,
    marginTop: 20,
    backgroundColor: C.card,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: C.border,
  },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: C.text, marginBottom: 12 },
  label: { fontSize: 13, color: C.textDim, marginTop: 10, marginBottom: 4 },
  hint: { fontSize: 12, color: C.textDim, marginBottom: 8 },
  input: {
    backgroundColor: C.cardAlt,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: C.text,
    fontSize: 15,
    borderWidth: 1,
    borderColor: C.border,
  },

  photoCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: C.cardAlt,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'center',
    marginBottom: 8,
    borderWidth: 2,
    borderColor: C.border,
  },
  photoLabel: { fontSize: 9, color: C.textDim, marginTop: 2 },

  permRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
  },
  permLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  permLabel: { fontSize: 14, color: C.text, flex: 1 },
  permBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  permBadgeText: { fontSize: 12, color: C.textDim, fontWeight: '600' },

  slowRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  slowChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: C.cardAlt,
    borderWidth: 1,
    borderColor: C.border,
  },
  slowChipActive: { backgroundColor: 'rgba(74,159,255,0.2)', borderColor: C.accent },
  slowChipText: { fontSize: 13, color: C.textDim, fontWeight: '600' },
  slowChipTextActive: { color: C.accent },

  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
  },
  toggleLabel: { fontSize: 14, color: C.text, fontWeight: '600' },

  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: C.cardAlt,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
    borderWidth: 1,
    borderColor: C.border,
  },
  avatarText: { fontSize: 16, fontWeight: '700', color: C.accent },
  memberName: { fontSize: 14, fontWeight: '600', color: C.text },
  roleBadgeText: { fontSize: 11, fontWeight: '700', marginTop: 2 },
  removeBtn: { padding: 6 },

  roleMenu: {
    flexDirection: 'row',
    backgroundColor: C.cardAlt,
    borderRadius: 10,
    marginBottom: 8,
    padding: 6,
    gap: 4,
  },
  roleOption: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    borderRadius: 8,
  },
  roleOptionActive: { backgroundColor: 'rgba(74,159,255,0.12)' },
  roleDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  roleOptionText: { fontSize: 11, color: C.textDim, fontWeight: '600' },

  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    paddingBottom: Platform.OS === 'ios' ? 34 : 20,
    paddingTop: 12,
    backgroundColor: 'rgba(2,11,24,0.95)',
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  saveBtn: { borderRadius: 12, overflow: 'hidden' },
  saveBtnGrad: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
  },
  saveBtnText: { fontSize: 16, fontWeight: '700', color: '#FFF' },
});
