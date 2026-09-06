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

import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput, Alert,
  ActivityIndicator, Modal, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { sendMessage, getMessages, decryptFromChat } from '../lib/chatService';
import { unionWithLocalHistoryAsc } from '../lib/messageHistory';
import { getCurrentUserAsync } from './(constants)/authService';
import {
  encodeNoteOp, decodeNoteOp, foldNotes, sortNotes, preview, newNoteId,
  type Note, type NoteOp,
} from '../lib/groups/notes';

const SCAN_LIMIT = 400;

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
  const [me, setMe] = useState<string | null>(null);

  const [editing, setEditing] = useState<Note | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const rebuild = useCallback(async () => {
    if (!groupId) { setLoading(false); return; }
    try {
      // Ops older than the retention window survive only on this device.
      const msgs = await unionWithLocalHistoryAsc(
        groupId, await getMessages(groupId, { limit: SCAN_LIMIT }), SCAN_LIMIT * 4);
      const ops: NoteOp[] = [];
      for (const m of msgs) {
        if (m.deletedAt || !m.content) continue;
        let body = '';
        try { body = await decryptFromChat(groupId, m.senderId, m.content, m.id); } catch { continue; }
        const op = decodeNoteOp(body);
        if (op) ops.push(op);
      }
      setNotes(foldNotes(ops));
    } catch {
      // Offline: keep what is on screen rather than blanking the list.
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

  /** Publish one event and fold it in locally so the UI is instant. */
  const publish = async (op: NoteOp) => {
    setNotes((prev) => {
      const replay: NoteOp[] = prev.map((n) => ({
        k: 'add', id: n.id, at: n.createdAt, by: n.createdBy, title: n.title, body: n.body,
      }));
      for (const n of prev) {
        if (n.updatedAt !== n.createdAt) {
          replay.push({ k: 'edit', id: n.id, at: n.updatedAt, by: n.updatedBy, title: n.title, body: n.body });
        }
        if (n.pinned) replay.push({ k: 'pin', id: n.id, at: n.updatedAt, by: n.updatedBy, pinned: true });
      }
      return foldNotes([...replay, op]);
    });
    try {
      await sendMessage(groupId, encodeNoteOp(op));
    } catch (e: any) {
      Alert.alert('Not saved', e?.message ?? 'Could not reach the group.');
      rebuild();
    }
  };

  const openNew = () => { setEditing(null); setDraftTitle(''); setDraftBody(''); setCreating(true); };
  const openEdit = (n: Note) => { setEditing(n); setDraftTitle(n.title); setDraftBody(n.body); setCreating(true); };

  const save = async () => {
    const t = draftTitle.trim();
    if (!t || busy || !me) return;
    setBusy(true);
    const at = Date.now();
    if (editing) {
      // Send only what actually changed, so a title-only edit cannot clobber a
      // body someone else edited meanwhile — that is the point of field-level
      // merge in the fold.
      const op: NoteOp = { k: 'edit', id: editing.id, at, by: me };
      if (t !== editing.title) op.title = t;
      if (draftBody !== editing.body) op.body = draftBody;
      if (op.title !== undefined || op.body !== undefined) await publish(op);
    } else {
      await publish({ k: 'add', id: newNoteId(), at, by: me, title: t, body: draftBody });
    }
    setCreating(false); setEditing(null); setBusy(false);
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

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{
        title: 'Notes', headerTitleAlign: 'center',
        headerRight: () => (
          <TouchableOpacity onPress={openNew} style={{ paddingHorizontal: 8 }}>
            <Ionicons name="add" size={24} color={colors.primary} />
          </TouchableOpacity>
        ),
      }} />

      {loading ? (
        <View style={st.center}><ActivityIndicator color={colors.primary} /></View>
      ) : ordered.length === 0 ? (
        <View style={[st.center, { padding: 34 }]}>
          <Ionicons name="document-text-outline" size={30} color={colors.textFaint} />
          <Text style={{ color: colors.text, fontWeight: '700', marginTop: 10 }}>No notes yet</Text>
          <Text style={{ color: colors.textDim, fontSize: 13, textAlign: 'center', marginTop: 4 }}>
            Packing lists, door codes, plans — shared with the group and encrypted end to end.
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
          {ordered.map((n) => (
            <TouchableOpacity key={n.id} onPress={() => openEdit(n)} activeOpacity={0.75}
              style={[st.card, { backgroundColor: colors.card, borderColor: n.pinned ? colors.primary : colors.border }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ color: colors.text, fontWeight: '700', fontSize: 15, flex: 1 }} numberOfLines={1}>
                  {n.title}
                </Text>
                <TouchableOpacity onPress={() => togglePin(n)} hitSlop={8}>
                  <Ionicons name={n.pinned ? 'pin' : 'pin-outline'} size={17} color={n.pinned ? colors.primary : colors.textFaint} />
                </TouchableOpacity>
              </View>
              {!!preview(n) && (
                <Text style={{ color: colors.textDim, fontSize: 13, marginTop: 4 }} numberOfLines={2}>
                  {preview(n)}
                </Text>
              )}
              <Text style={{ color: colors.textFaint, fontSize: 11, marginTop: 6 }}>
                Updated {when(n.updatedAt)}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      <Modal visible={creating} transparent animationType="slide" onRequestClose={() => setCreating(false)}>
        <KeyboardAvoidingView behavior={'padding'} style={st.backdrop}>
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setCreating(false)} />
          <View style={[st.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
              <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16, flex: 1 }}>
                {editing ? 'Edit note' : 'New note'}
              </Text>
              {!!editing && (
                <TouchableOpacity onPress={() => remove(editing)} hitSlop={8}>
                  <Ionicons name="trash-outline" size={19} color={colors.danger} />
                </TouchableOpacity>
              )}
            </View>

            <View style={[st.field, { borderColor: colors.border, backgroundColor: colors.surface }]}>
              <TextInput value={draftTitle} onChangeText={setDraftTitle} placeholder="Title"
                placeholderTextColor={colors.textFaint} style={[st.input, { color: colors.text }]} maxLength={120} />
            </View>
            <View style={[st.field, { borderColor: colors.border, backgroundColor: colors.surface, height: 150, alignItems: 'flex-start', paddingTop: 12, marginTop: 10 }]}>
              <TextInput value={draftBody} onChangeText={setDraftBody} placeholder="Write something…" multiline
                placeholderTextColor={colors.textFaint} style={[st.input, { color: colors.text, height: '100%' }]} />
            </View>

            <TouchableOpacity onPress={save} disabled={!draftTitle.trim() || busy}
              style={[st.btn, { backgroundColor: draftTitle.trim() && !busy ? colors.primary : colors.border }]}>
              {busy ? <ActivityIndicator color="#fff" />
                : <><Ionicons name="checkmark" size={18} color="#fff" /><Text style={st.btnTxt}>{editing ? 'Save' : 'Add note'}</Text></>}
            </TouchableOpacity>
            {!!editing && (
              <Text style={{ color: colors.textFaint, fontSize: 11.5, textAlign: 'center', marginTop: 10 }}>
                Only what you changed is sent, so someone else editing another part keeps their work.
              </Text>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const st = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: { borderWidth: 1, borderRadius: 14, padding: 14, marginBottom: 10 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: { borderTopLeftRadius: 22, borderTopRightRadius: 22, borderTopWidth: 1, padding: 18, paddingBottom: 32 },
  field: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, minHeight: 48 },
  input: { flex: 1, fontSize: 15 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 50, borderRadius: 13, marginTop: 16 },
  btnTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },
});
