// app/qr-contact.tsx — QR Code Add Contact (Postgres-backed).
//
// "My QR" renders your VaultID (GET /user/profile → vaultId) as a QR.
// "Scan" reads a VaultChat QR, resolves the handle (GET /user/by-vault/:id),
// and opens/creates a direct chat (POST /chats). No Firestore.

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Alert, StatusBar, ActivityIndicator, Share,
} from 'react-native';
import { useRouter } from 'expo-router';
import QRCode from 'react-native-qrcode-svg';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Aurora } from '../constants/theme';
import { getMyProfile, resolveVaultId, createDirectChat } from '../lib/chatService';

export default function QRContactScreen() {
  const router = useRouter();
  const [tab, setTab] = useState<'my' | 'scan'>('my');
  const [myVaultId, setMyVaultId] = useState('');
  const [myName, setMyName] = useState('VaultChat User');
  const [loading, setLoading] = useState(true);
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const p = await getMyProfile();
        if (active) { setMyVaultId(p.vaultId || ''); setMyName(p.name || 'VaultChat User'); }
      } catch { /* header still renders */ } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const qrData = `vaultchat://add/${myVaultId}/${encodeURIComponent(myName)}`;

  const handleShare = async () => {
    if (!myVaultId) return;
    try {
      await Share.share({
        message: `Add me on VaultChat! My VaultID: @${myVaultId}\nhttps://vaultchat.app/add/${myVaultId}`,
      });
    } catch { /* user cancelled */ }
  };

  const parseVaultId = (data: string): string => {
    if (data.startsWith('vaultchat://add/')) return data.replace('vaultchat://add/', '').split('/')[0];
    if (data.includes('/add/')) return data.split('/add/')[1].split('/')[0];
    if (data.startsWith('@')) return data.slice(1);
    return data.trim();
  };

  const handleScan = useCallback(async ({ data }: { data: string }) => {
    if (scanned || processing) return;
    setScanned(true);
    setProcessing(true);
    try {
      const vaultId = parseVaultId(data);
      if (!vaultId) { Alert.alert('Invalid', 'Not a VaultChat QR code.'); setScanned(false); return; }
      if (vaultId === myVaultId) { Alert.alert('That’s you', "That's your own QR code!"); setScanned(false); return; }

      const peer = await resolveVaultId(vaultId);
      Alert.alert('Contact found', `${peer.name || vaultId} (@${peer.vaultId})`, [
        { text: 'Cancel', onPress: () => setScanned(false) },
        {
          text: 'Open chat',
          onPress: async () => {
            try {
              const { id } = await createDirectChat({ userId: peer.userId });
              router.replace({ pathname: '/chat', params: { id, peerUid: peer.userId, peerName: peer.name || vaultId } } as any);
            } catch (e: any) {
              Alert.alert('Error', e?.message ?? 'Could not start chat');
              setScanned(false);
            }
          },
        },
      ]);
    } catch (e: any) {
      Alert.alert('Not found', e?.message ?? 'No VaultChat user with that ID.');
      setScanned(false);
    } finally {
      setProcessing(false);
    }
  }, [scanned, processing, myVaultId, router]);

  return (
    <View style={s.container}>
      <StatusBar barStyle="light-content" />

      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={10}>
          <Text style={{ color: Aurora.text, fontSize: 24 }}>←</Text>
        </TouchableOpacity>
        <Text style={s.title}>QR Contact</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={s.tabs}>
        <TouchableOpacity style={[s.tab, tab === 'my' && s.tabActive]} onPress={() => setTab('my')}>
          <Text style={[s.tabTxt, tab === 'my' && s.tabTxtActive]}>My QR</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.tab, tab === 'scan' && s.tabActive]} onPress={() => { setTab('scan'); setScanned(false); }}>
          <Text style={[s.tabTxt, tab === 'scan' && s.tabTxtActive]}>Scan</Text>
        </TouchableOpacity>
      </View>

      {tab === 'my' ? (
        <View style={s.myQR}>
          {loading ? (
            <ActivityIndicator color={Aurora.primary} size="large" />
          ) : (
            <>
              <View style={s.qrCard}>
                <Text style={s.qrName}>{myName}</Text>
                <Text style={s.qrId}>@{myVaultId || '…'}</Text>
                <View style={s.qrBox}>
                  {myVaultId
                    ? <QRCode value={qrData} size={200} backgroundColor="#FFFFFF" color="#0A0A0F" />
                    : <Text style={{ color: '#888' }}>No VaultID yet</Text>}
                </View>
                <Text style={s.qrHint}>Show this to add you on VaultChat</Text>
              </View>
              <TouchableOpacity style={s.shareBtn} onPress={handleShare} disabled={!myVaultId}>
                <Text style={s.shareTxt}>🔗  Share my VaultID</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      ) : (
        <View style={s.scanArea}>
          {!permission ? (
            <ActivityIndicator color={Aurora.primary} size="large" style={{ flex: 1 }} />
          ) : !permission.granted ? (
            <View style={s.noPerm}>
              <Text style={s.noPermTxt}>Camera permission is required to scan QR codes.</Text>
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
              <View style={s.scanOverlay} pointerEvents="none">
                <View style={s.scanFrame} />
                <Text style={s.scanHint}>{processing ? 'Processing…' : 'Point camera at a VaultChat QR code'}</Text>
              </View>
              {scanned && !processing && (
                <TouchableOpacity style={[s.shareBtn, { position: 'absolute', bottom: 40, alignSelf: 'center' }]} onPress={() => setScanned(false)}>
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
  container: { flex: 1, backgroundColor: Aurora.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 54, paddingHorizontal: 16, paddingBottom: 12 },
  backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  title: { color: Aurora.text, fontSize: 18, fontWeight: '800' },
  tabs: { flexDirection: 'row', marginHorizontal: 16, backgroundColor: Aurora.surface, borderRadius: 12, padding: 3, borderWidth: 1, borderColor: Aurora.border },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 10 },
  tabActive: { backgroundColor: Aurora.primary },
  tabTxt: { color: Aurora.textDim, fontSize: 14, fontWeight: '700' },
  tabTxtActive: { color: '#04130D' },
  myQR: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  qrCard: { backgroundColor: Aurora.card, borderRadius: 24, padding: 32, alignItems: 'center', width: '100%', maxWidth: 320, borderWidth: 1, borderColor: Aurora.border },
  qrName: { color: Aurora.text, fontSize: 20, fontWeight: '900', marginBottom: 4 },
  qrId: { color: Aurora.accent, fontSize: 14, marginBottom: 20, fontWeight: '700' },
  qrBox: { padding: 12, backgroundColor: '#FFFFFF', borderRadius: 12, minWidth: 224, minHeight: 224, alignItems: 'center', justifyContent: 'center' },
  qrHint: { color: Aurora.textDim, fontSize: 12, marginTop: 16, textAlign: 'center' },
  shareBtn: { marginTop: 24, backgroundColor: 'rgba(16,185,129,0.13)', borderRadius: 14, paddingVertical: 14, paddingHorizontal: 28, borderWidth: 1, borderColor: 'rgba(16,185,129,0.3)' },
  shareTxt: { color: Aurora.primary, fontSize: 14, fontWeight: '700' },
  scanArea: { flex: 1, position: 'relative', marginTop: 12 },
  scanner: { flex: 1 },
  scanOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', alignItems: 'center' },
  scanFrame: { width: 250, height: 250, borderWidth: 2, borderColor: Aurora.primary, borderRadius: 20, backgroundColor: 'transparent' },
  scanHint: { color: '#fff', fontSize: 14, marginTop: 20, textAlign: 'center', fontWeight: '600', textShadowColor: '#000', textShadowRadius: 4 },
  noPerm: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  noPermTxt: { color: Aurora.textDim, fontSize: 15, textAlign: 'center', marginBottom: 20 },
});
