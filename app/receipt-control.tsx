// @ts-nocheck
// app/receipt-control.tsx — Per-Contact Read Receipt Control
// Show blue ticks to some contacts, hide from others
// Also controls typing indicator and last seen per contact
// Stored in Firestore: users/{uid}/privacyRules/{contactUid}

import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList,
  StatusBar, Switch, ActivityIndicator, Alert, TextInput,
} from 'react-native';
import { Stack } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';

const C = { bg: '#020B18', accent: '#4A9FFF', card: '#0A1628', green: '#10B981', danger: '#FF3C6E' };

export default function ReceiptControlScreen() {
  const myUid = auth().currentUser?.uid || '';
  const [contacts, setContacts] = useState([]);
  const [rules, setRules] = useState({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      // Load recent chats as contacts
      const chatSnap = await firestore().collection('chats')
        .where('participants', 'array-contains', myUid)
        .orderBy('lastTime', 'desc')
        .limit(50)
        .get();

      const contactList = [];
      for (const doc of chatSnap.docs) {
        const data = doc.data();
        const peerUid = (data.participants || []).find(p => p !== myUid);
        if (peerUid) {
          const peerDoc = await firestore().collection('users').doc(peerUid).get();
          const peerData = peerDoc.data() || {};
          contactList.push({ uid: peerUid, name: peerData.name || peerData.vaultId || 'User', phone: peerData.phone || '' });
        }
      }
      setContacts(contactList);

      // Load existing rules
      const rulesSnap = await firestore().collection('users').doc(myUid)
        .collection('privacyRules').get();
      const rulesMap = {};
      rulesSnap.docs.forEach(d => { rulesMap[d.id] = d.data(); });
      setRules(rulesMap);
    } catch {}
    setLoading(false);
  };

  const toggleRule = async (contactUid, field) => {
    const current = rules[contactUid] || { readReceipts: true, typing: true, lastSeen: true };
    const updated = { ...current, [field]: !current[field] };
    setRules(prev => ({ ...prev, [contactUid]: updated }));

    await firestore().collection('users').doc(myUid)
      .collection('privacyRules').doc(contactUid)
      .set(updated, { merge: true });
  };

  const filtered = contacts.filter(c => !search || c.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <>
      <Stack.Screen options={{ title: 'Privacy per Contact', headerStyle: { backgroundColor: '#0C0C1A' }, headerTintColor: '#fff' }} />
      <View style={s.container}>
        <StatusBar barStyle="light-content" />

        <View style={s.infoCard}>
          <Text style={{ fontSize: 24 }}>{"\uD83D\uDD12"}</Text>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={s.infoTitle}>Per-Contact Privacy</Text>
            <Text style={s.infoDesc}>Control who sees your read receipts, typing indicator, and last seen — individually per contact.</Text>
          </View>
        </View>

        <TextInput style={s.searchInput} value={search} onChangeText={setSearch}
          placeholder="Search contacts..." placeholderTextColor="#555" />

        {/* Legend */}
        <View style={s.legendRow}>
          <View style={s.legendItem}><View style={[s.legendDot, { backgroundColor: '#4A9FFF' }]} /><Text style={s.legendTxt}>Read</Text></View>
          <View style={s.legendItem}><View style={[s.legendDot, { backgroundColor: '#10B981' }]} /><Text style={s.legendTxt}>Typing</Text></View>
          <View style={s.legendItem}><View style={[s.legendDot, { backgroundColor: '#A78BFA' }]} /><Text style={s.legendTxt}>Last Seen</Text></View>
        </View>

        {loading ? <ActivityIndicator color={C.accent} style={{ marginTop: 30 }} /> : (
          <FlatList
            data={filtered}
            keyExtractor={c => c.uid}
            renderItem={({ item }) => {
              const r = rules[item.uid] || { readReceipts: true, typing: true, lastSeen: true };
              return (
                <View style={s.contactRow}>
                  <View style={s.avatar}><Text style={{ fontSize: 18 }}>{"\uD83D\uDC64"}</Text></View>
                  <View style={{ flex: 1 }}>
                    <Text style={s.contactName}>{item.name}</Text>
                    <Text style={s.contactPhone}>{item.phone}</Text>
                  </View>
                  <View style={s.toggleGroup}>
                    <TouchableOpacity style={[s.toggleBtn, r.readReceipts && s.toggleOn, r.readReceipts && { backgroundColor: '#4A9FFF33', borderColor: '#4A9FFF' }]}
                      onPress={() => toggleRule(item.uid, 'readReceipts')}>
                      <Text style={[s.toggleIcon, r.readReceipts && { color: '#4A9FFF' }]}>{"\u2713\u2713"}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[s.toggleBtn, r.typing && s.toggleOn, r.typing && { backgroundColor: '#10B98133', borderColor: '#10B981' }]}
                      onPress={() => toggleRule(item.uid, 'typing')}>
                      <Text style={[s.toggleIcon, r.typing && { color: '#10B981' }]}>{"\u270D"}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[s.toggleBtn, r.lastSeen && s.toggleOn, r.lastSeen && { backgroundColor: '#A78BFA33', borderColor: '#A78BFA' }]}
                      onPress={() => toggleRule(item.uid, 'lastSeen')}>
                      <Text style={[s.toggleIcon, r.lastSeen && { color: '#A78BFA' }]}>{"\uD83D\uDD52"}</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            }}
            ListEmptyComponent={<View style={{ alignItems: 'center', padding: 40 }}><Text style={{ color: '#555' }}>No contacts found</Text></View>}
          />
        )}
      </View>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, padding: 16 },
  infoCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 14, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: '#111' },
  infoTitle: { color: '#fff', fontSize: 16, fontWeight: '800' },
  infoDesc: { color: '#666', fontSize: 12, marginTop: 2, lineHeight: 18 },
  searchInput: { backgroundColor: C.card, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, color: '#fff', fontSize: 14, marginBottom: 8, borderWidth: 1, borderColor: '#111' },
  legendRow: { flexDirection: 'row', gap: 16, marginBottom: 10, paddingLeft: 4 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendTxt: { color: '#666', fontSize: 10 },
  contactRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 12, padding: 12, marginBottom: 6, borderWidth: 1, borderColor: '#111' },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#111', justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  contactName: { color: '#E0E0F0', fontSize: 14, fontWeight: '700' },
  contactPhone: { color: '#555', fontSize: 11, marginTop: 2 },
  toggleGroup: { flexDirection: 'row', gap: 6 },
  toggleBtn: { width: 32, height: 32, borderRadius: 8, backgroundColor: '#111', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#222' },
  toggleOn: {},
  toggleIcon: { fontSize: 12, color: '#555' },
});
