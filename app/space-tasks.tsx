// app/space-tasks.tsx — assigned work in an office or business space.
//
// The backend for this has been complete and tested since migration 089 —
// /tasks, its assignment and its done-transition all work — and none of it was
// reachable from the app. This screen is the missing half, not a new feature.
//
// ── WHO SEES WHAT ──
//
// The server decides. RLS scopes the list to the caller's own tasks unless they
// run the space, so an employee sees what was assigned to them and a manager
// sees the team's — from the SAME request, with no branch here. This screen
// never filters by identity; doing so would be a second, weaker copy of a rule
// that already exists in one place.
//
// Creating and assigning needs view_space_ops. That is a presentation gate on
// the compose button only: POST /tasks re-checks it, so hiding the button is a
// courtesy, never the control.

import { AppText as Text } from '../components/ui/Text';
import React, { useCallback, useMemo, useState } from 'react';
import {
  View, StyleSheet, ScrollView, FlatList, TouchableOpacity, ActivityIndicator,
  RefreshControl, Modal, TextInput, Alert,
} from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSpaceColors, spaceHeader } from '../lib/spaces/theme';
import type { SpacePalette as Palette } from '../lib/spaces/theme';
import { getWorkTasks, createWorkTask, setWorkTaskDone, type WorkTask } from '../lib/spaces/api';
import { AuroraBackground } from '../components/ui';
import { KeyboardSafe } from '../components/ui/KeyboardSafe';
import LoadError from '../components/spaces/LoadError';
import { circleMembers } from '../lib/family/circle';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
// The app's one cross-platform date picker (shared with finance).
import { useDatePicker } from '../components/ui/useDatePicker';
import type { CircleMember } from '../lib/family/types';

/** Due choices, as whole local days from today. The due instant is the END of
 *  that local day, so "Today" is not overdue until tonight. */
const DUE: { days: number | null; label: string }[] = [
  { days: null, label: 'No due date' },
  { days: 0, label: 'Today' },
  { days: 1, label: 'Tomorrow' },
  { days: 7, label: 'In a week' },
];
function dueAtFor(days: number, nowMs = Date.now()): string {
  const d = new Date(nowMs);
  d.setDate(d.getDate() + days);
  d.setHours(23, 59, 0, 0);
  return d.toISOString();
}
/** A picked day's due instant: the end of that local day, like the presets. */
function dueAtOn(day: Date): string {
  const d = new Date(day);
  d.setHours(23, 59, 0, 0);
  return d.toISOString();
}


const PRIORITIES: { key: 'low' | 'medium' | 'high'; label: string }[] = [
  { key: 'high', label: 'High' },
  { key: 'medium', label: 'Medium' },
  { key: 'low', label: 'Low' },
];

function dueWords(iso: string | null): { text: string; overdue: boolean } {
  if (!iso) return { text: '', overdue: false };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { text: '', overdue: false };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((day.getTime() - today.getTime()) / 86400000);
  if (diff < 0) return { text: `${-diff}d overdue`, overdue: true };
  if (diff === 0) return { text: 'Due today', overdue: false };
  if (diff === 1) return { text: 'Due tomorrow', overdue: false };
  return { text: `Due in ${diff}d`, overdue: false };
}

export default function SpaceTasksScreen() {
  const params = useLocalSearchParams<{ spaceId?: string; name?: string; perms?: string; groupType?: string }>();
  const colors = useSpaceColors(params.groupType);
  const PRIORITY_TONE = { high: colors.danger, medium: colors.warning, low: colors.success };
  const spaceId = String(params.spaceId || '');
  const spaceName = String(params.name || 'This space');

  const canAssign = useMemo(
    () => String(params.perms || '').split(',').includes('view_space_ops'),
    [params.perms],
  );

  const [tasks, setTasks] = useState<WorkTask[] | null>(null);
  const [tab, setTab] = useState<'todo' | 'overdue' | 'done'>('todo');
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [compose, setCompose] = useState(false);
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<'low' | 'medium' | 'high'>('medium');
  const [assignee, setAssignee] = useState<string | null>(null);
  const [dueDays, setDueDays] = useState<number | null>(null);
  const [members, setMembers] = useState<CircleMember[]>([]);
  const [membersError, setMembersError] = useState(false);
  // A due day picked from the calendar; overrides the preset chips.
  const [dueCustom, setDueCustom] = useState<Date | null>(null);
  const insets = useSafeAreaInsets();
  const picker = useDatePicker();
  const loadMembers = useCallback(() => {
    setMembersError(false);
    circleMembers(spaceId).then(setMembers).catch(() => setMembersError(true));
  }, [spaceId]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!spaceId) { setErr('No space was given.'); setTasks([]); return; }
    try {
      setErr(null);
      setTasks(await getWorkTasks(spaceId));
    } catch (e: any) {
      // A plain member with nothing assigned gets an EMPTY list from the
      // server, not an error — so anything that throws here is a real failure
      // and is shown as one.
      setErr(e?.message || 'Could not load tasks.');
      setTasks([]);
    }
  }, [spaceId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await load(); } finally { setRefreshing(false); }
  }, [load]);

  const toggle = async (t: WorkTask) => {
    const next = !t.doneAt;
    setBusy(t.id);
    // Optimistic: ticking a task should feel instant. Kept on success (the
    // next focus or pull re-reads the list); put back on failure.
    setTasks((ts) => (ts ?? []).map((x) =>
      x.id === t.id ? { ...x, doneAt: next ? new Date().toISOString() : null } : x));
    try {
      await setWorkTaskDone(spaceId, t.id, next);
    } catch (e: any) {
      setTasks((ts) => (ts ?? []).map((x) => (x.id === t.id ? t : x))); // put it back
      Alert.alert('Could not update the task', e?.message ?? 'Please try again.');
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    const t = title.trim();
    if (!t) return;
    setSaving(true);
    try {
      await createWorkTask(spaceId, {
        title: t, priority,
        ...(assignee ? { assigneeId: assignee } : {}),
        ...(dueCustom ? { dueAt: dueAtOn(dueCustom) } : dueDays != null ? { dueAt: dueAtFor(dueDays) } : {}),
      });
      setTitle(''); setPriority('medium'); setAssignee(null); setDueDays(null); setDueCustom(null); setCompose(false);
      await load();
    } catch (e: any) {
      Alert.alert('Could not create the task', e?.message ?? 'Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const open = (tasks ?? []).filter((t) => !t.doneAt);
  const overdue = open.filter((t) => dueWords(t.dueAt).overdue);
  const todo = open.filter((t) => !dueWords(t.dueAt).overdue);
  const done = (tasks ?? []).filter((t) => t.doneAt);
  const shown = tab === 'todo' ? todo : tab === 'overdue' ? overdue : done;
  const s = useMemo(() => styles(colors), [colors]);
  // A picked day that has already ended: allowed (back-filling happens), but
  // said, because the task is overdue the moment it exists.
  const customPast = !!dueCustom && Date.parse(dueAtOn(dueCustom)) < Date.now();

  const TABS = [
    { key: 'todo', label: 'To Do', count: todo.length },
    { key: 'overdue', label: 'Overdue', count: overdue.length },
    { key: 'done', label: 'Done', count: done.length },
  ] as const;

  const row = (t: WorkTask) => {
    const due = dueWords(t.dueAt);
    return (
      <TouchableOpacity
        style={s.row} onPress={() => toggle(t)} disabled={busy === t.id}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: !!t.doneAt, disabled: busy === t.id }}
        accessibilityLabel={`${t.title}, ${t.assigneeName || 'Unassigned'}${due.text ? `, ${due.text}` : ''}`}
      >
        <Ionicons
          name={t.doneAt ? 'checkmark-circle' : 'ellipse-outline'}
          size={24}
          color={t.doneAt ? colors.success : colors.textDim}
        />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[s.title, t.doneAt && s.strike]} numberOfLines={2}>{t.title}</Text>
          <Text style={s.muted} numberOfLines={1}>
            {t.assigneeName || 'Unassigned'}
            {due.text
              ? <Text style={due.overdue ? { color: colors.danger } : undefined}>{` · ${due.text}`}</Text>
              : null}
          </Text>
        </View>
        {/* Priority carries a WORD, not just a colour. */}
        {!t.doneAt && (
          <View style={[s.pill, { backgroundColor: PRIORITY_TONE[t.priority] + '22' }]}>
            <Text style={[s.pillText, { color: PRIORITY_TONE[t.priority] }]}>
              {t.priority === 'high' ? 'High' : t.priority === 'medium' ? 'Medium' : 'Low'}
            </Text>
          </View>
        )}
        {due.overdue && !t.doneAt && (
          <Ionicons name="alert-circle" size={18} color={colors.danger} />
        )}
      </TouchableOpacity>
    );
  };

  return (
    <View style={s.screen}>
      <AuroraBackground />
      <Stack.Screen options={spaceHeader(colors, `${spaceName} · Tasks`, { id: spaceId, name: params.name })} />

      {/* Tabs (Business design: Tasks screen). No "In Progress": the model has
          no such state, and inventing one here would be a lie about the data. */}
      <View style={s.tabs} accessibilityRole="tablist">
        {TABS.map((t) => (
          <TouchableOpacity
            key={t.key}
            onPress={() => setTab(t.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === t.key }}
            style={[s.tab, tab === t.key && { backgroundColor: colors.brandOnLight }]}
          >
            {/* White ink on the solid brandOnLight fill (deep blue in both schemes, 6.3:1). */}
            <Text style={[s.tabText, tab === t.key && { color: colors.onBrand }]}>
              {t.label}{t.count > 0 ? ` (${t.count})` : ''}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <FlatList
        contentContainerStyle={s.body}
        ListHeaderComponentStyle={s.header}
        data={shown}
        keyExtractor={(t) => String(t.id)}
        renderItem={({ item }) => row(item)}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        ListHeaderComponent={<>
          {tasks === null && (
            <View style={s.centre}><ActivityIndicator color={colors.primary} /><Text style={s.muted}>Loading tasks…</Text></View>
          )}

          {err && (
            <LoadError colors={colors} title="Could not load tasks" message={err} onRetry={() => { void onRefresh(); }} />
          )}

          {tasks !== null && tasks.length === 0 && !err && (
            <View style={s.card}>
              <Ionicons name="checkbox-outline" size={26} color={colors.textDim} />
              <Text style={s.cardTitle}>Nothing assigned</Text>
              <Text style={s.muted}>
                {canAssign
                  ? `Create a task and it appears here for whoever it is assigned to.`
                  : `When someone assigns you work in ${spaceName}, it shows up here.`}
              </Text>
            </View>
          )}
        </>}
        ListFooterComponent={tasks !== null && tasks.length > 0 && shown.length === 0
          ? <Text style={s.muted}>Nothing in {TABS.find((t) => t.key === tab)?.label}.</Text>
          : null}
      />

      {canAssign && (
        <TouchableOpacity
          accessibilityRole="button" accessibilityLabel="New task"
          style={[s.fab, { backgroundColor: colors.brandOnLight, bottom: 28 + insets.bottom }]}
          onPress={() => {
            setCompose(true);
            // Assignable people; without the list a task is created unassigned —
            // and the sheet says so (see membersError).
            loadMembers();
          }}
        >
          {/* White ink on the solid brandOnLight fill (deep blue in both schemes, 6.3:1). */}
          <Ionicons name="add" size={26} color={colors.onBrand} />
        </TouchableOpacity>
      )}

      <Modal visible={compose} animationType="slide" transparent onRequestClose={() => setCompose(false)}>
        <KeyboardSafe keyboardOnly>
        <View style={s.sheetWrap}>
          <View style={[s.sheet, { paddingBottom: 18 + insets.bottom }]}>
            <Text style={s.cardTitle}>New task</Text>
            <TextInput
              style={s.input}
              placeholder="What needs doing?"
              placeholderTextColor={colors.textDim}
              value={title}
              onChangeText={setTitle}
              autoFocus
              maxLength={200}
              accessibilityLabel="Task title"
            />
            <View style={s.prioRow}>
              {PRIORITIES.map((p) => (
                <TouchableOpacity
                  key={p.key}
                  onPress={() => setPriority(p.key)}
                  accessibilityRole="radio" accessibilityState={{ checked: priority === p.key }}
                  accessibilityLabel={`${p.label} priority`}
                  style={[s.prio, priority === p.key && { backgroundColor: colors.brandOnLight }]}
                >
                  <Text style={[s.prioText, priority === p.key && { color: colors.onBrand }]}>{p.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={s.prioRow}>
              {DUE.map((d) => (
                <TouchableOpacity
                  key={String(d.days)}
                  onPress={() => { setDueDays(d.days); setDueCustom(null); }}
                  accessibilityRole="radio" accessibilityState={{ checked: !dueCustom && dueDays === d.days }}
                  accessibilityLabel={`Due: ${d.label}`}
                  style={[s.prio, !dueCustom && dueDays === d.days && { backgroundColor: colors.brandOnLight }]}
                >
                  <Text style={[s.prioText, !dueCustom && dueDays === d.days && { color: colors.onBrand }]}>{d.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {/* Beyond the presets: any day, picked. */}
            <TouchableOpacity
              onPress={() => picker.open(dueCustom ?? new Date(), (d) => setDueCustom(d))}
              accessibilityRole="radio" accessibilityState={{ checked: !!dueCustom }}
              accessibilityLabel={dueCustom ? `Due: ${dueCustom.toLocaleDateString()}. Change` : 'Due on another day'}
              style={[s.prio, { flex: 0 }, !!dueCustom && { backgroundColor: colors.brandOnLight }]}
            >
              <Text style={[s.prioText, !!dueCustom && { color: colors.onBrand }]}>
                {dueCustom
                  ? `Due ${dueCustom.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}`
                  : 'Another day…'}
              </Text>
            </TouchableOpacity>
            {customPast && (
              <Text style={[s.muted, { color: colors.warning }]} accessibilityRole="alert">
                That day has already ended, so the task will be overdue as soon as it is created.
              </Text>
            )}
            {membersError && (
              <View style={s.hintRow}>
                <Text style={[s.muted, { flex: 1 }]}>
                  Could not load people to assign, so this task will be unassigned.
                </Text>
                <TouchableOpacity onPress={loadMembers} style={s.hintBtn} accessibilityRole="button" accessibilityLabel="Try loading people again">
                  <Text style={{ color: colors.primary, fontWeight: '700' }}>Try again</Text>
                </TouchableOpacity>
              </View>
            )}
            {members.length > 0 && (
              <ScrollView style={{ maxHeight: 132 }} contentContainerStyle={[s.prioRow, { flexWrap: 'wrap' }]}>
                {[{ id: null as string | null, name: 'Unassigned' }, ...members.map((m) => ({ id: m.id as string | null, name: m.name }))].map((m) => (
                  <TouchableOpacity
                    key={m.id ?? 'none'}
                    onPress={() => setAssignee(m.id)}
                    accessibilityRole="radio" accessibilityState={{ checked: assignee === m.id }}
                    accessibilityLabel={`Assign to ${m.name}`}
                    style={[s.prio, { flex: 0, paddingHorizontal: 12 }, assignee === m.id && { backgroundColor: colors.brandOnLight }]}
                  >
                    <Text numberOfLines={1} style={[s.prioText, assignee === m.id && { color: colors.onBrand }]}>{m.name}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity onPress={() => setCompose(false)} style={[s.btn, s.btnGhost, { flex: 1 }]} accessibilityRole="button" accessibilityLabel="Cancel">
                <Text style={[s.btnText, { color: colors.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={submit}
                disabled={!title.trim() || saving}
                accessibilityRole="button" accessibilityLabel="Create task"
                accessibilityState={{ disabled: !title.trim() || saving, busy: saving }}
                style={[s.btn, { backgroundColor: colors.brandOnLight, flex: 1, opacity: !title.trim() || saving ? 0.5 : 1 }]}
              >
                <Text style={s.btnText}>{saving ? 'Creating…' : 'Create'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
        </KeyboardSafe>
        {/* Inside this Modal so it stacks above it on iOS. */}
        {picker.element}
      </Modal>
    </View>
  );
}

const styles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  body: { padding: 16, gap: 8, paddingBottom: 90 },
  header: { gap: 8 },
  tabs: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 12 },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.glassSoft, borderRadius: 999, minHeight: 44 },
  tabText: { color: c.textDim, fontWeight: '700', fontSize: 12.5 },
  centre: { alignItems: 'center', gap: 10, paddingVertical: 40 },
  card: { backgroundColor: c.glassSoft, borderRadius: 14, padding: 14, gap: 8 },
  cardTitle: { color: c.text, fontSize: 15.5, fontWeight: '700' },
  muted: { color: c.textDim, fontSize: 12.5, lineHeight: 17, flexShrink: 1 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: c.glassSoft, borderRadius: 12, padding: 14,
  },
  title: { color: c.text, fontSize: 15, fontWeight: '600' },
  strike: { textDecorationLine: 'line-through', color: c.textDim },
  pill: { backgroundColor: c.border, borderRadius: 9, paddingHorizontal: 8, paddingVertical: 2 },
  pillText: { color: c.textDim, fontSize: 11, fontWeight: '700' },
  fab: {
    position: 'absolute', right: 20, bottom: 28, width: 56, height: 56, borderRadius: 28,
    alignItems: 'center', justifyContent: 'center', elevation: 4,
  },
  // A fixed dark scrim behind the sheet, the same in both schemes.
  sheetWrap: { flex: 1, backgroundColor: '#0008', justifyContent: 'flex-end' },
  // surfaceSolid, not card: card is a translucent glass pane in the dusk skin,
  // and a see-through sheet over the scrim is unreadable in both schemes.
  sheet: { backgroundColor: c.surfaceSolid, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18, gap: 12 },
  input: {
    backgroundColor: c.bg, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12,
    color: c.text, fontSize: 15,
  },
  prioRow: { flexDirection: 'row', gap: 8 },
  prio: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg, borderRadius: 10, minHeight: 44, paddingHorizontal: 10 },
  hintRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  hintBtn: { minHeight: 44, justifyContent: 'center' },
  prioText: { color: c.textDim, fontWeight: '700', fontSize: 13 },
  btn: { alignItems: 'center', justifyContent: 'center', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 14, minHeight: 44 },
  btnGhost: { backgroundColor: c.bg },
  btnText: { color: c.onBrand, fontWeight: '700', fontSize: 14 },
});
