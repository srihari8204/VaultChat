// app/create-group.tsx
// Create a new group chat - pick members from contacts

import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, FlatList, TouchableOpacity,
  StyleSheet, Alert, ActivityIndicator, Image,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import { createGroup } from '../services/groupService';

interface Contact {
  uid: string;
  name: string;
  phone: string;
  photoURL: string;
}

export default function CreateGroupScreen() {
  const router = useRouter();
  const myUid  = auth().currentUser?.uid ?? '';

  const [contacts,  setContacts]  = useState<Contact[]>([]);
  const [selected,  setSelected]  = useState<Set<string>>(new Set());
  const [groupName, setGroupName] = useState('');
  const [loading,   setLoading]   = useState(true);
  const [creating,  setCreating]  = useState(false);

  useEffect(() => {
    firestore().collection('users').get().then(snap => {
      const list: Contact[] = snap.docs
        .filter(d => d.id !== myUid)
        .map(d => ({ uid: d.id, name: d.data().name ?? 'Unknown', phone: d.data().phone ?? '', photoURL: d.data().photoURL ?? '' }));
      setContacts(list);
      setLoading(false);
    });
  }, [myUid]);

  const toggle = (uid: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(uid)) { next.delete(uid); } else { next.add(uid); }
      return next;
    });
  };

  const create = async () => {
    if (!groupName.trim()) { Alert.alert('Enter a group name'); return; }
    if (selected.size === 0) { Alert.alert('Select at least 1 member'); return; }
    setCreating(true);
    try {
      const myDoc = await firestore().collection('users').doc(myUid).get();
      const myName  = myDoc.data()?.name ?? 'Me';
      const myPhoto = myDoc.data()?.photoURL ?? '';

      const memberUids   = Array.from(selected);
      const selectedDocs = contacts.filter(c => selected.has(c.uid));
      const names: Record<string, string> = { [myUid]: myName };
      const photos: Record<string, string> = { [myUid]: myPhoto };
      selectedDocs.forEach(c => { names[c.uid] = c.name; photos[c.uid] = c.photoURL; });

      const chatId = await createGroup(groupName.trim(), memberUids, names, photos);
      router.replace({ pathname: '/group-chat', params: { chatId, groupName: groupName.trim() } });
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally { setCreating(false); }
  };

  return (
    <>
      <Stack.Screen options={{ title: 'New Group', headerStyle: { backgroundColor: '#FFFFFF' }, headerTintColor: '#1F2937' }} />
      <View style={s.screen}>
        <TextInput
          style={s.nameInput}
          placeholder="Group nameâ€¦"
          placeholderTextColor="#9CA3AF"
          value={groupName}
          onChangeText={setGroupName}
          maxLength={50}
        />
        <Text style={s.label}>SELECT MEMBERS ({selected.size} selected)</Text>
        {loading
          ? <ActivityIndicator color="#4A9FFF" style={{ marginTop: 40 }} />
          : <FlatList
              data={contacts}
              keyExtractor={c => c.uid}
              renderItem={({ item: c }) => {
                const sel = selected.has(c.uid);
                return (
                  <TouchableOpacity style={s.row} onPress={() => toggle(c.uid)}>
                    <View style={[s.avatar, { backgroundColor: sel ? '#4A9FFF22' : '#F3F4F6' }]}>
                      {c.photoURL
                        ? <Image source={{ uri: c.photoURL }} style={s.avatarImg} />
                        : <Text style={s.avatarTxt}>{c.name[0]?.toUpperCase()}</Text>
                      }
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={s.name}>{c.name}</Text>
                      <Text style={s.phone}>{c.phone}</Text>
                    </View>
                    <View style={[s.check, sel && s.checkSel]}>
                      {sel && <Text style={s.checkMark}>âœ“</Text>}
                    </View>
                  </TouchableOpacity>
                );
              }}
            />
        }
        <TouchableOpacity
          style={[s.createBtn, (creating || !groupName.trim() || selected.size === 0) && s.createBtnOff]}
          onPress={create}
          disabled={creating || !groupName.trim() || selected.size === 0}
        >
          {creating
            ? <ActivityIndicator color="#000" />
            : <Text style={s.createTxt}>Create Group ({selected.size + 1} members)</Text>
          }
        </TouchableOpacity>
      </View>
    </>
  );
}

const s = StyleSheet.create({
  screen:      { flex: 1, backgroundColor: '#FFFFFF' },
  nameInput:   { backgroundColor: '#FFFFFF', color: '#1F2937', fontSize: 16, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#E5E7EB' },
  label:       { color: '#6B7280', fontSize: 11, fontWeight: '600', letterSpacing: 1, paddingHorizontal: 16, paddingVertical: 10 },
  row:         { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#0A0A18' },
  avatar:      { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  avatarImg:   { width: 46, height: 46, borderRadius: 23 },
  avatarTxt:   { color: '#4A9FFF', fontSize: 18, fontWeight: 'bold' },
  name:        { color: '#1F2937', fontSize: 15, fontWeight: '600' },
  phone:       { color: '#6B7280', fontSize: 12, marginTop: 2 },
  check:       { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: '#D1D5DB', alignItems: 'center', justifyContent: 'center' },
  checkSel:    { backgroundColor: '#4A9FFF', borderColor: '#4A9FFF' },
  checkMark:   { color: '#000', fontSize: 14, fontWeight: 'bold' },
  createBtn:   { margin: 16, backgroundColor: '#4A9FFF', borderRadius: 12, paddingVertical: 15, alignItems: 'center' },
  createBtnOff:{ backgroundColor: '#F3F4F6' },
  createTxt:   { color: '#000', fontSize: 16, fontWeight: 'bold' },
});
