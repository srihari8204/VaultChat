// app/space-transport.tsx — the transport landing for someone who is NOT running
// the operation: a parent watching a school bus, an employee waiting for a cab.
//
// ── WHY THIS SCREEN EXISTS SEPARATELY FROM space-overview ──
//
// space-overview asks the server for the operations summary, which needs
// view_space_ops. A parent holds NO permissions — deliberately: their access to
// their own child comes from space_links, not from a permission. Sending them to
// the overview answered 403, so the one person the school bus feature exists for
// landed on an error.
//
// This screen asks only for the runs the caller may see. The server already
// scopes that exactly right: ops sees the timetable, a driver sees their own
// runs, a guardian sees the runs their linked children are on, and nobody sees
// anything else. Verified against production — a parent's /runs returns their
// child's bus and nothing more.
//
// ── WHAT IS DELIBERATELY ABSENT ──
//
// No position is fetched or drawn here. Vehicle positions travel sealed on the
// live-location channel and this screen holds no key for them; "where is the
// bus" is the map's job, on the same encrypted stream everyone else reads. This
// screen answers WHO, WHAT and WHAT HAPPENED — the parts the server can honestly
// know without ever seeing a coordinate.
//
// It requires no location permission of its own. That is the point: tracking a
// child's bus must never require the parent to share their own position.

import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl, Alert,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSpaceColors, spaceHeader } from '../lib/spaces/theme';
import type { Palette } from '../constants/theme';
import { getRuns, getRun } from '../lib/spaces/api';
import { createDirectChat } from '../lib/chatService';
import type { Run, RunStop, RunRider } from '../lib/spaces/runs';
import { nextStop } from '../lib/spaces/runs';
import { familyOf } from '../lib/spaces/layout';

interface Loaded {
  run: Run;
  stops: RunStop[];
  /** Only the riders this caller is entitled to — the server decides, not us. */
  riders: RunRider[];
}

/** Plain words for a rider's state. A parent should not have to learn our enum. */
function riderWords(state: string, kind: string): { text: string; tone: 'ok' | 'warn' | 'wait' } {
  switch (state) {
    case 'boarded': return { text: kind.includes('drop') ? 'On the bus' : 'Picked up — on the bus', tone: 'ok' };
    case 'dropped': return { text: 'Dropped off safely', tone: 'ok' };
    case 'absent': return { text: 'Marked absent', tone: 'warn' };
    case 'no_show': return { text: 'Not at the stop', tone: 'warn' };
    default: return { text: 'Waiting to be picked up', tone: 'wait' };
  }
}

function runWords(run: Run): { text: string; tone: 'ok' | 'warn' | 'wait' } {
  if (run.status === 'completed') return { text: 'Finished', tone: 'ok' };
  if (run.status === 'cancelled') return { text: 'Cancelled', tone: 'warn' };
  if (run.status === 'started') {
    // `stale` is the ONE thing the server can raise by itself: an active run
    // whose device has stopped reporting. Saying "on the way" then would be a
    // reassurance we cannot back up.
    return run.stale
      ? { text: 'Not reporting right now', tone: 'warn' }
      : { text: 'On the way', tone: 'ok' };
  }
  return { text: 'Not started yet', tone: 'wait' };
}

function clockOf(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function SpaceTransportScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    spaceId?: string; name?: string; groupType?: string; perms?: string;
  }>();
  const colors = useSpaceColors(params.groupType);
  const spaceId = String(params.spaceId || '');
  const spaceName = String(params.name || 'This space');

  // ── Calling the driver ────────────────────────────────────────────
  //
  // This button used to push `/call` with `{ userId, video }`. There is no
  // `/call` route and never has been, and `/voicecall` takes
  // `{ chatId, peerUid, peerName }` — so the button navigated nowhere and the
  // params would have been wrong even if it had. The `as any` on the pathname
  // is what let both mistakes through the compiler.
  //
  // A call needs a chat, so resolve (or create) the direct chat with the driver
  // first. createDirectChat returns the existing one when there is one, so this
  // does not litter the chat list.
  const [callingDriver, setCallingDriver] = useState<string | null>(null);
  const callDriver = useCallback(async (driverId: string) => {
    if (callingDriver) return;
    setCallingDriver(driverId);
    try {
      const chat = await createDirectChat({ userId: driverId });
      router.push({
        pathname: '/voicecall' as any,
        params: { chatId: chat.id, peerUid: driverId, peerName: 'Driver' },
      });
    } catch (e: any) {
      Alert.alert('Could not call the driver', e?.message ?? 'Check your connection and try again.');
    } finally {
      setCallingDriver(null);
    }
  }, [callingDriver, router]);
  const kindWord = familyOf(params.groupType) === 'school' ? 'bus' : 'vehicle';

  const [loaded, setLoaded] = useState<Loaded[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const canOps = useMemo(
    () => String(params.perms || '').split(',').includes('view_space_ops'),
    [params.perms],
  );

  const load = useCallback(async () => {
    if (!spaceId) { setErr('No space was given.'); setLoaded([]); return; }
    try {
      setErr(null);
      const runs = await getRuns(spaceId);
      // The manifest carries the rider states, and the server has already cut it
      // down to the children this caller is linked to. A failure on one run must
      // not blank the whole screen.
      const out = await Promise.all(runs.map(async (run) => {
        try {
          const d = await getRun(spaceId, run.id);
          return { run: d.run, stops: d.stops, riders: d.riders };
        } catch {
          return { run, stops: [], riders: [] };
        }
      }));
      setLoaded(out);
    } catch (e: any) {
      setErr(e?.message || 'Could not load transport.');
      setLoaded([]);
    }
  }, [spaceId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await load(); } finally { setRefreshing(false); }
  }, [load]);

  const s = styles(colors);
  const toneColor = (t: 'ok' | 'warn' | 'wait') =>
    t === 'ok' ? colors.success : t === 'warn' ? colors.danger : colors.textDim;

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={s.body}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
    >
      <Stack.Screen options={spaceHeader(colors, `${spaceName} · Transport`, { id: spaceId, name: params.name })} />

      {loaded === null && (
        <View style={s.centre}>
          <ActivityIndicator color={colors.primary} />
          <Text style={s.muted}>Loading today’s {kindWord}…</Text>
        </View>
      )}

      {err && (
        <View style={[s.card, { borderColor: colors.danger, borderWidth: 1 }]}>
          <Text style={s.cardTitle}>Could not load transport</Text>
          <Text style={s.muted}>{err}</Text>
          <TouchableOpacity onPress={load} style={[s.btn, { backgroundColor: colors.primary }]}>
            <Text style={s.btnText}>Try again</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* EMPTY IS NOT AN ERROR, and the two must not look alike. A parent whose
          child has not been linked yet sees exactly this, and it has to say what
          to do about it rather than leaving them staring at a blank screen
          wondering whether the app is broken. */}
      {loaded !== null && loaded.length === 0 && !err && (
        <View style={s.card}>
          <Ionicons name="bus-outline" size={26} color={colors.textDim} />
          <Text style={s.cardTitle}>No {kindWord} assigned to you yet</Text>
          <Text style={s.muted}>
            You will see a {kindWord} here once {spaceName} has added the person you are
            responsible for and put them on a route. Nothing is wrong with your account —
            there is simply nothing assigned yet.
          </Text>
          {canOps && (
            <TouchableOpacity
              onPress={() => router.push({ pathname: '/space-admin' as any, params: { spaceId, name: spaceName, groupType: params.groupType ?? '', perms: params.perms ?? '' } })}
              style={[s.btn, { backgroundColor: colors.primary }]}
            >
              <Text style={s.btnText}>Set up transport</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {(loaded ?? []).map(({ run, stops, riders }) => {
        const rs = runWords(run);
        const next = nextStop(stops, riders);
        return (
          <View key={run.id} style={s.card}>
            <View style={s.rowTop}>
              <View style={[s.icon, { backgroundColor: colors.primary + '18' }]}>
                <Ionicons name="bus" size={20} color={colors.primary} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.cardTitle} numberOfLines={1}>
                  {run.vehicleLabel || run.name}
                </Text>
                <Text style={s.muted} numberOfLines={1}>{run.name}</Text>
              </View>
              {/* Status carries an ICON as well as a colour — colour alone is not
                  a status anyone can rely on. */}
              <View style={s.status}>
                <Ionicons
                  name={rs.tone === 'ok' ? 'checkmark-circle' : rs.tone === 'warn' ? 'alert-circle' : 'time-outline'}
                  size={15}
                  color={toneColor(rs.tone)}
                />
                <Text style={[s.statusText, { color: toneColor(rs.tone) }]}>{rs.text}</Text>
              </View>
            </View>

            {/* WHO — the children this caller is responsible for, and nobody
                else. The server returned exactly these. */}
            {riders.map((r) => {
              const w = riderWords(r.state, run.kind);
              return (
                <View key={r.riderId} style={s.rider}>
                  <View style={[s.avatar, { backgroundColor: colors.primary + '22' }]}>
                    <Text style={{ color: colors.primary, fontWeight: '800' }}>
                      {(r.displayName || '?').trim()[0]?.toUpperCase()}
                    </Text>
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={s.riderName} numberOfLines={1}>{r.displayName}</Text>
                    <Text style={[s.muted, { color: toneColor(w.tone) }]} numberOfLines={1}>
                      {w.text}{r.stateAt ? ` · ${clockOf(r.stateAt)}` : ''}
                    </Text>
                  </View>
                </View>
              );
            })}

            {riders.length === 0 && (
              <Text style={s.muted}>
                Nobody you are responsible for is on this {kindWord} today.
              </Text>
            )}

            {next && (
              <View style={s.next}>
                <Ionicons name="location-outline" size={15} color={colors.textDim} />
                <Text style={s.muted} numberOfLines={1}>
                  Next stop: {next.label}{next.plannedAt ? ` · ${clockOf(next.plannedAt)}` : ''}
                </Text>
              </View>
            )}

            <View style={s.actions}>
              {/* The live map reads the same sealed stream everyone else does. */}
              <TouchableOpacity
                onPress={() => router.push({ pathname: '/space-run' as any, params: { spaceId, runId: run.id, name: spaceName, groupType: params.groupType ?? '' } })}
                style={[s.btn, { backgroundColor: colors.primary, flex: 1 }]}
              >
                <Ionicons name="map-outline" size={16} color="#fff" />
                <Text style={s.btnText}>Live {kindWord}</Text>
              </TouchableOpacity>
              {/* Calling goes through VaultChat's existing call stack, and only
                  when the server actually named a driver. */}
              {run.driverId && (
                <TouchableOpacity
                  onPress={() => callDriver(run.driverId!)}
                  disabled={callingDriver === run.driverId}
                  style={[s.btn, { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1 },
                          callingDriver === run.driverId && { opacity: 0.6 }]}
                >
                  <Ionicons name="call-outline" size={16} color={colors.text} />
                  <Text style={[s.btnText, { color: colors.text }]}>Driver</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        );
      })}

      {loaded !== null && loaded.length > 0 && (
        <Text style={s.footnote}>
          You see only the people you are responsible for. Vehicle positions stay
          end-to-end encrypted — {spaceName} relays them but cannot read them, and neither
          can we.
        </Text>
      )}
    </ScrollView>
  );
}

const styles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  body: { padding: 16, gap: 12, paddingBottom: 40 },
  centre: { alignItems: 'center', gap: 10, paddingVertical: 40 },
  card: { backgroundColor: c.card, borderRadius: 14, padding: 14, gap: 10 },
  cardTitle: { color: c.text, fontSize: 15.5, fontWeight: '700' },
  muted: { color: c.textDim, fontSize: 12.5, lineHeight: 17, flexShrink: 1 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  icon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  status: { alignItems: 'flex-end', gap: 2, maxWidth: 130 },
  statusText: { fontSize: 11.5, fontWeight: '700', textAlign: 'right' },
  rider: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 4 },
  avatar: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  riderName: { color: c.text, fontSize: 14.5, fontWeight: '600' },
  next: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 2 },
  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderRadius: 10, paddingVertical: 11, paddingHorizontal: 14,
  },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 13.5 },
  footnote: { color: c.textFaint, fontSize: 11.5, lineHeight: 16, marginTop: 4 },
});
