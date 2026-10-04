import { AppText as Text } from '../components/ui/Text';
import { AuroraBackground } from '../components/ui';
// app/image-editor.tsx — Image Editor before sending
// Crop (free or fixed ratio, user-positioned box), Rotate, Draw, Text overlay,
// colour Filters, Brightness/Contrast.
// expo-image-manipulator does crop/rotate at the photo's own resolution;
// filters and adjustments are one SVG colour matrix (react-native-svg
// FilterImage). Drawing, text and colour edits are baked in on Done by
// rendering the edit OFFSCREEN at the photo's pixel size and capturing that
// with react-native-view-shot (see exportFullRes) — capturing the on-screen
// canvas would send a screen-sized photo.

import { BRAND_ACCENT, brandAlpha, type Palette } from '../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import React, { useState, useRef, useMemo, useEffect } from 'react';
import {
  View, TouchableOpacity, StyleSheet, Image, ScrollView, PixelRatio,
  PanResponder, type PanResponderInstance, TextInput, Alert, ActivityIndicator,
  useWindowDimensions, type ImageStyle, type StyleProp } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { FilterImage } from 'react-native-svg/filter-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../lib/theme';
import { useRouter, useLocalSearchParams, useNavigation, Stack } from 'expo-router';
import { returnParams } from '../lib/camera/cameraMode';
import { strokeD } from '../lib/strokePath';
import {
  FILTERS, editMatrix, type FilterName, type Matrix,
  containFrame, initialCrop, moveCrop, resizeCrop, toImageCrop, type Rect, type Corner,
} from '../lib/imageEditMath';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import ViewShot, { captureRef, releaseCapture } from 'react-native-view-shot';
import {
  exportSize, mapForCrop, mapForRotate90, scaleCrop, toExport, type OverlayMap,
} from '../lib/media/editExport';


// Ink colours are image content, not theme roles.
const DRAW_COLORS = ['#FFFFFF', '#FF3C3C', '#4A9FFF', BRAND_ACCENT, '#FBBF24'];
const COLOR_NAMES: Record<string, string> = {
  '#FFFFFF': 'white', '#FF3C3C': 'red', '#4A9FFF': 'blue', [BRAND_ACCENT]: 'brand blue', '#FBBF24': 'yellow',
};
const CROP_RATIOS = [
  { label: 'Free', value: null },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '16:9', value: 16 / 9 },
];
const CORNERS: Corner[] = ['tl', 'tr', 'bl', 'br'];

type DrawLine = { points: { x: number; y: number }[]; color: string; width: number };
type TextOverlay = { id: string; text: string; x: number; y: number; color: string; fontSize: number };

type ToolMode = 'none' | 'crop' | 'rotate' | 'draw' | 'text' | 'filter' | 'adjust';

/** The photo with the colour matrix applied, or the plain Image when there is
 *  no colour edit (no SVG filter pass at all). */
function EditedImage({ uri, matrix, style, onLoad }: {
  uri: string; matrix: Matrix | null; style: StyleProp<ImageStyle>; onLoad?: () => void;
}) {
  if (!matrix) return <Image source={{ uri }} style={style} resizeMode="contain" onLoad={onLoad} />;
  return (
    <FilterImage source={{ uri }} style={style} resizeMode="contain" onLoad={onLoad}
      filters={[{ name: 'feColorMatrix', type: 'matrix', values: matrix }]} />
  );
}

/** viewBox maps canvas coordinates onto a differently sized layer (the
 *  full-resolution export), scaling stroke widths with it. */
function Strokes({ lines, viewBox }: { lines: DrawLine[]; viewBox?: string }) {
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none" viewBox={viewBox}>
      {lines.map((l, i) => (
        <Path key={i} d={strokeD(l.points)} stroke={l.color} strokeWidth={l.width}
          strokeLinecap="round" strokeLinejoin="round" fill="none" />
      ))}
    </Svg>
  );
}

function useS() {
  const { width: SW, height: SH } = useWindowDimensions();
  const { top, bottom } = useSafeAreaInsets();
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors, SW, SH, top, bottom), [colors, SW, SH, top, bottom]);
}

/** Resolves on the next-but-one frame: an image that just reported onLoad has
 *  been drawn by then. */
const twoFrames = () => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));

export default function ImageEditorScreen() {
  // Live metrics owned by THIS component — follows rotation and folds.
  const { width: SW, height: SH } = useWindowDimensions();
  const canvasW = SW, canvasH = SH * 0.55;   // must match styles.canvas

  const { colors } = useTheme();
  const styles = useS();
  const router = useRouter();
  const { uri, chatId, peerUid, peerName, returnTo } = useLocalSearchParams<{
    uri: string; chatId?: string; peerUid?: string; peerName?: string; returnTo?: string;
  }>();
  const viewShotRef = useRef<ViewShot>(null);

  // Image state
  const [imageUri, setImageUri] = useState(uri || '');
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  // Image.getSize failed: crop cannot map its box to pixels, so say so instead
  // of leaving Apply Crop waiting for a size that never comes.
  const [sizeFailed, setSizeFailed] = useState(false);
  const [processing, setProcessing] = useState(false);

  // Files this screen made (rotate/crop results, captures). A superseded one is
  // deleted at once; the rest go when the screen closes — except the one that
  // was sent, which the chat still has to upload.
  const temps = useRef(new Set<string>());
  const keepOnClose = useRef<string | null>(null);
  const dropTemp = (u: string) => {
    if (!temps.current.delete(u)) return;
    FileSystem.deleteAsync(u, { idempotent: true }).catch(() => {});
  };
  useEffect(() => () => {
    for (const u of temps.current) if (u !== keepOnClose.current) FileSystem.deleteAsync(u, { idempotent: true }).catch(() => {});
    temps.current.clear();
  }, []);

  // Tool mode
  const [activeMode, setActiveMode] = useState<ToolMode>('none');

  // Crop
  const [cropRatio, setCropRatio] = useState<number | null>(null);
  const [cropRect, setCropRect] = useState<Rect | null>(null);

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

  // Filters + adjustments → one colour matrix
  const [activeFilter, setActiveFilter] = useState<FilterName>('Original');
  const [brightness, setBrightness] = useState(0);
  const [contrast, setContrast] = useState(0);
  const matrix = useMemo(() => editMatrix(activeFilter, brightness, contrast), [activeFilter, brightness, contrast]);

  // Natural size of the current image, for mapping the crop box to pixels.
  useEffect(() => {
    let dead = false;
    setImgSize(null);
    setSizeFailed(false);
    if (!imageUri) return;
    Image.getSize(imageUri, (w, h) => { if (!dead) setImgSize({ w, h }); }, () => { if (!dead) setSizeFailed(true); });
    return () => { dead = true; };
  }, [imageUri]);
  const frame = useMemo(
    () => (imgSize ? containFrame(canvasW, canvasH, imgSize.w, imgSize.h) : null),
    [imgSize, canvasW, canvasH],
  );
  // A fresh box whenever crop opens, the ratio changes, or the image changes.
  useEffect(() => {
    setCropRect(activeMode === 'crop' && frame ? initialCrop(frame, cropRatio) : null);
  }, [activeMode, frame, cropRatio]);

  // The PanResponders below are created once, so they read live values from
  // refs. Reading state there captured the first render: every stroke came
  // out white at size 3 whatever was picked.
  const drawColorRef = useRef(drawColor);
  drawColorRef.current = drawColor;
  const brushSizeRef = useRef(brushSize);
  brushSizeRef.current = brushSize;
  const overlaysRef = useRef(textOverlays);
  overlaysRef.current = textOverlays;
  const cropRef = useRef({ rect: cropRect, frame, ratio: cropRatio });
  cropRef.current = { rect: cropRect, frame, ratio: cropRatio };

  // Rendered size of each text overlay, so a rotate can keep its CENTRE on the
  // same spot of the photo (the text itself stays upright).
  const textSizes = useRef(new Map<string, { w: number; h: number }>());

  /** Crop and rotate change where the photo sits on the canvas: move the
   *  strokes and text with it, or they drift off what they were drawn on. */
  const remapOverlays = (m: OverlayMap) => {
    setLines(prev => prev.map(l => ({ ...l, width: l.width * m.scale, points: l.points.map(m.pt) })));
    setTextOverlays(prev => prev.map(t => {
      const sz = textSizes.current.get(t.id) ?? { w: 0, h: 0 };
      const c = m.pt({ x: t.x + sz.w / 2, y: t.y + sz.h / 2 });
      return { ...t, fontSize: t.fontSize * m.scale, x: c.x - (sz.w * m.scale) / 2, y: c.y - (sz.h * m.scale) / 2 };
    }));
  };

  /** A manipulator result replaces the current image (and its temp file). */
  const adoptResult = (r: { uri: string }) => {
    temps.current.add(r.uri);
    const prev = imageUri;
    setImageUri(r.uri);
    dropTemp(prev);
  };

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

  // ── Crop box gestures: drag the box to move it, a corner to resize ──
  const cropStart = useRef<Rect | null>(null);
  const cropPans = useRef(new Map<string, PanResponderInstance>());
  const cropPanFor = (handle: 'move' | Corner) => {
    let pan = cropPans.current.get(handle);
    if (!pan) {
      pan = PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => { cropStart.current = cropRef.current.rect; },
        onPanResponderMove: (_, g) => {
          const start = cropStart.current;
          const { frame: fr, ratio } = cropRef.current;
          if (!start || !fr) return;
          setCropRect(handle === 'move'
            ? moveCrop(start, g.dx, g.dy, fr)
            : resizeCrop(start, handle, g.dx, g.dy, ratio, fr));
        },
        onPanResponderRelease: () => { cropStart.current = null; },
        onPanResponderTerminate: () => { cropStart.current = null; },
      });
      cropPans.current.set(handle, pan);
    }
    return pan;
  };

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
      if (frame && imgSize) {
        remapOverlays(mapForRotate90(frame, imgSize.w, imgSize.h, containFrame(canvasW, canvasH, result.width, result.height)));
      }
      adoptResult(result);
    } catch {
      Alert.alert('Could not rotate', 'The image could not be rotated. Please try again.');
    }
    setProcessing(false);
  };

  // ── Crop ──
  const handleCrop = async () => {
    if (processing) return;   // a second tap would crop the stale uri again
    if (!cropRect || !frame || !imgSize) {
      Alert.alert('Crop not ready', sizeFailed
        ? "This photo's size couldn't be read, so it can't be cropped."
        : 'The image is still loading. Try again in a moment.');
      return;
    }
    setProcessing(true);
    try {
      const crop = toImageCrop(cropRect, frame, imgSize.w, imgSize.h);
      const result = await ImageManipulator.manipulateAsync(
        imageUri,
        [{ crop }],
        { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG }
      );
      remapOverlays(mapForCrop(frame, imgSize.w, crop, containFrame(canvasW, canvasH, result.width, result.height)));
      adoptResult(result);
      setActiveMode('none');
    } catch {
      Alert.alert('Could not crop', 'The image could not be cropped. Please try again.');
    }
    setProcessing(false);
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
    textSizes.current.delete(id);
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

  const dirty = imageUri !== (uri || '') || lines.length > 0 || textOverlays.length > 0 || !!matrix;

  // Hardware back and swipe leave through beforeRemove, not Cancel, so the
  // discard prompt lives here (the chat-wallpaper model). Done and a confirmed
  // discard set `leaving` so they pass straight through.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const leaving = useRef(false);
  const navigation = useNavigation();
  useEffect(() => navigation.addListener('beforeRemove', (ev) => {
    // beforeRemove is preventable at runtime; the generic navigation type says otherwise.
    const e = ev as typeof ev & { preventDefault(): void };
    if (leaving.current || !dirtyRef.current) return;
    e.preventDefault();
    Alert.alert('Discard Changes?', 'All edits will be lost.', [
      { text: 'Keep Editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => { leaving.current = true; navigation.dispatch(e.data.action); } },
    ]);
  }), [navigation]);

  // ── Full-resolution export ──
  // The edit is rendered a second time, OFFSCREEN, at the photo's own pixel
  // size (bounded by EXPORT_MAX_EDGE) and captured: same image, same colour
  // matrix, same strokes through an SVG viewBox, text scaled by the same
  // factor. A capture of the on-screen canvas is screen-sized, so a 12 MP photo
  // went out at about 1 MP.
  // ponytail: photos past EXPORT_MAX_EDGE (4096 px) are downscaled to it — the
  // offscreen bitmap is width × height × 4 bytes, ~64 MB at the cap. Lift the
  // cap only with a native renderer that works in tiles.
  const [exportPlan, setExportPlan] = useState<{ w: number; h: number } | null>(null);
  const exportRef = useRef<View>(null);
  const exportLoaded = useRef<(() => void) | null>(null);
  const exportFullRes = async (): Promise<string> => {
    if (!frame || !imgSize) throw new Error('image size unknown');
    const px = exportSize(imgSize.w, imgSize.h);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loaded = new Promise<void>((res, rej) => {
      exportLoaded.current = res;
      timer = setTimeout(() => rej(new Error('export render timed out')), 10000);
    });
    setExportPlan({ w: px.w / PixelRatio.get(), h: px.h / PixelRatio.get() });
    try {
      await loaded;
      await twoFrames();
      const out = await captureRef(exportRef, { format: 'jpg', quality: 0.92 });
      temps.current.add(out);
      return out;
    } finally {
      clearTimeout(timer);
      exportLoaded.current = null;
      setExportPlan(null);
    }
  };

  /** The fallback: the on-screen canvas, cut to the photo's area (`frame`) so
   *  no letterbox bands are sent. Screen resolution. */
  const exportScreen = async (): Promise<string> => {
    if (!viewShotRef.current?.capture) throw new Error('canvas not ready');
    const shotUri = await viewShotRef.current.capture();
    if (!frame) return shotUri;
    const shot = await new Promise<{ w: number; h: number }>((res, rej) =>
      Image.getSize(shotUri, (w, h) => res({ w, h }), rej));
    const cut = await ImageManipulator.manipulateAsync(
      shotUri,
      [{ crop: toImageCrop(frame, { x: 0, y: 0, w: canvasW, h: canvasH }, shot.w, shot.h) }],
      { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG },
    );
    releaseCapture(shotUri);
    temps.current.add(cut.uri);
    return cut.uri;
  };

  // ── Done — capture final image ──
  const handleDone = async () => {
    if (processing) return;
    setProcessing(true);
    try {
      let finalUri = imageUri;

      // Drawing, text and the colour matrix are not in imageUri, so the edit
      // is rendered and captured to put them in the sent image. Crop and
      // rotate are already baked into imageUri by ImageManipulator.
      if (lines.length > 0 || textOverlays.length > 0 || matrix) {
        try {
          finalUri = await exportFullRes();
        } catch (e: any) {
          // Out of memory, or a platform that will not draw the offscreen
          // view: a screen-resolution photo beats no photo.
          console.warn('[image-editor] full-resolution export failed, using the screen capture —', e?.message ?? e);
          finalUri = await exportScreen();
        }
      }
      keepOnClose.current = finalUri;

      // Hand the edited image back to the chat via the shared capturedUri
      // contract so it's actually sent (a prior router.back()+setParams lost it).
      // dismissTo pops back to the chat already in the stack instead of
      // pushing a second /chat, exactly as app/camera.tsx leaves.
      leaving.current = true;
      router.dismissTo({
        pathname: (returnTo || '/chat') as any,
        params: returnParams({ chatId, peerUid, peerName }, { uri: finalUri, type: 'image' }),
      });
    } catch {
      leaving.current = false;
      Alert.alert('Could not save', 'The edited image could not be saved. Please try again.');
      setProcessing(false);
    }
  };

  // ── Cancel ── (beforeRemove above asks when there is something to lose)
  const handleCancel = () => router.back();

  // ── Undo last draw line ──
  const undoLastLine = () => {
    setLines(prev => prev.slice(0, -1));
  };

  const toolButtons: { mode: ToolMode; icon: keyof typeof Ionicons.glyphMap; label: string }[] = [
    { mode: 'crop', icon: 'crop', label: 'Crop' },
    { mode: 'rotate', icon: 'refresh', label: 'Rotate' },
    { mode: 'draw', icon: 'brush', label: 'Draw' },
    { mode: 'text', icon: 'text', label: 'Text' },
    { mode: 'filter', icon: 'color-filter', label: 'Filter' },
    { mode: 'adjust', icon: 'sunny', label: 'Adjust' },
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
        <Text style={styles.topTitle} accessibilityRole="header">Edit Image</Text>
        <TouchableOpacity onPress={handleDone} disabled={processing} style={[styles.topBtn, styles.doneBtn]}
          accessibilityRole="button" accessibilityLabel="Done, send edited image" accessibilityState={{ disabled: processing, busy: processing }}>
          {processing ? <ActivityIndicator size="small" color={colors.onPrimary} /> : <Text style={styles.doneBtnText}>Done</Text>}
        </TouchableOpacity>
      </View>

      {/* Image canvas */}
      <View style={styles.canvasWrapper}>
        <View style={styles.canvas}>
          <ViewShot ref={viewShotRef} style={StyleSheet.absoluteFill} options={{ format: 'jpg', quality: 0.9 }}>
            <EditedImage uri={imageUri} matrix={matrix} style={styles.image} />

            {/* Draw lines */}
            <Strokes lines={lines} />
            {currentLine && <Strokes lines={[currentLine]} />}

            {/* Text overlays */}
            {textOverlays.map(t => (
              <View
                key={t.id}
                style={{ position: 'absolute', left: t.x, top: t.y }}
                onLayout={e => textSizes.current.set(t.id, { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
                {...textPanFor(t.id).panHandlers}
              >
                <Text style={[styles.overlayText, { color: t.color, fontSize: t.fontSize }]}>
                  {t.text}
                </Text>
              </View>
            ))}

            {/* Drawing touch area */}
            {activeMode === 'draw' && (
              <View style={StyleSheet.absoluteFill} {...drawPan.panHandlers} />
            )}
          </ViewShot>

          {/* Crop box — outside the ViewShot, so it is never captured. */}
          {activeMode === 'crop' && cropRect && (
            <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
              <View pointerEvents="none" style={[styles.cropShade, { left: 0, right: 0, top: 0, height: cropRect.y }]} />
              <View pointerEvents="none" style={[styles.cropShade, { left: 0, right: 0, top: cropRect.y + cropRect.h, bottom: 0 }]} />
              <View pointerEvents="none" style={[styles.cropShade, { left: 0, width: cropRect.x, top: cropRect.y, height: cropRect.h }]} />
              <View pointerEvents="none" style={[styles.cropShade, { left: cropRect.x + cropRect.w, right: 0, top: cropRect.y, height: cropRect.h }]} />
              <View
                style={[styles.cropBox, { left: cropRect.x, top: cropRect.y, width: cropRect.w, height: cropRect.h }]}
                accessible
                accessibilityRole="adjustable"
                accessibilityLabel="Crop area"
                accessibilityValue={frame ? { text: `${Math.round((cropRect.w * cropRect.h * 100) / (frame.w * frame.h))}% of the photo` } : undefined}
                accessibilityHint="Drag to move. Drag a corner to resize. Swipe up or down to grow or shrink."
                accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
                onAccessibilityAction={e => {
                  if (!frame) return;
                  setCropRect(r => r && scaleCrop(r, e.nativeEvent.actionName === 'increment' ? 1.15 : 1 / 1.15, frame, cropRatio));
                }}
                {...cropPanFor('move').panHandlers}
              >
                {CORNERS.map(c => (
                  // Inside the box: Android does not deliver touches to a
                  // child drawn outside its parent's bounds.
                  <View key={c} {...cropPanFor(c).panHandlers}
                    style={[styles.cropHandle,
                      c[0] === 't' ? { top: -2 } : { bottom: -2 },
                      c[1] === 'l' ? { left: -2 } : { right: -2 }]} />
                ))}
              </View>
            </View>
          )}
        </View>
      </View>

      {/* Offscreen full-resolution render of the edit, mounted only while Done
          captures it (exportFullRes). Same layers as the canvas, in export units. */}
      {exportPlan && frame && (
        <View ref={exportRef} collapsable={false} pointerEvents="none"
          importantForAccessibility="no-hide-descendants" accessibilityElementsHidden
          style={[styles.exportLayer, { width: exportPlan.w, height: exportPlan.h, left: -(exportPlan.w + SW) }]}>
          <EditedImage uri={imageUri} matrix={matrix} style={styles.image} onLoad={() => exportLoaded.current?.()} />
          <Strokes lines={lines} viewBox={`${frame.x} ${frame.y} ${frame.w} ${frame.h}`} />
          {textOverlays.map(t => {
            const k = exportPlan.w / frame.w;
            const at = toExport(t, frame, exportPlan.w);
            // The on-screen width, scaled (plus slack for glyph rounding), so the
            // text breaks into the same lines.
            const w = textSizes.current.get(t.id)?.w;
            return (
              <View key={t.id} style={{ position: 'absolute', left: at.x, top: at.y, width: w ? Math.ceil(w * k * 1.02) : undefined }}>
                <Text style={[styles.overlayText, { color: t.color, fontSize: t.fontSize * k, textShadowRadius: 3 * k }]}>{t.text}</Text>
              </View>
            );
          })}
        </View>
      )}

      {/* Bottom: the open tool's panel above the tool bar, padded past the home indicator. */}
      <View style={styles.bottomChrome}>
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
              <Ionicons name={tb.icon} size={20} color={activeMode === tb.mode ? colors.accentOn : colors.textDim} />
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
            <TouchableOpacity style={[styles.chipBtn, { backgroundColor: colors.accent }]} onPress={handleCrop}
              disabled={processing || !cropRect}
              accessibilityRole="button" accessibilityLabel="Apply crop"
              accessibilityState={{ disabled: processing || !cropRect, busy: processing }}>
              <Text style={[styles.chipText, { color: colors.onPrimary }]}>Apply Crop</Text>
            </TouchableOpacity>
          </ScrollView>
          {sizeFailed && (
            <Text style={styles.sliderLabel} accessibilityLiveRegion="polite">
              {"This photo's size couldn't be read, so it can't be cropped."}
            </Text>
          )}
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
            <TouchableOpacity onPress={undoLastLine} disabled={lines.length === 0} style={styles.undoBtn}
              accessibilityRole="button" accessibilityLabel="Undo last stroke" accessibilityState={{ disabled: lines.length === 0 }}>
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
              accessibilityLabel="Text to add to the image"
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
            {FILTERS.map(f => (
              <TouchableOpacity
                key={f}
                style={styles.filterBtn}
                accessibilityRole="radio" accessibilityLabel={`Filter ${f}`}
                accessibilityState={{ selected: activeFilter === f }}
                onPress={() => setActiveFilter(f)}
              >
                {/* A live thumbnail of the photo with that filter (brightness
                    and contrast included), so the preview is what gets sent. */}
                <View style={[styles.filterPreview, activeFilter === f && styles.filterPreviewActive]}>
                  <EditedImage uri={imageUri} matrix={editMatrix(f, brightness, contrast)} style={styles.filterThumb} />
                </View>
                <Text style={[styles.filterLabel, activeFilter === f && { color: colors.accentOn }]}>{f}</Text>
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
                  <Text style={[styles.adjustStepText, brightness === v && { color: colors.accentOn }]}>{v > 0 ? '+' + v : v}</Text>
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
                  <Text style={[styles.adjustStepText, contrast === v && { color: colors.accentOn }]}>{v > 0 ? '+' + v : v}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>
      )}

      </View>

      {processing && (
        <View style={styles.processingOverlay} accessibilityViewIsModal>
          <View style={[StyleSheet.absoluteFill, styles.processingScrim]} />
          <ActivityIndicator size="large" color={colors.accentOn} />
          <Text style={styles.processingText}>Processing...</Text>
        </View>
      )}
    </View>
  );
}

// Width/height are threaded in from useWindowDimensions() rather than read
// from a module-level Dimensions.get(): orientation is 'default', so a frozen
// value survived rotation, folds and split-screen resizes.
const makeStyles = (c: Palette, SW: number, SH: number, insetTop: number, insetBottom: number) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: insetTop + 8, paddingHorizontal: 16, paddingBottom: 12, backgroundColor: c.surfaceSolid },
  topBtn: { minHeight: 44, justifyContent: 'center', paddingVertical: 6, paddingHorizontal: 14 },
  topBtnText: { color: c.textDim, fontSize: 16, fontWeight: '600' },
  topTitle: { color: c.text, fontSize: 17, fontWeight: '700' },
  doneBtn: { backgroundColor: c.accent, borderRadius: 8 },
  doneBtnText: { color: c.onPrimary, fontSize: 16, fontWeight: '700' },
  canvasWrapper: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  canvas: { width: SW, height: SH * 0.55, overflow: 'hidden' },
  image: { width: '100%', height: '100%' },
  toolbar: { backgroundColor: c.card, borderTopWidth: 1, borderTopColor: c.hairline, paddingVertical: 10 },
  toolRow: { flexDirection: 'row', paddingHorizontal: 12, gap: 6 },
  toolBtn: { alignItems: 'center', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 },
  toolBtnActive: { backgroundColor: brandAlpha(0.15) },
  toolLabel: { fontSize: 12, color: c.textDim, marginTop: 3 },
  toolLabelActive: { color: c.accentOn },
  subPanel: { backgroundColor: c.card, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.hairline },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  chipBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: c.border },
  chipActive: { borderColor: c.accent, backgroundColor: brandAlpha(0.12) },
  chipText: { color: c.textDim, fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: c.accentOn },
  colorDot: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: c.glassStroke },
  colorDotActive: { borderColor: c.accent, borderWidth: 3 },
  sliderRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 10 },
  sliderLabel: { color: c.textDim, fontSize: 12, marginRight: 4 },
  sizeBtn: { width: 30, height: 30, borderRadius: 15, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: c.border },
  sizeBtnActive: { borderColor: c.accent, backgroundColor: brandAlpha(0.15) },
  undoBtn: { marginLeft: 'auto', paddingHorizontal: 12, paddingVertical: 6, backgroundColor: 'rgba(255,60,110,0.15)', borderRadius: 6 },
  undoBtnText: { color: c.danger, fontSize: 12, fontWeight: '600' },
  textInputRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  textInput: { flex: 1, backgroundColor: c.glassSoft, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, color: c.text, fontSize: 14, borderWidth: 1, borderColor: c.border },
  addTextBtn: { marginLeft: 8, backgroundColor: c.accent, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  addTextBtnText: { color: c.onPrimary, fontSize: 13, fontWeight: '700' },
  textTag: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.glassSoft, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, marginRight: 6 },
  filterBtn: { alignItems: 'center', marginRight: 14 },
  filterPreview: { width: 52, height: 52, borderRadius: 8, backgroundColor: c.glassSoft, marginBottom: 4, borderWidth: 2, borderColor: 'transparent', overflow: 'hidden' },
  filterPreviewActive: { borderColor: c.accent },
  filterThumb: { width: 48, height: 48 },
  filterLabel: { fontSize: 12, color: c.textDim },
  adjustRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  adjustLabel: { color: c.textDim, fontSize: 13, width: 80 },
  adjustSlider: { flex: 1, flexDirection: 'row', justifyContent: 'space-around' },
  adjustStep: { minHeight: 32, justifyContent: 'center', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, borderWidth: 1, borderColor: c.border },
  adjustStepActive: { borderColor: c.accent, backgroundColor: brandAlpha(0.12) },
  adjustStepText: { color: c.textDim, fontSize: 12 },
  processingOverlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center' },
  processingScrim: { backgroundColor: c.bg, opacity: 0.85 },
  processingText: { color: c.text, fontSize: 15, marginTop: 12, fontWeight: '600' },
  // The crop shade/box sit over the photo itself, so they stay dark/light in
  // both themes (like any photo editor), not theme tokens.
  cropShade: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.55)' },
  cropBox: { position: 'absolute', borderWidth: 2, borderColor: '#FFFFFF' },
  // Overlay text is image content: a dark halo keeps any ink colour legible on any photo.
  overlayText: { fontWeight: '700', textShadowColor: '#000', textShadowRadius: 3 },
  bottomChrome: { backgroundColor: c.card, paddingBottom: insetBottom },
  // Offscreen (left is set past the screen's width): laid out and drawable, never seen.
  exportLayer: { position: 'absolute', top: 0, overflow: 'hidden' },
  cropHandle: { position: 'absolute', width: 28, height: 28, borderColor: '#FFFFFF', borderWidth: 4, borderRadius: 4, backgroundColor: 'rgba(0,0,0,0.25)' },
});
