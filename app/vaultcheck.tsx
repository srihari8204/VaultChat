// app/vaultcheck.tsx — VaultCheck result screen.
//
// Opened from a message long-press ("Verify", app/chat.tsx). Runs the
// authenticity layers on-device and shows the verdict plus a per-layer
// breakdown the user can read and share.
//
// The copy here is load-bearing. This screen is what someone shows their family
// or the police when a fabricated image of them is circulating, so it states
// what was checked, what was NOT checked, and the limits of the answer — every
// time, not only when the news is bad.

import { AppText as Text } from '../components/ui/Text';
import { AuroraBackground } from '../components/ui';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, ScrollView, StyleSheet, ActivityIndicator, TouchableOpacity, Share, Alert, AccessibilityInfo,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';
import { getMedia } from '../lib/mediaStore';
import { verifyMedia, formatReport, type VaultCheckReport } from '../lib/vaultcheck';
import { userErrorText } from '../lib/userErrorText';

type IconName = React.ComponentProps<typeof Ionicons>['name'];
// Colours are palette ROLES so they keep contrast in both themes: success,
// danger, and a neutral for "not verified" (it is not a warning, just no answer).
const VERDICT_STYLE: Record<VaultCheckReport['verdict'], { icon: IconName; tone: 'success' | 'textDim' | 'danger'; label: string }> = {
  'likely-authentic': { icon: 'shield-checkmark', tone: 'success', label: 'LIKELY AUTHENTIC' },
  'unknown':          { icon: 'help-circle',      tone: 'textDim', label: 'NOT VERIFIED' },
  'likely-fake':      { icon: 'alert-circle',     tone: 'danger',  label: 'ALTERED' },
};

// A long video analysis should end in an answer, not an endless spinner.
const CHECK_TIMEOUT_MS = 120_000;

export default function VaultCheckScreen() {
  const { colors } = useTheme();
  const S = useMemo(() => makeStyles(colors), [colors]);
  // Only an attachment id is accepted: the old `uri` param read any path it
  // was given, and no caller passes it.
  const { attachmentId, msgType, mime, filename, isMine } = useLocalSearchParams();

  const kind: 'image' | 'video' = msgType === 'video' ? 'video' : 'image';
  const [report, setReport] = useState<VaultCheckReport | null>(null);
  const [error, setError] = useState<string>('');
  const [attempt, setAttempt] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  // A timeout only stops WAITING: the running analysis is kept here and Try
  // again waits on it again instead of starting a second one alongside it.
  // Leaving the screen cancels it (between stages — lib/vaultcheck).
  const inflight = useRef<{ key: string; p: Promise<VaultCheckReport> } | null>(null);
  const left = useRef(false);
  useEffect(() => () => { left.current = true; }, []);
  // Screen readers get one progress update on a long check (the elapsed
  // counter is deliberately not a live region).
  useEffect(() => {
    if (elapsed === 30) AccessibilityInfo.announceForAccessibility('Still checking. This can take a minute or two.');
  }, [elapsed]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setReport(null);
    setError('');
    setElapsed(0);
    const started = Date.now();
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    (async () => {
      try {
        // Resolve to a local file first — VaultCheck never uploads the media,
        // so everything below works on bytes already on this device.
        const id = typeof attachmentId === 'string' ? attachmentId : '';
        if (!id) throw new Error('No media was given to check.');
        const local = await getMedia(id, {
          kind,
          isMine: isMine === '1',
          mime: mime ? String(mime) : undefined,
          filename: filename ? String(filename) : undefined,
        });
        if (!local) throw new Error('Could not locate the media on this device');
        const key = `${local}|${kind}`;
        let run = inflight.current?.key === key ? inflight.current.p : null;
        if (!run) {
          const p = verifyMedia(local, kind, () => left.current);
          inflight.current = { key, p };
          p.catch(() => {}).finally(() => { if (inflight.current?.p === p) inflight.current = null; });
          run = p;
        }
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('The check is taking too long. It is still running on this device — Try again to keep waiting for it, or try a shorter clip.')), CHECK_TIMEOUT_MS);
        });
        const r = await Promise.race([run, timeout]);
        if (!cancelled) setReport(r);
      } catch (e: unknown) {
        if (!cancelled) setError(userErrorText(e, 'Verification failed. Try again.'));
      } finally {
        clearInterval(tick);
        if (timer) clearTimeout(timer);
      }
    })();
    return () => { cancelled = true; clearInterval(tick); if (timer) clearTimeout(timer); };
  }, [attachmentId, kind, mime, filename, isMine, attempt]);

  const onShare = useCallback(async () => {
    if (!report) return;
    try { await Share.share({ message: formatReport(report) }); }
    catch { Alert.alert('Could not share', 'Try again.'); }
  }, [report]);

  const v = report ? VERDICT_STYLE[report.verdict] : null;
  const vColor = v ? colors[v.tone] : colors.textDim;

  return (
    <>
      <Stack.Screen options={{
        headerShown: true, /* the root Stack sets headerShown:false app-wide, so the options below were inert and this screen had no back control at all */  title: 'Verify media', headerBackTitle: 'Back', headerStyle: { backgroundColor: colors.surfaceSolid }, headerTintColor: colors.text }} />
      <View style={S.page}>
      <AuroraBackground />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        {!report && !error && (
          <View style={S.loading}>
            <ActivityIndicator color={colors.primary} size="large" />
            <Text style={S.loadingTxt}>Checking on this device…</Text>
            <Text style={S.loadingHint}>
              Nothing is uploaded. The analysis runs entirely on your phone.
              {kind === 'video' ? ' A video can take up to a minute or two.' : ''}
            </Text>
            {elapsed >= 3 && (
              <Text style={S.loadingHint}>{elapsed}s elapsed</Text>
            )}
          </View>
        )}

        {!!error && (
          <View style={S.card} accessibilityRole="alert">
            <Ionicons name="warning-outline" size={28} color={colors.danger} importantForAccessibility="no" accessibilityElementsHidden />
            <Text style={S.cardTitle}>Could not check this file</Text>
            <Text style={S.cardBody}>{error}</Text>
            <Text style={S.cardBody}>
              If the file has not finished downloading, open it in the chat first, then try again.
            </Text>
            <TouchableOpacity style={S.retryBtn} onPress={() => setAttempt((a) => a + 1)} activeOpacity={0.8}
              accessibilityRole="button" accessibilityLabel="Try checking this file again">
              <Text style={S.retryTxt}>Try again</Text>
            </TouchableOpacity>
          </View>
        )}

        {report && v && (
          <>
            <View style={[S.verdict, { borderColor: vColor }]}>
              <Ionicons name={v.icon} size={40} color={vColor} importantForAccessibility="no" accessibilityElementsHidden />
              <Text style={[S.verdictLabel, { color: vColor }]} accessibilityRole="header">{v.label}</Text>
              <Text style={S.verdictHeadline}>{report.headline}</Text>
              <Text style={S.verdictDetail}>{report.detail}</Text>
            </View>

            {/* ── C2PA ── */}
            <View style={S.card}>
              <View style={S.rowHead}>
                <Ionicons name="ribbon-outline" size={18} color={colors.text} importantForAccessibility="no" accessibilityElementsHidden />
                <Text style={S.cardTitle}>Content Credentials</Text>
              </View>
              {!report.c2pa.present ? (
                <Text style={S.cardBody}>
                  No credentials embedded. This is normal — most phone cameras and
                  every screenshot produce files without them, so their absence is
                  not a sign of anything.
                </Text>
              ) : (
                <>
                  <Row label="Generator" value={report.c2pa.generator ?? 'unknown'} S={S} />
                  <Row label="Signature" value={report.c2pa.signature} S={S} />
                  <Row label="Content binding" value={report.c2pa.binding} S={S} />
                  {!!report.c2pa.signerName && <Row label="Signer" value={report.c2pa.signerName} S={S} />}
                  <Row label="Issuer trust" value="not checked against a trust list" S={S} />
                  {report.c2pa.actions.map((a, i) => (
                    <Row key={`${i}:${a.action}:${a.when ?? ''}`} label="Action" value={a.action + (a.when ? ` · ${a.when}` : '')} S={S} />
                  ))}
                </>
              )}
            </View>

            {/* ── rPPG ── */}
            {!!report.rppg && (
              <View style={S.card}>
                <View style={S.rowHead}>
                  <Ionicons name="heart-outline" size={18} color={colors.text} importantForAccessibility="no" accessibilityElementsHidden />
                  <Text style={S.cardTitle}>Heartbeat analysis</Text>
                </View>
                <Row label="Result" value={report.rppg.verdict} S={S} />
                {!!report.rppg.bpm && <Row label="Rate" value={`${report.rppg.bpm} BPM`} S={S} />}
                {!!report.rppg.fps && <Row label="Sampled" value={`${report.rppg.frames} frames · ${report.rppg.fps.toFixed(1)} fps`} S={S} />}
                {!!report.rppg.reason && <Text style={S.cardBody}>{report.rppg.reason}</Text>}
              </View>
            )}

            {/* ── what wasn't checked ── */}
            {report.notChecked.length > 0 && (
              <View style={[S.card, S.cardMuted]}>
                <View style={S.rowHead}>
                  <Ionicons name="information-circle-outline" size={18} color={colors.textDim} importantForAccessibility="no" accessibilityElementsHidden />
                  <Text style={[S.cardTitle, { color: colors.textDim }]}>Not checked</Text>
                </View>
                {report.notChecked.map((n, i) => (
                  <Text key={`${i}:${n}`} style={S.cardBody}>• {n}</Text>
                ))}
              </View>
            )}

            <TouchableOpacity style={S.shareBtn} onPress={onShare} activeOpacity={0.85}
              accessibilityRole="button" accessibilityLabel="Share this report">
              <Ionicons name="share-outline" size={16} color={colors.onPrimary} importantForAccessibility="no" accessibilityElementsHidden />
              <Text style={S.shareTxt}>Share this report</Text>
            </TouchableOpacity>

            <Text style={S.disclaimer}>
              This is a technical opinion produced on your device, not proof. It is
              not a forensic examination and does not replace expert testimony.
            </Text>
          </>
        )}
      </ScrollView>
      </View>
    </>
  );
}

function Row({ label, value, S }: { label: string; value: string; S: ReturnType<typeof makeStyles> }) {
  // No line cap: a signer name or an action list can be long, and a truncated
  // line in a report people share as evidence would hide part of the answer.
  return (
    <View style={S.row}>
      <Text style={S.rowLabel}>{label}</Text>
      <Text style={S.rowValue}>{value}</Text>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  page: { flex: 1, backgroundColor: c.bg },
  loading: { alignItems: 'center', paddingVertical: 60, gap: 10 },
  loadingTxt: { color: c.text, fontSize: 15, fontWeight: '700' },
  loadingHint: { color: c.textDim, fontSize: 12, textAlign: 'center', paddingHorizontal: 30 },

  verdict: {
    alignItems: 'center', gap: 8, padding: 20, borderRadius: 18,
    borderWidth: 2, backgroundColor: c.glassSoft, marginBottom: 14,
  },
  verdictLabel: { fontSize: 13, fontWeight: '900', letterSpacing: 1 },
  verdictHeadline: { color: c.text, fontSize: 17, fontWeight: '800', textAlign: 'center' },
  verdictDetail: { color: c.textDim, fontSize: 13, lineHeight: 19, textAlign: 'center' },

  card: {
    backgroundColor: c.glassSoft, borderRadius: 14, padding: 14, marginBottom: 12,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke, gap: 6,
  },
  cardMuted: { opacity: 0.85 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  cardTitle: { color: c.text, fontSize: 14, fontWeight: '800' },
  cardBody: { color: c.textDim, fontSize: 12.5, lineHeight: 18 },

  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 3 },
  rowLabel: { color: c.textDim, fontSize: 12.5 },
  rowValue: { color: c.text, fontSize: 12.5, fontWeight: '600', flexShrink: 1, textAlign: 'right' },

  shareBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: c.primary, borderRadius: 14, paddingVertical: 14, marginTop: 4,
  },
  shareTxt: { color: c.onPrimary, fontSize: 14, fontWeight: '800' },
  retryBtn: { alignSelf: 'flex-start', minHeight: 44, paddingHorizontal: 18, marginTop: 4, justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: c.glassStroke, backgroundColor: c.glass },
  retryTxt: { color: c.primary, fontWeight: '700' },
  disclaimer: { color: c.textDim, fontSize: 12, lineHeight: 16, textAlign: 'center', marginTop: 14 },
});
