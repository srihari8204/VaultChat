// app/group-tasks.tsx — the group's shared task list (Groups & Circles, G4.1).
//
// Every change is one encrypted message in the group thread; the list you see
// is the fold of every task event (lib/groups/tasks.ts). That is why this
// screen has no save button, no sync spinner and no conflict dialog: creating a
// task offline queues a message like any other, and the fold is order-
// independent, so devices converge without anything here having to coordinate.

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { KeyboardSafe } from '../components/ui';
import {
  View, StyleSheet, TouchableOpacity, FlatList, TextInput, Alert,
  ActivityIndicator,
} from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { AuroraBackground } from '../components/ui/AuroraBackground';
import { AppText as Text } from '../components/ui/Text';
import { brandAlpha } from '../constants/theme';
import { sendMessage } from '../lib/chatService';
import { readGroupOps } from '../lib/groups/opThread';
import { ThreadGaps } from '../components/groups/ThreadGaps';
import { GroupNotFound } from '../components/groups/GroupNotFound';
import { circleMembers } from '../lib/family/circle';
import { getCurrentUserAsync } from './(constants)/authService';
import { syncTaskReminders } from '../lib/groups/taskReminders';
import {
  encodeOp, decodeOp, foldTasks, sortTasks, isOverdue, newTaskId,
  type Task, type TaskOp,
} from '../lib/groups/tasks';
import { type CircleMember } from '../lib/family/types';

const DUE_PRESETS: { label: string; ms: number | null }[] = [
  { label: 'No date', ms: null },
  { label: 'Today', ms: 0 },
  { label: 'Tomorrow', ms: 24 * 3600_000 },
  { label: 'This week', ms: 7 * 24 * 3600_000 },
];

const endOfDay = (base: number) => { const d = new Date(base); d.setHours(23, 59, 0, 0); return d.getTime(); };

function dueLabel(ts: number, now: number): string {
  const d = new Date(ts), today = new Date(now);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (new Date(now + 86400_000).toDateString() === d.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export default function GroupTasksScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ groupId?: string; name?: string }>();
  const groupId = String(params.groupId || '');

  const [tasks, setTasks] = useState<Task[]>([]);
  const [members, setMembers] = useState<CircleMember[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Rebuild failed: an error when nothing is listed, a banner over the list otherwise.
  const [failed, setFailed] = useState(false);
  // What the last read could not see (lib/groups/opThread).
  const [gaps, setGaps] = useState<{ unreadable: number; complete: boolean }>({ unreadable: 0, complete: true });
  const [title, setTitle] = useState('');
  const [dueMs, setDueMs] = useState<number | null>(null);
  const [assignee, setAssignee] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The ops the list was folded from: a new op is folded onto these, not onto
  // adds rebuilt from the folded list (which lost edits' order and authors).
  const opsRef = useRef<TaskOp[]>([]);
  /** Rebuild the list by folding every task event in the thread. */
  const rebuild = useCallback(async () => {
    if (!groupId) { setLoading(false); return; }
    try {
      // Paged server read plus this device's own history (lib/groups/opThread).
      const { ops, unreadable, complete } = await readGroupOps<TaskOp>(groupId, decodeOp);
      opsRef.current = ops;
      setGaps({ unreadable, complete });
      const folded = foldTasks(ops);
      setTasks(folded);
      setFailed(false);
      // Reconcile OS reminders against the list we just rebuilt. Driven from
      // here rather than from the save handler because the list is a fold: a
      // due date moved on somebody else's phone arrives as a rebuild, not as a
      // tap. Idempotent, so an unchanged list books and cancels nothing.
      const u = await getCurrentUserAsync().catch(() => null);
      syncTaskReminders(groupId, folded, u ? String(u.id) : null).catch(() => {});
    } catch {
      // Offline: keep whatever is already on screen rather than blanking it.
      setFailed(true);
    } finally { setLoading(false); }
  }, [groupId]);

  useFocusEffect(useCallback(() => {
    let live = true;
    (async () => {
      const u = await getCurrentUserAsync().catch(() => null);
      if (live) setMe(u ? String(u.id) : null);
      if (groupId) circleMembers(groupId).then((m) => live && setMembers(m)).catch(() => {});
      await rebuild();
    })();
    return () => { live = false; };
  }, [groupId, rebuild]));

  /** Publish one event, then optimistically fold it in so the UI is instant. Resolves false on failure. */
  const publish = async (op: TaskOp): Promise<boolean> => {
    opsRef.current = [...opsRef.current, op];
    setTasks(foldTasks(opsRef.current));
    try {
      await sendMessage(groupId, encodeOp(op));
      return true;
    } catch (e: any) {
      // Take the unsent op back out first, so an offline re-read below does
      // not leave a change on screen that nobody received.
      opsRef.current = opsRef.current.filter((x) => x !== op);
      setTasks(foldTasks(opsRef.current));
      Alert.alert('Not saved', e?.message ?? 'Could not reach the group. Try again.');
      rebuild();
      return false;
    }
  };

  const addTask = async () => {
    const t = title.trim();
    if (!t || busy || !me) return;
    setBusy(true);
    const at = Date.now();
    const ok = await publish({
      k: 'add', id: newTaskId(), at, by: me, title: t,
      assignee, dueAt: dueMs == null ? null : endOfDay(at + dueMs),
    });
    // Keep what was typed when the send failed, so Retry is one tap.
    if (ok) { setTitle(''); setDueMs(null); setAssignee(null); }
    setBusy(false);
  };

  const toggle = (t: Task) => {
    if (!me) return;
    publish({ k: 'done', id: t.id, at: Date.now(), by: me, done: !t.done });
  };

  const remove = (t: Task) => {
    if (!me) return;
    Alert.alert('Delete task?', `"${t.title}" will be removed for everyone.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => publish({ k: 'del', id: t.id, at: Date.now(), by: me }) },
    ]);
  };

  const nameOf = (id: string | null) =>
    !id ? null : id === me ? 'You' : members.find((m) => m.id === id)?.name ?? 'Member';

  const now = Date.now();
  const ordered = useMemo(() => sortTasks(tasks), [tasks]);
  const open = ordered.filter((t) => !t.done).length;

  if (!groupId) return <GroupNotFound title="Tasks" />;

  return (
    <KeyboardSafe style={{ flex: 1, backgroundColor: colors.bg }}>
      <AuroraBackground variant="chat" />
      <Stack.Screen options={{ headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text, headerShadowVisible: false,
        headerShown: true, /* the root Stack sets headerShown:false app-wide, so the options below were inert and this screen had no back control at all */  title: 'Tasks', headerTitleAlign: 'center' }} />
      <FlatList
        data={ordered}
        keyExtractor={(t) => t.id}
        // Rows also read member names (assignee) and the clock (overdue).
        extraData={members}
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={<>
          <View style={[st.field, { borderColor: colors.glassStroke, backgroundColor: colors.glassSoft }]}>
            <Ionicons name="add-circle-outline" size={19} color={colors.textDim} />
            <TextInput
              value={title} onChangeText={setTitle} placeholder="Add a task…" accessibilityLabel="New task"
              placeholderTextColor={colors.textFaint} style={[st.input, { color: colors.text }]}
              returnKeyType="done" onSubmitEditing={addTask} maxLength={200}
            />
            {!!title.trim() && (
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Add this task" accessibilityState={{ disabled: busy || !me, busy }} onPress={addTask} disabled={busy || !me} hitSlop={10}>
                {busy ? <ActivityIndicator size="small" color={colors.primary} />
                  : <Ionicons name="arrow-forward-circle" size={26} color={colors.primary} />}
              </TouchableOpacity>
            )}
          </View>

          {!!title.trim() && (
            <>
              <View style={st.chips} accessibilityRole="radiogroup" accessibilityLabel="Due date">
                {DUE_PRESETS.map((d) => {
                  const on = dueMs === d.ms;
                  return (
                    <TouchableOpacity key={d.label} onPress={() => setDueMs(d.ms)}
                      accessibilityRole="radio" accessibilityLabel={`Due ${d.label}`} accessibilityState={{ selected: on, checked: on }}
                      style={[st.chip, { borderColor: on ? colors.primary : colors.border, backgroundColor: on ? brandAlpha(0.1) : 'transparent' }]}>
                      <Text style={{ color: on ? colors.primary : colors.text, fontSize: 12 }}>{d.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <View style={st.chips} accessibilityRole="radiogroup" accessibilityLabel="Assigned to">
                <TouchableOpacity onPress={() => setAssignee(null)}
                  accessibilityRole="radio" accessibilityLabel="Assign to anyone" accessibilityState={{ selected: assignee == null, checked: assignee == null }}
                  style={[st.chip, { borderColor: assignee == null ? colors.primary : colors.border, backgroundColor: assignee == null ? brandAlpha(0.1) : 'transparent' }]}>
                  <Text style={{ color: assignee == null ? colors.primary : colors.text, fontSize: 12 }}>Anyone</Text>
                </TouchableOpacity>
                {members.map((m) => {
                  const on = assignee === m.id;
                  return (
                    <TouchableOpacity key={m.id} onPress={() => setAssignee(m.id)}
                      accessibilityRole="radio" accessibilityLabel={`Assign to ${m.id === me ? 'me' : m.name}`} accessibilityState={{ selected: on, checked: on }}
                      style={[st.chip, { borderColor: on ? colors.primary : colors.border, backgroundColor: on ? brandAlpha(0.1) : 'transparent' }]}>
                      <Text style={{ color: on ? colors.primary : colors.text, fontSize: 12 }} numberOfLines={1}>
                        {m.id === me ? 'Me' : m.name}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </>
          )}

          <View style={st.sechead}>
            <Text style={[st.h, { color: colors.text }]} accessibilityRole="header">
              {open ? `${open} to do` : 'All done'}
            </Text>
            {loading && <ActivityIndicator size="small" color={colors.primary} />}
          </View>

          {!loading && ordered.length === 0 && failed && (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Couldn't load tasks. Retry" onPress={() => { setLoading(true); rebuild(); }}>
              <Text style={{ color: colors.danger, fontSize: 13.5 }}>Couldn’t load tasks. Tap to retry.</Text>
            </TouchableOpacity>
          )}
          {!loading && ordered.length === 0 && !failed && (
            <Text style={{ color: colors.textDim, fontSize: 13.5 }}>
              Nothing yet. Anything you add here is shared with the group and stays encrypted.
            </Text>
          )}

          {!loading && ordered.length > 0 && failed && (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Couldn't refresh tasks. Showing what was loaded before. Retry"
              onPress={() => { setLoading(true); rebuild(); }}
              style={[st.banner, { borderColor: colors.danger }]}>
              <Ionicons name="cloud-offline-outline" size={15} color={colors.danger} />
              <Text style={{ color: colors.danger, fontSize: 12.5, flex: 1 }}>Couldn’t refresh — this list may be out of date. Tap to retry.</Text>
            </TouchableOpacity>
          )}
        </>}
        renderItem={({ item: t }) => {
          const late = isOverdue(t, now);
          const who = nameOf(t.assignee);
          const due = t.dueAt != null ? `${late ? 'overdue, ' : ''}due ${dueLabel(t.dueAt, now)}` : '';
          return (
            <View style={[st.row, { borderColor: colors.glassStroke }]}>
              <TouchableOpacity accessibilityRole="checkbox" accessibilityState={{ checked: t.done }}
                accessibilityLabel={[t.title, who ? `for ${who}` : '', due].filter(Boolean).join(', ')}
                accessibilityHint={t.done ? 'Marks it not done' : 'Marks it done'} onPress={() => toggle(t)} style={st.check} hitSlop={10}>
                <Ionicons
                  name={t.done ? 'checkmark-circle' : 'ellipse-outline'}
                  size={23}
                  color={t.done ? colors.success : colors.textDim}
                />
              </TouchableOpacity>
              {/* Read as part of the checkbox above (title, assignee, due). */}
              <View style={{ flex: 1, minWidth: 0 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                <Text
                  style={{
                    color: t.done ? colors.textDim : colors.text, fontSize: 14.5,
                    textDecorationLine: t.done ? 'line-through' : 'none',
                  }}
                  numberOfLines={2}
                >
                  {t.title}
                </Text>
                {(who || t.dueAt != null) && (
                  <Text style={{ color: late ? colors.danger : colors.textDim, fontSize: 11.5, marginTop: 2 }}>
                    {who ? who : ''}{who && t.dueAt != null ? ' · ' : ''}
                    {t.dueAt != null ? `${late ? 'Overdue — ' : ''}${dueLabel(t.dueAt, now)}` : ''}
                  </Text>
                )}
              </View>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Delete the task ${t.title}`} onPress={() => remove(t)} style={{ padding: 6 }} hitSlop={8}>
                <Ionicons name="trash-outline" size={17} color={colors.textFaint} />
              </TouchableOpacity>
            </View>
          );
        }}
        ListFooterComponent={loading ? null : <ThreadGaps unreadable={gaps.unreadable} complete={gaps.complete} what="tasks" />}
      />
    </KeyboardSafe>
  );
}

const st = StyleSheet.create({
  field: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, minHeight: 52 },
  input: { flex: 1, fontSize: 15 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 10 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  sechead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 26, marginBottom: 8 },
  h: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  check: { padding: 2 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderWidth: 1, borderRadius: 12, marginBottom: 8 },
});
