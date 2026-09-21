// app/space-checkin.tsx — check in, check out, and leave
// (Employee design screens 9 and 11).
//
// ── two kinds of "attendance", kept apart on purpose ──
//
// This screen is the DECLARED one: someone tapped a button and the server has a
// record of it. It is what a manager can act on and what a person can point to.
//
// The other kind lives in lib/spaces/attendance.ts and is DERIVED on-device
// from safe-zone crossings, because location is end-to-end encrypted and the
// server cannot see it. That one answers "was their phone at the office"; this
// one answers "did they say they had arrived". A workplace usually wants both,
// and merging them would produce a number that is neither.
//
// Nothing is computed here — times and counts arrive from the server.

import { AppText as Text } from '../components/ui/Text';
import React, { useCallback, useMemo, useState } from 'react';
import {
  View, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity,
  Alert, TextInput, Modal,
} from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSpaceColors, spaceHeader } from '../lib/spaces/theme';
import type { SpacePalette as Palette } from '../lib/spaces/theme';
import {
  getAttendance, checkIn, checkOut, getLeave, requestLeave, decideLeave,
  type AttendanceRecord, type LeaveRequest,
} from '../lib/spaces/api';
import { getCurrentUserAsync } from './(constants)/authService';
import { AuroraBackground } from '../components/ui';
import { KeyboardSafe } from '../components/ui/KeyboardSafe';

const LEAVE_KINDS: { key: string; label: string }[] = [
  { key: 'casual', label: 'Casual' },
  { key: 'sick', label: 'Sick' },
  { key: 'privilege', label: 'Privilege' },
  { key: 'unpaid', label: 'Unpaid' },
];

export default function SpaceCheckinScreen() {
  const params = useLocalSearchParams<{ spaceId?: string; name?: string; groupType?: string; perms?: string }>();
  const colors = useSpaceColors(params.groupType);
  const spaceId = String(params.spaceId || '');

  // Presentation gate only — the PATCH re-checks it. Drawing Approve/Decline
  // for someone the server will refuse teaches them to distrust the app
  // (Business design rule: only an eligible approver sees the buttons).
  const canDecide = useMemo(
    () => String(params.perms || '').split(',').includes('view_space_ops'),
    [params.perms],
  );

  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [leave, setLeave] = useState<LeaveRequest[]>([]);
  const [me, setMe] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [kind, setKind] = useState('casual');
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    try {
      const [u, a, l] = await Promise.all([
        getCurrentUserAsync().catch(() => null),
        getAttendance(spaceId).catch(() => ({ day: today(), records: [] as AttendanceRecord[] })),
        getLeave(spaceId).catch(() => [] as LeaveRequest[]),
      ]);
      setMe(String((u as any)?.id ?? ''));
      setRecords(a.records || []);
      setLeave(l || []);
    } finally {
      setLoading(false);
    }
  }, [spaceId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const mine = useMemo(() => records.find((r) => r.userId === me) ?? null, [records, me]);
  const inAt = mine?.checkInAt ? new Date(mine.checkInAt) : null;
  const outAt = mine?.checkOutAt ? new Date(mine.checkOutAt) : null;

  const doCheckIn = useCallback(async () => {
    setBusy(true);
    try { await checkIn(spaceId); await load(); }
    catch (e: any) { Alert.alert('Could not check in', e?.message ?? 'Try again.'); }
    finally { setBusy(false); }
  }, [spaceId, load]);

  const doCheckOut = useCallback(async () => {
    setBusy(true);
    try { await checkOut(spaceId); await load(); }
    catch (e: any) {
      // The server refuses a check-out with no check-in rather than inventing a
      // record with an exit and no arrival. Pass its wording through.
      Alert.alert('Could not check out', e?.message ?? 'Try again.');
    } finally { setBusy(false); }
  }, [spaceId, load]);

  const submitLeave = useCallback(async () => {
    if (!isDay(from) || !isDay(to)) { Alert.alert('Dates', 'Use YYYY-MM-DD for both dates.'); return; }
    if (to < from) { Alert.alert('Dates', 'The end date is before the start date.'); return; }
    setBusy(true);
    try {
      await requestLeave(spaceId, { kind, fromDay: from, toDay: to, reason: reason.trim() || undefined });
      setAsking(false); setReason('');
      await load();
    } catch (e: any) {
      Alert.alert('Could not request leave', e?.message ?? 'Try again.');
    } finally { setBusy(false); }
  }, [spaceId, kind, from, to, reason, load]);

  const decide = useCallback(async (l: LeaveRequest, status: 'approved' | 'rejected' | 'cancelled') => {
    setBusy(true);
    try { await decideLeave(spaceId, l.id, status); await load(); }
    catch (e: any) { Alert.alert('Could not update', e?.message ?? 'Try again.'); }
    finally { setBusy(false); }
  }, [spaceId, load]);

  const s = styles(colors);

  if (loading) {
    return (
      <View style={[s.screen, s.centre]}>
      <AuroraBackground />
        <Stack.Screen options={spaceHeader(colors, 'Attendance')} />
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.body}>
      <Stack.Screen options={spaceHeader(colors, params.name ? `${params.name} · Attendance` : 'Attendance', { id: spaceId, name: params.name })} />

      {/* Design screen 9: the day's own state, big. */}
      <View style={[s.card, s.hero]}>
        <View style={[s.ring, { borderColor: inAt && !outAt ? colors.success : colors.border }]}>
          <Ionicons
            name={inAt && !outAt ? 'checkmark' : outAt ? 'log-out-outline' : 'time-outline'}
            size={26}
            color={inAt && !outAt ? colors.success : colors.textDim}
          />
        </View>
        <Text style={s.heroState}>
          {!inAt ? 'Not checked in' : outAt ? 'Checked out' : 'Checked in'}
        </Text>
        <Text style={s.muted}>
          {inAt ? `In ${clock(inAt)}` : 'Tap below when you arrive'}
          {outAt ? ` · Out ${clock(outAt)}` : ''}
        </Text>

        {!inAt ? (
          <TouchableOpacity style={[s.bigBtn, { backgroundColor: colors.brandOnLight }]} onPress={doCheckIn} disabled={busy}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.bigBtnText}>Check In</Text>}
          </TouchableOpacity>
        ) : !outAt ? (
          <TouchableOpacity style={[s.bigBtn, { backgroundColor: colors.danger }]} onPress={doCheckOut} disabled={busy}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.bigBtnText}>Check Out Now</Text>}
          </TouchableOpacity>
        ) : (
          // Checking in again would move the arrival time, so the button is
          // gone rather than disabled-and-mysterious.
          <Text style={s.footnote}>That is today done. Tomorrow starts a new record.</Text>
        )}
      </View>

      {/* Leave (design screen 11) */}
      <View style={s.card}>
        <View style={s.rowBetween}>
          <Text style={s.cardTitle}>Leave</Text>
          <TouchableOpacity onPress={() => setAsking(true)}>
            <Text style={s.link}>Request</Text>
          </TouchableOpacity>
        </View>

        {leave.length === 0 && <Text style={s.muted}>No leave requested.</Text>}

        {leave.map((l) => {
          const ownPending = l.userId === me && l.status === 'pending';
          return (
            <View key={l.id} style={s.leaveRow}>
              <View style={[s.leaveDot, { backgroundColor: statusColour(l.status, colors) }]} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.leaveTitle} numberOfLines={1}>
                  {l.userId === me ? 'You' : (l.name || 'Someone')} · {l.kind}
                </Text>
                <Text style={s.muted} numberOfLines={1}>
                  {l.fromDay}{l.toDay !== l.fromDay ? ` → ${l.toDay}` : ''} · {l.days} {l.days === 1 ? 'day' : 'days'} · {l.status}
                </Text>
              </View>
              {ownPending && (
                <TouchableOpacity onPress={() => decide(l, 'cancelled')} disabled={busy}>
                  <Text style={[s.link, { color: colors.textDim }]}>Withdraw</Text>
                </TouchableOpacity>
              )}
              {/* Only an eligible approver gets the buttons, and never on their
                  own request — the server enforces both, this just stops the
                  screen drawing an action that always fails. */}
              {canDecide && l.status === 'pending' && l.userId !== me && (
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel="Reject check-in" onPress={() => decide(l, 'rejected')} disabled={busy}>
                    <Ionicons name="close-circle-outline" size={21} color={colors.danger} />
                  </TouchableOpacity>
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel="Approve check-in" onPress={() => decide(l, 'approved')} disabled={busy}>
                    <Ionicons name="checkmark-circle-outline" size={21} color={colors.success} />
                  </TouchableOpacity>
                </View>
              )}
            </View>
          );
        })}
      </View>

      {/* Today's team record. RLS returns only the caller's own row unless they
          run the space, so this list is short for an employee and complete for
          a manager without a branch here. */}
      {records.length > 1 && (
        <View style={s.card}>
          <Text style={s.cardTitle}>Today</Text>
          {records.map((r) => (
            <View key={r.userId} style={s.leaveRow}>
              <View style={[s.leaveDot, {
                backgroundColor: r.checkInAt && !r.checkOutAt ? colors.success : colors.textFaint,
              }]} />
              <Text style={[s.leaveTitle, { flex: 1 }]} numberOfLines={1}>
                {r.userId === me ? 'You' : (r.name || 'Someone')}
              </Text>
              <Text style={s.muted}>
                {r.checkInAt ? clock(new Date(r.checkInAt)) : '—'}
                {r.checkOutAt ? ` → ${clock(new Date(r.checkOutAt))}` : ''}
              </Text>
            </View>
          ))}
        </View>
      )}

      <Text style={s.footnote}>
        This is what you told the app. It is separate from location-based arrival, which is
        worked out on your own device and never leaves it.
      </Text>

      {/* request leave */}
      <Modal visible={asking} transparent animationType="fade" onRequestClose={() => setAsking(false)}>
        <KeyboardSafe keyboardOnly>
        <View style={s.modalWrap}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>Request leave</Text>
            <View style={s.kinds}>
              {LEAVE_KINDS.map((k) => (
                <TouchableOpacity
                  key={k.key}
                  onPress={() => setKind(k.key)}
                  style={[s.kind, kind === k.key && { backgroundColor: colors.brandOnLight }]}
                >
                  <Text style={[s.kindText, kind === k.key && { color: '#fff' }]}>{k.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TextInput style={[s.input, { flex: 1 }]} value={from} onChangeText={setFrom} placeholder="From YYYY-MM-DD" placeholderTextColor={colors.textDim} />
              <TextInput style={[s.input, { flex: 1 }]} value={to} onChangeText={setTo} placeholder="To YYYY-MM-DD" placeholderTextColor={colors.textDim} />
            </View>
            <TextInput style={s.input} value={reason} onChangeText={setReason} placeholder="Reason (optional)" placeholderTextColor={colors.textDim} />
            <View style={s.modalRow}>
              <TouchableOpacity style={s.modalBtn} onPress={() => setAsking(false)}>
                <Text style={s.muted}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.modalBtn, { backgroundColor: colors.brandOnLight }]} onPress={submitLeave} disabled={busy}>
                {busy ? <ActivityIndicator size="small" color="#fff" /> : <Text style={s.bigBtnText}>Submit</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
        </KeyboardSafe>
      </Modal>
    </ScrollView>
  );
}

function today(): string { return new Date().toISOString().slice(0, 10); }
function isDay(s: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)); }
const clock = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function statusColour(st: LeaveRequest['status'], c: Palette): string {
  switch (st) {
    case 'approved': return c.success;
    case 'rejected': return c.danger;
    case 'cancelled': return c.textFaint;
    default: return c.warning;
  }
}

const styles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  centre: { alignItems: 'center', justifyContent: 'center' },
  body: { padding: 16, gap: 10, paddingBottom: 40 },
  card: { backgroundColor: c.glassSoft, borderRadius: 14, padding: 14, gap: 8 },
  hero: { alignItems: 'center', gap: 8, paddingVertical: 22 },
  ring: { width: 82, height: 82, borderRadius: 41, borderWidth: 4, alignItems: 'center', justifyContent: 'center' },
  heroState: { color: c.text, fontSize: 18, fontWeight: '800' },
  cardTitle: { color: c.text, fontSize: 15.5, fontWeight: '700' },
  muted: { color: c.textDim, fontSize: 12.5, flexShrink: 1 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  link: { color: c.primary, fontSize: 12.5, fontWeight: '700' },
  bigBtn: { marginTop: 8, paddingHorizontal: 28, paddingVertical: 13, borderRadius: 14 },
  bigBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  leaveRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9 },
  leaveDot: { width: 9, height: 9, borderRadius: 5 },
  leaveTitle: { color: c.text, fontSize: 14.5, fontWeight: '600' },
  footnote: { color: c.textFaint, fontSize: 11.5, lineHeight: 16 },
  modalWrap: { flex: 1, backgroundColor: '#0008', alignItems: 'center', justifyContent: 'center', padding: 22 },
  modal: { width: '100%', backgroundColor: c.bg, borderRadius: 16, padding: 20, gap: 10 },
  modalTitle: { color: c.text, fontSize: 18, fontWeight: '700' },
  input: { borderWidth: 1, borderColor: c.glassStroke, borderRadius: 10, padding: 12, color: c.text, fontSize: 14.5 },
  kinds: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  kind: { borderWidth: 1, borderColor: c.glassStroke, borderRadius: 20, paddingHorizontal: 13, paddingVertical: 7 },
  kindText: { color: c.textDim, fontSize: 12.5 },
  modalRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
  modalBtn: { paddingHorizontal: 18, paddingVertical: 12, borderRadius: 10 },
});
