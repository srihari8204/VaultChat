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

import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  RefreshControl, Modal, TextInput, Alert,
} from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import type { Palette } from '../constants/theme';
import { getWorkTasks, createWorkTask, setWorkTaskDone, type WorkTask } from '../lib/spaces/api';

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
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ spaceId?: string; name?: string; perms?: string }>();
  const spaceId = String(params.spaceId || '');
  const spaceName = String(params.name || 'This space');

  const canAssign = useMemo(
    () => String(params.perms || '').split(',').includes('view_space_ops'),
    [params.perms],
  );

  const [tasks, setTasks] = useState<WorkTask[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [compose, setCompose] = useState(false);
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<'low' | 'medium' | 'high'>('medium');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!spaceId) { setErr('No space was given.'); setTasks([]); return; }
    try {
      setErr(null);
      setTasks(await getWorkTasks(spaceId));
    } catch (e: any) {
      // A plain member with no ops rights is not an error state — the server
      // simply has nothing scoped to them. Anything else is worth showing.
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
    // Optimistic: ticking a task should feel instant. Reconciled by reload.
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
      await createWorkTask(spaceId, { title: t, priority });
      setTitle(''); setPriority('medium'); setCompose(false);
      await load();
    } catch (e: any) {
      Alert.alert('Could not create the task', e?.message ?? 'Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const open = (tasks ?? []).filter((t) => !t.doneAt);
  const done = (tasks ?? []).filter((t) => t.doneAt);
  const s = styles(colors);

  const row = (t: WorkTask) => {
    const due = dueWords(t.dueAt);
    return (
      <TouchableOpacity key={t.id} style={s.row} onPress={() => toggle(t)} disabled={busy === t.id}>
        <Ionicons
          name={t.doneAt ? 'checkmark-circle' : 'ellipse-outline'}
          size={24}
          color={t.doneAt ? colors.success : colors.textDim}
        />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[s.title, t.doneAt && s.strike]} numberOfLines={2}>{t.title}</Text>
          <Text style={s.muted} numberOfLines={1}>
            {t.assigneeName || 'Unassigned'}
            {due.text ? ` · ${due.text}` : ''}
          </Text>
        </View>
        {/* Priority carries a WORD, not just a colour. */}
        {!t.doneAt && t.priority !== 'medium' && (
          <View style={[s.pill, t.priority === 'high' && { backgroundColor: colors.danger + '22' }]}>
            <Text style={[s.pillText, t.priority === 'high' && { color: colors.danger }]}>
              {t.priority === 'high' ? 'High' : 'Low'}
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
      <Stack.Screen options={{ title: `${spaceName} · Tasks` }} />
      <ScrollView
        contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {tasks === null && (
          <View style={s.centre}><ActivityIndicator color={colors.primary} /><Text style={s.muted}>Loading tasks…</Text></View>
        )}

        {err && (
          <View style={[s.card, { borderColor: colors.danger, borderWidth: 1 }]}>
            <Text style={s.cardTitle}>Could not load tasks</Text>
            <Text style={s.muted}>{err}</Text>
            <TouchableOpacity onPress={load} style={[s.btn, { backgroundColor: colors.primary }]}>
              <Text style={s.btnText}>Try again</Text>
            </TouchableOpacity>
          </View>
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

        {open.length > 0 && <Text style={s.section}>TO DO · {open.length}</Text>}
        {open.map(row)}

        {done.length > 0 && <Text style={s.section}>DONE · {done.length}</Text>}
        {done.map(row)}
      </ScrollView>

      {canAssign && (
        <TouchableOpacity style={[s.fab, { backgroundColor: colors.primary }]} onPress={() => setCompose(true)}>
          <Ionicons name="add" size={26} color="#fff" />
        </TouchableOpacity>
      )}

      <Modal visible={compose} animationType="slide" transparent onRequestClose={() => setCompose(false)}>
        <View style={s.sheetWrap}>
          <View style={s.sheet}>
            <Text style={s.cardTitle}>New task</Text>
            <TextInput
              style={s.input}
              placeholder="What needs doing?"
              placeholderTextColor={colors.textDim}
              value={title}
              onChangeText={setTitle}
              autoFocus
              maxLength={200}
            />
            <View style={s.prioRow}>
              {PRIORITIES.map((p) => (
                <TouchableOpacity
                  key={p.key}
                  onPress={() => setPriority(p.key)}
                  style={[s.prio, priority === p.key && { backgroundColor: colors.primary }]}
                >
                  <Text style={[s.prioText, priority === p.key && { color: '#fff' }]}>{p.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity onPress={() => setCompose(false)} style={[s.btn, s.btnGhost, { flex: 1 }]}>
                <Text style={[s.btnText, { color: colors.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={submit}
                disabled={!title.trim() || saving}
                style={[s.btn, { backgroundColor: colors.primary, flex: 1, opacity: !title.trim() || saving ? 0.5 : 1 }]}
              >
                <Text style={s.btnText}>{saving ? 'Creating…' : 'Create'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  body: { padding: 16, gap: 8, paddingBottom: 90 },
  centre: { alignItems: 'center', gap: 10, paddingVertical: 40 },
  card: { backgroundColor: c.card, borderRadius: 14, padding: 14, gap: 8 },
  cardTitle: { color: c.text, fontSize: 15.5, fontWeight: '700' },
  muted: { color: c.textDim, fontSize: 12.5, lineHeight: 17, flexShrink: 1 },
  section: { color: c.textFaint, fontSize: 11.5, fontWeight: '800', marginTop: 12, marginBottom: 2 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: c.card, borderRadius: 12, padding: 14,
  },
  title: { color: c.text, fontSize: 15, fontWeight: '600' },
  strike: { textDecorationLine: 'line-through', color: c.textDim },
  pill: { backgroundColor: c.border, borderRadius: 9, paddingHorizontal: 8, paddingVertical: 2 },
  pillText: { color: c.textDim, fontSize: 11, fontWeight: '700' },
  fab: {
    position: 'absolute', right: 20, bottom: 28, width: 56, height: 56, borderRadius: 28,
    alignItems: 'center', justifyContent: 'center', elevation: 4,
  },
  sheetWrap: { flex: 1, backgroundColor: '#0008', justifyContent: 'flex-end' },
  sheet: { backgroundColor: c.card, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18, gap: 12 },
  input: {
    backgroundColor: c.bg, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12,
    color: c.text, fontSize: 15,
  },
  prioRow: { flexDirection: 'row', gap: 8 },
  prio: { flex: 1, alignItems: 'center', backgroundColor: c.bg, borderRadius: 10, paddingVertical: 10 },
  prioText: { color: c.textDim, fontWeight: '700', fontSize: 13 },
  btn: { alignItems: 'center', justifyContent: 'center', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 14 },
  btnGhost: { backgroundColor: c.bg },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
});
