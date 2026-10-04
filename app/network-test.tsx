// app/network-test.tsx — Built-in Network Speed Test
// Download/upload speed, ping/latency, jitter, animated gauge
// Connection type from NetInfo, history in AsyncStorage
//
// The test runs against crazzychat's own speed endpoints when the server has
// them, and otherwise against Cloudflare's public ones, as before they existed
// (lib/speedTarget.ts). The screen says which: Cloudflare sees this device's IP
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
import { appTarget, cloudflareTarget, probeVerdict, rateLimitMessage, type SpeedTarget } from '../lib/speedTarget';
import { getAccessToken } from '../lib/api';
import { SERVER_URL } from '../constants/server';


const STORAGE_KEY = 'vaultchat_speedtest_history';
const GAUGE_SIZE = 220;
const GAUGE_STROKE = 12;

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
  const [connectionDetails, setConnectionDetails] = useState('');
  const [history, setHistory] = useState<TestResult[]>([]);
  // A history that could not be read is not "No previous tests".
  const [historyError, setHistoryError] = useState(false);
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  // Where the test runs; null until the probe has answered (or after a 429).
  const [target, setTarget] = useState<SpeedTarget | null>(null);
  // Set by a 429 from our own endpoint: the sentence saying when to try again.
  const [limitMsg, setLimitMsg] = useState<string | null>(null);
  // A 429 seen mid-run, so the run can end with that sentence.
  const limitHit = useRef<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  // Async test steps keep resolving after the user leaves; nothing may set
  // state then. Leaving also ABORTS the in-flight request, so a 5 MB download
  // does not keep running (and costing data) behind a screen nobody is on.
  const mounted = useRef(true);
  const abort = useRef(new AbortController());
  useEffect(() => () => { mounted.current = false; abort.current.abort(); }, []);
  const signal = () => abort.current.signal;

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
    if (mounted.current) setConnectionDetails(details);
    return details;
  };

  /**
   * Pick the server: ours when /net/speed answers, Cloudflare otherwise
   * (lib/speedTarget.ts). Returns null when ours refused with a 429 — the test
   * then waits rather than moving to a third party.
   */
  const checkServerStatus = async (): Promise<SpeedTarget | null> => {
    const token = await getAccessToken().catch(() => null);
    if (token) {
      const app = appTarget(SERVER_URL, token);
      let status: number | null = null;
      let retryAfter: string | null = null;
      const start = Date.now();
      try {
        const resp = await fetch(app.downUrl(0), { method: 'HEAD', headers: app.headers, signal: signal() });
        status = resp.status;
        retryAfter = resp.headers.get('Retry-After');
      } catch { /* no answer: fall back below */ }
      const verdict = probeVerdict(status);
      if (verdict === 'rate_limited') {
        limitHit.current = rateLimitMessage(retryAfter);
        if (mounted.current) { setTarget(null); setLimitMsg(limitHit.current); setServerOnline(true); }
        return null;
      }
      if (verdict === 'app') {
        if (mounted.current) { setTarget(app); setLimitMsg(null); setServerOnline(Date.now() - start < 5000); }
        return app;
      }
    }
    const cf = cloudflareTarget();
    if (mounted.current) { setTarget(cf); setLimitMsg(null); }
    try {
      const start = Date.now();
      const resp = await fetch(cf.downUrl(1), { method: 'HEAD', signal: signal() });
      const elapsed = Date.now() - start;
      if (mounted.current) setServerOnline(resp.ok && elapsed < 5000);
    } catch {
      if (mounted.current) setServerOnline(false);
    }
    return cf;
  };

  /** Notes a 429 from our endpoint mid-run; the run then ends with that sentence. */
  const noteLimit = (resp: Response) => {
    if (resp.status === 429) limitHit.current = rateLimitMessage(resp.headers.get('Retry-After'));
  };

  // The list as last loaded or saved. runTest's closure holds `history` as it
  // was when the run STARTED, so saving builds on this ref instead, and the
  // write happens here rather than inside a state updater (which may run twice).
  const historyRef = useRef<TestResult[]>([]);
  const historyUnreadable = useRef(false);
  // Set when a result could not be written; cleared by the next good write.
  const [saveError, setSaveError] = useState<string | null>(null);

  const loadHistory = async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!mounted.current) return;
      historyRef.current = Array.isArray(parsed) ? parsed : [];
      historyUnreadable.current = false;
      setHistory(historyRef.current);
      setHistoryError(false);
    } catch {
      historyUnreadable.current = true;
      if (mounted.current) setHistoryError(true);
    }
  };

  const saveHistory = (result: TestResult) => {
    // An unreadable stored list must not be overwritten by a list of one.
    if (historyUnreadable.current) { setSaveError('This result was not saved, because past results could not be read.'); return; }
    const updated = [result, ...historyRef.current].slice(0, 20);
    historyRef.current = updated;
    setHistory(updated);
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated)).then(
      () => { if (mounted.current) setSaveError(null); },
      () => { if (mounted.current) setSaveError('This result could not be saved on your phone.'); },
    );
  };

  const running = phase !== 'idle' && phase !== 'done' && phase !== 'failed';
  const progressTo = (p: number) => { if (mounted.current) setProgress(p); };

  // ── Ping Test ── (a failed request is not a round trip)
  const testPing = async (t: SpeedTarget) => {
    const trips: (number | null)[] = [];
    for (let i = 0; i < 5; i++) {
      const start = Date.now();
      try {
        const resp = await fetch(t.pingUrl, { cache: 'no-store', headers: t.headers, signal: signal() });
        noteLimit(resp);
        trips.push(resp.ok ? Date.now() - start : null);
      } catch { trips.push(null); }
      progressTo((i + 1) / 5 * 100);
    }
    return pingStats(trips);
  };

  // ── Download Test ── (only bytes actually received count)
  const testDownload = async (t: SpeedTarget): Promise<number | null> => {
    const sizes = [1000000, 2000000, 5000000]; // 1MB, 2MB, 5MB
    const samples: TransferSample[] = [];
    for (let i = 0; i < sizes.length; i++) {
      const start = Date.now();
      try {
        const resp = await fetch(t.downUrl(sizes[i]), { cache: 'no-store', headers: t.headers, signal: signal() });
        noteLimit(resp);
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
  const testUpload = async (t: SpeedTarget): Promise<number | null> => {
    const sizes = [100000, 500000, 1000000]; // 100KB, 500KB, 1MB
    const samples: TransferSample[] = [];
    for (let i = 0; i < sizes.length; i++) {
      const data = new Uint8Array(sizes[i]);
      const start = Date.now();
      try {
        const resp = await fetch(t.upUrl, {
          method: 'POST',
          body: data,
          headers: { ...t.headers, 'Content-Type': 'application/octet-stream' },
          signal: signal(),
        });
        noteLimit(resp);
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
    limitHit.current = null;

    try {
      const connection = await checkConnection();
      // Re-probed only when there is no target yet, or the last probe was a 429.
      const t = target ?? await checkServerStatus();
      if (!mounted.current) return;
      if (!t) { setRunError(limitHit.current ?? 'Too many speed tests. Try again later.'); setPhase('failed'); return; }

      const pg = await testPing(t);
      if (!mounted.current) return;

      setPhase('download');
      setProgress(0);
      const dl = await testDownload(t);
      if (!mounted.current) return;

      setPhase('upload');
      setProgress(0);
      const ul = await testUpload(t);
      if (!mounted.current) return;

      // Our own budget refused part of the run: the figures are incomplete,
      // so say when to try again instead of showing them.
      if (limitHit.current) { setRunError(limitHit.current); setPhase('failed'); return; }

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
    const maxSpeed = 200;
    const ratio = Math.min(speed / maxSpeed, 1);
    // Semicircle from -135deg to 135deg (270 deg arc)
    const needleAngle = -135 + ratio * 270;

    const ticks = [0, 25, 50, 100, 150, 200];

    return (
      <View style={styles.gaugeContainer} accessible accessibilityRole="progressbar"
        accessibilityLabel={phase === 'failed' ? 'Speed test failed' : `${phase === 'upload' ? 'Upload' : 'Download'} ${speed.toFixed(1)} megabits per second`}
        accessibilityValue={running ? { min: 0, max: 100, now: Math.round(progress) } : { text: `${speed.toFixed(1)} Mbps` }}>
        {/* Gauge background arc */}
        <View style={[styles.gauge, { width: GAUGE_SIZE, height: GAUGE_SIZE / 2 + 20 }]}>
          {/* Background semicircle */}
          <View style={styles.gaugeArcBg} />
          {/* Colored arc overlay */}
          <View style={[styles.gaugeArcFill, {
            borderColor: speed > 100 ? colors.primary : speed > 20 ? colors.accent : colors.textDim,
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
        <TouchableOpacity
          accessibilityRole="button" accessibilityLabel="Back" hitSlop={8} style={styles.backBtn}
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/settings'))}
        >
          <Ionicons name="arrow-back" size={20} color={colors.accent} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} accessibilityRole="header">Speed Test</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>

        {/* Connection Info */}
        <View style={styles.connectionRow}>
          <View style={styles.connectionBadge}>
            <Text style={styles.connectionIcon}>{getConnectionIcon()}</Text>
            <Text style={styles.connectionLabel}>{connectionDetails}</Text>
          </View>
          <View style={[styles.serverDot, { backgroundColor: serverOnline === null ? colors.textFaint : serverOnline ? colors.primary : colors.danger }]} />
          <Text style={styles.serverLabel}>
            {serverOnline === null ? 'Checking...' : serverOnline ? 'Test server reachable' : 'Test server unreachable'}
          </Text>
        </View>
        <Text style={styles.disclosure}>
          {target?.kind === 'app'
            ? `Tests run against crazzychat's own server (${target.host}). Nothing is sent to a third party.`
            : target
              ? `Tests run against ${target.host} (Cloudflare), not crazzychat. Cloudflare sees this device's IP address while the test runs.`
              : limitMsg ?? 'Choosing a test server…'}
        </Text>

        {/* Gauge */}
        {renderGauge()}

        {/* Progress bar */}
        {running && (
          <View style={styles.progressBar}>
            <View style={[styles.progressFill, { width: `${progress}%` }]} />
          </View>
        )}

        {/* Test Button */}
        <TouchableOpacity
              onPress={runTest}
              disabled={running}
              style={[styles.testButton, running && styles.testButtonDisabled]}
              accessibilityRole="button"
              accessibilityLabel={running ? 'Speed test running' : phase === 'idle' ? 'Start speed test' : 'Run the speed test again'}
              accessibilityState={{ disabled: running, busy: running }}
            >
              <LinearGradient
                colors={running ? [colors.border, colors.border] : [colors.accent, colors.accentDeep]}
                style={styles.testButtonGradient}
              >
                {running ? (
                  <ActivityIndicator color={colors.text} />
                ) : (
                  <Text style={styles.testButtonText}>{phase === 'idle' ? 'Start Test' : 'Test Again'}</Text>
                )}
              </LinearGradient>
            </TouchableOpacity>

        {/* Failed */}
        {phase === 'failed' && (
          <View style={styles.failedBox} accessibilityRole="alert">
            <Text style={styles.failedTitle}>Test failed</Text>
            <Text style={styles.failedText}>
              {runError ?? `No request reached ${target?.host ?? 'the test server'}. Check your connection and try again.`}
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
              ['Jitter', outcome.jitter, 'ms', colors.purple],
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
          <Text style={styles.sectionTitle} accessibilityRole="header">History</Text>
          {saveError && <Text style={styles.saveError} accessibilityLiveRegion="polite">{saveError}</Text>}
          {historyError ? (
            <TouchableOpacity onPress={loadHistory} accessibilityRole="button" accessibilityLabel="Past results could not be read. Try again">
              <Text style={styles.noHistory}>Past results could not be read. Tap to try again.</Text>
            </TouchableOpacity>
          ) : history.length === 0 ? (
            <Text style={styles.noHistory}>No previous tests</Text>
          ) : (
            history.map(item => (
              <View
                key={item.id} style={styles.historyRow} accessible
                // The arrows and stopwatch are read raw by a screen reader, so the
                // row speaks one sentence instead.
                accessibilityLabel={`${formatDate(item.timestamp)}, ${item.connectionType}: download ${item.download.toFixed(1)}, upload ${item.upload.toFixed(1)} megabits per second, ping ${item.ping} milliseconds`}
              >
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
  backBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: c.glassSoft, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { color: c.text, fontSize: 18, fontWeight: '700' },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16 },

  // Connection
  connectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 10, marginBottom: 16 },
  connectionBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.glassSoft, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8, marginRight: 16, borderWidth: 1, borderColor: c.glassStroke },
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
  gaugeArcBg: { position: 'absolute', top: 0, width: GAUGE_SIZE, height: GAUGE_SIZE, borderRadius: GAUGE_SIZE / 2, borderWidth: GAUGE_STROKE, borderColor: c.glassStroke },
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
  progressBar: { height: 4, backgroundColor: c.glassSoft, borderRadius: 2, marginVertical: 12, overflow: 'hidden' },
  progressFill: { height: 4, backgroundColor: c.accent, borderRadius: 2 },

  // Test Button
  testButton: { borderRadius: 14, overflow: 'hidden', marginVertical: 16, elevation: 4, shadowColor: c.accent, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 10 },
  testButtonDisabled: { opacity: 0.7 },
  testButtonGradient: { paddingVertical: 16, alignItems: 'center', borderRadius: 14 },
  // White on the brand-blue gradient (accent → accentDeep) in both themes.
  testButtonText: { color: '#FFF', fontSize: 18, fontWeight: '800', letterSpacing: 1 },

  // Results
  resultsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 16 },
  resultCard: { width: (SW - 42) / 2, backgroundColor: c.glassSoft, borderRadius: 14, padding: 16, alignItems: 'center', borderWidth: 1, borderColor: c.glassStroke, borderLeftWidth: 3 },
  resultLabel: { color: c.textDim, fontSize: 12, marginBottom: 4 },
  resultValue: { color: c.text, fontSize: 28, fontWeight: '800' },
  resultUnit: { color: c.textDim, fontSize: 12, marginTop: 2 },

  // History
  section: { marginTop: 20 },
  sectionTitle: { color: c.text, fontSize: 16, fontWeight: '700', marginBottom: 12 },
  noHistory: { color: c.textDim, fontSize: 13, textAlign: 'center', marginTop: 8 },
  saveError: { color: c.danger, fontSize: 13, marginBottom: 8 },
  historyRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: c.glassSoft, borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: c.hairline },
  historyLeft: { flex: 1 },
  historyDate: { color: c.text, fontSize: 13, fontWeight: '600' },
  historyConn: { color: c.textDim, fontSize: 11, marginTop: 2 },
  historyRight: { flexDirection: 'row', gap: 14 },
  historyMetric: { alignItems: 'center' },
  historyMetricLabel: { color: c.accent, fontSize: 12 },
  historyMetricValue: { color: c.text, fontSize: 13, fontWeight: '700', marginTop: 2 },
});
