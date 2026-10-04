// app/verify-contact.tsx — Verify safety number (#101).
//
// Shows the 60-digit safety number derived from both parties' public identity
// keys. If it matches what the contact sees on their device (scanned as a QR
// code side by side, read aloud, or copied over a different channel), there is
// no man-in-the-middle. The "verified" decision is the user's own and is
// persisted (synced across their devices). It holds only for the number that
// was verified: this device records a hash of it (lib/keyChange), and when the
// number changes the screen says so and treats the contact as not verified.

import { HEADER_TOP } from '../constants/layout';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Modal, Platform, ScrollView, StyleSheet, ToastAndroid, TouchableOpacity, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import QRCode from 'react-native-qrcode-svg';
import { QR_COLORS } from '../constants/qrPalette';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { AuroraDark, type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { getCachedUser } from '../lib/api';
import { computeSafetyNumber, formatSafetyNumber } from '../services/security/safetyNumber';
import {
  fetchIdentityKey, getVerifiedContacts, safetyFingerprint, setContactVerified, verificationStatus,
} from '../lib/verification';
import {
  acknowledgeKeyChange, checkKeyChange, getVerifiedFingerprint, setVerifiedFingerprint, type KeyChange,
} from '../lib/keyChange';
import { AuroraBackground } from '../components/ui';
import { AppText as Text } from '../components/ui/Text';
import { copyAndAutoClear } from '../lib/clipboardSafe';
import { compareSafetyQr, safetyQrPayload } from '../lib/safetyQr';
import { permissionDenied } from '../lib/permissionDenied';
import { userErrorText } from '../lib/userErrorText';

type State =
  | { kind: 'loading' }
  | { kind: 'unavailable'; reason: string; retryable: boolean }
  | { kind: 'ready'; number: string };

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function VerifyContactScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const params = useLocalSearchParams();
  const peerId = (params.peerId as string) || '';
  const peerName = (params.peerName as string) || 'this contact';

  const [state, setState] = useState<State>({ kind: 'loading' });
  const [verified, setVerified] = useState(false);
  // Verified before, but for a different safety number than the one shown now.
  const [codeChanged, setCodeChanged] = useState(false);
  // An unacknowledged key-change banner for this peer; re-verifying clears it.
  const keyChange = useRef<KeyChange | null>(null);
  // The verified list could not be read: "not verified" below is unknown, not a fact.
  const [statusUnknown, setStatusUnknown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [camPerm, requestCamPerm] = useCameraPermissions();
  // One result per scanner opening: the camera reports the same code many times a second.
  const scanned = useRef(false);
  // The key fetches can settle after Back.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    const set = (next: State) => { if (alive.current) setState(next); };
    try {
      const me = await getCachedUser();
      const myId = me?.id;
      if (!myId || !peerId) { set({ kind: 'unavailable', reason: 'Missing account or contact.', retryable: false }); return; }

      const [myKey, peerKey, verifiedRead, recorded, change] = await Promise.all([
        fetchIdentityKey(myId),
        fetchIdentityKey(peerId),
        getVerifiedContacts().catch(() => null),
        getVerifiedFingerprint(peerId).catch(() => null),
        checkKeyChange(peerId),
      ]);
      if (!alive.current) return;

      if (!myKey) { set({ kind: 'unavailable', reason: 'Your encryption keys aren’t published yet. Open a chat once to set up E2EE, then try again.', retryable: true }); return; }
      if (!peerKey) { set({ kind: 'unavailable', reason: `${peerName} hasn’t set up end-to-end encryption yet, so there’s no safety number to compare.`, retryable: true }); return; }

      const number = computeSafetyNumber(myId, myKey, peerId, peerKey);
      const fp = safetyFingerprint(number);
      const verifiedList = verifiedRead ?? [];
      const status = verificationStatus(verifiedList.includes(peerId), recorded, fp, change != null);
      setStatusUnknown(verifiedRead === null);
      // A verification with no recorded number (older, or from another device)
      // that still holds is bound to today's number from now on.
      if (status === 'verified' && !recorded) setVerifiedFingerprint(peerId, fp).catch(() => {});
      keyChange.current = change;
      setVerified(status === 'verified');
      setCodeChanged(status === 'changed');
      set({ kind: 'ready', number });
    } catch (e: unknown) {
      set({ kind: 'unavailable', reason: userErrorText(e, 'Could not load the safety number.'), retryable: true });
    }
  }, [peerId, peerName]);

  useEffect(() => { load(); }, [load]);

  const toggleVerified = useCallback(async () => {
    if (saving || state.kind !== 'ready') return;
    const next = !verified;
    setSaving(true);
    setVerified(next);
    try {
      await setContactVerified(peerId, next);
      // Bind the decision to the number on screen (or forget it). Local only:
      // the server keeps just the flag, so other devices bind on their next visit.
      await setVerifiedFingerprint(peerId, next ? safetyFingerprint(state.number) : null).catch(() => {});
      if (next) {
        setCodeChanged(false);
        // The new number is verified, so the chat's "security code changed"
        // banner has been dealt with.
        const change = keyChange.current;
        keyChange.current = null;
        if (change) await acknowledgeKeyChange(change.peerId, change.currentHex);
      }
    } catch (e: unknown) {
      if (alive.current) setVerified(!next); // revert on failure
      Alert.alert('Could not save', userErrorText(e, 'Try again.'));
    } finally {
      if (alive.current) setSaving(false);
    }
  }, [saving, verified, peerId, state]);

  // Copy for comparing over a trusted text channel; the clipboard clears itself.
  const copyNumber = useCallback(async (n: string) => {
    try {
      await copyAndAutoClear(formatSafetyNumber(n));
      if (Platform.OS === 'android') ToastAndroid.show('Safety number copied', ToastAndroid.SHORT);
      else Alert.alert('Copied', 'The safety number was copied. It is cleared from the clipboard shortly.');
    } catch {
      Alert.alert('Could not copy', 'Try again.');
    }
  }, []);

  // Scan the contact's code: both devices show the same number, so their QR
  // must equal ours. A match offers to mark verified; it never does so itself.
  const openScanner = useCallback(async () => {
    const p = camPerm?.granted ? camPerm : await requestCamPerm();
    if (!p.granted) {
      permissionDenied('Camera needed', `Allow camera access to scan ${peerName}’s code.`, p.canAskAgain);
      return;
    }
    scanned.current = false;
    setScanOpen(true);
  }, [camPerm, requestCamPerm, peerName]);

  const onScanned = useCallback(({ data }: { data: string }) => {
    if (scanned.current || state.kind !== 'ready') return;
    scanned.current = true;
    setScanOpen(false);
    const result = compareSafetyQr(data, state.number);
    if (result === 'match') {
      Alert.alert('Numbers match', `${peerName}’s safety number is the same as yours.`, verified
        ? [{ text: 'OK' }]
        : [{ text: 'Not now', style: 'cancel' }, { text: 'Mark as verified', onPress: () => { toggleVerified(); } }]);
    } else if (result === 'mismatch') {
      Alert.alert('Numbers don’t match',
        `This is not the safety number your device has for ${peerName}. Their keys may have changed, or this is someone else’s code. Don’t mark this contact as verified.`);
    } else {
      Alert.alert('Not a safety-number code', `Ask ${peerName} to open Verify for your chat and show the QR code there.`);
    }
  }, [state, peerName, verified, toggleVerified]);

  return (
    <View style={S.container}>
      <AuroraBackground />
      <View style={S.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} hitSlop={10} style={S.backBtn}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <Text style={[S.title, { flexShrink: 1, textAlign: 'center' }]} numberOfLines={1} accessibilityRole="header">Verify {peerName}</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
        {state.kind === 'loading' && (
          <View style={S.center}><ActivityIndicator color={colors.primary} /></View>
        )}

        {state.kind === 'unavailable' && (
          <View style={S.card}>
            <Ionicons name="information-circle" size={28} color={colors.textDim} />
            <Text style={S.unavailable}>{state.reason}</Text>
            {state.retryable && (
              <TouchableOpacity onPress={load} accessibilityRole="button" accessibilityLabel="Try again" style={S.retryBtn}>
                <Text style={S.retryTxt}>Try again</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {state.kind === 'ready' && (
          <>
            <View style={S.card}>
              <Text style={S.numberLabel}>Safety number</Text>
              {/* Read in five-digit groups, not as one 60-digit number. */}
              <Text style={S.number} accessibilityLabel={`Safety number: ${formatSafetyNumber(state.number).split(/\s+/).join(', ')}`}>{formatSafetyNumber(state.number)}</Text>
              {showQr && (
                <View style={S.qrBox} accessible accessibilityRole="image" accessibilityLabel="Your safety number as a QR code">
                  <QRCode value={safetyQrPayload(state.number)} size={200} {...QR_COLORS} />
                </View>
              )}
              <View style={S.cardBtns}>
                <TouchableOpacity onPress={() => copyNumber(state.number)} style={S.copyBtn} accessibilityRole="button" accessibilityLabel="Copy safety number">
                  <Ionicons name="copy-outline" size={16} color={colors.primary} />
                  <Text style={S.copyTxt}>Copy</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setShowQr(v => !v)} style={S.copyBtn} accessibilityRole="button"
                  accessibilityLabel={showQr ? 'Hide QR code' : 'Show QR code'} accessibilityState={{ expanded: showQr }}>
                  <Ionicons name="qr-code-outline" size={16} color={colors.primary} />
                  <Text style={S.copyTxt}>{showQr ? 'Hide QR' : 'Show QR'}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={openScanner} style={S.copyBtn} accessibilityRole="button" accessibilityLabel={`Scan ${peerName}’s code`}>
                  <Ionicons name="scan-outline" size={16} color={colors.primary} />
                  <Text style={S.copyTxt}>Scan</Text>
                </TouchableOpacity>
              </View>
            </View>

            <Text style={S.explain}>
              Compare this 60-digit number with {peerName}: in person, show your QR code and scan
              theirs; otherwise read it aloud, or copy it to them over a different app or channel
              (not this chat — a pasted number here proves nothing). If it matches on both devices, your conversation is
              not being intercepted. If the numbers ever differ, the keys changed — do not trust
              the chat until you re-verify.
            </Text>

            {statusUnknown && (
              <TouchableOpacity style={S.changed} onPress={load} accessibilityRole="button" accessibilityLiveRegion="polite"
                accessibilityLabel={`Couldn't load whether you verified ${peerName}. Tap to try again`}>
                <Ionicons name="cloud-offline-outline" size={18} color={colors.textDim} />
                <Text style={S.changedTxt}>
                  Couldn’t load whether you verified {peerName}, so the button below may be out of date. Tap to try again.
                </Text>
              </TouchableOpacity>
            )}

            {codeChanged && (
              <View style={S.changed} accessibilityLiveRegion="polite">
                <Ionicons name="warning-outline" size={18} color={colors.warning} />
                <Text style={S.changedTxt}>
                  Not verified — the security code changed since you verified {peerName}. Compare the new
                  number above, then mark as verified again.
                </Text>
              </View>
            )}

            <TouchableOpacity
              style={[S.verifyBtn, verified ? S.verifyBtnOn : S.verifyBtnOff]}
              onPress={toggleVerified}
              disabled={saving}
              activeOpacity={0.85}
              accessibilityRole="switch"
              accessibilityLabel="Mark as verified"
              accessibilityState={{ checked: verified, busy: saving, disabled: saving }}
            >
              {saving ? (
                <ActivityIndicator size="small" color={verified ? colors.onPrimary : colors.primary} />
              ) : (
                <>
                  <Ionicons
                    name={verified ? 'shield-checkmark' : 'shield-outline'}
                    size={18}
                    color={verified ? colors.onPrimary : colors.primary}
                  />
                  <Text style={[S.verifyBtnText, { color: verified ? colors.onPrimary : colors.primary }]}>
                    {verified ? 'Verified — tap to clear' : 'Mark as verified'}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </>
        )}
      </ScrollView>

      {/* Scanner: a camera viewfinder, always dark. */}
      <Modal visible={scanOpen} animationType="slide" onRequestClose={() => setScanOpen(false)}>
        <View style={S.scanWrap}>
          <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={scanOpen ? onScanned : undefined} />
          <View style={S.scanFrame} pointerEvents="none" />
          <Text style={S.scanHint}>Point the camera at the QR code on {peerName}’s Verify screen</Text>
          <TouchableOpacity onPress={() => setScanOpen(false)} style={S.scanClose} accessibilityRole="button" accessibilityLabel="Close scanner">
            <Ionicons name="close" size={28} color={AuroraDark.text} />
          </TouchableOpacity>
        </View>
      </Modal>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: HEADER_TOP, paddingBottom: 12, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: c.glassStroke },
  title: { color: c.text, fontSize: 17, fontWeight: '800' },
  backBtn: { width: 44, height: 44, justifyContent: 'center' },
  copyBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: 14 },
  cardBtns: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
  // The code itself is dark-on-white in both themes (scanners need that); this
  // is only the frame around it.
  qrBox: { padding: 12, borderRadius: 12, backgroundColor: c.card },
  scanWrap: { flex: 1, backgroundColor: AuroraDark.bg, alignItems: 'center', justifyContent: 'center' },
  scanFrame: { width: 250, height: 250, borderWidth: 2, borderColor: c.primary, borderRadius: 20 },
  scanHint: { color: AuroraDark.text, fontSize: 14, fontWeight: '600', marginTop: 20, paddingHorizontal: 32, textAlign: 'center' },
  scanClose: { position: 'absolute', top: HEADER_TOP, right: 16, width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  copyTxt: { color: c.primary, fontSize: 14, fontWeight: '700' },
  center: { paddingVertical: 60, alignItems: 'center' },

  card: { backgroundColor: c.glassSoft, borderRadius: 16, borderWidth: 1, borderColor: c.glassStroke, padding: 20, alignItems: 'center', gap: 10 },
  numberLabel: { color: c.textFaint, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  number: { color: c.text, fontSize: 22, fontWeight: '700', letterSpacing: 2, textAlign: 'center', lineHeight: 34, fontVariant: ['tabular-nums'] },

  explain: { color: c.textDim, fontSize: 13.5, lineHeight: 20, marginTop: 18, marginBottom: 22 },

  verifyBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 15, borderRadius: 14, borderWidth: 1 },
  verifyBtnOn: { backgroundColor: c.primary, borderColor: c.primary },
  verifyBtnOff: { backgroundColor: 'transparent', borderColor: c.primary },
  verifyBtnText: { fontSize: 15, fontWeight: '800' },

  unavailable: { color: c.textDim, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  retryBtn: { padding: 10, minHeight: 44, justifyContent: 'center' },
  retryTxt: { color: c.primary, fontWeight: '700' },
  changed: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 12, marginBottom: 14, borderRadius: 12, borderWidth: 1, borderColor: c.warning, backgroundColor: c.glassSoft },
  changedTxt: { flex: 1, color: c.text, fontSize: 13.5, lineHeight: 19 },
});
