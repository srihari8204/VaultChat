import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  ScrollView, Alert, ActivityIndicator, SafeAreaView, Platform
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { useRouter } from 'expo-router';

// REPLACE with your actual backend IP
const API = 'http://YOUR_BACKEND_IP:3001/api/vaultdrop';

const C = {
  link:   '#4A9FFF',
  direct: '#10B981',
  bg:     '#030912',
  card:   '#0D1B2E',
  border: 'rgba(255,255,255,0.09)',
  text:   '#fff',
  sub:    'rgba(255,255,255,0.4)',
};

type DropType = 'link' | 'direct' | null;

export default function VaultDropScreen() {
  const router = useRouter();
  const [dropType,   setDropType]   = useState<DropType>(null);
  const [pickedFile, setPickedFile] = useState<any>(null);
  const [email,      setEmail]      = useState('');
  const [loading,    setLoading]    = useState(false);
  const [progress,   setProgress]   = useState(0);
  const [result,     setResult]     = useState<any>(null);

  const pickFile = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
      if (!res.canceled) setPickedFile(res.assets[0]);
    } catch {
      Alert.alert('Error', 'Could not open file picker');
    }
  };

  const fakeProgress = (onDone: () => void) => {
    setProgress(0);
    let p = 0;
    const t = setInterval(() => {
      p += 5;
      setProgress(p);
      if (p >= 90) { clearInterval(t); onDone(); }
    }, 60);
  };

  const sendLink = async () => {
    if (!pickedFile || !email.trim()) {
      Alert.alert('Missing info', 'Please pick a file and enter recipient email');
      return;
    }
    setLoading(true);
    fakeProgress(async () => {
      try {
        const formData = new FormData();
        formData.append('recipientEmail', email.trim());
        formData.append('fileName',       pickedFile.name);
        formData.append('senderName',     'VaultChat User');
        formData.append('file', {
          uri:  pickedFile.uri,
          name: pickedFile.name,
          type: pickedFile.mimeType || 'application/octet-stream',
        } as any);
        const resp = await fetch(`${API}/create-link`, { method: 'POST', body: formData });
        const data = await resp.json();
        if (data.success) {
          setProgress(100);
          setTimeout(() => { setLoading(false); setResult(data); }, 400);
        } else {
          throw new Error(data.error || 'Unknown error');
        }
      } catch (err: any) {
        setLoading(false);
        Alert.alert('Error', err.message || 'Failed to send');
      }
    });
  };

  const sendDirect = async () => {
    if (!pickedFile || !email.trim()) {
      Alert.alert('Missing info', 'Please pick a file and enter recipient email');
      return;
    }
    setLoading(true);
    fakeProgress(async () => {
      try {
        const formData = new FormData();
        formData.append('recipientEmail', email.trim());
        formData.append('fileName',       pickedFile.name);
        formData.append('senderName',     'VaultChat User');
        formData.append('file', {
          uri:  pickedFile.uri,
          name: pickedFile.name,
          type: pickedFile.mimeType || 'application/octet-stream',
        } as any);
        const resp = await fetch(`${API}/send-direct`, { method: 'POST', body: formData });
        const data = await resp.json();
        if (data.success) {
          setProgress(100);
          setTimeout(() => {
            setLoading(false);
            Alert.alert('Sent!', `File delivered to ${email}`);
            resetForm();
          }, 400);
        } else {
          throw new Error(data.error || 'Failed');
        }
      } catch (err: any) {
        setLoading(false);
        Alert.alert('Error', err.message || 'Failed to send');
      }
    });
  };

  const resetForm = () => {
    setDropType(null); setPickedFile(null);
    setEmail(''); setResult(null); setProgress(0);
  };

  const color = dropType === 'link' ? C.link : C.direct;

  // -- Loading screen ------------------------------------
  if (loading) {
    return (
      <SafeAreaView style={[s.root, { justifyContent: 'center', alignItems: 'center' }]}>
        <Text style={{ fontSize: 40, marginBottom: 16 }}>??</Text>
        <Text style={[s.subText, { color: '#fff', fontSize: 14, marginBottom: 20 }]}>Encrypting & Sending…</Text>
        <View style={s.progressTrack}>
          <View style={[s.progressFill, { width: `${progress}%` as any }]} />
        </View>
        <Text style={s.subText}>{progress}% · AES-256</Text>
      </SafeAreaView>
    );
  }

  // -- Result screen -------------------------------------
  if (result) {
    return (
      <SafeAreaView style={s.root}>
        <ScrollView contentContainerStyle={{ padding: 20 }}>
          <Text style={{ fontSize: 44, textAlign: 'center', marginBottom: 12 }}>?</Text>
          <Text style={[s.heading, { color: C.link, textAlign: 'center' }]}>Link + Code Sent!</Text>
          <Text style={[s.subText, { textAlign: 'center', marginBottom: 24 }]}>Delivered to {email}</Text>

          <View style={[s.card, { borderColor: `${C.link}44`, marginBottom: 14 }]}>
            <Text style={[s.label, { color: C.link }]}>8-DIGIT CODE — SHARE VERBALLY</Text>
            <Text style={[s.code8, { color: C.link }]}>
              {result.code8?.slice(0, 4)}  {result.code8?.slice(4)}
            </Text>
            <Text style={s.subText}>Tell this to your recipient — the link alone won't work</Text>
          </View>

          <View style={[s.card, { marginBottom: 20 }]}>
            <Text style={s.label}>LINK SENT TO THEIR EMAIL</Text>
            <Text style={{ color: C.link, fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace' }}>
              {result.link}
            </Text>
          </View>

          <Text style={[s.subText, { textAlign: 'center', color: 'rgba(239,68,68,0.8)', marginBottom: 20 }]}>
            One-time use · File auto-deletes after download
          </Text>

          <TouchableOpacity style={[s.btnPrimary, { backgroundColor: 'rgba(255,255,255,0.08)' }]} onPress={resetForm}>
            <Text style={[s.btnText, { color: 'rgba(255,255,255,0.5)' }]}>Send Another</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.btnPrimary} onPress={() => router.back()}>
            <Text style={s.btnText}>Back to Chat</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // -- Option picker -------------------------------------
  if (!dropType) {
    return (
      <SafeAreaView style={s.root}>
        <ScrollView contentContainerStyle={{ padding: 20 }}>
          <TouchableOpacity onPress={() => router.back()} style={{ marginBottom: 16 }}>
            <Text style={{ color: C.link, fontSize: 15 }}>? Back</Text>
          </TouchableOpacity>

          <Text style={s.label}>VAULTDROP</Text>
          <Text style={s.heading}>Send Files Securely</Text>
          <Text style={[s.subText, { marginBottom: 24 }]}>To any desktop. No app needed.</Text>

          <TouchableOpacity style={[s.optCard, { borderColor: `${C.link}33` }]} onPress={() => setDropType('link')}>
            <View style={[s.optIcon, { backgroundColor: `${C.link}18` }]}>
              <Text style={{ fontSize: 22 }}>??</Text>
            </View>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <Text style={s.optTitle}>Secure Link + Code</Text>
                <View style={[s.badge, { backgroundColor: `${C.link}18`, borderColor: `${C.link}33` }]}>
                  <Text style={[s.badgeText, { color: C.link }]}>SECURE</Text>
                </View>
              </View>
              <Text style={s.subText}>Email with link · 8-digit code to unlock · Auto-delete</Text>
            </View>
            <Text style={{ color: 'rgba(255,255,255,0.2)', fontSize: 18 }}>›</Text>
          </TouchableOpacity>

          <TouchableOpacity style={[s.optCard, { borderColor: `${C.direct}33` }]} onPress={() => setDropType('direct')}>
            <View style={[s.optIcon, { backgroundColor: `${C.direct}18` }]}>
              <Text style={{ fontSize: 22 }}>??</Text>
            </View>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <Text style={s.optTitle}>Send Document Directly</Text>
                <View style={[s.badge, { backgroundColor: `${C.direct}18`, borderColor: `${C.direct}33` }]}>
                  <Text style={[s.badgeText, { color: C.direct }]}>SIMPLE</Text>
                </View>
              </View>
              <Text style={s.subText}>Direct email attachment · No code needed · AES-256</Text>
            </View>
            <Text style={{ color: 'rgba(255,255,255,0.2)', fontSize: 18 }}>›</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // -- Compose screen ------------------------------------
  return (
    <SafeAreaView style={s.root}>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <TouchableOpacity onPress={() => setDropType(null)} style={{ marginBottom: 16 }}>
          <Text style={{ color: color, fontSize: 15 }}>? Back</Text>
        </TouchableOpacity>

        <Text style={[s.heading, { color }]}>
          {dropType === 'link' ? '?? Secure Link + Code' : '?? Send Document Directly'}
        </Text>
        <Text style={[s.subText, { marginBottom: 20 }]}>
          {dropType === 'link' ? 'Double-layer security · email + code' : 'Direct email attachment · no code needed'}
        </Text>

        <Text style={s.label}>SELECT FILE</Text>
        <TouchableOpacity
          style={[s.card, { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16 }]}
          onPress={pickFile}
        >
          <Text style={{ fontSize: 22 }}>??</Text>
          <Text style={{ flex: 1, color: pickedFile ? '#fff' : C.sub, fontSize: 13 }}>
            {pickedFile ? pickedFile.name : 'Tap to choose file…'}
          </Text>
          {pickedFile && <Text style={{ color }}>?</Text>}
        </TouchableOpacity>

        <Text style={s.label}>RECIPIENT EMAIL</Text>
        <TextInput
          style={s.input}
          value={email}
          onChangeText={setEmail}
          placeholder="recipient@email.com"
          placeholderTextColor={C.sub}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
        />

        {dropType === 'link' && (
          <View style={[s.card, { borderColor: `${C.link}22`, marginBottom: 16, flexDirection: 'row', gap: 10, alignItems: 'center' }]}>
            <Text style={{ fontSize: 18 }}>??</Text>
            <View style={{ flex: 1 }}>
              <Text style={s.label}>8-DIGIT CODE AUTO-GENERATED ON SEND</Text>
              <Text style={{ color: C.link, fontSize: 11, fontWeight: '700' }}>
                Share verbally with recipient to unlock
              </Text>
            </View>
          </View>
        )}

        <TouchableOpacity
          style={[s.btnPrimary, { backgroundColor: pickedFile && email.trim() ? color : 'rgba(255,255,255,0.06)' }]}
          onPress={dropType === 'link' ? sendLink : sendDirect}
          disabled={!pickedFile || !email.trim()}
        >
          <Text style={[s.btnText, { color: pickedFile && email.trim() ? '#fff' : C.sub }]}>
            {dropType === 'link' ? '?? Send Link + Code' : '?? Send Document'}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:         { flex: 1, backgroundColor: C.bg },
  heading:      { fontSize: 22, fontWeight: '900', color: C.text, marginBottom: 6 },
  subText:      { fontSize: 12, color: C.sub, lineHeight: 18 },
  label:        { fontSize: 9, fontWeight: '700', color: 'rgba(255,255,255,0.3)', letterSpacing: 2, marginBottom: 8 },
  card:         { backgroundColor: C.card, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: C.border, marginBottom: 10 },
  optCard:      { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 16,
                  backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, marginBottom: 10 },
  optIcon:      { width: 48, height: 48, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  optTitle:     { fontSize: 14, fontWeight: '800', color: C.text },
  badge:        { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5, borderWidth: 1 },
  badgeText:    { fontSize: 8, fontWeight: '700' },
  input:        { backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 12, borderWidth: 1,
                  borderColor: 'rgba(255,255,255,0.1)', color: C.text, padding: 13, fontSize: 13, marginBottom: 14 },
  btnPrimary:   { backgroundColor: '#1D4ED8', borderRadius: 14, padding: 14, alignItems: 'center', marginBottom: 10 },
  btnText:      { color: '#fff', fontSize: 14, fontWeight: '800' },
  code8:        { fontSize: 32, fontWeight: '900', letterSpacing: 10, textAlign: 'center',
                  fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace', marginVertical: 8 },
  progressTrack:{ width: 220, height: 5, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 3, overflow: 'hidden', marginBottom: 8 },
  progressFill: { height: '100%' as any, backgroundColor: '#4A9FFF', borderRadius: 3 },
});
