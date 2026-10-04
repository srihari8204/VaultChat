// app/d2de-status.tsx
// Encryption status — which encryption layers THIS BUILD uses. The layer list
// is a readout of compile-time flags (services/d2deService.getD2DEStatus →
// E2EE_ENABLED), not a live check, and the copy says so. With E2EE on, the top
// card also sums up the direct chats' live safety states (lib/peerSafetySummary)
// and the screen links to a chosen chat's safety number (app/verify-contact);
// the picker shows each contact's state (verified, not verified, code changed,
// no E2EE yet), worked out as verify-contact does (lib/peerSafetyStatus).

import { AppText as Text, AuroraBackground } from '../components/ui';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, View, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { Sheet, type SheetAction } from '../components/ui/Sheet';
import { listChats } from '../lib/chatService';
import { getD2DEStatus } from '../services/d2deService';
import { E2EE_ENABLED } from '../constants/flags';
import { getCachedUser } from '../lib/api';
import { fetchIdentityKey, getVerifiedContacts, safetyFingerprint, verificationStatus } from '../lib/verification';
import { checkKeyChange, getVerifiedFingerprint } from '../lib/keyChange';
import { computeSafetyNumber } from '../services/security/safetyNumber';
import { forEachLimited, peerSafetyLabel, type PeerSafetyStatus } from '../lib/peerSafetyStatus';
import { peerSafetySummary } from '../lib/peerSafetySummary';

type Peer = { id: string; name: string };

// Keyed by the layer names services/d2deService.ts returns — a key that does
// not match leaves the card's explanation blank ('Android Keystore' vs
// 'Secure Keystore' did exactly that). Worded as what the build is MADE to do:
// this screen reads flags, it cannot observe the live connection or keystore.
const LAYER_INFO: Record<string, string> = {
  'TLS 1.3':           'This build is made to encrypt traffic between your device and crazzychat servers in transit.',
  'AES-256-GCM':       'Direct-chat messages are encrypted on your device before they are sent, so the server stores ciphertext it cannot read.',
  'Double Ratchet':    'A fresh key for every message gives forward secrecy: one exposed key does not unlock earlier messages.',
  'X3DH':              'Two devices agree on a shared secret from published prekeys without ever sending a private key.',
  'Secure Keystore':   'This build is made to keep your end-to-end keys in the operating system’s secure storage on this device.',
};

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function D2DEStatusScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const layers = getD2DEStatus();
  const active = layers.filter(l => l.active).length;

  // The direct chats (group chats have no single safety number) and each
  // one's state, checked once when the screen opens: the top card sums them
  // up, and the picker shows them beside each name before opening that chat's
  // safety number (app/verify-contact needs a peer).
  const [peers, setPeers] = useState<Peer[] | null>(null);
  const [peersFailed, setPeersFailed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [states, setStates] = useState<Record<string, PeerSafetyStatus>>({});
  const [loadingPeers, setLoadingPeers] = useState(false);
  // Bumped when a new check starts or the screen goes: the older checks stop.
  const checkRun = useRef(0);
  useEffect(() => () => { checkRun.current++; }, []);
  const closePicker = () => setPickerOpen(false);

  const checkStates = async (list: Peer[], run: number) => {
    const live = () => checkRun.current === run;
    const put = (id: string, st: PeerSafetyStatus) => { if (live()) setStates((m) => ({ ...m, [id]: st })); };
    let myId = '';
    let myKey: string | null = null;
    let verifiedList: string[] | null = null;
    try {
      myId = (await getCachedUser())?.id ?? '';
      [myKey, verifiedList] = await Promise.all([myId ? fetchIdentityKey(myId) : null, getVerifiedContacts().catch(() => null)]);
    } catch { /* every row says it could not check */ }
    if (!myId || !myKey || verifiedList === null) {
      for (const p of list) put(p.id, 'unknown');
      return;
    }
    const verified = verifiedList;
    await forEachLimited(list, 3, async (p) => {
      try {
        const [peerKey, recorded, change] = await Promise.all([
          fetchIdentityKey(p.id), getVerifiedFingerprint(p.id).catch(() => null), checkKeyChange(p.id),
        ]);
        if (!peerKey) { put(p.id, 'nokey'); return; }
        const fp = safetyFingerprint(computeSafetyNumber(myId, myKey!, p.id, peerKey));
        put(p.id, verificationStatus(verified.includes(p.id), recorded, fp, change != null));
      } catch {
        put(p.id, 'unknown');
      }
    }, () => !live());
  };

  /** Load the direct chats and start checking them; null when it failed. */
  const loadPeers = async (): Promise<Peer[] | null> => {
    setLoadingPeers(true);
    try {
      const chats = await listChats();
      const seen = new Set<string>();
      const list: Peer[] = [];
      for (const ch of chats) {
        if (ch.type !== 'direct' || !ch.peerUserId || seen.has(ch.peerUserId)) continue;
        seen.add(ch.peerUserId);
        list.push({ id: ch.peerUserId, name: ch.peerName || 'this contact' });
      }
      const run = ++checkRun.current;
      setStates({});
      setPeers(list);
      setPeersFailed(false);
      checkStates(list, run);
      return list;
    } catch {
      setPeersFailed(true);
      return null;
    } finally { setLoadingPeers(false); }
  };
  useEffect(() => { if (E2EE_ENABLED) loadPeers(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Back from a safety number: it may have just been verified, so check again.
  const recheck = useRef(false);
  useFocusEffect(useCallback(() => {
    if (recheck.current) { recheck.current = false; loadPeers(); }
  }, [])); // eslint-disable-line react-hooks/exhaustive-deps

  const pickContact = async () => {
    if (loadingPeers) return;
    const list = peers ?? await loadPeers();
    if (!list) {
      Alert.alert('Could not load your chats', 'Check your connection and try again.');
      return;
    }
    if (!list.length) {
      Alert.alert('No direct chats yet', 'A safety number belongs to a one-to-one chat. Start one, then check it here.');
      return;
    }
    setPickerOpen(true);
  };

  const summary = !E2EE_ENABLED ? null
    : peers ? peerSafetySummary(peers.map((p) => states[p.id]).filter((x): x is PeerSafetyStatus => !!x), peers.length)
    : peersFailed ? 'Your chats could not be checked. Check your connection, then tap Check a contact’s safety number.'
    : 'Checking your direct chats…';

  const actions: SheetAction[] = (pickerOpen ? peers ?? [] : []).map((p) => {
    const st = states[p.id];
    return {
      label: st ? `${p.name} · ${peerSafetyLabel(st)}` : `${p.name} · Checking…`,
      icon: st === 'verified' ? 'shield-checkmark-outline' : st === 'changed' ? 'warning-outline' : 'person-outline',
      accessibilityLabel: `${p.name}, ${st ? peerSafetyLabel(st) : 'checking'}. Opens the safety number.`,
      onPress: () => {
        closePicker();
        recheck.current = true;
        router.push({ pathname: '/verify-contact', params: { peerId: p.id, peerName: p.name } });
      },
    };
  });

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Encryption status', headerStyle: { backgroundColor: colors.glassSoft }, headerTintColor: colors.text }} />
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <AuroraBackground />
      <ScrollView style={s.screen}>

        {/* Score card */}
        <View style={s.scoreCard}>
          <Text style={s.scoreNum} accessibilityRole="header"
            accessibilityLabel={`${active} of ${layers.length} encryption layers in this build`}>{active}/{layers.length}</Text>
          <Text style={s.scoreLabel} importantForAccessibility="no" accessibilityElementsHidden>Encryption layers in this build</Text>
          {/* Decorative: the number above already says it. */}
          <View style={s.scoreBar} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
            {layers.map((l) => (
              <View key={l.layer} style={[s.scoreSeg, { backgroundColor: l.active ? colors.success : colors.border }]} />
            ))}
          </View>
          <Text style={s.scoreNote}>
            {active === layers.length
              ? 'All layers are switched on in this build.'
              : `${layers.length - active} layer${layers.length - active > 1 ? 's are' : ' is'} not switched on in this build.`
            }
          </Text>
          {/* Live, unlike the flags above: the direct chats' safety states. */}
          {summary ? <Text style={s.chatSummary}>{summary}</Text> : null}
        </View>

        {/* Layer cards */}
        {layers.map((layer) => (
          <View key={layer.layer} style={[s.layerCard, { borderLeftColor: layer.active ? colors.success : colors.border }]}
            accessible accessibilityLabel={`${layer.layer}, ${layer.active ? 'on' : 'off'}. ${layer.label}. ${LAYER_INFO[layer.layer] ?? ''}`}>
            <View style={s.layerHeader}>
              <View style={[s.layerDot, { backgroundColor: layer.active ? colors.success : colors.border }]} />
              <Text style={[s.layerName, { color: layer.active ? colors.text : colors.textDim }]}>{layer.layer}</Text>
              <View style={[s.layerBadge, { backgroundColor: colors.glassSoft }]}>
                <Text style={[s.layerBadgeTxt, { color: layer.active ? colors.accentOn : colors.textDim }]}>
                  {layer.active ? 'ON' : 'OFF'}
                </Text>
              </View>
            </View>
            <Text style={s.layerLabel}>{layer.label}</Text>
            <Text style={s.layerInfo}>{LAYER_INFO[layer.layer] ?? ''}</Text>
          </View>
        ))}

        <View style={s.uniqueBox}>
          {/* Same flag as the card in app/contact-info.tsx, which is titled
              "Encrypted in Transit" and cannot be tapped while it is off. */}
          <Text style={s.uniqueBody}>
            {E2EE_ENABLED
              ? 'This lists what this version of the app is built to use. To check that a particular conversation is end-to-end encrypted with the right person, open the chat, tap their name, then tap the End-to-End Encrypted card, and compare the safety number with the one on their phone.'
              : 'This lists what this version of the app is built to use. End-to-end encryption is not switched on in this build, so there is no safety number to compare yet; messages are encrypted in transit.'}
          </Text>
          {E2EE_ENABLED ? (
            <TouchableOpacity style={s.checkBtn} onPress={pickContact} disabled={loadingPeers} accessibilityRole="button"
              accessibilityLabel="Check a contact's safety number" accessibilityState={{ disabled: loadingPeers, busy: loadingPeers }}>
              {loadingPeers ? <ActivityIndicator color={colors.primary} /> : <Text style={s.checkBtnTxt}>Check a contact’s safety number</Text>}
            </TouchableOpacity>
          ) : null}
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
      {/* A sibling of the ScrollView: a Modal is never scroll content. */}
      <Sheet visible={pickerOpen} title="Whose safety number?" actions={actions} onClose={closePicker} />
      </View>
    </>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:       { flex: 1, backgroundColor: c.glassSoft },
  scoreCard:    { backgroundColor: c.glass, margin: 16, borderRadius: 16, padding: 24, alignItems: 'center', borderWidth: 1, borderColor: c.glassStroke },
  scoreNum:     { fontSize: 56, fontWeight: 'bold', color: c.accentOn },
  scoreLabel:   { color: c.textDim, fontSize: 14, marginBottom: 16 },
  scoreBar:     { flexDirection: 'row', gap: 6, marginBottom: 12 },
  scoreSeg:     { flex: 1, height: 6, borderRadius: 3 },
  scoreNote:    { color: c.textDim, fontSize: 12, textAlign: 'center' },
  chatSummary:  { color: c.text, fontSize: 13, fontWeight: '600', textAlign: 'center', marginTop: 10 },
  layerCard:    { backgroundColor: c.glassSoft, marginHorizontal: 16, marginBottom: 10, borderRadius: 12, padding: 16, borderLeftWidth: 3 },
  layerHeader:  { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 6 },
  layerDot:     { width: 10, height: 10, borderRadius: 5 },
  layerName:    { fontSize: 16, fontWeight: '700', flex: 1, minWidth: 120 },
  layerBadge:   { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  layerBadgeTxt:{ fontSize: 12, fontWeight: 'bold', letterSpacing: 0.5 },
  layerLabel:   { color: c.accentOn, fontSize: 12, marginBottom: 6 },
  layerInfo:    { color: c.textDim, fontSize: 12, lineHeight: 18 },
  uniqueBox:    { backgroundColor: c.glass, margin: 16, borderRadius: 12, padding: 18, borderWidth: 1, borderColor: c.glassStroke },
  uniqueBody:   { color: c.textDim, fontSize: 13, lineHeight: 20 },
  checkBtn:     { marginTop: 12, minHeight: 44, borderRadius: 10, borderWidth: 1, borderColor: c.glassStroke, backgroundColor: c.glassSoft, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
  checkBtnTxt:  { color: c.primary, fontWeight: '700', fontSize: 14 },
});
