// app/encrypted-notes.tsx
// Encrypted Notes Vault — 13 features (12 from PDF page 21, plus backup).
// 1. Encrypted Notes (AES-256-GCM)   7. Per-Note PIN Lock
// 2. 9 Categories                      8. Encrypted Search
// 3. Rich Text Editor (Bold/Lists)     9. File Attachments in Notes
// 4. Password Generator (Built-In)    10. Tags & Color Labels
// 5. Show/Hide Sensitive Fields       11. Secure Trash (30-Day Recovery)
// 6. Copy with Auto-Clear (30s)       12. Reminders on Notes
//                                     13. E2EE Backup & Restore (lib/notesVault)
//
// THREE OF THESE USED TO BE DECORATION. #7 stored `isLocked`, drew a padlock and
// gated nothing — a "locked" note opened on a plain tap. #12 declared
// `reminder?: number` that no code ever read. #11 declared TRASH_DAYS = 30 that
// no code ever read, so trashed notes and their encrypted attachments lived
// forever. Each is wired now; see the comment at each site for what was wrong.
//
// Round 4 split: the model, styles, editor, backup and the smaller modals live
// in components/notes/. This file keeps the state, the gate and the list.

import { Ionicons } from '@expo/vector-icons';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, TouchableOpacity, FlatList, TextInput, Alert, ScrollView, AppState } from 'react-native';
import { AppText as Text } from '../components/ui/Text';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import {
  addAttachment, deleteAttachment, isImage, openAttachment, type NoteAttachment,
} from '../lib/notesAttachments';
import { useTheme } from '../lib/theme';
import { Stack, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { copyAndAutoClear } from '../lib/clipboardSafe';
import { clearNotesKeyCache, decryptNotes, encryptNotes, hasDEK } from '../lib/notesCrypto';
import { armNoteReminder, cancelNoteReminder } from '../lib/notesReminders';
import { purgeExpired } from '../lib/notesVault';
import { holdAppSwitcherBlur } from '../lib/screenGuard';

// The same PIN check hidden-chats uses: the server-verified sign-in MPIN.
// services/security/pinStore is a LOCAL store that is empty on installs which
// never set a local PIN — gating on it fell open on a real device.
import { verifyPin } from '../lib/chatService';
import 'react-native-get-random-values';
import { randomBytes } from '@noble/hashes/utils.js';
import { permissionDenied } from '../lib/permissionDenied';
import {
  CATEGORIES, DEFAULT_TAG_COLOR, DRAFT_KEY, STORAGE_KEY, TRASH_DAYS,
  emptyFields, fieldsOf, openDraft, pinCheckError, sealDraft, snapshotOf,
  type Draft, type EditorFields, type Note,
} from '../components/notes/notesModel';
import { useNotesStyles } from '../components/notes/notesStyles';
import { useNoteEditor } from '../components/notes/useNoteEditor';
import { NoteEditorModal } from '../components/notes/NoteEditorModal';
import { NotesBackupModal } from '../components/notes/NotesBackupModal';
import {
  ImageViewerModal, LockChallengeModal, NotesPinGate, PasswordGeneratorModal, TrashModal,
} from '../components/notes/NotesModals';

export default function EncryptedNotesScreen() {
  const { colors } = useTheme();
  const s = useNotesStyles();
  const router = useRouter();
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showEditor, setShowEditor] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [editNote, setEditNote] = useState<Note | null>(null);
  const [showPassGen, setShowPassGen] = useState(false);
  const [generatedPass, setGeneratedPass] = useState('');

  // The header promises "Biometric locked", but nothing enforced it: deep-linking
  // to vaultchat://encrypted-notes from a cold start rendered every note title
  // with no challenge at all (vault / hidden-chats both gate correctly).
  // Starting at 'pin' blocks the first paint, so titles never flash unlocked.
  //
  // PIN only, matching hidden-chats — the same server-verified MPIN check.
  //
  // A biometric variant was tried first and dropped after it appeared to ANR
  // the app on a cold deep-link. That diagnosis turned out to be WRONG: the
  // same ANR reproduces on `search` and `shelf`, which have no biometric and
  // no gate, whenever adb injects input into a cold-deep-linked screen. So the
  // biometric was not the cause and could be reinstated — it is simply not
  // needed, since the PIN alone satisfies the screen's "locked" promise.
  const [gate, setGate] = useState<'pin' | 'open'>('pin');
  const [pinTry, setPinTry] = useState('');
  const [pinErr, setPinErr] = useState<string | null>(null);

  // Per-note lock (feature #7). `isLocked` was stored, toggled and badged, but
  // NOTHING ever read it to gate anything: a "locked" note opened on a plain
  // tap like any other, and its preview text sat in the list unmasked. The
  // padlock was decoration. A note held here is not opened until its own PIN
  // challenge passes.
  const [pendingLock, setPendingLock] = useState<Note | null>(null);
  const [lockTry, setLockTry] = useState('');
  const [lockErr, setLockErr] = useState<string | null>(null);

  // Editor state (components/notes/useNoteEditor).
  const ed = useNoteEditor();
  const [hideSensitive, setHideSensitive] = useState(true);
  const [attaching, setAttaching] = useState(false);
  const [viewerImg, setViewerImg] = useState<string | null>(null);
  const [showBackup, setShowBackup] = useState(false);

  // Re-lock on background. clearNotesKeyCache() existed and was called from
  // nowhere, so once the screen had been unlocked the DEK stayed in memory for
  // the life of the process — the vault never actually re-locked, it only
  // re-prompted. Dropping the key and the gate together makes the prompt real.
  //
  // 2026-10-04: the notes themselves now go too. They used to stay decrypted in
  // memory behind the gate, so "locked" only hid them. An open editor's draft is
  // sealed under the notes key first and offered back after the next unlock.
  // A system picker or share sheet this screen opened also backgrounds the app
  // (Android runs it as another activity): those are bracketed by `systemUi`
  // and do not re-lock, or attaching a photo would lock the vault every time.
  // ponytail: the bracket is our own counter, not an OS signal; leaving the app
  // from inside a picker keeps it unlocked until the picker returns. Needs a
  // device check.
  //
  // Round 4: only 'background' re-locks. iOS also reports 'inactive' for
  // Control Center, the notification shade and the app switcher, and locking
  // on that closed the editor and every modal mid-edit. What 'inactive' could
  // expose — the screen in the switcher, or behind Control Center — is
  // blurred instead while the notes are open (holdAppSwitcherBlur, below).
  const systemUi = useRef(0);
  const withSystemUi = async <T,>(fn: () => Promise<T>): Promise<T> => {
    systemUi.current++;
    try { return await fn(); } finally { systemUi.current--; }
  };
  // The unsaved draft, and the attachments it added that no saved note
  // references (so a draft that cannot be sealed does not orphan them).
  const draftRef = useRef<{ draft: Draft; added: string[] } | null>(null);
  const loadSeq = useRef(0);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'background' || systemUi.current > 0) return;
      const d = draftRef.current;
      draftRef.current = null;
      // Seal first (the key is still cached), then drop the key. If the seal
      // fails the draft is gone, so the files only it pointed at go too.
      (d ? sealDraft(d.draft).then((b) => AsyncStorage.setItem(DRAFT_KEY, b)) : Promise.resolve())
        .catch(() => { d?.added.forEach((id) => { deleteAttachment(id).catch(() => {}); }); })
        .finally(() => clearNotesKeyCache());
      loadSeq.current++;            // a load still in flight must not repaint
      loadOk.current = false;
      setNotes([]);
      setLoadState('loading');
      setGate('pin');
      setShowEditor(false);
      setShowTrash(false);
      setShowBackup(false);
      setShowPassGen(false);
      setGeneratedPass('');
      setPendingLock(null);
      setViewerImg(null);
    });
    return () => sub.remove();
  }, []);

  // iOS: blur the switcher snapshot and the inactive screen while open.
  useEffect(() => (gate === 'open' ? holdAppSwitcherBlur() : undefined), [gate]);

  // No focus effect and no TextInput: this gate uses an in-app keypad, so
  // there is no soft keyboard to raise and nothing for the OS to refuse.

  // Takes the PIN as an argument: PinPad fires onComplete with the final digit
  // included, which the `pinTry` state does not hold yet on that same tick.
  const submitPin = useCallback(async (pin?: string) => {
    const v = pin ?? pinTry;
    if (!/^\d{4,8}$/.test(v)) { setPinErr('PIN must be 4–8 digits'); return; }
    try {
      if (await verifyPin(v)) { setGate('open'); setPinTry(''); setPinErr(null); }
      else { setPinTry(''); setPinErr('Incorrect PIN'); }
    } catch (e) {
      // Server unreachable — stay locked rather than open on a network error.
      setPinTry(''); setPinErr(pinCheckError(e));
    }
  }, [pinTry]);

  // WRITES ARE BLOCKED UNTIL THE STORE HAS BEEN READ (2026-10-04).
  //
  // loadNotes used to swallow every failure and leave notes = [], and the next
  // save then sealed that empty-plus-one list over the blob it could not read —
  // a missing key or a transient read error became the loss of every note.
  // Every write goes through saveNotes, which now refuses unless the load
  // actually succeeded (or there was nothing stored yet).
  const [loadState, setLoadState] = useState<'loading' | 'ok' | 'failed'>('loading');
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const loadOk = useRef(false);
  const markLoad = (ok: boolean, problem: string | null = null) => {
    loadOk.current = ok;
    setLoadState(ok ? 'ok' : 'failed');
    setLoadProblem(problem);
  };

  const loadNotes = async () => {
    const seq = ++loadSeq.current;
    const stale = () => seq !== loadSeq.current;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (stale()) return;
      if (!raw) { setNotes([]); markLoad(true); await offerDraft([]); return; }
      const dec = await decryptNotes(raw);
      if (stale()) return;
      if (!dec) {
        // Sealed blob we can't open — don't clobber it, and say why.
        markLoad(false, (await hasDEK())
          ? 'Your notes could not be decrypted on this device.'
          : 'The key for your notes is missing on this device.');
        return;
      }
      const parsed: Note[] = JSON.parse(dec.text);
      if (!Array.isArray(parsed)) throw new Error('not a notes list');

      // Honour the 30 days the trash promises. TRASH_DAYS was declared and
      // never read, so "30-Day Recovery" recovered forever: trashed notes and
      // their encrypted attachments stayed on disk for the life of the install.
      const { kept, purgedAttachmentIds } = purgeExpired(parsed, Date.now(), TRASH_DAYS);
      const expired = parsed.length - kept.length;
      if (expired > 0) {
        await Promise.all(purgedAttachmentIds.map(id => deleteAttachment(id)));
        await Promise.all(
          parsed.filter(n => !kept.includes(n)).map(n => cancelNoteReminder(n.id)),
        );
      }
      if (stale()) return;
      setNotes(kept);
      markLoad(true);
      await offerDraft(kept);

      // Re-arm alarms for anything still in the future. Alarms are OS-level and
      // notes are not: a restore (or a reinstall) brings back a note carrying a
      // `reminder` timestamp with nothing behind it, and the reminder would
      // simply never fire. armNoteReminder cancels before it schedules, so
      // re-arming an alarm that already exists is a no-op.
      // ponytail: runs on every screen open; fine for a handful of reminders,
      // move to a one-shot on restore if a vault ever carries hundreds.
      for (const n of kept) {
        if (n.reminder && !n.isDeleted && n.reminder > Date.now()) {
          await armNoteReminder(n.id, n.reminder, n.title, n.isSensitive, n.isLocked);
        }
      }

      // Re-seal when the blob was legacy plaintext, or when the purge changed it.
      if (!dec.wasEncrypted || expired > 0) {
        await AsyncStorage.setItem(STORAGE_KEY, await encryptNotes(JSON.stringify(kept)));
      }
    } catch {
      // Read/parse failure before the notes were in hand: block writes. A
      // failure AFTER they loaded (re-arming, re-sealing) leaves them usable.
      if (!loadOk.current) markLoad(false, 'Your notes could not be read.');
    }
  };
  const loadNotesRef = useRef(loadNotes);
  loadNotesRef.current = loadNotes;

  // Nothing is read or decrypted until the PIN gate has opened.
  useEffect(() => { if (gate === 'open') loadNotesRef.current(); }, [gate]);

  // What the editor opened with, to tell whether Cancel would discard anything.
  const edInitial = useRef('');
  const openWith = (note: Note | null, f: EditorFields, initial: string) => {
    setEditNote(note);
    ed.load(f);
    edInitial.current = initial;
    setShowEditor(true);
  };

  /** Reopen an unsaved draft sealed when the app last went to the background. */
  const offerDraft = async (list: Note[]) => {
    const raw = await AsyncStorage.getItem(DRAFT_KEY).catch(() => null);
    if (!raw) return;
    await AsyncStorage.removeItem(DRAFT_KEY).catch(() => {});
    const d = await openDraft(raw);
    if (!d) return;
    const base = d.editId ? list.find(n => n.id === d.editId) ?? null : null;
    openWith(base, d, '');   // a restored draft is unsaved by definition
    Alert.alert('Unsaved note restored', 'You left the app while editing. Your changes were kept — save them or cancel to discard.');
  };

  /** Seal and store. Returns false (and says why) when writing would overwrite
   *  a store this screen could not read. Throws on a storage error. */
  const saveNotes = async (updated: Note[]): Promise<boolean> => {
    if (!loadOk.current) {
      Alert.alert(
        'Not saved',
        'Your existing notes could not be opened, so saving is turned off to avoid overwriting them. Open Backup to recover the key, or try again later.',
      );
      return false;
    }
    await AsyncStorage.setItem(STORAGE_KEY, await encryptNotes(JSON.stringify(updated)));
    setNotes(updated);
    return true;
  };

  const openEditor = (note?: Note, unlocked = false) => {
    // No editing (and so no attaching, which would mint a stand-in key) until
    // the stored notes have opened — see saveNotes.
    if (!loadOk.current) {
      Alert.alert('Notes not open', 'Your existing notes could not be opened, so editing is turned off to avoid overwriting them. Open Backup to recover the key.');
      return;
    }
    // A locked note goes to the challenge instead of the editor. Without this
    // the padlock badge promised a protection that did not exist.
    if (note?.isLocked && !unlocked) {
      setLockTry(''); setLockErr(null); setPendingLock(note);
      return;
    }
    const f = note ? fieldsOf(note) : emptyFields(activeCategory ?? 'personal');
    openWith(note ?? null, f, snapshotOf(f));
  };

  // Challenge a locked note before anything of it is rendered. Same
  // server-verified MPIN as the screen gate — one PIN, not a second secret to
  // remember for the same vault.
  const submitLockPin = async (pin?: string) => {
    const note = pendingLock;
    if (!note) return;
    const v = pin ?? lockTry;
    if (!/^\d{4,8}$/.test(v)) { setLockErr('PIN must be 4–8 digits'); return; }
    try {
      if (await verifyPin(v)) {
        setPendingLock(null); setLockTry(''); setLockErr(null);
        openEditor(note, true);
      } else { setLockTry(''); setLockErr('Incorrect PIN'); }
    } catch (e) {
      setLockTry(''); setLockErr(pinCheckError(e));
    }
  };

  const f = ed.fields;
  const edDirty = showEditor && snapshotOf(f) !== edInitial.current;
  const savedAttIds = new Set((editNote?.attachments ?? []).map(a => a.id));
  draftRef.current = showEditor && edDirty ? {
    draft: { editId: editNote?.id ?? null, ...f },
    added: f.attachments.filter(a => !savedAttIds.has(a.id)).map(a => a.id),
  } : null;

  // ── Attachments (encrypted via lib/notesAttachments) ──────────────────────
  const attachImage = async () => {
    const perm = await withSystemUi(() => ImagePicker.requestMediaLibraryPermissionsAsync());
    if (!perm.granted) { permissionDenied('Permission needed', 'Allow photo access to attach an image.', perm.canAskAgain); return; }
    const res = await withSystemUi(() => ImagePicker.launchImageLibraryAsync({ quality: 0.9 }));
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    setAttaching(true);
    try {
      const att = await addAttachment(a.uri, a.fileName ?? `image_${Date.now()}.jpg`, a.mimeType ?? 'image/jpeg');
      ed.setAttachments(prev => [...prev, att]);
    } catch (e: any) {
      Alert.alert('Could not attach', e?.message ?? 'Try again');
    } finally { setAttaching(false); }
  };

  const attachFile = async () => {
    const res = await withSystemUi(() => DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true }));
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    setAttaching(true);
    try {
      const att = await addAttachment(a.uri, a.name, a.mimeType ?? 'application/octet-stream');
      ed.setAttachments(prev => [...prev, att]);
    } catch (e: any) {
      Alert.alert('Could not attach', e?.message ?? 'Try again');
    } finally { setAttaching(false); }
  };

  const addAttachmentMenu = () => {
    if (!loadOk.current) return;
    Alert.alert('Add attachment', 'Encrypted with your notes key before it touches disk.', [
      { text: 'Photo / Image', onPress: attachImage },
      { text: 'File', onPress: attachFile },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  // Cancel: attachments added to this draft are referenced by nothing, so
  // their encrypted files go; the saved note keeps exactly what it had.
  const discardEditor = () => {
    f.attachments.filter(a => !savedAttIds.has(a.id)).forEach(a => { deleteAttachment(a.id).catch(() => {}); });
    setShowEditor(false);
  };
  // Unsaved edits are only thrown away after a confirmation.
  const cancelEditor = () => {
    if (!edDirty) { discardEditor(); return; }
    Alert.alert('Discard changes?', 'Your edits to this note have not been saved.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: discardEditor },
    ]);
  };

  const openAttachmentFile = async (att: NoteAttachment) => {
    try {
      const uri = await openAttachment(att);
      if (!uri) { Alert.alert('Could not open', 'This attachment is unavailable or corrupted.'); return; }
      if (isImage(att)) { setViewerImg(uri); return; }
      if (await Sharing.isAvailableAsync()) await withSystemUi(() => Sharing.shareAsync(uri, { mimeType: att.mime, dialogTitle: att.name }));
      else Alert.alert('Saved', 'Opened a decrypted copy.');
    } catch (e: any) {
      Alert.alert('Could not open', e?.message ?? 'This attachment could not be opened. Try again.');
    }
  };

  const savingNote = useRef(false);
  const saveNote = async () => {
    if (!f.title.trim()) { Alert.alert('Error', 'Title required'); return; }
    if (savingNote.current) return;
    savingNote.current = true;
    try {
      const now = Date.now();
      const id = editNote ? editNote.id : `note_${now}`;
      let saved: boolean;
      if (editNote) {
        const updated = notes.map(n => n.id === editNote.id ? { ...n, title: f.title.trim(), content: f.content, category: f.category, tags: f.tags, tagColor: f.tagColor, isSensitive: f.sensitive, isLocked: f.locked, attachments: f.attachments, reminder: f.reminder, updatedAt: now } : n);
        saved = await saveNotes(updated);
      } else {
        const newNote: Note = {
          id, title: f.title.trim(), content: f.content,
          category: f.category, tags: f.tags, tagColor: f.tagColor,
          isSensitive: f.sensitive, isLocked: f.locked, attachments: f.attachments,
          reminder: f.reminder, createdAt: now, updatedAt: now,
        };
        saved = await saveNotes([newNote, ...notes]);
      }
      if (!saved) return;   // editor stays open; nothing was written
      // Now that the note no longer references them, drop removed attachments.
      const still = new Set(f.attachments.map(a => a.id));
      (editNote?.attachments ?? []).filter(a => !still.has(a.id))
        .forEach(a => { deleteAttachment(a.id).catch(() => {}); });
      setShowEditor(false);
      // Arm the OS alarm last, so a notifee failure never costs the user the save.
      try {
        if (f.reminder) await armNoteReminder(id, f.reminder, f.title.trim(), f.sensitive, f.locked);
        else await cancelNoteReminder(id);
      } catch { /* the note is saved; the alarm is best effort */ }
    } catch (e: any) {
      Alert.alert('Not saved', e?.message ?? 'Your note could not be saved. Try again.');
    } finally {
      savingNote.current = false;
    }
  };

  const deleteNote = (id: string) => {
    Alert.alert('Move to Trash?', '30-day recovery available', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Trash', style: 'destructive', onPress: async () => {
        const updated = notes.map(n => n.id === id ? { ...n, isDeleted: true, deletedAt: Date.now() } : n);
        if (!(await saveNotes(updated).catch(() => false))) return;
        // A trashed note must stop nagging, or its alarm outlives it by 30 days.
        await cancelNoteReminder(id).catch(() => {});
      }},
    ]);
  };

  const restoreNote = async (id: string) => {
    const updated = notes.map(n => n.id === id ? { ...n, isDeleted: false, deletedAt: undefined } : n);
    if (!(await saveNotes(updated).catch(() => false))) return;
    // Put back the alarm trashing cancelled, if its time is still ahead. The
    // note is restored either way; a failed alarm is not worth an error.
    const n = updated.find(x => x.id === id);
    if (n?.reminder) await armNoteReminder(n.id, n.reminder, n.title, n.isSensitive, n.isLocked).catch(() => false);
  };

  // Confirmed: this is the one delete in the vault with no way back. The note
  // is removed from the store FIRST, so a failed write never leaves a note
  // whose attachments are already gone.
  const permanentDelete = (id: string) => {
    const gone = notes.find(n => n.id === id);
    Alert.alert('Delete forever?', `“${gone?.title ?? 'This note'}” and its attachments will be erased. This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete forever', style: 'destructive', onPress: async () => {
        if (!(await saveNotes(notes.filter(n => n.id !== id)).catch(() => false))) return;
        if (gone?.attachments?.length) await Promise.all(gone.attachments.map(a => deleteAttachment(a.id).catch(() => {})));
        await cancelNoteReminder(id).catch(() => {});
      }},
    ]);
  };

  // Password generator — CSPRNG (@noble randomBytes) with rejection sampling so
  // every character is uniformly distributed (no modulo bias). Never Math.random
  // for a security tool.
  const generatePassword = (length = 20) => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=';
    const max = 256 - (256 % chars.length); // discard bytes ≥ this to stay unbiased
    const out: string[] = [];
    while (out.length < length) {
      const batch = randomBytes(length);
      for (let i = 0; i < batch.length && out.length < length; i++) {
        if (batch[i] < max) out.push(chars[batch[i] % chars.length]);
      }
    }
    setGeneratedPass(out.join(''));
    setShowPassGen(true);
  };

  // Copy with auto-clear (30s) — delegates to the shared clipboardSafe util
  const copyWithAutoClear = async (text: string) => {
    try {
      await copyAndAutoClear(text);
      Alert.alert('Copied', 'Clipboard will auto-clear in 30 seconds');
    } catch {
      Alert.alert('Could not copy', 'Try again.');
    }
  };

  // Filter notes
  const activeNotes = notes.filter(n => !n.isDeleted);
  const trashedNotes = notes.filter(n => n.isDeleted);
  const filtered = activeNotes.filter(n => {
    if (activeCategory && n.category !== activeCategory) return false;
    if (search) {
      const q = search.toLowerCase();
      // A locked note is searched by title and tags only. Matching its body
      // would let anyone holding the phone confirm what is inside it — "does
      // this note contain 'amex'?" — without ever passing the PIN.
      const body = n.isLocked ? '' : n.content;
      return n.title.toLowerCase().includes(q) || body.toLowerCase().includes(q) || n.tags.some(t => t.toLowerCase().includes(q));
    }
    return true;
  });

  // Count per category
  const catCounts: Record<string, number> = {};
  activeNotes.forEach(n => { catCounts[n.category] = (catCounts[n.category] ?? 0) + 1; });

  if (gate !== 'open') {
    return (
      <NotesPinGate
        pin={pinTry}
        err={pinErr}
        onChange={(v) => { setPinTry(v); setPinErr(null); }}
        onSubmit={(v) => submitPin(v)}
        onCancel={() => router.back()}
      />
    );
  }

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity hitSlop={6} onPress={() => router.back()} style={s.backBtn} accessibilityRole="button" accessibilityLabel="Back">
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle} accessibilityRole="header">Encrypted Notes</Text>
          {/* Says what the screen actually does. The gate is the MPIN, not a
              biometric, and notes now leave the device only as ciphertext the
              user's own passphrase seals — "On-device only" stopped being true
              the moment cloudBackup started sweeping this vault's blob. */}
          <Text style={s.headerSub}>AES-256-GCM {'•'} PIN locked {'•'} End-to-end encrypted</Text>
        </View>
        <TouchableOpacity hitSlop={6} onPress={() => setShowBackup(true)} style={s.trashBtn} accessibilityRole="button" accessibilityLabel="Backup notes">
          <Ionicons name="shield-checkmark-outline" size={18} color={colors.text} />
        </TouchableOpacity>
        <TouchableOpacity hitSlop={6} onPress={() => setShowTrash(true)} style={s.trashBtn} accessibilityRole="button" accessibilityLabel="Deleted notes">
          <Ionicons name="trash-outline" size={18} color={colors.text} />
        </TouchableOpacity>
      </View>

      {loadState === 'failed' && (
        <TouchableOpacity style={s.loadFail} onPress={() => setShowBackup(true)} accessibilityRole="button" accessibilityLiveRegion="polite"
          accessibilityLabel={`${loadProblem ?? ''} Saving is off. Open Backup to recover the key.`}>
          <Text style={{ color: colors.danger, fontWeight: '700' }}>{loadProblem}</Text>
          <Text style={{ color: colors.textDim, marginTop: 4 }}>
            Saving is off so nothing overwrites them. Tap to open Backup and recover the key with your passphrase.
          </Text>
        </TouchableOpacity>
      )}

      {/* Search */}
      <View style={s.searchBar}>
        <Ionicons name="search" size={16} color={colors.textDim} style={s.searchIcon} />
        <TextInput style={s.searchInput} placeholder="Encrypted search..." placeholderTextColor={colors.textFaint} value={search} onChangeText={setSearch} accessibilityLabel="Search notes" />
        <TouchableOpacity onPress={() => generatePassword()} hitSlop={10} accessibilityRole="button" accessibilityLabel="Password generator">
          <Ionicons name="key-outline" size={20} color={colors.text} />
        </TouchableOpacity>
      </View>

      {/* Categories */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.catRow}>
        <TouchableOpacity hitSlop={4} style={[s.catChip, !activeCategory && s.catChipActive]} onPress={() => setActiveCategory(null)}
          accessibilityRole="button" accessibilityLabel={`All notes, ${activeNotes.length}`} accessibilityState={{ selected: !activeCategory }}>
          <Text style={[s.catTxt, !activeCategory && s.catTxtActive]}>All ({activeNotes.length})</Text>
        </TouchableOpacity>
        {CATEGORIES.map(cat => (
          <TouchableOpacity key={cat.key} hitSlop={4} style={[s.catChip, activeCategory === cat.key && { backgroundColor: cat.color + '20', borderColor: cat.color }]} onPress={() => setActiveCategory(activeCategory === cat.key ? null : cat.key)}
            accessibilityRole="button" accessibilityLabel={`${cat.name}, ${catCounts[cat.key] ?? 0}`} accessibilityState={{ selected: activeCategory === cat.key }}>
            <Text style={s.catIcon} importantForAccessibility="no" accessibilityElementsHidden>{cat.icon}</Text>
            <Text numberOfLines={1} style={[s.catTxt, activeCategory === cat.key && { color: cat.color }]}>{cat.name}</Text>
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
          const tagColor = n.tagColor ?? DEFAULT_TAG_COLOR;
          return (
            <TouchableOpacity style={s.noteCard} onPress={() => openEditor(n)} onLongPress={() => deleteNote(n.id)} activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`${n.title}${n.isLocked ? ', locked' : ''}${n.isSensitive ? ', sensitive' : ''}${n.attachments?.length ? `, ${n.attachments.length} attachments` : ''}`}
              accessibilityHint="Opens the note"
              accessibilityActions={[{ name: 'trash', label: 'Move to trash' }]}
              onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'trash') deleteNote(n.id); }}>
              {/* The card's label says all of this; the glyphs are for the eye. */}
              <View style={s.noteHeader} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                <Text style={s.noteIcon}>{cat?.icon ?? '📝'}</Text>
                <Text style={s.noteTitle} numberOfLines={1}>{n.title}</Text>
                {n.isLocked && <Ionicons name="lock-closed" size={14} color={colors.textDim} />}
                {n.isSensitive && <Ionicons name="eye-off-outline" size={14} color={colors.textDim} />}
                {!!n.attachments?.length && (
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Ionicons name="attach" size={14} color={colors.textDim} />
                    <Text style={{ fontSize: 12, color: colors.textDim }}>{n.attachments.length}</Text>
                  </View>
                )}
              </View>
              <Text style={s.notePreview} numberOfLines={2}>
                {n.isLocked
                  ? 'Locked — tap to unlock'
                  : n.isSensitive && hideSensitive ? '••••••••••' : n.content}
              </Text>
              <View style={s.noteFooter}>
                <Text style={s.noteDate}>{new Date(n.updatedAt).toLocaleDateString()}</Text>
                {n.tags.length > 0 && (
                  <View style={s.tagRow}>
                    {n.tags.slice(0, 3).map((t, i) => (
                      <View key={`${t}-${i}`} style={[s.tag, { backgroundColor: tagColor + '20' }]}>
                        <Text style={[s.tagTxt, { color: tagColor }]}>{t}</Text>
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
            <Ionicons name="document-text-outline" size={48} color={colors.textDim} style={{ marginBottom: 12 }} importantForAccessibility="no" accessibilityElementsHidden />
            <Text style={s.emptyTxt}>{search ? 'No notes found' : 'No notes yet'}</Text>
            <Text style={s.emptySub}>Tap + to create your first encrypted note</Text>
          </View>
        }
      />

      {/* Show/Hide sensitive toggle */}
      <TouchableOpacity style={[s.sensToggle, { flexDirection: 'row', alignItems: 'center', gap: 6 }]} onPress={() => setHideSensitive(h => !h)}
        accessibilityRole="switch" accessibilityLabel="Hide sensitive notes" accessibilityState={{ checked: hideSensitive }}>
        <Ionicons name={hideSensitive ? 'eye-outline' : 'eye-off-outline'} size={14} color={colors.textDim} />
        <Text style={s.sensToggleTxt}>{hideSensitive ? 'Show' : 'Hide'} Sensitive</Text>
      </TouchableOpacity>

      {/* FAB */}
      <TouchableOpacity
        style={[s.fab, loadState !== 'ok' && { opacity: 0.4 }]}
        onPress={() => openEditor()}
        disabled={loadState !== 'ok'}
        accessibilityRole="button"
        accessibilityLabel="New note"
        accessibilityState={{ disabled: loadState !== 'ok' }}
        activeOpacity={0.8}
      >
        {/* bubbleOutText is the palette's white-on-accent ink (the FAB is purple, not primary). */}
        <Ionicons name="add" size={28} color={colors.bubbleOutText} />
      </TouchableOpacity>

      <NoteEditorModal
        visible={showEditor}
        ed={ed}
        isEdit={!!editNote}
        canSave={loadState === 'ok'}
        attaching={attaching}
        onCancel={cancelEditor}
        onSave={saveNote}
        onAttach={addAttachmentMenu}
        onOpenAttachment={openAttachmentFile}
        onCopy={copyWithAutoClear}
      />

      <PasswordGeneratorModal
        visible={showPassGen}
        password={generatedPass}
        onRegenerate={() => generatePassword()}
        onCopy={() => { copyWithAutoClear(generatedPass); setShowPassGen(false); }}
        onClose={() => setShowPassGen(false)}
      />

      <ImageViewerModal uri={viewerImg} onClose={() => setViewerImg(null)} />

      <TrashModal
        visible={showTrash}
        notes={trashedNotes}
        onClose={() => setShowTrash(false)}
        onRestore={restoreNote}
        onDeleteForever={permanentDelete}
      />

      <LockChallengeModal
        note={pendingLock}
        pin={lockTry}
        err={lockErr}
        onChange={(v) => { setLockTry(v); setLockErr(null); }}
        onSubmit={submitLockPin}
        onCancel={() => { setPendingLock(null); setLockTry(''); setLockErr(null); }}
      />

      <NotesBackupModal
        visible={showBackup}
        onClose={() => setShowBackup(false)}
        loadFailed={loadState === 'failed'}
        withSystemUi={withSystemUi}
        onKeyRestored={async () => { clearNotesKeyCache(); await loadNotes(); }}
      />
    </View>
  );
}
