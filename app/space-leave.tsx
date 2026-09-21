// app/space-leave.tsx — leave requests, approvals and balance.
//
// Like tasks, the backend has been complete and tested since migration 089/090
// and had no way in from the app. /leave, its approval transitions and
// /leave/balance all work; this is the missing screen, not new behaviour.
//
// ── ONE LIST, TWO AUDIENCES ──
//
// RLS returns the caller's own requests unless they run the space, in which case
// it returns everyone's. So an employee opens this and sees their leave; an HR
// manager opens the same screen and sees the queue. No branch here decides that,
// and none should: the moment this screen filters by identity it becomes a
// second implementation of a rule that already exists server-side, and the two
// will drift.
//
// Approve/Decline are drawn only for someone holding view_space_ops, and the
// PATCH re-checks it. A request cannot be approved by the person who made it —
// that is enforced in the handler, not here.

import { AppText as Text } from '../components/ui/Text';
import React, { useCallback, useMemo, useState } from 'react';
import {
  View, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  RefreshControl, Modal, TextInput, Alert,
} from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSpaceColors, spaceHeader } from '../lib/spaces/theme';
import type { SpacePalette as Palette } from '../lib/spaces/theme';
import { getCurrentUserAsync } from './(constants)/authService';
import {
  getLeave, requestLeave, decideLeave, getLeaveBalance,
  type LeaveRequest, type LeaveBalance,
} from '../lib/spaces/api';
import { AuroraBackground } from '../components/ui';
import { KeyboardSafe } from '../components/ui/KeyboardSafe';

const KINDS = ['casual', 'sick', 'privilege', 'unpaid', 'other'];

/** YYYY-MM-DD for an offset from today — the format the API expects. */
function dayOffset(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function pretty(day: string): string {
  const d = new Date(day + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export default function SpaceLeaveScreen() {
  const params = useLocalSearchParams<{ spaceId?: string; name?: string; perms?: string; groupType?: string }>();
  const colors = useSpaceColors(params.groupType);
  const spaceId = String(params.spaceId || '');
  const spaceName = String(params.name || 'This space');

  const canDecide = useMemo(
    () => String(params.perms || '').split(',').includes('view_space_ops'),
    [params.perms],
  );

  const [rows, setRows] = useState<LeaveRequest[] | null>(null);
  const [tab, setTab] = useState<'mine' | 'pending' | 'history'>('mine');
  const [balance, setBalance] = useState<LeaveBalance | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [compose, setCompose] = useState(false);
  const [kind, setKind] = useState('casual');
  const [from, setFrom] = useState(dayOffset(1));
  const [to, setTo] = useState(dayOffset(1));
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [meId, setMeId] = useState<string | null>(null);

  React.useEffect(() => {
    getCurrentUserAsync().then((u: any) => setMeId(u?.id ? String(u.id) : null)).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    if (!spaceId) { setErr('No space was given.'); setRows([]); return; }
    try {
      setErr(null);
      const [l, b] = await Promise.all([
        getLeave(spaceId),
        // Balance is a nicety; its absence must not empty the whole screen.
        getLeaveBalance(spaceId).catch(() => null),
      ]);
      setRows(l);
      setBalance(b);
    } catch (e: any) {
      setErr(e?.message || 'Could not load leave.');
      setRows([]);
    }
  }, [spaceId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await load(); } finally { setRefreshing(false); }
  }, [load]);

  const decide = async (r: LeaveRequest, status: 'approved' | 'rejected') => {
    setBusy(r.id);
    try {
      await decideLeave(spaceId, r.id, status);
      await load();
    } catch (e: any) {
      Alert.alert('Could not update the request', e?.message ?? 'Please try again.');
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    if (from > to) {
      Alert.alert('Check the dates', 'The first day cannot be after the last day.');
      return;
    }
    setSaving(true);
    try {
      await requestLeave(spaceId, { kind, fromDay: from, toDay: to, reason: reason.trim() || undefined });
      setReason(''); setCompose(false);
      await load();
    } catch (e: any) {
      Alert.alert('Could not request leave', e?.message ?? 'Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const s = styles(colors);
  // Pending is orange in the design system — attention, not a verdict either way.
  const tone = (st: string) =>
    st === 'approved' ? colors.success : st === 'pending' ? colors.warning : colors.danger;
  const icon = (st: string) =>
    st === 'approved' ? 'checkmark-circle' : st === 'pending' ? 'time-outline' : 'close-circle';

  const mine = (rows ?? []).filter((r) => r.userId === meId);
  const pending = (rows ?? []).filter((r) => r.status === 'pending');
  const settled = (rows ?? []).filter((r) => r.status !== 'pending');
  const shown = tab === 'mine' ? mine : tab === 'pending' ? pending : settled;

  const TABS = [
    { key: 'mine', label: 'My Leave', count: mine.length },
    { key: 'pending', label: 'Pending', count: pending.length },
    { key: 'history', label: 'History', count: settled.length },
  ] as const;

  const row = (r: LeaveRequest) => (
    <View key={r.id} style={s.card}>
      <View style={s.rowTop}>
        <Ionicons name={icon(r.status) as any} size={20} color={tone(r.status)} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.cardTitle} numberOfLines={1}>
            {r.name || 'A member'} · {r.kind}
          </Text>
          <Text style={s.muted} numberOfLines={1}>
            {pretty(r.fromDay)} – {pretty(r.toDay)} · {r.days} day{r.days === 1 ? '' : 's'}
          </Text>
        </View>
        <Text style={[s.status, { color: tone(r.status) }]}>{r.status}</Text>
      </View>
      {!!r.reason && <Text style={s.muted}>{r.reason}</Text>}
      {/* NOBODY DECIDES THEIR OWN REQUEST. The server refuses it outright, so
          drawing the buttons here would be an action that always fails — and
          until today it was worse than that: it succeeded. */}
      {canDecide && r.status === 'pending' && r.userId === meId && (
        <Text style={s.muted}>
          Waiting for someone else who runs this space to decide.
        </Text>
      )}
      {canDecide && r.status === 'pending' && r.userId !== meId && (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TouchableOpacity
            onPress={() => decide(r, 'rejected')}
            disabled={busy === r.id}
            style={[s.btn, s.btnGhost, { flex: 1 }]}
          >
            <Text style={[s.btnText, { color: colors.danger }]}>Decline</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => decide(r, 'approved')}
            disabled={busy === r.id}
            style={[s.btn, { backgroundColor: colors.success, flex: 1 }]}
          >
            <Text style={s.btnText}>{busy === r.id ? '…' : 'Approve'}</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );

  return (
    <View style={s.screen}>
      <AuroraBackground />
      <Stack.Screen options={spaceHeader(colors, `${spaceName} · Leave`, { id: spaceId, name: params.name })} />

      {/* Tabs (Business design: Leave screen). For a plain employee the server
          returns only their own requests, so Pending and History are simply
          their pending and settled — the tabs need no role branch. */}
      <View style={s.tabs}>
        {TABS.map((t) => (
          <TouchableOpacity
            key={t.key}
            onPress={() => setTab(t.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: tab === t.key }}
            style={[s.tabBtn, tab === t.key && { backgroundColor: colors.brandOnLight }]}
          >
            <Text style={[s.tabText, tab === t.key && { color: '#fff' }]}>
              {t.label}{t.count > 0 ? ` (${t.count})` : ''}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView
        contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {/* Balance. `allowance: null` means the space has never set one — that
            is "not set", NOT zero. Showing 0 would read as "you have no leave",
            which is a different and alarming statement. */}
        {balance && (
          <View style={s.card}>
            <Text style={s.cardTitle}>Your leave</Text>
            {Object.keys(balance.used).length === 0 && !balance.allowance && (
              <Text style={s.muted}>You have not taken any leave in {spaceName}.</Text>
            )}
            {Object.entries(balance.used).map(([k, v]) => (
              <Text key={k} style={s.muted}>
                {k}: {v} day{v === 1 ? '' : 's'} used
                {balance.allowance?.[k] != null ? ` of ${balance.allowance[k]}` : ' · allowance not set'}
              </Text>
            ))}
          </View>
        )}

        {rows === null && (
          <View style={s.centre}><ActivityIndicator color={colors.primary} /><Text style={s.muted}>Loading leave…</Text></View>
        )}

        {err && (
          <View style={[s.card, { borderColor: colors.danger, borderWidth: 1 }]}>
            <Text style={s.cardTitle}>Could not load leave</Text>
            <Text style={s.muted}>{err}</Text>
            <TouchableOpacity onPress={load} style={[s.btn, { backgroundColor: colors.brandOnLight }]}>
              <Text style={s.btnText}>Try again</Text>
            </TouchableOpacity>
          </View>
        )}

        {rows !== null && rows.length === 0 && !err && (
          <View style={s.card}>
            <Ionicons name="calendar-outline" size={26} color={colors.textDim} />
            <Text style={s.cardTitle}>No leave requested</Text>
            <Text style={s.muted}>Requests you make appear here, with their status.</Text>
          </View>
        )}

        {shown.map(row)}
        {rows !== null && rows.length > 0 && shown.length === 0 && (
          <Text style={s.muted}>Nothing in {TABS.find((t) => t.key === tab)?.label}.</Text>
        )}
      </ScrollView>

      <TouchableOpacity accessibilityRole="button" accessibilityLabel="New leave request" style={[s.fab, { backgroundColor: colors.brandOnLight }]} onPress={() => setCompose(true)}>
        <Ionicons name="add" size={26} color="#fff" />
      </TouchableOpacity>

      <Modal visible={compose} animationType="slide" transparent onRequestClose={() => setCompose(false)}>
        <KeyboardSafe keyboardOnly>
        <View style={s.sheetWrap}>
          <View style={s.sheet}>
            <Text style={s.cardTitle}>Request leave</Text>
            <View style={s.kindRow}>
              {KINDS.map((k) => (
                <TouchableOpacity
                  key={k}
                  onPress={() => setKind(k)}
                  style={[s.kind, kind === k && { backgroundColor: colors.brandOnLight }]}
                >
                  <Text style={[s.kindText, kind === k && { color: '#fff' }]}>{k}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Text style={s.label}>First day</Text>
                <TextInput style={s.input} value={from} onChangeText={setFrom}
                  placeholder="YYYY-MM-DD" placeholderTextColor={colors.textDim} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.label}>Last day</Text>
                <TextInput style={s.input} value={to} onChangeText={setTo}
                  placeholder="YYYY-MM-DD" placeholderTextColor={colors.textDim} />
              </View>
            </View>
            <TextInput
              style={s.input}
              placeholder="Reason (optional)"
              placeholderTextColor={colors.textDim}
              value={reason}
              onChangeText={setReason}
              maxLength={300}
            />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity onPress={() => setCompose(false)} style={[s.btn, s.btnGhost, { flex: 1 }]}>
                <Text style={[s.btnText, { color: colors.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={submit}
                disabled={saving}
                style={[s.btn, { backgroundColor: colors.brandOnLight, flex: 1, opacity: saving ? 0.5 : 1 }]}
              >
                <Text style={s.btnText}>{saving ? 'Sending…' : 'Request'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
        </KeyboardSafe>
      </Modal>
    </View>
  );
}

const styles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  body: { padding: 16, gap: 10, paddingBottom: 90 },
  centre: { alignItems: 'center', gap: 10, paddingVertical: 40 },
  card: { backgroundColor: c.glassSoft, borderRadius: 14, padding: 14, gap: 8 },
  cardTitle: { color: c.text, fontSize: 15, fontWeight: '700' },
  muted: { color: c.textDim, fontSize: 12.5, lineHeight: 17, flexShrink: 1 },
  tabs: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 12 },
  tabBtn: { flex: 1, alignItems: 'center', backgroundColor: c.glassSoft, borderRadius: 999, paddingVertical: 9 },
  tabText: { color: c.textDim, fontWeight: '700', fontSize: 12.5 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  status: { fontSize: 11.5, fontWeight: '800', textTransform: 'uppercase' },
  label: { color: c.textDim, fontSize: 11.5, marginBottom: 4, fontWeight: '700' },
  fab: {
    position: 'absolute', right: 20, bottom: 28, width: 56, height: 56, borderRadius: 28,
    alignItems: 'center', justifyContent: 'center', elevation: 4,
  },
  sheetWrap: { flex: 1, backgroundColor: '#0008', justifyContent: 'flex-end' },
  // surfaceSolid, not card: card is a translucent glass pane in the dusk skin,
  // and a see-through sheet over the scrim is unreadable in both schemes.
  sheet: { backgroundColor: c.surfaceSolid, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18, gap: 12 },
  input: {
    backgroundColor: c.bg, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11,
    color: c.text, fontSize: 14.5,
  },
  kindRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  kind: { backgroundColor: c.bg, borderRadius: 9, paddingHorizontal: 12, paddingVertical: 8 },
  kindText: { color: c.textDim, fontWeight: '700', fontSize: 12.5 },
  btn: { alignItems: 'center', justifyContent: 'center', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 14 },
  btnGhost: { backgroundColor: c.bg },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
});
