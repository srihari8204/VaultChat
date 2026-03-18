// @ts-nocheck
// app/trusted-contacts.tsx — Trusted Contacts Manager
// Up to 3 emergency contacts who receive:
//   - GPS alert on duress PIN activation
//   - New device login notifications
//   - Panic button alerts
// Stored in Firestore: users/{uid}.trustedContacts[]

import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList,
  Alert, StatusBar, ActivityIndicator, TextInput,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';

const MAX_TRUSTED = 3;
const C = { bg: '#020B18', accent: '#00D4AA', danger: '#FF3C6E', primary: '#4A9FFF', card: '#0A1628' };

export default function TrustedContactsScreen() {
  const router = useRouter();
  const myUid = auth().currentUser?.uid || '';
  const [trusted, setTrusted] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [searchId, setSearchId] = useState('');
  const [searching, setSearching] = useState(false);

  useEffect(() => { loadTrusted(); }, []);

  const loadTrusted = async () => {
    setLoading(true);
    try {
      const snap = await firestore().collection('users').doc(myUid).get();
      const ids: string[] = snap.data()?.trustedContacts || [];
      const list: any[] = [];
      for (const uid of ids) {
        try {
          const uSnap = await firestore().collection('users').doc(uid).get();
          const d = uSnap.data();
          list.push({ uid, name: d?.name || 'Unknown', vaultId: d?.vaultId || uid.slice(0, 8), online: d?.online || false });
        } catch {}
      }
      setTrusted(list);
    } catch {}
    setLoading(false);
  };

  const addByVaultId = async () => {
    const id = searchId.trim().toLowerCase().replace('@', '');
    if (!id) return;
    if (trusted.length >= MAX_TRUSTED) { Alert.alert('Maximum Reached', 'You can have up to ' + MAX_TRUSTED + ' trusted contacts.'); return; }
    setSearching(true);
    try {
      const snap = await firestore().collection('users').where('vaultId', '==', id).get();
      if (snap.empty) { Alert.alert('Not Found', 'No user with VaultID @' + id); setSearching(false); return; }
      const doc = snap.docs[0];
      const peerUid = doc.id;
      if (peerUid === myUid) { Alert.alert('Error', "You can't add yourself"); setSearching(false); return; }
      if (trusted.some(t => t.uid === peerUid)) { Alert.alert('Already Added', 'This contact is already trusted.'); setSearching(false); return; }
      const peer = doc.data();
      // Add to Firestore
      await firestore().collection('users').doc(myUid).update({
        trustedContacts: firestore.FieldValue.arrayUnion(peerUid),
      });
      // Notify the trusted contact
      await firestore().collection('users').doc(peerUid).collection('alerts').add({
        type: 'trusted_added',
        fromUid: myUid,
        fromName: (await firestore().collection('users').doc(myUid).get()).data()?.name || 'Someone',
        message: 'You have been added as a trusted emergency contact',
        createdAt: firestore.FieldValue.serverTimestamp(),
        read: false,
      });
      setTrusted(prev => [...prev, { uid: peerUid, name: peer.name || id, vaultId: peer.vaultId || id, online: peer.online || false }]);
      setSearchId('');
      setAdding(false);
      Alert.alert('Added!', (peer.name || id) + ' is now a trusted contact. They will receive alerts if you activate duress mode.');
    } catch (e) { Alert.alert('Error', 'Could not add contact'); }
    setSearching(false);
  };

  const removeTrusted = (uid: string, name: string) => {
    Alert.alert('Remove Trusted Contact?', 'Remove ' + name + ' from your emergency contacts?', [
      { text: 'Cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => {
        try {
          await firestore().collection('users').doc(myUid).update({
            trustedContacts: firestore.FieldValue.arrayRemove(uid),
          });
          setTrusted(prev => prev.filter(t => t.uid !== uid));
        } catch {}
      }},
    ]);
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Trusted Contacts', headerStyle: { backgroundColor: '#0C0C1A' }, headerTintColor: '#fff' }} />
      <View style={s.container}>
        <StatusBar barStyle="light-content" />

        {/* Info Card */}
        <View style={s.infoCard}>
          <Text style={{ fontSize: 28, marginBottom: 8 }}>{"\uD83D\uDEE1\uFE0F"}</Text>
          <Text style={s.infoTitle}>Emergency Contacts</Text>
          <Text style={s.infoDesc}>
            These contacts will be silently notified with your GPS location if you activate the duress PIN (Ghost Protocol).
            They also receive alerts when your account is accessed from a new device.
          </Text>
          <View style={s.infoStats}>
            <Text style={s.infoStat}>{trusted.length}/{MAX_TRUSTED} contacts set</Text>
          </View>
        </View>

        {/* Trusted List */}
        {loading ? (
          <ActivityIndicator color={C.accent} style={{ marginTop: 30 }} />
        ) : (
          <FlatList
            data={trusted}
            keyExtractor={t => t.uid}
            renderItem={({ item }) => (
              <View style={s.contactRow}>
                <View style={s.contactAvatar}>
                  <Text style={{ color: '#fff', fontWeight: '900', fontSize: 18 }}>{(item.name || '?')[0].toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.contactName}>{item.name}</Text>
                  <Text style={s.contactId}>@{item.vaultId}</Text>
                </View>
                <View style={[s.statusDot, { backgroundColor: item.online ? '#10B981' : '#333' }]} />
                <TouchableOpacity onPress={() => removeTrusted(item.uid, item.name)} style={s.removeBtn}>
                  <Text style={{ color: C.danger, fontSize: 12, fontWeight: '700' }}>Remove</Text>
                </TouchableOpacity>
              </View>
            )}
            ListEmptyComponent={
              <View style={{ alignItems: 'center', paddingVertical: 30 }}>
                <Text style={{ color: '#555', fontSize: 14 }}>No trusted contacts yet</Text>
                <Text style={{ color: '#444', fontSize: 12, marginTop: 4 }}>Add up to {MAX_TRUSTED} emergency contacts</Text>
              </View>
            }
          />
        )}

        {/* Add Button */}
        {!adding && trusted.length < MAX_TRUSTED && (
          <TouchableOpacity style={s.addBtn} onPress={() => setAdding(true)}>
            <Text style={s.addBtnTxt}>{"\u2795  Add Trusted Contact"}</Text>
          </TouchableOpacity>
        )}

        {/* Add Form */}
        {adding && (
          <View style={s.addForm}>
            <Text style={s.addLabel}>Enter their VaultID</Text>
            <View style={s.addRow}>
              <Text style={{ color: '#888', fontSize: 18 }}>@</Text>
              <TextInput
                style={s.addInput}
                value={searchId}
                onChangeText={setSearchId}
                placeholder="vaultid"
                placeholderTextColor="#444"
                autoCapitalize="none"
                autoFocus
              />
              <TouchableOpacity style={s.addConfirm} onPress={addByVaultId} disabled={searching}>
                {searching ? <ActivityIndicator color="#000" size="small" /> : <Text style={{ color: '#000', fontWeight: '800' }}>Add</Text>}
              </TouchableOpacity>
            </View>
            <TouchableOpacity onPress={() => { setAdding(false); setSearchId(''); }}>
              <Text style={{ color: '#555', textAlign: 'center', marginTop: 12 }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* What they receive */}
        <View style={s.alertInfo}>
          <Text style={s.alertTitle}>What trusted contacts receive:</Text>
          <Text style={s.alertItem}>{"\uD83D\uDEA8"} Duress PIN activation — GPS + emergency alert</Text>
          <Text style={s.alertItem}>{"\uD83D\uDCF1"} New device login — device info + location</Text>
          <Text style={s.alertItem}>{"\uD83C\uDD98"} Panic button — instant location share</Text>
        </View>
      </View>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, padding: 16 },
  infoCard: { backgroundColor: C.card, borderRadius: 16, padding: 20, marginBottom: 16, borderWidth: 1, borderColor: '#111' },
  infoTitle: { color: '#fff', fontSize: 18, fontWeight: '900', marginBottom: 6 },
  infoDesc: { color: '#888', fontSize: 13, lineHeight: 20 },
  infoStats: { marginTop: 12, flexDirection: 'row' },
  infoStat: { color: C.accent, fontSize: 13, fontWeight: '700' },
  contactRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 14, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: '#111' },
  contactAvatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#1D4ED8', justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  contactName: { color: '#E0E0F0', fontSize: 15, fontWeight: '700' },
  contactId: { color: '#555', fontSize: 12, marginTop: 2 },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 12 },
  removeBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: '#FF3C6E15', borderWidth: 1, borderColor: '#FF3C6E33' },
  addBtn: { backgroundColor: C.accent + '22', borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 12, borderWidth: 1, borderColor: C.accent + '44' },
  addBtnTxt: { color: C.accent, fontSize: 14, fontWeight: '700' },
  addForm: { backgroundColor: C.card, borderRadius: 14, padding: 16, marginTop: 12, borderWidth: 1, borderColor: '#111' },
  addLabel: { color: '#888', fontSize: 13, marginBottom: 10 },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  addInput: { flex: 1, backgroundColor: '#111', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, color: '#fff', fontSize: 15 },
  addConfirm: { backgroundColor: C.accent, borderRadius: 10, paddingHorizontal: 20, paddingVertical: 10 },
  alertInfo: { marginTop: 20, backgroundColor: C.card, borderRadius: 14, padding: 16, borderWidth: 1, borderColor: '#111' },
  alertTitle: { color: '#888', fontSize: 12, fontWeight: '700', marginBottom: 10 },
  alertItem: { color: '#666', fontSize: 12, lineHeight: 22 },
});
