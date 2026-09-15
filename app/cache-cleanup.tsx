// app/cache-cleanup.tsx — Application Cache Cleanup screen.
//
// A THIN renderer over the Node-tested planner (services/cache/cachePlan) and the
// device manager (services/cache/cacheManager). It frees rebuildable cache only —
// chats, saved media, document originals, backups, keys, settings, and offline
// files are not cache categories and can never be selected here. Every clear
// asks for confirmation and shows how much will be freed.

import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import {
  CACHE_CATEGORIES, formatBytes, planCleanup, smartSelection, summarizeSizes,
  type CacheCategoryId,
} from '../services/cache/cachePlan';
import {
  executeCleanup, getAutoCleanDays, getClearOnLogout,
  getLastCleanAt, measureCacheSizes, setAutoCleanDays, setClearOnLogout,
} from '../services/cache/cacheManager';
import { AuroraBackground } from '../components/ui';

const AUTO_OPTIONS = [0, 7, 15, 30];

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function CacheCleanupScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();

  const [sizes, setSizes] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<Set<CacheCategoryId>>(new Set(smartSelection()));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [autoDays, setAutoDays] = useState(0);
  const [clearLogout, setClearLogout] = useState(false);
  const [lastClean, setLastClean] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [s, days, logout, last] = await Promise.all([
      measureCacheSizes(), getAutoCleanDays(), getClearOnLogout(), getLastCleanAt(),
    ]);
    setSizes(s); setAutoDays(days); setClearLogout(logout); setLastClean(last);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const summary = useMemo(() => summarizeSizes(sizes), [sizes]);
  const selectedPlan = useMemo(() => planCleanup(sizes, { selected: Array.from(selected) }), [sizes, selected]);

  const toggle = (id: CacheCategoryId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const runCleanup = useCallback(async (plan: ReturnType<typeof planCleanup>, label: string) => {
    if (plan.items.length === 0) { Alert.alert('Nothing to clear', 'No cache is selected.'); return; }
    Alert.alert(
      `Clear ${label}?`,
      `This frees about ${formatBytes(plan.totalBytes)} of cache. Your chats, media, documents, backups, and keys are not affected — cache is rebuilt automatically when needed.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: `Clear ${formatBytes(plan.totalBytes)}`, style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              const res = await executeCleanup(plan);
              Alert.alert('Cache cleared', `Freed about ${formatBytes(res.freedBytes)}.`);
            } catch {
              Alert.alert('Cleanup failed', 'Some cache could not be cleared. Please try again.');
            } finally { setBusy(false); load(); }
          },
        },
      ],
    );
  }, [load]);

  const onSmart = () => runCleanup(planCleanup(sizes, { smart: true }), 'safe cache (Smart)');
  const onSelected = () => runCleanup(selectedPlan, 'selected cache');

  const chooseAutoDays = async (d: number) => { setAutoDays(d); await setAutoCleanDays(d); };
  const toggleLogout = async (v: boolean) => { setClearLogout(v); await setClearOnLogout(v); };

  return (
    <View style={S.container}>
      <AuroraBackground />
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} style={S.backBtn} hitSlop={10}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={S.headerTitle}>Cache cleanup</Text>
          <Text style={S.headerSub}>Free storage — never your data</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        <View style={S.hero}>
          <Text style={S.totalNum}>{formatBytes(summary.totalBytes)}</Text>
          <Text style={S.totalLabel}>reclaimable cache{lastClean ? ` · last cleared ${new Date(lastClean).toLocaleDateString()}` : ''}</Text>
        </View>

        <View style={S.btnRow}>
          <TouchableOpacity style={[S.actBtn, S.actPrimary]} onPress={onSmart} disabled={busy} activeOpacity={0.85}>
            {busy ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="flash" size={16} color="#fff" />}
            <Text style={S.actPrimaryText}>One-Tap Smart Cleanup</Text>
          </TouchableOpacity>
        </View>

        <Text style={S.sectionTitle}>CATEGORIES</Text>
        {loading ? (
          <View style={S.center}><ActivityIndicator color={colors.primary} /></View>
        ) : (
          <View style={S.card}>
            {CACHE_CATEGORIES.map((c, i) => {
              const bytes = sizes[c.id] ?? 0;
              const on = selected.has(c.id);
              return (
                <View key={c.id}>
                  <TouchableOpacity style={S.row} onPress={() => toggle(c.id)} activeOpacity={0.7}>
                    <Ionicons name={on ? 'checkbox' : 'square-outline'} size={22} color={on ? colors.primary : colors.textFaint} />
                    <View style={{ flex: 1 }}>
                      <Text style={S.rowLabel}>{c.label}</Text>
                      <Text style={S.rowDesc}>{c.description}</Text>
                    </View>
                    <Text style={S.rowSize}>{formatBytes(bytes)}</Text>
                  </TouchableOpacity>
                  {i < CACHE_CATEGORIES.length - 1 && <View style={S.divider} />}
                </View>
              );
            })}
          </View>
        )}

        <TouchableOpacity style={[S.actBtn, S.actClear]} onPress={onSelected} disabled={busy || selectedPlan.items.length === 0} activeOpacity={0.85}>
          <Ionicons name="trash" size={16} color={colors.danger} />
          <Text style={[S.actClearText, { color: colors.danger }]}>Clear selected · {formatBytes(selectedPlan.totalBytes)}</Text>
        </TouchableOpacity>

        <Text style={S.sectionTitle}>AUTOMATIC CLEANUP</Text>
        <View style={S.card}>
          <View style={S.settingRow}>
            <Text style={S.rowLabel}>Auto-clear safe cache</Text>
            <View style={S.chips}>
              {AUTO_OPTIONS.map((d) => (
                <TouchableOpacity key={d} onPress={() => chooseAutoDays(d)} style={[S.chip, autoDays === d && { backgroundColor: colors.primary, borderColor: colors.primary }]}>
                  <Text style={[S.chipText, autoDays === d && { color: '#fff' }]}>{d === 0 ? 'Off' : `${d}d`}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
          <View style={S.divider} />
          <View style={S.settingRow}>
            <View style={{ flex: 1 }}>
              <Text style={S.rowLabel}>Clear cache on logout</Text>
              <Text style={S.rowDesc}>Removes cache (not your data) when you sign out.</Text>
            </View>
            <Switch value={clearLogout} onValueChange={toggleLogout} />
          </View>
        </View>

        <View style={S.note}>
          <Text style={S.noteText}>
            Cache is temporary data that crazzychat recreates as needed. The first time you reopen a chat
            after clearing, images and thumbnails may take a moment to reload. Offline files you saved are
            not cache and are never removed.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: HEADER_TOP, paddingBottom: 14, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: c.glassStroke },
  backBtn: { padding: 4 },
  headerTitle: { color: c.text, fontSize: 18, fontWeight: '800' },
  headerSub: { color: c.textDim, fontSize: 12, marginTop: 1 },

  hero: { alignItems: 'center', paddingVertical: 22 },
  totalNum: { color: c.text, fontSize: 40, fontWeight: '900', letterSpacing: -1 },
  totalLabel: { color: c.textDim, fontSize: 12.5, marginTop: 4 },

  btnRow: { paddingHorizontal: 16 },
  actBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginHorizontal: 16, paddingVertical: 14, borderRadius: 14, marginTop: 8 },
  actPrimary: { backgroundColor: c.primary, marginHorizontal: 0 },
  actPrimaryText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  actClear: { borderWidth: 1, borderColor: c.glassStroke, backgroundColor: c.glassSoft },
  actClearText: { fontWeight: '800', fontSize: 14 },

  sectionTitle: { color: c.textFaint, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginTop: 24, marginBottom: 8, marginLeft: 20 },
  card: { marginHorizontal: 16, backgroundColor: c.glassSoft, borderRadius: 16, borderWidth: 1, borderColor: c.glassStroke, overflow: 'hidden' },
  divider: { height: 1, backgroundColor: c.hairline, marginLeft: 16 },
  center: { paddingVertical: 30, alignItems: 'center' },

  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  rowLabel: { color: c.text, fontSize: 14.5, fontWeight: '700' },
  rowDesc: { color: c.textDim, fontSize: 12, marginTop: 2, lineHeight: 16 },
  rowSize: { color: c.textDim, fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },

  settingRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  chips: { flexDirection: 'row', gap: 6 },
  chip: { borderWidth: 1, borderColor: c.glassStroke, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 5 },
  chipText: { color: c.textDim, fontSize: 12.5, fontWeight: '700' },

  note: { marginHorizontal: 16, marginTop: 20, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: c.glassStroke, backgroundColor: c.glassSoft },
  noteText: { color: c.textDim, fontSize: 12.5, lineHeight: 18 },
});
