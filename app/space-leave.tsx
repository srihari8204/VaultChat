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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  getLeave, requestLeave, decideLeave, getLeaveBalance, setLeaveAllowance,
  type LeaveRequest, type LeaveBalance,
} from '../lib/spaces/api';
import { AuroraBackground } from '../components/ui';
import { KeyboardSafe } from '../components/ui/KeyboardSafe';
import LoadError from '../components/spaces/LoadError';
import { ymd, dayOffset, allowanceBody, ALLOWANCE_KINDS, type AllowanceKind } from '../lib/spaces/leave';
import { parseDay } from '../lib/spaces/runPlan';
// The app's one cross-platform date picker (shared with finance).
import { useDatePicker } from '../components/ui/useDatePicker';
import { errMsg } from '../lib/spaces/errors';

const KINDS = ['casual', 'sick', 'privilege', 'unpaid', 'other'];

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
  // Setting the allowance is a space setting (leaveAllowanceSet: edit_settings).
  const canSetAllowance = useMemo(
    () => String(params.perms || '').split(',').includes('edit_settings'),
    [params.perms],
  );
  const insets = useSafeAreaInsets();
  const picker = useDatePicker(undefined, { inModal: true });
  const [allowanceOpen, setAllowanceOpen] = useState(false);
  const [allowanceForm, setAllowanceForm] = useState<Record<AllowanceKind, string>>({ casual: '', sick: '', privilege: '', unpaid: '' });

  const [rows, setRows] = useState<LeaveRequest[] | null>(null);
  const [tab, setTab] = useState<'mine' | 'pending' | 'history'>('mine');
  const [balance, setBalance] = useState<LeaveBalance | null>(null);
  // The balance read failed (not "never set"): said on screen, and the
  // allowance editor warns that it cannot show the current values.
  const [balanceFailed, setBalanceFailed] = useState(false);
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

  const load = useCallback(async () => {
    if (!spaceId) { setErr('No space was given.'); setRows([]); return; }
    try {
      setErr(null);
      const [u, l, b] = await Promise.all([
        getCurrentUserAsync().catch(() => null),
        getLeave(spaceId),
        // Balance is a nicety; its absence must not empty the whole screen.
        getLeaveBalance(spaceId).catch(() => null),
      ]);
      // Without knowing who is signed in, My Leave would be empty, Withdraw
      // hidden, and an approver shown Approve on their own request (which the
      // server refuses). An error, as on space-checkin.
      const id = u?.id != null ? String(u.id) : '';
      if (!id) throw new Error('Could not tell who is signed in. Try again.');
      setMeId(id);
      setRows(l);
      setBalance(b);
      setBalanceFailed(b == null);
    } catch (e) {
      setErr(errMsg(e) || 'Could not load leave.');
      // Keep what was last shown; the note under the error says it may be old.
      setRows((prev) => prev ?? []);
    }
  }, [spaceId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await load(); } finally { setRefreshing(false); }
  }, [load]);

  const decideNow = async (r: LeaveRequest, status: 'approved' | 'rejected' | 'cancelled') => {
    setBusy(r.id);
    try {
      await decideLeave(spaceId, r.id, status);
      await load();
    } catch (e) {
      Alert.alert('Could not update the request', errMsg(e) ?? 'Please try again.');
    } finally {
      setBusy(null);
    }
  };

  // Approve is the expected tap and stays one; decline and withdraw are confirmed.
  const decide = (r: LeaveRequest, status: 'approved' | 'rejected' | 'cancelled') => {
    if (status === 'approved') { void decideNow(r, status); return; }
    const span = `${r.kind}, ${pretty(r.fromDay)}${r.toDay !== r.fromDay ? ` – ${pretty(r.toDay)}` : ''}`;
    Alert.alert(
      status === 'rejected' ? `Decline ${r.name || 'this'}’s leave?` : 'Withdraw your leave request?',
      `${span}.`,
      [
        { text: 'Keep', style: 'cancel' },
        { text: status === 'rejected' ? 'Decline' : 'Withdraw', style: 'destructive', onPress: () => { void decideNow(r, status); } },
      ],
    );
  };

  const openAllowance = () => {
    const a = balance?.allowance ?? {};
    setAllowanceForm({
      casual: a.casual != null ? String(a.casual) : '', sick: a.sick != null ? String(a.sick) : '',
      privilege: a.privilege != null ? String(a.privilege) : '', unpaid: a.unpaid != null ? String(a.unpaid) : '',
    });
    setAllowanceOpen(true);
  };
  const saveAllowance = async () => {
    const r = allowanceBody(allowanceForm);
    if ('error' in r) { Alert.alert('Check the allowance', r.error); return; }
    setSaving(true);
    try {
      await setLeaveAllowance(spaceId, r.body);
      setAllowanceOpen(false);
      await load();
    } catch (e) {
      Alert.alert('Could not save the allowance', errMsg(e) ?? 'Please try again.');
    } finally { setSaving(false); }
  };

  const submit = async () => {
    if (parseDay(from) == null || parseDay(to) == null) {
      Alert.alert('Check the dates', 'Choose both the first and the last day.');
      return;
    }
    if (from > to) {
      Alert.alert('Check the dates', 'The first day cannot be after the last day.');
      return;
    }
    setSaving(true);
    try {
      await requestLeave(spaceId, { kind, fromDay: from, toDay: to, reason: reason.trim() || undefined });
      setReason(''); setCompose(false);
      await load();
    } catch (e) {
      Alert.alert('Could not request leave', errMsg(e) ?? 'Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const s = useMemo(() => styles(colors), [colors]);
  // Pending is orange in the design system — attention, not a verdict either
  // way. Withdrawn (cancelled) is the requester's own choice: neutral, not red.
  const tone = (st: string) =>
    st === 'approved' ? colors.success : st === 'pending' ? colors.warning
      : st === 'cancelled' ? colors.textDim : colors.danger;
  const icon = (st: string): keyof typeof Ionicons.glyphMap =>
    st === 'approved' ? 'checkmark-circle' : st === 'pending' ? 'time-outline'
      : st === 'cancelled' ? 'arrow-undo-outline' : 'close-circle';

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
        <Ionicons name={icon(r.status)} size={20} color={tone(r.status)} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.cardTitle} numberOfLines={1}>
            {r.name || 'A member'} · {r.kind}
          </Text>
          <Text style={s.muted} numberOfLines={1}>
            {pretty(r.fromDay)} – {pretty(r.toDay)} · {r.days} day{r.days === 1 ? '' : 's'}
          </Text>
        </View>
        <Text style={[s.status, { color: tone(r.status) }]}>{r.status === 'cancelled' ? 'withdrawn' : r.status}</Text>
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
      {/* The requester can take back their own pending request. */}
      {r.status === 'pending' && r.userId === meId && (
        <TouchableOpacity
          onPress={() => decide(r, 'cancelled')} disabled={busy === r.id}
          style={[s.btn, s.btnGhost]}
          accessibilityRole="button" accessibilityLabel={`Withdraw your ${r.kind} leave request`}
          accessibilityState={{ disabled: busy === r.id, busy: busy === r.id }}
        >
          <Text style={[s.btnText, { color: colors.text }]}>{busy === r.id ? '…' : 'Withdraw'}</Text>
        </TouchableOpacity>
      )}
      {canDecide && !!meId && r.status === 'pending' && r.userId !== meId && (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TouchableOpacity
            onPress={() => decide(r, 'rejected')}
            disabled={busy === r.id}
            style={[s.btn, s.btnGhost, { flex: 1 }]}
            accessibilityRole="button" accessibilityLabel={`Decline leave for ${r.name || 'this person'}`}
            accessibilityState={{ disabled: busy === r.id, busy: busy === r.id }}
          >
            <Text style={[s.btnText, { color: colors.danger }]}>Decline</Text>
          </TouchableOpacity>
          {/* Outlined, success-coloured ink on the ground: white on the dark
              scheme's #22C55E fill was about 2.3:1. */}
          <TouchableOpacity
            onPress={() => decide(r, 'approved')}
            disabled={busy === r.id}
            style={[s.btn, s.btnGhost, { borderWidth: 1, borderColor: colors.success, flex: 1 }]}
            accessibilityRole="button" accessibilityLabel={`Approve leave for ${r.name || 'this person'}`}
            accessibilityState={{ disabled: busy === r.id, busy: busy === r.id }}
          >
            <Text style={[s.btnText, { color: colors.success }]}>{busy === r.id ? '…' : 'Approve'}</Text>
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
      <View style={s.tabs} accessibilityRole="tablist">
        {TABS.map((t) => (
          <TouchableOpacity
            key={t.key}
            onPress={() => setTab(t.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === t.key }}
            style={[s.tabBtn, tab === t.key && { backgroundColor: colors.brandOnLight }]}
          >
            {/* White ink on the solid brandOnLight fill (deep blue in both schemes, 6.3:1). */}
            <Text style={[s.tabText, tab === t.key && { color: colors.onBrand }]}>
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
            <View style={s.rowTop}>
              <Text style={[s.cardTitle, { flex: 1 }]}>Your leave</Text>
              {canSetAllowance && (
                <TouchableOpacity onPress={openAllowance} style={s.hit} accessibilityRole="button" accessibilityLabel="Set the leave allowance for this space">
                  <Text style={{ color: colors.primary, fontWeight: '700' }}>Set allowance</Text>
                </TouchableOpacity>
              )}
            </View>
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
        {/* A failed balance read is said, and the allowance editor stays
            reachable — it is a space setting, not part of the balance. */}
        {!balance && balanceFailed && rows !== null && !err && (
          <View style={s.card}>
            <View style={s.rowTop}>
              <Text style={[s.muted, { flex: 1 }]}>Could not load your leave balance. Pull down to try again.</Text>
              {canSetAllowance && (
                <TouchableOpacity onPress={openAllowance} style={s.hit} accessibilityRole="button" accessibilityLabel="Set the leave allowance for this space">
                  <Text style={{ color: colors.primary, fontWeight: '700' }}>Set allowance</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}

        {rows === null && (
          <View style={s.centre}><ActivityIndicator color={colors.primary} /><Text style={s.muted}>Loading leave…</Text></View>
        )}

        {err && (
          <LoadError colors={colors} title="Could not load leave" message={err} onRetry={() => { void onRefresh(); }} />
        )}
        {err && !!rows?.length && (
          <Text style={s.muted}>The requests below are from the last successful refresh and may be out of date.</Text>
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

      <TouchableOpacity
        accessibilityRole="button" accessibilityLabel="New leave request"
        style={[s.fab, { backgroundColor: colors.brandOnLight, bottom: 28 + insets.bottom }]}
        onPress={() => { setFrom(dayOffset(1)); setTo(dayOffset(1)); setCompose(true); }}
      >
        {/* White ink on the solid brandOnLight fill (deep blue in both schemes, 6.3:1). */}
        <Ionicons name="add" size={26} color={colors.onBrand} />
      </TouchableOpacity>

      <Modal visible={compose} animationType="slide" transparent onRequestClose={() => setCompose(false)} onDismiss={picker.close}>
        <KeyboardSafe keyboardOnly>
        <View style={s.sheetWrap}>
          <View style={[s.sheet, { paddingBottom: 18 + insets.bottom }]}>
            <Text style={s.cardTitle} accessibilityRole="header">Request leave</Text>
            <View style={s.kindRow} accessibilityRole="radiogroup" accessibilityLabel="Kind of leave">
              {KINDS.map((k) => (
                <TouchableOpacity
                  key={k}
                  onPress={() => setKind(k)}
                  accessibilityRole="radio" accessibilityState={{ checked: kind === k }}
                  style={[s.kind, kind === k && { backgroundColor: colors.brandOnLight }]}
                >
                  <Text style={[s.kindText, kind === k && { color: colors.onBrand }]}>{k}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {/* Picked, not typed: no format to get wrong, and the day is the
                  LOCAL calendar day (lib/spaces/leave.ts ymd). */}
              <View style={{ flex: 1 }}>
                <Text style={s.label}>First day</Text>
                <TouchableOpacity
                  style={[s.input, s.dateBtn]}
                  onPress={() => picker.open(new Date(parseDay(from) ?? Date.now()), (d) => {
                    const v = ymd(d); setFrom(v); if (to < v) setTo(v);
                  })}
                  accessibilityRole="button" accessibilityLabel={`First day: ${pretty(from)}. Change`}
                >
                  <Text style={{ color: colors.text }}>{pretty(from)}</Text>
                </TouchableOpacity>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.label}>Last day</Text>
                <TouchableOpacity
                  style={[s.input, s.dateBtn]}
                  onPress={() => picker.open(new Date(parseDay(to) ?? Date.now()), (d) => setTo(ymd(d)))}
                  accessibilityRole="button" accessibilityLabel={`Last day: ${pretty(to)}. Change`}
                >
                  <Text style={{ color: colors.text }}>{pretty(to)}</Text>
                </TouchableOpacity>
              </View>
            </View>
            <TextInput
              style={s.input}
              placeholder="Reason (optional)"
              placeholderTextColor={colors.textDim}
              value={reason}
              onChangeText={setReason}
              maxLength={300}
              accessibilityLabel="Reason, optional"
            />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity onPress={() => setCompose(false)} style={[s.btn, s.btnGhost, { flex: 1 }]} accessibilityRole="button" accessibilityLabel="Cancel">
                <Text style={[s.btnText, { color: colors.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={submit}
                disabled={saving}
                style={[s.btn, { backgroundColor: colors.brandOnLight, flex: 1, opacity: saving ? 0.5 : 1 }]}
                accessibilityRole="button" accessibilityLabel="Request leave"
                accessibilityState={{ disabled: saving, busy: saving }}
              >
                <Text style={s.btnText}>{saving ? 'Sending…' : 'Request'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
        </KeyboardSafe>
        {/* Last child: on iOS the picker is an overlay inside this Modal, not a
            second Modal (components/ui/useDatePicker inModal). */}
        {picker.element}
      </Modal>

      {/* allowance (edit_settings) */}
      <Modal visible={allowanceOpen} animationType="slide" transparent onRequestClose={() => setAllowanceOpen(false)}>
        <KeyboardSafe keyboardOnly>
        <View style={s.sheetWrap}>
          <View style={[s.sheet, { paddingBottom: 18 + insets.bottom }]}>
            <Text style={s.cardTitle} accessibilityRole="header">Leave allowance</Text>
            <Text style={s.muted}>
              Days per type for everyone in {spaceName}. Leave a type empty for no allowance (shown as
              “not set”, never as zero). Saving replaces the whole allowance.
            </Text>
            {!balance && (
              <Text style={[s.muted, { color: colors.warning }]} accessibilityRole="alert">
                The current allowance could not be read, so these fields start empty. Saving
                replaces whatever is set now with what you enter here.
              </Text>
            )}
            {ALLOWANCE_KINDS.map((k) => (
              <View key={k} style={s.rowTop}>
                <Text style={[s.label, { flex: 1, marginBottom: 0 }]}>{k}</Text>
                <TextInput
                  style={[s.input, { width: 96 }]} value={allowanceForm[k]}
                  onChangeText={(t) => setAllowanceForm((f) => ({ ...f, [k]: t }))}
                  keyboardType="number-pad" maxLength={3} placeholder="not set"
                  placeholderTextColor={colors.textDim} accessibilityLabel={`${k} leave, days per year`}
                />
              </View>
            ))}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity onPress={() => setAllowanceOpen(false)} style={[s.btn, s.btnGhost, { flex: 1 }]} accessibilityRole="button" accessibilityLabel="Cancel">
                <Text style={[s.btnText, { color: colors.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={saveAllowance} disabled={saving}
                style={[s.btn, { backgroundColor: colors.brandOnLight, flex: 1, opacity: saving ? 0.5 : 1 }]}
                accessibilityRole="button" accessibilityLabel="Save allowance"
                accessibilityState={{ disabled: saving, busy: saving }}
              >
                <Text style={s.btnText}>{saving ? 'Saving…' : 'Save'}</Text>
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
  tabBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.glassSoft, borderRadius: 999, minHeight: 44 },
  tabText: { color: c.textDim, fontWeight: '700', fontSize: 12.5 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  status: { fontSize: 11.5, fontWeight: '800', textTransform: 'uppercase' },
  label: { color: c.textDim, fontSize: 11.5, marginBottom: 4, fontWeight: '700' },
  fab: {
    position: 'absolute', right: 20, bottom: 28, width: 56, height: 56, borderRadius: 28,
    alignItems: 'center', justifyContent: 'center', elevation: 4,
  },
  // The theme's scrim (Palette.scrim) behind the sheet.
  sheetWrap: { flex: 1, backgroundColor: c.scrim, justifyContent: 'flex-end' },
  // surfaceSolid, not card: card is a translucent glass pane in the dusk skin,
  // and a see-through sheet over the scrim is unreadable in both schemes.
  sheet: { backgroundColor: c.surfaceSolid, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18, gap: 12 },
  input: {
    backgroundColor: c.bg, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11,
    color: c.text, fontSize: 14.5,
  },
  kindRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  kind: { backgroundColor: c.bg, borderRadius: 9, paddingHorizontal: 14, minHeight: 44, justifyContent: 'center' },
  kindText: { color: c.textDim, fontWeight: '700', fontSize: 12.5 },
  btn: { alignItems: 'center', justifyContent: 'center', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 14, minHeight: 44 },
  hit: { minHeight: 44, justifyContent: 'center' },
  dateBtn: { minHeight: 44, justifyContent: 'center' },
  btnGhost: { backgroundColor: c.bg },
  btnText: { color: c.onBrand, fontWeight: '700', fontSize: 14 },
});
