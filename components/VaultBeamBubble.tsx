// components/VaultBeamBubble.tsx — in-chat card for a VaultBeam large-file
// transfer (type='vaultbeam'). Renders the sender's live upload progress and the
// recipient's Accept → download → Open flow, driven by the runtime transfer
// state in lib/vaultBeamController (subscribed per-transferId, so a progress
// tick never re-renders the whole message list).
//
// The card's filename/size come from the E2EE manifest (decrypted `plain`), so
// the server never sees them. 1:1 only (v1).

import React, { useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { BRAND_ACCENT } from '../constants/theme';
import {
  useTransfer, parseManifest, startReceive, cancelTransfer, openSaved,
} from '../lib/vaultBeamController';

function fmtBytes(n: number): string {
  if (!n || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
const fmtRate = (bps?: number) => (bps && bps > 0 ? `${fmtBytes(bps)}/s` : null);
function fmtEta(sec?: number): string | null {
  if (sec == null || !isFinite(sec) || sec <= 0) return null;
  const s = Math.round(sec);
  if (s < 60) return `${s}s left`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left`;
}

export default function VaultBeamBubble({
  msg, isMine, plain,
}: {
  msg: { meta?: any; content?: string | null; senderId?: string };
  isMine: boolean;
  plain: string;       // decrypted message content (the manifest JSON)
}) {
  const { colors } = useTheme();
  const transferId: string | undefined = msg.meta?.transferId;
  const st = useTransfer(transferId);
  const manifest = parseManifest(plain);

  const name = manifest?.name ?? st?.name ?? 'File';
  const totalBytes = manifest?.size || Number(msg.meta?.size) || st?.totalBytes || 0;
  const pct = st && st.total > 0
    ? Math.min(100, Math.round((st.done / st.total) * 100))
    : (st && st.totalBytes > 0 ? Math.min(100, Math.round((st.bytes / st.totalBytes) * 100)) : 0);
  const status = st?.status;
  const active = status === 'uploading' || status === 'receiving';

  const onAccept = useCallback(async () => {
    if (!transferId || !manifest || !msg.senderId) { Alert.alert('Transfer unavailable', 'This transfer can’t be opened yet — try again in a moment.'); return; }
    try { await startReceive({ transferId, manifest, peerId: msg.senderId }); }
    catch (e: any) { Alert.alert('Download failed', e?.message ?? 'Try again'); }
  }, [transferId, manifest, msg.senderId]);

  const onCancel = useCallback(() => { if (transferId) cancelTransfer(transferId); }, [transferId]);
  const onOpen = useCallback(async () => {
    if (st?.savedPath) { try { await openSaved(st.savedPath); } catch (e: any) { Alert.alert('Cannot open', e?.message ?? 'No handler for this file type'); } }
  }, [st?.savedPath]);

  // Status line + optional trailing action, per role × status.
  // Live meter (rate/ETA) comes from verified progress only — same truth as the bar.
  const meter = active ? [fmtRate(st?.rateBps), fmtEta(st?.etaSec)].filter(Boolean).join(' · ') : '';
  const avg = fmtRate(st?.avgBps);
  let line = fmtBytes(totalBytes);
  let action: React.ReactNode = null;

  if (isMine) {
    if (status === 'uploading') { line = `${st?.tier === 'relay' ? 'Uploading via relay' : 'Sending direct'}… ${pct}%${meter ? ` · ${meter}` : ''}`; action = <CancelBtn onPress={onCancel} colors={colors} />; }
    else if (status === 'sent') { line = `${fmtBytes(totalBytes)} · Sent`; action = <Ionicons name="checkmark-done" size={18} color={colors.textDim} />; }
    else if (status === 'complete') { line = `${fmtBytes(totalBytes)} · Delivered${avg ? ` · avg ${avg}` : ''}`; action = <Ionicons name="checkmark-done" size={18} color={BRAND_ACCENT} />; }
    else if (status === 'failed') { line = st?.error ? `Upload failed — ${st.error}` : 'Upload failed'; }
    else if (status === 'cancelled') { line = 'Cancelled'; }
    else { line = `${fmtBytes(totalBytes)} · Sent`; action = <Ionicons name="cloud-upload-outline" size={18} color={colors.textDim} />; }
  } else {
    if (status === 'receiving') { line = `${st?.tier === 'relay' ? 'Downloading via relay' : 'Receiving direct'}… ${pct}%${meter ? ` · ${meter}` : ''}`; action = <CancelBtn onPress={onCancel} colors={colors} />; }
    else if (status === 'complete') { line = `${fmtBytes(totalBytes)} · Saved${avg ? ` · avg ${avg}` : ''}`; action = <PillBtn label="Open" icon="open-outline" onPress={onOpen} colors={colors} />; }
    else if (status === 'failed') { line = st?.error ? `Failed — ${st.error}` : 'Download failed'; action = <PillBtn label="Retry" icon="refresh" onPress={onAccept} colors={colors} />; }
    else if (status === 'cancelled') { line = 'Cancelled'; action = <PillBtn label="Accept" icon="download-outline" onPress={onAccept} colors={colors} />; }
    else { line = fmtBytes(totalBytes); action = <PillBtn label="Accept" icon="download-outline" onPress={onAccept} colors={colors} disabled={!manifest} />; }
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <View style={[styles.iconWrap, { backgroundColor: colors.surface }]}>
          {active
            ? <ActivityIndicator size="small" color={BRAND_ACCENT} />
            : <Ionicons name="cube-outline" size={22} color={BRAND_ACCENT} />}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>{name}</Text>
          <Text style={[styles.sub, { color: colors.textDim }]} numberOfLines={1}>{line}</Text>
        </View>
        {action}
      </View>
      {active && (
        <View style={[styles.track, { backgroundColor: colors.border }]}>
          <View style={[styles.fill, { width: `${pct}%`, backgroundColor: BRAND_ACCENT }]} />
        </View>
      )}
      <Text style={[styles.tag, { color: colors.textFaint ?? colors.textDim }]}>🔒 VaultBeam · end-to-end encrypted</Text>
    </View>
  );
}

function CancelBtn({ onPress, colors }: { onPress: () => void; colors: any }) {
  return (
    <TouchableOpacity onPress={onPress} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={styles.cancelBtn}>
      <Ionicons name="close" size={18} color={colors.textDim} />
    </TouchableOpacity>
  );
}

function PillBtn({ label, icon, onPress, colors, disabled }: {
  label: string; icon: any; onPress: () => void; colors: any; disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.8}
      style={[styles.pill, { borderColor: BRAND_ACCENT, opacity: disabled ? 0.4 : 1 }]}
    >
      <Ionicons name={icon} size={14} color={BRAND_ACCENT} />
      <Text style={[styles.pillTxt, { color: BRAND_ACCENT }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  wrap: { minWidth: 220, maxWidth: 300, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  iconWrap: { width: 42, height: 42, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  name: { fontSize: 14, fontWeight: '700' },
  sub: { fontSize: 12, marginTop: 2 },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2 },
  tag: { fontSize: 9, letterSpacing: 0.3, marginTop: 1 },
  cancelBtn: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 16, paddingHorizontal: 10, paddingVertical: 5 },
  pillTxt: { fontSize: 12, fontWeight: '700' },
});
