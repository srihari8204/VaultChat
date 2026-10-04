// app/qr-contact.tsx — QR Code Add Contact (Postgres-backed).
//
// "My QR" renders your VaultID (GET /user/profile → vaultId) as a QR.
// "Scan" reads a crazzychat QR, resolves the handle (GET /user/by-vault/:id),
// and opens/creates a direct chat (POST /chats). No Firestore.

import { HEADER_TOP } from '../constants/layout';
import { brandAlpha, type Palette } from '../constants/theme';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { View, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, Share, Linking } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import QRCode from 'react-native-qrcode-svg';
import { QR_COLORS, QR_SCAN_OVERLAY } from '../constants/qrPalette';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useTheme } from '../lib/theme';
import { getMyProfile, resolveVaultId, createDirectChat } from '../lib/chatService';
import { AuroraBackground } from '../components/ui';
import { AppText as Text } from '../components/ui/Text';
import { parseVaultIdPayload } from '../lib/vaultIdLink';
import { userErrorText } from '../lib/userErrorText';

const errStatus = (e: unknown) => (e as { status?: number } | null)?.status;

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function QRContactScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const [tab, setTab] = useState<'my' | 'scan'>('my');
  const [myVaultId, setMyVaultId] = useState('');
  const [myName, setMyName] = useState('crazzychat User');
  const [loading, setLoading] = useState(true);
  // getMyProfile failed: "No VaultID yet" would be a false statement.
  const [loadError, setLoadError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [processing, setProcessing] = useState(false);
  // A resolved code waiting for "Open chat" — shown in the scan tab, like /add's confirm.
  const [found, setFound] = useState<{ userId: string; name: string; vaultId: string } | null>(null);
  // A scan that found no one to add, shown in the same card as a match. The
  // camera stays paused until "Scan again" (an Alert re-armed it at once, so
  // the same code fired the same Alert over and over).
  const [scanMsg, setScanMsg] = useState<{ title: string; body: string } | null>(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError('');
    (async () => {
      try {
        const p = await getMyProfile();
        if (active) { setMyVaultId(p.vaultId || ''); setMyName(p.name || 'crazzychat User'); }
      } catch (e: unknown) {
        if (active) setLoadError(userErrorText(e, 'Could not load your VaultID.'));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [reloadKey]);

  const qrData = `vaultchat://add/${myVaultId}/${encodeURIComponent(myName)}`;

  const handleShare = async () => {
    if (!myVaultId) return;
    try {
      await Share.share({
        message: `Add me on crazzychat! My VaultID: @${myVaultId}\nhttps://vaultchat.app/add/${myVaultId}`,
      });
    } catch { /* user cancelled */ }
  };


  const handleScan = useCallback(async ({ data }: { data: string }) => {
    if (scanned || processing) return;
    setScanned(true);
    setProcessing(true);
    try {
      // Only our own payloads (lib/vaultIdLink.ts); any other QR is "not ours".
      const vaultId = parseVaultIdPayload(data);
      if (!vaultId) { setScanMsg({ title: 'Not a crazzychat code', body: 'This QR code isn’t a crazzychat contact code.' }); return; }
      if (vaultId === myVaultId) { setScanMsg({ title: 'That’s you', body: 'That’s your own QR code. Scan someone else’s.' }); return; }

      const peer = await resolveVaultId(vaultId);
      setFound({ userId: peer.userId, name: peer.name || vaultId, vaultId: peer.vaultId || vaultId });
    } catch (e: unknown) {
      // Only a 404 means "no such user"; anything else (offline, a server
      // error) must not tell the user the code is wrong. Same split as /add.
      if (errStatus(e) === 404) setScanMsg({ title: 'Not found', body: 'No crazzychat user with that ID.' });
      else setScanMsg({ title: 'Couldn’t look up this code', body: `${userErrorText(e, 'Check your connection.')} Try scanning again.` });
    } finally {
      setProcessing(false);
    }
  }, [scanned, processing, myVaultId]);

  const cancelFound = () => { setFound(null); setScanned(false); };
  const scanAgain = () => { setScanMsg(null); setScanned(false); };
  const openFound = async () => {
    if (!found || opening) return;
    setOpening(true);
    try {
      const { id } = await createDirectChat({ userId: found.userId });
      router.replace({ pathname: '/chat', params: { id, peerUid: found.userId, peerName: found.name } });
    } catch (e: unknown) {
      Alert.alert('Couldn’t start the chat', userErrorText(e, 'Try again.'));
      setOpening(false);
    }
  };

  return (
    <View style={s.container}>
      <AuroraBackground />

      <View style={s.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={s.backBtn} hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.title} accessibilityRole="header">QR Contact</Text>
        <View style={{ width: 44 }} />
      </View>

      <View style={s.tabs} accessibilityRole="tablist">
        <TouchableOpacity style={[s.tab, tab === 'my' && s.tabActive]} onPress={() => setTab('my')}
          accessibilityRole="tab" accessibilityState={{ selected: tab === 'my' }}>
          <Text style={[s.tabTxt, tab === 'my' && s.tabTxtActive]}>My QR</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.tab, tab === 'scan' && s.tabActive]} onPress={() => { setTab('scan'); setScanned(false); setFound(null); setScanMsg(null); }}
          accessibilityRole="tab" accessibilityState={{ selected: tab === 'scan' }}>
          <Text style={[s.tabTxt, tab === 'scan' && s.tabTxtActive]}>Scan</Text>
        </TouchableOpacity>
      </View>

      {tab === 'my' ? (
        <View style={s.myQR}>
          {loading ? (
            <ActivityIndicator color={colors.primary} size="large" />
          ) : loadError ? (
            <View style={s.noPerm}>
              <Ionicons name="cloud-offline-outline" size={40} color={colors.textDim} />
              <Text style={s.noPermTxt}>Couldn’t load your QR code. {loadError}</Text>
              <TouchableOpacity style={s.shareBtn} onPress={() => setReloadKey(k => k + 1)} accessibilityRole="button">
                <Text style={s.shareTxt}>Try again</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <View style={s.qrCard}>
                <Text style={s.qrName}>{myName}</Text>
                <Text style={s.qrId}>@{myVaultId || '…'}</Text>
                <View style={s.qrBox} accessible={!!myVaultId} accessibilityRole="image" accessibilityLabel={myVaultId ? `Your QR code, VaultID ${myVaultId}` : undefined}>
                  {myVaultId
                    ? <QRCode value={qrData} size={200} {...QR_COLORS} quietZone={20} />
                    : <Text style={{ color: colors.textDim }}>No VaultID yet</Text>}
                </View>
                <Text style={s.qrHint}>Show this to add you on crazzychat</Text>
              </View>
              <TouchableOpacity style={[s.shareBtn, { flexDirection: 'row', alignItems: 'center', gap: 8 }]} onPress={handleShare} disabled={!myVaultId}
                accessibilityRole="button" accessibilityState={{ disabled: !myVaultId }}>
                <Ionicons name="share-outline" size={16} color={colors.primary} />
                <Text style={s.shareTxt}>Share my VaultID</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      ) : (
        <View style={s.scanArea}>
          {!permission ? (
            <ActivityIndicator color={colors.primary} size="large" style={{ flex: 1 }} />
          ) : !permission.granted ? (
            <View style={s.noPerm}>
              <Text style={s.noPermTxt}>Camera permission is required to scan QR codes.</Text>
              {/* A permanent denial cannot re-prompt; send the user to Settings. */}
              <TouchableOpacity style={s.shareBtn} accessibilityRole="button"
                onPress={permission.canAskAgain ? requestPermission : () => { Linking.openSettings().catch(() => {}); }}>
                <Text style={s.shareTxt}>{permission.canAskAgain ? 'Grant Permission' : 'Open settings'}</Text>
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
                <Text style={s.scanHint}>{processing ? 'Processing…' : 'Point camera at a crazzychat QR code'}</Text>
              </View>
              {found ? (
                <View style={s.foundCard} accessibilityViewIsModal accessibilityLiveRegion="polite">
                  <Text style={s.foundTitle} accessibilityRole="header">Contact found</Text>
                  <Text style={s.foundSub}>Start a chat with {found.name} (@{found.vaultId})?</Text>
                  <TouchableOpacity style={[s.foundBtn, opening && s.dim]} onPress={openFound} disabled={opening}
                    accessibilityRole="button" accessibilityLabel={`Open chat with ${found.name}`}
                    accessibilityState={{ busy: opening, disabled: opening }}>
                    {opening ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={s.foundBtnTxt}>Open chat</Text>}
                  </TouchableOpacity>
                  <TouchableOpacity style={s.foundGhost} onPress={cancelFound} disabled={opening}
                    accessibilityRole="button" accessibilityLabel="Cancel and scan again" accessibilityState={{ disabled: opening }}>
                    <Text style={s.foundGhostTxt}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              ) : scanMsg ? (
                <View style={s.foundCard} accessibilityLiveRegion="polite">
                  <Text style={s.foundTitle} accessibilityRole="header">{scanMsg.title}</Text>
                  <Text style={s.foundSub}>{scanMsg.body}</Text>
                  <TouchableOpacity style={s.foundBtn} onPress={scanAgain} accessibilityRole="button">
                    <Text style={s.foundBtnTxt}>Scan again</Text>
                  </TouchableOpacity>
                </View>
              ) : scanned && !processing && (
                <TouchableOpacity style={[s.shareBtn, s.scanAgain]} onPress={() => setScanned(false)} accessibilityRole="button">
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

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: HEADER_TOP, paddingHorizontal: 16, paddingBottom: 12 },
  backBtn: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
  title: { color: c.text, fontSize: 18, fontWeight: '800' },
  tabs: { flexDirection: 'row', marginHorizontal: 16, backgroundColor: c.glassSoft, borderRadius: 12, padding: 3, borderWidth: 1, borderColor: c.glassStroke },
  tab: { flex: 1, paddingVertical: 10, minHeight: 44, justifyContent: 'center', alignItems: 'center', borderRadius: 10 },
  tabActive: { backgroundColor: c.primary },
  tabTxt: { color: c.textDim, fontSize: 14, fontWeight: '700' },
  tabTxtActive: { color: c.onPrimary },
  myQR: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  qrCard: { backgroundColor: c.glassSoft, borderRadius: 24, padding: 32, alignItems: 'center', width: '100%', maxWidth: 320, borderWidth: 1, borderColor: c.glassStroke },
  qrName: { color: c.text, fontSize: 20, fontWeight: '900', marginBottom: 4 },
  qrId: { color: c.accent, fontSize: 14, marginBottom: 20, fontWeight: '700' },
  // The QR draws its own white quiet zone (quietZone={20}, about 3-4 modules):
  // this box is the theme's surface, dark in dark mode, and scanners need light round the code.
  qrBox: { padding: 12, backgroundColor: c.glassSoft, borderRadius: 12, minWidth: 224, minHeight: 224, alignItems: 'center', justifyContent: 'center' },
  qrHint: { color: c.textDim, fontSize: 12, marginTop: 16, textAlign: 'center' },
  shareBtn: { marginTop: 24, backgroundColor: brandAlpha(0.13), borderRadius: 14, paddingVertical: 14, paddingHorizontal: 28, borderWidth: 1, borderColor: brandAlpha(0.3) },
  shareTxt: { color: c.primary, fontSize: 14, fontWeight: '700' },
  scanArea: { flex: 1, position: 'relative', marginTop: 12 },
  scanner: { flex: 1 },
  scanOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', alignItems: 'center' },
  scanFrame: { width: 250, height: 250, borderWidth: 2, borderColor: c.primary, borderRadius: 20, backgroundColor: 'transparent' },
  scanHint: { color: QR_SCAN_OVERLAY.ink, fontSize: 14, marginTop: 20, textAlign: 'center', fontWeight: '600', textShadowColor: QR_SCAN_OVERLAY.shadow, textShadowRadius: 4 },
  scanAgain: { position: 'absolute', bottom: 40, alignSelf: 'center' },
  foundCard: { position: 'absolute', left: 16, right: 16, bottom: 32, padding: 20, gap: 8, borderRadius: 20, alignItems: 'center', backgroundColor: c.surfaceSolid, borderWidth: 1, borderColor: c.glassStroke },
  foundTitle: { color: c.text, fontSize: 18, fontWeight: '800', textAlign: 'center' },
  foundSub: { color: c.textDim, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  foundBtn: { alignSelf: 'stretch', marginTop: 8, minHeight: 48, borderRadius: 12, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  foundBtnTxt: { color: c.onPrimary, fontSize: 15, fontWeight: '700' },
  foundGhost: { minHeight: 44, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center' },
  foundGhostTxt: { color: c.textDim, fontSize: 15, fontWeight: '600' },
  dim: { opacity: 0.6 },
  noPerm: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  noPermTxt: { color: c.textDim, fontSize: 15, textAlign: 'center', marginBottom: 20 },
});
