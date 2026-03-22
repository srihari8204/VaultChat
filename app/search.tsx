// app/search.tsx
// Global search across all chats

import React, { useState } from 'react';
import { View, Text, TextInput, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';

interface Result {
  chatId: string;
  chatName: string;
  messageId: string;
  plaintext: string;
  senderId: string;
  createdAt: any;
  peerUid: string;
}

export default function SearchScreen() {
  const router   = useRouter();
  const myUid    = auth().currentUser?.uid ?? '';
  const [query,   setQuery]   = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);

  const search = async (q: string) => {
    setQuery(q);
    if (q.trim().length < 2) { setResults([]); return; }
    setLoading(true);
    try {
      // Get all chats I'm in
      const chatsSnap = await firestore().collection('chats')
        .where('participants', 'array-contains', myUid).get();

      const matches: Result[] = [];
      await Promise.all(chatsSnap.docs.map(async chatDoc => {
        const d = chatDoc.data();
        const chatName = d.name ?? (d.participantNames ? Object.values(d.participantNames).filter((n: any) => n !== myUid).join(', ') : 'Chat');
        const peerUid  = (d.participants as string[]).find(u => u !== myUid) ?? '';

        // Note: this searches on plaintext field (unencrypted legacy messages)
        // Encrypted messages need client-side search (decrypt first in memory)
        const msgsSnap = await firestore().collection('chats').doc(chatDoc.id)
          .collection('messages')
          .where('plaintext', '>=', q)
          .where('plaintext', '<=', q + '\uf8ff')
          .limit(5).get();

        msgsSnap.docs.forEach(mDoc => {
          const md = mDoc.data();
          matches.push({
            chatId: chatDoc.id, chatName, messageId: mDoc.id,
            plaintext: md.plaintext ?? '', senderId: md.senderId,
            createdAt: md.createdAt, peerUid,
          });
        });
      }));
      setResults(matches);
    } catch { setResults([]); }
    finally { setLoading(false); }
  };

  const fmt = (ts: any) => ts?.toDate?.().toLocaleDateString() ?? '';

  return (
    <>
      <Stack.Screen options={{ title: 'Search', headerStyle: { backgroundColor: '#0C0C1A' }, headerTintColor: '#fff' }} />
      <View style={s.screen}>
        <View style={s.searchBar}>
          <Text style={{ fontSize: 16, marginRight: 8 }}>ðŸ”</Text>
          <TextInput
            style={s.input}
            placeholder="Search messagesâ€¦"
            placeholderTextColor="#444"
            value={query}
            onChangeText={search}
            autoFocus
          />
          {loading && <ActivityIndicator color="#00E5FF" size="small" />}
        </View>
        <FlatList
          data={results}
          keyExtractor={r => r.chatId + r.messageId}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={s.result}
              onPress={() => router.push({ pathname: '/chat', params: { chatId: item.chatId, peerUid: item.peerUid, peerName: item.chatName } })}
            >
              <Text style={s.chatName}>{item.chatName}</Text>
              <Text style={s.date}>{fmt(item.createdAt)}</Text>
              <Text style={s.preview} numberOfLines={2}>
                {item.plaintext.replace(query, '').length < item.plaintext.length
                  ? item.plaintext
                  : item.plaintext}
              </Text>
            </TouchableOpacity>
          )}
          ListEmptyComponent={query.length >= 2 && !loading
            ? <View style={s.empty}><Text style={s.emptyTxt}>No results for &quot;{query}&quot;</Text></View>
            : query.length < 2
              ? <View style={s.empty}><Text style={s.emptyTxt}>Type at least 2 characters</Text></View>
              : null
          }
        />
      </View>
    </>
  );
}

const s = StyleSheet.create({
  screen:   { flex: 1, backgroundColor: '#03030E' },
  searchBar:{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#0C0C1A', padding: 12, borderBottomWidth: 1, borderBottomColor: '#111' },
  input:    { flex: 1, color: '#E0E0F0', fontSize: 16 },
  result:   { padding: 14, borderBottomWidth: 1, borderBottomColor: '#0A0A18' },
  chatName: { color: '#00E5FF', fontSize: 13, fontWeight: 'bold', marginBottom: 2 },
  date:     { color: '#555', fontSize: 11, marginBottom: 4 },
  preview:  { color: '#C0C0E0', fontSize: 14 },
  empty:    { padding: 40, alignItems: 'center' },
  emptyTxt: { color: '#555', fontSize: 14 },
});