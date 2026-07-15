// app/vaultlens.tsx — VaultLens home (Create + History). Open → stunning avatar
// in under 30s: cached selfie + quota, horizontally-scrollable style packs, tap a
// style → generation starts instantly and the result screen reveals it. First
// run only: one plain-language consent + a selfie. Reuses the VaultChat design
// system (AppText/Button/Header, SPACING/RADIUS/TYPOGRAPHY, theme tokens).

import React, { useCallback, useEffect, useState } from 'react';
import { View, ScrollView, TouchableOpacity, Image, Text, Modal, StyleSheet, Alert, Pressable } from 'react-native';
import { useRouter, useFocusEffect, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { useTheme } from '../lib/theme';
import { SPACING, RADIUS, ELEVATION, BRAND_ACCENT, brandAlpha, avatarColor } from '../constants/theme';
import { AppText, Button, Header } from '../components/ui';
import { Shimmer } from '../components/vaultlens/Shimmer';
import { getCatalog, previewUrl, uploadFace, deleteFaceData, type VLPack, type VLStyle } from '../lib/vaultlens/api';
import { useQuota, refreshQuota, ensureListeners, startGeneration, getHistory, retryPending, type VLGen } from '../lib/vaultlens/store';
import { getStrings } from '../lib/vaultlens/strings';

const CONSENT_KEY = 'vaultlens.consent.v1';
const FACE_KEY    = 'vaultlens.face.thumb';
const haptic = () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}); };

export default function VaultLensHome() {
  const { colors } = useTheme();
  const router = useRouter();
  const t = getStrings();
  const quota = useQuota();

  const [tab, setTab] = useState<'create' | 'history'>('create');
  const [packs, setPacks] = useState<VLPack[]>([]);
  const [activePack, setActivePack] = useState<string | null>(null);
  const [faceThumb, setFaceThumb] = useState<string | null>(null);
  const [consented, setConsented] = useState(false);
  const [showConsent, setShowConsent] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [busyFace, setBusyFace] = useState(false);
  const [history, setHistory] = useState<VLGen[]>([]);
  const [pendingStyle, setPendingStyle] = useState<VLStyle | null>(null); // style tapped before a face existed

  // ── boot ──────────────────────────────────────────────────────────
  useEffect(() => {
    ensureListeners();
    refreshQuota();
    getCatalog().then((c) => { setPacks(c.packs); setActivePack(c.packs[0]?.id ?? null); }).catch(() => {});
    AsyncStorage.multiGet([CONSENT_KEY, FACE_KEY]).then(([[, c], [, f]]) => {
      setConsented(c === '1'); setFaceThumb(f || null);
    });
  }, []);
  useFocusEffect(useCallback(() => { retryPending(); if (tab === 'history') getHistory().then(setHistory); }, [tab]));

  const hasFace = !!faceThumb;

  // ── selfie capture + upload (compress ≤1024 / q80) ────────────────
  const captureFace = useCallback(async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert('Permission needed', 'Allow photo access to add your selfie.'); return false; }
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 1 });
    if (res.canceled || !res.assets?.[0]) return false;
    setBusyFace(true);
    try {
      const m = await ImageManipulator.manipulateAsync(res.assets[0].uri, [{ resize: { width: 1024 } }],
        { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG });
      await uploadFace(m.uri);
      await AsyncStorage.setItem(FACE_KEY, m.uri);
      setFaceThumb(m.uri);
      return true;
    } catch (e: any) { Alert.alert('Could not add photo', e?.message ?? 'Try again'); return false; }
    finally { setBusyFace(false); }
  }, []);

  // First-run gate: consent → selfie, then continue with the tapped style.
  const ensureFace = useCallback(async (): Promise<boolean> => {
    if (hasFace) return true;
    if (!consented) { setShowConsent(true); return false; } // consent modal drives the rest
    return captureFace();
  }, [hasFace, consented, captureFace]);

  const onAgree = useCallback(async () => {
    await AsyncStorage.setItem(CONSENT_KEY, '1');
    setConsented(true); setShowConsent(false);
    const ok = await captureFace();
    if (ok && pendingStyle) { const s = pendingStyle; setPendingStyle(null); fire(s); }
  }, [pendingStyle, captureFace]);

  // ── generate ──────────────────────────────────────────────────────
  const fire = useCallback(async (style: VLStyle) => {
    if (quota && quota.remaining <= 0) { Alert.alert(t.title, t.quotaReached); return; }
    const id = await startGeneration({ id: style.id, name: style.name, pack: style.pack });
    router.push({ pathname: '/vaultlens-result', params: { id } } as any);
  }, [quota, router, t]);

  const onTapStyle = useCallback(async (style: VLStyle) => {
    haptic();
    if (!hasFace) { setPendingStyle(style); const ok = await ensureFace(); if (!ok) return; }
    fire(style);
  }, [hasFace, ensureFace, fire]);

  const onDeleteData = useCallback(async () => {
    setShowSettings(false);
    try {
      await deleteFaceData();
      await AsyncStorage.multiRemove([FACE_KEY, CONSENT_KEY]);
      setFaceThumb(null); setConsented(false); setHistory([]);
      Alert.alert(t.title, t.deleted);
    } catch (e: any) { Alert.alert(t.title, e?.message ?? 'Failed'); }
  }, [t]);

  const pack = packs.find((p) => p.id === activePack);
  const s = styles(colors);

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <Header title={t.title} right={
        <TouchableOpacity onPress={() => setShowSettings(true)} hitSlop={10}>
          <Ionicons name="ellipsis-horizontal" size={22} color={colors.text} />
        </TouchableOpacity>} />

      {/* Segmented tabs */}
      <View style={s.tabs}>
        {(['create', 'history'] as const).map((k) => (
          <TouchableOpacity key={k} style={[s.tab, tab === k && s.tabActive]} onPress={() => { haptic(); setTab(k); }} activeOpacity={0.8}>
            <AppText variant="bodyStrong" color={tab === k ? '#fff' : colors.textDim}>{k === 'create' ? t.tabCreate : t.tabHistory}</AppText>
          </TouchableOpacity>
        ))}
      </View>

      {tab === 'create' ? (
        <ScrollView contentContainerStyle={s.body} showsVerticalScrollIndicator={false}>
          {/* Selfie + quota row */}
          <View style={s.topRow}>
            <TouchableOpacity style={s.faceWrap} onPress={() => (hasFace ? captureFace() : ensureFace())} activeOpacity={0.85}>
              {busyFace ? <Shimmer width={64} height={64} radius={32} />
                : hasFace ? <Image source={{ uri: faceThumb! }} style={s.faceImg} />
                : (
                  <View style={[s.faceImg, s.faceAdd]}>
                    <Ionicons name="camera" size={22} color={BRAND_ACCENT} />
                  </View>
                )}
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <AppText variant="h3">{hasFace ? t.tagline : t.addPhoto}</AppText>
              <AppText variant="caption" color={colors.textDim}>{hasFace ? t.retakePhoto : 'Tap to add a selfie'}</AppText>
            </View>
            <View style={s.quotaChip}>
              <Ionicons name="sparkles" size={13} color={BRAND_ACCENT} />
              <AppText variant="tiny" color={BRAND_ACCENT}>{quota ? String(quota.remaining) : '—'}</AppText>
            </View>
          </View>

          {/* Pack selector */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.packRow}>
            {packs.map((p) => (
              <TouchableOpacity key={p.id} onPress={() => { haptic(); setActivePack(p.id); }} activeOpacity={0.8}
                style={[s.packChip, activePack === p.id && s.packChipActive]}>
                <AppText variant="caption" color={activePack === p.id ? '#fff' : colors.text}>{p.emoji}  {p.name}</AppText>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* Style grid (2-col) — preview of the style on a sample face */}
          <View style={s.grid}>
            {(pack?.styles ?? []).map((st, i) => (
              <Animated.View key={st.id} entering={FadeInDown.delay(i * 30).springify()} style={s.tileWrap}>
                <TouchableOpacity activeOpacity={0.85} onPress={() => onTapStyle(st)} style={s.tile}>
                  {/* Pack-gradient + emoji fallback — shows through while the preview
                      loads, or stays if the preview isn't uploaded yet, so tiles
                      never render as a broken grey box. */}
                  <LinearGradient colors={[avatarColor(st.id), avatarColor(st.pack)]} style={StyleSheet.absoluteFill}>
                    <View style={s.tileFallback}><Text style={s.tileEmoji}>{pack?.emoji}</Text></View>
                  </LinearGradient>
                  <Image source={{ uri: previewUrl(st.id) }} style={s.tileImg} />
                  <View style={s.tileLabel}><AppText variant="tiny" color="#fff" numberOfLines={1}>{st.name}</AppText></View>
                </TouchableOpacity>
              </Animated.View>
            ))}
            {!pack && [0, 1, 2, 3].map((i) => <View key={i} style={s.tileWrap}><Shimmer width="100%" height={160} radius={RADIUS.lg} /></View>)}
          </View>
        </ScrollView>
      ) : (
        <HistoryGrid history={history} colors={colors} onOpen={(id) => router.push({ pathname: '/vaultlens-result', params: { id } } as any)} empty={t.emptyHistory} />
      )}

      {/* ── Consent (first run, once) ── */}
      <Modal visible={showConsent} transparent animationType="fade" onRequestClose={() => setShowConsent(false)}>
        <Pressable style={s.backdrop} onPress={() => setShowConsent(false)} />
        <Animated.View entering={FadeInDown.springify()} style={[s.sheet, { backgroundColor: colors.surfaceSolid }]}>
          <View style={s.consentIcon}><Ionicons name="shield-checkmark" size={26} color={BRAND_ACCENT} /></View>
          <AppText variant="h2" style={{ marginTop: SPACING.md }}>{t.consentTitle}</AppText>
          <AppText variant="body" color={colors.textDim} style={{ marginTop: SPACING.xs }}>{t.consentBody}</AppText>
          <View style={{ marginTop: SPACING.md, gap: SPACING.sm }}>
            {t.consentBullets.map((b, i) => (
              <View key={i} style={s.bullet}>
                <Ionicons name="checkmark-circle" size={17} color={colors.success} />
                <AppText variant="callout" style={{ flex: 1 }}>{b}</AppText>
              </View>
            ))}
          </View>
          <Button title={t.consentAgree} onPress={onAgree} style={{ marginTop: SPACING.lg }} />
          <AppText variant="caption" color={colors.textFaint} style={{ textAlign: 'center', marginTop: SPACING.sm }}>{t.consentDeleteNote}</AppText>
        </Animated.View>
      </Modal>

      {/* ── Settings: delete data ── */}
      <Modal visible={showSettings} transparent animationType="fade" onRequestClose={() => setShowSettings(false)}>
        <Pressable style={s.backdrop} onPress={() => setShowSettings(false)} />
        <Animated.View entering={FadeInDown.springify()} style={[s.sheet, { backgroundColor: colors.surfaceSolid }]}>
          <TouchableOpacity style={s.settingRow} onPress={() =>
            Alert.alert(t.deletePhotoData, t.deleteConfirm, [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: onDeleteData }])}>
            <Ionicons name="trash-outline" size={20} color={colors.danger} />
            <AppText variant="bodyStrong" color={colors.danger}>{t.deletePhotoData}</AppText>
          </TouchableOpacity>
        </Animated.View>
      </Modal>
    </View>
  );
}

function HistoryGrid({ history, colors, onOpen, empty }: { history: VLGen[]; colors: any; onOpen: (id: string) => void; empty: string }) {
  const s = styles(colors);
  if (history.length === 0) {
    return <View style={s.emptyWrap}><Ionicons name="images-outline" size={40} color={colors.textFaint} /><AppText variant="callout" color={colors.textDim} style={{ marginTop: SPACING.sm }}>{empty}</AppText></View>;
  }
  return (
    <ScrollView contentContainerStyle={s.body} showsVerticalScrollIndicator={false}>
      <View style={s.grid}>
        {history.map((g, i) => (
          <Animated.View key={g.id} entering={FadeIn.delay(i * 25)} style={s.tileWrap}>
            <TouchableOpacity activeOpacity={0.85} onPress={() => onOpen(g.id)} style={s.tile}>
              {g.url ? <Image source={{ uri: g.url }} style={s.tileImg} /> : <View style={[s.tileImg, { backgroundColor: colors.surface }]} />}
              <View style={s.tileLabel}><AppText variant="tiny" color="#fff" numberOfLines={1}>{g.styleName}</AppText></View>
            </TouchableOpacity>
          </Animated.View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = (c: any) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  tabs: { flexDirection: 'row', gap: SPACING.sm, paddingHorizontal: SPACING.lg, paddingBottom: SPACING.sm },
  tab: { flex: 1, alignItems: 'center', paddingVertical: SPACING.sm, borderRadius: RADIUS.pill, backgroundColor: c.surface },
  tabActive: { backgroundColor: BRAND_ACCENT },
  body: { padding: SPACING.lg, paddingBottom: SPACING.xxxl, gap: SPACING.lg },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, backgroundColor: c.card, borderRadius: RADIUS.xl, padding: SPACING.md, ...ELEVATION.sm },
  faceWrap: { width: 64, height: 64, borderRadius: 32 },
  faceImg: { width: 64, height: 64, borderRadius: 32, borderWidth: 2, borderColor: brandAlpha(0.4) },
  faceAdd: { alignItems: 'center', justifyContent: 'center', backgroundColor: brandAlpha(0.10), borderStyle: 'dashed' },
  quotaChip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: brandAlpha(0.12), paddingHorizontal: SPACING.sm, paddingVertical: 5, borderRadius: RADIUS.pill },
  packRow: { gap: SPACING.sm, paddingRight: SPACING.lg },
  packChip: { paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, borderRadius: RADIUS.pill, backgroundColor: c.surface },
  packChipActive: { backgroundColor: BRAND_ACCENT },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.md },
  tileWrap: { width: '47.5%' },
  tile: { width: '100%', aspectRatio: 1, borderRadius: RADIUS.lg, overflow: 'hidden', backgroundColor: c.surface },
  tileImg: { ...StyleSheet.absoluteFillObject },
  tileFallback: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  tileEmoji: { fontSize: 40, opacity: 0.9 },
  tileLabel: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: SPACING.sm, paddingVertical: 6, backgroundColor: 'rgba(0,0,0,0.45)' },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACING.xxl },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: { position: 'absolute', left: SPACING.lg, right: SPACING.lg, top: '22%', borderRadius: RADIUS.xxl, padding: SPACING.xl, ...ELEVATION.lg },
  consentIcon: { width: 52, height: 52, borderRadius: 26, backgroundColor: brandAlpha(0.12), alignItems: 'center', justifyContent: 'center' },
  bullet: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  settingRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, paddingVertical: SPACING.sm },
});
