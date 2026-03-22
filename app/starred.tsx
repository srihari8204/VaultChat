// app/starred.tsx
// View all starred messages across all chats

import React, { useState, useEffect } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Stack } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';

interface StarredMsg {
  id: string;
  chatId: string;
  chatName: string;
  plaintext: string;
  senderId: string;
  senderName: string;
  createdAt: any;
  msgType: string;
}

export default function StarredScreen() {
  const myUid   = auth().currentUser?.uid ?? '';
  const [items, setItems] = useState<StarredMsg[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    firestore().collection('users').doc(myUid)
      .collection('starred').orderBy('starredAt', 'desc').onSnapshot(async snap => {
        const list = snap.docs.map(d => d.data() as StarredMsg);
        setItems(list);
        setLoading(false);
      });
  }, [myUid]);

  const unstar = async (item: StarredMsg) => {
    await firestore().collection('users').doc(myUid).collection('starred').doc(item.id).delete();
  };

  const fmt = (ts: any) => ts?.toDate?.().toLocaleDateString() ?? '';

  if (loading) return <View style={s.center}><ActivityIndicator color="#00E5FF" /></View>;

  return (
    <>
      <Stack.Screen options={{ title: 'â­ Starred Messages', headerStyle: { backgroundColor: '#0C0C1A' }, headerTintColor: '#fff' }} />
      <View style={s.screen}>
        <FlatList
          data={items}
          keyExtractor={i => i.id}
          renderItem={({ item }) => (
            <View style={s.item}>
              <View style={{ flex: 1 }}>
                <Text style={s.chatName}>{item.chatName}</Text>
                <Text style={s.sender}>{item.senderName} Â· {fmt(item.createdAt)}</Text>
                <Text style={s.msg} numberOfLines={3}>{item.plaintext || `[${item.msgType}]`}</Text>
              </View>
              <TouchableOpacity onPress={() => unstar(item)} style={s.unstarBtn}>
                <Text style={{ fontSize: 20 }}>â­</Text>
              </TouchableOpacity>
            </View>
          )}
          ListEmptyComponent={<View style={s.center}><Text style={s.emptyTxt}>No starred messages yet{'\n'}Long press a message â†’ Star</Text></View>}
        />
      </View>
    </>
  );
}

const s = StyleSheet.create({
  screen:    { flex: 1, backgroundColor: '#03030E' },
  center:    { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  item:      { flexDirection: 'row', alignItems: 'flex-start', padding: 14, borderBottomWidth: 1, borderBottomColor: '#0A0A18' },
  chatName:  { color: '#00E5FF', fontSize: 13, fontWeight: 'bold', marginBottom: 2 },
  sender:    { color: '#555', fontSize: 11, marginBottom: 4 },
  msg:       { color: '#C0C0E0', fontSize: 14 },
  unstarBtn: { padding: 6 },
  emptyTxt:  { color: '#555', fontSize: 14, textAlign: 'center', lineHeight: 22 },
});
