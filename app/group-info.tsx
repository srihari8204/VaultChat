// app/group-info.tsx
// Group info: member list, add member, disappearing timer, leave group

import React, { useState, useEffect } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import { removeMember, setDisappearingTimer } from '../services/groupService';

export default function GroupInfoScreen() {
  const { chatId, groupName } = useLocalSearchParams<{ chatId: string; groupName: string }>();
  const router = useRouter();
  const myUid  = auth().currentUser?.uid ?? '';

  const [members,   setMembers]   = useState<{ uid: string; name: string; isAdmin: boolean }[]>([]);
  const [admins,    setAdmins]    = useState<string[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [timer,     setTimer]     = useState(0);

  useEffect(() => {
    const unsub = firestore().collection('chats').doc(chatId).onSnapshot(snap => {
      const d = snap.data();
      if (!d) return;
      const ads = d.admins ?? [];
      setAdmins(ads);
      setTimer(d.disappearingTimer ?? 0);
      const list = (d.participants as string[]).map(uid => ({
        uid, name: d.participantNames?.[uid] ?? 'Unknown', isAdmin: ads.includes(uid),
      }));
      setMembers(list);
      setLoading(false);
    });
    return unsub;
  }, [chatId]);

  const leave = () => {
    Alert.alert('Leave Group?', 'You will be removed from this group.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Leave', style: 'destructive', onPress: async () => {
        await removeMember(chatId, myUid);
        router.replace('/chats');
      }},
    ]);
  };

  const changeTimer = () => {
    const options = [
      { label: 'Off', value: 0 },
      { label: '24 hours', value: 86400 },
      { label: '7 days', value: 604800 },
      { label: '30 days', value: 2592000 },
    ];
    Alert.alert('Disappearing Messages', 'Choose timer for all messages', options.map(o => ({
      text: o.label + (timer === o.value ? ' âœ“' : ''),
      onPress: () => { setDisappearingTimer(chatId, o.value); setTimer(o.value); },
    })));
  };

  const timerLabel = () => {
    if (timer === 0) return 'Off';
    if (timer === 86400) return '24 hours';
    if (timer === 604800) return '7 days';
    return '30 days';
  };

  if (loading) return <View style={{ flex: 1, backgroundColor: '#03030E', alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color="#00E5FF" /></View>;

  return (
    <>
      <Stack.Screen options={{ title: groupName ?? 'Group Info', headerStyle: { backgroundColor: '#0C0C1A' }, headerTintColor: '#fff' }} />
      <View style={s.screen}>
        <View style={s.section}>
          <Text style={s.sectionTitle}>DISAPPEARING MESSAGES</Text>
          <TouchableOpacity style={s.row} onPress={changeTimer}>
            <Text style={s.rowLabel}>â±  Timer</Text>
            <Text style={s.rowValue}>{timerLabel()}</Text>
          </TouchableOpacity>
        </View>

        <View style={s.section}>
          <Text style={s.sectionTitle}>{members.length} MEMBERS</Text>
          <FlatList
            data={members}
            keyExtractor={m => m.uid}
            scrollEnabled={false}
            renderItem={({ item: m }) => (
              <View style={s.memberRow}>
                <View style={s.memberAvatar}>
                  <Text style={s.memberAvatarTxt}>{m.name[0]?.toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.memberName}>{m.name}{m.uid === myUid ? ' (You)' : ''}</Text>
                  {m.isAdmin && <Text style={s.adminBadge}>Admin</Text>}
                </View>
                {admins.includes(myUid) && m.uid !== myUid && (
                  <TouchableOpacity onPress={() => { Alert.alert('Remove?', '', [{ text: 'Cancel', style: 'cancel' }, { text: 'Remove', style: 'destructive', onPress: () => removeMember(chatId, m.uid) }]); }}>
                    <Text style={{ color: '#FF3C6E', fontSize: 13 }}>Remove</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
          />
        </View>

        <TouchableOpacity style={s.leaveBtn} onPress={leave}>
          <Text style={s.leaveTxt}>ðŸšª Leave Group</Text>
        </TouchableOpacity>
      </View>
    </>
  );
}

const s = StyleSheet.create({
  screen:          { flex: 1, backgroundColor: '#03030E' },
  section:         { marginTop: 20 },
  sectionTitle:    { color: '#555', fontSize: 11, fontWeight: '700', letterSpacing: 1, paddingHorizontal: 16, paddingBottom: 8 },
  row:             { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#0C0C1A', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#111' },
  rowLabel:        { color: '#E0E0F0', fontSize: 15 },
  rowValue:        { color: '#00E5FF', fontSize: 14 },
  memberRow:       { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0C0C1A', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#111' },
  memberAvatar:    { width: 40, height: 40, borderRadius: 20, backgroundColor: '#111127', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  memberAvatarTxt: { color: '#00E5FF', fontSize: 16, fontWeight: 'bold' },
  memberName:      { color: '#E0E0F0', fontSize: 15 },
  adminBadge:      { color: '#FF8C42', fontSize: 11, marginTop: 2 },
  leaveBtn:        { margin: 20, backgroundColor: '#FF3C6E22', borderRadius: 12, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: '#FF3C6E44' },
  leaveTxt:        { color: '#FF3C6E', fontSize: 15, fontWeight: '600' },
});
