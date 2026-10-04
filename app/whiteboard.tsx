// app/whiteboard.tsx — Drawing Whiteboard
// Draw a sketch, then send it into the chat that opened this screen (the
// shared capturedUri contract, staged in the chat's caption preview) or share
// it to another app. Pen, eraser, colours, brush sizes, undo/redo, clear.

import { BRAND_ACCENT, type Palette } from '../constants/theme';
import React, { useState, useRef, useMemo, useEffect, memo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, PanResponder, Alert, ActivityIndicator, AccessibilityInfo } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { Stack, useNavigation, useLocalSearchParams, useRouter } from 'expo-router';
import { captureRef } from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import { CANVAS_BG, DEFAULT_INK, commitWhiteboardPath, type Tool, type PathData, type Point } from '../lib/whiteboardStroke';
import { strokeD } from '../lib/strokePath';
import { returnParams } from '../lib/camera/cameraMode';


// Ink colours are drawing content on the fixed white canvas, not theme roles.
const COLORS = [DEFAULT_INK, '#FF3C6E', '#4A9FFF', BRAND_ACCENT, '#F59E0B', '#A78BFA', '#FFFFFF', '#EC4899', '#8B5CF6'];
const BRUSH_SIZES = [2, 4, 8, 14, 22];
const COLOR_NAMES: Record<string, string> = {
  [DEFAULT_INK]: 'black', '#FF3C6E': 'red', '#4A9FFF': 'blue', [BRAND_ACCENT]: 'brand blue', '#F59E0B': 'amber',
  '#A78BFA': 'lavender', '#FFFFFF': 'white', '#EC4899': 'pink', '#8B5CF6': 'purple',
};

/** One SVG path per stroke. Memoised: committed strokes re-render only when
 *  the stroke list changes, not on every move event of the live stroke. */
const StrokeLayer = memo(function StrokeLayer({ strokes }: { strokes: PathData[] }) {
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
      {strokes.map((p, i) => (
        <Path key={i} d={strokeD(p.points)} stroke={p.color} strokeWidth={p.width}
          strokeLinecap="round" strokeLinejoin="round" fill="none" />
      ))}
    </Svg>
  );
});


const strokeCountText = (n: number) => (n === 0 ? 'Empty' : `${n} stroke${n === 1 ? '' : 's'}`);

function useS() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return useMemo(() => makeStyles(colors, insets.bottom), [colors, insets.bottom]);
}

export default function WhiteboardScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const { chatId, peerUid, peerName } = useLocalSearchParams<{
    chatId?: string; peerUid?: string; peerName?: string;
  }>();
  const canvasRef = useRef<View>(null);
  const [paths, setPaths] = useState<PathData[]>([]);
  const [redoStack, setRedoStack] = useState<PathData[]>([]);
  // The live stroke grows in a ref; a render is asked for at most once per
  // frame (it used to copy the whole point array and re-render the screen on
  // every move event).
  const [, setFrame] = useState(0);
  const frameReq = useRef<number | null>(null);
  const requestFrame = () => {
    if (frameReq.current != null) return;
    frameReq.current = requestAnimationFrame(() => { frameReq.current = null; setFrame(f => f + 1); });
  };
  useEffect(() => () => { if (frameReq.current != null) cancelAnimationFrame(frameReq.current); }, []);
  const [color, setColor] = useState(DEFAULT_INK);
  const [brushSize, setBrushSize] = useState(4);
  const [tool, setTool] = useState<Tool>('pen');
  const [busy, setBusy] = useState(false);
  const currentPathRef = useRef<Point[]>([]);
  const colorRef = useRef(color);
  const brushSizeRef = useRef(brushSize);
  const toolRef = useRef(tool);

  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { brushSizeRef.current = brushSize; }, [brushSize]);
  useEffect(() => { toolRef.current = tool; }, [tool]);

  const panResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => {
      const { locationX, locationY } = e.nativeEvent;
      currentPathRef.current = [{ x: locationX, y: locationY }];
      requestFrame();
    },
    onPanResponderMove: (e) => {
      const { locationX, locationY } = e.nativeEvent;
      currentPathRef.current.push({ x: locationX, y: locationY });
      requestFrame();
    },
    onPanResponderRelease: () => {
      const committed = commitWhiteboardPath(currentPathRef.current, toolRef.current, colorRef.current, brushSizeRef.current);
      if (committed) {
        setPaths(prev => [...prev, committed]);
        setRedoStack([]); // a new stroke ends the redo history, as in any editor
        version.current++;
      }
      currentPathRef.current = [];
      requestFrame();
    },
  })).current;

  // Every change to the drawing bumps this. The leave guard compares it with
  // the version last shared — counting strokes could not tell "undid one, drew
  // another" from "nothing changed", so that edit could be lost without asking.
  const version = useRef(0);
  const sharedVersion = useRef(0);

  const undo = () => {
    if (paths.length === 0) return;
    setRedoStack(r => [...r, paths[paths.length - 1]]);
    setPaths(prev => prev.slice(0, -1));
    version.current++;
  };
  const redo = () => {
    if (redoStack.length === 0) return;
    setPaths(prev => [...prev, redoStack[redoStack.length - 1]]);
    setRedoStack(r => r.slice(0, -1));
    version.current++;
  };
  // The canvas has no non-gesture alternative; screen-reader users at least
  // hear what each stroke, undo, redo or clear did to the drawing.
  const announcedCount = useRef(paths.length);
  useEffect(() => {
    if (announcedCount.current === paths.length) return;
    announcedCount.current = paths.length;
    AccessibilityInfo.announceForAccessibility(strokeCountText(paths.length));
  }, [paths.length]);

  const clear = () => {
    if (paths.length === 0) return;
    Alert.alert('Clear Canvas?', 'This will erase everything.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: () => { setPaths([]); setRedoStack([]); version.current++; } },
    ]);
  };

  // Leaving with an unshared drawing asks first: the drawing lives only in
  // memory, and back used to drop it silently.
  const pathsRef = useRef(paths);
  pathsRef.current = paths;
  const navigation = useNavigation();
  useEffect(() => navigation.addListener('beforeRemove', (ev) => {
    // beforeRemove is preventable at runtime; the generic navigation type says otherwise.
    const e = ev as typeof ev & { preventDefault(): void };
    if (pathsRef.current.length === 0 || version.current === sharedVersion.current) return;
    e.preventDefault();
    Alert.alert('Discard drawing?', 'Your drawing has not been shared and will be lost.', [
      { text: 'Keep drawing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => navigation.dispatch(e.data.action) },
    ]);
  }), [navigation]);

  // JPEG to match the chat's capture contract (it stages captures as
  // image/jpeg); the canvas is opaque white, so nothing is lost to alpha.
  const capture = () => captureRef(canvasRef, { format: 'jpg', quality: 0.95 });

  const sendToChat = async () => {
    if (busy || paths.length === 0 || !chatId) return;
    setBusy(true);
    try {
      const uri = await capture();
      // Mark as saved BEFORE leaving, or the leave guard would block the pop.
      sharedVersion.current = version.current;
      router.dismissTo({
        pathname: '/chat',   // the only return target (callers' `returnTo` is always '/chat'); a route param must not pick an arbitrary screen
        params: returnParams({ chatId, peerUid, peerName }, { uri, type: 'image' }),
      });
    } catch {
      Alert.alert('Could not send', 'The drawing could not be saved as an image. Please try again.');
      setBusy(false);
    }
  };

  const saveAndShare = async () => {
    if (busy || paths.length === 0) return;
    setBusy(true);
    try {
      const uri = await capture();
      if (await Sharing.isAvailableAsync()) {
        // The capture is left in place: the receiving app may still be reading
        // it after the sheet closes. react-native-view-shot deletes its
        // snapshot files itself when the app next starts.
        await Sharing.shareAsync(uri, { mimeType: 'image/jpeg' });
        sharedVersion.current = version.current;
      } else {
        Alert.alert('Sharing unavailable', 'No app on this device can receive the drawing.');
      }
    } catch {
      Alert.alert('Could not share', 'The drawing could not be saved as an image. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const empty = paths.length === 0;
  const currentPath = currentPathRef.current;
  const live: PathData | null = currentPath.length > 0
    ? { points: currentPath, color: tool === 'eraser' ? CANVAS_BG : color, width: tool === 'eraser' ? brushSize * 3 : brushSize }
    : null;

  return (
    <>
      <Stack.Screen options={{
        headerShown: true, /* the root Stack sets headerShown:false app-wide, so the options below were inert and this screen had no back control at all */  title: 'Whiteboard', headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text,
        headerRight: () => (
          <View style={s.headerActions}>
            {busy && <ActivityIndicator color={colors.accentOn} />}
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Share drawing to another app"
              accessibilityState={{ disabled: empty || busy, busy }} disabled={empty || busy}
              style={[s.headerBtn, empty && s.headerBtnOff]} onPress={saveAndShare}>
              <Text style={s.headerBtnTxt}>Share</Text>
            </TouchableOpacity>
            {!!chatId && (
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Send drawing to this chat"
                accessibilityState={{ disabled: empty || busy, busy }} disabled={empty || busy}
                style={[s.headerBtn, empty && s.headerBtnOff]} onPress={sendToChat}>
                <Text style={[s.headerBtnTxt, s.headerBtnStrong]}>Send</Text>
              </TouchableOpacity>
            )}
          </View>
        ),
      }} />
      <View style={s.container}>

        {/* Canvas — collapsable={false} keeps the native view that captureRef snapshots. */}
        <View ref={canvasRef} collapsable={false} style={s.canvas} {...panResponder.panHandlers}
          accessible accessibilityLabel="Drawing canvas" accessibilityHint="Draw with one finger"
          accessibilityValue={{ text: strokeCountText(paths.length) }}>
          <StrokeLayer strokes={paths} />
          {live && (
            <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
              <Path d={strokeD(live.points)} stroke={live.color} strokeWidth={live.width}
                strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </Svg>
          )}
        </View>

        {/* Toolbar */}
        <View style={s.toolbar}>
          {/* Tools */}
          <View style={s.toolRow}>
            <TouchableOpacity style={[s.toolBtn, tool === 'pen' && s.toolActive]} onPress={() => setTool('pen')}
              accessibilityRole="radio" accessibilityLabel="Pen" accessibilityState={{ selected: tool === 'pen' }}>
              <Ionicons name="pencil" size={20} color={colors.text} />
            </TouchableOpacity>
            <TouchableOpacity style={[s.toolBtn, tool === 'eraser' && s.toolActive]} onPress={() => setTool('eraser')}
              accessibilityRole="radio" accessibilityLabel="Eraser" accessibilityState={{ selected: tool === 'eraser' }}>
              <MaterialCommunityIcons name="eraser" size={20} color={colors.text} />
            </TouchableOpacity>
            <TouchableOpacity style={[s.toolBtn, empty && s.toolDisabled]} onPress={undo} disabled={empty}
              accessibilityRole="button" accessibilityLabel="Undo last stroke" accessibilityState={{ disabled: empty }}>
              <Ionicons name="arrow-undo" size={20} color={colors.text} />
            </TouchableOpacity>
            <TouchableOpacity style={[s.toolBtn, redoStack.length === 0 && s.toolDisabled]} onPress={redo}
              disabled={redoStack.length === 0}
              accessibilityRole="button" accessibilityLabel="Redo stroke" accessibilityState={{ disabled: redoStack.length === 0 }}>
              <Ionicons name="arrow-redo" size={20} color={colors.text} />
            </TouchableOpacity>
            <TouchableOpacity style={[s.toolBtn, empty && s.toolDisabled]} onPress={clear} disabled={empty}
              accessibilityRole="button" accessibilityLabel="Clear canvas" accessibilityState={{ disabled: empty }}>
              <Ionicons name="trash-outline" size={20} color={colors.danger} />
            </TouchableOpacity>
          </View>

          {/* Colors */}
          <View style={s.colorRow}>
            {COLORS.map(c => (
              <TouchableOpacity hitSlop={8} key={c} style={[s.colorDot, { backgroundColor: c }, color === c && s.colorActive]}
                accessibilityRole="radio" accessibilityLabel={`Colour ${COLOR_NAMES[c] ?? c}`}
                accessibilityState={{ selected: color === c }}
                onPress={() => { setColor(c); setTool('pen'); }} />
            ))}
          </View>

          {/* Brush sizes */}
          <View style={s.brushRow}>
            {BRUSH_SIZES.map(sz => (
              <TouchableOpacity hitSlop={4} key={sz} style={[s.brushBtn, brushSize === sz && s.brushActive]} onPress={() => setBrushSize(sz)}
                accessibilityRole="radio" accessibilityLabel={`Brush size ${sz}`} accessibilityState={{ selected: brushSize === sz }}>
                <View style={[s.brushDot, { width: sz, height: sz, borderRadius: sz / 2 }]} />
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </View>
    </>
  );
}

const makeStyles = (c: Palette, insetBottom: number) => StyleSheet.create({
  // The canvas is opaque white and the toolbar a glass bar over this ground.
  container: { flex: 1, backgroundColor: c.bg },
  headerActions: { flexDirection: 'row', gap: 14, marginRight: 8, alignItems: 'center' },
  headerBtn: { minHeight: 44, justifyContent: 'center' },
  headerBtnOff: { opacity: 0.5 },
  headerBtnTxt: { color: c.accentOn, fontSize: 13, fontWeight: '700' },
  headerBtnStrong: { fontWeight: '800' },
  canvas: { flex: 1, backgroundColor: CANVAS_BG },
  toolbar: { backgroundColor: c.glass, padding: 12, paddingBottom: insetBottom + 12, borderTopWidth: 1, borderTopColor: c.glassStroke },
  toolRow: { flexDirection: 'row', justifyContent: 'center', gap: 16, marginBottom: 12 },
  toolBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: c.glassSoft, justifyContent: 'center', alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  toolActive: { backgroundColor: c.glass, borderWidth: 2, borderColor: c.primary },
  toolDisabled: { opacity: 0.4 },
  colorRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10, marginBottom: 12 },
  // The hairline ring keeps the white swatch visible on the light toolbar.
  colorDot: { width: 28, height: 28, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  colorActive: { borderWidth: 3, borderColor: c.primary, transform: [{ scale: 1.15 }] },
  brushRow: { flexDirection: 'row', justifyContent: 'center', gap: 16 },
  brushBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: c.glassSoft, justifyContent: 'center', alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  brushActive: { backgroundColor: c.glass, borderWidth: 1, borderColor: c.primary },
  brushDot: { backgroundColor: c.text },
});
