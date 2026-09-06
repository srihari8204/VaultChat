// app/aiguardian.tsx — Security Hub (Device Security & Monitoring).
//
// The screen behind the mini-apps "Security Hub" tile (formerly "Pegasus").
// A THIN renderer: all logic lives in the Node-tested pure core under
// services/security/deviceSecurity (riskEngine → posture → viewModel). This file
// only calls scanDevice()/getCurrentSnapshot(), records the returned
// notifications into the tamper-evident audit chain, and paints the view model.
//
// Honest by construction: the score, bands, and factor rows come straight from
// the pure modules, and a factor the collectors couldn't evaluate shows as
// "Not evaluated" — never a fabricated "clear". This screen observes and alerts;
// it never wipes (that lives in the separate boot-time securityService).

import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { getCurrentSnapshot } from '../services/security/deviceSecurity/postureStore';
import { runMonitoringScan } from '../services/security/deviceSecurity/monitorService';
import { buildDashboardViewModel, type DashboardVM } from '../services/security/deviceSecurity/viewModel';
import { AuroraBackground } from '../components/ui';

const STATUS_ICON: Record<string, keyof typeof Ionicons.glyphMap> = {
  critical: 'close-circle', warning: 'alert-circle', clear: 'checkmark-circle',
  pending: 'help-circle', not_applicable: 'remove-circle',
};

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function SecurityHubScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const [vm, setVm] = useState<DashboardVM>(() => buildDashboardViewModel(null, Date.now()));
  const [scanning, setScanning] = useState(false);

  const load = useCallback(async () => {
    const snap = await getCurrentSnapshot();
    setVm(buildDashboardViewModel(snap, Date.now()));
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onScan = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    try {
      // Manual trigger always scans; monitorService records events into the
      // audit chain + fires the "Security" channel, so the screen just renders.
      const { outcome } = await runMonitoringScan('manual');
      const snapshot = outcome?.snapshot ?? (await getCurrentSnapshot());
      const view = buildDashboardViewModel(snapshot, Date.now());
      setVm(view);
      Alert.alert(
        `Scan complete — ${view.bandLabel}`,
        view.actions.length
          ? view.actions.map((a) => `• ${a.text}`).join('\n')
          : 'No security indicators were found.\n\nNote: a sandboxed app cannot detect kernel-level implants, so clean does not guarantee safety.',
      );
    } catch {
      Alert.alert('Scan failed', 'The device scan could not complete. Please try again.');
    } finally {
      setScanning(false);
      load();
    }
  }, [scanning, load]);

  return (
    <View style={S.container}>
      <AuroraBackground />
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} style={S.backBtn} hitSlop={10}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={S.headerTitle}>Security Hub</Text>
          <Text style={S.headerSub}>Live checks on this device</Text>
        </View>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
        {/* Score hero — risk 0–100 (lower is safer). */}
        <View style={S.hero}>
          <View style={[S.ring, { borderColor: vm.bandColor }]}>
            <Text style={[S.scoreNum, { color: vm.bandColor }]}>{vm.score ?? '—'}</Text>
            {vm.score != null && <Text style={S.scoreMax}>/100</Text>}
          </View>
          <Text style={[S.bandLabel, { color: vm.bandColor }]}>{vm.bandLabel}</Text>
          <Text style={S.heroSub}>{vm.hasScanned ? vm.bandBlurb : 'Run a device scan to evaluate this device.'}</Text>
          {vm.hasScanned && <Text style={S.lastScan}>Last scan {vm.lastScanText} · lower risk is safer</Text>}
        </View>

        <TouchableOpacity style={S.scanBtn} onPress={onScan} disabled={scanning} activeOpacity={0.85}>
          {scanning ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="shield-checkmark" size={18} color="#fff" />}
          <Text style={S.scanBtnText}>{scanning ? 'Scanning device…' : 'Run device scan'}</Text>
        </TouchableOpacity>

        {/* Recommended actions (only when there are any). */}
        {vm.actions.length > 0 && (
          <>
            <Text style={S.sectionTitle}>RECOMMENDED ACTIONS</Text>
            <View style={S.card}>
              {vm.actions.map((a, i) => (
                <View key={a.key + i}>
                  <View style={S.actionRow}>
                    <Ionicons
                      name={a.severity === 'critical' ? 'alert-circle' : 'warning'}
                      size={20}
                      color={a.severity === 'critical' ? '#EF4444' : '#F59E0B'}
                    />
                    <Text style={S.actionText}>{a.text}</Text>
                  </View>
                  {i < vm.actions.length - 1 && <View style={S.divider} />}
                </View>
              ))}
            </View>
          </>
        )}

        {/* Checks — every dashboard factor row. */}
        <Text style={S.sectionTitle}>CHECKS</Text>
        {vm.factors.length === 0 ? (
          <View style={[S.card, S.emptyCard]}>
            <Text style={S.emptyText}>Run a device scan to see per-check results.</Text>
          </View>
        ) : (
          <View style={S.card}>
            {vm.factors.map((f, i) => (
              <View key={f.key}>
                <View style={S.checkRow}>
                  <Ionicons name={STATUS_ICON[f.status] ?? 'help-circle'} size={22} color={f.statusColor} />
                  <View style={{ flex: 1 }}>
                    <Text style={S.checkLabel}>{f.label}</Text>
                    {!!f.detail && <Text style={S.checkDetail}>{f.detail}</Text>}
                  </View>
                  <Text style={[S.statusPill, { color: f.statusColor, borderColor: f.statusColor }]}>{f.statusLabel}</Text>
                </View>
                {i < vm.factors.length - 1 && <View style={S.divider} />}
              </View>
            ))}
          </View>
        )}

        {/* Permanent honesty disclosure. */}
        <Text style={S.sectionTitle}>WHAT THIS CAN &amp; CAN’T DETECT</Text>
        <View style={[S.card, S.discCard]}>
          <Text style={S.discText}>
            This checks for indicators a phone app can see — root/jailbreak, instrumentation, debuggers,
            emulators, and risky device settings. It <Text style={S.discBold}>cannot</Text> detect
            kernel-level implants (true Pegasus-class spyware) or well-hidden root, so a clean result
            lowers risk but is not a guarantee of safety.
          </Text>
        </View>

        <TouchableOpacity style={S.alertsLink} onPress={() => router.push('/(tabs)/alerts')} activeOpacity={0.7}>
          <Text style={S.alertsLinkText}>View full security log</Text>
          <Ionicons name="arrow-forward" size={15} color={colors.primary} />
        </TouchableOpacity>
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

  hero: { alignItems: 'center', paddingVertical: 26, gap: 6 },
  ring: { width: 130, height: 130, borderRadius: 65, borderWidth: 5, justifyContent: 'center', alignItems: 'center', flexDirection: 'row' },
  scoreNum: { fontSize: 44, fontWeight: '900' },
  scoreMax: { color: c.textFaint, fontSize: 15, fontWeight: '700', marginLeft: 2, marginTop: 14 },
  bandLabel: { fontSize: 18, fontWeight: '800', marginTop: 4 },
  heroSub: { color: c.textDim, fontSize: 13, textAlign: 'center', paddingHorizontal: 40, lineHeight: 19 },
  lastScan: { color: c.textFaint, fontSize: 11.5, marginTop: 2 },

  scanBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginHorizontal: 16, backgroundColor: c.primary, paddingVertical: 15, borderRadius: 14 },
  scanBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },

  sectionTitle: { color: c.textFaint, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginTop: 24, marginBottom: 8, marginLeft: 20 },
  card: { marginHorizontal: 16, backgroundColor: c.glassSoft, borderRadius: 16, borderWidth: 1, borderColor: c.glassStroke, overflow: 'hidden' },
  divider: { height: 1, backgroundColor: c.hairline, marginLeft: 16 },

  actionRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 14 },
  actionText: { color: c.text, fontSize: 13.5, flex: 1, lineHeight: 19 },

  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  checkLabel: { color: c.text, fontSize: 14.5, fontWeight: '700' },
  checkDetail: { color: c.textDim, fontSize: 12.5, marginTop: 2, lineHeight: 17 },
  statusPill: { fontSize: 10.5, fontWeight: '800', borderWidth: 1, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2, overflow: 'hidden' },

  emptyCard: { padding: 18 },
  emptyText: { color: c.textDim, fontSize: 13, lineHeight: 19, textAlign: 'center' },

  discCard: { padding: 16 },
  discText: { color: c.textDim, fontSize: 12.5, lineHeight: 19 },
  discBold: { color: c.text, fontWeight: '800' },

  alertsLink: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 22 },
  alertsLinkText: { color: c.primary, fontSize: 14, fontWeight: '700' },
});
