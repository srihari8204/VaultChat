import { AppText as Text } from '../components/ui/Text';
import { AuroraBackground } from '../components/ui';
// app/docscanner.tsx — real photo → PDF document scanner.
//
// Pick/capture one or more photos → resize each (expo-image-manipulator) →
// assemble a real multi-page PDF (expo-print) → share it (expo-sharing) or send
// it into a chat as a file attachment. Recent docs are the real PDFs produced on
// this device, encrypted at rest (lib/scanVault: AES-256-GCM, install key in
// SecureStore); plaintext exists only as a short-lived cache copy for Share/Send.
// No fake OCR, no simulated progress.

import { Ionicons } from '@expo/vector-icons';
import { BRAND_GRADIENT_CTA, brandAlpha, type Palette } from '../constants/theme';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState, useMemo } from 'react';
import { ActivityIndicator, Alert, Animated, FlatList, Image, Modal, Pressable, ScrollView, StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../lib/theme';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { enqueueMedia } from '../lib/mediaOutbox';
import { listChats, chatTitle, type ChatSummary } from '../lib/chatService';
import DocumentScanner from 'react-native-document-scanner-plugin';
import { docFilename, DEFAULT_STYLE } from '../lib/docs/docStyle';
import { sealJson, openJson, encryptFileTo, decryptToTemp, SCAN_RECENT_KEY } from '../lib/scanVault';
import { updateRecent, serialQueue, RecentListUnavailable, type RecentStore } from '../lib/media/scanRecent';
import type { MediaKey } from '../lib/mediaCrypto';

/** Pre-encryption list: plaintext JSON. Read once, migrated, then removed. */
const LEGACY_RECENT_KEY = 'vc_docscanner_recent';
/** The recent list, sealed under the scan key (titles are private too). */
const RECENT_KEY = SCAN_RECENT_KEY;
/** Every read-modify-write of the stored list (load + migration, save,
 *  delete, reset) runs through this one queue, so a delete computed from an
 *  older read can never land after a newer save, and two migrations never
 *  overlap. Module-level: shared by every mounted scanner. */
const recentQueue = serialQueue();
const SCAN_DIR = `${FileSystem.documentDirectory}VaultScans/`;

const DOC_TYPES: { id: string; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { id: 'invoice', label: 'Invoice', icon: 'receipt-outline' },
  { id: 'contract', label: 'Contract', icon: 'create-outline' },
  { id: 'letter', label: 'Letter', icon: 'mail-outline' },
  { id: 'report', label: 'Report', icon: 'bar-chart-outline' },
  { id: 'id', label: 'ID Scan', icon: 'id-card-outline' },
  { id: 'receipt', label: 'Receipt', icon: 'cart-outline' },
];
const TIPS = [
  'Place the document on a flat, dark surface',
  'Ensure all corners are visible',
  'Use good lighting, avoid shadows',
  'Multiple pages: pick several photos at once',
];

interface ScannedDoc {
  id: string;
  type: string;
  title: string;
  createdAt: number;
  pages: number;
  pdfUri: string;
  sizeKb: number;
  /** The document's real name (used for Share/Send). Absent on scans saved before it was kept. */
  filename?: string;
  /** Present when pdfUri is the ENCRYPTED file (VaultScans/<id>.vcs). */
  mk?: MediaKey;
}

/** Encrypt a legacy plaintext scan: write <id>.vcs and return the encrypted
 *  doc plus the plaintext path. The plaintext is NOT deleted here: its new key
 *  only exists in memory until the sealed list is saved, so the caller deletes
 *  it after that save succeeds. On any failure the plaintext doc is returned
 *  unchanged. */
async function migrateDoc(doc: ScannedDoc): Promise<{ doc: ScannedDoc; plain?: string }> {
  if (doc.mk) return { doc };
  try {
    if (!(await FileSystem.getInfoAsync(doc.pdfUri)).exists) return { doc };
    await FileSystem.makeDirectoryAsync(SCAN_DIR, { intermediates: true });
    const enc = `${SCAN_DIR}${doc.id}.vcs`;
    const mk = await encryptFileTo(doc.pdfUri, enc);
    return { doc: { ...doc, pdfUri: enc, mk, filename: doc.filename || doc.pdfUri.split('/').pop() }, plain: doc.pdfUri };
  } catch {
    return { doc };
  }
}

function DocScannerContent() {
  const S = useS();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { chatId } = useLocalSearchParams<{ chatId?: string }>();

  const [step, setStep] = useState<'pick' | 'type' | 'processing' | 'preview'>('pick');
  const [imageUris, setImageUris] = useState<string[]>([]);
  const [selectedType, setSelectedType] = useState('');
  const [customTitle, setCustomTitle] = useState('');
  const [processingProgress, setProcessingProgress] = useState(0);
  const [processingPhase, setProcessingPhase] = useState('');
  const [recentDocs, setRecentDocs] = useState<ScannedDoc[]>([]);
  // A list that could not be read is an error, not "no documents". 'read' may
  // pass on Retry (also shown while legacy scans still await migration);
  // 'locked' (the list exists but its key cannot open it — the data is
  // damaged) never will; 'keyLost' (the key read back empty while the list
  // exists — keychain cleared, or a transient miss) may on Retry, and the key
  // is never replaced while the list exists (lib/scanVault).
  const [recentError, setRecentError] = useState<null | 'read' | 'locked' | 'keyLost'>(null);
  const [sharing, setSharing] = useState(false);
  const [currentDoc, setCurrentDoc] = useState<ScannedDoc | null>(null);
  const [busy, setBusy] = useState(false);
  // Chat picker. The scanner is reachable only from Mini apps, which has no
  // chat context, so "send this scan to someone" needs to ask WHICH chat —
  // the same shape as Forward in app/chat.tsx.
  const [pickerDoc, setPickerDoc] = useState<ScannedDoc | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chatsLoading, setChatsLoading] = useState(false);

  const fadeIn = useRef(new Animated.Value(0)).current;
  // Conversion run id. Back (resetScanner) and unmount bump it, so a
  // conversion still in flight stops at its next step instead of forcing the
  // screen back to 'preview' and saving a document the user walked away from.
  const runRef = useRef(0);
  // Page images from the scanner and the picker are plaintext copies in the
  // app cache. Once a document is built — or abandoned — they are deleted.
  const pageFiles = useRef<string[]>([]);
  const dropPageFiles = () => {
    for (const u of pageFiles.current) FileSystem.deleteAsync(u, { idempotent: true }).catch(() => {});
    pageFiles.current = [];
  };
  useEffect(() => () => { runRef.current++; dropPageFiles(); }, []);

  // Every change to the sealed list re-reads it and applies the change to
  // what is STORED (lib/media/scanRecent), never to this screen's copy: after
  // a failed load that copy is [], and saving it would drop every older
  // scan's key. Throws when the list cannot be read or written, so a failed
  // save fails the caller rather than looking saved.
  const recentStore = useMemo<RecentStore<ScannedDoc>>(() => ({
    readSealed: () => AsyncStorage.getItem(RECENT_KEY),
    hasLegacy: async () => (await AsyncStorage.getItem(LEGACY_RECENT_KEY)) != null,
    open: sealed => openJson<ScannedDoc[]>(sealed),
    write: async docs => { await AsyncStorage.setItem(RECENT_KEY, await sealJson(docs)); },
  }), []);
  const changeRecent = (change: (stored: ScannedDoc[]) => ScannedDoc[]) => recentQueue(async () => {
    try {
      setRecentDocs(await updateRecent(recentStore, change));
      setRecentError(null);
    } catch (e) {
      // Show the start page's way out: Reset ('locked'), Retry + Reset
      // ('keyLost'), or Retry, which re-runs a pending migration ('legacy').
      if (e instanceof RecentListUnavailable) setRecentError(e.reason === 'legacy' ? 'read' : e.reason);
      throw e;
    }
  });

  // One load at a time: a double-tapped Retry must not start a second
  // migration (two would encrypt the same <id>.vcs under different keys).
  const loadingRef = useRef(false);
  const loadRecent = async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setRecentError(null);
    try { await recentQueue(loadRecentNow); } finally { loadingRef.current = false; }
  };
  const loadRecentNow = async () => {
    try {
      const sealed = await AsyncStorage.getItem(RECENT_KEY);
      if (sealed) {
        const docs = await openJson<ScannedDoc[]>(sealed);
        if (!docs) { setRecentError('locked'); return; }
        setRecentDocs(docs);
        return;
      }
      // One-time migration from the plaintext list + plaintext PDFs.
      const legacy = await AsyncStorage.getItem(LEGACY_RECENT_KEY);
      if (!legacy) return;
      const migrated: { doc: ScannedDoc; plain?: string }[] = [];
      for (const d of JSON.parse(legacy) as ScannedDoc[]) migrated.push(await migrateDoc(d));
      const docs = migrated.map(m => m.doc);
      try {
        await AsyncStorage.setItem(RECENT_KEY, await sealJson(docs));
      } catch (e) {
        // The new keys were never saved: drop the unreadable .vcs copies and
        // keep the plaintext + legacy list so the next open retries. Awaited,
        // so a queued Retry cannot write a new <id>.vcs this then deletes.
        await Promise.all(migrated.filter(m => m.plain).map(m => FileSystem.deleteAsync(m.doc.pdfUri, { idempotent: true }).catch(() => {})));
        throw e;
      }
      // Keys are saved, and each .vcs was decrypt-checked against its source
      // by encryptFileTo; only now is the plaintext safe to remove.
      for (const m of migrated) if (m.plain) await FileSystem.deleteAsync(m.plain, { idempotent: true }).catch(() => {});
      await AsyncStorage.removeItem(LEGACY_RECENT_KEY);
      setRecentDocs(docs);
    } catch (e: unknown) {
      setRecentError(e instanceof RecentListUnavailable && e.reason === 'keyLost' ? 'keyLost' : 'read');
    }
  };

  // The way out of a list that can never be opened: its keys are gone, so the
  // encrypted scans it lists are unreadable too. Confirmed, because it deletes.
  const resetRecent = () => {
    Alert.alert(
      'Reset recent documents?',
      (recentError === 'keyLost'
        ? 'Only do this if Retry did not help: resetting is permanent, and your saved scans could open again if the missing key comes back. '
        : 'The saved scans on this device can no longer be opened. ')
        + 'Resetting removes the list and those unreadable files. New scans will save normally.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Reset', style: 'destructive', onPress: async () => {
          try {
            await recentQueue(async () => {
              await AsyncStorage.removeItem(RECENT_KEY);
              await FileSystem.deleteAsync(SCAN_DIR, { idempotent: true }).catch(() => {});
            });
            setRecentDocs([]);
            setRecentError(null);
          } catch {
            Alert.alert('Could not reset', 'The list could not be removed. Please try again.');
          }
        } },
      ],
    );
  };

  useEffect(() => {
    Animated.timing(fadeIn, { toValue: 1, duration: 400, useNativeDriver: true }).start();
    loadRecent();
    // Mount-only: loadRecent guards itself and runs through recentQueue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fadeIn]);

  /** A plaintext copy to hand to Share/Send: decrypted into a vt_ cache dir
   *  (swept at boot/logout) for encrypted scans, the file itself for a legacy
   *  scan whose migration failed. */
  const plainCopy = (doc: ScannedDoc) =>
    doc.mk ? decryptToTemp(doc.pdfUri, doc.mk, doc.filename || `${doc.title}.pdf`) : Promise.resolve(doc.pdfUri);

  // ML Kit / VisionKit document scanner — live edge detection, auto-capture,
  // perspective-correct crop, filters (auto/grayscale/color) and multi-page.
  // Returns already-cropped page images; we then assemble the PDF as before.
  const scanDoc = async () => {
    try {
      const { scannedImages } = await DocumentScanner.scanDocument({ maxNumDocuments: 15, croppedImageQuality: 90 });
      if (scannedImages?.length) {
        const uris = scannedImages.map(p => (p.startsWith('file://') || p.startsWith('http') ? p : `file://${p}`));
        dropPageFiles();
        pageFiles.current = uris;   // the scanner's own output: ours to delete
        setImageUris(uris);
        setStep('type');
      }
    } catch (e: unknown) {
      // A user cancel is not an error; anything else gets fixed copy, never
      // the raw ML Kit / VisionKit message.
      const msg = e instanceof Error ? e.message : String(e);
      if (/cancel/i.test(msg)) return;
      console.warn('[docscanner] scan failed:', msg);
      Alert.alert('Scanner unavailable', 'The document scanner could not start on this device. You can pick photos from the gallery instead.');
    }
  };

  // Camera capture is the Scan Document button above (edge detection, crop,
  // multi-page); this is the gallery path only.
  const pickFromGallery = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ quality: 1, allowsMultipleSelection: true, mediaTypes: ['images'] });
      if (!result.canceled && result.assets?.length) {
        const uris = result.assets.map(a => a.uri);
        dropPageFiles();
        // The picker hands back copies in the app cache (the photos in the
        // gallery are untouched); only those copies are deleted later.
        pageFiles.current = uris.filter(u => !!FileSystem.cacheDirectory && u.startsWith(FileSystem.cacheDirectory));
        setImageUris(uris);
        setStep('type');
      }
    } catch {
      Alert.alert('Could not open gallery', 'Please try again.');
    }
  };

  // Real conversion: resize each page, embed as JPEG in HTML, render to PDF.
  const processToPdf = async () => {
    if (!selectedType) { Alert.alert('Select Type', 'Please select a document type.'); return; }
    if (!imageUris.length) { Alert.alert('No pages', 'Pick at least one photo.'); return; }
    const docType = DOC_TYPES.find(d => d.id === selectedType);
    const title = customTitle.trim() || `${docType?.label} ${new Date().toLocaleDateString()}`;

    const run = ++runRef.current;
    const stale = () => run !== runRef.current;
    setStep('processing');
    setProcessingProgress(4);
    setProcessingPhase('Preparing pages…');
    let produced: string | null = null;
    try {
      const pages: string[] = [];
      for (let i = 0; i < imageUris.length; i++) {
        if (stale()) return;
        setProcessingPhase(`Processing page ${i + 1} of ${imageUris.length}…`);
        const m = await ImageManipulator.manipulateAsync(
          imageUris[i],
          [{ resize: { width: 1240 } }],
          { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG, base64: true },
        );
        pages.push(`<div style="page-break-after:always;text-align:center;"><img src="data:image/jpeg;base64,${m.base64}" style="width:100%;height:auto;"/></div>`);
        setProcessingProgress(Math.round(((i + 1) / imageUris.length) * 80));
      }
      setProcessingPhase('Building PDF…');
      setProcessingProgress(90);
      const html = `<html><head><meta name="viewport" content="width=device-width"/></head><body style="margin:0;padding:0;">${pages.join('')}</body></html>`;
      if (stale()) return;
      const { uri } = await Print.printToFileAsync({ html });
      produced = uri;
      if (stale()) { FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {}); return; }

      // Print writes into the CACHE directory, which Android may evict, and
      // in plaintext. The kept copy is ENCRYPTED into documentDirectory
      // (VaultScans/<id>.vcs, a name that says nothing about the document) and
      // the print output is deleted. Failing to encrypt fails the save rather
      // than silently keeping a plaintext copy; the pages are still selected,
      // so Convert can simply be tried again.
      // The title the user typed still becomes the document's name wherever it
      // is shared or sent — docFilename is the same helper the camera's scan
      // mode uses, so both scanners name a document identically.
      const filename = docFilename(title, DEFAULT_STYLE, new Date());
      const plainInfo = await FileSystem.getInfoAsync(uri);
      const sizeKb = plainInfo.exists && plainInfo.size ? Math.max(1, Math.round(plainInfo.size / 1024)) : 0;
      const id = Date.now().toString();
      await FileSystem.makeDirectoryAsync(SCAN_DIR, { intermediates: true });
      const pdfUri = `${SCAN_DIR}${id}.vcs`;
      const mk = await encryptFileTo(uri, pdfUri);
      produced = pdfUri;
      FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      if (stale()) { FileSystem.deleteAsync(pdfUri, { idempotent: true }).catch(() => {}); return; }

      const doc: ScannedDoc = {
        id, type: selectedType, title,
        createdAt: Date.now(), pages: imageUris.length, pdfUri, sizeKb, filename, mk,
      };
      // Persist BEFORE showing "PDF ready": the sealed list is the only place
      // the scan's key is kept, so a failed save is a failed scan (the catch
      // below deletes the unreadable .vcs and says so).
      await changeRecent(stored => [doc, ...stored.filter(d => d.id !== doc.id)]);
      // Saved (it is in the recent list now); Back during the save means the
      // user left this flow, so do not jump to "PDF ready".
      if (stale()) return;
      setCurrentDoc(doc);
      setProcessingProgress(100);
      setStep('preview');
    } catch (e: unknown) {
      if (stale()) {
        if (produced) FileSystem.deleteAsync(produced, { idempotent: true }).catch(() => {});
        return;
      }
      if (produced) FileSystem.deleteAsync(produced, { idempotent: true }).catch(() => {});
      console.warn('[docscanner] PDF build failed:', e instanceof Error ? e.message : e);
      if (e instanceof RecentListUnavailable) {
        // Saving now would replace a list holding older scans' keys.
        Alert.alert('Scan not saved', e.reason === 'locked'
          ? 'Your recent documents list can’t be opened on this device, and saving this scan would replace it. Reset the list on the Doc Scanner start page, then scan again.'
          : e.reason === 'keyLost'
            ? 'The key that opens your recent documents is missing on this device, and saving this scan would replace it. Tap Retry on the Doc Scanner start page; if that does not help, reset the list. Then scan again.'
            : 'Your earlier documents haven’t finished moving to secure storage, and saving this scan now could lose them. Tap Retry on the Doc Scanner start page, then scan again.');
      } else {
        Alert.alert('Could not save the PDF', 'The document could not be built and saved securely. Your pages are still selected — try Convert again.');
      }
      setStep('type');
    }
  };

  // One share at a time: each tap decrypts a fresh plaintext copy.
  const sharePdf = async (doc: ScannedDoc) => {
    if (sharing) return;
    setSharing(true);
    try {
      if (!(await Sharing.isAvailableAsync())) { Alert.alert('Unavailable', 'Sharing is not available on this device.'); return; }
      let uri: string;
      try { uri = await plainCopy(doc); }
      catch { Alert.alert('Could not open document', 'This scan could not be decrypted on this device.'); return; }
      // The receiving app may still be reading the copy after the sheet closes,
      // so it is left for the vt_ boot/logout sweep rather than deleted here.
      try { await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: doc.title }); }
      catch { /* user dismissed */ }
    } finally {
      setSharing(false);
    }
  };

  // Hand the scan to the DURABLE media outbox, exactly like every send site in
  // app/chat.tsx. This used to await sendMediaMessage inline behind a spinner:
  // scanning on a weak signal blocked the screen for the whole upload and threw
  // the document away if it failed, with no retry and no restart recovery.
  // enqueueMedia copies the PDF into its own storage first, so the send now
  // survives going offline, navigating away, and force-quitting the app — and
  // the chat bubble shows Preparing…/Uploading% like any other attachment.
  // Opened FROM a chat (chatId in params) → send straight there. Opened from
  // Mini apps → ask which chat. Before this, the second case silently fell back
  // to the share sheet, so a scan could never reach a conversation at all and
  // the button just read "Save".
  const sendOrPick = (doc: ScannedDoc) => {
    if (chatId) { sendToChat(doc, chatId); return; }
    openChatPicker(doc);
  };

  const openChatPicker = async (doc: ScannedDoc) => {
    setPickerDoc(doc);
    setChatsLoading(true);
    try {
      setChats(await listChats());
    } catch {
      // listChats is a network call; offline it throws. Say so and close,
      // rather than leaving an empty sheet that looks like "you have no chats".
      Alert.alert('Could not load chats', 'Check your connection and try again.');
      setPickerDoc(null);
    } finally {
      setChatsLoading(false);
    }
  };

  const sendToChat = async (doc: ScannedDoc, targetChatId: string) => {
    setPickerDoc(null);
    setBusy(true);
    let temp: string | null = null;
    try {
      const uri = await plainCopy(doc);
      if (uri !== doc.pdfUri) temp = uri;
      // enqueueMedia copies the file into the outbox before resolving, so the
      // decrypted temp can go as soon as it returns.
      await enqueueMedia(targetChatId, 'file', {
        uri,
        filename: doc.filename || `${doc.title}.pdf`,
        mime: 'application/pdf',
      });
      // Open the chat rather than just going back: the send is durable but
      // asynchronous, and "did it actually go?" is exactly the doubt this
      // screen used to leave people with. chat.tsx adopts pending outbox items
      // on focus, so the bubble is already there with its upload progress.
      router.push({ pathname: '/chat', params: { id: targetChatId } });
    } catch (e: unknown) {
      console.warn('[docscanner] send failed:', e instanceof Error ? e.message : e);
      Alert.alert('Could not send', 'The document could not be prepared for sending. Please try again.');
    } finally {
      if (temp) FileSystem.deleteAsync(temp.slice(0, temp.lastIndexOf('/') + 1), { idempotent: true }).catch(() => {});
      setBusy(false);
    }
  };

  const deleteRecent = (doc: ScannedDoc) => {
    Alert.alert('Delete document?', `Remove ${doc.title}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try {
          await changeRecent(stored => stored.filter(d => d.id !== doc.id));
        } catch {
          Alert.alert('Could not delete', 'The document list could not be saved. Please try again.');
          return;
        }
        FileSystem.deleteAsync(doc.pdfUri, { idempotent: true }).catch(() => {});
      } },
    ]);
  };

  const resetScanner = () => {
    runRef.current++;   // abandon any conversion in flight
    dropPageFiles();
    setStep('pick'); setSelectedType(''); setCustomTitle('');
    setProcessingProgress(0); setCurrentDoc(null); setImageUris([]);
  };

  const fmtTime = (ts: number) => {
    const d = Date.now() - ts;
    if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
    if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
    return Math.floor(d / 86400000) + 'd ago';
  };
  const fmtSize = (kb: number) => kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB';

  return (
    <View style={S.container}>
      <AuroraBackground />
      <Animated.View style={[S.flex, { opacity: fadeIn }]}>
        <View style={S.header}>
          <TouchableOpacity hitSlop={4} accessibilityRole="button" accessibilityLabel="Back" onPress={() => step === 'pick' ? router.back() : resetScanner()} style={S.backBtn}>
            <Ionicons name="arrow-back" size={24} color={colors.primary} />
          </TouchableOpacity>
          <View style={S.flex}>
            <Text style={S.title} accessibilityRole="header">Doc Scanner</Text>
            <Text style={S.subtitle}>PHOTO → PDF DOCUMENT</Text>
          </View>
        </View>

        <ScrollView contentContainerStyle={S.scroll} showsVerticalScrollIndicator={false}>

          {/* STEP 1: Pick photo */}
          {step === 'pick' && (
            <View style={S.stack16}>
              <View style={S.row12}>
                <TouchableOpacity onPress={scanDoc} style={S.flex} accessibilityRole="button" accessibilityLabel="Scan document">
                  <LinearGradient colors={BRAND_GRADIENT_CTA} style={S.sourceBtn}>
                    <Ionicons name="scan-outline" size={40} color={colors.onPrimary} />
                    <Text style={S.sourceTitle}>Scan Document</Text>
                    <Text style={S.sourceBody}>Auto edge-detect, crop & multi-page</Text>
                  </LinearGradient>
                </TouchableOpacity>
                <TouchableOpacity onPress={pickFromGallery} style={S.flex} accessibilityRole="button" accessibilityLabel="Pick photos from gallery">
                  <LinearGradient colors={[colors.accentDeep, colors.accentDeep]} style={S.sourceBtn}>
                    <Ionicons name="images-outline" size={40} color={colors.onPrimary} />
                    <Text style={S.sourceTitle}>From Gallery</Text>
                    <Text style={S.sourceBody}>Pick one or more photos</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </View>

              <View style={S.tipsCard}>
                <Text style={S.tipsTitle} accessibilityRole="header">For best results</Text>
                {TIPS.map(tip => (
                  <View key={tip} style={S.tipRow}>
                    <Ionicons name="checkmark" size={14} color={colors.success} importantForAccessibility="no" />
                    <Text style={S.tipTxt}>{tip}</Text>
                  </View>
                ))}
              </View>

              {recentError && (
                <View style={S.tipsCard} accessibilityLiveRegion="polite">
                  <Text style={S.errTitle}>
                    {recentError === 'locked'
                      ? 'Your recent documents can’t be opened on this device anymore'
                      : recentError === 'keyLost'
                        ? 'The key that opens your recent documents is missing on this device'
                        : 'Couldn’t load your recent documents'}
                  </Text>
                  {recentError === 'keyLost' && (
                    <Text style={S.errBody}>New scans can’t be saved until this is solved. Try Retry first; reset only if the key does not come back.</Text>
                  )}
                  {recentError !== 'locked' && (
                    <TouchableOpacity onPress={loadRecent} style={S.errBtn}
                      accessibilityRole="button" accessibilityLabel="Retry loading recent documents">
                      <Text style={S.errBtnTxt}>Retry</Text>
                    </TouchableOpacity>
                  )}
                  {recentError !== 'read' && (
                    <TouchableOpacity onPress={resetRecent} style={S.errBtn}
                      accessibilityRole="button" accessibilityLabel="Reset recent documents">
                      <Text style={S.errBtnTxt}>Reset list</Text>
                    </TouchableOpacity>
                  )}
                </View>
              )}

              {recentDocs.length > 0 && (
                <View style={S.stack10}>
                  <Text style={S.sectionLabel}>RECENT DOCUMENTS</Text>
                  {recentDocs.map((doc) => (
                    <TouchableOpacity key={doc.id} style={S.docRow} onPress={() => sharePdf(doc)} onLongPress={() => deleteRecent(doc)}
                      accessibilityRole="button" accessibilityLabel={`${doc.title}, ${doc.pages} page${doc.pages > 1 ? 's' : ''}. Share`}
                      accessibilityActions={[{ name: 'send', label: 'Send to chat' }, { name: 'share', label: 'Share' }, { name: 'delete', label: 'Delete' }]}
                      onAccessibilityAction={(e) => {
                        const a = e.nativeEvent.actionName;
                        if (a === 'delete') deleteRecent(doc);
                        else if (a === 'send') sendOrPick(doc);
                        else if (a === 'share') sharePdf(doc);
                      }}>
                      <Ionicons name={DOC_TYPES.find(d => d.id === doc.type)?.icon ?? 'document-outline'} size={26}
                        color={colors.primary} importantForAccessibility="no" />
                      <View style={S.docInfo}>
                        <Text style={S.docTitle} numberOfLines={1}>{doc.title}</Text>
                        <View style={S.docMetaRow}>
                          <Text style={S.docMeta}>{fmtTime(doc.createdAt)}</Text>
                          <Text style={S.docMeta}>·</Text>
                          <Text style={S.docMeta}>{doc.pages} page{doc.pages > 1 ? 's' : ''}</Text>
                          <Text style={S.docMeta}>·</Text>
                          <Text style={S.docMeta}>{fmtSize(doc.sizeKb)}</Text>
                        </View>
                      </View>
                      <View style={S.docActions}>
                        <Pressable onPress={() => sendOrPick(doc)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Send ${doc.title}`}>
                          <Text style={S.docSend}>Send</Text>
                        </Pressable>
                        <Pressable onPress={() => sharePdf(doc)} hitSlop={8} disabled={sharing} accessibilityRole="button"
                          accessibilityLabel={`Share ${doc.title}`} accessibilityState={{ disabled: sharing, busy: sharing }}>
                          <Text style={S.docShare}>Share</Text>
                        </Pressable>
                        <Pressable onPress={() => deleteRecent(doc)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Delete ${doc.title}`}>
                          <Ionicons name="trash-outline" size={16} color={colors.danger} />
                        </Pressable>
                      </View>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>
          )}

          {/* STEP 2: Select type */}
          {step === 'type' && (
            <View style={S.stack16}>
              <Text style={S.sectionLabel}>{imageUris.length} PAGE{imageUris.length > 1 ? 'S' : ''} SELECTED · WHAT IS THIS?</Text>
              <View style={S.typeGrid} accessibilityRole="radiogroup">
                {DOC_TYPES.map(type => {
                  const on = selectedType === type.id;
                  return (
                    <TouchableOpacity key={type.id} onPress={() => setSelectedType(type.id)} style={[S.typeCard, on && S.typeCardOn]}
                      accessibilityRole="radio" accessibilityLabel={type.label} accessibilityState={{ selected: on }}>
                      <Ionicons name={type.icon} size={28} color={on ? colors.primary : colors.textDim} importantForAccessibility="no" />
                      <Text style={[S.typeLabel, on && S.typeLabelOn]}>{type.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <View>
                <Text style={S.sectionLabel}>DOCUMENT TITLE (OPTIONAL)</Text>
                <TextInput value={customTitle} onChangeText={setCustomTitle} placeholder="e.g. Invoice #2024-041" placeholderTextColor={colors.textFaint} style={S.input}
                  accessibilityLabel="Document title, optional" />
              </View>
              <TouchableOpacity onPress={processToPdf} accessibilityRole="button" accessibilityLabel="Convert to PDF">
                <LinearGradient colors={[colors.accentDeep, colors.accentDeep]} style={S.convertBtn}>
                  <Ionicons name="document-text-outline" size={20} color={colors.onPrimary} />
                  <Text style={S.convertTxt}>Convert to PDF</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          )}

          {/* STEP 3: Processing (real progress, page by page) */}
          {step === 'processing' && (
            <View style={S.progressBox}
              accessible accessibilityRole="progressbar" accessibilityLabel={processingPhase}
              accessibilityValue={{ min: 0, max: 100, now: Math.floor(processingProgress) }}>
              <Ionicons name="document-text-outline" size={56} color={colors.primary} />
              <View style={S.progressInner}>
                <View style={S.progressTrack}>
                  <View style={[S.progressFill, { width: `${processingProgress}%` }]} />
                </View>
                <View style={S.progressRow}>
                  <Text style={S.progressPhase}>{processingPhase}</Text>
                  <Text style={S.progressPct}>{Math.floor(processingProgress)}%</Text>
                </View>
              </View>
            </View>
          )}

          {/* STEP 4: Preview (real first page) */}
          {step === 'preview' && currentDoc && (
            <View style={S.stack16}>
              <View style={S.successBanner} accessibilityLiveRegion="polite">
                <Ionicons name="checkmark-circle" size={36} color={colors.success} />
                <View style={S.flex}>
                  <Text style={S.readyTitle}>PDF ready</Text>
                  <Text style={S.readyMeta}>{currentDoc.pages} page{currentDoc.pages > 1 ? 's' : ''} · {fmtSize(currentDoc.sizeKb)}</Text>
                </View>
              </View>

              {imageUris[0] && (
                <View style={S.docPreviewLarge}>
                  <Image source={{ uri: imageUris[0] }} style={S.fillImg} resizeMode="contain"
                    accessible accessibilityRole="image" accessibilityLabel="First page" />
                </View>
              )}

              <View style={S.row10}>
                <TouchableOpacity onPress={() => sharePdf(currentDoc)} disabled={sharing} style={S.shareBtn}
                  accessibilityRole="button" accessibilityLabel="Share PDF" accessibilityState={{ disabled: sharing, busy: sharing }}>
                  {sharing ? <ActivityIndicator color={colors.accentOn} size="small" />
                    : <Ionicons name="share-outline" size={16} color={colors.accentOn} />}
                  <Text style={S.shareTxt}>Share PDF</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => sendOrPick(currentDoc)} disabled={busy} style={S.flex}
                  accessibilityRole="button" accessibilityLabel={chatId ? 'Send in chat' : 'Send to chat'}
                  accessibilityState={{ disabled: busy, busy }}>
                  <LinearGradient colors={[colors.accentDeep, colors.accentDeep]} style={S.sendBtn}>
                    {busy ? <ActivityIndicator color={colors.onPrimary} size="small" /> : <Ionicons name="send" size={14} color={colors.onPrimary} />}
                    <Text style={S.sendTxt}>{chatId ? 'Send in Chat' : 'Send to chat'}</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </View>
              <TouchableOpacity onPress={resetScanner} style={S.againBtn}
                accessibilityRole="button" accessibilityLabel="Scan another document">
                <Text style={S.againTxt}>Scan another document</Text>
              </TouchableOpacity>
            </View>
          )}

        </ScrollView>
      </Animated.View>

      {/* Which chat? Same shape as Forward in app/chat.tsx, deliberately —
          two pickers that behave differently is a worse outcome than a little
          repeated markup. */}
      <Modal
        visible={pickerDoc != null}
        transparent
        animationType="slide"
        onRequestClose={() => setPickerDoc(null)}
      >
        {/* The backdrop is a sibling of the sheet, not its parent: an
            accessible button wrapping the sheet hid the chat rows from VoiceOver. */}
        <View style={S.sheetBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setPickerDoc(null)} accessibilityRole="button" accessibilityLabel="Close chat picker" />
          <View style={[S.sheet, { paddingBottom: insets.bottom + 18 }]} accessibilityViewIsModal>
            <View style={S.sheetHead}>
              <Text style={[S.sheetTitle, S.flex]} accessibilityRole="header">Send to…</Text>
              <TouchableOpacity onPress={() => setPickerDoc(null)} hitSlop={10} style={S.sheetClose}
                accessibilityRole="button" accessibilityLabel="Close">
                <Ionicons name="close" size={22} color={colors.textDim} />
              </TouchableOpacity>
            </View>
            {pickerDoc && (
              <View style={S.sheetSubRow}>
                <Ionicons name="document-outline" size={14} color={colors.textDim} importantForAccessibility="no" />
                <Text style={S.sheetSub} numberOfLines={1}>{pickerDoc.filename || `${pickerDoc.title}.pdf`}</Text>
              </View>
            )}
            {chatsLoading ? (
              <ActivityIndicator color={colors.primary} style={S.sheetSpinner} />
            ) : chats.length === 0 ? (
              <Text style={S.sheetEmpty}>No chats yet</Text>
            ) : (
              <FlatList
                data={chats}
                keyExtractor={c => c.id}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={S.sheetRow}
                    onPress={() => pickerDoc && sendToChat(pickerDoc, item.id)}
                    activeOpacity={0.7}
                    accessibilityRole="button" accessibilityLabel={`Send to ${chatTitle(item)}`}
                  >
                    <Text style={S.sheetRowTxt} numberOfLines={1}>{chatTitle(item)}</Text>
                    <Text style={S.sheetRowSub}>{item.type}</Text>
                  </TouchableOpacity>
                )}
              />
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

function useS() {
  const { colors } = useTheme();
  const { top } = useSafeAreaInsets();
  return useMemo(() => makeStyles(colors, top), [colors, top]);
}

export default function DocScannerScreen() {
  return (
    <ErrorBoundary fallbackTitle="Doc Scanner Error" fallbackMessage="Document scanner had a problem.">
      <DocScannerContent />
    </ErrorBoundary>
  );
}

const makeStyles = (c: Palette, insetTop: number) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingTop: insetTop + 8, paddingBottom: 14, gap: 10 },
  title: { color: c.text, fontSize: 20, fontWeight: '900' },
  subtitle: { color: c.textFaint, fontSize: 12, letterSpacing: 2 },
  flex: { flex: 1 },
  scroll: { paddingHorizontal: 18, paddingBottom: 40 },
  stack16: { gap: 16 },
  stack10: { gap: 10 },
  row12: { flexDirection: 'row', gap: 12 },
  row10: { flexDirection: 'row', gap: 10 },
  sourceTitle: { color: c.onPrimary, fontSize: 14, fontWeight: '900', marginTop: 8 },
  sourceBody: { color: c.onPrimary, fontSize: 12, marginTop: 4, textAlign: 'center' },
  tipsTitle: { color: c.primary, fontSize: 13, fontWeight: '800', marginBottom: 12 },
  tipRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tipTxt: { color: c.textDim, fontSize: 12, lineHeight: 22, flex: 1 },
  errTitle: { color: c.text, fontSize: 13, fontWeight: '700' },
  errBody: { color: c.textDim, fontSize: 12, lineHeight: 18, marginTop: 6 },
  errBtn: { marginTop: 10, alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' },
  errBtnTxt: { color: c.accentOn, fontSize: 13, fontWeight: '800' },
  docInfo: { flex: 1, minWidth: 120 },
  docTitle: { color: c.text, fontSize: 13, fontWeight: '700' },
  docMetaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  docMeta: { color: c.textFaint, fontSize: 12 },
  docActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, alignItems: 'center', marginLeft: 'auto' },
  docSend: { color: c.primary, fontSize: 12, fontWeight: '800' },
  docShare: { color: c.textDim, fontSize: 12, fontWeight: '800' },
  typeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  typeCardOn: { borderColor: c.primary, backgroundColor: brandAlpha(0.08) },
  typeLabel: { color: c.text, fontSize: 12, fontWeight: '700', marginTop: 6 },
  typeLabelOn: { color: c.primary },
  convertBtn: { borderRadius: 18, paddingVertical: 18, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 10 },
  convertTxt: { color: c.onPrimary, fontSize: 16, fontWeight: '900' },
  progressBox: { gap: 20, alignItems: 'center', paddingTop: 30 },
  progressInner: { width: '100%', gap: 10 },
  progressTrack: { height: 6, backgroundColor: c.glassStroke, borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: 6, backgroundColor: c.primary, borderRadius: 3 },
  progressRow: { flexDirection: 'row', justifyContent: 'space-between' },
  progressPhase: { color: c.primary, fontSize: 12, fontWeight: '700' },
  progressPct: { color: c.textFaint, fontSize: 12 },
  readyTitle: { color: c.accentOn, fontSize: 15, fontWeight: '900' },
  readyMeta: { color: c.textDim, fontSize: 12, marginTop: 2 },
  fillImg: { width: '100%', height: '100%' },
  shareBtn: { flex: 1, flexDirection: 'row', gap: 6, justifyContent: 'center', backgroundColor: brandAlpha(0.1), borderRadius: 16, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: brandAlpha(0.3) },
  shareTxt: { color: c.accentOn, fontWeight: '800', fontSize: 13 },
  sendBtn: { borderRadius: 16, paddingVertical: 14, alignItems: 'center', flexDirection: 'row', gap: 6, justifyContent: 'center' },
  sendTxt: { color: c.onPrimary, fontWeight: '800', fontSize: 13 },
  againBtn: { alignItems: 'center', paddingVertical: 8, minHeight: 44, justifyContent: 'center' },
  againTxt: { color: c.textFaint, fontSize: 13 },
  sheetHead: { flexDirection: 'row', alignItems: 'center' },
  sheetClose: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  sheetSubRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  sheetSpinner: { marginTop: 24 },
  backBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: c.glassSoft, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: c.glassStroke },
  sectionLabel: { color: c.textDim, fontSize: 12, fontWeight: '800', letterSpacing: 2, marginBottom: 8 },
  sourceBtn: { borderRadius: 20, paddingVertical: 28, alignItems: 'center', paddingHorizontal: 16 },
  tipsCard: { backgroundColor: c.glassSoft, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: c.glassStroke },
  docRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', backgroundColor: c.glassSoft, borderRadius: 14, padding: 14, gap: 12, borderWidth: 1, borderColor: c.glassStroke },
  typeCard: { width: '30%', flex: 1, minWidth: 100, backgroundColor: c.glassSoft, borderRadius: 16, padding: 14, alignItems: 'center', borderWidth: 1.5, borderColor: c.glassStroke },
  input: { backgroundColor: c.glassSoft, borderRadius: 14, padding: 15, color: c.text, fontSize: 14, borderWidth: 1, borderColor: c.glassStroke },
  sheetBackdrop: { flex: 1, backgroundColor: c.scrim, justifyContent: 'flex-end' },
  sheet: {
    maxHeight: '70%', backgroundColor: c.card, borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingTop: 18, paddingHorizontal: 18, gap: 4,
    borderTopWidth: 1, borderColor: c.border,
  },
  sheetTitle: { color: c.text, fontSize: 17, fontWeight: '900' },
  sheetSub: { color: c.textDim, fontSize: 12, flexShrink: 1 },
  sheetEmpty: { color: c.textFaint, fontSize: 13, textAlign: 'center', paddingVertical: 28 },
  sheetRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: c.separator, gap: 12,
  },
  sheetRowTxt: { color: c.text, fontSize: 15, fontWeight: '700', flex: 1 },
  sheetRowSub: { color: c.textFaint, fontSize: 12, textTransform: 'uppercase' },
  successBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: brandAlpha(0.1), borderRadius: 16, padding: 16, gap: 14, borderWidth: 1, borderColor: brandAlpha(0.25) },
  docPreviewLarge: { height: 320, borderRadius: 16, borderWidth: 1, borderColor: c.glassStroke, overflow: 'hidden', backgroundColor: c.surfaceSolid },
});
