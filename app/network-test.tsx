// app/network-test.tsx — Built-in Network Speed Test
// Download/upload speed, ping/latency, jitter, animated gauge
// Connection type from NetInfo, history in AsyncStorage
//
// The test runs against Cloudflare's public speed endpoints (TEST_HOST), not a
// crazzychat server, so the screen says so: Cloudflare sees this device's IP
// address. Only requests that succeeded are measured (lib/speedTest.ts); a run
// where nothing got through shows as failed instead of an invented speed.

import React, { useState, useEffect, useRef , useMemo} from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  ActivityIndicator, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { useRouter, Stack } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import NetInfo from '@react-native-community/netinfo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AuroraBackground } from '../components/ui';
import { pingStats, throughputMbps, type TransferSample } from '../lib/speedTest';


const STORAGE_KEY = 'vaultchat_speedtest_history';
const GAUGE_SIZE = 220;
const GAUGE_STROKE = 12;
const TEST_HOST = 'speed.cloudflare.com';
const UPLOAD_URL = `https://${TEST_HOST}/__up`;
const DOWN_URL = (bytes: number) => `https://${TEST_HOST}/__down?bytes=${bytes}`;

type TestResult = {
  id: string;
  download: number;
  upload: number;
  ping: number;
  jitter: number;
  connectionType: string;
  timestamp: number;
};

type TestPhase = 'idle' | 'ping' | 'download' | 'upload' | 'done' | 'failed';
/** Final figures; null = every request for that metric failed. */
type Outcome = { download: number | null; upload: number | null; ping: number | null; jitter: number | null };

function useS() {
  // Reactive size. The module-level Dimensions.get above is captured ONCE at
  // import and never updates, so it froze the layout at the size the app
  // launched with. Shadowing it here makes every use in this component follow
  // rotation; StyleSheet.create keeps the initial value, which is fine for
  // static rules.
  const {width: SW} = useWindowDimensions();

  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors, SW), [colors, SW]);
}

export default function NetworkTestScreen() {
  const { colors } = useTheme();
  const styles = useS();
  const router = useRouter();

  // State
  const [phase, setPhase] = useState<TestPhase>('idle');
  const [progress, setProgress] = useState(0);
  const [download, setDownload] = useState(0);
  const [upload, setUpload] = useState(0);
  const [, setConnectionType] = useState('Unknown');
  const [connectionDetails, setConnectionDetails] = useState('');
  const [history, setHistory] = useState<TestResult[]>([]);
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  // Async test steps keep resolving after the user leaves; nothing may set
  // state then.
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    loadHistory();
    checkConnection();
    checkServerStatus();
  }, []);


  /** Reads the connection, shows it, and returns the label — the caller uses
   *  the returned value, because state set here is not visible to it until the
   *  next render. */
  const checkConnection = async (): Promise<string> => {
    const state = await NetInfo.fetch();
    let details: string;
    if (state.type === 'wifi') details = 'WiFi';
    else if (state.type === 'cellular') {
      const gen = (state as any).details?.cellularGeneration || '';
      details = gen ? gen.toUpperCase() : 'Cellular';
    } else details = state.type || 'Unknown';
    if (mounted.current) { setConnectionType(state.type || 'Unknown'); setConnectionDetails(details); }
    return details;
  };

  const checkServerStatus = async () => {
    try {
      const start = Date.now();
      const resp = await fetch(DOWN_URL(1), { method: 'HEAD' });
      const elapsed = Date.now() - start;
      if (mounted.current) setServerOnline(resp.ok && elapsed < 5000);
    } catch {
      if (mounted.current) setServerOnline(false);
    }
  };

  const loadHistory = async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) setHistory(JSON.parse(raw));
    } catch {}
  };

  const saveHistory = async (result: TestResult) => {
    try {
      const updated = [result, ...history].slice(0, 20);
      setHistory(updated);
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch {}
  };

  const progressTo = (p: number) => { if (mounted.current) setProgress(p); };

  // ── Ping Test ── (a failed request is not a round trip)
  const testPing = async () => {
    const trips: (number | null)[] = [];
    for (let i = 0; i < 5; i++) {
      const start = Date.now();
      try {
        const resp = await fetch(DOWN_URL(1), { cache: 'no-store' });
        trips.push(resp.ok ? Date.now() - start : null);
      } catch { trips.push(null); }
      progressTo((i + 1) / 5 * 100);
    }
    return pingStats(trips);
  };

  // ── Download Test ── (only bytes actually received count)
  const testDownload = async (): Promise<number | null> => {
    const sizes = [1000000, 2000000, 5000000]; // 1MB, 2MB, 5MB
    const samples: TransferSample[] = [];
    for (let i = 0; i < sizes.length; i++) {
      const start = Date.now();
      try {
        const resp = await fetch(DOWN_URL(sizes[i]), { cache: 'no-store' });
        const blob = await resp.blob();
        samples.push({ ok: resp.ok, bytes: blob.size, ms: Date.now() - start });
      } catch {
        samples.push({ ok: false, bytes: 0, ms: Date.now() - start });
      }
      const sofar = throughputMbps(samples);
      if (mounted.current && sofar != null) setDownload(sofar);
      progressTo((i + 1) / sizes.length * 100);
    }
    return throughputMbps(samples);
  };

  // ── Upload Test ── (an upload counts only if the server accepted it)
  const testUpload = async (): Promise<number | null> => {
    const sizes = [100000, 500000, 1000000]; // 100KB, 500KB, 1MB
    const samples: TransferSample[] = [];
    for (let i = 0; i < sizes.length; i++) {
      const data = new Uint8Array(sizes[i]);
      const start = Date.now();
      try {
        const resp = await fetch(UPLOAD_URL, {
          method: 'POST',
          body: data,
          headers: { 'Content-Type': 'application/octet-stream' },
        });
        samples.push({ ok: resp.ok, bytes: sizes[i], ms: Date.now() - start });
      } catch {
        samples.push({ ok: false, bytes: 0, ms: Date.now() - start });
      }
      const sofar = throughputMbps(samples);
      if (mounted.current && sofar != null) setUpload(sofar);
      progressTo((i + 1) / sizes.length * 100);
    }
    return throughputMbps(samples);
  };

  // ── Run full test ──
  const runTest = async () => {
    setPhase('ping');
    setOutcome(null);
    setRunError(null);
    setDownload(0);
    setUpload(0);
    setProgress(0);

    try {
      const connection = await checkConnection();

      const pg = await testPing();
      if (!mounted.current) return;

      setPhase('download');
      setProgress(0);
      const dl = await testDownload();
      if (!mounted.current) return;

      setPhase('upload');
      setProgress(0);
      const ul = await testUpload();
      if (!mounted.current) return;

      const result: Outcome = { download: dl, upload: ul, ping: pg?.ping ?? null, jitter: pg?.jitter ?? null };
      setOutcome(result);
      setDownload(dl ?? 0);
      setUpload(ul ?? 0);
      setProgress(100);
      const nothingWorked = dl == null && ul == null && pg == null;
      setPhase(nothingWorked ? 'failed' : 'done');

      // History keeps complete measurements only — a partial run would sit
      // there looking like a real (and very slow) connection.
      if (dl != null && ul != null && pg != null) {
        saveHistory({
          id: Date.now().toString(),
          download: dl,
          upload: ul,
          ping: pg.ping,
          jitter: pg.jitter,
          connectionType: connection,
          timestamp: Date.now(),
        });
      }
    } catch (e: any) {
      if (!mounted.current) return;
      setRunError(e?.message ?? 'The test stopped unexpectedly');
      setPhase('failed');
    }
  };

  // ── Gauge rendering ──
  const renderGauge = () => {
    const speed = phase === 'download' ? download : phase === 'upload' ? upload : (phase === 'done' ? download : 0);
    const running = phase !== 'idle' && phase !== 'done' && phase !== 'failed';
    const maxSpeed = 200;
    const ratio = Math.min(speed / maxSpeed, 1);
    // Semicircle from -135deg to 135deg (270 deg arc)
    const needleAngle = -135 + ratio * 270;

    const ticks = [0, 25, 50, 100, 150, 200];

    return (
      <View style={styles.gaugeContainer} accessible accessibilityRole="progressbar"
        accessibilityLabel={phase === 'failed' ? 'Speed test failed' : `${phase === 'upload' ? 'Upload' : 'Download'} ${speed.toFixed(1)} megabits per second`}>
        {/* Gauge background arc */}
        <View style={[styles.gauge, { width: GAUGE_SIZE, height: GAUGE_SIZE / 2 + 20 }]}>
          {/* Background semicircle */}
          <View style={styles.gaugeArcBg} />
          {/* Colored arc overlay */}
          <View style={[styles.gaugeArcFill, {
            borderColor: speed > 100 ? colors.primary : speed > 50 ? colors.accent : speed > 20 ? colors.accent : '#FBBF24',
          }]} />
          {/* Tick marks */}
          {ticks.map(t => {
            const angle = -135 + (t / maxSpeed) * 270;
            return (
              <View key={t} style={[styles.gaugeTick, {
                transform: [{ rotate: `${angle}deg` }, { translateY: -GAUGE_SIZE / 2 + 20 }],
              }]}>
                <Text style={styles.gaugeTickLabel}>{t}</Text>
              </View>
            );
          })}
          {/* Needle */}
          <View style={[styles.gaugeNeedle, { transform: [{ rotate: `${needleAngle}deg` }] }]}>
            <View style={styles.needleLine} />
          </View>
          {/* Center dot */}
          <View style={styles.gaugeCenterDot} />
        </View>
        {/* Speed display */}
        <Text style={styles.gaugeSpeed}>{speed.toFixed(1)}</Text>
        <Text style={styles.gaugeUnit}>Mbps</Text>
        {running && (
          <Text style={styles.gaugePhase}>
            {phase === 'ping' ? 'Testing Ping...' : phase === 'download' ? 'Download Test...' : 'Upload Test...'}
          </Text>
        )}
      </View>
    );
  };

  const formatDate = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const getConnectionIcon = () => {
    switch (connectionDetails.toLowerCase()) {
      case 'wifi': return '📶';
      case '5g': return '5G';
      case '4g': case 'lte': return '4G';
      case '3g': return '3G';
      default: return '🌐';
    }
  };

  return (
    <View style={styles.container}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />
      {/* A hardcoded WHITE absoluteFill gradient used to sit here, painted over
          the Aurora ground. Every text style on this screen is #FFF — built for
          the dark ground — so the whole screen rendered white-on-white: the
          speed readout, "History", and the empty-state line were all invisible
          on a real device. The ground is <AuroraBackground/> above; nothing
          should cover it. */}

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={20} color={colors.accent} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Speed Test</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>

        {/* Connection Info */}
        <View style={styles.connectionRow}>
          <View style={styles.connectionBadge}>
            <Text style={styles.connectionIcon}>{getConnectionIcon()}</Text>
            <Text style={styles.connectionLabel}>{connectionDetails}</Text>
          </View>
          <View style={[styles.serverDot, { backgroundColor: serverOnline === null ? '#FBBF24' : serverOnline ? colors.primary : colors.danger }]} />
          <Text style={styles.serverLabel}>
            {serverOnline === null ? 'Checking...' : serverOnline ? 'Test server reachable' : 'Test server unreachable'}
          </Text>
        </View>
        <Text style={styles.disclosure}>
          Tests run against {TEST_HOST} (Cloudflare), not crazzychat. Cloudflare sees this device&apos;s IP address while the test runs.
        </Text>

        {/* Gauge */}
        {renderGauge()}

        {/* Progress bar */}
        {phase !== 'idle' && phase !== 'done' && phase !== 'failed' && (
          <View style={styles.progressBar}>
            <View style={[styles.progressFill, { width: `${progress}%` }]} />
          </View>
        )}

        {/* Test Button */}
        {(() => {
          const running = phase !== 'idle' && phase !== 'done' && phase !== 'failed';
          return (
            <TouchableOpacity
              onPress={runTest}
              disabled={running}
              style={[styles.testButton, running && styles.testButtonDisabled]}
              accessibilityRole="button"
              accessibilityLabel={running ? 'Speed test running' : phase === 'idle' ? 'Start speed test' : 'Run the speed test again'}
              accessibilityState={{ disabled: running, busy: running }}
            >
              <LinearGradient
                colors={running ? [colors.border, colors.border] : [colors.accent, '#2D7AE0']}
                style={styles.testButtonGradient}
              >
                {running ? (
                  <ActivityIndicator color="#FFF" />
                ) : (
                  <Text style={styles.testButtonText}>{phase === 'idle' ? 'Start Test' : 'Test Again'}</Text>
                )}
              </LinearGradient>
            </TouchableOpacity>
          );
        })()}

        {/* Failed */}
        {phase === 'failed' && (
          <View style={styles.failedBox} accessibilityRole="alert">
            <Text style={styles.failedTitle}>Test failed</Text>
            <Text style={styles.failedText}>
              {runError ?? `No request reached ${TEST_HOST}. Check your connection and try again.`}
            </Text>
          </View>
        )}

        {/* Results — a metric whose every request failed shows "Failed", not a number */}
        {phase === 'done' && outcome && (
          <View style={styles.resultsGrid}>
            {([
              ['Download', outcome.download, 'Mbps', colors.accent],
              ['Upload', outcome.upload, 'Mbps', colors.accent],
              ['Ping', outcome.ping, 'ms', colors.primary],
              ['Jitter', outcome.jitter, 'ms', '#FBBF24'],
            ] as const).map(([label, value, unit, edge]) => (
              <View key={label} style={[styles.resultCard, { borderLeftColor: edge }]} accessible
                accessibilityLabel={value == null ? `${label} failed` : `${label} ${unit === 'Mbps' ? value.toFixed(1) : value} ${unit}`}>
                <Text style={styles.resultLabel}>{label}</Text>
                <Text style={[styles.resultValue, value == null && { color: colors.danger }]}>
                  {value == null ? 'Failed' : unit === 'Mbps' ? value.toFixed(1) : value}
                </Text>
                {value != null && <Text style={styles.resultUnit}>{unit}</Text>}
              </View>
            ))}
          </View>
        )}

        {/* History */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>History</Text>
          {history.length === 0 ? (
            <Text style={styles.noHistory}>No previous tests</Text>
          ) : (
            history.map(item => (
              <View key={item.id} style={styles.historyRow}>
                <View style={styles.historyLeft}>
                  <Text style={styles.historyDate}>{formatDate(item.timestamp)}</Text>
                  <Text style={styles.historyConn}>{item.connectionType}</Text>
                </View>
                <View style={styles.historyRight}>
                  <View style={styles.historyMetric}>
                    <Text style={styles.historyMetricLabel}>↓</Text>
                    <Text style={styles.historyMetricValue}>{item.download.toFixed(1)}</Text>
                  </View>
                  <View style={styles.historyMetric}>
                    <Text style={styles.historyMetricLabel}>↑</Text>
                    <Text style={styles.historyMetricValue}>{item.upload.toFixed(1)}</Text>
                  </View>
                  <View style={styles.historyMetric}>
                    <Text style={[styles.historyMetricLabel, { color: colors.primary }]}>⏱</Text>
                    <Text style={styles.historyMetricValue}>{item.ping}ms</Text>
                  </View>
                </View>
              </View>
            ))
          )}
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette, SW: number) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  // The status-bar inset comes from INSET_SCREENS (app/_layout.tsx), which pads
  // this screen already; a second 40/56 here doubled it.
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 4, paddingHorizontal: 16, paddingBottom: 14 },
  backBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: 'rgba(74,159,255,0.08)', justifyContent: 'center', alignItems: 'center' },
  headerTitle: { color: c.text, fontSize: 18, fontWeight: '700' },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16 },

  // Connection
  connectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 10, marginBottom: 16 },
  connectionBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.glassSoft, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8, marginRight: 16, borderWidth: 1, borderColor: 'rgba(74,159,255,0.1)' },
  connectionIcon: { fontSize: 16, marginRight: 6 },
  connectionLabel: { color: c.text, fontSize: 14, fontWeight: '600' },
  serverDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  serverLabel: { color: c.textDim, fontSize: 13 },
  disclosure: { color: c.textDim, fontSize: 12, lineHeight: 17, textAlign: 'center', marginTop: -6, marginBottom: 12, paddingHorizontal: 12 },
  failedBox: { marginBottom: 16, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: c.danger, backgroundColor: c.glassSoft },
  failedTitle: { color: c.danger, fontSize: 15, fontWeight: '700', marginBottom: 4 },
  failedText: { color: c.textDim, fontSize: 13, lineHeight: 18 },

  // Gauge
  gaugeContainer: { alignItems: 'center', marginVertical: 16 },
  gauge: { alignItems: 'center', justifyContent: 'flex-end', overflow: 'hidden' },
  gaugeArcBg: { position: 'absolute', top: 0, width: GAUGE_SIZE, height: GAUGE_SIZE, borderRadius: GAUGE_SIZE / 2, borderWidth: GAUGE_STROKE, borderColor: 'rgba(74,159,255,0.08)' },
  gaugeArcFill: { position: 'absolute', top: 0, width: GAUGE_SIZE, height: GAUGE_SIZE, borderRadius: GAUGE_SIZE / 2, borderWidth: GAUGE_STROKE, borderTopColor: 'transparent' },
  gaugeTick: { position: 'absolute', bottom: 0, alignItems: 'center' },
  gaugeTickLabel: { color: c.textDim, fontSize: 9 },
  gaugeNeedle: { position: 'absolute', bottom: 10, width: 3, height: GAUGE_SIZE / 2 - 20, backgroundColor: c.danger, borderRadius: 2, transformOrigin: 'bottom center' },
  needleLine: { width: 3, height: '100%', backgroundColor: c.accent, borderRadius: 2 },
  gaugeCenterDot: { position: 'absolute', bottom: 4, width: 16, height: 16, borderRadius: 8, backgroundColor: c.glassSoft },
  gaugeSpeed: { color: c.text, fontSize: 42, fontWeight: '800', marginTop: 8 },
  gaugeUnit: { color: c.textDim, fontSize: 14, marginTop: -2 },
  gaugePhase: { color: c.accent, fontSize: 13, fontWeight: '600', marginTop: 8 },

  // Progress
  progressBar: { height: 4, backgroundColor: 'rgba(74,159,255,0.1)', borderRadius: 2, marginVertical: 12, overflow: 'hidden' },
  progressFill: { height: 4, backgroundColor: c.accent, borderRadius: 2 },

  // Test Button
  testButton: { borderRadius: 14, overflow: 'hidden', marginVertical: 16, elevation: 4, shadowColor: c.accent, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 10 },
  testButtonDisabled: { opacity: 0.7 },
  testButtonGradient: { paddingVertical: 16, alignItems: 'center', borderRadius: 14 },
  testButtonText: { color: '#FFF', fontSize: 18, fontWeight: '800', letterSpacing: 1 },

  // Results
  resultsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 16 },
  resultCard: { width: (SW - 42) / 2, backgroundColor: c.glassSoft, borderRadius: 14, padding: 16, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(74,159,255,0.08)', borderLeftWidth: 3 },
  resultLabel: { color: c.textDim, fontSize: 12, marginBottom: 4 },
  resultValue: { color: c.text, fontSize: 28, fontWeight: '800' },
  resultUnit: { color: c.textDim, fontSize: 12, marginTop: 2 },

  // History
  section: { marginTop: 20 },
  sectionTitle: { color: c.text, fontSize: 16, fontWeight: '700', marginBottom: 12 },
  noHistory: { color: c.textDim, fontSize: 13, textAlign: 'center', marginTop: 8 },
  historyRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: c.glassSoft, borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: 'rgba(74,159,255,0.06)' },
  historyLeft: { flex: 1 },
  historyDate: { color: c.text, fontSize: 13, fontWeight: '600' },
  historyConn: { color: c.textDim, fontSize: 11, marginTop: 2 },
  historyRight: { flexDirection: 'row', gap: 14 },
  historyMetric: { alignItems: 'center' },
  historyMetricLabel: { color: c.accent, fontSize: 12 },
  historyMetricValue: { color: c.text, fontSize: 13, fontWeight: '700', marginTop: 2 },
});
