// @ts-nocheck
// app/qr-contact.tsx — QR Code Add Contact
// Tab 1: "My QR" shows your VaultID as a QR code
// Tab 2: "Scan" uses expo-camera CameraView with barcode scanning

import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Alert,
  StatusBar, ActivityIndicator, Share,
} from 'react-native';
import { useRouter } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import QRCode from 'react-native-qrcode-svg';
import { CameraView, useCameraPermissions } from 'expo-camera';

const C = {
  bg: '#020B18', primary: '#4A9FFF', accent: '#00D4AA',
  card: 'rgba(10,22,40,0.88)', dim: 'rgba(255,255,255,0.45)',
};

export default function QRContactScreen() {
  const router = useRouter();
  const myUid = auth().currentUser?.uid || '';
  const [tab, setTab] = useState('my');
  const [myVaultId, setMyVaultId] = useState('');
  const [myName, setMyName] = useState('');
  const [loading, setLoading] = useState(true);
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const snap = await firestore().collection('users').doc(myUid).get();
        const d = snap.data();
        setMyVaultId(d?.vaultId || myUid.slice(0, 12));
        setMyName(d?.name || 'VaultChat User');
      } catch {}
      setLoading(false);
    })();
  }, [myUid]);

  const qrData = 'vaultchat://add/' + myVaultId + '/' + encodeURIComponent(myName);

  const handleShare = async () => {
    try {
      await Share.share({
        message: 'Add me on VaultChat! My VaultID: @' + myVaultId + '\nhttps://vaultchat.app/add/' + myVaultId,
      });
    } catch {}
  };

  const handleScan = async ({ data }) => {
    if (scanned || processing) return;
    setScanned(true);
    setProcessing(true);

    try {
      let vaultId = '';
      let scanName = '';

      if (data.startsWith('vaultchat://add/')) {
        const parts = data.replace('vaultchat://add/', '').split('/');
        vaultId = parts[0];
        scanName = decodeURIComponent(parts[1] || '');
      } else if (data.startsWith('@')) {
        vaultId = data.slice(1);
      } else {
        vaultId = data.trim();
      }

      if (!vaultId || vaultId === myVaultId) {
        Alert.alert('Invalid', vaultId === myVaultId ? "That's your own QR code!" : 'Invalid QR code');
        setScanned(false);
        setProcessing(false);
        return;
      }

      const snap = await firestore().collection('users').where('vaultId', '==', vaultId).get();

      if (snap.empty) {
        Alert.alert('Not Found', 'No VaultChat user with ID @' + vaultId);
        setScanned(false);
        setProcessing(false);
        return;
      }

      const peerDoc = snap.docs[0];
      const peer = peerDoc.data();
      const peerUid = peerDoc.id;
      const peerName = peer.name || scanName || vaultId;

      const chatId = [myUid, peerUid].sort().join('_');
      await firestore().collection('chats').doc(chatId).set({
        participants: [myUid, peerUid],
        createdAt: firestore.FieldValue.serverTimestamp(),
        lastTime: firestore.FieldValue.serverTimestamp(),
        lastMsg: '',
      }, { merge: true });

      Alert.alert(
        'Contact Found!',
        peerName + ' (@' + vaultId + ')',
        [
          { text: 'Cancel', onPress: () => { setScanned(false); setProcessing(false); } },
          {
            text: 'Open Chat',
            onPress: () => {
              router.replace({
                pathname: '/chat',
                params: { chatId, peerUid, peerName },
              });
            },
          },
        ]
      );
    } catch {
      Alert.alert('Error', 'Could not process QR code');
      setScanned(false);
    }
    setProcessing(false);
  };

  return (
    <View style={s.container}>
      <StatusBar barStyle="light-content" />

      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Text style={{ color: '#fff', fontSize: 24 }}>{"\u2190"}</Text>
        </TouchableOpacity>
        <Text style={s.title}>QR Contact</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={s.tabs}>
        <TouchableOpacity
          style={[s.tab, tab === 'my' && s.tabActive]}
          onPress={() => setTab('my')}
        >
          <Text style={[s.tabTxt, tab === 'my' && s.tabTxtActive]}>My QR</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.tab, tab === 'scan' && s.tabActive]}
          onPress={() => { setTab('scan'); setScanned(false); }}
        >
          <Text style={[s.tabTxt, tab === 'scan' && s.tabTxtActive]}>Scan</Text>
        </TouchableOpacity>
      </View>

      {tab === 'my' ? (
        <View style={s.myQR}>
          {loading ? (
            <ActivityIndicator color={C.accent} size="large" />
          ) : (
            <>
              <View style={s.qrCard}>
                <Text style={s.qrName}>{myName}</Text>
                <Text style={s.qrId}>@{myVaultId}</Text>
                <View style={s.qrBox}>
                  <QRCode
                    value={qrData}
                    size={200}
                    backgroundColor="#FFFFFF"
                    color="#020B18"
                  />
                </View>
                <Text style={s.qrHint}>Show this to add you on VaultChat</Text>
              </View>
              <TouchableOpacity style={s.shareBtn} onPress={handleShare}>
                <Text style={s.shareTxt}>{"\uD83D\uDD17  Share my VaultID"}</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      ) : (
        <View style={s.scanArea}>
          {!permission ? (
            <ActivityIndicator color={C.accent} size="large" style={{ flex: 1 }} />
          ) : !permission.granted ? (
            <View style={s.noPerm}>
              <Text style={s.noPermTxt}>Camera permission is required to scan QR codes</Text>
              <TouchableOpacity style={s.shareBtn} onPress={requestPermission}>
                <Text style={s.shareTxt}>Grant Permission</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <CameraView
                style={s.scanner}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={scanned ? undefined : handleScan}
              />
              <View style={s.scanOverlay}>
                <View style={s.scanFrame} />
                <Text style={s.scanHint}>
                  {processing ? 'Processing...' : 'Point camera at a VaultChat QR code'}
                </Text>
              </View>
              {scanned && !processing && (
                <TouchableOpacity
                  style={[s.shareBtn, { position: 'absolute', bottom: 40, alignSelf: 'center' }]}
                  onPress={() => setScanned(false)}
                >
                  <Text style={s.shareTxt}>Scan Again</Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 50, paddingHorizontal: 16, paddingBottom: 12 },
  backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  title: { color: '#fff', fontSize: 18, fontWeight: '800' },
  tabs: { flexDirection: 'row', marginHorizontal: 16, backgroundColor: '#0A1628', borderRadius: 12, padding: 3 },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 10 },
  tabActive: { backgroundColor: C.accent },
  tabTxt: { color: '#888', fontSize: 14, fontWeight: '700' },
  tabTxtActive: { color: '#000' },
  myQR: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  qrCard: { backgroundColor: '#fff', borderRadius: 24, padding: 32, alignItems: 'center', width: '100%', maxWidth: 320 },
  qrName: { color: '#020B18', fontSize: 20, fontWeight: '900', marginBottom: 4 },
  qrId: { color: '#666', fontSize: 14, marginBottom: 20 },
  qrBox: { padding: 12, backgroundColor: '#fff', borderRadius: 12 },
  qrHint: { color: '#999', fontSize: 12, marginTop: 16, textAlign: 'center' },
  shareBtn: { marginTop: 24, backgroundColor: C.accent + '22', borderRadius: 14, paddingVertical: 14, paddingHorizontal: 28, borderWidth: 1, borderColor: C.accent + '44' },
  shareTxt: { color: C.accent, fontSize: 14, fontWeight: '700' },
  scanArea: { flex: 1, position: 'relative' },
  scanner: { flex: 1 },
  scanOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', alignItems: 'center' },
  scanFrame: { width: 250, height: 250, borderWidth: 2, borderColor: C.accent, borderRadius: 20, backgroundColor: 'transparent' },
  scanHint: { color: '#fff', fontSize: 14, marginTop: 20, textAlign: 'center', fontWeight: '600', textShadowColor: '#000', textShadowRadius: 4 },
  noPerm: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  noPermTxt: { color: '#888', fontSize: 15, textAlign: 'center', marginBottom: 20 },
});
