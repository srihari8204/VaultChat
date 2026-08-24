// app/perf-debug.tsx — hidden diagnostics screen (Task 1).
//
// Reached by long-pressing the version string in Profile. Shows the live
// socket transport + connection state, the reconnect count this session, and
// the last 20 send timings (tap→encrypt, encrypt→ack in ms). Refreshes on a
// 1s tick while open. Purely a read-out of lib/perf's in-memory ring buffer —
// no network, no persistence.

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import perf, { type SendTiming } from '../lib/perf';

export default function PerfDebugScreen() {
  const { colors } = useTheme();
  const S = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();

  const [snap, setSnap] = useState(perf.snapshot());
  const [sends, setSends] = useState<SendTiming[]>(perf.recentSends(20));

  useEffect(() => {
    const id = setInterval(() => {
      setSnap(perf.snapshot());
      setSends(perf.recentSends(20));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Boot marks are written once at startup and never change, so unlike the rows
  // above they are read a single time rather than on the 1s tick.
  const boot = useMemo(() => {
    const marks = perf.recentMarks(200).filter(m => m.event.startsWith('boot_') || m.event === 'db_ready');
    if (!marks.length) return [];
    const t0 = marks[0].t;
    return marks.map(m => ({ event: m.event, offset: m.t - t0 }));
  }, []);

  const transportBad = snap.transport === 'polling';

  return (
    <View style={S.screen}>
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={S.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.title}>Diagnostics</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
        {/* Connection */}
        <Text style={S.section}>Connection</Text>
        <View style={S.card}>
          <Row S={S} k="Transport" v={snap.transport} bad={transportBad} />
          <Row S={S} k="State" v={snap.connState} bad={snap.connState !== 'connected'} />
          <Row S={S} k="Reconnects (session)" v={String(snap.reconnects)} />
        </View>
        {transportBad && (
          <Text style={S.warn}>⚠️ On POLLING — websocket failed to negotiate. Sends will be slow.</Text>
        )}

        {/* Boot timeline — cold-start cost, measured rather than assumed.
            Offsets are relative to the first mark, so the number that matters
            is where boot_unblocked lands: that is when the first render stopped
            being gated. Anything at or after boot_deferred_start is work that
            was deliberately moved OFF the startup path and is not felt. */}
        <Text style={S.section}>Boot timeline</Text>
        <View style={S.card}>
          {boot.length === 0 ? (
            <Text style={S.empty}>No boot marks — this build predates them.</Text>
          ) : boot.map((b, i) => (
            <View key={`${b.event}-${i}`} style={S.trow}>
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
        <Text style={S.section}>Last {sends.length} sends</Text>
        <View style={S.card}>
          <View style={[S.trow, S.thead]}>
            <Text style={[S.th, { flex: 2 }]}>id</Text>
            <Text style={S.th}>tap→enc</Text>
            <Text style={S.th}>enc→ack</Text>
            <Text style={S.th}>total</Text>
          </View>
          {sends.length === 0 ? (
            <Text style={S.empty}>No sends yet — send a message, then come back.</Text>
          ) : sends.map((s, i) => (
            <View key={`${s.id}-${i}`} style={S.trow}>
              <Text style={[S.td, { flex: 2 }]} numberOfLines={1}>{s.id}</Text>
              <Text style={S.td}>{ms(s.tapToEncrypt)}</Text>
              <Text style={S.td}>{ms(s.encryptToAck)}</Text>
              <Text style={[S.td, s.failed ? S.tdFail : slow(s.totalMs)]}>
                {s.failed ? 'FAIL' : ms(s.totalMs)}
              </Text>
            </View>
          ))}
        </View>

        <Text style={S.note}>
          “tap→enc” = E2EE encryption time (X3DH/ratchet). “enc→ack” = HTTP POST round-trip.
          A large tap→enc means the peer key-bundle fetch is the bottleneck.
        </Text>
      </ScrollView>
    </View>
  );
}

function Row({ S, k, v, bad }: { S: any; k: string; v: string; bad?: boolean }) {
  return (
    <View style={S.kv}>
      <Text style={S.k}>{k}</Text>
      <Text style={[S.v, bad && S.vBad]}>{v}</Text>
    </View>
  );
}

function ms(n?: number): string { return n == null ? '—' : `${n}ms`; }
function slow(total?: number) { return total != null && total > 1500 ? { color: '#F59E0B' } : undefined; }

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:  { flex: 1, backgroundColor: c.bg },
  header:  { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 56, paddingBottom: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title:   { color: c.text, fontSize: 22, fontWeight: '800' },

  section: { color: c.textDim, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', marginTop: 20, marginBottom: 8, letterSpacing: 0.5 },
  card:    { backgroundColor: c.card, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, overflow: 'hidden' },

  kv:   { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  k:    { color: c.textDim, fontSize: 14 },
  v:    { color: c.text, fontSize: 14, fontWeight: '600' },
  vBad: { color: c.danger },

  trow:  { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  thead: { backgroundColor: c.bg },
  th:    { flex: 1, color: c.textDim, fontSize: 11, fontWeight: '700' },
  td:    { flex: 1, color: c.text, fontSize: 12, fontVariant: ['tabular-nums'] },
  tdFail:{ color: c.danger, fontWeight: '700' },

  warn:  { color: '#F59E0B', fontSize: 12, marginTop: 8, paddingHorizontal: 4 },
  empty: { color: c.textDim, fontSize: 13, padding: 14 },
  note:  { color: c.textDim, fontSize: 11, lineHeight: 16, marginTop: 16, paddingHorizontal: 4 },
});
