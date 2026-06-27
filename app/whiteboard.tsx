// app/whiteboard.tsx — Drawing Whiteboard
// Draw sketches, annotate, share in chat
// Touch-based drawing with color picker, brush sizes, undo, clear

import { BRAND_ACCENT } from '../constants/theme';
import React, { useState, useRef , useMemo} from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, PanResponder,
  StatusBar, Alert,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { Stack } from 'expo-router';
import { captureRef } from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';


const COLORS = ['#FFFFFF', '#FF3C6E', '#4A9FFF', BRAND_ACCENT, '#F59E0B', '#A78BFA', BRAND_ACCENT, '#EC4899', '#8B5CF6'];
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
  const [color, setColor] = useState('#FFFFFF');
  const [brushSize, setBrushSize] = useState(4);
  const [tool, setTool] = useState('pen');

  const panResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => {
      const { locationX, locationY } = e.nativeEvent;
      setCurrentPath([{ x: locationX, y: locationY }]);
    },
    onPanResponderMove: (e) => {
      const { locationX, locationY } = e.nativeEvent;
      setCurrentPath(prev => [...prev, { x: locationX, y: locationY }]);
    },
    onPanResponderRelease: () => {
      if (currentPath.length > 0) {
        setPaths(prev => [...prev, { points: currentPath, color: tool === 'eraser' ? '#FFFFFF' : color, width: tool === 'eraser' ? brushSize * 3 : brushSize }]);
        setCurrentPath([]);
      }
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
      <Stack.Screen options={{ title: 'Whiteboard', headerStyle: { backgroundColor: '#FFFFFF' }, headerTintColor: '#1F2937',
        headerRight: () => (
          <View style={{ flexDirection: 'row', gap: 14, marginRight: 8 }}>
            <TouchableOpacity onPress={undo}><Text style={{ color: '#4A9FFF', fontSize: 13, fontWeight: '700' }}>Undo</Text></TouchableOpacity>
            <TouchableOpacity onPress={saveAndShare}><Text style={{ color: BRAND_ACCENT, fontSize: 13, fontWeight: '700' }}>Share</Text></TouchableOpacity>
          </View>
        ),
      }} />
      <View style={s.container}>
        <StatusBar barStyle="light-content" />

        {/* Canvas */}
        <View ref={canvasRef} style={s.canvas} {...panResponder.panHandlers}>
          {paths.map((p, i) => renderPath(p, i))}
          {currentPath.length > 0 && renderPath({ points: currentPath, color: tool === 'eraser' ? '#FFFFFF' : color, width: tool === 'eraser' ? brushSize * 3 : brushSize }, 'current')}
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
              <TouchableOpacity key={c} style={[s.colorDot, { backgroundColor: c }, color === c && s.colorActive]}
                onPress={() => { setColor(c); setTool('pen'); }} />
            ))}
          </View>

          {/* Brush sizes */}
          <View style={s.brushRow}>
            {BRUSH_SIZES.map(sz => (
              <TouchableOpacity key={sz} style={[s.brushBtn, brushSize === sz && s.brushActive]} onPress={() => setBrushSize(sz)}>
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
  container: { flex: 1, backgroundColor: c.bg },
  canvas: { flex: 1, backgroundColor: c.bg },
  toolbar: { backgroundColor: '#161B22', padding: 12, paddingBottom: 28, borderTopWidth: 1, borderTopColor: '#21262D' },
  toolRow: { flexDirection: 'row', justifyContent: 'center', gap: 16, marginBottom: 12 },
  toolBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#21262D', justifyContent: 'center', alignItems: 'center' },
  toolActive: { backgroundColor: '#4A9FFF33', borderWidth: 2, borderColor: '#4A9FFF' },
  toolTxt: { fontSize: 18 },
  colorRow: { flexDirection: 'row', justifyContent: 'center', gap: 10, marginBottom: 12 },
  colorDot: { width: 28, height: 28, borderRadius: 14 },
  colorActive: { borderWidth: 3, borderColor: '#fff', transform: [{ scale: 1.15 }] },
  brushRow: { flexDirection: 'row', justifyContent: 'center', gap: 16 },
  brushBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#21262D', justifyContent: 'center', alignItems: 'center' },
  brushActive: { backgroundColor: '#4A9FFF33', borderWidth: 1, borderColor: '#4A9FFF' },
  brushDot: { backgroundColor: '#fff' },
});
