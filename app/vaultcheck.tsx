// app/vaultcheck.tsx — VaultCheck result screen.
//
// Opened from a message long-press ("Verify") or the media viewer. Runs the
// authenticity layers on-device and shows the verdict plus a per-layer
// breakdown the user can read and share.
//
// The copy here is load-bearing. This screen is what someone shows their family
// or the police when a fabricated image of them is circulating, so it states
// what was checked, what was NOT checked, and the limits of the answer — every
// time, not only when the news is bad.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, ActivityIndicator, TouchableOpacity, Share, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';
import { getMedia } from '../lib/mediaStore';
import { verifyMedia, formatReport, type VaultCheckReport } from '../lib/vaultcheck';

const VERDICT_STYLE: Record<string, { icon: any; color: string; label: string }> = {
  'likely-authentic': { icon: 'shield-checkmark', color: '#00D4AA', label: 'LIKELY AUTHENTIC' },
  'unknown':          { icon: 'help-circle',      color: '#FFC53D', label: 'NOT VERIFIED' },
  'likely-fake':      { icon: 'alert-circle',     color: '#FF3C6E', label: 'ALTERED' },
};

export default function VaultCheckScreen() {
  const { colors } = useTheme();
  const S = useMemo(() => makeStyles(colors), [colors]);
  const { attachmentId, uri, msgType, mime, filename, isMine } = useLocalSearchParams();

  const kind: 'image' | 'video' = msgType === 'video' ? 'video' : 'image';
  const [report, setReport] = useState<VaultCheckReport | null>(null);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Resolve to a local file first — VaultCheck never uploads the media,
        // so everything below works on bytes already on this device.
        let local = uri ? String(uri) : '';
        if (!local && attachmentId) {
          local = await getMedia(String(attachmentId), {
            kind,
            isMine: isMine === '1',
            mime: mime ? String(mime) : undefined,
            filename: filename ? String(filename) : undefined,
          });
        }
        if (!local) throw new Error('Could not locate the media on this device');
        const r = await verifyMedia(local, kind);
        if (!cancelled) setReport(r);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Verification failed');
      }
    })();
    return () => { cancelled = true; };
  }, [attachmentId, uri, kind, mime, filename, isMine]);

  const onShare = useCallback(async () => {
    if (!report) return;
    try { await Share.share({ message: formatReport(report) }); }
    catch { Alert.alert('Could not share', 'Try again.'); }
  }, [report]);

  const v = report ? VERDICT_STYLE[report.verdict] : null;

  return (
    <>
      <Stack.Screen options={{ title: 'Verify media', headerBackTitle: 'Back' }} />
      <ScrollView style={S.page} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        {!report && !error && (
          <View style={S.loading}>
            <ActivityIndicator color={colors.primary} size="large" />
            <Text style={S.loadingTxt}>Checking on this device…</Text>
            <Text style={S.loadingHint}>
              Nothing is uploaded. The analysis runs entirely on your phone.
            </Text>
          </View>
        )}

        {!!error && (
          <View style={S.card}>
            <Ionicons name="warning-outline" size={28} color="#FF3C6E" />
            <Text style={S.cardTitle}>Could not check this file</Text>
            <Text style={S.cardBody}>{error}</Text>
          </View>
        )}

        {report && v && (
          <>
            <View style={[S.verdict, { borderColor: v.color }]}>
              <Ionicons name={v.icon} size={40} color={v.color} />
              <Text style={[S.verdictLabel, { color: v.color }]}>{v.label}</Text>
              <Text style={S.verdictHeadline}>{report.headline}</Text>
              <Text style={S.verdictDetail}>{report.detail}</Text>
            </View>

            {/* ── C2PA ── */}
            <View style={S.card}>
              <View style={S.rowHead}>
                <Ionicons name="ribbon-outline" size={18} color={colors.text} />
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
                    <Row key={i} label="Action" value={a.action + (a.when ? ` · ${a.when}` : '')} S={S} />
                  ))}
                </>
              )}
            </View>

            {/* ── rPPG ── */}
            {!!report.rppg && (
              <View style={S.card}>
                <View style={S.rowHead}>
                  <Ionicons name="heart-outline" size={18} color={colors.text} />
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
                  <Ionicons name="information-circle-outline" size={18} color={colors.textDim} />
                  <Text style={[S.cardTitle, { color: colors.textDim }]}>Not checked</Text>
                </View>
                {report.notChecked.map((n, i) => (
                  <Text key={i} style={S.cardBody}>• {n}</Text>
                ))}
              </View>
            )}

            <TouchableOpacity style={S.shareBtn} onPress={onShare} activeOpacity={0.85}>
              <Ionicons name="share-outline" size={16} color="#000" />
              <Text style={S.shareTxt}>Share this report</Text>
            </TouchableOpacity>

            <Text style={S.disclaimer}>
              This is a technical opinion produced on your device, not proof. It is
              not a forensic examination and does not replace expert testimony.
            </Text>
          </>
        )}
      </ScrollView>
    </>
  );
}

function Row({ label, value, S }: { label: string; value: string; S: any }) {
  return (
    <View style={S.row}>
      <Text style={S.rowLabel}>{label}</Text>
      <Text style={S.rowValue} numberOfLines={3}>{value}</Text>
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
  shareTxt: { color: '#000', fontSize: 14, fontWeight: '800' },
  disclaimer: { color: c.textDim, fontSize: 11, lineHeight: 16, textAlign: 'center', marginTop: 14 },
});
