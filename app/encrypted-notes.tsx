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

import { Ionicons } from '@expo/vector-icons';
import { BRAND_ACCENT, type Palette } from '../constants/theme';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, TextInput,
  Alert, Modal, Platform, ScrollView, Image, ActivityIndicator, AppState,
} from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import Markdown from 'react-native-markdown-display';
import {
  addAttachment, deleteAttachment, isImage, openAttachment, prettySize,
  type NoteAttachment,
} from '../lib/notesAttachments';
import { useTheme } from '../lib/theme';
import { Stack, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { copyAndAutoClear } from '../lib/clipboardSafe';
import { PinPad } from '../components/PinPad';
import { clearNotesKeyCache, decryptNotes, encryptNotes } from '../lib/notesCrypto';
import { armNoteReminder, cancelNoteReminder } from '../lib/notesReminders';
import {
  buildBundle, checkPassphrase, hasPassphrase, purgeExpired, restoreBundle,
  restoreKeyFromWrap, setPassphrase,
} from '../lib/notesVault';

// The same PIN check hidden-chats uses: the server-verified sign-in MPIN.
// services/security/pinStore is a LOCAL store that is empty on installs which
// never set a local PIN — gating on it fell open on a real device.
import { verifyPin } from '../lib/chatService';
import 'react-native-get-random-values';
import { randomBytes } from '@noble/hashes/utils.js';
import { AuroraBackground } from '../components/ui';


// 9 Categories from PDF
const CATEGORIES = [
  { key: 'passwords',    icon: '\uD83D\uDD11', name: 'Passwords',     color: '#EF4444' },
  { key: 'ideas',        icon: '\uD83D\uDCA1', name: 'Ideas',         color: '#F59E0B' },
  { key: 'personal',     icon: '\uD83D\uDCDD', name: 'Personal',      color: '#3B82F6' },
  { key: 'bank',         icon: '\uD83D\uDCB3', name: 'Bank/Cards',    color: BRAND_ACCENT },
  { key: 'medical',      icon: '\uD83C\uDFE5', name: 'Medical',       color: '#EC4899' },
  { key: 'documents',    icon: '\uD83D\uDCC1', name: 'Documents',     color: '#8B5CF6' },
  { key: 'recovery',     icon: '\uD83D\uDD10', name: 'Recovery Keys', color: BRAND_ACCENT },
  { key: 'bookmarks',    icon: '\uD83D\uDD16', name: 'Bookmarks',     color: '#06B6D4' },
  { key: 'custom',       icon: '\uD83D\uDCC2', name: 'Custom',        color: '#6B7280' },
];

const TAG_COLORS = ['#EF4444', '#F59E0B', BRAND_ACCENT, '#3B82F6', '#8B5CF6', '#EC4899', '#06B6D4', '#6B7280'];

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
  attachments?: NoteAttachment[]; // encrypted files (lib/notesAttachments)
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

  // Re-lock on background. clearNotesKeyCache() existed and was called from
  // nowhere, so once the screen had been unlocked the DEK stayed in memory for
  // the life of the process — the vault never actually re-locked, it only
  // re-prompted. Dropping the key and the gate together makes the prompt real.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active') {
        clearNotesKeyCache();
        setGate('pin');
        setShowEditor(false);
        setPendingLock(null);
        setViewerImg(null);
      }
    });
    return () => sub.remove();
  }, []);

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
    } catch {
      // Server unreachable — stay locked rather than open on a network error.
      setPinTry(''); setPinErr('Could not verify. Check your connection.');
    }
  }, [pinTry]);

  // Editor state
  const [edTitle, setEdTitle] = useState('');
  const [edContent, setEdContent] = useState('');
  const [edCategory, setEdCategory] = useState('personal');
  const [edTags, setEdTags] = useState<string[]>([]);
  const [edTagColor, setEdTagColor] = useState('#3B82F6');
  const [edSensitive, setEdSensitive] = useState(false);
  const [edLocked, setEdLocked] = useState(false);
  const [hideSensitive, setHideSensitive] = useState(true);
  const [edAttachments, setEdAttachments] = useState<NoteAttachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [viewerImg, setViewerImg] = useState<string | null>(null);
  const [edPreview, setEdPreview] = useState(false);
  const [edSel, setEdSel] = useState({ start: 0, end: 0 });
  const [edReminder, setEdReminder] = useState<number | undefined>(undefined);

  // Backup / restore (lib/notesVault) — passphrase-wrapped, ciphertext only.
  const [showBackup, setShowBackup] = useState(false);
  const [bkPass, setBkPass] = useState('');
  const [bkPass2, setBkPass2] = useState('');
  const [bkBusy, setBkBusy] = useState(false);
  const [bkHasPass, setBkHasPass] = useState(false);
  useEffect(() => { hasPassphrase().then(setBkHasPass).catch(() => {}); }, [showBackup]);

  useEffect(() => { loadNotes(); }, []);

  const loadNotes = async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const dec = await decryptNotes(raw);
      if (!dec) return; // sealed blob we can't open — don't clobber it
      const parsed: Note[] = JSON.parse(dec.text);

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
      setNotes(kept);

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
    } catch {}
  };

  const saveNotes = async (updated: Note[]) => {
    setNotes(updated);
    await AsyncStorage.setItem(STORAGE_KEY, await encryptNotes(JSON.stringify(updated)));
  };

  // Challenge a locked note before anything of it is rendered. Same
  // server-verified MPIN as the screen gate — one PIN, not a second secret to
  // remember for the same vault.
  const submitLockPin = useCallback(async (pin?: string) => {
    const note = pendingLock;
    if (!note) return;
    const v = pin ?? lockTry;
    if (!/^\d{4,8}$/.test(v)) { setLockErr('PIN must be 4–8 digits'); return; }
    try {
      if (await verifyPin(v)) {
        setPendingLock(null); setLockTry(''); setLockErr(null);
        openEditor(note, true);
      } else { setLockTry(''); setLockErr('Incorrect PIN'); }
    } catch {
      setLockTry(''); setLockErr('Could not verify. Check your connection.');
    }
  }, [pendingLock, lockTry]);

  const openEditor = (note?: Note, unlocked = false) => {
    // A locked note goes to the challenge instead of the editor. Without this
    // the padlock badge promised a protection that did not exist.
    if (note?.isLocked && !unlocked) {
      setLockTry(''); setLockErr(null); setPendingLock(note);
      return;
    }
    if (note) {
      setEditNote(note);
      setEdTitle(note.title);
      setEdContent(note.content);
      setEdCategory(note.category);
      setEdTags(note.tags);
      setEdTagColor(note.tagColor ?? '#3B82F6');
      setEdSensitive(note.isSensitive);
      setEdLocked(note.isLocked);
      setEdAttachments(note.attachments ?? []);
      setEdReminder(note.reminder);
    } else {
      setEditNote(null);
      setEdTitle('');
      setEdContent('');
      setEdCategory(activeCategory ?? 'personal');
      setEdTags([]);
      setEdTagColor('#3B82F6');
      setEdSensitive(false);
      setEdLocked(false);
      setEdAttachments([]);
      setEdReminder(undefined);
    }
    setShowEditor(true);
  };

  // ── Attachments (encrypted via lib/notesAttachments) ──────────────────────
  const attachImage = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert('Permission needed', 'Allow photo access to attach an image.'); return; }
    const res = await ImagePicker.launchImageLibraryAsync({ quality: 0.9 });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    setAttaching(true);
    try {
      const att = await addAttachment(a.uri, a.fileName ?? `image_${Date.now()}.jpg`, a.mimeType ?? 'image/jpeg');
      setEdAttachments(prev => [...prev, att]);
    } catch (e: any) {
      Alert.alert('Could not attach', e?.message ?? 'Try again');
    } finally { setAttaching(false); }
  };

  const attachFile = async () => {
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    setAttaching(true);
    try {
      const att = await addAttachment(a.uri, a.name, a.mimeType ?? 'application/octet-stream');
      setEdAttachments(prev => [...prev, att]);
    } catch (e: any) {
      Alert.alert('Could not attach', e?.message ?? 'Try again');
    } finally { setAttaching(false); }
  };

  const addAttachmentMenu = () => {
    Alert.alert('Add attachment', 'Encrypted with your notes key before it touches disk.', [
      { text: 'Photo / Image', onPress: attachImage },
      { text: 'File', onPress: attachFile },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const removeAttachment = async (att: NoteAttachment) => {
    await deleteAttachment(att.id);
    setEdAttachments(prev => prev.filter(x => x.id !== att.id));
  };

  const openAttachmentFile = async (att: NoteAttachment) => {
    const uri = await openAttachment(att);
    if (!uri) { Alert.alert('Could not open', 'This attachment is unavailable or corrupted.'); return; }
    if (isImage(att)) { setViewerImg(uri); return; }
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: att.mime, dialogTitle: att.name });
    else Alert.alert('Saved', 'Opened a decrypted copy.');
  };

  // ── Markdown formatting (#142) ────────────────────────────────────────────
  // Wrap the current selection (or insert at the cursor) with markdown markers.
  const wrapSelection = (before: string, after: string) => {
    const { start, end } = edSel;
    const s0 = Math.max(0, Math.min(start, edContent.length));
    const s1 = Math.max(s0, Math.min(end, edContent.length));
    const selected = edContent.slice(s0, s1) || 'text';
    setEdContent(edContent.slice(0, s0) + before + selected + after + edContent.slice(s1));
  };
  // Prefix the line containing the selection start (headings, lists, quotes).
  const prefixLine = (prefix: string) => {
    const { start } = edSel;
    const lineStart = edContent.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    setEdContent(edContent.slice(0, lineStart) + prefix + edContent.slice(lineStart));
  };

  const saveNote = async () => {
    if (!edTitle.trim()) { Alert.alert('Error', 'Title required'); return; }
    const now = Date.now();
    const id = editNote ? editNote.id : `note_${now}`;
    if (editNote) {
      const updated = notes.map(n => n.id === editNote.id ? { ...n, title: edTitle.trim(), content: edContent, category: edCategory, tags: edTags, tagColor: edTagColor, isSensitive: edSensitive, isLocked: edLocked, attachments: edAttachments, reminder: edReminder, updatedAt: now } : n);
      await saveNotes(updated);
    } else {
      const newNote: Note = {
        id, title: edTitle.trim(), content: edContent,
        category: edCategory, tags: edTags, tagColor: edTagColor,
        isSensitive: edSensitive, isLocked: edLocked, attachments: edAttachments,
        reminder: edReminder, createdAt: now, updatedAt: now,
      };
      await saveNotes([newNote, ...notes]);
    }
    // Arm the OS alarm last, so a notifee failure never costs the user the save.
    if (edReminder) await armNoteReminder(id, edReminder, edTitle.trim(), edSensitive, edLocked);
    else await cancelNoteReminder(id);
    setShowEditor(false);
  };

  const deleteNote = (id: string) => {
    Alert.alert('Move to Trash?', '30-day recovery available', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Trash', style: 'destructive', onPress: async () => {
        const updated = notes.map(n => n.id === id ? { ...n, isDeleted: true, deletedAt: Date.now() } : n);
        await saveNotes(updated);
        // A trashed note must stop nagging, or its alarm outlives it by 30 days.
        await cancelNoteReminder(id);
      }},
    ]);
  };

  const restoreNote = async (id: string) => {
    const updated = notes.map(n => n.id === id ? { ...n, isDeleted: false, deletedAt: undefined } : n);
    await saveNotes(updated);
    // Put back the alarm trashing cancelled, if its time is still ahead.
    const n = updated.find(x => x.id === id);
    if (n?.reminder) await armNoteReminder(n.id, n.reminder, n.title, n.isSensitive, n.isLocked);
  };

  const permanentDelete = async (id: string) => {
    const gone = notes.find(n => n.id === id);
    if (gone?.attachments?.length) await Promise.all(gone.attachments.map(a => deleteAttachment(a.id)));
    await cancelNoteReminder(id);
    await saveNotes(notes.filter(n => n.id !== id));
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

  // Reminder picker — the same date-then-time chain app/finance/reminders.tsx
  // uses, so the two reminder features in this app behave identically.
  const pickReminder = () => {
    const base = edReminder ?? Date.now() + 60 * 60 * 1000;
    DateTimePickerAndroid.open({
      value: new Date(base), mode: 'date', minimumDate: new Date(),
      onChange: (_e, d) => {
        if (!d) return;
        const day = d.getTime();
        DateTimePickerAndroid.open({
          value: new Date(base), mode: 'time',
          onChange: (_e2, t) => {
            const at = new Date(day);
            if (t) at.setHours(t.getHours(), t.getMinutes(), 0, 0);
            if (at.getTime() <= Date.now()) { Alert.alert('Pick a future time', 'That moment has already passed.'); return; }
            setEdReminder(at.getTime());
          },
        });
      },
    });
  };

  // ── Backup / restore (lib/notesVault) ─────────────────────────────────────
  // The vault's DEK lives only in SecureStore, which nothing backs up — while
  // the sealed notes blob IS swept into every cloud backup as a plain
  // AsyncStorage key. A restore therefore produced ciphertext with no key: the
  // backup looked fine and guaranteed total loss. A passphrase-wrapped copy of
  // the DEK travels with it now, so only the passphrase — never stored, never
  // sent — can open the vault, including from the server's side of a backup.

  const savePassphrase = async () => {
    if (bkPass !== bkPass2) { Alert.alert('Passphrases differ', 'The two entries must match.'); return; }
    setBkBusy(true);
    try {
      await setPassphrase(bkPass);
      setBkPass(''); setBkPass2(''); setBkHasPass(true);
      Alert.alert(
        'Backup passphrase set',
        'Your notes key is now included in backups, sealed with this passphrase.\n\nWrite it down. It is never stored and never sent — if you forget it, nobody can recover these notes, including us.',
      );
    } catch (e: any) {
      Alert.alert('Could not set passphrase', e?.message ?? 'Try again');
    } finally { setBkBusy(false); }
  };

  // Write a self-contained encrypted file and hand it to the share sheet.
  const exportBundle = async () => {
    if (!bkPass) { Alert.alert('Passphrase needed', 'Enter the passphrase to seal this export.'); return; }
    setBkBusy(true);
    try {
      if (bkHasPass && !(await checkPassphrase(bkPass))) {
        Alert.alert('Wrong passphrase', 'That is not your backup passphrase.');
        return;
      }
      const bundle = await buildBundle(bkPass);
      const path = `${FileSystem.cacheDirectory}vaultchat-notes-${new Date().toISOString().slice(0, 10)}.vcnotes`;
      await FileSystem.writeAsStringAsync(path, JSON.stringify(bundle), { encoding: FileSystem.EncodingType.UTF8 });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(path, { mimeType: 'application/json', dialogTitle: 'Encrypted notes backup' });
      } else {
        Alert.alert('Saved', path);
      }
      setBkPass(''); setBkPass2('');
    } catch (e: any) {
      Alert.alert('Export failed', e?.message ?? 'Try again');
    } finally { setBkBusy(false); }
  };

  const importBundleFile = async () => {
    if (!bkPass) { Alert.alert('Passphrase needed', 'Enter the passphrase this backup was sealed with.'); return; }
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (res.canceled || !res.assets?.[0]) return;
    setBkBusy(true);
    try {
      const raw = await FileSystem.readAsStringAsync(res.assets[0].uri, { encoding: FileSystem.EncodingType.UTF8 });
      const r = await restoreBundle(bkPass, JSON.parse(raw));
      if (r.status === 'invalid') { Alert.alert('Not a notes backup', 'That file is not a VaultChat notes export.'); return; }
      if (r.status === 'wrong') { Alert.alert('Wrong passphrase', 'That passphrase does not open this backup.'); return; }
      if (r.status === 'occupied') {
        // Never silently swap the key: whatever this device already holds would
        // become permanently unreadable.
        Alert.alert(
          'This device already has notes',
          'Restoring replaces this device’s notes key. Any notes here that came from a different key will become unreadable. Continue?',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Replace', style: 'destructive', onPress: async () => {
              const f = await restoreBundle(bkPass, JSON.parse(raw), true);
              if (f.status === 'ok') { clearNotesKeyCache(); await loadNotes(); setShowBackup(false); Alert.alert('Restored', `Notes and ${f.attachments} attachment(s) restored.`); }
            }},
          ],
        );
        return;
      }
      clearNotesKeyCache();
      await loadNotes();
      setShowBackup(false); setBkPass('');
      Alert.alert('Restored', `Notes and ${r.attachments} attachment(s) restored.`);
    } catch (e: any) {
      Alert.alert('Restore failed', e?.message ?? 'Try again');
    } finally { setBkBusy(false); }
  };

  // After a device restore the notes blob and the wrap both came back through
  // the normal cloud/Drive backup — only the key is missing. This recovers it
  // in place, with no file to pick.
  const recoverKey = async () => {
    if (!bkPass) { Alert.alert('Passphrase needed', 'Enter your backup passphrase.'); return; }
    setBkBusy(true);
    try {
      const r = await restoreKeyFromWrap(bkPass);
      if (r === 'none') { Alert.alert('Nothing to recover', 'No wrapped key travelled with this install.'); return; }
      if (r === 'wrong') { Alert.alert('Wrong passphrase', 'That passphrase does not open the stored key.'); return; }
      if (r === 'occupied') {
        Alert.alert(
          'This device already has a different key',
          'Replacing it will make any notes written with the current key unreadable. Continue?',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Replace', style: 'destructive', onPress: async () => {
              await restoreKeyFromWrap(bkPass, true);
              clearNotesKeyCache(); await loadNotes(); setShowBackup(false);
              Alert.alert('Key recovered', 'Your notes should be readable again.');
            }},
          ],
        );
        return;
      }
      clearNotesKeyCache();
      await loadNotes();
      setShowBackup(false); setBkPass('');
      Alert.alert('Key recovered', 'Your notes should be readable again.');
    } catch (e: any) {
      Alert.alert('Could not recover', e?.message ?? 'Try again');
    } finally { setBkBusy(false); }
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
      <View style={[s.screen, { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }]}>
      <AuroraBackground />
        <Stack.Screen options={{ headerShown: false }} />
        <Text style={{ fontSize: 40, marginBottom: 16 }}>🔒</Text>
        {gate === 'pin' && (
          <>
            <Text style={{ color: colors.text, fontSize: 16, marginBottom: 16 }}>Enter your PIN</Text>
            {/* An in-app keypad, NOT a TextInput. Device-proven on the Redmi:
                the soft keyboard never opened for this gate — the field held
                focus while dumpsys reported mShowRequested=false and the IME
                never bound to the app's window at all, so the gate could not
                be passed. Android does not guarantee the IME on programmatic
                focus (a real tap is the reliable trigger) and MIUI is strict
                about it. components/PinPad has no IME dependency, so there is
                nothing left to refuse. */}
            <PinPad
              value={pinTry}
              onChange={(v) => { setPinTry(v); setPinErr(null); }}
              onComplete={(v) => submitPin(v)}
              error={!!pinErr}
            />
            {!!pinErr && <Text style={{ color: '#ff6b6b', marginTop: 12 }}>{pinErr}</Text>}
            <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 20 }}>
              <Text style={{ color: colors.textDim }}>Cancel</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} accessibilityLabel="Back">
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle}>{'\uD83D\uDCDD'} Encrypted Notes</Text>
          {/* Says what the screen actually does. The gate is the MPIN, not a
              biometric, and notes now leave the device only as ciphertext the
              user's own passphrase seals \u2014 "On-device only" stopped being true
              the moment cloudBackup started sweeping this vault's blob. */}
          <Text style={s.headerSub}>AES-256-GCM {'\u2022'} PIN locked {'\u2022'} End-to-end encrypted</Text>
        </View>
        <TouchableOpacity onPress={() => setShowBackup(true)} style={s.trashBtn} accessibilityLabel="Backup notes">
          <Ionicons name="shield-checkmark-outline" size={18} color={colors.text} />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setShowTrash(true)} style={s.trashBtn} accessibilityLabel="Deleted notes">
          <Ionicons name="trash-outline" size={18} color={colors.text} />
        </TouchableOpacity>
      </View>

      {/* Search */}
      <View style={s.searchBar}>
        <Ionicons name="search" size={16} color={colors.textDim} style={s.searchIcon} />
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
          return (
            <TouchableOpacity style={s.noteCard} onPress={() => openEditor(n)} onLongPress={() => deleteNote(n.id)} activeOpacity={0.7}>
              <View style={s.noteHeader}>
                <Text style={s.noteIcon}>{cat?.icon ?? '\uD83D\uDCDD'}</Text>
                <Text style={s.noteTitle} numberOfLines={1}>{n.title}</Text>
                {n.isLocked && <Text style={{ fontSize: 14 }}>{'\uD83D\uDD12'}</Text>}
                {n.isSensitive && <Text style={{ fontSize: 14 }}>{'\uD83D\uDC41'}</Text>}
                {!!n.attachments?.length && <Text style={{ fontSize: 13 }}>{'\uD83D\uDCCE'}{n.attachments.length}</Text>}
              </View>
              <Text style={s.notePreview} numberOfLines={2}>
                {n.isLocked
                  ? 'Locked \u2014 tap to unlock'
                  : n.isSensitive && hideSensitive ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : n.content}
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
      <TouchableOpacity style={s.fab} onPress={() => openEditor()} accessibilityLabel="New note" activeOpacity={0.8}>
        <Ionicons name="add" size={28} color="#FFF" />
      </TouchableOpacity>

      {/* Note Editor Modal */}
      <Modal visible={showEditor} animationType="slide">
        <View style={s.editorScreen}>
          <View style={s.editorHeader}>
            <TouchableOpacity onPress={() => setShowEditor(false)}>
              <Text style={s.editorCancel}>Cancel</Text>
            </TouchableOpacity>
            <Text style={s.editorTitle}>{editNote ? 'Edit Note' : 'New Note'}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
              <TouchableOpacity onPress={() => setEdPreview(p => !p)}>
                <Text style={[s.editorCancel, edPreview && { color: colors.primary }]}>{edPreview ? 'Edit' : 'Preview'}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={saveNote}>
                <Text style={s.editorSave}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>

          <ScrollView style={s.editorBody}>
            <TextInput style={s.editorTitleInput} placeholder="Title" placeholderTextColor="#555" value={edTitle} onChangeText={setEdTitle} />

            {/* Category picker */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 8 }}>
              {CATEGORIES.map(cat => (
                <TouchableOpacity key={cat.key} style={[s.edCatChip, edCategory === cat.key && { backgroundColor: cat.color + '20', borderColor: cat.color }]} onPress={() => setEdCategory(cat.key)}>
                  <Text style={{ fontSize: 14 }}>{cat.icon}</Text>
                  <Text numberOfLines={1} style={[s.edCatTxt, edCategory === cat.key && { color: cat.color }]}>{cat.name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            {/* Markdown content (#142): edit with a formatting toolbar, or preview rendered */}
            {edPreview ? (
              <View style={s.mdPreview}>
                {edContent.trim()
                  ? <Markdown style={mdStyles(colors)}>{edContent}</Markdown>
                  : <Text style={{ color: colors.textFaint }}>Nothing to preview yet.</Text>}
              </View>
            ) : (
              <>
                <View style={s.mdBar}>
                  {([
                    ['B', () => wrapSelection('**', '**')],
                    ['I', () => wrapSelection('_', '_')],
                    ['H', () => prefixLine('# ')],
                    ['• List', () => prefixLine('- ')],
                    ['❝', () => prefixLine('> ')],
                    ['‹›', () => wrapSelection('`', '`')],
                    ['🔗', () => wrapSelection('[', '](https://)')],
                  ] as [string, () => void][]).map(([label, fn]) => (
                    <TouchableOpacity key={label} style={s.mdBtn} onPress={fn}>
                      <Text style={s.mdBtnTxt}>{label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <TextInput
                  style={s.editorContent}
                  placeholder="Note content… (Markdown supported — tap Preview)"
                  placeholderTextColor="#555"
                  value={edContent}
                  onChangeText={setEdContent}
                  onSelectionChange={(e) => setEdSel(e.nativeEvent.selection)}
                  multiline
                  textAlignVertical="top"
                />
              </>
            )}

            {/* Attachments (encrypted) */}
            <View style={s.edSection}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={s.edLabel}>Attachments {edAttachments.length > 0 ? `(${edAttachments.length})` : ''}</Text>
                <TouchableOpacity onPress={addAttachmentMenu} disabled={attaching} style={s.attachBtn}>
                  {attaching ? <ActivityIndicator size="small" color={colors.primary} /> : <Text style={s.attachBtnTxt}>＋ Attach</Text>}
                </TouchableOpacity>
              </View>
              <Text style={s.attachHint}>🔒 Encrypted with your notes key before it’s written to disk.</Text>
              {edAttachments.map(att => (
                <View key={att.id} style={s.attachRow}>
                  <TouchableOpacity style={{ flexDirection: 'row', alignItems: 'center', flex: 1, gap: 10 }} onPress={() => openAttachmentFile(att)}>
                    <Text style={{ fontSize: 20 }}>{isImage(att) ? '🖼️' : '📎'}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={s.attachName} numberOfLines={1}>{att.name}</Text>
                      <Text style={s.attachMeta}>{prettySize(att.size)} · tap to open</Text>
                    </View>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => removeAttachment(att)} hitSlop={8} accessibilityLabel="Remove attachment">
                    <Ionicons name="close" size={16} color="#EF4444" />
                  </TouchableOpacity>
                </View>
              ))}
            </View>

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
                <Text style={s.edToggleTxt}>PIN Lock {edLocked ? '(ON)' : '(OFF)'}</Text>
              </TouchableOpacity>

              {/* Reminder (feature #12) \u2014 armed as an AlarmManager alarm on save. */}
              <TouchableOpacity style={s.edToggle} onPress={pickReminder}>
                <Text style={s.edToggleIcon}>{'\u23F0'}</Text>
                <Text style={s.edToggleTxt}>
                  {edReminder ? `Reminder ${new Date(edReminder).toLocaleString()}` : 'Reminder (none)'}
                </Text>
                {!!edReminder && (
                  <TouchableOpacity onPress={() => setEdReminder(undefined)} hitSlop={10} accessibilityLabel="Clear reminder">
                    <Ionicons name="close" size={16} color="#EF4444" />
                  </TouchableOpacity>
                )}
              </TouchableOpacity>
              {!!edReminder && (edLocked || edSensitive) && (
                <Text style={s.attachHint}>
                  {'\uD83D\uDD12'} The alert will not show this note\u2019s title on your lock screen.
                </Text>
              )}
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

      {/* Encrypted image viewer */}
      <Modal visible={!!viewerImg} transparent animationType="fade" onRequestClose={() => setViewerImg(null)}>
        <View style={s.imgViewer}>
          {viewerImg && <Image source={{ uri: viewerImg }} style={s.imgViewerImg} resizeMode="contain" />}
          <TouchableOpacity style={s.imgViewerClose} onPress={() => setViewerImg(null)}>
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>Close</Text>
          </TouchableOpacity>
        </View>
      </Modal>

      {/* Secure Trash Modal */}
      <Modal visible={showTrash} animationType="slide">
        <View style={s.editorScreen}>
          <View style={s.editorHeader}>
            <TouchableOpacity onPress={() => setShowTrash(false)} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Ionicons name="arrow-back" size={16} color={colors.textDim} />
              <Text style={s.editorCancel}>Back</Text>
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
                <Text numberOfLines={1} style={s.trashTitle}>{n.title}</Text>
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

      {/* Per-note lock challenge — nothing of the note renders until it passes. */}
      <Modal visible={!!pendingLock} transparent animationType="fade" onRequestClose={() => setPendingLock(null)}>
        <View style={s.passModal}>
          <View style={s.passCard}>
            <Text style={s.passTitle}>{'🔒'} Locked note</Text>
            <Text style={{ color: colors.textDim, textAlign: 'center', marginBottom: 12 }}>
              Enter your PIN to open “{pendingLock?.title}”
            </Text>
            {/* Same keypad as the screen gate — see the note there. */}
            <PinPad
              value={lockTry}
              onChange={(v) => { setLockTry(v); setLockErr(null); }}
              onComplete={(v) => submitLockPin(v)}
              error={!!lockErr}
            />
            {!!lockErr && <Text style={{ color: '#ff6b6b', textAlign: 'center', marginBottom: 8 }}>{lockErr}</Text>}
            <View style={s.passActions}>
              <TouchableOpacity style={s.passBtn} onPress={() => { setPendingLock(null); setLockTry(''); setLockErr(null); }}>
                <Text style={s.passBtnTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.passBtn, { backgroundColor: colors.primary }]} onPress={() => submitLockPin()}>
                <Text style={s.passBtnTxt}>Unlock</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Backup & restore — passphrase-wrapped key, ciphertext everywhere. */}
      <Modal visible={showBackup} animationType="slide" onRequestClose={() => setShowBackup(false)}>
        <View style={s.editorScreen}>
          <View style={s.editorHeader}>
            <TouchableOpacity onPress={() => setShowBackup(false)} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Ionicons name="arrow-back" size={16} color={colors.textDim} />
              <Text style={s.editorCancel}>Back</Text>
            </TouchableOpacity>
            <Text style={s.editorTitle}>{'🛡️'} Backup</Text>
            <View style={{ width: 50 }} />
          </View>

          <ScrollView style={s.editorBody} contentContainerStyle={{ paddingBottom: 40 }}>
            <Text style={s.bkBody}>
              Your notes are sealed with a key that lives only in this phone’s keystore. Nothing
              copies it — so without a backup passphrase, losing this phone loses every note here
              permanently.
            </Text>
            <Text style={s.bkBody}>
              A passphrase seals a copy of that key so it can travel inside your normal backup.
              The passphrase is never stored and never sent: not to us, not to the server, not
              inside the backup. Only you can open it, and if you forget it nobody can help.
            </Text>

            <View style={s.edSection}>
              <Text style={s.edLabel}>{bkHasPass ? 'Backup passphrase (set)' : 'Set a backup passphrase'}</Text>
              <TextInput
                style={s.tagInput} placeholder="Passphrase (8+ characters)" placeholderTextColor="#555"
                value={bkPass} onChangeText={setBkPass} secureTextEntry autoCapitalize="none"
              />
              {!bkHasPass && (
                <TextInput
                  style={s.tagInput} placeholder="Repeat passphrase" placeholderTextColor="#555"
                  value={bkPass2} onChangeText={setBkPass2} secureTextEntry autoCapitalize="none"
                />
              )}
              {!bkHasPass && (
                <TouchableOpacity style={s.bkBtn} onPress={savePassphrase} disabled={bkBusy || bkPass.length < 8}>
                  <Text style={s.bkBtnTxt}>{bkBusy ? 'Working…' : 'Set passphrase'}</Text>
                </TouchableOpacity>
              )}
              {bkHasPass && (
                <TouchableOpacity style={[s.bkBtn, { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.glassStroke }]}
                  onPress={() => { setBkHasPass(false); setBkPass(''); setBkPass2(''); }}>
                  <Text style={[s.bkBtnTxt, { color: colors.textDim }]}>Change passphrase</Text>
                </TouchableOpacity>
              )}
            </View>

            <View style={s.edSection}>
              <Text style={s.edLabel}>Export</Text>
              <Text style={s.attachHint}>
                One encrypted file holding your notes and every attachment, exactly as they are
                sealed on disk. Nothing inside it is readable without the passphrase.
              </Text>
              <TouchableOpacity style={s.bkBtn} onPress={exportBundle} disabled={bkBusy}>
                <Text style={s.bkBtnTxt}>{bkBusy ? 'Working…' : 'Export encrypted file'}</Text>
              </TouchableOpacity>
            </View>

            <View style={s.edSection}>
              <Text style={s.edLabel}>Restore</Text>
              <Text style={s.attachHint}>
                From an exported file, or — if your notes came back from a cloud backup unreadable —
                recover just the key that was left behind.
              </Text>
              <TouchableOpacity style={s.bkBtn} onPress={importBundleFile} disabled={bkBusy}>
                <Text style={s.bkBtnTxt}>Restore from file</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.bkBtn, { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.glassStroke }]}
                onPress={recoverKey} disabled={bkBusy}>
                <Text style={[s.bkBtnTxt, { color: colors.textDim }]}>Recover key from backup</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

// Markdown render theme — maps react-native-markdown-display element keys to the
// active palette so previews look right in both light and dark.
const mdStyles = (c: Palette) => ({
  body: { color: c.text, fontSize: 15, lineHeight: 22 },
  heading1: { color: c.text, fontSize: 22, fontWeight: '800' as const, marginTop: 8, marginBottom: 4 },
  heading2: { color: c.text, fontSize: 19, fontWeight: '800' as const, marginTop: 8, marginBottom: 4 },
  heading3: { color: c.text, fontSize: 16, fontWeight: '700' as const, marginTop: 6, marginBottom: 4 },
  strong: { fontWeight: '800' as const, color: c.text },
  em: { fontStyle: 'italic' as const },
  link: { color: c.primary, textDecorationLine: 'underline' as const },
  blockquote: { backgroundColor: c.glassSoft, borderLeftColor: c.primary, borderLeftWidth: 3, paddingHorizontal: 12, paddingVertical: 6, marginVertical: 4 },
  code_inline: { backgroundColor: c.glassSoft, color: c.accent, paddingHorizontal: 5, borderRadius: 4, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  code_block: { backgroundColor: c.glassSoft, color: c.text, padding: 10, borderRadius: 8, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  fence: { backgroundColor: c.glassSoft, color: c.text, padding: 10, borderRadius: 8, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  bullet_list: { marginVertical: 4 },
  ordered_list: { marginVertical: 4 },
  hr: { backgroundColor: c.border, height: 1 },
});

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: Platform.OS === 'ios' ? 56 : 44, paddingBottom: 14, paddingHorizontal: 16, backgroundColor: c.glassSoft, borderBottomWidth: 1, borderBottomColor: c.glassStroke },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: c.surfaceSolid, alignItems: 'center', justifyContent: 'center' },
  backTxt: { fontSize: 18, color: c.text },
  headerTitle: { fontSize: 16, fontWeight: '700', color: c.text },
  headerSub: { fontSize: 10, color: c.textDim, marginTop: 1 },
  trashBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: c.surfaceSolid, alignItems: 'center', justifyContent: 'center' },

  searchBar: { flexDirection: 'row', alignItems: 'center', gap: 8, margin: 12, backgroundColor: c.glassSoft, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: c.glassStroke },
  searchIcon: { fontSize: 16 },
  searchInput: { flex: 1, color: c.text, fontSize: 14 },
  passGenBtn: { fontSize: 20 },

  catRow: { paddingHorizontal: 12, gap: 8, paddingBottom: 8 },
  catChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.glassSoft, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: c.glassStroke },
  catChipActive: { backgroundColor: c.purple + '20', borderColor: c.purple },
  catIcon: { fontSize: 14 },
  catTxt: { fontSize: 12, color: c.textDim, fontWeight: '500' },
  catTxtActive: { color: c.purple },
  catCount: { fontSize: 10, fontWeight: '700' },

  notesList: { padding: 12, paddingBottom: 100 },
  noteCard: { backgroundColor: c.glassSoft, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: c.glassStroke },
  noteHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  noteIcon: { fontSize: 18 },
  noteTitle: { flex: 1, fontSize: 15, fontWeight: '700', color: c.text },
  notePreview: { fontSize: 13, color: c.textDim, lineHeight: 18, marginBottom: 8 },
  noteFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  noteDate: { fontSize: 11, color: c.textDim },
  tagRow: { flexDirection: 'row', gap: 4 },
  tag: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  tagTxt: { fontSize: 10, fontWeight: '600' },

  sensToggle: { position: 'absolute', bottom: 90, left: 16, backgroundColor: c.glassSoft, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: c.glassStroke },
  sensToggleTxt: { color: c.textDim, fontSize: 12, fontWeight: '600' },

  fab: { position: 'absolute', bottom: 24, right: 20, width: 56, height: 56, borderRadius: 28, backgroundColor: c.purple, alignItems: 'center', justifyContent: 'center', elevation: 6 },
  fabTxt: { fontSize: 28, color: '#FFF', fontWeight: '300', marginTop: -2 },

  empty: { alignItems: 'center', paddingTop: 60 },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyTxt: { fontSize: 16, fontWeight: '600', color: c.text },
  emptySub: { fontSize: 13, color: c.textDim, marginTop: 4 },

  // Editor
  editorScreen: { flex: 1, backgroundColor: c.bg },
  editorHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: Platform.OS === 'ios' ? 56 : 44, paddingBottom: 12, paddingHorizontal: 16, backgroundColor: c.glassSoft, borderBottomWidth: 1, borderBottomColor: c.glassStroke },
  editorCancel: { color: c.textDim, fontSize: 14 },
  editorTitle: { color: c.text, fontSize: 16, fontWeight: '700' },
  editorSave: { color: c.purple, fontSize: 14, fontWeight: '700' },
  editorBody: { flex: 1, padding: 16 },
  editorTitleInput: { color: c.text, fontSize: 22, fontWeight: '700', marginBottom: 12, borderBottomWidth: 1, borderBottomColor: c.glassStroke, paddingBottom: 8 },
  editorContent: { color: c.text, fontSize: 15, lineHeight: 22, minHeight: 150, backgroundColor: c.glassSoft, borderRadius: 12, padding: 14, marginTop: 8, borderWidth: 1, borderColor: c.glassStroke },

  edCatChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: c.glassSoft, borderWidth: 1, borderColor: c.glassStroke },
  edCatTxt: { fontSize: 11, color: c.textDim },

  edSection: { marginTop: 16 },
  edLabel: { color: c.purple, fontSize: 12, fontWeight: '600', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  attachBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: c.glassStroke, minWidth: 72, alignItems: 'center' },
  attachBtnTxt: { color: c.primary, fontSize: 13, fontWeight: '700' },
  attachHint: { color: c.textDim, fontSize: 11, marginBottom: 8 },
  bkBody: { color: c.textDim, fontSize: 13, lineHeight: 19, marginBottom: 12 },
  bkBtn: { backgroundColor: c.primary, borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 8 },
  bkBtnTxt: { color: '#fff', fontWeight: '700', fontSize: 14 },
  attachRow: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: c.glassSoft, borderRadius: 10, borderWidth: 1, borderColor: c.glassStroke, paddingHorizontal: 12, paddingVertical: 10, marginTop: 6 },
  attachName: { color: c.text, fontSize: 14, fontWeight: '600' },
  attachMeta: { color: c.textDim, fontSize: 11, marginTop: 2 },
  mdBar: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8, marginBottom: 8 },
  mdBtn: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, backgroundColor: c.glassSoft, borderWidth: 1, borderColor: c.glassStroke },
  mdBtnTxt: { color: c.text, fontSize: 13, fontWeight: '700' },
  mdPreview: { minHeight: 180, paddingVertical: 8 },
  imgViewer: { flex: 1, backgroundColor: 'rgba(0,0,0,0.95)', justifyContent: 'center', alignItems: 'center' },
  imgViewerImg: { width: '100%', height: '80%' },
  imgViewerClose: { position: 'absolute', bottom: 50, paddingHorizontal: 28, paddingVertical: 12, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 24 },
  colorDot: { width: 28, height: 28, borderRadius: 14 },
  colorDotActive: { borderWidth: 3, borderColor: c.glassStroke },
  tagInput: { backgroundColor: c.glassSoft, borderRadius: 10, padding: 10, color: c.text, fontSize: 13, marginTop: 8, borderWidth: 1, borderColor: c.glassStroke },

  edToggle: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.glassStroke },
  edToggleIcon: { fontSize: 20 },
  edToggleTxt: { color: c.text, fontSize: 14, fontWeight: '500' },

  copyBtn: { backgroundColor: c.primary + '20', borderRadius: 12, padding: 14, alignItems: 'center', marginTop: 16, borderWidth: 1, borderColor: c.primary + '40' },
  copyBtnTxt: { color: c.primary, fontSize: 14, fontWeight: '600' },

  // Password generator
  passModal: { flex: 1, backgroundColor: '#000000AA', justifyContent: 'center', padding: 24 },
  passCard: { backgroundColor: c.glassSoft, borderRadius: 20, padding: 24, borderWidth: 1, borderColor: c.glassStroke },
  passTitle: { color: c.text, fontSize: 18, fontWeight: '700', marginBottom: 16, textAlign: 'center' },
  passDisplay: { backgroundColor: c.bg, borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: c.glassStroke },
  passText: { color: c.primary, fontSize: 16, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', textAlign: 'center' },
  passActions: { flexDirection: 'row', gap: 10 },
  passBtn: { flex: 1, backgroundColor: c.purple, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  passBtnTxt: { color: '#FFF', fontSize: 14, fontWeight: '600' },

  // Trash
  trashCard: { backgroundColor: c.glassSoft, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: c.danger + '30' },
  trashTitle: { color: c.text, fontSize: 15, fontWeight: '600' },
  trashDate: { color: c.textDim, fontSize: 12, marginTop: 2 },
  trashRestore: { backgroundColor: c.primary + '15', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 6 },
  trashDelete: { backgroundColor: c.danger + '15', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 6 },
});
