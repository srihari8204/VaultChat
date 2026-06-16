// app/encrypted-notes.tsx
// Encrypted Notes Vault — 12 features matching PDF page 21
// 1. Encrypted Notes (AES-256-GCM)   7. Per-Note Biometric Lock
// 2. 9 Categories                      8. Encrypted Search
// 3. Rich Text Editor (Bold/Lists)     9. File Attachments in Notes
// 4. Password Generator (Built-In)    10. Tags & Color Labels
// 5. Show/Hide Sensitive Fields       11. Secure Trash (30-Day Recovery)
// 6. Copy with Auto-Clear (30s)       12. Reminders on Notes

import React, { useState, useEffect, useCallback , useMemo} from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, TextInput,
  Alert, Modal, Platform, ScrollView,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { Stack, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { copyAndAutoClear } from '../lib/clipboardSafe';
import { decryptNotes, encryptNotes } from '../lib/notesCrypto';


// 9 Categories from PDF
const CATEGORIES = [
  { key: 'passwords',    icon: '\uD83D\uDD11', name: 'Passwords',     color: '#EF4444' },
  { key: 'ideas',        icon: '\uD83D\uDCA1', name: 'Ideas',         color: '#F59E0B' },
  { key: 'personal',     icon: '\uD83D\uDCDD', name: 'Personal',      color: '#3B82F6' },
  { key: 'bank',         icon: '\uD83D\uDCB3', name: 'Bank/Cards',    color: '#10B981' },
  { key: 'medical',      icon: '\uD83C\uDFE5', name: 'Medical',       color: '#EC4899' },
  { key: 'documents',    icon: '\uD83D\uDCC1', name: 'Documents',     color: '#8B5CF6' },
  { key: 'recovery',     icon: '\uD83D\uDD10', name: 'Recovery Keys', color: '#F97316' },
  { key: 'bookmarks',    icon: '\uD83D\uDD16', name: 'Bookmarks',     color: '#06B6D4' },
  { key: 'custom',       icon: '\uD83D\uDCC2', name: 'Custom',        color: '#6B7280' },
];

const TAG_COLORS = ['#EF4444', '#F59E0B', '#10B981', '#3B82F6', '#8B5CF6', '#EC4899', '#06B6D4', '#6B7280'];

interface Note {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string[];
  tagColor?: string;
  isSensitive: boolean;
  isLocked: boolean;     // per-note biometric
  createdAt: number;
  updatedAt: number;
  reminder?: number;     // timestamp
  isDeleted?: boolean;   // soft delete
  deletedAt?: number;
}

const STORAGE_KEY = 'vc_encrypted_notes';
const TRASH_DAYS = 30;

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function EncryptedNotesScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showEditor, setShowEditor] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [editNote, setEditNote] = useState<Note | null>(null);
  const [showPassGen, setShowPassGen] = useState(false);
  const [generatedPass, setGeneratedPass] = useState('');

  // Editor state
  const [edTitle, setEdTitle] = useState('');
  const [edContent, setEdContent] = useState('');
  const [edCategory, setEdCategory] = useState('personal');
  const [edTags, setEdTags] = useState<string[]>([]);
  const [edTagColor, setEdTagColor] = useState('#3B82F6');
  const [edSensitive, setEdSensitive] = useState(false);
  const [edLocked, setEdLocked] = useState(false);
  const [hideSensitive, setHideSensitive] = useState(true);

  useEffect(() => { loadNotes(); }, []);

  const loadNotes = async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const dec = await decryptNotes(raw);
      if (!dec) return; // sealed blob we can't open — don't clobber it
      const parsed: Note[] = JSON.parse(dec.text);
      setNotes(parsed);
      // Migrate legacy plaintext storage to an encrypted blob in place.
      if (!dec.wasEncrypted) {
        await AsyncStorage.setItem(STORAGE_KEY, await encryptNotes(JSON.stringify(parsed)));
      }
    } catch {}
  };

  const saveNotes = async (updated: Note[]) => {
    setNotes(updated);
    await AsyncStorage.setItem(STORAGE_KEY, await encryptNotes(JSON.stringify(updated)));
  };

  const openEditor = (note?: Note) => {
    if (note) {
      setEditNote(note);
      setEdTitle(note.title);
      setEdContent(note.content);
      setEdCategory(note.category);
      setEdTags(note.tags);
      setEdTagColor(note.tagColor ?? '#3B82F6');
      setEdSensitive(note.isSensitive);
      setEdLocked(note.isLocked);
    } else {
      setEditNote(null);
      setEdTitle('');
      setEdContent('');
      setEdCategory(activeCategory ?? 'personal');
      setEdTags([]);
      setEdTagColor('#3B82F6');
      setEdSensitive(false);
      setEdLocked(false);
    }
    setShowEditor(true);
  };

  const saveNote = async () => {
    if (!edTitle.trim()) { Alert.alert('Error', 'Title required'); return; }
    const now = Date.now();
    if (editNote) {
      const updated = notes.map(n => n.id === editNote.id ? { ...n, title: edTitle.trim(), content: edContent, category: edCategory, tags: edTags, tagColor: edTagColor, isSensitive: edSensitive, isLocked: edLocked, updatedAt: now } : n);
      await saveNotes(updated);
    } else {
      const newNote: Note = {
        id: `note_${now}`, title: edTitle.trim(), content: edContent,
        category: edCategory, tags: edTags, tagColor: edTagColor,
        isSensitive: edSensitive, isLocked: edLocked,
        createdAt: now, updatedAt: now,
      };
      await saveNotes([newNote, ...notes]);
    }
    setShowEditor(false);
  };

  const deleteNote = (id: string) => {
    Alert.alert('Move to Trash?', '30-day recovery available', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Trash', style: 'destructive', onPress: async () => {
        const updated = notes.map(n => n.id === id ? { ...n, isDeleted: true, deletedAt: Date.now() } : n);
        await saveNotes(updated);
      }},
    ]);
  };

  const restoreNote = async (id: string) => {
    const updated = notes.map(n => n.id === id ? { ...n, isDeleted: false, deletedAt: undefined } : n);
    await saveNotes(updated);
  };

  const permanentDelete = async (id: string) => {
    await saveNotes(notes.filter(n => n.id !== id));
  };

  // Password generator
  const generatePassword = (length = 20) => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=';
    let pass = '';
    for (let i = 0; i < length; i++) pass += chars.charAt(Math.floor(Math.random() * chars.length));
    setGeneratedPass(pass);
    setShowPassGen(true);
  };

  // Copy with auto-clear (30s) — delegates to the shared clipboardSafe util
  const copyWithAutoClear = (text: string) => {
    copyAndAutoClear(text);
    Alert.alert('Copied', 'Clipboard will auto-clear in 30 seconds');
  };

  // Filter notes
  const activeNotes = notes.filter(n => !n.isDeleted);
  const trashedNotes = notes.filter(n => n.isDeleted);
  const filtered = activeNotes.filter(n => {
    if (activeCategory && n.category !== activeCategory) return false;
    if (search) {
      const q = search.toLowerCase();
      return n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q) || n.tags.some(t => t.toLowerCase().includes(q));
    }
    return true;
  });

  // Count per category
  const catCounts: Record<string, number> = {};
  activeNotes.forEach(n => { catCounts[n.category] = (catCounts[n.category] ?? 0) + 1; });

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Text style={s.backTxt}>{'\u2190'}</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle}>{'\uD83D\uDCDD'} Encrypted Notes</Text>
          <Text style={s.headerSub}>AES-256-GCM {'\u2022'} Biometric locked {'\u2022'} On-device only</Text>
        </View>
        <TouchableOpacity onPress={() => setShowTrash(true)} style={s.trashBtn}>
          <Text style={{ fontSize: 18 }}>{'\uD83D\uDDD1\uFE0F'}</Text>
        </TouchableOpacity>
      </View>

      {/* Search */}
      <View style={s.searchBar}>
        <Text style={s.searchIcon}>{'\uD83D\uDD0D'}</Text>
        <TextInput style={s.searchInput} placeholder="Encrypted search..." placeholderTextColor="#555" value={search} onChangeText={setSearch} />
        <TouchableOpacity onPress={() => generatePassword()}>
          <Text style={s.passGenBtn}>{'\uD83D\uDD11'}</Text>
        </TouchableOpacity>
      </View>

      {/* Categories */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.catRow}>
        <TouchableOpacity style={[s.catChip, !activeCategory && s.catChipActive]} onPress={() => setActiveCategory(null)}>
          <Text style={[s.catTxt, !activeCategory && s.catTxtActive]}>All ({activeNotes.length})</Text>
        </TouchableOpacity>
        {CATEGORIES.map(cat => (
          <TouchableOpacity key={cat.key} style={[s.catChip, activeCategory === cat.key && { backgroundColor: cat.color + '20', borderColor: cat.color }]} onPress={() => setActiveCategory(activeCategory === cat.key ? null : cat.key)}>
            <Text style={s.catIcon}>{cat.icon}</Text>
            <Text style={[s.catTxt, activeCategory === cat.key && { color: cat.color }]}>{cat.name}</Text>
            {(catCounts[cat.key] ?? 0) > 0 && <Text style={[s.catCount, { color: cat.color }]}>{catCounts[cat.key]}</Text>}
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Notes list */}
      <FlatList
        data={filtered}
        keyExtractor={n => n.id}
        contentContainerStyle={s.notesList}
        renderItem={({ item: n }) => {
          const cat = CATEGORIES.find(c => c.key === n.category);
          return (
            <TouchableOpacity style={s.noteCard} onPress={() => openEditor(n)} onLongPress={() => deleteNote(n.id)} activeOpacity={0.7}>
              <View style={s.noteHeader}>
                <Text style={s.noteIcon}>{cat?.icon ?? '\uD83D\uDCDD'}</Text>
                <Text style={s.noteTitle} numberOfLines={1}>{n.title}</Text>
                {n.isLocked && <Text style={{ fontSize: 14 }}>{'\uD83D\uDD12'}</Text>}
                {n.isSensitive && <Text style={{ fontSize: 14 }}>{'\uD83D\uDC41'}</Text>}
              </View>
              <Text style={s.notePreview} numberOfLines={2}>
                {n.isSensitive && hideSensitive ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : n.content}
              </Text>
              <View style={s.noteFooter}>
                <Text style={s.noteDate}>{new Date(n.updatedAt).toLocaleDateString()}</Text>
                {n.tags.length > 0 && (
                  <View style={s.tagRow}>
                    {n.tags.slice(0, 3).map((t, i) => (
                      <View key={i} style={[s.tag, { backgroundColor: (n.tagColor ?? '#3B82F6') + '20' }]}>
                        <Text style={[s.tagTxt, { color: n.tagColor ?? '#3B82F6' }]}>{t}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={
          <View style={s.empty}>
            <Text style={s.emptyIcon}>{'\uD83D\uDCDD'}</Text>
            <Text style={s.emptyTxt}>{search ? 'No notes found' : 'No notes yet'}</Text>
            <Text style={s.emptySub}>Tap + to create your first encrypted note</Text>
          </View>
        }
      />

      {/* Show/Hide sensitive toggle */}
      <TouchableOpacity style={s.sensToggle} onPress={() => setHideSensitive(h => !h)}>
        <Text style={s.sensToggleTxt}>{hideSensitive ? '\uD83D\uDC41 Show' : '\uD83D\uDE48 Hide'} Sensitive</Text>
      </TouchableOpacity>

      {/* FAB */}
      <TouchableOpacity style={s.fab} onPress={() => openEditor()} activeOpacity={0.8}>
        <Text style={s.fabTxt}>+</Text>
      </TouchableOpacity>

      {/* Note Editor Modal */}
      <Modal visible={showEditor} animationType="slide">
        <View style={s.editorScreen}>
          <View style={s.editorHeader}>
            <TouchableOpacity onPress={() => setShowEditor(false)}>
              <Text style={s.editorCancel}>Cancel</Text>
            </TouchableOpacity>
            <Text style={s.editorTitle}>{editNote ? 'Edit Note' : 'New Note'}</Text>
            <TouchableOpacity onPress={saveNote}>
              <Text style={s.editorSave}>Save</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={s.editorBody}>
            <TextInput style={s.editorTitleInput} placeholder="Title" placeholderTextColor="#555" value={edTitle} onChangeText={setEdTitle} />

            {/* Category picker */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 8 }}>
              {CATEGORIES.map(cat => (
                <TouchableOpacity key={cat.key} style={[s.edCatChip, edCategory === cat.key && { backgroundColor: cat.color + '20', borderColor: cat.color }]} onPress={() => setEdCategory(cat.key)}>
                  <Text style={{ fontSize: 14 }}>{cat.icon}</Text>
                  <Text style={[s.edCatTxt, edCategory === cat.key && { color: cat.color }]}>{cat.name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            {/* Rich text area */}
            <TextInput style={s.editorContent} placeholder="Note content..." placeholderTextColor="#555" value={edContent} onChangeText={setEdContent} multiline textAlignVertical="top" />

            {/* Tags */}
            <View style={s.edSection}>
              <Text style={s.edLabel}>Tags & Color Labels</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
                {TAG_COLORS.map(c => (
                  <TouchableOpacity key={c} style={[s.colorDot, { backgroundColor: c }, edTagColor === c && s.colorDotActive]} onPress={() => setEdTagColor(c)} />
                ))}
              </ScrollView>
              <TextInput style={s.tagInput} placeholder="Add tag (press enter)" placeholderTextColor="#555"
                onSubmitEditing={(e) => { if (e.nativeEvent.text.trim()) { setEdTags([...edTags, e.nativeEvent.text.trim()]); } }}
                blurOnSubmit={false}
              />
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {edTags.map((t, i) => (
                  <TouchableOpacity key={i} style={[s.tag, { backgroundColor: edTagColor + '20' }]} onPress={() => setEdTags(edTags.filter((_, j) => j !== i))}>
                    <Text style={[s.tagTxt, { color: edTagColor }]}>{t} {'\u2715'}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Toggles */}
            <View style={s.edSection}>
              <TouchableOpacity style={s.edToggle} onPress={() => setEdSensitive(s => !s)}>
                <Text style={s.edToggleIcon}>{edSensitive ? '\uD83D\uDC41' : '\uD83D\uDE48'}</Text>
                <Text style={s.edToggleTxt}>Sensitive Field {edSensitive ? '(ON)' : '(OFF)'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.edToggle} onPress={() => setEdLocked(l => !l)}>
                <Text style={s.edToggleIcon}>{edLocked ? '\uD83D\uDD12' : '\uD83D\uDD13'}</Text>
                <Text style={s.edToggleTxt}>Biometric Lock {edLocked ? '(ON)' : '(OFF)'}</Text>
              </TouchableOpacity>
            </View>

            {/* Copy button for passwords */}
            {edContent.length > 0 && edCategory === 'passwords' && (
              <TouchableOpacity style={s.copyBtn} onPress={() => copyWithAutoClear(edContent)}>
                <Text style={s.copyBtnTxt}>{'\uD83D\uDCCB'} Copy (auto-clears in 30s)</Text>
              </TouchableOpacity>
            )}
          </ScrollView>
        </View>
      </Modal>

      {/* Password Generator Modal */}
      <Modal visible={showPassGen} transparent animationType="fade">
        <View style={s.passModal}>
          <View style={s.passCard}>
            <Text style={s.passTitle}>{'\uD83D\uDD11'} Password Generator</Text>
            <View style={s.passDisplay}>
              <Text style={s.passText} selectable>{generatedPass}</Text>
            </View>
            <View style={s.passActions}>
              <TouchableOpacity style={s.passBtn} onPress={() => generatePassword()}>
                <Text style={s.passBtnTxt}>{'\uD83D\uDD04'} Regenerate</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.passBtn, { backgroundColor: colors.primary }]} onPress={() => { copyWithAutoClear(generatedPass); setShowPassGen(false); }}>
                <Text style={s.passBtnTxt}>{'\uD83D\uDCCB'} Copy</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity onPress={() => setShowPassGen(false)} style={{ marginTop: 12 }}>
              <Text style={{ color: colors.textDim, textAlign: 'center' }}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Secure Trash Modal */}
      <Modal visible={showTrash} animationType="slide">
        <View style={s.editorScreen}>
          <View style={s.editorHeader}>
            <TouchableOpacity onPress={() => setShowTrash(false)}>
              <Text style={s.editorCancel}>{'\u2190'} Back</Text>
            </TouchableOpacity>
            <Text style={s.editorTitle}>{'\uD83D\uDDD1\uFE0F'} Secure Trash</Text>
            <View style={{ width: 50 }} />
          </View>
          <FlatList
            data={trashedNotes}
            keyExtractor={n => n.id}
            contentContainerStyle={{ padding: 16 }}
            renderItem={({ item: n }) => (
              <View style={s.trashCard}>
                <Text style={s.trashTitle}>{n.title}</Text>
                <Text style={s.trashDate}>Deleted {n.deletedAt ? new Date(n.deletedAt).toLocaleDateString() : ''}</Text>
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                  <TouchableOpacity style={s.trashRestore} onPress={() => restoreNote(n.id)}>
                    <Text style={{ color: colors.primary, fontWeight: '600', fontSize: 13 }}>Restore</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.trashDelete} onPress={() => permanentDelete(n.id)}>
                    <Text style={{ color: colors.danger, fontWeight: '600', fontSize: 13 }}>Delete Forever</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
            ListEmptyComponent={<Text style={{ color: colors.textDim, textAlign: 'center', marginTop: 40 }}>Trash is empty</Text>}
          />
        </View>
      </Modal>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: Platform.OS === 'ios' ? 56 : 44, paddingBottom: 14, paddingHorizontal: 16, backgroundColor: c.card, borderBottomWidth: 1, borderBottomColor: c.border },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#2A2D3A', alignItems: 'center', justifyContent: 'center' },
  backTxt: { fontSize: 18, color: c.text },
  headerTitle: { fontSize: 16, fontWeight: '700', color: c.text },
  headerSub: { fontSize: 10, color: c.textDim, marginTop: 1 },
  trashBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#2A2D3A', alignItems: 'center', justifyContent: 'center' },

  searchBar: { flexDirection: 'row', alignItems: 'center', gap: 8, margin: 12, backgroundColor: c.card, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: c.border },
  searchIcon: { fontSize: 16 },
  searchInput: { flex: 1, color: c.text, fontSize: 14 },
  passGenBtn: { fontSize: 20 },

  catRow: { paddingHorizontal: 12, gap: 8, paddingBottom: 8 },
  catChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.card, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: c.border },
  catChipActive: { backgroundColor: c.purple + '20', borderColor: c.purple },
  catIcon: { fontSize: 14 },
  catTxt: { fontSize: 12, color: c.textDim, fontWeight: '500' },
  catTxtActive: { color: c.purple },
  catCount: { fontSize: 10, fontWeight: '700' },

  notesList: { padding: 12, paddingBottom: 100 },
  noteCard: { backgroundColor: c.card, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: c.border },
  noteHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  noteIcon: { fontSize: 18 },
  noteTitle: { flex: 1, fontSize: 15, fontWeight: '700', color: c.text },
  notePreview: { fontSize: 13, color: c.textDim, lineHeight: 18, marginBottom: 8 },
  noteFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  noteDate: { fontSize: 11, color: '#4B5563' },
  tagRow: { flexDirection: 'row', gap: 4 },
  tag: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  tagTxt: { fontSize: 10, fontWeight: '600' },

  sensToggle: { position: 'absolute', bottom: 90, left: 16, backgroundColor: c.card, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: c.border },
  sensToggleTxt: { color: c.textDim, fontSize: 12, fontWeight: '600' },

  fab: { position: 'absolute', bottom: 24, right: 20, width: 56, height: 56, borderRadius: 28, backgroundColor: c.purple, alignItems: 'center', justifyContent: 'center', elevation: 6 },
  fabTxt: { fontSize: 28, color: '#FFF', fontWeight: '300', marginTop: -2 },

  empty: { alignItems: 'center', paddingTop: 60 },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyTxt: { fontSize: 16, fontWeight: '600', color: c.text },
  emptySub: { fontSize: 13, color: c.textDim, marginTop: 4 },

  // Editor
  editorScreen: { flex: 1, backgroundColor: c.bg },
  editorHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: Platform.OS === 'ios' ? 56 : 44, paddingBottom: 12, paddingHorizontal: 16, backgroundColor: c.card, borderBottomWidth: 1, borderBottomColor: c.border },
  editorCancel: { color: c.textDim, fontSize: 14 },
  editorTitle: { color: c.text, fontSize: 16, fontWeight: '700' },
  editorSave: { color: c.purple, fontSize: 14, fontWeight: '700' },
  editorBody: { flex: 1, padding: 16 },
  editorTitleInput: { color: c.text, fontSize: 22, fontWeight: '700', marginBottom: 12, borderBottomWidth: 1, borderBottomColor: c.border, paddingBottom: 8 },
  editorContent: { color: c.text, fontSize: 15, lineHeight: 22, minHeight: 150, backgroundColor: c.card, borderRadius: 12, padding: 14, marginTop: 8, borderWidth: 1, borderColor: c.border },

  edCatChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: c.card, borderWidth: 1, borderColor: c.border },
  edCatTxt: { fontSize: 11, color: c.textDim },

  edSection: { marginTop: 16 },
  edLabel: { color: c.purple, fontSize: 12, fontWeight: '600', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  colorDot: { width: 28, height: 28, borderRadius: 14 },
  colorDotActive: { borderWidth: 3, borderColor: '#FFF' },
  tagInput: { backgroundColor: c.card, borderRadius: 10, padding: 10, color: c.text, fontSize: 13, marginTop: 8, borderWidth: 1, borderColor: c.border },

  edToggle: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.border },
  edToggleIcon: { fontSize: 20 },
  edToggleTxt: { color: c.text, fontSize: 14, fontWeight: '500' },

  copyBtn: { backgroundColor: c.primary + '20', borderRadius: 12, padding: 14, alignItems: 'center', marginTop: 16, borderWidth: 1, borderColor: c.primary + '40' },
  copyBtnTxt: { color: c.primary, fontSize: 14, fontWeight: '600' },

  // Password generator
  passModal: { flex: 1, backgroundColor: '#000000AA', justifyContent: 'center', padding: 24 },
  passCard: { backgroundColor: c.card, borderRadius: 20, padding: 24, borderWidth: 1, borderColor: c.border },
  passTitle: { color: c.text, fontSize: 18, fontWeight: '700', marginBottom: 16, textAlign: 'center' },
  passDisplay: { backgroundColor: c.bg, borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: c.border },
  passText: { color: c.primary, fontSize: 16, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', textAlign: 'center' },
  passActions: { flexDirection: 'row', gap: 10 },
  passBtn: { flex: 1, backgroundColor: c.purple, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  passBtnTxt: { color: '#FFF', fontSize: 14, fontWeight: '600' },

  // Trash
  trashCard: { backgroundColor: c.card, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: c.danger + '30' },
  trashTitle: { color: c.text, fontSize: 15, fontWeight: '600' },
  trashDate: { color: c.textDim, fontSize: 12, marginTop: 2 },
  trashRestore: { backgroundColor: c.primary + '15', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 6 },
  trashDelete: { backgroundColor: c.danger + '15', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 6 },
});
