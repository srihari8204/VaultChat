// @ts-nocheck
// app/stickers.tsx — Sticker Pack Manager
// Built-in packs + create custom stickers from photos
// Stickers stored in Firestore: stickerPacks/{packId}/stickers/{id}

import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList,
  StatusBar, Image, Alert, ActivityIndicator, Dimensions, Modal,
} from 'react-native';
import { Stack } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import storage from '@react-native-firebase/storage';

const { width: SW } = Dimensions.get('window');
const TILE = (SW - 60) / 4;
const C = { bg: '#020B18', accent: '#4A9FFF', green: '#10B981', card: '#0A1628' };

// Built-in emoji sticker packs
const BUILTIN_PACKS = [
  { id: 'emotions', name: 'Emotions', stickers: ['😀','😂','🥰','😎','🤔','😱','🥳','😴','🤗','😤','🥺','😈','👻','💀','🤖','👽'] },
  { id: 'reactions', name: 'Reactions', stickers: ['👍','👎','❤️','🔥','💯','🎉','💪','🙏','👀','🤝','✅','❌','⚡','🚀','💎','🏆'] },
  { id: 'animals', name: 'Animals', stickers: ['🐶','🐱','🦁','🐻','🐼','🦊','🐸','🦄','🐳','🦋','🐙','🦅','🐧','🐨','🦈','🐝'] },
  { id: 'food', name: 'Food & Drink', stickers: ['🍕','🍔','🌮','🍣','🍩','☕','🍺','🧃','🍰','🍟','🥗','🍜','🍗','🍿','🧁','🥤'] },
  { id: 'travel', name: 'Travel', stickers: ['✈️','🏖️','🗻','🌍','🏕️','🚗','🚀','🏠','🌅','🎢','🗼','⛺','🚢','🏔️','🌴','🎡'] },
  { id: 'vault', name: 'VaultChat Special', stickers: ['🔐','🛡️','👁️‍🗨️','🔒','🕵️','💂','🔑','🧬','📡','🛰️','⚔️','🗡️','🏴‍☠️','🎯','🔮','💠'] },
];

export default function StickerScreen() {
  const myUid = auth().currentUser?.uid || '';
  const [tab, setTab] = useState('builtin');
  const [customPacks, setCustomPacks] = useState([]);
  const [selectedPack, setSelectedPack] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showPreview, setShowPreview] = useState(null);

  const loadCustomPacks = async () => {
    try {
      const snap = await firestore().collection('stickerPacks')
        .where('ownerUid', '==', myUid)
        .orderBy('createdAt', 'desc').get();
      setCustomPacks(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch {}
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadCustomPacks(); }, [myUid]);

  const createCustomPack = async () => {
    Alert.prompt('New Sticker Pack', 'Enter a name for your pack:', async (name) => {
      if (!name?.trim()) return;
      try {
        await firestore().collection('stickerPacks').add({
          name: name.trim(),
          ownerUid: myUid,
          stickers: [],
          isPublic: false,
          createdAt: firestore.FieldValue.serverTimestamp(),
        });
        await loadCustomPacks();
        Alert.alert('Created!', 'Now add stickers from your photos');
      } catch { Alert.alert('Error', 'Could not create pack'); }
    });
  };

  const addStickerToCustom = async (packId) => {
    const result = await ImagePicker.launchImageLibraryAsync({ quality: 0.7, allowsEditing: true, aspect: [1, 1] });
    if (result.canceled) return;
    setLoading(true);
    try {
      const uri = result.assets[0].uri;
      const filename = 'sticker_' + Date.now() + '.jpg';
      const ref = storage().ref('stickers/' + myUid + '/' + filename);
      await ref.putFile(uri);
      const url = await ref.getDownloadURL();
      await firestore().collection('stickerPacks').doc(packId).update({
        stickers: firestore.FieldValue.arrayUnion(url),
      });
      await loadCustomPacks();
    } catch { Alert.alert('Error', 'Could not upload sticker'); }
    setLoading(false);
  };

  const renderBuiltinPack = ({ item }) => (
    <TouchableOpacity style={s.packCard} onPress={() => setSelectedPack(item)}>
      <Text style={s.packEmoji}>{item.stickers[0]}</Text>
      <Text style={s.packName}>{item.name}</Text>
      <Text style={s.packCount}>{item.stickers.length} stickers</Text>
    </TouchableOpacity>
  );

  const renderCustomPack = ({ item }) => (
    <TouchableOpacity style={s.packCard} onPress={() => setSelectedPack({ ...item, isCustom: true })}>
      <Text style={s.packEmoji}>{"\uD83C\uDFA8"}</Text>
      <Text style={s.packName}>{item.name}</Text>
      <Text style={s.packCount}>{(item.stickers || []).length} stickers</Text>
    </TouchableOpacity>
  );

  if (selectedPack) {
    const isCustom = selectedPack.isCustom;
    const stickers = selectedPack.stickers || [];
    return (
      <>
        <Stack.Screen options={{ title: selectedPack.name, headerStyle: { backgroundColor: '#0C0C1A' }, headerTintColor: '#fff' }} />
        <View style={s.container}>
          <FlatList
            data={stickers}
            numColumns={4}
            keyExtractor={(_, i) => String(i)}
            renderItem={({ item }) => (
              <TouchableOpacity style={s.stickerTile} onPress={() => setShowPreview(item)}>
                {typeof item === 'string' && item.startsWith('http') ? (
                  <Image source={{ uri: item }} style={s.stickerImg} />
                ) : (
                  <Text style={s.stickerEmoji}>{item}</Text>
                )}
              </TouchableOpacity>
            )}
            contentContainerStyle={{ padding: 12 }}
          />
          {isCustom && (
            <TouchableOpacity style={s.addStickerBtn} onPress={() => addStickerToCustom(selectedPack.id)} disabled={loading}>
              {loading ? <ActivityIndicator color="#000" /> : <Text style={{ color: '#000', fontWeight: '800' }}>{"\u2795  Add Sticker from Photos"}</Text>}
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={() => setSelectedPack(null)} style={{ padding: 16, alignItems: 'center' }}>
            <Text style={{ color: '#555' }}>Back to Packs</Text>
          </TouchableOpacity>
          <Modal visible={!!showPreview} transparent animationType="fade" onRequestClose={() => setShowPreview(null)}>
            <TouchableOpacity style={s.previewBg} activeOpacity={1} onPress={() => setShowPreview(null)}>
              {showPreview && typeof showPreview === 'string' && showPreview.startsWith('http') ? (
                <Image source={{ uri: showPreview }} style={{ width: 200, height: 200 }} />
              ) : (
                <Text style={{ fontSize: 120 }}>{showPreview}</Text>
              )}
            </TouchableOpacity>
          </Modal>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Sticker Packs', headerStyle: { backgroundColor: '#0C0C1A' }, headerTintColor: '#fff' }} />
      <View style={s.container}>
        <StatusBar barStyle="light-content" />
        <View style={s.tabs}>
          <TouchableOpacity style={[s.tab, tab === 'builtin' && s.tabActive]} onPress={() => setTab('builtin')}>
            <Text style={[s.tabTxt, tab === 'builtin' && s.tabTxtActive]}>Built-in</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.tab, tab === 'custom' && s.tabActive]} onPress={() => setTab('custom')}>
            <Text style={[s.tabTxt, tab === 'custom' && s.tabTxtActive]}>My Packs</Text>
          </TouchableOpacity>
        </View>
        {tab === 'builtin' ? (
          <FlatList data={BUILTIN_PACKS} keyExtractor={p => p.id} renderItem={renderBuiltinPack} contentContainerStyle={{ padding: 12 }} />
        ) : (
          <>
            <FlatList data={customPacks} keyExtractor={p => p.id} renderItem={renderCustomPack}
              contentContainerStyle={{ padding: 12 }}
              ListEmptyComponent={<View style={{ alignItems: 'center', padding: 40 }}><Text style={{ color: '#555' }}>No custom packs yet</Text></View>}
            />
            <TouchableOpacity style={s.createPackBtn} onPress={createCustomPack}>
              <Text style={s.createPackTxt}>{"\u2795  Create Sticker Pack"}</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  tabs: { flexDirection: 'row', paddingHorizontal: 12, paddingTop: 8, gap: 6 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10, backgroundColor: '#0A1628' },
  tabActive: { backgroundColor: C.accent },
  tabTxt: { color: '#888', fontSize: 13, fontWeight: '700' },
  tabTxtActive: { color: '#000' },
  packCard: { backgroundColor: C.card, borderRadius: 14, padding: 16, marginBottom: 8, borderWidth: 1, borderColor: '#111', flexDirection: 'row', alignItems: 'center', gap: 12 },
  packEmoji: { fontSize: 32 },
  packName: { color: '#E0E0F0', fontSize: 15, fontWeight: '700', flex: 1 },
  packCount: { color: '#555', fontSize: 12 },
  stickerTile: { width: TILE, height: TILE, margin: 4, borderRadius: 12, backgroundColor: '#0A1628', justifyContent: 'center', alignItems: 'center' },
  stickerEmoji: { fontSize: 36 },
  stickerImg: { width: TILE - 8, height: TILE - 8, borderRadius: 10 },
  addStickerBtn: { margin: 12, backgroundColor: C.accent, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  createPackBtn: { margin: 12, backgroundColor: '#4A9FFF22', borderRadius: 12, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: '#4A9FFF44' },
  createPackTxt: { color: C.accent, fontSize: 14, fontWeight: '700' },
  previewBg: { flex: 1, backgroundColor: '#000000CC', justifyContent: 'center', alignItems: 'center' },
});
