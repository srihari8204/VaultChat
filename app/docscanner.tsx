import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState , useMemo} from 'react';
import { Alert, Animated, Easing, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { ErrorBoundary } from '../components/ErrorBoundary';


const DOC_TYPES = [
  { id: 'invoice', label: 'Invoice', icon: '🧾', desc: 'Professional invoice or receipt' },
  { id: 'contract', label: 'Contract', icon: '📝', desc: 'Legal agreement or contract' },
  { id: 'letter', label: 'Letter', icon: '✉️', desc: 'Formal business letter' },
  { id: 'report', label: 'Report', icon: '📊', desc: 'Structured report or summary' },
  { id: 'id', label: 'ID Scan', icon: '🪪', desc: 'Identity document scan' },
  { id: 'receipt', label: 'Receipt', icon: '🧾', desc: 'Purchase receipt or expense' },
];

interface ScannedDoc {
  id: string;
  type: string;
  title: string;
  createdAt: number;
  pages: number;
  status: 'processing' | 'ready' | 'sent';
  encrypted: boolean;
}

function DocScannerContent() {
  const S = useS();
  const { colors } = useTheme();
  const router = useRouter();
  const [step, setStep] = useState<'pick'|'type'|'processing'|'preview'|'done'>('pick');
  const [selectedType, setSelectedType] = useState('');
  const [customTitle, setCustomTitle] = useState('');
  const [processingProgress, setProcessingProgress] = useState(0);
  const [processingPhase, setProcessingPhase] = useState('');
  const [recentDocs, setRecentDocs] = useState<ScannedDoc[]>([
    { id: '1', type: 'invoice', title: 'Invoice #2024-041', createdAt: Date.now() - 86400000, pages: 1, status: 'sent', encrypted: true },
    { id: '2', type: 'contract', title: 'Service Agreement', createdAt: Date.now() - 86400000 * 3, pages: 3, status: 'ready', encrypted: true },
  ]);
  const [currentDoc, setCurrentDoc] = useState<ScannedDoc | null>(null);

  const fadeIn = useRef(new Animated.Value(0)).current;
  const scanLine = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.timing(fadeIn, { toValue: 1, duration: 400, useNativeDriver: true }).start();
  }, [fadeIn]);

  const pickPhoto = async (source: 'camera' | 'gallery') => {
    try {
      let result;
      if (source === 'camera') {
        if (Platform.OS === 'web') {
          result = await ImagePicker.launchImageLibraryAsync({ quality: 1, allowsEditing: false });
        } else {
          result = await ImagePicker.launchCameraAsync({ quality: 1, allowsEditing: false });
        }
      } else {
        result = await ImagePicker.launchImageLibraryAsync({ quality: 1, allowsMultipleSelection: true });
      }
      if (!result.canceled) {
        setStep('type');
      }
    } catch {
      Alert.alert('Error', 'Could not open camera or gallery.');
    }
  };

  const startProcessing = () => {
    if (!selectedType) { Alert.alert('Select Type', 'Please select a document type.'); return; }
    const docType = DOC_TYPES.find(d => d.id === selectedType);
    const title = customTitle.trim() || docType?.label + ' ' + new Date().toLocaleDateString();
    const doc: ScannedDoc = {
      id: Date.now().toString(), type: selectedType, title,
      createdAt: Date.now(), pages: 1, status: 'processing', encrypted: true,
    };
    setCurrentDoc(doc);
    setStep('processing');
    setProcessingProgress(0);

    // Animate scan line
    Animated.loop(Animated.sequence([
      Animated.timing(scanLine, { toValue: 1, duration: 1500, easing: Easing.linear, useNativeDriver: false }),
      Animated.timing(scanLine, { toValue: 0, duration: 0, useNativeDriver: false }),
    ])).start();

    Animated.loop(Animated.sequence([
      Animated.timing(pulseAnim, { toValue: 1.04, duration: 800, useNativeDriver: true }),
      Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
    ])).start();

    const phases = [
      'Detecting document edges...',
      'Correcting perspective...',
      'Enhancing image quality...',
      'Running OCR text recognition...',
      'Applying professional formatting...',
      'Encrypting document...',
      'Finalizing PDF...',
    ];
    let p = 0; let phaseIdx = 0;
    const iv = setInterval(() => {
      p += Math.random() * 4 + 2;
      const cap = Math.min(p, 100);
      setProcessingProgress(cap);
      const idx = Math.min(Math.floor(cap / (100 / phases.length)), phases.length - 1);
      if (idx !== phaseIdx) { phaseIdx = idx; setProcessingPhase(phases[idx]); }
      if (p >= 100) {
        clearInterval(iv);
        scanLine.stopAnimation();
        setCurrentDoc(d => d ? { ...d, status: 'ready' } : null);
        setTimeout(() => setStep('preview'), 400);
      }
    }, 80);
  };

  const sendDoc = () => {
    if (currentDoc) {
      setRecentDocs(prev => [{ ...currentDoc, status: 'sent' }, ...prev]);
      setCurrentDoc(null);
      setStep('done');
    }
  };

  const resetScanner = () => {
    setStep('pick');
    setSelectedType('');
    setCustomTitle('');
    setProcessingProgress(0);
    setCurrentDoc(null);
  };

  const fmtTime = (ts: number) => {
    const d = Date.now() - ts;
    if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
    if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
    return Math.floor(d / 86400000) + 'd ago';
  };

  const scanLineY = scanLine.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

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
            <Text style={{ color: colors.textFaint, fontSize: 9, letterSpacing: 2 }}>PHOTO → PROFESSIONAL DOCUMENT</Text>
          </View>
        </View>

        {/* Step indicators */}
        <View style={{ flexDirection: 'row', paddingHorizontal: 18, gap: 6, marginBottom: 20 }}>
          {[{ s: 'pick', label: 'Scan' }, { s: 'type', label: 'Type' }, { s: 'processing', label: 'Convert' }, { s: 'preview', label: 'Preview' }].map((st, i, arr) => {
            const steps = ['pick', 'type', 'processing', 'preview', 'done'];
            const currentStepIdx = steps.indexOf(step);
            const thisStepIdx = steps.indexOf(st.s);
            const isDone = currentStepIdx > thisStepIdx;
            const isActive = currentStepIdx === thisStepIdx;
            return (
              <View key={i} style={{ flex: 1, alignItems: 'center', gap: 5 }}>
                <View style={[{ width: 28, height: 28, borderRadius: 14, justifyContent: 'center', alignItems: 'center', borderWidth: 1.5 }, isDone ? { backgroundColor: colors.accent, borderColor: colors.accent } : isActive ? { backgroundColor: colors.primary + '22', borderColor: colors.primary } : { backgroundColor: 'rgba(10,22,40,0.8)', borderColor: 'rgba(255,255,255,0.1)' }]}>
                  {isDone ? <Text style={{ color: '#fff', fontSize: 14, fontWeight: '900' }}>✓</Text> : <Text style={{ color: isActive ? colors.primary : colors.textFaint, fontSize: 11, fontWeight: '800' }}>{i + 1}</Text>}
                </View>
                <Text style={{ color: isActive ? colors.primary : isDone ? colors.accent : colors.textFaint, fontSize: 9, fontWeight: '700' }}>{st.label}</Text>
                {i < arr.length - 1 && <View style={{ position: 'absolute', top: 14, right: -6, width: 12, height: 1.5, backgroundColor: isDone ? colors.accent : 'rgba(255,255,255,0.1)' }} />}
              </View>
            );
          })}
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
                    <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 11, marginTop: 4, textAlign: 'center' }}>Use camera to scan document</Text>
                  </LinearGradient>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => pickPhoto('gallery')} style={{ flex: 1 }}>
                  <LinearGradient colors={['#1D4ED8', '#1E40AF']} style={S.sourceBtn}>
                    <Text style={{ fontSize: 40 }}>🖼️</Text>
                    <Text style={{ color: '#fff', fontSize: 14, fontWeight: '900', marginTop: 8 }}>From Gallery</Text>
                    <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 11, marginTop: 4, textAlign: 'center' }}>Pick existing photo</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </View>

              <View style={S.tipsCard}>
                <Text style={{ color: colors.primary, fontSize: 13, fontWeight: '800', marginBottom: 12 }}>📸 For Best Results</Text>
                {[
                  '✓ Place document on flat, dark surface',
                  '✓ Ensure all corners are visible',
                  '✓ Use good lighting, avoid shadows',
                  '✓ Hold camera directly above document',
                  '✓ Multiple pages: take separate photos',
                ].map((tip, i) => (
                  <Text key={i} style={{ color: colors.textDim, fontSize: 12, lineHeight: 22 }}>{tip}</Text>
                ))}
              </View>

              {recentDocs.length > 0 && (
                <View style={{ gap: 10 }}>
                  <Text style={S.sectionLabel}>RECENT DOCUMENTS</Text>
                  {recentDocs.map((doc, i) => (
                    <View key={i} style={S.docRow}>
                      <Text style={{ fontSize: 26 }}>{DOC_TYPES.find(d => d.id === doc.type)?.icon || '📄'}</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: colors.text, fontSize: 13, fontWeight: '700' }}>{doc.title}</Text>
                        <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
                          <Text style={{ color: colors.textFaint, fontSize: 10 }}>{fmtTime(doc.createdAt)}</Text>
                          <Text style={{ color: colors.textFaint, fontSize: 10 }}>·</Text>
                          <Text style={{ color: colors.textFaint, fontSize: 10 }}>{doc.pages} page{doc.pages > 1 ? 's' : ''}</Text>
                          {doc.encrypted && <Text style={{ color: colors.accent, fontSize: 10 }}>🔐</Text>}
                        </View>
                      </View>
                      <View style={[S.statusPill, { borderColor: doc.status === 'sent' ? colors.accent + '44' : colors.accent + '44', backgroundColor: doc.status === 'sent' ? colors.accent + '12' : colors.accent + '12' }]}>
                        <Text style={{ color: doc.status === 'sent' ? colors.accent : colors.accent, fontSize: 9, fontWeight: '800' }}>{doc.status.toUpperCase()}</Text>
                      </View>
                    </View>
                  ))}
                </View>
              )}
            </View>
          )}

          {/* STEP 2: Select document type */}
          {step === 'type' && (
            <View style={{ gap: 16 }}>
              <Text style={S.sectionLabel}>WHAT TYPE OF DOCUMENT IS THIS?</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                {DOC_TYPES.map(type => (
                  <TouchableOpacity key={type.id} onPress={() => setSelectedType(type.id)} style={[S.typeCard, selectedType === type.id && { borderColor: colors.primary, backgroundColor: colors.primary + '15' }]}>
                    <Text style={{ fontSize: 28 }}>{type.icon}</Text>
                    <Text style={{ color: selectedType === type.id ? colors.primary : colors.text, fontSize: 12, fontWeight: '700', marginTop: 6 }}>{type.label}</Text>
                    <Text style={{ color: colors.textFaint, fontSize: 9, marginTop: 2, textAlign: 'center' }}>{type.desc}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View>
                <Text style={S.sectionLabel}>DOCUMENT TITLE (OPTIONAL)</Text>
                <TextInput value={customTitle} onChangeText={setCustomTitle} placeholder="e.g. Invoice #2024-041" placeholderTextColor={colors.textFaint} style={S.input} />
              </View>
              <TouchableOpacity onPress={startProcessing}>
                <LinearGradient colors={[colors.primary, colors.textDim]} style={{ borderRadius: 18, paddingVertical: 18, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 10 }}>
                  <Text style={{ fontSize: 20 }}>⚡</Text>
                  <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>Convert to Document</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          )}

          {/* STEP 3: Processing */}
          {step === 'processing' && (
            <View style={{ gap: 20, alignItems: 'center' }}>
              <Animated.View style={[S.processingCard, { transform: [{ scale: pulseAnim }] }]}>
                <LinearGradient colors={[colors.primary + '18', colors.textDim + '12']} style={{ ...StyleSheet.absoluteFillObject, borderRadius:20 }} />
                {/* Simulated doc preview */}
                <View style={S.docPreview}>
                  <View style={{ height: 16, backgroundColor: 'rgba(74,159,255,0.3)', borderRadius: 4, marginBottom: 10, width: '60%' }} />
                  <View style={{ height: 8, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 3, marginBottom: 6 }} />
                  <View style={{ height: 8, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 3, marginBottom: 6, width: '85%' }} />
                  <View style={{ height: 8, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 3, marginBottom: 6 }} />
                  <View style={{ height: 8, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 3, marginBottom: 6, width: '70%' }} />
                  <View style={{ height: 40, backgroundColor: 'rgba(74,159,255,0.1)', borderRadius: 6, marginTop: 10, marginBottom: 10, borderWidth: 1, borderColor: 'rgba(74,159,255,0.2)' }} />
                  <View style={{ height: 8, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 3, marginBottom: 6 }} />
                  <View style={{ height: 8, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 3, width: '50%' }} />
                  {/* Scan line */}
                  <Animated.View style={{ position: 'absolute', left: 0, right: 0, top: scanLineY, height: 2, backgroundColor: colors.primary + '88' }} />
                </View>
              </Animated.View>

              <View style={{ flex: 1, gap: 10 }}>
                <View style={{ height: 6, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
                  <View style={{ width:(processingProgress+'%') as any, height: 6, backgroundColor: colors.primary, borderRadius: 3 }} />
                </View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '700' }}>{processingPhase}</Text>
                  <Text style={{ color: colors.textFaint, fontSize: 12 }}>{Math.floor(processingProgress)}%</Text>
                </View>
              </View>

              <View style={{ width: '100%', gap: 8 }}>
                {[
                  { label: 'Edge Detection', done: processingProgress > 15 },
                  { label: 'Perspective Correction', done: processingProgress > 30 },
                  { label: 'Image Enhancement', done: processingProgress > 50 },
                  { label: 'OCR Text Recognition', done: processingProgress > 65 },
                  { label: 'Professional Formatting', done: processingProgress > 80 },
                  { label: 'AES-256 Encryption', done: processingProgress > 95 },
                ].map((item, i) => (
                  <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: item.done ? colors.accent + '22' : 'rgba(255,255,255,0.05)', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: item.done ? colors.accent : 'rgba(255,255,255,0.08)' }}>
                      {item.done && <Text style={{ color: colors.accent, fontSize: 11, fontWeight: '900' }}>✓</Text>}
                    </View>
                    <Text style={{ color: item.done ? colors.text : colors.textFaint, fontSize: 12, fontWeight: item.done ? '600' : '400' }}>{item.label}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}

          {/* STEP 4: Preview */}
          {step === 'preview' && currentDoc && (
            <View style={{ gap: 16 }}>
              <View style={S.successBanner}>
                <Text style={{ fontSize: 36 }}>✅</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.accent, fontSize: 15, fontWeight: '900' }}>Document Ready!</Text>
                  <Text style={{ color: colors.textDim, fontSize: 12, marginTop: 2 }}>Converted and encrypted successfully</Text>
                </View>
              </View>

              <View style={S.docPreviewLarge}>
                <LinearGradient colors={['rgba(4,20,50,0.95)', 'rgba(2,14,38,0.95)']} style={{ ...StyleSheet.absoluteFillObject, borderRadius:16 }} />
                <View style={{ padding: 16 }}>
                  <Text style={{ color: colors.primary, fontSize: 14, fontWeight: '900', marginBottom: 12 }}>{currentDoc.title}</Text>
                  {Array.from({ length: 6 }).map((_, i) => (
                    <View key={i} style={{ height: 8, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 3, marginBottom: 8, width: ([100, 85, 92, 78, 95, 60][i] + '%') as any }} />
                  ))}
                  <View style={{ height: 50, backgroundColor: 'rgba(74,159,255,0.08)', borderRadius: 8, marginVertical: 12, borderWidth: 1, borderColor: 'rgba(74,159,255,0.15)' }} />
                  {Array.from({ length: 3 }).map((_, i) => (
                    <View key={i} style={{ height: 8, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 3, marginBottom: 8, width: ([88, 70, 45][i] + '%') as any }} />
                  ))}
                  <View style={{ position: 'absolute', bottom: 12, right: 12, flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                    <Text style={{ color: colors.accent, fontSize: 9 }}>🔐 AES-256</Text>
                  </View>
                </View>
              </View>

              <View style={S.metaRow}>
                {[
                  { label: 'Type', value: DOC_TYPES.find(d => d.id === currentDoc.type)?.label || '', icon: '📄' },
                  { label: 'Format', value: 'PDF', icon: '📑' },
                  { label: 'Pages', value: currentDoc.pages.toString(), icon: '📃' },
                  { label: 'Encrypted', value: 'AES-256', icon: '🔐' },
                ].map((m, i) => (
                  <View key={i} style={S.metaCard}>
                    <Text style={{ fontSize: 16 }}>{m.icon}</Text>
                    <Text style={{ color: colors.text, fontSize: 11, fontWeight: '700', marginTop: 4 }}>{m.value}</Text>
                    <Text style={{ color: colors.textFaint, fontSize: 9, marginTop: 2 }}>{m.label}</Text>
                  </View>
                ))}
              </View>

              <View style={{ flexDirection: 'row', gap: 10 }}>
                <TouchableOpacity onPress={() => { Alert.alert('Saved', currentDoc.title + ' saved to File Vault securely.'); setRecentDocs(p => [{ ...currentDoc, status: 'ready' }, ...p]); resetScanner(); }} style={{ flex: 1, backgroundColor: colors.accent + '18', borderRadius: 16, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: colors.accent + '44' }}>
                  <Text style={{ color: colors.accent, fontWeight: '800', fontSize: 13 }}>💾 Save to Vault</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={sendDoc} style={{ flex: 1 }}>
                  <LinearGradient colors={[colors.primary, colors.textDim]} style={{ borderRadius: 16, paddingVertical: 14, alignItems: 'center' }}>
                    <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>📤 Send in Chat</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Done */}
          {step === 'done' && (
            <View style={{ alignItems: 'center', gap: 20, paddingTop: 40 }}>
              <Text style={{ fontSize: 72 }}>🚀</Text>
              <Text style={{ color: colors.text, fontSize: 22, fontWeight: '900' }}>Document Sent!</Text>
              <Text style={{ color: colors.textDim, fontSize: 14, textAlign: 'center', lineHeight: 22 }}>Your encrypted document was shared securely via VaultChat.</Text>
              <TouchableOpacity onPress={resetScanner}>
                <LinearGradient colors={[colors.primary, colors.textDim]} style={{ borderRadius: 18, paddingVertical: 16, paddingHorizontal: 36 }}>
                  <Text style={{ color: '#fff', fontWeight: '900', fontSize: 15 }}>Scan Another Document</Text>
                </LinearGradient>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => router.back()}>
                <Text style={{ color: colors.textFaint, fontSize: 13 }}>Back to Chat</Text>
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
  const { colors } = useTheme();
  const S = useS();
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
  statusPill: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1 },
  typeCard: { width: '30%', flex: 1, minWidth: 100, backgroundColor: 'rgba(10,22,40,0.8)', borderRadius: 16, padding: 14, alignItems: 'center', borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.06)' },
  input: { backgroundColor: 'rgba(6,14,34,0.9)', borderRadius: 14, padding: 15, color: '#fff', fontSize: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  processingCard: { width: '100%', borderRadius: 20, padding: 20, borderWidth: 1, borderColor: 'rgba(74,159,255,0.2)', overflow: 'hidden', alignItems: 'center' },
  docPreview: { width: '85%', backgroundColor: 'rgba(2,11,24,0.9)', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: 'rgba(74,159,255,0.15)', overflow: 'hidden', position: 'relative' },
  successBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(16,185,129,0.1)', borderRadius: 16, padding: 16, gap: 14, borderWidth: 1, borderColor: 'rgba(16,185,129,0.25)' },
  docPreviewLarge: { height: 240, borderRadius: 16, borderWidth: 1, borderColor: 'rgba(74,159,255,0.2)', overflow: 'hidden', position: 'relative' },
  metaRow: { flexDirection: 'row', gap: 8 },
  metaCard: { flex: 1, backgroundColor: 'rgba(10,22,40,0.8)', borderRadius: 14, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' },
});
