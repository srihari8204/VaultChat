import { AuroraBackground } from '../components/ui/AuroraBackground';
// app/space-admin.tsx — the space admin console (Spaces & Operations).
//
// For the people who RUN a space: a Principal, a Super Admin, a Transport
// Manager. Everything an office needs to set up and watch its operation, in one
// place, instead of scattered behind a settings sheet.
//
// ── WHAT THIS CONSOLE IS NOT ──
//
// It is not a database console, and it cannot become one. Every screen it opens
// talks to the ordinary space API as the signed-in user, so an administrator
// here reaches exactly one space — their own — and only the parts of it their
// permissions allow. There is no admin key, no elevated session and no
// cross-space query anywhere behind this screen.
//
// That is enforced in three independent places, none of which live in this file:
//   · the route checks the caller's permission on every request
//   · the RLS policies scope every row to the caller's space
//   · the handler carries the same scope predicate in its WHERE clause
//
// The header says so out loud, because an administrator should be able to see
// the limit of their own authority rather than having to trust it.

import { AppText as Text } from '../components/ui/Text';
import React, { useCallback, useMemo, useState } from 'react';
import {
  View, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSpaceColors, spaceHeader } from '../lib/spaces/theme';
import type { SpacePalette as Palette } from '../lib/spaces/theme';
import {
  getRunsWithManifest, getRoster, getIncidents, getLinks,
  type Incident, type RosterEntry, type SpaceLink,
} from '../lib/spaces/api';
import LoadError from '../components/spaces/LoadError';
import ShiftSheet from '../components/spaces/ShiftSheet';
import SpaceLinksSheet from '../components/spaces/SpaceLinksSheet';
import { tilesForType, type RunSet } from '../lib/spaces/dashboard';
import type { Run } from '../lib/spaces/runs';

interface Entry {
  key: string;
  label: string;
  hint: string;
  icon: keyof typeof Ionicons.glyphMap;
  /** A screen to open, or a setup sheet drawn on top of this console. */
  route?: string;
  sheet?: 'shift' | 'links';
  /** Permission the caller needs. Presentation only — the server re-checks. */
  needs?: 'manage_runs' | 'manage_roster' | 'view_space_ops' | 'edit_settings';
}

const ENTRIES: Entry[] = [
  { key: 'overview', label: 'Overview', hint: 'The day in numbers, computed on the server', icon: 'stats-chart-outline', route: '/space-overview', needs: 'view_space_ops' },
  { key: 'runs', label: 'Runs', hint: 'Create routes, set stops, assign drivers', icon: 'bus-outline', route: '/space-runs-admin', needs: 'manage_runs' },
  { key: 'map', label: 'Live operations', hint: 'Every vehicle on one map', icon: 'map-outline', route: '/space-ops-map', needs: 'view_space_ops' },
  { key: 'pending', label: 'Pending pickups', hint: 'Who is still waiting, oldest first', icon: 'hourglass-outline', route: '/space-pending' },
  { key: 'people', label: 'People', hint: 'Who is in, on leave, or unaccounted', icon: 'id-card-outline', route: '/space-people', needs: 'view_space_ops' },
  { key: 'roster', label: 'Roster & links', hint: 'People, and who is responsible for whom', icon: 'people-outline', route: '/space-roster', needs: 'manage_roster' },
  { key: 'links', label: 'Links', hint: 'Who is guardian of, supervises or teaches whom', icon: 'git-network-outline', sheet: 'links', needs: 'manage_roster' },
  { key: 'shift', label: 'Shift and lateness', hint: 'When the day starts, and when a run counts as late', icon: 'time-outline', sheet: 'shift', needs: 'edit_settings' },
  { key: 'checkin', label: 'Check in', hint: 'Declared arrivals and departures', icon: 'log-in-outline', route: '/space-checkin' },
  // No gate on either: every member has their own leave and tasks, and the
  // screens draw the decide/assign affordances from the perms passed below.
  { key: 'leave', label: 'Leave', hint: 'Requests, approvals and allowance', icon: 'calendar-outline', route: '/space-leave' },
  { key: 'tasks', label: 'Tasks', hint: 'Assigned work and its progress', icon: 'checkbox-outline', route: '/space-tasks' },
  { key: 'attendance', label: 'Attendance from location', hint: 'Worked out on this device', icon: 'calendar-number-outline', route: '/space-attendance', needs: 'view_space_ops' },
  { key: 'incidents', label: 'Incidents', hint: 'Breakdowns, emergencies, road problems', icon: 'alert-circle-outline', route: '/space-incidents', needs: 'view_space_ops' },
  { key: 'passes', label: 'Visitor passes', hint: 'Issue and admit visitors', icon: 'qr-code-outline', route: '/space-visitors', needs: 'manage_roster' },
  // No permission gate: your own devices are yours, and the server returns only
  // those unless you run the space.
  { key: 'devices', label: 'Devices', hint: 'Phones, vehicles and theft protection', icon: 'hardware-chip-outline', route: '/space-devices' },
];

export default function SpaceAdminScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    spaceId?: string; name?: string; groupType?: string; perms?: string; roleLabel?: string;
  }>();
  const colors = useSpaceColors(params.groupType);
  const spaceId = String(params.spaceId || '');
  const spaceName = String(params.name || 'This space');

  // The caller's resolved permissions, passed from the dashboard that already
  // fetched them. Presentation only: it decides what to DRAW, never what is
  // allowed — every endpoint behind these tiles re-resolves server-side.
  const perms = useMemo(
    () => new Set(String(params.perms || '').split(',').filter(Boolean)),
    [params.perms],
  );

  const [runs, setRuns] = useState<Run[]>([]);
  const [manifests, setManifests] = useState<Record<string, RunSet['riders']>>({});
  const [rosterCount, setRosterCount] = useState<number | null>(null);
  const [openIncidents, setOpenIncidents] = useState<Incident[]>([]);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [links, setLinks] = useState<SpaceLink[]>([]);
  const [linksError, setLinksError] = useState<string | null>(null);
  // True until the first links read settles, so the sheet does not open on a
  // false "No links yet".
  const [linksLoading, setLinksLoading] = useState(false);
  const [sheet, setSheet] = useState<'shift' | 'links' | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // Each part still fails on its own, but a failure is SAID rather than
      // drawn as "Nothing running yet" or a missing SOS banner.
      const failed: string[] = [];
      // Runs come with their riders in one call where the server supports it,
      // else one read per run (getRunsWithManifest).
      const [rs, ros, incidents] = await Promise.all([
        getRunsWithManifest(spaceId, { activeOnly: true }).catch(() => { failed.push('runs'); return []; }),
        getRoster(spaceId).catch(() => { failed.push('roster'); return null; }),
        getIncidents(spaceId).catch(() => { failed.push('incidents'); return [] as Incident[]; }),
      ]);
      // A run whose riders could not be read would undercount the tiles: say so.
      const noManifest = rs.filter((x) => x.failed).length;
      if (noManifest) failed.push(`riders for ${noManifest} ${noManifest === 1 ? 'run' : 'runs'} (the figures below may be low)`);
      setLoadError(failed.length ? `Could not load ${failed.join(', ')}.` : null);
      setRuns(rs.map((x) => x.run));
      setRosterCount(ros ? ros.roster.length : null);
      setRoster(ros?.roster ?? []);
      setOpenIncidents(incidents.filter((i) => i.status !== 'resolved'));
      setManifests(Object.fromEntries(rs.map((x) => [x.run.id, x.riders])));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [spaceId]);

  const loadLinks = useCallback(async () => {
    // The error is shown INSIDE the links sheet: the console's own error card
    // sits behind that full-screen modal, and an empty list there reads as
    // "No links yet".
    try { setLinks(await getLinks(spaceId)); setLinksError(null); }
    catch (e: any) { setLinksError(e?.message ?? 'Check your connection and try again.'); }
    finally { setLinksLoading(false); }
  }, [spaceId]);
  const openSheet = useCallback((which: 'shift' | 'links') => {
    if (which === 'links') { setLinksLoading(true); void loadLinks(); }
    setSheet(which);
  }, [loadLinks]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const tiles = useMemo(
    () => tilesForType(
      params.groupType ? String(params.groupType) : null,
      runs.map((r) => ({ run: r, riders: manifests[r.id] ?? [] })),
    ),
    [params.groupType, runs, manifests],
  );

  const s = useMemo(() => styles(colors), [colors]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <AuroraBackground variant="profile" />
    <ScrollView
      style={s.screen} contentContainerStyle={s.body}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={colors.primary} />}
    >
      <Stack.Screen options={spaceHeader(colors, `${spaceName} · Admin`, { id: spaceId, name: params.name })} />

      {/* The scope statement. An administrator should be able to SEE the limit
          of their own authority rather than having to take it on trust — and a
          school buying this asks exactly this question first. */}
      <View style={s.scope}>
        <Ionicons name="shield-checkmark-outline" size={18} color={colors.primary} />
        <View style={{ flex: 1 }}>
          <Text style={s.scopeTitle}>
            You are administering {spaceName}
            {params.roleLabel ? ` as ${params.roleLabel}` : ''}
          </Text>
          <Text style={s.scopeText}>
            This console reaches this space only. It signs in as you, not as an operator,
            so it cannot see other spaces, other organisations, or anything on the server
            outside what your role here allows.
          </Text>
        </View>
      </View>

      {/* An open emergency outranks the whole console. */}
      {openIncidents.some((i) => i.category === 'sos') && (
        <TouchableOpacity
          style={s.sos}
          onPress={() => router.push({ pathname: '/space-incidents', params: { spaceId, name: spaceName, groupType: params.groupType ?? '', perms: params.perms ?? '' } })}
          accessibilityRole="button"
          accessibilityLabel="An emergency alert is open. Open incidents"
        >
          <Ionicons name="warning" size={20} color={colors.onDanger} />
          <Text style={s.sosText}>
            An emergency alert is open. Tap to see it.
          </Text>
        </TouchableOpacity>
      )}

      {loadError && !loading && (
        <LoadError colors={colors} message={loadError} onRetry={() => { setLoading(true); void load(); }} />
      )}

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginVertical: 24 }} />
      ) : (
        <>
          {tiles.length > 0 && (
            <View style={s.tiles}>
              {tiles.map((t) => (
                <View
                  key={t.key} style={[s.tile, t.alert && s.tileAlert]}
                  accessible accessibilityLabel={`${t.label}, ${t.value}${t.alert ? ', needs attention' : ''}`}
                >
                  <Text style={[s.tileValue, t.alert && { color: colors.danger }]}>{t.value}</Text>
                  <Text style={s.tileLabel} numberOfLines={2}>{t.label}</Text>
                </View>
              ))}
            </View>
          )}

          {tiles.length === 0 && !loadError && (
            <View style={s.card}>
              <Text style={s.cardTitle}>Nothing running yet</Text>
              <Text style={s.muted}>
                Create a run and add people to the roster, and this becomes the operations
                board for {spaceName}.
              </Text>
            </View>
          )}
        </>
      )}

      {ENTRIES.map((e) => {
        // A tile the caller cannot use is not drawn. Drawing it and failing on
        // tap teaches people to distrust the console.
        if (e.needs && !perms.has(e.needs)) return null;
        const badge =
          e.key === 'roster' ? rosterCount :
            e.key === 'incidents' ? (openIncidents.length || null) :
              e.key === 'runs' ? (runs.length || null) : null;
        return (
          <TouchableOpacity
            key={e.key}
            style={s.row}
            accessibilityRole="button"
            accessibilityLabel={`${e.label}${badge != null ? `, ${badge}` : ''}. ${e.hint}`}
            onPress={() => e.sheet ? openSheet(e.sheet) : router.push({
              pathname: e.route as string,
              params: {
                spaceId, name: spaceName,
                groupType: params.groupType ?? '',
                // perms travel with every hop — the same contract space-overview
                // and space-transport already keep. Without them Check-in,
                // Tasks, Leave and Overview open in member mode when reached
                // through this console, and in full mode from the space tiles.
                perms: params.perms ?? '',
                canManage: perms.has('manage_roster') ? '1' : '0',
              },
            })}
          >
            <View style={[s.rowIcon, { backgroundColor: colors.primary + '18' }]}>
              <Ionicons name={e.icon} size={19} color={colors.primary} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.rowLabel}>{e.label}</Text>
              <Text style={s.muted} numberOfLines={1}>{e.hint}</Text>
            </View>
            {badge != null && (
              <View style={[s.badge, e.key === 'incidents' && { backgroundColor: colors.danger + '22' }]}>
                <Text style={[s.badgeText, e.key === 'incidents' && { color: colors.danger }]}>{badge}</Text>
              </View>
            )}
            <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
          </TouchableOpacity>
        );
      })}

      <Text style={s.footnote}>
        Every action here is checked again on the server against your role in this space,
        and recorded in the space’s audit log. Vehicle and member positions stay
        end-to-end encrypted — this console reads the same sealed stream everyone else
        does, and the server holds no copy of them.
      </Text>
    </ScrollView>
      <ShiftSheet visible={sheet === 'shift'} onClose={() => setSheet(null)} colors={colors} spaceId={spaceId} />
      <SpaceLinksSheet
        visible={sheet === 'links'} onClose={() => setSheet(null)} colors={colors}
        spaceId={spaceId} roster={roster} links={links} linksError={linksError} linksLoading={linksLoading}
        onChanged={loadLinks}
      />
    </View>
  );
}

const styles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  body: { padding: 16, gap: 10, paddingBottom: 40 },
  scope: {
    flexDirection: 'row', gap: 10, alignItems: 'flex-start',
    backgroundColor: c.primary + '12', borderRadius: 14, padding: 14,
  },
  scopeTitle: { color: c.text, fontWeight: '700', fontSize: 14.5, marginBottom: 4 },
  scopeText: { color: c.textDim, fontSize: 12.5, lineHeight: 17 },
  sos: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: c.danger, borderRadius: 12, padding: 14,
  },
  // On-danger ink on the solid danger fill.
  sosText: { color: c.onDanger, fontWeight: '700', flex: 1 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: {
    backgroundColor: c.glassSoft, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12,
    minWidth: 96, flexGrow: 1, borderWidth: 1, borderColor: 'transparent',
  },
  tileAlert: { borderColor: c.danger },
  tileValue: { color: c.text, fontSize: 21, fontWeight: '700' },
  tileLabel: { color: c.textDim, fontSize: 11.5 },
  card: { backgroundColor: c.glassSoft, borderRadius: 14, padding: 14, gap: 6 },
  cardTitle: { color: c.text, fontSize: 15.5, fontWeight: '700' },
  muted: { color: c.textDim, fontSize: 12.5, flexShrink: 1 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: c.glassSoft, borderRadius: 12, padding: 14,
  },
  rowIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  rowLabel: { color: c.text, fontSize: 15.5, fontWeight: '600', flexShrink: 1 },
  badge: { backgroundColor: c.border, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { color: c.text, fontSize: 12, fontWeight: '700' },
  footnote: { color: c.textFaint, fontSize: 11.5, lineHeight: 16, marginTop: 6 },
});
