// components/spaces/SpaceLinksSheet.tsx — add and remove space links
// (guardian_of / supervises / teaches).
//
// Links are what the scoped-visibility rule reads: a parent sees the roster
// entries they are guardian_of, a supervisor their reports. addLink/removeLink
// existed with no caller, so none of that could be configured from the app.
// Every write is re-checked server-side against manage_roster.

import React, { useMemo, useState } from 'react';
import {
  View, Modal, ScrollView, TouchableOpacity, TextInput, Alert, ActivityIndicator, StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText as Text } from '../ui/Text';
import { KeyboardSafe } from '../ui/KeyboardSafe';
import LoadError from './LoadError';
import type { SpacePalette } from '../../lib/spaces/theme';
import {
  addLink, removeLink, type RosterEntry, type SpaceLink, type LinkRelation,
} from '../../lib/spaces/api';

const RELATIONS: { key: LinkRelation; label: string }[] = [
  { key: 'guardian_of', label: 'is guardian of' },
  { key: 'supervises', label: 'supervises' },
  { key: 'teaches', label: 'teaches' },
];
const relLabel = (r: LinkRelation) => RELATIONS.find((x) => x.key === r)?.label ?? r;

/** The picker draws at most this many rows; a search narrows past it. */
const PICK_LIMIT = 100;

export default function SpaceLinksSheet({
  visible, onClose, colors, spaceId, roster, links, linksError, linksLoading, onChanged,
}: {
  visible: boolean;
  onClose: () => void;
  colors: SpacePalette;
  spaceId: string;
  roster: RosterEntry[];
  links: SpaceLink[];
  /** Set when the links could not be read, so the list is not drawn as "No links yet". */
  linksError?: string | null;
  /** True until the first read of the links settles — "No links yet" is not
   *  drawn for a list that has not arrived. */
  linksLoading?: boolean;
  /** Re-read links (and anything they affect) after a write. */
  onChanged: () => void | Promise<void>;
}) {
  const insets = useSafeAreaInsets();
  const [subject, setSubject] = useState<RosterEntry | null>(null);
  const [object, setObject] = useState<RosterEntry | null>(null);
  const [relation, setRelation] = useState<LinkRelation>('guardian_of');
  const [picking, setPicking] = useState<'subject' | 'object' | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const nameOf = useMemo(() => {
    const m = new Map(roster.map((r) => [r.id, r.displayName]));
    return (id: string) => m.get(id) ?? 'Someone not on this list';
  }, [roster]);
  const allMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return roster.filter((r) => !r.archived && (!q || r.displayName.toLowerCase().includes(q)));
  }, [roster, query]);
  const matches = allMatches.slice(0, PICK_LIMIT);

  const s = styles(colors);

  const onAdd = async () => {
    if (!subject || !object || busy) return;
    setBusy(true);
    try {
      await addLink(spaceId, { subjectId: subject.id, objectId: object.id, relation });
      setSubject(null); setObject(null);
      await onChanged();
    } catch (e: any) {
      Alert.alert('Could not add the link', e?.message ?? 'Try again.');
    } finally { setBusy(false); }
  };

  const onRemove = (l: SpaceLink) => {
    Alert.alert(
      'Remove this link?',
      `${nameOf(l.subjectId)} ${relLabel(l.relation)} ${nameOf(l.objectId)}. ` +
      'They may stop seeing this person straight away.',
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Remove', style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try { await removeLink(spaceId, l); await onChanged(); }
            catch (e: any) { Alert.alert('Could not remove the link', e?.message ?? 'Try again.'); }
            finally { setBusy(false); }
          },
        },
      ],
    );
  };

  const pickerButton = (which: 'subject' | 'object', value: RosterEntry | null, placeholder: string) => (
    <TouchableOpacity
      style={s.picker} onPress={() => { setQuery(''); setPicking(which); }}
      accessibilityRole="button" accessibilityLabel={`${placeholder}: ${value?.displayName ?? 'not chosen'}`}
    >
      <Text style={[s.pickerText, !value && { color: colors.textDim }]} numberOfLines={1}>
        {value?.displayName ?? placeholder}
      </Text>
      <Ionicons name="chevron-down" size={16} color={colors.textDim} />
    </TouchableOpacity>
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={picking ? () => setPicking(null) : onClose}>
      <KeyboardSafe keyboardOnly>
      <View style={[s.screen, { paddingTop: insets.top + 8, paddingBottom: insets.bottom }]}>
        <View style={s.header}>
          <TouchableOpacity
            onPress={picking ? () => setPicking(null) : onClose}
            accessibilityRole="button" accessibilityLabel={picking ? 'Back' : 'Close'} style={s.hit}
          >
            <Ionicons name={picking ? 'arrow-back' : 'close'} size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={s.title}>{picking ? 'Choose a person' : 'Links'}</Text>
          {busy && <ActivityIndicator size="small" color={colors.primary} />}
        </View>

        {picking ? (
          <>
            <TextInput
              style={[s.input, { marginHorizontal: 16 }]} value={query} onChangeText={setQuery} autoFocus
              placeholder="Search the roster" placeholderTextColor={colors.textDim} accessibilityLabel="Search the roster"
            />
            <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
              {matches.length === 0 && <Text style={s.muted}>Nobody on the roster matches.</Text>}
              {allMatches.length > PICK_LIMIT && (
                <Text style={s.muted}>
                  Showing the first {PICK_LIMIT} of {allMatches.length}. Search to find anyone else.
                </Text>
              )}
              {matches.map((r) => (
                <TouchableOpacity
                  key={r.id} style={s.row}
                  onPress={() => { (picking === 'subject' ? setSubject : setObject)(r); setPicking(null); }}
                  accessibilityRole="button" accessibilityLabel={r.displayName}
                >
                  <Ionicons name={r.userId ? 'person' : 'happy-outline'} size={18} color={colors.primary} />
                  <Text style={s.rowText} numberOfLines={1}>{r.displayName}</Text>
                  <Text style={s.muted}>{r.userId ? 'Has an account' : 'No account'}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </>
        ) : (
          <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
            <Text style={s.section}>NEW LINK</Text>
            <View style={s.card}>
              {pickerButton('subject', subject, 'Person who sees (e.g. a parent)')}
              <View style={s.chips}>
                {RELATIONS.map((r) => (
                  <TouchableOpacity
                    key={r.key} onPress={() => setRelation(r.key)}
                    style={[s.chip, relation === r.key && { backgroundColor: colors.brandOnLight }]}
                    accessibilityRole="radio" accessibilityState={{ checked: relation === r.key }}
                  >
                    {/* White ink on the solid brand fill: brandOnLight is a deep
                        blue in both schemes, so this keeps contrast. */}
                    <Text style={[s.chipText, relation === r.key && { color: '#fff' }]}>{r.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              {pickerButton('object', object, 'Person they see (e.g. a child)')}
              <Text style={s.muted}>
                The first person needs an account to benefit: links are how the server decides
                what each signed-in person may see.
              </Text>
              <TouchableOpacity
                style={[s.primary, (!subject || !object || subject.id === object.id || busy) && { opacity: 0.4 }]}
                onPress={onAdd} disabled={!subject || !object || subject.id === object.id || busy}
                accessibilityRole="button" accessibilityLabel="Add link"
                accessibilityState={{ disabled: !subject || !object || subject.id === object.id || busy }}
              >
                <Text style={s.primaryText}>Add link</Text>
              </TouchableOpacity>
            </View>

            <Text style={s.section}>CURRENT LINKS</Text>
            {linksError ? (
              <LoadError colors={colors} title="Could not load the links" message={linksError} onRetry={() => { void onChanged(); }} />
            ) : linksLoading ? (
              <View style={s.card} accessibilityLabel="Loading links">
                <ActivityIndicator color={colors.primary} />
              </View>
            ) : (
            <View style={s.card}>
              {links.length === 0 && <Text style={s.muted}>No links yet.</Text>}
              {links.map((l) => (
                <View key={`${l.subjectId}|${l.relation}|${l.objectId}`} style={s.row}>
                  <Text style={s.rowText}>
                    {nameOf(l.subjectId)} <Text style={s.muted}>{relLabel(l.relation)}</Text> {nameOf(l.objectId)}
                  </Text>
                  <TouchableOpacity
                    onPress={() => onRemove(l)} disabled={busy} style={s.hit}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove link: ${nameOf(l.subjectId)} ${relLabel(l.relation)} ${nameOf(l.objectId)}`}
                  >
                    <Ionicons name="close-circle-outline" size={20} color={colors.textDim} />
                  </TouchableOpacity>
                </View>
              ))}
            </View>
            )}
          </ScrollView>
        )}
      </View>
      </KeyboardSafe>
    </Modal>
  );
}

const styles = (c: SpacePalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingBottom: 10 },
  title: { color: c.text, fontSize: 18, fontWeight: '700', flex: 1 },
  hit: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  body: { padding: 16, gap: 10, paddingBottom: 40 },
  section: { color: c.textDim, fontSize: 11.5, letterSpacing: 1, marginTop: 4 },
  card: { backgroundColor: c.glassSoft, borderRadius: 14, padding: 14, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  rowText: { color: c.text, flex: 1, fontSize: 14.5 },
  muted: { color: c.textDim, fontSize: 12.5 },
  picker: {
    flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44,
    borderWidth: 1, borderColor: c.glassStroke, borderRadius: 10, paddingHorizontal: 12,
  },
  pickerText: { color: c.text, flex: 1, fontSize: 15 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    borderWidth: 1, borderColor: c.glassStroke, borderRadius: 22, paddingHorizontal: 14,
    minHeight: 44, justifyContent: 'center',
  },
  chipText: { color: c.textDim, fontSize: 12.5 },
  input: { borderWidth: 1, borderColor: c.glassStroke, borderRadius: 10, padding: 12, color: c.text, fontSize: 15 },
  primary: { backgroundColor: c.brandOnLight, borderRadius: 10, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: '#fff', fontWeight: '700' },
});
