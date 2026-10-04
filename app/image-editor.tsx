import { AppText as Text } from '../components/ui/Text';
import { AuroraBackground } from '../components/ui';
// app/image-editor.tsx — Image Editor before sending
// Crop, Rotate, Draw, Text overlay, Filters, Brightness/Contrast
// Uses expo-image-manipulator for transforms, react-native-view-shot to capture

import { BRAND_ACCENT, type Palette } from '../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import React, { useState, useRef , useMemo} from 'react';
import {
  View, TouchableOpacity, StyleSheet, Image, ScrollView,
  PanResponder, type PanResponderInstance, TextInput, Alert, ActivityIndicator,
  Platform, useWindowDimensions } from 'react-native';
import { useTheme } from '../lib/theme';
import { useRouter, useLocalSearchParams, Stack } from 'expo-router';
import { returnParams } from '../lib/camera/cameraMode';
import * as ImageManipulator from 'expo-image-manipulator';
import ViewShot from 'react-native-view-shot';


const DRAW_COLORS = ['#FFFFFF', '#FF3C3C', '#4A9FFF', BRAND_ACCENT, '#FBBF24'];
const COLOR_NAMES: Record<string, string> = {
  '#FFFFFF': 'white', '#FF3C3C': 'red', '#4A9FFF': 'blue', [BRAND_ACCENT]: 'brand blue', '#FBBF24': 'yellow',
};
const FILTER_LIST = ['Original', 'B&W', 'Warm', 'Cool', 'Vivid'];
const CROP_RATIOS = [
  { label: 'Free', value: null },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '16:9', value: 16 / 9 },
];

type DrawLine = { points: { x: number; y: number }[]; color: string; width: number };
type TextOverlay = { id: string; text: string; x: number; y: number; color: string; fontSize: number };

type ToolMode = 'none' | 'crop' | 'rotate' | 'draw' | 'text' | 'filter' | 'adjust';

function useS() {
  // Reactive size. The module-level Dimensions.get above is captured ONCE at
  // import and never updates, so it froze the layout at the size the app
  // launched with. Shadowing it here makes every use in this component follow
  // rotation; StyleSheet.create keeps the initial value, which is fine for
  // static rules.
  const {width: SW, height: SH} = useWindowDimensions();

  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors, SW, SH), [colors, SW, SH]);
}

export default function ImageEditorScreen() {
  // Live metrics owned by THIS component — the hook further up belongs to the
  // useS() style helper, a different scope. Follows rotation and folds.
  const { width: SW, height: SH } = useWindowDimensions();

  const { colors } = useTheme();
  const styles = useS();
  const router = useRouter();
  const { uri, chatId, peerUid, peerName, returnTo } = useLocalSearchParams<{
    uri: string; chatId?: string; peerUid?: string; peerName?: string; returnTo?: string;
  }>();
  const viewShotRef = useRef<any>(null);

  // Image state
  const [imageUri, setImageUri] = useState(uri || '');
  const [rotation, setRotation] = useState(0);
  const [processing, setProcessing] = useState(false);

  // Tool mode
  const [activeMode, setActiveMode] = useState<ToolMode>('none');

  // Crop
  const [cropRatio, setCropRatio] = useState<number | null>(null);

  // Draw
  const [lines, setLines] = useState<DrawLine[]>([]);
  const [currentLine, setCurrentLine] = useState<DrawLine | null>(null);
  const [drawColor, setDrawColor] = useState('#FFFFFF');
  const [brushSize, setBrushSize] = useState(3);

  // Text overlays
  const [textOverlays, setTextOverlays] = useState<TextOverlay[]>([]);
  const [editingText, setEditingText] = useState('');
  const [textColor, setTextColor] = useState('#FFFFFF');
  const [textFontSize, setTextFontSize] = useState(24);

  // Filters
  const [activeFilter, setActiveFilter] = useState('Original');

  // Adjustments
  const [brightness, setBrightness] = useState(0);
  const [contrast, setContrast] = useState(0);

  // The PanResponders below are created once, so they read live values from
  // refs. Reading state there captured the first render: every stroke came
  // out white at size 3 whatever was picked.
  const drawColorRef = useRef(drawColor);
  drawColorRef.current = drawColor;
  const brushSizeRef = useRef(brushSize);
  brushSizeRef.current = brushSize;
  const overlaysRef = useRef(textOverlays);
  overlaysRef.current = textOverlays;

  // ── Drawing PanResponder ──
  const drawPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        const { locationX, locationY } = e.nativeEvent;
        setCurrentLine({ points: [{ x: locationX, y: locationY }], color: drawColorRef.current, width: brushSizeRef.current });
      },
      onPanResponderMove: (e) => {
        const { locationX, locationY } = e.nativeEvent;
        setCurrentLine(prev => prev ? { ...prev, points: [...prev.points, { x: locationX, y: locationY }] } : prev);
      },
      onPanResponderRelease: () => {
        setCurrentLine(prev => {
          if (prev) setLines(l => [...l, prev]);
          return null;
        });
      },
    })
  ).current;

  // ── Rotate ──
  const handleRotate = async () => {
    if (processing) return;   // a second tap would rotate the stale uri again
    setProcessing(true);
    try {
      const result = await ImageManipulator.manipulateAsync(
        imageUri,
        [{ rotate: 90 }],
        { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG }
      );
      setImageUri(result.uri);
      setRotation((rotation + 90) % 360);
    } catch {
      Alert.alert('Error', 'Failed to rotate image');
    }
    setProcessing(false);
  };

  // ── Crop ──
  const handleCrop = async () => {
    if (!cropRatio) {
      Alert.alert('Select Ratio', 'Choose a crop ratio first');
      return;
    }
    setProcessing(true);
    try {
      // Get image dimensions
      const imgSize = await new Promise<{ width: number; height: number }>((res) => {
        Image.getSize(imageUri, (w, h) => res({ width: w, height: h }), () => res({ width: SW, height: SW }));
      });
      const { width: iw, height: ih } = imgSize;
      let cropW = iw, cropH = ih;
      if (cropRatio >= 1) {
        cropH = Math.min(ih, iw / cropRatio);
        cropW = cropH * cropRatio;
      } else {
        cropW = Math.min(iw, ih * cropRatio);
        cropH = cropW / cropRatio;
      }
      const originX = Math.max(0, (iw - cropW) / 2);
      const originY = Math.max(0, (ih - cropH) / 2);
      const result = await ImageManipulator.manipulateAsync(
        imageUri,
        [{ crop: { originX, originY, width: cropW, height: cropH } }],
        { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG }
      );
      setImageUri(result.uri);
    } catch {
      Alert.alert('Error', 'Failed to crop image');
    }
    setProcessing(false);
  };

  // ── Apply Filter ──
  const applyFilter = async (filter: string) => {
    setActiveFilter(filter);
    if (filter === 'Original') return;
    // Filters are applied at capture time via overlay tint
  };

  // ── Get filter overlay style ──
  const getFilterOverlay = () => {
    switch (activeFilter) {
      case 'B&W': return { backgroundColor: 'rgba(128,128,128,0.5)' };
      case 'Warm': return { backgroundColor: 'rgba(255,140,50,0.15)' };
      case 'Cool': return { backgroundColor: 'rgba(50,100,255,0.15)' };
      case 'Vivid': return { backgroundColor: 'rgba(255,50,200,0.08)' };
      default: return {};
    }
  };

  // ── Add text overlay ──
  const addTextOverlay = () => {
    if (!editingText.trim()) return;
    const id = Date.now().toString();
    setTextOverlays(prev => [...prev, {
      id, text: editingText.trim(), x: SW / 2 - 50, y: SH / 3,
      color: textColor, fontSize: textFontSize,
    }]);
    setEditingText('');
  };

  // ── Remove text overlay ──
  const removeTextOverlay = (id: string) => {
    setTextOverlays(prev => prev.filter(t => t.id !== id));
    textPans.current.delete(id);
  };

  // ── Text drag handler ──
  // g.dx/g.dy are CUMULATIVE since the touch began, so they are added to the
  // position at grant — adding them to the current position on every move made
  // the text accelerate away from the finger. One responder per overlay, kept
  // across renders.
  const textPans = useRef(new Map<string, PanResponderInstance>());
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const textPanFor = (id: string) => {
    let pan = textPans.current.get(id);
    if (!pan) {
      pan = PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          const t = overlaysRef.current.find(o => o.id === id);
          dragStart.current = t ? { x: t.x, y: t.y } : null;
        },
        onPanResponderMove: (_, g) => {
          const start = dragStart.current;
          if (!start) return;
          setTextOverlays(prev => prev.map(t =>
            t.id === id ? { ...t, x: start.x + g.dx, y: start.y + g.dy } : t
          ));
        },
        onPanResponderRelease: () => { dragStart.current = null; },
        onPanResponderTerminate: () => { dragStart.current = null; },
      });
      textPans.current.set(id, pan);
    }
    return pan;
  };

  // ── Done — capture final image ──
  const handleDone = async () => {
    if (processing) return;
    setProcessing(true);
    try {
      let finalUri = imageUri;

      // Every visual edit lives in the ViewShot (drawing, text, filter tint and
      // the brightness/contrast washes), so capturing it is what puts them in
      // the sent image. Brightness/contrast used to be skipped here and then
      // "applied" as a plain resize, so they never reached the output.
      if (lines.length > 0 || textOverlays.length > 0 || activeFilter !== 'Original'
          || brightness !== 0 || contrast !== 0) {
        if (!viewShotRef.current) throw new Error('canvas not ready');
        finalUri = await viewShotRef.current.capture();
      }

      // Hand the edited image back to the chat via the shared capturedUri
      // contract so it's actually sent (a prior router.back()+setParams lost it).
      // dismissTo pops back to the chat already in the stack instead of
      // pushing a second /chat, exactly as app/camera.tsx leaves.
      router.dismissTo({
        pathname: (returnTo || '/chat') as any,
        params: returnParams({ chatId, peerUid, peerName }, { uri: finalUri, type: 'image' }),
      });
    } catch {
      Alert.alert('Error', 'Failed to save edited image');
    }
    setProcessing(false);
  };

  // ── Cancel ──
  const handleCancel = () => {
    Alert.alert('Discard Changes?', 'All edits will be lost.', [
      { text: 'Keep Editing' },
      { text: 'Discard', style: 'destructive', onPress: () => router.back() },
    ]);
  };

  // ── Undo last draw line ──
  const undoLastLine = () => {
    setLines(prev => prev.slice(0, -1));
  };

  // ── Render SVG-like lines ──
  const renderDrawLines = (linesToRender: DrawLine[]) => {
    return linesToRender.map((line, li) => (
      <View key={li} style={StyleSheet.absoluteFill} pointerEvents="none">
        {line.points.map((pt, pi) => {
          if (pi === 0) return null;
          const prev = line.points[pi - 1];
          const dx = pt.x - prev.x;
          const dy = pt.y - prev.y;
          const len = Math.sqrt(dx * dx + dy * dy);
          const angle = Math.atan2(dy, dx) * (180 / Math.PI);
          return (
            <View
              key={pi}
              style={{
                position: 'absolute',
                left: prev.x,
                top: prev.y,
                width: len,
                height: line.width,
                backgroundColor: line.color,
                borderRadius: line.width / 2,
                transform: [{ rotate: angle + 'deg' }],
                transformOrigin: 'left center',
              }}
            />
          );
        })}
      </View>
    ));
  };

  const toolButtons: { mode: ToolMode; icon: string; label: string }[] = [
    { mode: 'crop', icon: '⬜', label: 'Crop' },
    { mode: 'rotate', icon: '↻', label: 'Rotate' },
    { mode: 'draw', icon: '✏️', label: 'Draw' },
    { mode: 'text', icon: 'T', label: 'Text' },
    { mode: 'filter', icon: '◑', label: 'Filter' },
    { mode: 'adjust', icon: '☀', label: 'Adjust' },
  ];

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />
      <AuroraBackground />

      {/* Top bar */}
      <View style={styles.topBar}>
        <TouchableOpacity onPress={handleCancel} style={styles.topBtn} accessibilityRole="button" accessibilityLabel="Cancel editing">
          <Text style={styles.topBtnText}>Cancel</Text>
        </TouchableOpacity>
        <Text style={styles.topTitle}>Edit Image</Text>
        <TouchableOpacity onPress={handleDone} disabled={processing} style={[styles.topBtn, styles.doneBtn]}
          accessibilityRole="button" accessibilityLabel="Done, send edited image" accessibilityState={{ disabled: processing, busy: processing }}>
          {processing ? <ActivityIndicator size="small" color="#FFF" /> : <Text style={styles.doneBtnText}>Done</Text>}
        </TouchableOpacity>
      </View>

      {/* Image canvas */}
      <View style={styles.canvasWrapper}>
        <ViewShot ref={viewShotRef} style={styles.canvas} options={{ format: 'jpg', quality: 0.9 }}>
          <Image source={{ uri: imageUri }} style={styles.image} resizeMode="contain" />

          {/* Filter overlay */}
          {activeFilter !== 'Original' && <View style={[StyleSheet.absoluteFill, getFilterOverlay()]} pointerEvents="none" />}

          {/* Brightness overlay */}
          {brightness !== 0 && (
            <View style={[StyleSheet.absoluteFill, {
              backgroundColor: brightness > 0 ? `rgba(255,255,255,${brightness / 200})` : `rgba(0,0,0,${Math.abs(brightness) / 200})`,
            }]} pointerEvents="none" />
          )}

          {/* Contrast overlay. ponytail: brightness/contrast/filters are
              translucent washes captured with the canvas, not a colour matrix
              (no filter library is installed). What you see is what is sent,
              but it is an approximation; replace with a real colour-matrix
              filter if one (e.g. Skia) is adopted. Lower contrast = a grey wash. */}
          {contrast !== 0 && (
            <View style={[StyleSheet.absoluteFill, {
              backgroundColor: contrast > 0 ? `rgba(0,0,0,${contrast / 400})` : `rgba(128,128,128,${Math.abs(contrast) / 125})`,
              opacity: contrast > 0 ? 0.5 : 1,
            }]} pointerEvents="none" />
          )}

          {/* Draw lines */}
          {renderDrawLines(lines)}
          {currentLine && renderDrawLines([currentLine])}

          {/* Text overlays */}
          {textOverlays.map(t => (
            <View
              key={t.id}
              style={{ position: 'absolute', left: t.x, top: t.y }}
              {...textPanFor(t.id).panHandlers}
            >
              <Text style={{ color: t.color, fontSize: t.fontSize, fontWeight: '700', textShadowColor: '#000', textShadowRadius: 3 }}>
                {t.text}
              </Text>
            </View>
          ))}

          {/* Drawing touch area */}
          {activeMode === 'draw' && (
            <View style={StyleSheet.absoluteFill} {...drawPan.panHandlers} />
          )}
        </ViewShot>
      </View>

      {/* Tool bar */}
      <View style={styles.toolbar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.toolRow}>
          {toolButtons.map(tb => (
            <TouchableOpacity
              key={tb.mode}
              style={[styles.toolBtn, activeMode === tb.mode && styles.toolBtnActive]}
              accessibilityRole="button"
              accessibilityLabel={tb.label}
              accessibilityState={tb.mode === 'rotate' ? { disabled: processing } : { selected: activeMode === tb.mode }}
              onPress={() => {
                if (tb.mode === 'rotate') {
                  handleRotate();
                } else {
                  setActiveMode(activeMode === tb.mode ? 'none' : tb.mode);
                }
              }}
            >
              <Text importantForAccessibility="no" accessibilityElementsHidden style={[styles.toolIcon, activeMode === tb.mode && styles.toolIconActive]}>{tb.icon}</Text>
              <Text style={[styles.toolLabel, activeMode === tb.mode && styles.toolLabelActive]}>{tb.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* Sub-panels */}
      {activeMode === 'crop' && (
        <View style={styles.subPanel}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.subRow}>
            {CROP_RATIOS.map(r => (
              <TouchableOpacity
                key={r.label}
                style={[styles.chipBtn, cropRatio === r.value && styles.chipActive]}
                accessibilityRole="radio" accessibilityLabel={`Crop ratio ${r.label}`}
                accessibilityState={{ selected: cropRatio === r.value }}
                onPress={() => setCropRatio(r.value)}
              >
                <Text style={[styles.chipText, cropRatio === r.value && styles.chipTextActive]}>{r.label}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={[styles.chipBtn, { backgroundColor: colors.accent }]} onPress={handleCrop} accessibilityRole="button" accessibilityLabel="Apply crop">
              <Text style={[styles.chipText, { color: '#FFF' }]}>Apply Crop</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      )}

      {activeMode === 'draw' && (
        <View style={styles.subPanel}>
          <View style={styles.subRow}>
            {DRAW_COLORS.map(c => (
              <TouchableOpacity hitSlop={8}
                key={c}
                style={[styles.colorDot, { backgroundColor: c }, drawColor === c && styles.colorDotActive]}
                accessibilityRole="radio" accessibilityLabel={`Brush colour ${COLOR_NAMES[c] ?? c}`}
                accessibilityState={{ selected: drawColor === c }}
                onPress={() => setDrawColor(c)}
              />
            ))}
            <View style={styles.sliderRow}>
              <Text style={styles.sliderLabel}>Size</Text>
              {[2, 4, 6, 8].map(s => (
                <TouchableOpacity hitSlop={7}
                  key={s}
                  style={[styles.sizeBtn, brushSize === s && styles.sizeBtnActive]}
                  accessibilityRole="radio" accessibilityLabel={`Brush size ${s}`}
                  accessibilityState={{ selected: brushSize === s }}
                  onPress={() => setBrushSize(s)}
                >
                  <View style={{ width: s * 2, height: s * 2, borderRadius: s, backgroundColor: drawColor }} />
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity onPress={undoLastLine} style={styles.undoBtn} accessibilityRole="button" accessibilityLabel="Undo last stroke">
              <Text style={styles.undoBtnText}>Undo</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {activeMode === 'text' && (
        <View style={styles.subPanel}>
          <View style={styles.textInputRow}>
            <TextInput
              style={styles.textInput}
              placeholder="Enter text..."
              placeholderTextColor={colors.textDim}
              value={editingText}
              onChangeText={setEditingText}
              onSubmitEditing={addTextOverlay}
            />
            <TouchableOpacity onPress={addTextOverlay} style={styles.addTextBtn} accessibilityRole="button" accessibilityLabel="Add text">
              <Text style={styles.addTextBtnText}>Add</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.subRow}>
            {DRAW_COLORS.map(c => (
              <TouchableOpacity hitSlop={8}
                key={c}
                style={[styles.colorDot, { backgroundColor: c }, textColor === c && styles.colorDotActive]}
                accessibilityRole="radio" accessibilityLabel={`Text colour ${COLOR_NAMES[c] ?? c}`}
                accessibilityState={{ selected: textColor === c }}
                onPress={() => setTextColor(c)}
              />
            ))}
            <View style={styles.sliderRow}>
              <Text style={styles.sliderLabel}>Size</Text>
              {[18, 24, 32, 42].map(s => (
                <TouchableOpacity hitSlop={7}
                  key={s}
                  style={[styles.sizeBtn, textFontSize === s && styles.sizeBtnActive]}
                  accessibilityRole="radio" accessibilityLabel={`Text size ${s}`}
                  accessibilityState={{ selected: textFontSize === s }}
                  onPress={() => setTextFontSize(s)}
                >
                  <Text style={{ color: colors.text, fontSize: 12 }}>{s}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
          {textOverlays.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 6 }}>
              {textOverlays.map(t => (
                <TouchableOpacity key={t.id} onPress={() => removeTextOverlay(t.id)} style={styles.textTag} accessibilityRole="button" accessibilityLabel={`Remove text ${t.text}`}>
                  <Text style={{ color: t.color, fontSize: 12 }}>{t.text}</Text>
                  <Ionicons name="close" size={12} color={colors.danger} style={{ marginLeft: 4 }} />
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
        </View>
      )}

      {activeMode === 'filter' && (
        <View style={styles.subPanel}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.subRow}>
            {FILTER_LIST.map(f => (
              <TouchableOpacity
                key={f}
                style={[styles.filterBtn, activeFilter === f && styles.filterBtnActive]}
                accessibilityRole="radio" accessibilityLabel={`Filter ${f}`}
                accessibilityState={{ selected: activeFilter === f }}
                onPress={() => applyFilter(f)}
              >
                <View style={[styles.filterPreview, f === 'B&W' && { backgroundColor: '#6B7280' }, f === 'Warm' && { backgroundColor: '#FF8C32' }, f === 'Cool' && { backgroundColor: '#3264FF' }, f === 'Vivid' && { backgroundColor: '#FF32C8' }]} />
                <Text style={[styles.filterLabel, activeFilter === f && { color: colors.accent }]}>{f}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {activeMode === 'adjust' && (
        <View style={styles.subPanel}>
          <View style={styles.adjustRow}>
            <Text style={styles.adjustLabel}>Brightness</Text>
            <View style={styles.adjustSlider}>
              {[-50, -25, 0, 25, 50].map(v => (
                <TouchableOpacity
                  key={v}
                  style={[styles.adjustStep, brightness === v && styles.adjustStepActive]}
                  accessibilityRole="radio" accessibilityLabel={`Brightness ${v}`}
                  accessibilityState={{ selected: brightness === v }}
                  onPress={() => setBrightness(v)}
                >
                  <Text style={[styles.adjustStepText, brightness === v && { color: colors.accent }]}>{v > 0 ? '+' + v : v}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
          <View style={styles.adjustRow}>
            <Text style={styles.adjustLabel}>Contrast</Text>
            <View style={styles.adjustSlider}>
              {[-50, -25, 0, 25, 50].map(v => (
                <TouchableOpacity
                  key={v}
                  style={[styles.adjustStep, contrast === v && styles.adjustStepActive]}
                  accessibilityRole="radio" accessibilityLabel={`Contrast ${v}`}
                  accessibilityState={{ selected: contrast === v }}
                  onPress={() => setContrast(v)}
                >
                  <Text style={[styles.adjustStepText, contrast === v && { color: colors.accent }]}>{v > 0 ? '+' + v : v}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>
      )}

      {processing && (
        <View style={styles.processingOverlay}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={styles.processingText}>Processing...</Text>
        </View>
      )}
    </View>
  );
}

// Width/height are threaded in from useWindowDimensions() rather than read
// from a module-level Dimensions.get(): orientation is 'default', so a frozen
// value survived rotation, folds and split-screen resizes.
const makeStyles = (c: Palette, SW: number, SH: number) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: Platform.OS === 'ios' ? 56 : 40, paddingHorizontal: 16, paddingBottom: 12, backgroundColor: c.surfaceSolid },
  topBtn: { minHeight: 44, justifyContent: 'center', paddingVertical: 6, paddingHorizontal: 14 },
  topBtnText: { color: c.textDim, fontSize: 16, fontWeight: '600' },
  topTitle: { color: c.text, fontSize: 17, fontWeight: '700' },
  doneBtn: { backgroundColor: c.accent, borderRadius: 8 },
  doneBtnText: { color: '#FFF', fontSize: 16, fontWeight: '700' },
  canvasWrapper: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  canvas: { width: SW, height: SH * 0.55, justifyContent: 'center', alignItems: 'center', overflow: 'hidden' },
  image: { width: '100%', height: '100%' },
  toolbar: { backgroundColor: c.card, borderTopWidth: 1, borderTopColor: 'rgba(74,159,255,0.1)', paddingVertical: 10 },
  toolRow: { flexDirection: 'row', paddingHorizontal: 12, gap: 6 },
  toolBtn: { alignItems: 'center', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 },
  toolBtnActive: { backgroundColor: 'rgba(0,229,255,0.15)' },
  toolIcon: { fontSize: 20, color: c.textDim },
  toolIconActive: { color: c.accent },
  toolLabel: { fontSize: 12, color: c.textDim, marginTop: 3 },
  toolLabelActive: { color: c.accent },
  subPanel: { backgroundColor: c.card, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1, borderTopColor: 'rgba(74,159,255,0.08)' },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  chipBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(74,159,255,0.2)' },
  chipActive: { borderColor: c.accent, backgroundColor: 'rgba(0,229,255,0.1)' },
  chipText: { color: c.textDim, fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: c.accent },
  colorDot: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: 'transparent' },
  colorDotActive: { borderColor: c.accent, borderWidth: 3 },
  sliderRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 10 },
  sliderLabel: { color: c.textDim, fontSize: 12, marginRight: 4 },
  sizeBtn: { width: 30, height: 30, borderRadius: 15, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
  sizeBtnActive: { borderColor: c.accent, backgroundColor: 'rgba(0,229,255,0.15)' },
  undoBtn: { marginLeft: 'auto', paddingHorizontal: 12, paddingVertical: 6, backgroundColor: 'rgba(255,60,110,0.15)', borderRadius: 6 },
  undoBtnText: { color: c.danger, fontSize: 12, fontWeight: '600' },
  textInputRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  textInput: { flex: 1, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, color: c.text, fontSize: 14, borderWidth: 1, borderColor: 'rgba(74,159,255,0.15)' },
  addTextBtn: { marginLeft: 8, backgroundColor: c.accent, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  addTextBtnText: { color: '#FFF', fontSize: 13, fontWeight: '700' },
  textTag: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.06)', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, marginRight: 6 },
  filterBtn: { alignItems: 'center', marginRight: 14 },
  filterBtnActive: {},
  filterPreview: { width: 48, height: 48, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.1)', marginBottom: 4, borderWidth: 2, borderColor: 'transparent' },
  filterLabel: { fontSize: 12, color: c.textDim },
  adjustRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  adjustLabel: { color: c.textDim, fontSize: 13, width: 80 },
  adjustSlider: { flex: 1, flexDirection: 'row', justifyContent: 'space-around' },
  adjustStep: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  adjustStepActive: { borderColor: c.accent, backgroundColor: 'rgba(0,229,255,0.1)' },
  adjustStepText: { color: c.textDim, fontSize: 12 },
  processingOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(2,11,24,0.85)', justifyContent: 'center', alignItems: 'center' },
  processingText: { color: c.accent, fontSize: 15, marginTop: 12, fontWeight: '600' },
});
