// app/hidden-chats.tsx — Hidden Locked Chats
// PIN-protected list of hidden chats
// Access: Settings -> "Hidden Chats" or long-press chat -> "Hide"

import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList,
  Alert, TextInput, StatusBar, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

const C = {
  bg: '#FFFFFF', accent: '#FF3C6E', primary: '#4A9FFF',
  card: '#F9FAFB', dim: '#6B7280',
};

export default function HiddenChatsScreen() {
  const router = useRouter();
  const myUid = auth().currentUser?.uid || '';
  const [unlocked, setUnlocked] = useState(false);
  const [pin, setPin] = useState('');
  const [chats, setChats] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const verifyPin = async () => {
    if (pin.length < 4) { Alert.alert('Enter your PIN'); return; }
    const hash = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256, 'vaultchat-hidden-' + pin
    );
    const stored = await AsyncStorage.getItem('vc_hidden_pin_hash');
    if (!stored) {
      // First time — set the PIN
      await AsyncStorage.setItem('vc_hidden_pin_hash', hash);
      setUnlocked(true);
      loadHiddenChats();
      return;
    }
    if (hash === stored) {
      setUnlocked(true);
      loadHiddenChats();
    } else {
      Alert.alert('Wrong PIN', 'Incorrect hidden chats PIN');
      setPin('');
    }
  };

  const loadHiddenChats = async () => {
    setLoading(true);
    try {
      const raw = await AsyncStorage.getItem('vc_hidden_chats');
      const hiddenIds: string[] = raw ? JSON.parse(raw) : [];
      if (hiddenIds.length === 0) { setChats([]); setLoading(false); return; }

      const list: any[] = [];
      for (const chatId of hiddenIds) {
        try {
          const chatDoc = await firestore().collection('chats').doc(chatId).get();
          if (!chatDoc.exists) continue;
          const data = chatDoc.data();
          const otherId = (data.participants || []).find((p: string) => p !== myUid);
          let name = data.groupName || '';
          if (!name && otherId) {
            const uSnap = await firestore().collection('users').doc(otherId).get();
            name = uSnap.data()?.name || otherId.slice(0, 8);
          }
          list.push({
            chatId,
            name: name || 'Chat',
            lastMsg: data.lastMsg || '',
            peerUid: otherId,
            isGroup: !!data.groupName,
          });
        } catch {}
      }
      setChats(list);
    } catch {}
    setLoading(false);
  };

  const unhideChat = async (chatId: string) => {
    const raw = await AsyncStorage.getItem('vc_hidden_chats');
    const ids: string[] = raw ? JSON.parse(raw) : [];
    await AsyncStorage.setItem('vc_hidden_chats', JSON.stringify(ids.filter(id => id !== chatId)));
    setChats(prev => prev.filter(c => c.chatId !== chatId));
    Alert.alert('Chat unhidden', 'This chat will appear in your main list again.');
  };

  // PIN Entry screen
  if (!unlocked) {
    return (
      <View style={[s.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <StatusBar barStyle="light-content" />
        <Text style={{ fontSize: 40, marginBottom: 12 }}>{"\uD83D\uDD12"}</Text>
        <Text style={s.lockTitle}>Hidden Chats</Text>
        <Text style={s.lockSub}>Enter PIN to access hidden chats</Text>
        <TextInput
          style={s.pinInput}
          value={pin}
          onChangeText={setPin}
          placeholder="Enter PIN"
          placeholderTextColor="#6B7280"
          secureTextEntry
          keyboardType="number-pad"
          maxLength={8}
          autoFocus
        />
        <TouchableOpacity style={s.unlockBtn} onPress={verifyPin}>
          <Text style={s.unlockTxt}>Unlock</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 20 }}>
          <Text style={{ color: '#6B7280' }}>Cancel</Text>
        </TouchableOpacity>
        <Text style={s.firstTimeHint}>First time? Your PIN will be set on first entry.</Text>
      </View>
    );
  }

  // Chat list
  return (
    <View style={s.container}>
      <StatusBar barStyle="light-content" />
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={{ color: '#fff', fontSize: 24 }}>{"\u2190"}</Text>
        </TouchableOpacity>
        <Text style={s.title}>{"\uD83D\uDD12"} Hidden Chats</Text>
        <View style={{ width: 30 }} />
      </View>

      {loading ? (
        <ActivityIndicator color={C.primary} style={{ flex: 1 }} />
      ) : chats.length === 0 ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <Text style={{ fontSize: 40, marginBottom: 12 }}>{"\uD83D\uDC7B"}</Text>
          <Text style={{ color: '#6B7280', fontSize: 15 }}>No hidden chats</Text>
          <Text style={{ color: '#9CA3AF', fontSize: 12, marginTop: 6, textAlign: 'center', paddingHorizontal: 40 }}>
            Long press any chat and tap &quot;Hide&quot; to move it here
          </Text>
        </View>
      ) : (
        <FlatList
          data={chats}
          keyExtractor={c => c.chatId}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={s.chatRow}
              onPress={() => router.push({
                pathname: (item.isGroup ? '/group-chat' : '/chat') as any,
                params: { chatId: item.chatId, peerUid: item.peerUid, peerName: item.name },
              })}
              onLongPress={() => Alert.alert('Unhide?', 'Move this chat back to main list?', [
                { text: 'Cancel' },
                { text: 'Unhide', onPress: () => unhideChat(item.chatId) },
              ])}
            >
              <View style={s.chatAvatar}>
                <Text style={{ color: '#fff', fontWeight: '900', fontSize: 16 }}>
                  {(item.name || '?')[0].toUpperCase()}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.chatName}>{item.name}</Text>
                <Text style={s.chatPreview} numberOfLines={1}>{item.lastMsg || 'No messages'}</Text>
              </View>
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 50, paddingHorizontal: 16, paddingBottom: 12 },
  title: { color: '#fff', fontSize: 18, fontWeight: '800' },
  lockTitle: { color: '#fff', fontSize: 22, fontWeight: '900', marginBottom: 6 },
  lockSub: { color: '#6B7280', fontSize: 14, marginBottom: 24 },
  pinInput: { width: 200, height: 52, backgroundColor: '#F9FAFB', borderRadius: 14, color: '#fff', fontSize: 22, textAlign: 'center', letterSpacing: 8, borderWidth: 1, borderColor: '#E5E7EB' },
  unlockBtn: { marginTop: 20, backgroundColor: C.accent, paddingHorizontal: 40, paddingVertical: 14, borderRadius: 14 },
  unlockTxt: { color: '#fff', fontWeight: '800', fontSize: 16 },
  firstTimeHint: { color: '#9CA3AF', fontSize: 11, marginTop: 30, textAlign: 'center', paddingHorizontal: 40 },
  chatRow: { flexDirection: 'row', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: '#E5E7EB' },
  chatAvatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#1D4ED8', justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  chatName: { color: '#1F2937', fontSize: 15, fontWeight: '700' },
  chatPreview: { color: '#6B7280', fontSize: 13, marginTop: 2 },
});
