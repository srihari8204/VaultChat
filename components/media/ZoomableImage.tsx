// components/media/ZoomableImage.tsx — a full-screen photo you can zoom.
//
// Pinch to zoom (1x–5x), drag to pan while zoomed (held inside the overflow by
// lib/zoomPan), tap to toggle 2.5x, and a screen-reader "activate" action that
// does the same toggle. Shared by app/media-viewer.tsx and app/file-viewer.tsx,
// which used to have one viewer each — the file viewer's had double-tap only
// and a pan that was never clamped.

import React, { useRef, useState } from 'react';
import { ActivityIndicator, Animated, PanResponder, StyleSheet, View, type GestureResponderEvent } from 'react-native';
// expo-image, not RN Image: it decodes SVG and HEIC everywhere, which the file
// viewer relied on, and keeps a disk cache for the media viewer.
import { Image } from 'expo-image';
import { clampPan, pinchZoom } from '../../lib/zoomPan';

type Touches = GestureResponderEvent['nativeEvent']['touches'];

export function ZoomableImage({ source, spinnerColor, onLoaded, onFail, label = 'Photo' }: {
  source: { uri: string; headers?: Record<string, string> };
  spinnerColor: string;
  onLoaded: () => void;
  /** Called with user-facing copy. */
  onFail: (msg: string) => void;
  label?: string;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;
  const [imgLoaded, setImgLoaded] = useState(false);
  // Live values + the gesture's starting point (the responder is created once).
  const cur = useRef({ z: 1, x: 0, y: 0 });
  const start = useRef({ z: 1, x: 0, y: 0, dist: 0, pinched: false });
  const box = useRef({ w: 0, h: 0 });
  const apply = (z: number, x: number, y: number, animate = false) => {
    const nx = clampPan(x, z, box.current.w), ny = clampPan(y, z, box.current.h);
    cur.current = { z, x: nx, y: ny };
    if (animate) {
      Animated.parallel([
        Animated.spring(scale, { toValue: z, useNativeDriver: true }),
        Animated.spring(tx, { toValue: nx, useNativeDriver: true }),
        Animated.spring(ty, { toValue: ny, useNativeDriver: true }),
      ]).start();
    } else { scale.setValue(z); tx.setValue(nx); ty.setValue(ny); }
  };
  const dist = (t: Touches) => Math.hypot(t[1].pageX - t[0].pageX, t[1].pageY - t[0].pageY);
  const panResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => {
      const t = e.nativeEvent.touches;
      start.current = { ...cur.current, dist: t.length >= 2 ? dist(t) : 0, pinched: t.length >= 2 };
    },
    onPanResponderMove: (e, g) => {
      const t = e.nativeEvent.touches;
      if (t.length >= 2) {
        // A second finger can land mid-gesture: start the pinch from there.
        if (!start.current.dist) start.current = { ...cur.current, dist: dist(t), pinched: true };
        apply(pinchZoom(start.current.z, start.current.dist, dist(t)), cur.current.x, cur.current.y);
      } else if (cur.current.z > 1 && !start.current.pinched) {
        apply(cur.current.z, start.current.x + g.dx, start.current.y + g.dy);
      }
    },
    onPanResponderRelease: (_, g) => {
      const tap = !start.current.pinched && Math.abs(g.dx) < 5 && Math.abs(g.dy) < 5;
      if (tap) apply(cur.current.z > 1 ? 1 : 2.5, 0, 0, true);
      else if (cur.current.z <= 1.01) apply(1, 0, 0, true);
    },
    onPanResponderTerminate: () => { if (cur.current.z <= 1.01) apply(1, 0, 0, true); },
  })).current;
  return (
    <View style={s.full} {...panResponder.panHandlers}
      onLayout={(e) => { box.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height }; }}
      accessible accessibilityRole="image" accessibilityLabel={label}
      accessibilityHint="Pinch to zoom. Tap to zoom in or out."
      accessibilityActions={[{ name: 'activate', label: 'Zoom in or out' }]}
      onAccessibilityAction={() => apply(cur.current.z > 1 ? 1 : 2.5, 0, 0, true)}>
      {!imgLoaded && <ActivityIndicator color={spinnerColor} style={s.center} />}
      <Animated.View style={[s.fullImg, { transform: [{ translateX: tx }, { translateY: ty }, { scale }] }]}>
        <Image source={source} style={s.fullImg} contentFit="contain"
          onLoad={() => { setImgLoaded(true); onLoaded(); }} onError={() => onFail("This photo couldn't be loaded.")} />
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  full: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  center: { position: 'absolute', top: '45%', alignSelf: 'center', zIndex: 10 },
  fullImg: { width: '100%', height: '100%' },
});

export default ZoomableImage;
