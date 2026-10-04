// app/lock-history.tsx — Lock History & Statistics. Sessions newest-first with
// event filters (all / exits / returns / alarms), expandable per-session event
// timeline, Today / 7-day / 30-day rollups (pure SQL, offline), JSON/CSV export
// via the OS share sheet, and per-session / clear-all deletion. Local-only:
// these screens make no network requests (spec: lock-history).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, TouchableOpacity, StyleSheet, FlatList, Alert, Share, TextInput, ActivityIndicator } from 'react-native';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { tint } from '../lib/tintColor';
import type { Palette } from '../constants/theme';
import { zoneColor } from '../lib/lock/zoneMachine';
import { ALARM } from '../lib/lock/alarmPalette';
import {
  getSessions, getEvents, statsForRange, distancePerDay, deleteSession, clearAllHistory,
  exportHistoryJSON, exportHistoryCSV, setSessionNotes,
  type LockSessionRow, type LockEventRow, type HistoryFilter, type LockStats,
} from '../lib/lock/lockStore';
import { fmtDistance, type Units } from '../lib/lock/format';
import { useLockSettings } from '../lib/lock/lockSettings';
import { AppText as Text, AuroraBackground, KeyboardSafe } from '../components/ui';

const FILTERS: { key: HistoryFilter; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'exits', label: 'Exits' },
  { key: 'returns', label: 'Returns' }, { key: 'alarms', label: 'Alerts' },
];
const RANGES = [
  { key: 'today', label: 'Today', days: 1 },
  { key: '7d', label: '7 days', days: 7 },
  { key: '30d', label: '30 days', days: 30 },
] as const;

const fmtMs = (ms: number) => {
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : m ? `${m}m` : `${Math.floor(ms / 1000)}s`;
};
const fmtT = (t: number) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Sessions per page. lockStore.getSessions caps every read; "Show more"
 *  raises the cap instead of silently stopping at the first page. */
const PAGE = 100;

type EventMeta = { icon: keyof typeof Ionicons.glyphMap; color: string; label: string };
/** Event glyphs. Colours come from the theme, the zone colours and the alarm
 *  palette, so the timeline matches the lock screens in either theme. */
const eventMeta = (type: string, c: Palette): EventMeta => {
  switch (type) {
    case 'warning':     return { icon: 'alert',       color: zoneColor('warning'), label: 'Near boundary' };
    case 'exit':        return { icon: 'exit',        color: c.danger,         label: 'Exited zone' };
    case 'alarm_start': return { icon: 'volume-high', color: ALARM.sounding,   label: 'Alarm started' };
    case 'alarm_stop':  return { icon: 'volume-mute', color: ALARM.grace,      label: 'Alarm stopped' };
    case 'return':      return { icon: 'enter',       color: c.success,        label: 'Returned to safe zone' };
    case 'unlocked':    return { icon: 'lock-open',   color: c.textDim,        label: 'Unlocked' };
    default:            return { icon: 'lock-closed', color: c.primary,        label: 'Locked' };
  }
};

/** Filter / range chip: a radio inside its radiogroup. Hoisted: defined inside
 *  the screen it was a new component type on every render. */
function Chip({ on, label, onPress, colors }: { on: boolean; label: string; onPress: () => void; colors: Palette }) {
  return (
    <TouchableOpacity onPress={onPress}
      accessibilityRole="radio" accessibilityState={{ checked: on }}
      style={[st.chip, { borderColor: on ? colors.primary : colors.border, backgroundColor: on ? tint(colors.primary, 0.1) : 'transparent' }]}>
      <Text style={{ color: on ? colors.primary : colors.text, fontWeight: on ? '700' : '500', fontSize: 12.5 }}>{label}</Text>
    </TouchableOpacity>
  );
}

/** Everything the summary shows, spoken: its label replaces the children, so a
 *  shorter label dropped the radius, duration, alarm time, time outside and note. */
function sessionLabel(s: LockSessionRow, units: Units): string {
  const parts = [
    `Lock session ${fmtT(s.started_at)}`,
    `radius ${fmtDistance(s.radius, units)}`,
    s.ended_at ? `lasted ${fmtMs(s.ended_at - s.started_at)}` : 'active',
    s.exits ? `${s.exits} exit${s.exits > 1 ? 's' : ''}, max ${fmtDistance(s.max_distance, units)}` : 'stayed inside',
  ];
  if (s.alarm_ms > 0) parts.push(`alarm ${fmtMs(s.alarm_ms)}`);
  parts.push(`outside ${fmtMs(s.time_outside_ms)}`);
  if (s.notes) parts.push(`note: ${s.notes}`);
  return parts.join(', ');
}

export default function LockHistoryScreen() {
  const { colors } = useTheme();
  const settings = useLockSettings();
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [range, setRange] = useState<(typeof RANGES)[number]['key']>('today');
  const [sessions, setSessions] = useState<LockSessionRow[]>([]);
  const [stats, setStats] = useState<LockStats | null>(null);
  const [trend, setTrend] = useState<{ day: string; meters: number }[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [events, setEvents] = useState<LockEventRow[]>([]);
  /** The open session's timeline could not be read (not "no events"). */
  const [eventsFailed, setEventsFailed] = useState(false);
  /** The open session's events are being read (first open or Retry). */
  const [eventsLoading, setEventsLoading] = useState(false);
  /** The session whose events are wanted now: a slower read for a session
   *  toggled earlier must not land under this one. */
  const openRef = useRef<number | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [savingNote, setSavingNote] = useState(false);
  const [noteSaved, setNoteSaved] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  // 'loading' and 'error' are not "No lock sessions yet" — the empty copy used
  // to show while loading and after a failed read alike.
  const [load, setLoad] = useState<'loading' | 'ok' | 'error'>('loading');
  /** A Retry after a failed read is in flight: only then does the header
   *  banner show "Refreshing…". Filter, range and "Show more" changes keep the
   *  list up and show progress in the footer instead. */
  const [retrying, setRetrying] = useState(false);
  /** The newest reload: an older read (previous filter, range or limit) that
   *  resolves later must not overwrite it. */
  const reqRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const reload = useCallback(async () => {
    const rows = await getSessions(filter, limit);
    const days = RANGES.find((r) => r.key === range)!.days;
    const now = new Date();
    const from = days === 1
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
      : Date.now() - days * 86_400_000;
    const stat = await statsForRange(from, Date.now() + 1);
    const tr = await distancePerDay(7);
    return { rows, stat, tr };
  }, [filter, range, limit]);

  /** Every reload reports into `load`, so a failure is never silent. */
  const refresh = useCallback(() => {
    const req = ++reqRef.current;
    return reload().then((d) => {
      if (req !== reqRef.current || !mountedRef.current) return;
      setSessions(d.rows); setStats(d.stat); setTrend(d.tr);
      setLoad('ok'); setRetrying(false);
    }, () => {
      if (req !== reqRef.current || !mountedRef.current) return;
      setLoad('error'); setRetrying(false);
    });
  }, [reload]);
  // A filter, range or "Show more" change reloads: show progress meanwhile.
  useEffect(() => { setLoad('loading'); refresh(); }, [refresh]);
  const retry = () => { setRetrying(true); setLoad('loading'); refresh(); };

  const loadEvents = async (id: number) => {
    setEventsFailed(false);
    setEventsLoading(true);
    try {
      const evs = await getEvents(id);
      if (openRef.current === id && mountedRef.current) setEvents(evs);
    } catch { if (openRef.current === id && mountedRef.current) setEventsFailed(true); }
    finally { if (openRef.current === id && mountedRef.current) setEventsLoading(false); }
  };

  const toggle = (id: number) => {
    if (open === id) { openRef.current = null; setOpen(null); return; }
    openRef.current = id;
    setOpen(id);
    setEvents([]);   // never show the previous session's events under this one
    setNoteSaved(false);
    setNoteDraft(sessions.find((s) => s.id === id)?.notes ?? '');
    loadEvents(id);
  };

  const share = async (make: () => Promise<string>, title: string) => {
    try { await Share.share({ message: await make(), title }); }
    catch { Alert.alert('Export failed', 'Lock history could not be exported. Try again.'); }
  };

  const doExport = () => {
    Alert.alert('Export history', 'Choose a format', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'CSV', onPress: () => share(exportHistoryCSV, 'location-lock-history.csv') },
      { text: 'JSON', onPress: () => share(exportHistoryJSON, 'location-lock-history.json') },
    ]);
  };

  const doClear = () => {
    Alert.alert('Delete all history?', 'This is immediate and irreversible.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete all', style: 'destructive', onPress: async () => {
        try { await clearAllHistory(); } catch { Alert.alert('Delete failed', 'History could not be deleted. Try again.'); }
        refresh();
      } },
    ]);
  };

  const removeOne = (id: number) => {
    Alert.alert('Delete this session?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try { await deleteSession(id); if (openRef.current === id) { openRef.current = null; setOpen(null); } }
        catch { Alert.alert('Delete failed', 'This session could not be deleted. Try again.'); }
        refresh();
      } },
    ]);
  };

  const saveNote = async (id: number) => {
    if (savingNote) return;
    setSavingNote(true);
    try { await setSessionNotes(id, noteDraft); }
    catch { Alert.alert('Not saved', 'The note could not be saved. Try again.'); return; }
    finally { setSavingNote(false); }
    setNoteSaved(true);
    refresh();
  };

  const trendMax = Math.max(...trend.map((x) => x.meters), 1);

  const header = (
    <View>
      {/* statistics */}
      <View style={[st.chips, { marginTop: 4 }]} accessibilityRole="radiogroup" accessibilityLabel="Statistics period">
        {RANGES.map((r) => <Chip key={r.key} on={range === r.key} label={r.label} onPress={() => setRange(r.key)} colors={colors} />)}
      </View>
      {stats && (
        <View style={[st.statsCard, { backgroundColor: colors.glassSoft, borderColor: colors.glassStroke }]}>
          <StatCell label="Locks" value={String(stats.locks)} colors={colors} />
          <StatCell label="Exits" value={String(stats.exits)} colors={colors} />
          <StatCell label="Alarms" value={String(stats.alarms)} colors={colors} />
          <StatCell label="Time outside" value={fmtMs(stats.timeOutsideMs)} colors={colors} />
          <StatCell label="Protected" value={fmtMs(stats.timeProtectedMs)} colors={colors} />
          <StatCell label="Avg duration" value={stats.avgDurationMs ? fmtMs(stats.avgDurationMs) : '—'} colors={colors} />
          <StatCell label="Distance" value={fmtDistance(stats.distanceTraveled, settings.units)} colors={colors} />
          <StatCell label="Avg GPS ±" value={stats.avgAccuracyM ? fmtDistance(stats.avgAccuracyM, settings.units) : '—'} colors={colors} />
          <StatCell label="Avg radius" value={stats.avgRadiusM ? fmtDistance(stats.avgRadiusM, settings.units) : '—'} colors={colors} />
        </View>
      )}

      {/* 7-day distance trend (plain Views — no chart lib) */}
      {trend.some((t) => t.meters > 0) && (
        <View style={[st.trendCard, { backgroundColor: colors.glassSoft, borderColor: colors.glassStroke }]}>
          <Text style={{ color: colors.textDim, fontSize: 11.5, fontWeight: '700', marginBottom: 8 }}>
            DISTANCE WHILE LOCKED — LAST 7 DAYS
          </Text>
          <View style={st.trendRow}>
            {trend.map((t) => {
              return (
                <View key={t.day} style={st.trendCol}
                  accessible accessibilityLabel={`${t.day}: ${fmtDistance(t.meters, settings.units)}`}>
                  <View style={[st.trendBar, {
                    height: Math.max(3, (t.meters / trendMax) * 56),
                    backgroundColor: t.meters > 0 ? colors.primary : colors.border,
                  }]} />
                  <Text style={{ color: colors.textDim, fontSize: 10, marginTop: 4 }}>{t.day}</Text>
                </View>
              );
            })}
          </View>
        </View>
      )}

      {/* filters + actions */}
      <View style={[st.rowBetween, { marginTop: 16 }]}>
        <View style={st.chips} accessibilityRole="radiogroup" accessibilityLabel="Show sessions">
          {FILTERS.map((f) => <Chip key={f.key} on={filter === f.key} label={f.label} onPress={() => setFilter(f.key)} colors={colors} />)}
        </View>
      </View>
      <View style={[st.rowBetween, { marginTop: 10, marginBottom: 6 }]}>
        <TouchableOpacity onPress={doExport} accessibilityRole="button" accessibilityLabel="Export history" style={st.linkBtn}>
          <Ionicons name="share-outline" size={15} color={colors.primary} />
          <Text style={{ color: colors.primary, fontWeight: '600', fontSize: 13 }}>Export</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={doClear} accessibilityRole="button" accessibilityLabel="Delete all history" style={st.linkBtn}>
          <Ionicons name="trash-outline" size={15} color={colors.danger} />
          <Text style={{ color: colors.danger, fontWeight: '600', fontSize: 13 }}>Delete all</Text>
        </TouchableOpacity>
      </View>
      {/* The empty-list error below cannot show while sessions are listed, so a
          failed reload (after a filter change, delete or note save) gets this.
          While its Retry runs, the banner stays (neutral border) with progress
          instead of vanishing silently; ordinary reloads do not show it. */}
      {sessions.length > 0 && (load === 'error' || (load === 'loading' && retrying)) && (
        <View accessibilityLiveRegion="polite" style={[st.rowBetween, st.errBanner, { borderColor: load === 'error' ? colors.danger : colors.glassStroke, backgroundColor: colors.glass }]}>
          <Text style={{ color: colors.text, fontSize: 13, flex: 1 }}>
            {load === 'loading' ? 'Refreshing lock history…' : 'Couldn\u2019t refresh lock history. The list may be out of date.'}
          </Text>
          {load === 'loading'
            ? <ActivityIndicator size="small" color={colors.primary} accessibilityLabel="Refreshing" />
            : (
              <TouchableOpacity onPress={retry} accessibilityRole="button" accessibilityLabel="Retry loading lock history" hitSlop={12}>
                <Text style={{ color: colors.primary, fontWeight: '700' }}>Retry</Text>
              </TouchableOpacity>
            )}
        </View>
      )}
    </View>
  );

  return (
    // The note field sits inside the list: pad the screen by the keyboard so the
    // list shrinks to the visible area and a lower session's note can scroll
    // clear of it (native header: no resting bottom inset to add).
    <KeyboardSafe style={st.screen} keyboardOnly>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: true, title: 'Lock History', headerTitleAlign: 'center', headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text }} />
      <FlatList
        data={sessions}
        keyExtractor={(s) => String(s.id)}
        // Save is tappable while the note's keyboard is open.
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={header}
        // Progress for a filter, range or "Show more" reload of a listed history
        // (the empty list shows its own spinner; a Retry shows it in the banner).
        ListFooterComponent={sessions.length > 0 && load === 'loading' ? (
          retrying ? null : <ActivityIndicator color={colors.primary} style={{ marginTop: 16 }} accessibilityLabel="Loading sessions" />
        ) : sessions.length >= limit ? (
          <TouchableOpacity onPress={() => setLimit((l) => l + PAGE)} accessibilityRole="button"
            accessibilityLabel={`Showing the latest ${sessions.length} sessions. Show more`}
            hitSlop={12} style={{ alignSelf: 'center', marginTop: 16, minHeight: 44, justifyContent: 'center' }}>
            <Text style={{ color: colors.primary, fontWeight: '700', fontSize: 13 }}>Showing the latest {sessions.length} · Show more</Text>
          </TouchableOpacity>
        ) : null}
        contentContainerStyle={st.body}
        ListEmptyComponent={
          load === 'loading' ? (
            <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
          ) : load === 'error' ? (
            <View style={{ alignItems: 'center', marginTop: 40, gap: 10 }}>
              <Text style={{ color: colors.textDim, fontSize: 13.5 }}>Couldn&apos;t read lock history on this phone.</Text>
              <TouchableOpacity onPress={retry} accessibilityRole="button" accessibilityLabel="Retry loading lock history" hitSlop={12}>
                <Text style={{ color: colors.primary, fontWeight: '700' }}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <Text style={{ color: colors.textDim, textAlign: 'center', marginTop: 40, fontSize: 13.5 }}>
              No lock sessions {filter !== 'all' ? 'matching this filter ' : ''}yet.
            </Text>
          )
        }
        renderItem={({ item: s }) => (
          // Only the summary is the toggle. The note input, Save and Delete
          // used to sit INSIDE the accessible card, which iOS groups into one
          // element, so VoiceOver could not reach them.
          <View style={[st.session, { backgroundColor: colors.glass, borderColor: colors.glassStroke }]}>
            <TouchableOpacity onPress={() => toggle(s.id)} onLongPress={() => removeOne(s.id)}
              accessibilityRole="button"
              accessibilityLabel={sessionLabel(s, settings.units)}
              accessibilityState={{ expanded: open === s.id }}
              accessibilityHint="Shows the event timeline"
              // Long-press stays as a shortcut; screen readers get a named action.
              accessibilityActions={[{ name: 'delete', label: 'Delete session' }]}
              onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'delete') removeOne(s.id); }}>
              <View style={st.rowBetween}>
                <Text style={{ color: colors.text, fontWeight: '800', fontSize: 14 }}>{fmtT(s.started_at)}</Text>
                <Text style={{ color: colors.textDim, fontSize: 12.5 }}>
                  {fmtDistance(s.radius, settings.units)} · {s.ended_at ? fmtMs(s.ended_at - s.started_at) : 'active'}
                </Text>
              </View>
              <View style={[st.rowBetween, { marginTop: 6 }]}>
                <Text style={{ color: s.exits ? colors.danger : colors.success, fontSize: 12.5, fontWeight: '600' }}>
                  {s.exits ? `${s.exits} exit${s.exits > 1 ? 's' : ''} · max ${fmtDistance(s.max_distance, settings.units)}` : 'Stayed inside'}
                </Text>
                <Text style={{ color: colors.textDim, fontSize: 12.5 }}>
                  {s.alarm_ms > 0 ? `alarm ${fmtMs(s.alarm_ms)} · ` : ''}outside {fmtMs(s.time_outside_ms)}
                </Text>
              </View>
              {!!s.notes && open !== s.id && (
                <View style={[st.linkRow, { marginTop: 4 }]}>
                  <Ionicons name="document-text-outline" size={12} color={colors.textFaint} accessibilityElementsHidden importantForAccessibility="no" />
                  <Text numberOfLines={1} style={{ color: colors.textFaint, fontSize: 12, flex: 1 }}>{s.notes}</Text>
                </View>
              )}
            </TouchableOpacity>

            {open === s.id && (
              <View style={[st.timeline, { borderColor: colors.glassStroke }]}>
                {eventsLoading && (
                  <ActivityIndicator size="small" color={colors.primary} style={{ alignSelf: 'flex-start', marginVertical: 4 }}
                    accessibilityLabel="Loading this session's events" />
                )}
                {eventsFailed && !eventsLoading && (
                  <View style={[st.rowBetween, { gap: 10 }]}>
                    <Text style={{ color: colors.textDim, fontSize: 12.5, paddingVertical: 4, flex: 1 }} accessibilityLiveRegion="polite">
                      Couldn’t read this session’s events.
                    </Text>
                    <TouchableOpacity onPress={() => loadEvents(s.id)} accessibilityRole="button"
                      accessibilityLabel="Retry loading this session's events" hitSlop={12}>
                      <Text style={{ color: colors.primary, fontWeight: '700', fontSize: 12.5 }}>Retry</Text>
                    </TouchableOpacity>
                  </View>
                )}
                {events.map((e) => {
                  const meta = eventMeta(e.type, colors);
                  const dist = e.distance != null ? fmtDistance(e.distance, settings.units) : null;
                  const time = new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                  return (
                    // One element per event: icon, label, distance and time
                    // were read as separate fragments.
                    <View key={e.id} style={st.eventRow} accessible
                      accessibilityLabel={`${meta.label}${dist ? `, ${dist}` : ''}, at ${time}`}>
                      <Ionicons name={meta.icon} size={14} color={meta.color} />
                      <Text style={{ color: colors.text, fontSize: 12.5, flex: 1 }}>{meta.label}</Text>
                      {dist != null && <Text style={{ color: colors.textDim, fontSize: 12 }}>{dist}</Text>}
                      <Text style={{ color: colors.textDim, fontSize: 12 }}>{time}</Text>
                    </View>
                  );
                })}
                {/* optional note (v2.1) */}
                <View style={{ flexDirection: 'row', gap: 6, marginTop: 8, alignItems: 'center' }}>
                  <TextInput
                    value={noteDraft} onChangeText={(t) => { setNoteDraft(t); setNoteSaved(false); }}
                    placeholder="Add a note (e.g. “parked at north gate”)…"
                    placeholderTextColor={colors.textFaint}
                    accessibilityLabel="Note for this session"
                    style={{ flex: 1, minHeight: 44, borderWidth: 1, borderColor: colors.glassStroke, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5, color: colors.text, fontSize: 12, backgroundColor: colors.glass }}
                  />
                  <TouchableOpacity
                    accessibilityRole="button" accessibilityLabel="Save note"
                    accessibilityState={{ busy: savingNote, disabled: savingNote }} disabled={savingNote}
                    hitSlop={12}
                    onPress={() => saveNote(s.id)}>
                    {savingNote
                      ? <ActivityIndicator size="small" color={colors.primary} />
                      : <Text style={{ color: colors.primary, fontWeight: '700', fontSize: 12 }}>Save</Text>}
                  </TouchableOpacity>
                </View>
                {noteSaved && (
                  <Text accessibilityLiveRegion="polite" style={{ color: colors.success, fontSize: 12, marginTop: 4 }}>Note saved</Text>
                )}
                <View style={[st.rowBetween, { marginTop: 6 }]}>
                  <Text style={{ color: colors.textFaint, fontSize: 11 }}>
                    {s.center_lat.toFixed(5)}, {s.center_lng.toFixed(5)}
                  </Text>
                  {/* A visible delete — long-press alone could not be found. */}
                  <TouchableOpacity onPress={() => removeOne(s.id)} accessibilityRole="button"
                    accessibilityLabel="Delete this session" hitSlop={12} style={st.linkBtn}>
                    <Ionicons name="trash-outline" size={14} color={colors.danger} />
                    <Text style={{ color: colors.danger, fontWeight: '600', fontSize: 12 }}>Delete</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>
        )}
      />
    </KeyboardSafe>
  );
}

function StatCell({ label, value, colors }: { label: string; value: string; colors: Palette }) {
  return (
    <View style={st.statCell} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={{ color: colors.text, fontSize: 16, fontWeight: '800' }}>{value}</Text>
      <Text style={{ color: colors.textDim, fontSize: 11, marginTop: 2 }}>{label}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  body: { padding: 16, paddingBottom: 48 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, minHeight: 44, justifyContent: 'center' },
  statsCard: { flexDirection: 'row', flexWrap: 'wrap', borderWidth: 1, borderRadius: 14, marginTop: 12, paddingVertical: 6 },
  statCell: { width: '33.33%', alignItems: 'center', paddingVertical: 10 },
  trendCard: { borderWidth: 1, borderRadius: 14, marginTop: 10, padding: 12 },
  trendRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  trendCol: { alignItems: 'center', flex: 1 },
  trendBar: { width: 18, borderRadius: 5 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  errBanner: { gap: 10, borderWidth: 1, borderRadius: 12, padding: 10, marginBottom: 8 },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  /** linkRow as a tap target: 44 tall. */
  linkBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 44 },
  session: { borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 10 },
  timeline: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 10, paddingTop: 8 },
  eventRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
});
