// app/space-people.tsx — the team list (Employee design screen 6).
//
// Who is here, who is on leave, who has not checked in. The status word is
// computed by the SERVER in one query rather than assembled here from three —
// so this screen and the overview tiles can never disagree about how many
// people are in.
//
// 'unknown' is rendered as "No check-in", never as "Absent". Nobody having told
// us is not the same as somebody being away, and an app that quietly converts
// one into the other produces an accusation out of a flat battery.

import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator,
  RefreshControl, TextInput, Alert, TouchableOpacity, Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { useSpaceColors, spaceHeader } from '../lib/spaces/theme';
import type { Palette } from '../constants/theme';
import { getPeople, setRoleKey, type Person } from '../lib/spaces/api';
import { getChat } from '../lib/chatService';
import { getCurrentUserAsync } from './(constants)/authService';
import {
  roleOptions, canChangeRole, roleErrorText, permissionLabel, rankLabel,
  type RoleOption,
} from '../lib/spaces/rolepicker';
import type { RoleDef } from '../lib/groups/permissions';
import PermissionMatrix from '../components/spaces/PermissionMatrix';

const LABEL: Record<Person['status'], string> = {
  in: 'In',
  left: 'Left',
  on_leave: 'On leave',
  unknown: 'No check-in',
};

export default function SpacePeopleScreen() {
  const params = useLocalSearchParams<{ spaceId?: string; name?: string; groupType?: string }>();
  const colors = useSpaceColors(params.groupType);
  const spaceId = String(params.spaceId || '');

  const [people, setPeople] = useState<Person[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // The role catalog is DATA from the server, fetched once per space. Not
  // passed as a route param: it is a list of objects, and a serialised catalog
  // in a URL is a copy that can go stale against the one the server enforces.
  const [catalog, setCatalog] = useState<RoleDef[] | null>(null);
  const [viewer, setViewer] = useState<{ id: string; role: string } | null>(null);
  // The member whose role is being changed, the role chosen, and whether the
  // confirmation step is showing. One at a time, deliberately: two concurrent
  // role mutations are never something a person meant to do.
  const [editing, setEditing] = useState<Person | null>(null);
  const [chosen, setChosen] = useState<RoleOption | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [roleErr, setRoleErr] = useState<string | null>(null);
  const [catalogErr, setCatalogErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPeople(await getPeople(spaceId));
    } catch (e: any) {
      Alert.alert('Could not load people', e?.message ?? 'Try again.');
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [spaceId]);

  // Catalog + who I am. Failure here is not fatal: the list still renders, the
  // role action simply is not offered.
  const loadMeta = useCallback(async () => {
    try {
      const [detail, me]: any[] = await Promise.all([
        getChat(spaceId),
        getCurrentUserAsync().catch(() => null),
      ]);
      setCatalog(detail?.roleCatalog ?? null);
      if (me?.id) setViewer({ id: String(me.id), role: String(detail?.role ?? 'member') });
    } catch (e: any) {
      // Stated, not swallowed. Without the catalog the matrix must say so
      // rather than render an invented permission list.
      setCatalogErr(e?.message || 'The space’s role list could not be loaded.');
    }
  }, [spaceId]);

  useFocusEffect(useCallback(() => { load(); loadMeta(); }, [load, loadMeta]));

  /** The catalog's label for a stored key. Never the raw key. */
  const labelFor = useCallback((p: Person) => {
    const def = catalog?.find((d) => d.key === p.roleKey);
    if (def) return def.label;
    // No catalog entry: fall back to the RANK's own label rather than printing
    // an internal key at a user.
    return rankLabel(p.role);
  }, [catalog]);

  const options = useMemo(
    () => (editing ? roleOptions(catalog, editing.role, editing.roleKey) : []),
    [catalog, editing],
  );

  const openPicker = (p: Person) => {
    if (!viewer || !canChangeRole(viewer.role, viewer.id, p.role, p.userId)) return;
    setEditing(p); setChosen(null); setConfirming(false); setRoleErr(null);
  };

  const commit = async () => {
    if (!editing || !chosen || saving) return;   // guards the double tap
    setSaving(true); setRoleErr(null);
    try {
      await setRoleKey(spaceId, editing.userId, chosen.key);
      // Re-read from the server rather than trusting the optimistic value. A
      // permission change is exactly the thing not to guess about.
      await load();
      setEditing(null); setChosen(null); setConfirming(false);
      // A name takes a SINGULAR verb, whoever it belongs to. "are" was an
      // attempt to avoid assuming gender, but the fix for that is to use the
      // name — not to make the sentence ungrammatical.
      Alert.alert('Role updated', `${editing.name || 'That member'} is now ${chosen.label}.`);
    } catch (e: any) {
      const status = Number(e?.status ?? e?.statusCode ?? 0);
      // The server's own words for 409 — it explains which rank is needed.
      setRoleErr(status === 409 && e?.message ? String(e.message) : roleErrorText(status, e?.message));
      setConfirming(false);
    } finally {
      setSaving(false);
    }
  };

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return people;
    return people.filter((p) => (p.name || '').toLowerCase().includes(needle));
  }, [people, q]);

  // Counts come from the same list the rows render, so the header can never
  // disagree with what is underneath it.
  const counts = useMemo(() => ({
    in: people.filter((p) => p.status === 'in').length,
    leave: people.filter((p) => p.status === 'on_leave').length,
    unknown: people.filter((p) => p.status === 'unknown').length,
  }), [people]);

  const s = styles(colors);

  if (loading) {
    return (
      <View style={[s.screen, s.centre]}>
        <Stack.Screen options={spaceHeader(colors, 'People')} />
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <Stack.Screen options={spaceHeader(colors, params.name ? `${params.name} · People` : 'People')} />

      <View style={s.head}>
        <View style={s.counts}>
          <Count value={counts.in} label="In" tone={colors.success} c={colors} />
          <Count value={counts.leave} label="On leave" tone={'#F59E0B'} c={colors} />
          <Count value={counts.unknown} label="No check-in" tone={colors.textFaint} c={colors} />
        </View>
        <TextInput
          style={s.search}
          value={q}
          onChangeText={setQ}
          placeholder="Search people"
          placeholderTextColor={colors.textDim}
        />
      </View>

      <ScrollView
        contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
      >
        {filtered.length === 0 && <Text style={s.muted}>Nobody matches.</Text>}

        {filtered.map((p) => {
          const canEdit = !!viewer && canChangeRole(viewer.role, viewer.id, p.role, p.userId)
            && !!catalog?.some((d) => d.rank === p.role);
          return (
          <TouchableOpacity
            key={p.userId}
            style={s.row}
            activeOpacity={canEdit ? 0.6 : 1}
            onPress={() => canEdit && openPicker(p)}
          >
            <View style={[s.avatar, { backgroundColor: colors.primary + '22' }]}>
              <Text style={{ color: colors.primary, fontWeight: '800' }}>
                {(p.name || '?').trim()[0]?.toUpperCase()}
              </Text>
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.name} numberOfLines={1}>{p.name || 'Member'}</Text>
              <Text style={s.muted} numberOfLines={1}>
                {/* The catalog's LABEL, never the stored key: role_key is an
                    internal identifier and "transport manager" spelled out of a
                    snake_case string is a guess at a name the catalog already
                    holds properly. */}
                {labelFor(p)}
                {p.checkInAt ? ` · in ${clock(p.checkInAt)}` : ''}
                {p.checkOutAt ? ` · out ${clock(p.checkOutAt)}` : ''}
                {p.dutyState ? ` · ${p.dutyState.replace('_', ' ')}` : ''}
              </Text>
            </View>
            <View style={[s.pill, { backgroundColor: tone(p.status, colors) + '22' }]}>
              <View style={[s.pillDot, { backgroundColor: tone(p.status, colors) }]} />
              <Text style={{ color: tone(p.status, colors), fontSize: 11, fontWeight: '700' }}>
                {LABEL[p.status]}
              </Text>
            </View>
            {canEdit && <Ionicons name="chevron-forward" size={16} color={colors.textDim} />}
          </TouchableOpacity>
          );
        })}

        <Text style={s.footnote}>
          Status is what people declared today. “No check-in” means nobody told us — it is not
          the same as absent, and is never counted as one.
        </Text>
      </ScrollView>

      {/* ── Role picker ───────────────────────────────────────────────
          Selecting does NOT save. The confirmation is a separate step
          because a role change alters what someone can see and do, and
          that should never happen on a mis-tap. */}
      <Modal visible={!!editing} transparent animationType="slide" onRequestClose={() => setEditing(null)}>
        <View style={s.sheetWrap}>
          <View style={s.sheet}>
            <Text style={s.sheetTitle}>Change role</Text>

            {editing && (
              <View style={s.who}>
                <View style={[s.avatar, { backgroundColor: colors.primary + '22' }]}>
                  <Text style={{ color: colors.primary, fontWeight: '800' }}>
                    {(editing.name || '?').trim()[0]?.toUpperCase()}
                  </Text>
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.name} numberOfLines={1}>{editing.name || 'Member'}</Text>
                  <Text style={s.muted}>Currently {labelFor(editing)}</Text>
                </View>
              </View>
            )}

            {roleErr && (
              <View style={s.errBox}>
                <Ionicons name="alert-circle" size={16} color={colors.danger} />
                <Text style={[s.muted, { color: colors.danger, flex: 1 }]}>{roleErr}</Text>
              </View>
            )}

            {/* No same-rank alternatives is a real answer, not an error. */}
            {options.length === 0 && (
              <Text style={s.muted}>
                This space has no other role at this member&apos;s level. Changing their
                rank first will offer more.
              </Text>
            )}

            <ScrollView style={{ maxHeight: 340 }}>
              {options.map((o) => (
                <TouchableOpacity
                  key={o.key}
                  onPress={() => { setChosen(o); setRoleErr(null); }}
                  style={[s.roleCard, chosen?.key === o.key && { borderColor: colors.primary }]}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Ionicons
                      name={chosen?.key === o.key ? 'radio-button-on' : 'radio-button-off'}
                      size={18}
                      color={chosen?.key === o.key ? colors.primary : colors.textDim}
                    />
                    <Text style={s.name}>{o.label}</Text>
                    {o.current && <Text style={s.currentTag}>CURRENT</Text>}
                  </View>
                  {/* One line in the list; the full matrix once selected, so
                      choosing a role is never done blind. null, [] and a real
                      list stay three distinct statements — PermissionMatrix
                      owns that distinction. */}
                  {o.grants === null ? (
                    <Text style={s.muted}>Inherits the standard {rankLabel(o.rank)} permissions</Text>
                  ) : o.grants.length === 0 ? (
                    <Text style={s.muted}>No permissions of its own</Text>
                  ) : (
                    <Text style={s.muted}>
                      {o.grants.length} permission{o.grants.length === 1 ? '' : 's'}
                      {' · '}{o.grants.slice(0, 3).map(permissionLabel).join(', ')}
                      {o.grants.length > 3 ? '…' : ''}
                    </Text>
                  )}
                  {chosen?.key === o.key && (
                    <PermissionMatrix
                      role={catalog?.find((d) => d.key === o.key) ?? null}
                      error={catalogErr}
                    />
                  )}
                </TouchableOpacity>
              ))}
            </ScrollView>

            {confirming && editing && chosen ? (
              <View style={s.confirm}>
                <Text style={s.name}>Change role?</Text>
                <Text style={s.muted}>
                  {editing.name || 'This member'} · {labelFor(editing)} → {chosen.label}
                </Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TouchableOpacity onPress={() => setConfirming(false)} style={[s.btn, s.btnGhost, { flex: 1 }]}>
                    <Text style={[s.btnText, { color: colors.text }]}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={commit}
                    disabled={saving}
                    style={[s.btn, { backgroundColor: colors.primary, flex: 1, opacity: saving ? 0.5 : 1 }]}
                  >
                    <Text style={s.btnText}>{saving ? 'Saving…' : 'Confirm'}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <TouchableOpacity onPress={() => setEditing(null)} style={[s.btn, s.btnGhost, { flex: 1 }]}>
                  <Text style={[s.btnText, { color: colors.text }]}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => setConfirming(true)}
                  disabled={!chosen || chosen.current || saving}
                  style={[s.btn, {
                    backgroundColor: colors.primary, flex: 1,
                    opacity: !chosen || chosen.current || saving ? 0.5 : 1,
                  }]}
                >
                  <Text style={s.btnText}>Change role</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

function Count({ value, label, tone, c }: { value: number; label: string; tone: string; c: Palette }) {
  const s = styles(c);
  return (
    <View style={s.count}>
      <Text style={[s.countValue, { color: tone }]}>{value}</Text>
      <Text style={s.countLabel}>{label}</Text>
    </View>
  );
}

function tone(st: Person['status'], c: Palette): string {
  switch (st) {
    case 'in': return c.success;
    case 'on_leave': return '#F59E0B';
    case 'left': return c.textDim;
    default: return c.textFaint;
  }
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const styles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  centre: { alignItems: 'center', justifyContent: 'center' },
  head: { padding: 16, gap: 10, borderBottomWidth: 1, borderBottomColor: c.border },
  counts: { flexDirection: 'row', gap: 8 },
  count: { flex: 1, backgroundColor: c.card, borderRadius: 12, paddingVertical: 10, alignItems: 'center' },
  countValue: { fontSize: 20, fontWeight: '800' },
  countLabel: { color: c.textDim, fontSize: 11 },
  search: {
    borderWidth: 1, borderColor: c.border, borderRadius: 10,
    paddingHorizontal: 12, height: 42, color: c.text,
  },
  body: { padding: 16, gap: 4, paddingBottom: 40 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  avatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  name: { color: c.text, fontSize: 15, fontWeight: '600' },
  muted: { color: c.textDim, fontSize: 12.5, flexShrink: 1 },
  pill: { borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4, flexDirection: 'row', alignItems: 'center', gap: 5 },
  pillDot: { width: 6, height: 6, borderRadius: 3 },
  sheetWrap: { flex: 1, backgroundColor: '#0008', justifyContent: 'flex-end' },
  sheet: { backgroundColor: c.card, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18, gap: 12 },
  sheetTitle: { color: c.text, fontSize: 17, fontWeight: '800' },
  who: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  errBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: c.danger + '14', borderRadius: 10, padding: 10,
  },
  roleCard: {
    borderWidth: 1, borderColor: c.border, borderRadius: 12,
    padding: 12, gap: 4, marginBottom: 8,
  },
  currentTag: { color: c.textFaint, fontSize: 10, fontWeight: '800' },
  confirm: { backgroundColor: c.bg, borderRadius: 12, padding: 12, gap: 8 },
  btn: { alignItems: 'center', justifyContent: 'center', borderRadius: 10, paddingVertical: 12 },
  btnGhost: { backgroundColor: c.bg },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  footnote: { color: c.textFaint, fontSize: 11.5, lineHeight: 16, marginTop: 10 },
});
