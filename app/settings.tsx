// app/settings.tsx
// Privacy settings: read receipts, typing indicator, last seen,
// VaultID username, duress PIN setup, backup, scheduled messages

import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Switch,
  TextInput, Alert, ScrollView, ActivityIndicator,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import * as Crypto from 'expo-crypto';
import { exportEncryptedBackup } from '../services/backupService';

export default function SettingsScreen() {
  const router = useRouter();
  const myUid  = auth().currentUser?.uid ?? '';

  const [readReceipts,   setReadReceipts]   = useState(true);
  const [typingIndicator,setTypingIndicator]= useState(true);
  const [lastSeen,       setLastSeen]       = useState(true);
  const [vaultId,        setVaultId]        = useState('');
  const [vaultIdInput,   setVaultIdInput]   = useState('');
  const [savingId,       setSavingId]       = useState(false);
  const [backingUp,      setBackingUp]      = useState(false);
  const [backupProgress, setBackupProgress] = useState('');
  const [duressPin,      setDuressPin]      = useState('');
  const [duressInput,    setDuressInput]    = useState('');
  const [smartReplies,   setSmartReplies]   = useState(true);
  const [linkPreviews,   setLinkPreviews]   = useState(true);

  useEffect(() => {
    firestore().collection('users').doc(myUid).get().then(snap => {
      const d = snap.data();
      if (!d) return;
      setReadReceipts(d.settings?.readReceipts ?? true);
      setTypingIndicator(d.settings?.typingIndicator ?? true);
      setLastSeen(d.settings?.lastSeen ?? true);
      setVaultId(d.vaultId ?? '');
      setVaultIdInput(d.vaultId ?? '');
      setSmartReplies(d.settings?.smartReplies ?? true);
      setLinkPreviews(d.settings?.linkPreviews ?? true);
    });
  }, [myUid]);

  const saveSettings = async (key: string, value: any) => {
    try {
      await firestore().collection('users').doc(myUid).update({ [`settings.${key}`]: value });
    } catch {
      Alert.alert('Save failed', 'Could not update setting. Check your connection.');
    }
  };

  const saveVaultId = async () => {
    const id = vaultIdInput.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (id.length < 4) { Alert.alert('VaultID must be at least 4 characters'); return; }
    setSavingId(true);
    try {
      // Check uniqueness
      const snap = await firestore().collection('users').where('vaultId', '==', id).get();
      if (!snap.empty && snap.docs[0].id !== myUid) {
        Alert.alert('That VaultID is taken. Choose another.'); return;
      }
      await firestore().collection('users').doc(myUid).update({ vaultId: id });
      setVaultId(id);
      Alert.alert('VaultID saved!', `Your ID is @${id}`);
    } catch (e: any) { Alert.alert('Error', e.message); }
    finally { setSavingId(false); }
  };

  const saveDuressPin = async () => {
    if (duressInput.length < 4) { Alert.alert('Duress PIN must be at least 4 digits'); return; }
    // Hash the duress PIN before storing Ã¢â‚¬â€ never store raw PIN
    const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, 'vaultchat-duress-' + duressInput);
    await firestore().collection('users').doc(myUid).update({ duressPinHash: hash });
    setDuressPin(hash);
    setDuressInput('');
    Alert.alert('Duress PIN set', 'Entering this PIN will show an empty decoy app and silently wipe messages.');
  };

  const startBackup = async () => {
    Alert.prompt(
      'Backup Password',
      'Enter a password to encrypt your backup. You will need this to restore.',
      async (pin) => {
        if (!pin || pin.length < 4) { Alert.alert('Password must be at least 4 characters'); return; }
        setBackingUp(true);
        try {
          await exportEncryptedBackup(pin, msg => setBackupProgress(msg));
        } catch (e: any) { Alert.alert('Backup failed', e.message); }
        finally { setBackingUp(false); setBackupProgress(''); }
      },
      'secure-text'
    );
  };

  const Row = ({ label, value, onValueChange, desc }: { label: string; value: boolean; onValueChange: (v: boolean) => void; desc?: string }) => (
    <View style={s.row}>
      <View style={{ flex: 1 }}>
        <Text style={s.rowLabel}>{label}</Text>
        {desc && <Text style={s.rowDesc}>{desc}</Text>}
      </View>
      <Switch value={value} onValueChange={v => { onValueChange(v); }} thumbColor={value ? '#4A9FFF' : '#D1D5DB'} trackColor={{ false: '#E5E7EB', true: '#4A9FFF44' }} />
    </View>
  );

  return (
    <>
      <Stack.Screen options={{ title: 'Ã¢Å¡â„¢Ã¯Â¸Â Settings', headerStyle: { backgroundColor: '#FFFFFF' }, headerTintColor: '#1F2937' }} />
      <ScrollView style={s.screen}>

        {/* Privacy */}
        <Text style={s.sectionTitle}>PRIVACY</Text>
        <Row label="Read Receipts (Blue ticks)" value={readReceipts} onValueChange={v => { setReadReceipts(v); saveSettings('readReceipts', v); }} desc="Let others know when you've read their messages" />
        <Row label="Typing Indicator" value={typingIndicator} onValueChange={v => { setTypingIndicator(v); saveSettings('typingIndicator', v); }} desc="Show 'typingÃ¢â‚¬Â¦' when you're composing a message" />
        <Row label="Last Seen / Online" value={lastSeen} onValueChange={v => { setLastSeen(v); saveSettings('lastSeen', v); }} desc="Show your online status and last seen time" />

        {/* AI */}
        <Text style={[s.sectionTitle, { marginTop: 24 }]}>AI FEATURES</Text>
        <Row label="Smart Replies" value={smartReplies} onValueChange={v => { setSmartReplies(v); saveSettings('smartReplies', v); }} desc="Suggest quick replies based on message context" />
        <Row label="Link Previews" value={linkPreviews} onValueChange={v => { setLinkPreviews(v); saveSettings('linkPreviews', v); }} desc="Show preview cards for URLs in messages" />

        {/* VaultID */}
        <Text style={[s.sectionTitle, { marginTop: 24 }]}>VAULT ID</Text>
        <View style={s.vaultIdSection}>
          <Text style={s.desc}>Choose a unique username so people can find you without sharing your phone number.</Text>
          {vaultId ? <Text style={s.currentId}>Current: @{vaultId}</Text> : null}
          <View style={s.idRow}>
            <Text style={s.atSign}>@</Text>
            <TextInput
              style={s.idInput}
              value={vaultIdInput}
              onChangeText={setVaultIdInput}
              placeholder="yourname"
              placeholderTextColor="#444"
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={30}
            />
            <TouchableOpacity style={s.saveBtn} onPress={saveVaultId} disabled={savingId}>
              {savingId ? <ActivityIndicator color="#000" size="small" /> : <Text style={s.saveBtnTxt}>Save</Text>}
            </TouchableOpacity>
          </View>
        </View>

        {/* Duress PIN */}
        <Text style={[s.sectionTitle, { marginTop: 24 }]}>DURESS PIN</Text>
        <View style={s.vaultIdSection}>
          <Text style={s.desc}>Set a secondary PIN. If entered under coercion, it silently wipes your messages and shows an empty decoy app.</Text>
          {duressPin ? <Text style={[s.currentId, { color: '#FF3C6E' }]}>Ã¢Å“â€œ Duress PIN is set</Text> : null}
          <View style={s.idRow}>
            <TextInput
              style={[s.idInput, { flex: 1 }]}
              value={duressInput}
              onChangeText={setDuressInput}
              placeholder="Enter 4+ digit duress PIN"
              placeholderTextColor="#444"
              keyboardType="number-pad"
              secureTextEntry
              maxLength={8}
            />
            <TouchableOpacity style={[s.saveBtn, { backgroundColor: '#FF3C6E' }]} onPress={saveDuressPin}>
              <Text style={s.saveBtnTxt}>Set</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Backup */}
        
        {/* Trusted Contacts */}
        <Text style={[s.sectionTitle, { marginTop: 24 }]}>TRUSTED CONTACTS</Text>
        
        {/* Chat Themes */}
        <TouchableOpacity style={{ backgroundColor: '#F9FAFB', borderRadius: 14, padding: 16, marginBottom: 8, borderWidth: 1, borderColor: '#E5E7EB', flexDirection: 'row', alignItems: 'center' }}
          onPress={() => router.push('/chat-themes' as any)}>
          <Text style={{ fontSize: 22, marginRight: 12 }}>{"\uD83C\uDFA8"}</Text>
          <View style={{ flex: 1 }}>
            <Text style={{ color: '#1F2937', fontSize: 15, fontWeight: '700' }}>Chat Themes</Text>
            <Text style={{ color: '#6B7280', fontSize: 12, marginTop: 2 }}>Customize backgrounds and bubble colors</Text>
          </View>
          <Text style={{ color: '#6B7280', fontSize: 18 }}>{"\u203A"}</Text>
        </TouchableOpacity>

<TouchableOpacity style={{ backgroundColor: '#F9FAFB', borderRadius: 14, padding: 16, marginBottom: 8, borderWidth: 1, borderColor: '#E5E7EB', flexDirection: 'row', alignItems: 'center' }}
          onPress={() => router.push('/trusted-contacts' as any)}>
          <Text style={{ fontSize: 22, marginRight: 12 }}>{"\uD83D\uDEE1\uFE0F"}</Text>
          <View style={{ flex: 1 }}>
            <Text style={{ color: '#1F2937', fontSize: 15, fontWeight: '700' }}>Manage Trusted Contacts</Text>
            <Text style={{ color: '#6B7280', fontSize: 12, marginTop: 2 }}>Up to 3 emergency contacts for duress alerts</Text>
          </View>
          <Text style={{ color: '#6B7280', fontSize: 18 }}>{"\u203A"}</Text>
        </TouchableOpacity>

        {/* Login History */}
        <TouchableOpacity style={{ backgroundColor: '#F9FAFB', borderRadius: 14, padding: 16, marginBottom: 8, borderWidth: 1, borderColor: '#E5E7EB', flexDirection: 'row', alignItems: 'center' }}
          onPress={() => router.push('/login-history' as any)}>
          <Text style={{ fontSize: 22, marginRight: 12 }}>{"\uD83D\uDD10"}</Text>
          <View style={{ flex: 1 }}>
            <Text style={{ color: '#1F2937', fontSize: 15, fontWeight: '700' }}>Login History</Text>
            <Text style={{ color: '#6B7280', fontSize: 12, marginTop: 2 }}>View active sessions, revoke devices</Text>
          </View>
          <Text style={{ color: '#6B7280', fontSize: 18 }}>{"\u203A"}</Text>
        </TouchableOpacity>

<Text style={[s.sectionTitle, { marginTop: 24 }]}>ENCRYPTED BACKUP</Text>
        <View style={s.vaultIdSection}>
          <Text style={s.desc}>Export all your chats as an AES-256 encrypted file. Only you can decrypt it with your backup password.</Text>
          {backingUp && <Text style={s.progressTxt}>{backupProgress}</Text>}
          <TouchableOpacity style={[s.saveBtn, { width: '100%', paddingVertical: 12, marginTop: 8 }]} onPress={startBackup} disabled={backingUp}>
            {backingUp
              ? <ActivityIndicator color="#000" />
              : <Text style={s.saveBtnTxt}>Ã°Å¸â€œÂ¦ Export Encrypted Backup</Text>
            }
          </TouchableOpacity>
        </View>

        {/* Danger zone */}
        <Text style={[s.sectionTitle, { marginTop: 24, color: '#FF3C6E' }]}>ACCOUNT</Text>
        <TouchableOpacity style={s.dangerRow} onPress={() => router.push('/search' as any)}>
          <Text style={s.dangerTxt}>Ã°Å¸â€Â Search Messages</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.dangerRow} onPress={() => router.push('/starred' as any)}>
          <Text style={s.dangerTxt}>Ã¢Â­Â Starred Messages</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.dangerRow, { borderTopColor: '#FF3C6E44' }]} onPress={() => {
          Alert.alert('Sign Out?', '', [{ text: 'Cancel', style: 'cancel' }, { text: 'Sign Out', style: 'destructive', onPress: () => auth().signOut() }]);
        }}>
          <Text style={[s.dangerTxt, { color: '#FF3C6E' }]}>Ã°Å¸Å¡Âª Sign Out</Text>
        </TouchableOpacity>

        <View style={{ height: 50 }} />
      </ScrollView>
    </>
  );
}

const s = StyleSheet.create({
  screen:       { flex: 1, backgroundColor: '#FFFFFF' },
  sectionTitle: { color: '#6B7280', fontSize: 11, fontWeight: '700', letterSpacing: 1.2, paddingHorizontal: 16, paddingTop: 20, paddingBottom: 8 },
  row:          { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFFFFF', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#F1F3F4' },
  rowLabel:     { color: '#1F2937', fontSize: 15, marginBottom: 2 },
  rowDesc:      { color: '#6B7280', fontSize: 12 },
  vaultIdSection:{ backgroundColor: '#FFFFFF', padding: 16, borderTopWidth: 1, borderBottomWidth: 1, borderColor: '#F1F3F4' },
  desc:         { color: '#6B7280', fontSize: 12, lineHeight: 18, marginBottom: 10 },
  currentId:    { color: '#4A9FFF', fontSize: 13, fontWeight: 'bold', marginBottom: 8 },
  idRow:        { flexDirection: 'row', alignItems: 'center', gap: 8 },
  atSign:       { color: '#6B7280', fontSize: 18, fontWeight: 'bold' },
  idInput:      { flex: 1, backgroundColor: '#F3F4F6', color: '#1F2937', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  saveBtn:      { backgroundColor: '#4A9FFF', borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10, alignItems: 'center' },
  saveBtnTxt:   { color: '#000', fontSize: 14, fontWeight: 'bold' },
  progressTxt:  { color: '#4A9FFF', fontSize: 12, marginBottom: 8 },
  dangerRow:    { backgroundColor: '#FFFFFF', paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: 1, borderTopColor: '#F1F3F4' },
  dangerTxt:    { color: '#1F2937', fontSize: 15 },
});
