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

import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import { brandAlpha, type Palette } from '../constants/theme';
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
import { sealJson, openJson, encryptFileTo, decryptToTemp } from '../lib/scanVault';
import type { MediaKey } from '../lib/mediaCrypto';

/** Pre-encryption list: plaintext JSON. Read once, migrated, then removed. */
const LEGACY_RECENT_KEY = 'vc_docscanner_recent';
/** The recent list, sealed under the scan key (titles are private too). */
const RECENT_KEY = 'vc_docscanner_recent_v2';
const SCAN_DIR = `${FileSystem.documentDirectory}VaultScans/`;

const DOC_TYPES = [
  { id: 'invoice', label: 'Invoice', icon: '🧾' },
  { id: 'contract', label: 'Contract', icon: '📝' },
  { id: 'letter', label: 'Letter', icon: '✉️' },
  { id: 'report', label: 'Report', icon: '📊' },
  { id: 'id', label: 'ID Scan', icon: '🪪' },
  { id: 'receipt', label: 'Receipt', icon: '🧾' },
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
  // A list that could not be read/opened is an error, not "no documents".
  const [recentError, setRecentError] = useState(false);
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
  useEffect(() => () => { runRef.current++; }, []);

  // Throws when the sealed list cannot be written: it holds every scan's key,
  // so a failed write must fail the caller rather than look saved.
  const persistRecent = async (docs: ScannedDoc[]) => {
    await AsyncStorage.setItem(RECENT_KEY, await sealJson(docs.slice(0, 20)));
    setRecentDocs(docs);
  };

  const loadRecent = async () => {
    setRecentError(false);
    try {
      const sealed = await AsyncStorage.getItem(RECENT_KEY);
      if (sealed) {
        const docs = await openJson<ScannedDoc[]>(sealed);
        if (!docs) throw new Error('recent list could not be opened');
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
        await AsyncStorage.setItem(RECENT_KEY, await sealJson(docs.slice(0, 20)));
      } catch (e) {
        // The new keys were never saved: drop the unreadable .vcs copies and
        // keep the plaintext + legacy list so the next open retries.
        for (const m of migrated) if (m.plain) FileSystem.deleteAsync(m.doc.pdfUri, { idempotent: true }).catch(() => {});
        throw e;
      }
      // Keys are saved; only now is the plaintext safe to remove.
      for (const m of migrated) if (m.plain) await FileSystem.deleteAsync(m.plain, { idempotent: true }).catch(() => {});
      await AsyncStorage.removeItem(LEGACY_RECENT_KEY);
      setRecentDocs(docs);
    } catch {
      setRecentError(true);
    }
  };

  useEffect(() => {
    Animated.timing(fadeIn, { toValue: 1, duration: 400, useNativeDriver: true }).start();
    loadRecent();
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
        setImageUris(scannedImages.map(p => (p.startsWith('file://') || p.startsWith('http') ? p : `file://${p}`)));
        setStep('type');
      }
    } catch (e: any) {
      // A user cancel is not an error; anything else gets fixed copy, never
      // the raw ML Kit / VisionKit message.
      if (/cancel/i.test(String(e?.message ?? ''))) return;
      console.warn('[docscanner] scan failed:', e?.message ?? e);
      Alert.alert('Scanner unavailable', 'The document scanner could not start on this device. You can pick photos from the gallery instead.');
    }
  };

  // Camera capture is the Scan Document button above (edge detection, crop,
  // multi-page); this is the gallery path only.
  const pickFromGallery = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ quality: 1, allowsMultipleSelection: true, mediaTypes: ['images'] });
      if (!result.canceled && result.assets?.length) {
        setImageUris(result.assets.map(a => a.uri));
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
      const sizeKb = plainInfo.exists && (plainInfo as any).size ? Math.max(1, Math.round((plainInfo as any).size / 1024)) : 0;
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
      await persistRecent([doc, ...recentDocs]);
      setCurrentDoc(doc);
      setProcessingProgress(100);
      setStep('preview');
    } catch (e: any) {
      if (stale()) {
        if (produced) FileSystem.deleteAsync(produced, { idempotent: true }).catch(() => {});
        return;
      }
      if (produced) FileSystem.deleteAsync(produced, { idempotent: true }).catch(() => {});
      console.warn('[docscanner] PDF build failed:', e?.message ?? e);
      Alert.alert('Could not save the PDF', 'The document could not be built and saved securely. Your pages are still selected — try Convert again.');
      setStep('type');
    }
  };

  const sharePdf = async (doc: ScannedDoc) => {
    if (!(await Sharing.isAvailableAsync())) { Alert.alert('Unavailable', 'Sharing is not available on this device.'); return; }
    let uri: string;
    try { uri = await plainCopy(doc); }
    catch { Alert.alert('Could not open document', 'This scan could not be decrypted on this device.'); return; }
    // The receiving app may still be reading the copy after the sheet closes,
    // so it is left for the vt_ boot/logout sweep rather than deleted here.
    try { await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: doc.title }); }
    catch { /* user dismissed */ }
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
      router.push({ pathname: '/chat' as any, params: { id: targetChatId } });
    } catch (e: any) {
      console.warn('[docscanner] send failed:', e?.message ?? e);
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
          await persistRecent(recentDocs.filter(d => d.id !== doc.id));
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
      <Animated.View style={{ flex: 1, opacity: fadeIn }}>
        <View style={S.header}>
          <TouchableOpacity hitSlop={4} accessibilityRole="button" accessibilityLabel="Back" onPress={() => step === 'pick' ? router.back() : resetScanner()} style={S.backBtn}>
            <Ionicons name="arrow-back" size={24} color={colors.primary} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={S.title} accessibilityRole="header">Doc Scanner</Text>
            <Text style={{ color: colors.textFaint, fontSize: 12, letterSpacing: 2 }}>PHOTO → PDF DOCUMENT</Text>
          </View>
        </View>

        <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>

          {/* STEP 1: Pick photo */}
          {step === 'pick' && (
            <View style={{ gap: 16 }}>
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <TouchableOpacity onPress={scanDoc} style={{ flex: 1 }} accessibilityRole="button" accessibilityLabel="Scan document">
                  <LinearGradient colors={['#4338CA', '#312E81']} style={S.sourceBtn}>
                    <Ionicons name="scan-outline" size={40} color="#fff" />
                    <Text style={{ color: '#fff', fontSize: 14, fontWeight: '900', marginTop: 8 }}>Scan Document</Text>
                    <Text style={{ color: '#FFFFFF', fontSize: 12, marginTop: 4, textAlign: 'center' }}>Auto edge-detect, crop & multi-page</Text>
                  </LinearGradient>
                </TouchableOpacity>
                <TouchableOpacity onPress={pickFromGallery} style={{ flex: 1 }} accessibilityRole="button" accessibilityLabel="Pick photos from gallery">
                  <LinearGradient colors={['#1D4ED8', '#1E40AF']} style={S.sourceBtn}>
                    <Ionicons name="images-outline" size={40} color="#fff" />
                    <Text style={{ color: '#fff', fontSize: 14, fontWeight: '900', marginTop: 8 }}>From Gallery</Text>
                    <Text style={{ color: '#FFFFFF', fontSize: 12, marginTop: 4, textAlign: 'center' }}>Pick one or more photos</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </View>

              <View style={S.tipsCard}>
                <Text style={{ color: colors.primary, fontSize: 13, fontWeight: '800', marginBottom: 12 }}>📸 For best results</Text>
                {[
                  '✓ Place the document on a flat, dark surface',
                  '✓ Ensure all corners are visible',
                  '✓ Use good lighting, avoid shadows',
                  '✓ Multiple pages: pick several photos at once',
                ].map((tip, i) => (
                  <Text key={i} style={{ color: colors.textDim, fontSize: 12, lineHeight: 22 }}>{tip}</Text>
                ))}
              </View>

              {recentError && (
                <View style={S.tipsCard}>
                  <Text style={{ color: colors.text, fontSize: 13, fontWeight: '700' }}>Couldn’t load your recent documents</Text>
                  <TouchableOpacity onPress={loadRecent} style={{ marginTop: 10, alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' }}
                    accessibilityRole="button" accessibilityLabel="Retry loading recent documents">
                    <Text style={{ color: colors.accentOn, fontSize: 13, fontWeight: '800' }}>Retry</Text>
                  </TouchableOpacity>
                </View>
              )}

              {recentDocs.length > 0 && (
                <View style={{ gap: 10 }}>
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
                      <Text style={{ fontSize: 26 }} importantForAccessibility="no" accessibilityElementsHidden>{DOC_TYPES.find(d => d.id === doc.type)?.icon || '📄'}</Text>
                      <View style={{ flex: 1, minWidth: 120 }}>
                        <Text style={{ color: colors.text, fontSize: 13, fontWeight: '700' }} numberOfLines={1}>{doc.title}</Text>
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                          <Text style={{ color: colors.textFaint, fontSize: 12 }}>{fmtTime(doc.createdAt)}</Text>
                          <Text style={{ color: colors.textFaint, fontSize: 12 }}>·</Text>
                          <Text style={{ color: colors.textFaint, fontSize: 12 }}>{doc.pages} page{doc.pages > 1 ? 's' : ''}</Text>
                          <Text style={{ color: colors.textFaint, fontSize: 12 }}>·</Text>
                          <Text style={{ color: colors.textFaint, fontSize: 12 }}>{fmtSize(doc.sizeKb)}</Text>
                        </View>
                      </View>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14, alignItems: 'center', marginLeft: 'auto' }}>
                        <Pressable onPress={() => sendOrPick(doc)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Send ${doc.title}`}>
                          <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '800' }}>Send</Text>
                        </Pressable>
                        <Pressable onPress={() => sharePdf(doc)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Share ${doc.title}`}>
                          <Text style={{ color: colors.textDim, fontSize: 12, fontWeight: '800' }}>Share</Text>
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
            <View style={{ gap: 16 }}>
              <Text style={S.sectionLabel}>{imageUris.length} PAGE{imageUris.length > 1 ? 'S' : ''} SELECTED · WHAT IS THIS?</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                {DOC_TYPES.map(type => (
                  <TouchableOpacity key={type.id} onPress={() => setSelectedType(type.id)} style={[S.typeCard, selectedType === type.id && { borderColor: colors.primary, backgroundColor: colors.primary + '15' }]}
                    accessibilityRole="radio" accessibilityLabel={type.label} accessibilityState={{ selected: selectedType === type.id }}>
                    <Text style={{ fontSize: 28 }} importantForAccessibility="no" accessibilityElementsHidden>{type.icon}</Text>
                    <Text style={{ color: selectedType === type.id ? colors.primary : colors.text, fontSize: 12, fontWeight: '700', marginTop: 6 }}>{type.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View>
                <Text style={S.sectionLabel}>DOCUMENT TITLE (OPTIONAL)</Text>
                <TextInput value={customTitle} onChangeText={setCustomTitle} placeholder="e.g. Invoice #2024-041" placeholderTextColor={colors.textFaint} style={S.input}
                  accessibilityLabel="Document title, optional" />
              </View>
              <TouchableOpacity onPress={processToPdf} accessibilityRole="button" accessibilityLabel="Convert to PDF">
                <LinearGradient colors={[colors.accentDeep, colors.accentDeep]} style={{ borderRadius: 18, paddingVertical: 18, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 10 }}>
                  <Ionicons name="document-text-outline" size={20} color="#fff" />
                  <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>Convert to PDF</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          )}

          {/* STEP 3: Processing (real progress, page by page) */}
          {step === 'processing' && (
            <View style={{ gap: 20, alignItems: 'center', paddingTop: 30 }}
              accessible accessibilityRole="progressbar" accessibilityLabel={processingPhase}
              accessibilityValue={{ min: 0, max: 100, now: Math.floor(processingProgress) }}>
              <Ionicons name="document-text-outline" size={56} color={colors.primary} />
              <View style={{ width: '100%', gap: 10 }}>
                <View style={{ height: 6, backgroundColor: colors.glassStroke, borderRadius: 3, overflow: 'hidden' }}>
                  <View style={{ width: (processingProgress + '%') as any, height: 6, backgroundColor: colors.primary, borderRadius: 3 }} />
                </View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '700' }}>{processingPhase}</Text>
                  <Text style={{ color: colors.textFaint, fontSize: 12 }}>{Math.floor(processingProgress)}%</Text>
                </View>
              </View>
            </View>
          )}

          {/* STEP 4: Preview (real first page) */}
          {step === 'preview' && currentDoc && (
            <View style={{ gap: 16 }}>
              <View style={S.successBanner}>
                <Ionicons name="checkmark-circle" size={36} color={colors.success} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.accent, fontSize: 15, fontWeight: '900' }}>PDF ready</Text>
                  <Text style={{ color: colors.textDim, fontSize: 12, marginTop: 2 }}>{currentDoc.pages} page{currentDoc.pages > 1 ? 's' : ''} · {fmtSize(currentDoc.sizeKb)}</Text>
                </View>
              </View>

              {imageUris[0] && (
                <View style={S.docPreviewLarge}>
                  <Image source={{ uri: imageUris[0] }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />
                </View>
              )}

              <View style={{ flexDirection: 'row', gap: 10 }}>
                <TouchableOpacity onPress={() => sharePdf(currentDoc)} style={{ flex: 1, flexDirection: 'row', gap: 6, justifyContent: 'center', backgroundColor: brandAlpha(0.1), borderRadius: 16, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: brandAlpha(0.3) }}
                  accessibilityRole="button" accessibilityLabel="Share PDF">
                  <Ionicons name="share-outline" size={16} color={colors.accentOn} />
                  <Text style={{ color: colors.accentOn, fontWeight: '800', fontSize: 13 }}>Share PDF</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => sendOrPick(currentDoc)} disabled={busy} style={{ flex: 1 }}
                  accessibilityRole="button" accessibilityLabel={chatId ? 'Send in chat' : 'Send to chat'}
                  accessibilityState={{ disabled: busy, busy }}>
                  <LinearGradient colors={[colors.accentDeep, colors.accentDeep]} style={{ borderRadius: 16, paddingVertical: 14, alignItems: 'center', flexDirection: 'row', gap: 6, justifyContent: 'center' }}>
                    {busy ? <ActivityIndicator color="#fff" size="small" /> : <Ionicons name="send" size={14} color="#fff" />}
                    <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>{chatId ? 'Send in Chat' : 'Send to chat'}</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </View>
              <TouchableOpacity onPress={resetScanner} style={{ alignItems: 'center', paddingVertical: 8, minHeight: 44, justifyContent: 'center' }}
                accessibilityRole="button" accessibilityLabel="Scan another document">
                <Text style={{ color: colors.textFaint, fontSize: 13 }}>Scan another document</Text>
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
        <Pressable style={S.sheetBackdrop} onPress={() => setPickerDoc(null)} accessibilityRole="button" accessibilityLabel="Close chat picker">
          <Pressable style={[S.sheet, { paddingBottom: insets.bottom + 18 }]} onPress={e => e.stopPropagation()} accessible={false}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={[S.sheetTitle, { flex: 1 }]} accessibilityRole="header">Send to…</Text>
              <TouchableOpacity onPress={() => setPickerDoc(null)} hitSlop={10} style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
                accessibilityRole="button" accessibilityLabel="Close">
                <Ionicons name="close" size={22} color={colors.textDim} />
              </TouchableOpacity>
            </View>
            {pickerDoc && (
              <Text style={S.sheetSub} numberOfLines={1}>
                📄 {pickerDoc.filename || `${pickerDoc.title}.pdf`}
              </Text>
            )}
            {chatsLoading ? (
              <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} />
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
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function DocScannerScreen() {
  return (
    <ErrorBoundary fallbackTitle="Doc Scanner Error" fallbackMessage="Document scanner had a problem.">
      <DocScannerContent />
    </ErrorBoundary>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingTop: HEADER_TOP, paddingBottom: 14, gap: 10 },
  title: { color: c.text, fontSize: 20, fontWeight: '900' },
  backBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: c.glassSoft, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: c.glassStroke },
  sectionLabel: { color: c.textDim, fontSize: 12, fontWeight: '800', letterSpacing: 2, marginBottom: 8 },
  sourceBtn: { borderRadius: 20, paddingVertical: 28, alignItems: 'center', paddingHorizontal: 16 },
  tipsCard: { backgroundColor: c.glassSoft, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: c.glassStroke },
  docRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', backgroundColor: c.glassSoft, borderRadius: 14, padding: 14, gap: 12, borderWidth: 1, borderColor: c.glassStroke },
  typeCard: { width: '30%', flex: 1, minWidth: 100, backgroundColor: c.glassSoft, borderRadius: 16, padding: 14, alignItems: 'center', borderWidth: 1.5, borderColor: c.glassStroke },
  input: { backgroundColor: c.glassSoft, borderRadius: 14, padding: 15, color: c.text, fontSize: 14, borderWidth: 1, borderColor: c.glassStroke },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    maxHeight: '70%', backgroundColor: c.card, borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingTop: 18, paddingHorizontal: 18, gap: 4,
    borderTopWidth: 1, borderColor: c.border,
  },
  sheetTitle: { color: c.text, fontSize: 17, fontWeight: '900' },
  sheetSub: { color: c.textDim, fontSize: 12, marginBottom: 10 },
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
