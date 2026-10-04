// app/space-checkin.tsx — check in and check out (Employee design screen 9),
// with a door to leave (app/space-leave.tsx owns requests and approvals).
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
  View, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity, Alert, RefreshControl,
} from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSpaceColors, spaceHeader } from '../lib/spaces/theme';
import type { SpacePalette as Palette } from '../lib/spaces/theme';
import {
  getAttendance, checkIn, checkOut, getLeave,
  type AttendanceRecord, type LeaveRequest,
} from '../lib/spaces/api';
import { getCurrentUserAsync } from './(constants)/authService';
import { AuroraBackground } from '../components/ui';
import LoadError from '../components/spaces/LoadError';


export default function SpaceCheckinScreen() {
  const params = useLocalSearchParams<{ spaceId?: string; name?: string; groupType?: string; perms?: string }>();
  const colors = useSpaceColors(params.groupType);
  const router = useRouter();
  const spaceId = String(params.spaceId || '');

  // Presentation only: whether to count requests waiting for this viewer's
  // decision. Deciding happens on the leave screen, which the server re-checks.
  const canDecide = useMemo(
    () => String(params.perms || '').split(',').includes('view_space_ops'),
    [params.perms],
  );

  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [leave, setLeave] = useState<LeaveRequest[]>([]);
  // Leave is only a badge here, so its failure is reported on the leave row
  // and never hides the check-in hero.
  const [leaveError, setLeaveError] = useState(false);
  const [me, setMe] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [u, a, l] = await Promise.all([
        getCurrentUserAsync().catch(() => null),
        getAttendance(spaceId),
        getLeave(spaceId).catch(() => null),
      ]);
      const id = u?.id != null ? String(u.id) : '';
      // Without knowing who is signed in, the hero would say "Not checked in"
      // and the leave badge would count the viewer's own requests as others'.
      if (!id) throw new Error('Could not tell who is signed in. Try again.');
      setMe(id);
      setRecords(a.records || []);
      setLeave(l ?? []);
      setLeaveError(l == null);
      setLoadError(null);
    } catch (e: any) {
      // "Not checked in" and "No leave requested" after a failed read would be
      // statements about today that nobody made.
      setLoadError(e?.message ?? 'Could not load today’s record.');
    } finally {
      setLoading(false);
      setRefreshing(false);
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

  // The leave summary: the viewer's own pending requests, and — for an
  // approver — other people's waiting for a decision.
  const myPending = leave.filter((l) => l.userId === me && l.status === 'pending').length;
  const toDecide = canDecide ? leave.filter((l) => l.userId !== me && l.status === 'pending').length : 0;
  const openLeave = () => router.push({
    pathname: '/space-leave',
    params: { spaceId, name: params.name ?? '', groupType: params.groupType ?? '', perms: params.perms ?? '' },
  });

  const s = useMemo(() => styles(colors), [colors]);

  if (loading) {
    return (
      <View style={[s.screen, s.centre]}>
      <AuroraBackground />
        <Stack.Screen options={spaceHeader(colors, 'Check in')} />
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <AuroraBackground />
    <ScrollView
      style={s.screen} contentContainerStyle={s.body}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={colors.primary} />}
    >
      <Stack.Screen options={spaceHeader(colors, params.name ? `${params.name} · Check in` : 'Check in', { id: spaceId, name: params.name })} />

      {loadError && (
        <LoadError colors={colors} title="Could not load today’s record" message={loadError} onRetry={() => { setLoading(true); void load(); }} />
      )}

      {/* Design screen 9: the day's own state, big. */}
      {!loadError && <View style={[s.card, s.hero]}>
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
          <TouchableOpacity style={[s.bigBtn, { backgroundColor: colors.brandOnLight }]} onPress={doCheckIn} disabled={busy} accessibilityRole="button" accessibilityLabel="Check in" accessibilityState={{ disabled: busy, busy }}>
            {/* White ink on the solid brandOnLight fill (deep blue in both schemes, 6.3:1). */}
            {busy ? <ActivityIndicator color={colors.onBrand} /> : <Text style={s.bigBtnText}>Check In</Text>}
          </TouchableOpacity>
        ) : !outAt ? (
          <TouchableOpacity style={[s.bigBtn, { backgroundColor: colors.danger }]} onPress={doCheckOut} disabled={busy} accessibilityRole="button" accessibilityLabel="Check out now" accessibilityState={{ disabled: busy, busy }}>
            {busy ? <ActivityIndicator color={colors.onDanger} /> : <Text style={[s.bigBtnText, { color: colors.onDanger }]}>Check Out Now</Text>}
          </TouchableOpacity>
        ) : (
          // Checking in again would move the arrival time, so the button is
          // gone rather than disabled-and-mysterious.
          <Text style={s.footnote}>That is today done. Tomorrow starts a new record.</Text>
        )}
      </View>}

      {/* Leave lives on its own screen (requests, approvals, balance); this is
          the door to it, with what is waiting. */}
      <TouchableOpacity
        style={[s.card, s.linkRow]} onPress={openLeave}
        accessibilityRole="button"
        accessibilityLabel={`Leave. ${loadError ? '' : leaveError ? 'Could not load your requests. ' : `${myPending} of yours pending${canDecide ? `, ${toDecide} waiting for your decision` : ''}. `}Request or review leave`}
      >
        <Ionicons name="calendar-outline" size={20} color={colors.primary} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.cardTitle}>Leave</Text>
          <Text style={s.muted}>
            {loadError ? 'Request leave, or review requests'
              : leaveError ? 'Could not load your requests · open to try again'
              : [
                myPending ? `${myPending} of yours pending` : 'Nothing of yours pending',
                canDecide && toDecide ? `${toDecide} waiting for your decision` : null,
              ].filter(Boolean).join(' · ')}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
      </TouchableOpacity>

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

    </ScrollView>
    </View>
  );
}

const clock = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

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
  bigBtn: { marginTop: 8, paddingHorizontal: 28, paddingVertical: 13, borderRadius: 14, minHeight: 48, justifyContent: 'center' },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
  bigBtnText: { color: c.onBrand, fontWeight: '800', fontSize: 15 },
  leaveRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9 },
  leaveDot: { width: 9, height: 9, borderRadius: 5 },
  leaveTitle: { color: c.text, fontSize: 14.5, fontWeight: '600' },
  footnote: { color: c.textFaint, fontSize: 11.5, lineHeight: 16 },
});
