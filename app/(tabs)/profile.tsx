// app/profile.tsx
// Profile screen â€” photo, name, VaultID, links to all settings screens

import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  Image, Alert, ActivityIndicator, ScrollView, TextInput,
} from 'react-native';
import { useRouter } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import storage from '@react-native-firebase/storage';
import * as ImagePicker from 'expo-image-picker';

export default function ProfileScreen() {
  const router = useRouter();
  const myUid  = auth().currentUser?.uid ?? '';

  const [name,    setName]    = useState('');
  const [phone,   setPhone]   = useState('');
  const [photo,   setPhoto]   = useState('');
  const [vaultId, setVaultId] = useState('');
  const [online,  setOnline]  = useState(false);
  const [saving,  setSaving]  = useState(false);
  const [editName,setEditName]= useState(false);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    firestore().collection('users').doc(myUid).get().then(snap => {
      const d = snap.data();
      setName(d?.name ?? '');
      setPhone(d?.phone ?? auth().currentUser?.phoneNumber ?? '');
      setPhoto(d?.photoURL ?? '');
      setVaultId(d?.vaultId ?? '');
      setOnline(d?.online ?? false);
    });
  }, [myUid]);

  const pickPhoto = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.7, allowsEditing: true, aspect: [1,1] });
    if (res.canceled || !res.assets[0]) return;
    setSaving(true);
    try {
      const uri  = res.assets[0].uri;
      const ref  = storage().ref(`avatars/${myUid}.jpg`);
      await ref.putFile(uri);
      const url  = await ref.getDownloadURL();
      await firestore().collection('users').doc(myUid).update({ photoURL: url });
      setPhoto(url);
    } catch (e: any) { Alert.alert('Error', e.message); }
    finally { setSaving(false); }
  };

  const saveName = async () => {
    if (!newName.trim()) return;
    setSaving(true);
    await firestore().collection('users').doc(myUid).update({ name: newName.trim() }).catch(() => {});
    setName(newName.trim()); setEditName(false);
    setSaving(false);
  };

  const MenuItem = ({ icon, label, onPress, danger }: any) => (
    <TouchableOpacity style={s.menuItem} onPress={onPress}>
      <Text style={s.menuIcon}>{icon}</Text>
      <Text style={[s.menuLabel, danger && { color: '#FF3C6E' }]}>{label}</Text>
      <Text style={s.menuArrow}>â€º</Text>
    </TouchableOpacity>
  );

  return (
    <>
      {/* header managed by tab layout */}
      <ScrollView style={s.screen}>

        {/* Avatar */}
        <View style={s.avatarSection}>
          <TouchableOpacity onPress={pickPhoto} style={s.avatarWrap}>
            {photo
              ? <Image source={{ uri: photo }} style={s.avatar} />
              : <View style={[s.avatar, s.avatarFallback]}><Text style={s.avatarFallbackTxt}>{name[0]?.toUpperCase() ?? '?'}</Text></View>
            }
            {saving ? <ActivityIndicator style={StyleSheet.absoluteFillObject} color="#00E5FF" /> : <View style={s.editBadge}><Text style={{ color: '#000', fontSize: 16 }}>ðŸ“·</Text></View>}
            {online && <View style={s.onlineDot} />}
          </TouchableOpacity>

          {editName
            ? <View style={s.nameEdit}>
                <TextInput style={s.nameInput} value={newName} onChangeText={setNewName} autoFocus />
                <TouchableOpacity onPress={saveName} style={s.nameSaveBtn}><Text style={{ color: '#000', fontWeight: 'bold' }}>Save</Text></TouchableOpacity>
              </View>
            : <TouchableOpacity onPress={() => { setNewName(name); setEditName(true); }}>
                <Text style={s.name}>{name}</Text>
                <Text style={s.nameSub}>Tap to edit name âœï¸</Text>
              </TouchableOpacity>
          }

          <Text style={s.phone}>{phone}</Text>
          {vaultId ? <Text style={s.vaultId}>@{vaultId}</Text> : null}
        </View>

        {/* Menu */}
        <Text style={s.sectionLabel}>SECURITY</Text>
        <MenuItem icon="ðŸ”" label="D2DE Encryption Status" onPress={() => router.push('/d2de-status')} />
        <MenuItem icon="ðŸŒ‘" label="Dark Web Guard"         onPress={() => router.push('/dark-web-guard')} />
        <MenuItem icon="ðŸ›¡ï¸" label="Security Alerts"        onPress={() => router.push('/alerts')} />
        <MenuItem icon="ðŸ›ï¸" label="Secret Vault"           onPress={() => router.push('/vault')} />

        <Text style={s.sectionLabel}>FEATURES</Text>
        <MenuItem icon="âš™ï¸"  label="Settings & Privacy"   onPress={() => router.push('/settings')} />
        <MenuItem icon="â­"  label="Starred Messages"      onPress={() => router.push('/starred')} />
        <MenuItem icon="ðŸ“…"  label="Scheduled Messages"   onPress={() => router.push('/scheduled')} />
        <MenuItem icon="ðŸ”"  label="Search Messages"       onPress={() => router.push('/search')} />

        <Text style={s.sectionLabel}>ACCOUNT</Text>
        <MenuItem icon="ðŸšª" label="Sign Out" onPress={() => auth().signOut()} danger />

        <View style={{ height: 40 }} />
      </ScrollView>
    </>
  );
}

const s = StyleSheet.create({
  screen:          { flex: 1, backgroundColor: '#FFFFFF' },
  avatarSection:   { alignItems: 'center', paddingTop: 32, paddingBottom: 24, borderBottomWidth: 1, borderBottomColor: '#F1F3F4' },
  avatarWrap:      { position: 'relative', marginBottom: 14 },
  avatar:          { width: 96, height: 96, borderRadius: 48 },
  avatarFallback:  { backgroundColor: '#F3F4F6', alignItems: 'center', justifyContent: 'center' },
  avatarFallbackTxt:{ color: '#4A9FFF', fontSize: 38, fontWeight: 'bold' },
  editBadge:       { position: 'absolute', bottom: 0, right: 0, width: 30, height: 30, borderRadius: 15, backgroundColor: '#4A9FFF', alignItems: 'center', justifyContent: 'center' },
  onlineDot:       { position: 'absolute', top: 4, right: 4, width: 14, height: 14, borderRadius: 7, backgroundColor: '#00FF88', borderWidth: 2, borderColor: '#FFFFFF' },
  name:            { color: '#1F2937', fontSize: 22, fontWeight: 'bold', textAlign: 'center' },
  nameSub:         { color: '#9CA3AF', fontSize: 12, textAlign: 'center', marginTop: 2 },
  nameEdit:        { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  nameInput:       { backgroundColor: '#F3F4F6', color: '#1F2937', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 18, minWidth: 180 },
  nameSaveBtn:     { backgroundColor: '#4A9FFF', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  phone:           { color: '#6B7280', fontSize: 14, marginTop: 4 },
  vaultId:         { color: '#4A9FFF', fontSize: 13, marginTop: 4 },
  sectionLabel:    { color: '#6B7280', fontSize: 11, fontWeight: '700', letterSpacing: 1.2, paddingHorizontal: 16, paddingTop: 20, paddingBottom: 8 },
  menuItem:        { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFFFFF', paddingHorizontal: 16, paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: '#F1F3F4' },
  menuIcon:        { fontSize: 20, marginRight: 14, width: 28, textAlign: 'center' },
  menuLabel:       { color: '#1F2937', fontSize: 15, flex: 1 },
  menuArrow:       { color: '#D1D5DB', fontSize: 22 },
});
