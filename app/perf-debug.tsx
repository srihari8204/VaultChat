// app/perf-debug.tsx — hidden diagnostics screen (Task 1).
//
// Reached by long-pressing the version string in Profile. Shows the live
// socket transport + connection state, the reconnect count this session, and
// the last 20 send timings (tap→encrypt, encrypt→ack in ms). Refreshes on a
// 1s tick while open. Purely a read-out of lib/perf's in-memory ring buffer —
// no network, no persistence.

import { HEADER_TOP, SCREEN_BOTTOM } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { recentMarks, recentSends, snapshot, type SendTiming } from '../lib/perf';
import { ccwireDiagnostics } from '../lib/ccwire/transport';
import { featureFlagDiagnostics, TRANSPORT_RUST } from '../lib/featureFlags';
import { AuroraBackground } from '../components/ui';

type Styles = ReturnType<typeof makeStyles>;

export default function PerfDebugScreen() {
  const { colors } = useTheme();
  // Amber for "slow"/"warning": the palette's warning token, AA on both grounds.
  const S = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const slow = (total?: number) => (total != null && total > 1500 ? S.slow : undefined);

  const [snap, setSnap] = useState(snapshot());
  const [sends, setSends] = useState<SendTiming[]>(recentSends(20));
  const [wire, setWire] = useState(ccwireDiagnostics());

  useEffect(() => {
    const id = setInterval(() => {
      setSnap(snapshot());
      setSends(recentSends(20));
      setWire(ccwireDiagnostics());
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Boot marks are written once at startup and never change, so unlike the rows
  // above they are read a single time rather than on the 1s tick.
  const boot = useMemo(() => {
    const marks = recentMarks(200).filter(m => m.event.startsWith('boot_') || m.event === 'db_ready');
    if (!marks.length) return [];
    const t0 = marks[0].t;
    return marks.map(m => ({ event: m.event, offset: m.t - t0 }));
  }, []);

  const transportBad = snap.transport === 'polling';

  return (
    <View style={S.screen}>
      <AuroraBackground />
      <View style={S.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/profile'))} hitSlop={10} style={S.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.title} accessibilityRole="header">Diagnostics</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 24 + SCREEN_BOTTOM }}>
        {/* Connection */}
        <Text style={S.section} accessibilityRole="header">Connection</Text>
        <View style={S.card}>
          <Row S={S} k="Transport" v={snap.transport} bad={transportBad} />
          <Row S={S} k="State" v={snap.connState} bad={snap.connState !== 'connected'} />
          <Row S={S} k="Reconnects (session)" v={String(snap.reconnects)} />
          <Row S={S} k="CC-Wire cohort" v={featureFlagDiagnostics(TRANSPORT_RUST).enabled ? 'Enabled' : 'Disabled'} />
          <Row S={S} k="CC-Wire state" v={wire.status} />
          <Row S={S} k="CC-Wire carrier" v={wire.carrier} />
          {/* NOT frame counters. These three move only for an eligible
              outbound plain-text chat submission (lib/ccwire/transport.ts
              submitCCWireMessage); a healthy session that exchanged a hundred
              frames still reads 0 / 0 if no text was sent. Frames in/out below
              is the answer to "did CC-Wire carry anything". Likewise
              "text sends that fell back": when CC-Wire is not ready the send
              goes straight to HTTP WITHOUT incrementing, so 0 here does not
              mean HTTP was unused. */}
          <Row S={S} k="Text submits / acks (ccwire)" v={`${wire.submitted} / ${wire.acknowledged}`} />
          <Row S={S} k="Text sends that fell back" v={String(wire.fallbacks)} />
          <Row S={S} k="Frames in / out" v={`${wire.framesIn ?? '-'} / ${wire.framesOut ?? '-'}`} />
          <Row S={S} k="Bytes in / out" v={`${wire.bytesIn ?? '-'} / ${wire.bytesOut ?? '-'}`} />
          <Row S={S} k="Decode fails / encode refusals"
            v={`${wire.decodeFailures ?? '-'} / ${wire.encodeRefusals ?? '-'}`}
            bad={!!(wire.decodeFailures || wire.encodeRefusals)} />
          <Row S={S} k="Pre-handshake closes" v={String(wire.preHandshakeCloses ?? '-')}
            bad={(wire.preHandshakeCloses ?? 0) > 0} />
          {!!wire.lastError && <Row S={S} k="Last transport error" v={wire.lastError} bad />}
        </View>
        {transportBad && (
          <Text style={S.warn}>⚠️ On POLLING — websocket failed to negotiate. Sends will be slow.</Text>
        )}

        {/* Boot timeline — cold-start cost, measured rather than assumed.
            Offsets are relative to the first mark, so the number that matters
            is where boot_unblocked lands: that is when the first render stopped
            being gated. Anything at or after boot_deferred_start is work that
            was deliberately moved OFF the startup path and is not felt. */}
        <Text style={S.section} accessibilityRole="header">Boot timeline</Text>
        <View style={S.card}>
          {boot.length === 0 ? (
            <Text style={S.empty}>No boot marks — this build predates them.</Text>
          ) : boot.map((b, i) => (
            <View key={`${b.event}-${i}`} style={S.trow} accessible accessibilityLabel={`${b.event}, ${b.offset} milliseconds after the first mark`}>
              <Text style={[S.td, { flex: 3 }]} numberOfLines={1}>{b.event}</Text>
              {/* Deferred work is SUPPOSED to land late — flagging it as slow
                  would invert the meaning of the change that moved it there. */}
              <Text style={[S.td, b.event === 'boot_deferred_start' ? undefined : slow(b.offset)]}>
                +{b.offset}ms
              </Text>
            </View>
          ))}
        </View>

        {/* Send timings */}
        <Text style={S.section} accessibilityRole="header">Last {sends.length} sends</Text>
        <View style={S.card}>
          {/* Each row below reads as one sentence, so the column header is visual only. */}
          <View style={[S.trow, S.thead]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Text style={[S.th, { flex: 2 }]}>id</Text>
            <Text style={S.th}>tap→enc</Text>
            <Text style={S.th}>enc→ack</Text>
            <Text style={S.th}>total</Text>
          </View>
          {sends.length === 0 ? (
            <Text style={S.empty}>No sends yet — send a message, then come back.</Text>
          ) : sends.map((s, i) => (
            <View key={`${s.id}-${i}`} style={S.trow} accessible
              accessibilityLabel={`Send ${s.id} via ${s.transport ?? 'unknown'}: tap to encrypt ${ms(s.tapToEncrypt)}, encrypt to acknowledgement ${ms(s.encryptToAck)}, ${s.failed ? 'failed' : `total ${ms(s.totalMs)}`}`}>
              <Text style={[S.td, { flex: 2 }]} numberOfLines={2}>{s.id}{'\n'}{s.transport ?? 'unknown'}</Text>
              <Text style={S.td}>{ms(s.tapToEncrypt)}</Text>
              <Text style={S.td}>{ms(s.encryptToAck)}</Text>
              <Text style={[S.td, s.failed ? S.tdFail : slow(s.totalMs)]}>
                {s.failed ? 'FAIL' : ms(s.totalMs)}
              </Text>
            </View>
          ))}
        </View>

        <Text style={S.note}>
          “tap→enc” = E2EE encryption time (X3DH/ratchet). “enc→ack” = server acknowledgement time.
          A large tap→enc means the peer key-bundle fetch is the bottleneck.
        </Text>
      </ScrollView>
    </View>
  );
}

function Row({ S, k, v, bad }: { S: Styles; k: string; v: string; bad?: boolean }) {
  return (
    <View style={S.kv} accessible accessibilityLabel={`${k}: ${v}`}>
      <Text style={S.k}>{k}</Text>
      <Text style={[S.v, bad && S.vBad]}>{v}</Text>
    </View>
  );
}

function ms(n?: number): string { return n == null ? '—' : `${n}ms`; }

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  header:  { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: HEADER_TOP, paddingBottom: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  backBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title:   { color: c.text, fontSize: 22, fontWeight: '800' },

  section: { color: c.textDim, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', marginTop: 20, marginBottom: 8, letterSpacing: 0.5 },
  card:    { backgroundColor: c.glassSoft, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke, overflow: 'hidden' },

  kv:   { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  k:    { color: c.textDim, fontSize: 14 },
  v:    { color: c.text, fontSize: 14, fontWeight: '600' },
  vBad: { color: c.danger },

  trow:  { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  thead: { backgroundColor: c.bg },
  th:    { flex: 1, color: c.textDim, fontSize: 11, fontWeight: '700' },
  td:    { flex: 1, color: c.text, fontSize: 12, fontVariant: ['tabular-nums'] },
  tdFail:{ color: c.danger, fontWeight: '700' },

  slow:  { color: c.warning },
  warn:  { color: c.warning, fontSize: 12, marginTop: 8, paddingHorizontal: 4 },
  empty: { color: c.textDim, fontSize: 13, padding: 14 },
  note:  { color: c.textDim, fontSize: 11, lineHeight: 16, marginTop: 16, paddingHorizontal: 4 },
});
