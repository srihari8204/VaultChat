// app/docscanner.tsx — real photo → PDF document scanner.
//
// Pick/capture one or more photos → resize each (expo-image-manipulator) →
// assemble a real multi-page PDF (expo-print) → share it (expo-sharing) or send
// it into a chat as a file attachment. Recent docs are the real PDFs produced on
// this device. No fake OCR, no fabricated "AES-256" claim, no simulated progress.

import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState, useMemo } from 'react';
import { Alert, Animated, Image, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { sendMediaMessage } from '../lib/sendMedia';

const RECENT_KEY = 'vc_docscanner_recent';

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
}

function DocScannerContent() {
  const S = useS();
  const { colors } = useTheme();
  const router = useRouter();
  const { chatId } = useLocalSearchParams<{ chatId?: string }>();

  const [step, setStep] = useState<'pick' | 'type' | 'processing' | 'preview'>('pick');
  const [imageUris, setImageUris] = useState<string[]>([]);
  const [selectedType, setSelectedType] = useState('');
  const [customTitle, setCustomTitle] = useState('');
  const [processingProgress, setProcessingProgress] = useState(0);
  const [processingPhase, setProcessingPhase] = useState('');
  const [recentDocs, setRecentDocs] = useState<ScannedDoc[]>([]);
  const [currentDoc, setCurrentDoc] = useState<ScannedDoc | null>(null);
  const [busy, setBusy] = useState(false);

  const fadeIn = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeIn, { toValue: 1, duration: 400, useNativeDriver: true }).start();
    (async () => {
      try { const raw = await AsyncStorage.getItem(RECENT_KEY); if (raw) setRecentDocs(JSON.parse(raw)); } catch {}
    })();
  }, [fadeIn]);

  const persistRecent = async (docs: ScannedDoc[]) => {
    setRecentDocs(docs);
    try { await AsyncStorage.setItem(RECENT_KEY, JSON.stringify(docs.slice(0, 20))); } catch {}
  };

  const pickPhoto = async (source: 'camera' | 'gallery') => {
    try {
      let result;
      if (source === 'camera' && Platform.OS !== 'web') {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) { Alert.alert('Permission needed', 'Allow camera access to scan.'); return; }
        result = await ImagePicker.launchCameraAsync({ quality: 1, allowsEditing: false });
      } else {
        result = await ImagePicker.launchImageLibraryAsync({ quality: 1, allowsMultipleSelection: true, mediaTypes: ['images'] });
      }
      if (!result.canceled && result.assets?.length) {
        setImageUris(result.assets.map(a => a.uri));
        setStep('type');
      }
    } catch {
      Alert.alert('Error', 'Could not open camera or gallery.');
    }
  };

  // Real conversion: resize each page, embed as JPEG in HTML, render to PDF.
  const processToPdf = async () => {
    if (!selectedType) { Alert.alert('Select Type', 'Please select a document type.'); return; }
    if (!imageUris.length) { Alert.alert('No pages', 'Pick at least one photo.'); return; }
    const docType = DOC_TYPES.find(d => d.id === selectedType);
    const title = customTitle.trim() || `${docType?.label} ${new Date().toLocaleDateString()}`;

    setStep('processing');
    setProcessingProgress(4);
    setProcessingPhase('Preparing pages…');
    try {
      const pages: string[] = [];
      for (let i = 0; i < imageUris.length; i++) {
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
      const { uri } = await Print.printToFileAsync({ html });

      const info = await FileSystem.getInfoAsync(uri);
      const sizeKb = info.exists && (info as any).size ? Math.max(1, Math.round((info as any).size / 1024)) : 0;

      const doc: ScannedDoc = {
        id: Date.now().toString(), type: selectedType, title,
        createdAt: Date.now(), pages: imageUris.length, pdfUri: uri, sizeKb,
      };
      setCurrentDoc(doc);
      await persistRecent([doc, ...recentDocs]);
      setProcessingProgress(100);
      setStep('preview');
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Could not build the PDF.');
      setStep('type');
    }
  };

  const sharePdf = async (doc: ScannedDoc) => {
    if (!(await Sharing.isAvailableAsync())) { Alert.alert('Unavailable', 'Sharing is not available on this device.'); return; }
    try { await Sharing.shareAsync(doc.pdfUri, { mimeType: 'application/pdf', dialogTitle: doc.title }); }
    catch { /* user dismissed */ }
  };

  const sendToChat = async (doc: ScannedDoc) => {
    if (!chatId) { sharePdf(doc); return; }
    setBusy(true);
    try {
      await sendMediaMessage(chatId, 'file', { uri: doc.pdfUri, filename: `${doc.title}.pdf`, mime: 'application/pdf' });
      Alert.alert('Sent', 'Document sent to the chat.');
      router.back();
    } catch (e: any) {
      Alert.alert('Could not send', e?.message ?? 'Try again');
    } finally { setBusy(false); }
  };

  const deleteRecent = (doc: ScannedDoc) => {
    Alert.alert('Delete document?', `Remove ${doc.title}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        FileSystem.deleteAsync(doc.pdfUri, { idempotent: true }).catch(() => {});
        await persistRecent(recentDocs.filter(d => d.id !== doc.id));
      } },
    ]);
  };

  const resetScanner = () => {
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
      <LinearGradient colors={['#FFFFFF', '#040F20', '#060F24']} style={StyleSheet.absoluteFillObject} />
      <Animated.View style={{ flex: 1, opacity: fadeIn }}>
        <View style={S.header}>
          <TouchableOpacity onPress={() => step === 'pick' ? router.back() : resetScanner()} style={S.backBtn}>
            <Text style={{ color: colors.primary, fontSize: 18 }}>←</Text>
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={S.title}>📄 Doc Scanner</Text>
            <Text style={{ color: colors.textFaint, fontSize: 9, letterSpacing: 2 }}>PHOTO → PDF DOCUMENT</Text>
          </View>
        </View>

        <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>

          {/* STEP 1: Pick photo */}
          {step === 'pick' && (
            <View style={{ gap: 16 }}>
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <TouchableOpacity onPress={() => pickPhoto('camera')} style={{ flex: 1 }}>
                  <LinearGradient colors={[colors.primary, colors.textDim]} style={S.sourceBtn}>
                    <Text style={{ fontSize: 40 }}>📷</Text>
                    <Text style={{ color: '#fff', fontSize: 14, fontWeight: '900', marginTop: 8 }}>Take Photo</Text>
                    <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 11, marginTop: 4, textAlign: 'center' }}>Use camera to scan a page</Text>
                  </LinearGradient>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => pickPhoto('gallery')} style={{ flex: 1 }}>
                  <LinearGradient colors={['#1D4ED8', '#1E40AF']} style={S.sourceBtn}>
                    <Text style={{ fontSize: 40 }}>🖼️</Text>
                    <Text style={{ color: '#fff', fontSize: 14, fontWeight: '900', marginTop: 8 }}>From Gallery</Text>
                    <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 11, marginTop: 4, textAlign: 'center' }}>Pick one or more photos</Text>
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

              {recentDocs.length > 0 && (
                <View style={{ gap: 10 }}>
                  <Text style={S.sectionLabel}>RECENT DOCUMENTS</Text>
                  {recentDocs.map((doc) => (
                    <TouchableOpacity key={doc.id} style={S.docRow} onPress={() => sharePdf(doc)} onLongPress={() => deleteRecent(doc)}>
                      <Text style={{ fontSize: 26 }}>{DOC_TYPES.find(d => d.id === doc.type)?.icon || '📄'}</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: colors.text, fontSize: 13, fontWeight: '700' }} numberOfLines={1}>{doc.title}</Text>
                        <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
                          <Text style={{ color: colors.textFaint, fontSize: 10 }}>{fmtTime(doc.createdAt)}</Text>
                          <Text style={{ color: colors.textFaint, fontSize: 10 }}>·</Text>
                          <Text style={{ color: colors.textFaint, fontSize: 10 }}>{doc.pages} page{doc.pages > 1 ? 's' : ''}</Text>
                          <Text style={{ color: colors.textFaint, fontSize: 10 }}>·</Text>
                          <Text style={{ color: colors.textFaint, fontSize: 10 }}>{fmtSize(doc.sizeKb)}</Text>
                        </View>
                      </View>
                      <Text style={{ color: colors.primary, fontSize: 11, fontWeight: '800' }}>Share</Text>
                    </TouchableOpacity>
                  ))}
                  <Text style={{ color: colors.textFaint, fontSize: 10, textAlign: 'center' }}>Long-press a document to delete it</Text>
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
                  <TouchableOpacity key={type.id} onPress={() => setSelectedType(type.id)} style={[S.typeCard, selectedType === type.id && { borderColor: colors.primary, backgroundColor: colors.primary + '15' }]}>
                    <Text style={{ fontSize: 28 }}>{type.icon}</Text>
                    <Text style={{ color: selectedType === type.id ? colors.primary : colors.text, fontSize: 12, fontWeight: '700', marginTop: 6 }}>{type.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View>
                <Text style={S.sectionLabel}>DOCUMENT TITLE (OPTIONAL)</Text>
                <TextInput value={customTitle} onChangeText={setCustomTitle} placeholder="e.g. Invoice #2024-041" placeholderTextColor={colors.textFaint} style={S.input} />
              </View>
              <TouchableOpacity onPress={processToPdf}>
                <LinearGradient colors={[colors.primary, colors.textDim]} style={{ borderRadius: 18, paddingVertical: 18, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 10 }}>
                  <Text style={{ fontSize: 20 }}>⚡</Text>
                  <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>Convert to PDF</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          )}

          {/* STEP 3: Processing (real progress, page by page) */}
          {step === 'processing' && (
            <View style={{ gap: 20, alignItems: 'center', paddingTop: 30 }}>
              <Text style={{ fontSize: 56 }}>📄</Text>
              <View style={{ width: '100%', gap: 10 }}>
                <View style={{ height: 6, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
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
                <Text style={{ fontSize: 36 }}>✅</Text>
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
                <TouchableOpacity onPress={() => sharePdf(currentDoc)} style={{ flex: 1, backgroundColor: colors.accent + '18', borderRadius: 16, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: colors.accent + '44' }}>
                  <Text style={{ color: colors.accent, fontWeight: '800', fontSize: 13 }}>📤 Share PDF</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => sendToChat(currentDoc)} disabled={busy} style={{ flex: 1 }}>
                  <LinearGradient colors={[colors.primary, colors.textDim]} style={{ borderRadius: 16, paddingVertical: 14, alignItems: 'center' }}>
                    <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>{chatId ? '📨 Send in Chat' : '💾 Save'}</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </View>
              <TouchableOpacity onPress={resetScanner} style={{ alignItems: 'center', paddingVertical: 8 }}>
                <Text style={{ color: colors.textFaint, fontSize: 13 }}>Scan another document</Text>
              </TouchableOpacity>
            </View>
          )}

        </ScrollView>
      </Animated.View>
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
  container: { flex: 1, backgroundColor: '#FFFFFF' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingTop: 50, paddingBottom: 14, gap: 10 },
  title: { color: '#fff', fontSize: 20, fontWeight: '900' },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(10,22,40,0.8)', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' },
  sectionLabel: { color: 'rgba(255,255,255,0.22)', fontSize: 9, fontWeight: '800', letterSpacing: 2, marginBottom: 8 },
  sourceBtn: { borderRadius: 20, paddingVertical: 28, alignItems: 'center', paddingHorizontal: 16 },
  tipsCard: { backgroundColor: 'rgba(10,22,40,0.8)', borderRadius: 16, padding: 16, borderWidth: 1, borderColor: 'rgba(74,159,255,0.12)' },
  docRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(10,22,40,0.8)', borderRadius: 14, padding: 14, gap: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' },
  typeCard: { width: '30%', flex: 1, minWidth: 100, backgroundColor: 'rgba(10,22,40,0.8)', borderRadius: 16, padding: 14, alignItems: 'center', borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.06)' },
  input: { backgroundColor: 'rgba(6,14,34,0.9)', borderRadius: 14, padding: 15, color: '#fff', fontSize: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  successBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(16,185,129,0.1)', borderRadius: 16, padding: 16, gap: 14, borderWidth: 1, borderColor: 'rgba(16,185,129,0.25)' },
  docPreviewLarge: { height: 320, borderRadius: 16, borderWidth: 1, borderColor: 'rgba(74,159,255,0.2)', overflow: 'hidden', backgroundColor: 'rgba(2,11,24,0.9)' },
});
