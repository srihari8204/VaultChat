// app/vaultlens-result.tsx — VaultLens result. Full-bleed reveal + exactly three
// one-tap actions (Set as DP / Save / Share) and a small secondary row
// (Regenerate / Try another). While generating: full-bleed shimmer (no spinner),
// "Almost there…" after 20s. Failure: tap-to-retry (quota already refunded).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Image, TouchableOpacity, StyleSheet, Alert, Dimensions } from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import * as Haptics from 'expo-haptics';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useTheme } from '../lib/theme';
import { SPACING, RADIUS, BRAND_ACCENT, brandAlpha, ELEVATION } from '../constants/theme';
import { AppText, Header } from '../components/ui';
import { Shimmer } from '../components/vaultlens/Shimmer';
import { useGen, getGen, startGeneration, retryGeneration, freshUrl } from '../lib/vaultlens/store';
import { getResult } from '../lib/vaultlens/api';
import { getStrings } from '../lib/vaultlens/strings';
import { uploadAttachment } from '../lib/chatService';
import { api } from '../lib/api';

const { width: SW } = Dimensions.get('window');
const haptic = () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {}); };

export default function VaultLensResult() {
  const { colors } = useTheme();
  const router = useRouter();
  const t = getStrings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const gen = useGen(id);
  const [slow, setSlow] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState<{ url: string | null; status: string } | null>(null);

  // History items aren't in the live store — hydrate from the server (re-signs URL).
  useEffect(() => {
    if (id && !getGen(id)) getResult(id).then((r) => setHydrated({ url: r.url, status: r.status })).catch(() => {});
  }, [id]);

  const status = gen?.status ?? (hydrated?.status as any) ?? 'queued';
  const url = gen?.url ?? hydrated?.url ?? null;

  // "Almost there…" once generation passes 20s.
  useEffect(() => {
    if (status === 'queued' || status === 'processing') {
      const to = setTimeout(() => setSlow(true), 20000);
      return () => clearTimeout(to);
    }
    setSlow(false);
  }, [status]);

  // Download the result to a local cache file (needed for DP/save/share).
  const localFile = useRef<string | null>(null);
  const ensureLocal = useCallback(async (): Promise<string | null> => {
    if (localFile.current) return localFile.current;
    let u = url;
    if (!u && id) u = await freshUrl(id);      // expired R2 URL → re-sign
    if (!u) return null;
    const dest = `${FileSystem.cacheDirectory}vaultlens_${id}.jpg`;
    const r = await FileSystem.downloadAsync(u, dest);
    if ((r.status ?? 0) >= 400) return null;
    localFile.current = dest;
    return dest;
  }, [url, id]);

  const onSetDp = useCallback(async () => {
    haptic(); setBusy('dp');
    try {
      const file = await ensureLocal();
      if (!file) throw new Error('Image not ready');
      const up = await uploadAttachment(file, 'vaultlens.jpg', 'image/jpeg');
      await api('/user/profile', { method: 'PUT', json: { photoURL: up.id } });
      Alert.alert(t.title, t.dpUpdated);
    } catch (e: any) { Alert.alert(t.title, e?.message ?? 'Failed'); }
    finally { setBusy(null); }
  }, [ensureLocal, t]);

  const onSave = useCallback(async () => {
    haptic(); setBusy('save');
    try {
      const perm = await MediaLibrary.requestPermissionsAsync();
      if (!perm.granted) { Alert.alert('Permission needed', 'Allow photo access to save.'); return; }
      const file = await ensureLocal();
      if (!file) throw new Error('Image not ready');
      await MediaLibrary.saveToLibraryAsync(file);
      Alert.alert(t.title, t.savedGallery);
    } catch (e: any) { Alert.alert(t.title, e?.message ?? 'Failed'); }
    finally { setBusy(null); }
  }, [ensureLocal, t]);

  const onShare = useCallback(async () => {
    haptic(); setBusy('share');
    try {
      const file = await ensureLocal();
      if (!file) throw new Error('Image not ready');
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file);
    } catch (e: any) { Alert.alert(t.title, e?.message ?? 'Failed'); }
    finally { setBusy(null); }
  }, [ensureLocal, t]);

  const onRegenerate = useCallback(async () => {
    haptic();
    const g = getGen(String(id));
    if (!g) return;
    localFile.current = null;
    const newId = await startGeneration({ id: g.styleId, name: g.styleName, pack: g.packId });
    router.replace({ pathname: '/vaultlens-result', params: { id: newId } } as any);
  }, [id, router]);

  const s = styles(colors);

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <Header title="" right={<TouchableOpacity onPress={() => router.replace('/vaultlens' as any)} hitSlop={10}><Ionicons name="grid-outline" size={20} color={colors.text} /></TouchableOpacity>} />

      <View style={s.stage}>
        {status === 'done' && url ? (
          <Animated.View entering={FadeIn.duration(450)} style={s.full}>
            <Image source={{ uri: url }} style={s.full} resizeMode="cover" />
          </Animated.View>
        ) : status === 'failed' ? (
          <TouchableOpacity style={[s.full, s.center]} activeOpacity={0.85} onPress={() => id && retryGeneration(String(id))}>
            <Ionicons name="refresh-circle" size={54} color={colors.textDim} />
            <AppText variant="h3" style={{ marginTop: SPACING.sm }}>{t.didntWork}</AppText>
            <AppText variant="callout" color={colors.textDim}>{t.tapRetry}</AppText>
          </TouchableOpacity>
        ) : (
          <View style={s.full}>
            <Shimmer width={SW} height={SW * 1.25} radius={0} />
            <View style={[StyleSheet.absoluteFill, s.center]} pointerEvents="none">
              <Ionicons name="sparkles" size={30} color={brandAlpha(0.9)} />
              <AppText variant="bodyStrong" style={{ marginTop: SPACING.sm }}>{slow ? t.almostThere : t.generating}</AppText>
              {gen?.styleName ? <AppText variant="caption" color={colors.textDim}>{gen.styleName}</AppText> : null}
            </View>
          </View>
        )}
      </View>

      {/* Actions */}
      {status === 'done' && (
        <View style={s.actions}>
          <View style={s.primaryRow}>
            <PrimaryAction icon="person-circle" label={t.setDp} onPress={onSetDp} busy={busy === 'dp'} colors={colors} highlight />
            <PrimaryAction icon="download" label={t.saveGallery} onPress={onSave} busy={busy === 'save'} colors={colors} />
            <PrimaryAction icon="share-social" label={t.share} onPress={onShare} busy={busy === 'share'} colors={colors} />
          </View>
          <View style={s.secondaryRow}>
            <TouchableOpacity style={s.secBtn} onPress={onRegenerate}><Ionicons name="refresh" size={15} color={colors.textDim} /><AppText variant="caption" color={colors.textDim}>{t.regenerate}</AppText></TouchableOpacity>
            <TouchableOpacity style={s.secBtn} onPress={() => router.replace('/vaultlens' as any)}><Ionicons name="grid" size={15} color={colors.textDim} /><AppText variant="caption" color={colors.textDim}>{t.tryAnother}</AppText></TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

function PrimaryAction({ icon, label, onPress, busy, colors, highlight }:
  { icon: any; label: string; onPress: () => void; busy?: boolean; colors: any; highlight?: boolean }) {
  return (
    <TouchableOpacity style={[pa.btn, { backgroundColor: highlight ? BRAND_ACCENT : colors.card }]} onPress={onPress} disabled={busy} activeOpacity={0.85}>
      <Ionicons name={busy ? 'hourglass' : icon} size={22} color={highlight ? '#fff' : colors.text} />
      <AppText variant="tiny" color={highlight ? '#fff' : colors.text} numberOfLines={1} style={{ marginTop: 4 }}>{label}</AppText>
    </TouchableOpacity>
  );
}

const pa = StyleSheet.create({
  btn: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: SPACING.md, borderRadius: RADIUS.lg, ...ELEVATION.sm },
});

const styles = (c: any) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  stage: { flex: 1, backgroundColor: '#000', overflow: 'hidden' },
  full: { width: '100%', height: '100%' },
  center: { alignItems: 'center', justifyContent: 'center' },
  actions: { padding: SPACING.lg, gap: SPACING.md },
  primaryRow: { flexDirection: 'row', gap: SPACING.sm },
  secondaryRow: { flexDirection: 'row', justifyContent: 'center', gap: SPACING.xl },
  secBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: SPACING.xs },
});
