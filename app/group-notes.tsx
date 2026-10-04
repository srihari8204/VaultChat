// app/group-notes.tsx — the group's shared notes (Groups & Circles, G4.5).
//
// Distinct from app/encrypted-notes.tsx, which is your PRIVATE notebook sealed
// with a device-local key. These are sealed with the GROUP's encryption and
// carried on its message thread, so every member can read them and nobody else
// can — including the server.
//
// Like tasks, each change is one encrypted event and the list is the fold, so
// editing offline just queues a message and devices converge without this
// screen coordinating anything.

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  View, StyleSheet, TouchableOpacity, FlatList, TextInput, Alert,
  ActivityIndicator, Modal,
} from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { AuroraBackground } from '../components/ui/AuroraBackground';
import { AppText as Text } from '../components/ui/Text';
import { getCurrentUserAsync } from './(constants)/authService';
import {
  encodeNoteOp, decodeNoteOp, foldNotes, sortNotes, preview, newNoteId,
  type Note, type NoteOp,
} from '../lib/groups/notes';
import { readGroupOps, sendGroupOp } from '../lib/groups/opThread';
import { KeyboardSafe } from '../components/ui';
import { GroupNotFound } from '../components/groups/GroupNotFound';
import { ThreadGaps } from '../components/groups/ThreadGaps';

const when = (ts: number) => {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
};

export default function GroupNotesScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ groupId?: string; name?: string }>();
  const groupId = String(params.groupId || '');

  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  // Load failed: an error screen when nothing is listed, a banner over the list otherwise.
  const [failed, setFailed] = useState(false);
  // What the last read could not see: undecryptable messages, and whether paging stopped early.
  const [gaps, setGaps] = useState<{ unreadable: number; complete: boolean }>({ unreadable: 0, complete: true });
  const [me, setMe] = useState<string | null>(null);

  const [editing, setEditing] = useState<Note | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  // Banner Retry in flight: the list stays on screen (no full-screen spinner).
  const [retrying, setRetrying] = useState(false);

  // The ops the list was folded from: a new op is folded onto these, not onto
  // a log rebuilt from the folded notes (which loses what the fold dropped).
  const opsRef = useRef<NoteOp[]>([]);
  const rebuild = useCallback(async () => {
    if (!groupId) { setLoading(false); return; }
    try {
      // The server op index (or, on a server without it, the paged read) plus
      // this device's own history (lib/groups/opThread). The viewer keys the
      // in-memory legacy scan, so another account never reuses it.
      const u = await getCurrentUserAsync().catch(() => null);
      const { ops, unreadable, complete } = await readGroupOps<NoteOp>(groupId, 'notes', decodeNoteOp, u ? String(u.id) : null);
      opsRef.current = ops;
      setGaps({ unreadable, complete });
      setNotes(foldNotes(ops));
      setFailed(false);
    } catch {
      // Offline: keep what is on screen rather than blanking the list.
      setFailed(true);
    } finally { setLoading(false); }
  }, [groupId]);

  useFocusEffect(useCallback(() => {
    let live = true;
    (async () => {
      const u = await getCurrentUserAsync().catch(() => null);
      if (live) setMe(u ? String(u.id) : null);
      await rebuild();
    })();
    return () => { live = false; };
  }, [rebuild]));

  /** Publish one event and fold it in locally so the UI is instant. Resolves false on failure. */
  const publish = async (op: NoteOp): Promise<boolean> => {
    opsRef.current = [...opsRef.current, op];
    setNotes(foldNotes(opsRef.current));
    try {
      // Tagged 'notes' so the server can index it; the op itself stays encrypted.
      await sendGroupOp(groupId, 'notes', encodeNoteOp(op));
      return true;
    } catch (e) {
      // Take the unsent op back out first: if the re-read below also fails
      // (offline), the list must not keep showing a change nobody received.
      opsRef.current = opsRef.current.filter((x) => x !== op);
      setNotes(foldNotes(opsRef.current));
      Alert.alert('Not saved', e instanceof Error && e.message ? e.message : 'Could not reach the group.');
      rebuild();
      return false;
    }
  };

  const openNew = () => { setEditing(null); setDraftTitle(''); setDraftBody(''); setCreating(true); };
  const openEdit = (n: Note) => { setEditing(n); setDraftTitle(n.title); setDraftBody(n.body); setCreating(true); };

  const save = async () => {
    const t = draftTitle.trim();
    if (!t || busy || !me) return;
    setBusy(true);
    const at = Date.now();
    let ok = true;
    if (editing) {
      // Send only what actually changed, so a title-only edit cannot clobber a
      // body someone else edited meanwhile — that is the point of field-level
      // merge in the fold.
      const op: NoteOp = { k: 'edit', id: editing.id, at, by: me };
      if (t !== editing.title) op.title = t;
      if (draftBody !== editing.body) op.body = draftBody;
      if (op.title !== undefined || op.body !== undefined) ok = await publish(op);
    } else {
      ok = await publish({ k: 'add', id: newNoteId(), at, by: me, title: t, body: draftBody });
    }
    setBusy(false);
    // A failed send keeps the sheet (and the draft) open so nothing typed is lost.
    if (ok) { setCreating(false); setEditing(null); }
  };

  const togglePin = (n: Note) => {
    if (!me) return;
    publish({ k: 'pin', id: n.id, at: Date.now(), by: me, pinned: !n.pinned });
  };

  const remove = (n: Note) => {
    if (!me) return;
    Alert.alert('Delete note?', `"${n.title}" will be removed for everyone.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => { publish({ k: 'del', id: n.id, at: Date.now(), by: me }); setCreating(false); } },
    ]);
  };

  const ordered = useMemo(() => sortNotes(notes), [notes]);

  const retryInPlace = async () => {
    if (retrying) return;
    setRetrying(true);
    try { await rebuild(); } finally { setRetrying(false); }
  };

  if (!groupId) return <GroupNotFound title="Notes" />;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <AuroraBackground variant="chat" />
      <Stack.Screen options={{ headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text, headerShadowVisible: false,
        headerShown: true, /* the root Stack sets headerShown:false app-wide, so the options below were inert and this screen had no back control at all */
        title: 'Notes', headerTitleAlign: 'center',
        headerRight: () => (
          <TouchableOpacity onPress={openNew} accessibilityRole="button" accessibilityLabel="New note" style={{ paddingHorizontal: 8 }}>
            <Ionicons name="add" size={24} color={colors.primary} />
          </TouchableOpacity>
        ),
      }} />

      {loading ? (
        <View style={st.center}><ActivityIndicator color={colors.primary} /></View>
      ) : ordered.length === 0 && failed ? (
        <View style={[st.center, { padding: 34 }]}>
          <Ionicons name="cloud-offline-outline" size={30} color={colors.textFaint} />
          <Text style={{ color: colors.text, fontWeight: '700', marginTop: 10 }}>Couldn’t load notes</Text>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Retry loading notes" onPress={() => { setLoading(true); rebuild(); }}
            style={[st.btn, { backgroundColor: colors.primary, paddingHorizontal: 22 }]}>
            <Text style={[st.btnTxt, { color: colors.onPrimary }]}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : ordered.length === 0 ? (
        <View style={[st.center, { padding: 34 }]}>
          <Ionicons name="document-text-outline" size={30} color={colors.textFaint} />
          <Text style={{ color: colors.text, fontWeight: '700', marginTop: 10 }}>No notes yet</Text>
          <Text style={{ color: colors.textDim, fontSize: 13, textAlign: 'center', marginTop: 4 }}>
            Packing lists, door codes, plans — shared with the group and encrypted end to end.
          </Text>
        </View>
      ) : (
        <FlatList
          data={ordered}
          keyExtractor={(n) => n.id}
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          ListHeaderComponent={<>
            {failed && (
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Couldn't refresh notes. Showing what was loaded before. Retry"
                accessibilityState={{ busy: retrying, disabled: retrying }} disabled={retrying}
                onPress={retryInPlace}
                style={[st.banner, { borderColor: colors.danger }]}>
                {retrying ? <ActivityIndicator size="small" color={colors.danger} />
                  : <Ionicons name="cloud-offline-outline" size={15} color={colors.danger} />}
                <Text style={{ color: colors.danger, fontSize: 12.5, flex: 1 }}>Couldn’t refresh — these may be out of date. Tap to retry.</Text>
              </TouchableOpacity>
            )}
          </>}
          renderItem={({ item: n }) => (
            // Edit and Pin are SIBLINGS: a touchable nested in a touchable is
            // merged into one element by screen readers (Pin was unreachable
            // with VoiceOver).
            <View style={[st.card, { backgroundColor: colors.glassSoft, borderColor: n.pinned ? colors.primary : colors.border }]}>
              <TouchableOpacity onPress={() => openEdit(n)} activeOpacity={0.75} style={st.cardMain}
                accessibilityRole="button" accessibilityLabel={`${n.title}${n.pinned ? ', pinned' : ''}. Edit note`}>
                <Text style={{ color: colors.text, fontWeight: '700', fontSize: 15, paddingRight: 30 }} numberOfLines={1}>
                  {n.title}
                </Text>
                {!!preview(n) && (
                  <Text style={{ color: colors.textDim, fontSize: 13, marginTop: 4 }} numberOfLines={2}>
                    {preview(n)}
                  </Text>
                )}
                <Text style={{ color: colors.textFaint, fontSize: 11, marginTop: 6 }}>
                  Updated {when(n.updatedAt)}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel={n.pinned ? `Unpin ${n.title}` : `Pin ${n.title}`}
                onPress={() => togglePin(n)} hitSlop={12} style={st.pin}>
                <Ionicons name={n.pinned ? 'pin' : 'pin-outline'} size={17} color={n.pinned ? colors.primary : colors.textFaint} />
              </TouchableOpacity>
            </View>
          )}
          ListFooterComponent={<ThreadGaps unreadable={gaps.unreadable} complete={gaps.complete} what="notes" />}
        />
      )}

      <Modal visible={creating} transparent animationType="slide" onRequestClose={() => setCreating(false)}>
        {/* KeyboardSafe, not KeyboardAvoidingView (2026-09-17): a React Native
            <Modal> is its own Android window and never receives the activity's
            adjustResize, and KAV's 'padding' math mixes Modal-relative layout
            coords with absolute screen coords, so the lift came up short.
            keyboardOnly: this sheet already sets its own bottom padding. */}
        <KeyboardSafe keyboardOnly style={[st.backdrop, { backgroundColor: colors.scrim }]}>
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setCreating(false)}
            accessibilityRole="button" accessibilityLabel="Close without saving" />
          <View style={[st.sheet, { backgroundColor: colors.glassSoft, borderColor: colors.glassStroke }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
              <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16, flex: 1 }} accessibilityRole="header">
                {editing ? 'Edit note' : 'New note'}
              </Text>
              {!!editing && (
                <TouchableOpacity accessibilityRole="button" accessibilityLabel="Delete this note" onPress={() => remove(editing)} hitSlop={12}>
                  <Ionicons name="trash-outline" size={19} color={colors.danger} />
                </TouchableOpacity>
              )}
            </View>

            <View style={[st.field, { borderColor: colors.glassStroke, backgroundColor: colors.glassSoft }]}>
              <TextInput value={draftTitle} onChangeText={setDraftTitle} placeholder="Title" accessibilityLabel="Note title"
                placeholderTextColor={colors.textFaint} style={[st.input, { color: colors.text }]} maxLength={120} />
            </View>
            <View style={[st.field, { borderColor: colors.glassStroke, backgroundColor: colors.glassSoft, height: 150, alignItems: 'flex-start', paddingTop: 12, marginTop: 10 }]}>
              <TextInput value={draftBody} onChangeText={setDraftBody} placeholder="Write something…" multiline accessibilityLabel="Note text"
                placeholderTextColor={colors.textFaint} style={[st.input, { color: colors.text, height: '100%' }]} />
            </View>

            <TouchableOpacity onPress={save} disabled={!draftTitle.trim() || busy || !me}
              accessibilityRole="button" accessibilityState={{ disabled: !draftTitle.trim() || busy || !me, busy }}
              style={[st.btn, { backgroundColor: draftTitle.trim() && !busy && me ? colors.primary : colors.border }]}>
              {busy ? <ActivityIndicator color={colors.onPrimary} />
                : <><Ionicons name="checkmark" size={18} color={colors.onPrimary} /><Text style={[st.btnTxt, { color: colors.onPrimary }]}>{editing ? 'Save' : 'Add note'}</Text></>}
            </TouchableOpacity>
            {!!editing && (
              <Text style={{ color: colors.textFaint, fontSize: 11.5, textAlign: 'center', marginTop: 10 }}>
                Only what you changed is sent, so someone else editing another part keeps their work.
              </Text>
            )}
          </View>
        </KeyboardSafe>
      </Modal>
    </View>
  );
}

const st = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: { borderWidth: 1, borderRadius: 14, marginBottom: 10 },
  cardMain: { padding: 14 },
  pin: { position: 'absolute', top: 10, right: 10, padding: 4 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderWidth: 1, borderRadius: 12, marginBottom: 12 },
  backdrop: { flex: 1 },
  sheet: { borderTopLeftRadius: 22, borderTopRightRadius: 22, borderTopWidth: 1, padding: 18, paddingBottom: 32 },
  field: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, minHeight: 48 },
  input: { flex: 1, fontSize: 15 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 50, borderRadius: 13, marginTop: 16 },
  btnTxt: { fontSize: 15, fontWeight: '800' },
});
