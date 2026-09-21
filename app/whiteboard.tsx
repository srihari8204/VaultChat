// app/whiteboard.tsx — Drawing Whiteboard
// Draw sketches, annotate, share in chat
// Touch-based drawing with color picker, brush sizes, undo, clear

import { BRAND_ACCENT, type Palette } from '../constants/theme';
import React, { useState, useRef , useMemo, useEffect} from 'react';
import { View, Text, TouchableOpacity, StyleSheet, PanResponder, Alert } from 'react-native';
import { useTheme } from '../lib/theme';
import { Stack } from 'expo-router';
import { captureRef } from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import { AuroraBackground } from '../components/ui';
import { CANVAS_BG, DEFAULT_INK, commitWhiteboardPath, type Tool } from '../lib/whiteboardStroke';


const COLORS = [DEFAULT_INK, '#FF3C6E', '#4A9FFF', BRAND_ACCENT, '#F59E0B', '#A78BFA', '#FFFFFF', '#EC4899', '#8B5CF6'];
const BRUSH_SIZES = [2, 4, 8, 14, 22];

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function WhiteboardScreen() {
  const { colors } = useTheme();
  const s = useS();
  const canvasRef = useRef(null);
  const [paths, setPaths] = useState([]);
  const [currentPath, setCurrentPath] = useState([]);
  const [color, setColor] = useState(DEFAULT_INK);
  const [brushSize, setBrushSize] = useState(4);
  const [tool, setTool] = useState<Tool>('pen');
  const currentPathRef = useRef(currentPath);
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
      const next = [{ x: locationX, y: locationY }];
      currentPathRef.current = next;
      setCurrentPath(next);
    },
    onPanResponderMove: (e) => {
      const { locationX, locationY } = e.nativeEvent;
      const next = [...currentPathRef.current, { x: locationX, y: locationY }];
      currentPathRef.current = next;
      setCurrentPath(next);
    },
    onPanResponderRelease: () => {
      const latestPath = currentPathRef.current;
      const latestTool = toolRef.current;
      const latestBrush = brushSizeRef.current;
      const committed = commitWhiteboardPath(latestPath, latestTool, colorRef.current, latestBrush);
      if (committed) {
        setPaths(prev => [...prev, committed]);
      }
      currentPathRef.current = [];
      setCurrentPath([]);
    },
  })).current;

  const undo = () => setPaths(prev => prev.slice(0, -1));
  const clear = () => {
    Alert.alert('Clear Canvas?', 'This will erase everything.', [
      { text: 'Cancel' },
      { text: 'Clear', style: 'destructive', onPress: () => setPaths([]) },
    ]);
  };

  const saveAndShare = async () => {
    try {
      if (!canvasRef.current) return;
      const uri = await captureRef(canvasRef.current, { format: 'png', quality: 1 });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: 'image/png' });
      }
    } catch {
      Alert.alert('Error', 'Could not save drawing. Make sure react-native-view-shot is installed.');
    }
  };

  const renderPath = (pathData, idx) => {
    if (pathData.points.length < 2) return null;
    return (
      <View key={idx} style={StyleSheet.absoluteFill} pointerEvents="none">
        {pathData.points.map((point, i) => {
          if (i === 0) return null;
          return (
            <View key={i} style={{
              position: 'absolute',
              left: point.x - pathData.width / 2,
              top: point.y - pathData.width / 2,
              width: pathData.width,
              height: pathData.width,
              borderRadius: pathData.width / 2,
              backgroundColor: pathData.color,
            }} />
          );
        })}
      </View>
    );
  };

  return (
    <>
      <Stack.Screen options={{
        headerShown: true, /* the root Stack sets headerShown:false app-wide, so the options below were inert and this screen had no back control at all */  title: 'Whiteboard', headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text,
        headerRight: () => (
          <View style={{ flexDirection: 'row', gap: 14, marginRight: 8 }}>
            <TouchableOpacity accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center' }} onPress={undo}><Text style={{ color: colors.accentOn, fontSize: 13, fontWeight: '700' }}>Undo</Text></TouchableOpacity>
            <TouchableOpacity accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center' }} onPress={saveAndShare}><Text style={{ color: colors.accentOn, fontSize: 13, fontWeight: '700' }}>Share</Text></TouchableOpacity>
          </View>
        ),
      }} />
      <View style={s.container}>
      <AuroraBackground />

        {/* Canvas */}
        <View ref={canvasRef} style={s.canvas} {...panResponder.panHandlers}>
          {paths.map((p, i) => renderPath(p, i))}
          {currentPath.length > 0 && renderPath({ points: currentPath, color: tool === 'eraser' ? CANVAS_BG : color, width: tool === 'eraser' ? brushSize * 3 : brushSize }, 'current')}
        </View>

        {/* Toolbar */}
        <View style={s.toolbar}>
          {/* Tools */}
          <View style={s.toolRow}>
            <TouchableOpacity style={[s.toolBtn, tool === 'pen' && s.toolActive]} onPress={() => setTool('pen')}>
              <Text style={s.toolTxt}>{"\u270F\uFE0F"}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.toolBtn, tool === 'eraser' && s.toolActive]} onPress={() => setTool('eraser')}>
              <Text style={s.toolTxt}>{"\uD83E\uDDF9"}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.toolBtn} onPress={clear}>
              <Text style={s.toolTxt}>{"\uD83D\uDDD1\uFE0F"}</Text>
            </TouchableOpacity>
          </View>

          {/* Colors */}
          <View style={s.colorRow}>
            {COLORS.map(c => (
              <TouchableOpacity hitSlop={8} key={c} style={[s.colorDot, { backgroundColor: c }, color === c && s.colorActive]}
                onPress={() => { setColor(c); setTool('pen'); }} />
            ))}
          </View>

          {/* Brush sizes */}
          <View style={s.brushRow}>
            {BRUSH_SIZES.map(sz => (
              <TouchableOpacity hitSlop={4} key={sz} style={[s.brushBtn, brushSize === sz && s.brushActive]} onPress={() => setBrushSize(sz)}>
                <View style={[s.brushDot, { width: sz, height: sz, borderRadius: sz / 2 }]} />
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </View>
    </>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  canvas: { flex: 1, backgroundColor: CANVAS_BG },
  toolbar: { backgroundColor: c.glass, padding: 12, paddingBottom: 28, borderTopWidth: 1, borderTopColor: c.glassStroke },
  toolRow: { flexDirection: 'row', justifyContent: 'center', gap: 16, marginBottom: 12 },
  toolBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: c.glassSoft, justifyContent: 'center', alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  toolActive: { backgroundColor: c.glass, borderWidth: 2, borderColor: c.primary },
  toolTxt: { fontSize: 18 },
  colorRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10, marginBottom: 12 },
  colorDot: { width: 28, height: 28, borderRadius: 14 },
  colorActive: { borderWidth: 3, borderColor: c.primary, transform: [{ scale: 1.15 }] },
  brushRow: { flexDirection: 'row', justifyContent: 'center', gap: 16 },
  brushBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: c.glassSoft, justifyContent: 'center', alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  brushActive: { backgroundColor: c.glass, borderWidth: 1, borderColor: c.primary },
  brushDot: { backgroundColor: c.text },
});
