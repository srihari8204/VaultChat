// app/space-roster.tsx — the people you are responsible for
// (Spaces & Operations, S3.3).
//
// One screen serves every viewer, because the SERVER decides what is in it: a
// parent gets their own child, a supervisor gets their reporting line, ops gets
// the space. There is no role switch here and no client-side filter — a filter
// here would mean the rest of the roster had already been sent to this device,
// which is the exact thing the visibility rule exists to prevent.
//
// TRUNCATION IS SHOWN, NOT SWALLOWED. The resolver walks a bounded depth and
// tells us when it stopped early. A supervisor silently missing half their line
// is worse than one told the hierarchy is deeper than the walk, so that flag is
// rendered rather than logged.

import { AppText as Text } from '../components/ui/Text';
import React, { useCallback, useMemo, useState } from 'react';
import {
  View, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity, Alert,
  TextInput, Modal, RefreshControl,
} from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSpaceColors, spaceHeader } from '../lib/spaces/theme';
import type { SpacePalette as Palette } from '../lib/spaces/theme';
import {
  getRoster, addRosterEntry, updateRosterEntry, getLinks,
  type RosterEntry, type SpaceLink,
} from '../lib/spaces/api';
import { AuroraBackground } from '../components/ui';
import { KeyboardSafe } from '../components/ui/KeyboardSafe';
import LoadError from '../components/spaces/LoadError';
import SpaceLinksSheet from '../components/spaces/SpaceLinksSheet';
import ChatDoorButton from '../components/spaces/ChatDoorButton';
import { familyOf } from '../lib/spaces/layout';

/** Roster kinds the server counts apart ('child' feeds the school's student
 *  total in space_ops_summary). Anything else is stored as given. */
const KINDS: { key: string; label: string }[] = [
  { key: 'child', label: 'Child' },
  { key: 'person', label: 'Adult' },
];

export default function SpaceRosterScreen() {
  const params = useLocalSearchParams<{ spaceId?: string; name?: string; canManage?: string; groupType?: string; perms?: string }>();
  const colors = useSpaceColors(params.groupType);
  const spaceId = String(params.spaceId || '');
  // Presentation only. Every write below is re-checked server-side against
  // manage_roster; this just decides whether to draw the button.
  // Section tiles and the overview pass `perms` rather than `canManage`, so
  // read either: opening the roster from a tile used to drop the controls.
  const canManage = String(params.canManage || '') === '1'
    || String(params.perms || '').split(',').includes('manage_roster');

  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [links, setLinks] = useState<SpaceLink[]>([]);
  const [linksError, setLinksError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [scoped, setScoped] = useState(true);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [linksOpen, setLinksOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newRef, setNewRef] = useState('');
  const defaultKind = familyOf(params.groupType) === 'school' ? 'child' : 'person';
  const [newKind, setNewKind] = useState(defaultKind);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      let linkErr: string | null = null;
      const [r, l] = await Promise.all([
        getRoster(spaceId),
        // Links are only visible from the subject end, so this comes back small
        // for a parent and complete for ops — same call either way. A failure
        // is kept for the links sheet rather than shown there as "No links yet".
        getLinks(spaceId).catch((e: any) => {
          linkErr = e?.message ?? 'Check your connection and try again.';
          return [] as SpaceLink[];
        }),
      ]);
      setRoster(r.roster || []);
      setTruncated(!!r.truncated);
      setScoped(!!r.scoped);
      setLinks(l || []);
      setLinksError(linkErr);
      setLoadError(null);
    } catch (e: any) {
      setLoadError(e?.message ?? 'Could not load the roster.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [spaceId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  /** Who this viewer is linked to, for the "in your line" label. */
  const linkedIds = useMemo(() => new Set(links.map((l) => l.objectId)), [links]);

  const onAdd = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const ref = newRef.trim();
      await addRosterEntry(spaceId, { displayName: name, kind: newKind, ...(ref ? { externalRef: ref } : {}) });
      setNewName(''); setNewRef(''); setNewKind(defaultKind);
      setAdding(false);
      await load();
    } catch (e: any) {
      Alert.alert('Could not add', e?.message ?? 'Try again.');
    } finally {
      setBusy(false);
    }
  }, [newName, newRef, newKind, defaultKind, spaceId, load]);

  const onArchive = useCallback((entry: RosterEntry) => {
    Alert.alert(
      `Remove ${entry.displayName}?`,
      'They stop appearing everywhere in this space. Their past run records stay, so history remains readable.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await updateRosterEntry(spaceId, entry.id, { archived: true });
              await load();
            } catch (e: any) {
              Alert.alert('Could not remove', e?.message ?? 'Try again.');
            }
          },
        },
      ],
    );
  }, [spaceId, load]);

  const s = styles(colors);

  if (loading) {
    return (
      <View style={[s.screen, s.centre]}>
      <AuroraBackground />
        <Stack.Screen options={spaceHeader(colors, 'Roster')} />
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <AuroraBackground />
      <Stack.Screen
        options={{
          ...spaceHeader(colors, params.name ? `${params.name} · Roster` : 'Roster', { id: spaceId, name: params.name }),
          // The add button sits NEXT TO the chat door, not in place of it.
          ...(canManage ? {
            headerRight: () => (
              <View style={s.headerActions}>
                <TouchableOpacity accessibilityRole="button" accessibilityLabel="Add someone to the roster" onPress={() => setAdding(true)} style={s.hit}>
                  <Ionicons name="person-add" size={20} color={colors.primary} />
                </TouchableOpacity>
                {!!spaceId && (
                  <ChatDoorButton
                    colors={colors} chat={{ id: spaceId, name: params.name }}
                    fallbackTitle="Roster" accessibilityLabel="Open the space chat"
                  />
                )}
              </View>
            ),
          } : null),
        }}
      />

      <ScrollView
        contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={colors.primary} />}
      >
        {loadError && (
          <LoadError colors={colors} title="Could not load the roster" message={loadError} onRetry={() => { setLoading(true); void load(); }} />
        )}
        {canManage && !loadError && (
          <TouchableOpacity
            style={[s.card, s.row]} onPress={() => setLinksOpen(true)}
            accessibilityRole="button" accessibilityLabel="Manage links: who is guardian of, supervises or teaches whom"
          >
            <Ionicons name="git-network-outline" size={18} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={s.name}>Links</Text>
              <Text style={s.muted}>Who is guardian of, supervises or teaches whom. This decides what each person can see.</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
          </TouchableOpacity>
        )}
        {truncated && (
          <View style={s.warn}>
            <Ionicons name="git-branch-outline" size={16} color={colors.warning} />
            <Text style={s.warnText}>
              This space’s structure is deeper than the view can follow, so some people
              below you are not shown. Ask an administrator for the full list.
            </Text>
          </View>
        )}

        {!loadError && roster.length === 0 && (
          <View style={s.card}>
            <Text style={s.muted}>
              {scoped
                ? 'Nobody is linked to you in this space yet. An administrator adds those links.'
                : 'Nobody is on the roster yet.'}
            </Text>
          </View>
        )}

        {roster.map((r) => (
          <View key={r.id} style={s.card}>
            <View style={s.row}>
              <View style={[s.avatar, { backgroundColor: colors.primary + '22' }]}>
                <Ionicons
                  name={r.userId ? 'person' : 'happy-outline'}
                  size={18}
                  color={colors.primary}
                />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.name} numberOfLines={1}>{r.displayName}</Text>
                <Text style={s.muted}>
                  {/* An entry with no account is the normal case for a child —
                      saying so stops it reading as a broken invite. */}
                  {r.userId ? 'Has an account' : 'No account'}
                  {linkedIds.has(r.id) ? ' · in your care' : ''}
                  {r.externalRef ? ` · ${r.externalRef}` : ''}
                </Text>
              </View>
              {canManage && (
                <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Remove ${r.displayName} from the roster`} onPress={() => onArchive(r)} style={s.hit}>
                  <Ionicons name="close-circle-outline" size={20} color={colors.textDim} />
                </TouchableOpacity>
              )}
            </View>
          </View>
        ))}

        <Text style={s.footnote}>
          {scoped
            ? 'You see the people you are responsible for. The rest of the space’s roster is not sent to this device.'
            : 'You have the space-wide view, so this is everyone.'}
        </Text>
      </ScrollView>

      <Modal visible={adding} transparent animationType="fade" onRequestClose={() => setAdding(false)}>
        <KeyboardSafe keyboardOnly>
        <View style={s.modalWrap}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>Add to the roster</Text>
            <Text style={s.muted}>
              A roster entry does not need an account — a young child usually has none.
            </Text>
            <TextInput
              style={s.input}
              value={newName}
              onChangeText={setNewName}
              placeholder="Full name"
              placeholderTextColor={colors.textDim}
              accessibilityLabel="Full name"
              autoFocus
              maxLength={120}
            />
            <View style={s.kinds} accessibilityRole="radiogroup" accessibilityLabel="Kind of entry">
              {KINDS.map((k) => (
                <TouchableOpacity
                  key={k.key} onPress={() => setNewKind(k.key)}
                  style={[s.kind, newKind === k.key && s.kindOn]}
                  accessibilityRole="radio" accessibilityState={{ checked: newKind === k.key }}
                >
                  <Text style={[s.kindText, newKind === k.key && { color: colors.primary }]}>{k.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TextInput
              style={s.input}
              value={newRef}
              onChangeText={setNewRef}
              placeholder="Reference (optional), e.g. admission or staff number"
              placeholderTextColor={colors.textDim}
              accessibilityLabel="Reference, optional"
              autoCapitalize="characters"
              maxLength={64}
            />
            <View style={s.modalRow}>
              <TouchableOpacity style={s.modalBtn} onPress={() => setAdding(false)} accessibilityRole="button">
                <Text style={s.muted}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.modalBtn, s.primaryBtn, (!newName.trim() || busy) && s.btnOff]}
                onPress={onAdd}
                disabled={!newName.trim() || busy}
                accessibilityRole="button" accessibilityLabel="Add to the roster"
                accessibilityState={{ disabled: !newName.trim() || busy, busy }}
              >
                {busy
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Text style={s.primaryText}>Add</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
        </KeyboardSafe>
      </Modal>
      <SpaceLinksSheet
        visible={linksOpen} onClose={() => setLinksOpen(false)} colors={colors}
        spaceId={spaceId} roster={roster} links={links} linksError={linksError} onChanged={load}
      />
    </View>
  );
}

const styles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  centre: { alignItems: 'center', justifyContent: 'center' },
  body: { padding: 16, gap: 10, paddingBottom: 40 },
  card: { backgroundColor: c.glassSoft, borderRadius: 14, padding: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  name: { color: c.text, fontSize: 15.5, fontWeight: '600' },
  muted: { color: c.textDim, fontSize: 13, flexShrink: 1 },
  warn: {
    flexDirection: 'row', gap: 8, alignItems: 'flex-start',
    backgroundColor: c.warning + '18', borderRadius: 12, padding: 12,
  },
  warnText: { color: c.text, flex: 1, fontSize: 13, lineHeight: 18 },
  footnote: { color: c.textFaint, fontSize: 11.5, lineHeight: 16, marginTop: 6 },
  // A fixed dark scrim behind the dialog, the same in both schemes.
  modalWrap: { flex: 1, backgroundColor: '#0008', alignItems: 'center', justifyContent: 'center', padding: 24 },
  modal: { width: '100%', backgroundColor: c.bg, borderRadius: 16, padding: 20, gap: 10 },
  modalTitle: { color: c.text, fontSize: 18, fontWeight: '700' },
  input: {
    borderWidth: 1, borderColor: c.glassStroke, borderRadius: 10, padding: 12,
    color: c.text, fontSize: 16,
  },
  modalRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
  modalBtn: { paddingHorizontal: 18, minHeight: 44, minWidth: 64, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  hit: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  kinds: { flexDirection: 'row', gap: 8 },
  kind: {
    minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 22,
    borderWidth: 1, borderColor: c.glassStroke,
  },
  kindOn: { borderColor: c.primary, backgroundColor: c.primary + '18' },
  kindText: { color: c.text, fontSize: 14, fontWeight: '600' },
  primaryBtn: { backgroundColor: c.brandOnLight },
  primaryText: { color: '#fff', fontWeight: '700' },
  btnOff: { opacity: 0.4 },
});
