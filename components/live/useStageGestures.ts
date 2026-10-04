// components/live/useStageGestures.ts — the Go Live stage's geometry and touch.
//
// Moved out of app/live-view.tsx unchanged: the camera corner (size, position,
// drag) and pinch-to-zoom/pan on the stage. Plus movePipToNextCorner, the
// non-drag way to move the corner (a chrome button and a screen-reader action).

import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, PanResponder } from 'react-native';
import type { EdgeInsets } from 'react-native-safe-area-context';
import {
  clampPip, clampZoom, clampZoomPan, nextPipCorner, pipSize, ZOOM_MAX,
} from '../../lib/golive/stageLayout';
import { SPACING } from '../../constants/theme';

export function useStageGestures({
  win, insets, mainStream, tapStage,
}: {
  win: { width: number; height: number };
  insets: EdgeInsets;
  /** The stream on the stage; a new one resets the zoom. */
  mainStream: string | null | undefined;
  /** The stage's double-tap handler — a tap that did not travel goes to it. */
  tapStage: () => void;
}) {
  /**
   * PIP GEOMETRY, DERIVED — never a fixed 120x160 box.
   *
   * A quarter of the SHORT edge, so it is the same visual weight in portrait
   * and landscape and on any panel size, then clamped so it is neither a
   * postage stamp on a small phone nor a second stage on a tablet.
   */
  const { width: pipW, height: pipH } = pipSize(win.width, win.height);

  /**
   * THE HOST'S FACE IS IN THE WAY — move it, or send it away.
   *
   * The corner preview sits over the share, and where it sits is a guess: the
   * one thing being shared that matters might be exactly under it. It was also
   * `pointerEvents="none"`, so a viewer could not do anything about it at all.
   *
   * Drag moves it, clamped onto the safe area so it cannot be thrown off the
   * edge (clampPip, 8 checks). The chrome carries a toggle to hide it outright.
   * A tap that did not travel is forwarded to the stage's own double-tap, so the
   * chrome still toggles when the thumb lands on the corner instead of beside it.
   */
  const [pipOn, setPipOn] = useState(true);
  const [pipXY, setPipXY] = useState<{ x: number; y: number } | null>(null);
  const pipHome = { x: win.width - pipW - insets.right - SPACING.lg, y: insets.top + 56 };
  const pipAt = clampPip(
    (pipXY ?? pipHome).x, (pipXY ?? pipHome).y,
    win.width, win.height, pipW, pipH, insets.top, insets.bottom, insets.left, insets.right,
  );
  /**
   * PINCH TO ZOOM THE STAGE — the screen share and the face alike.
   *
   * Auto-fit decides how the frame meets the panel; this is the viewer looking
   * CLOSER at part of it, which is a different question and the one a shared
   * screen raises constantly — a phone screen scaled onto a phone screen is
   * legible until someone shares a spreadsheet.
   *
   * Raw touches rather than a gesture library: app/video-player.tsx already
   * pinches this way and ships, and the two now behave identically, which is
   * worth more than either being individually nicer.
   *
   * The transform lives on a wrapper around the renderer, so it applies to the
   * WebRTC surface and the HLS player without either knowing about it.
   */
  const zoom = useRef(new Animated.Value(1)).current;
  const zoomPan = useRef(new Animated.ValueXY()).current;
  /** What the gesture has settled on. The Animated values follow the fingers. */
  const zoomAt = useRef({ scale: 1, x: 0, y: 0 });
  // `scale`, `px`, `py` mirror what the gesture last set on the Animated values,
  // so release reads them here instead of through the private __getValue.
  const touch = useRef({ pinch: false, d0: 0, base: 1, x0: 0, y0: 0, moved: false, scale: 1, px: 0, py: 0 });

  // A new stream is a new picture: keeping a 3x zoom across it leaves the viewer
  // staring at a magnified corner of something they have not seen whole yet.
  useEffect(() => {
    zoomAt.current = { scale: 1, x: 0, y: 0 };
    zoom.setValue(1);
    zoomPan.setValue({ x: 0, y: 0 });
  }, [mainStream, zoom, zoomPan]);

  const stageTouchStart = useCallback((e: any) => {
    const t = e.nativeEvent.touches;
    touch.current.moved = false;
    touch.current.scale = zoomAt.current.scale;
    touch.current.px = zoomAt.current.x;
    touch.current.py = zoomAt.current.y;
    if (t.length === 2) {
      touch.current.pinch = true;
      touch.current.d0 = Math.hypot(t[1].pageX - t[0].pageX, t[1].pageY - t[0].pageY);
      touch.current.base = zoomAt.current.scale;
    } else if (t.length === 1) {
      touch.current.x0 = t[0].pageX;
      touch.current.y0 = t[0].pageY;
    }
  }, []);

  const stageTouchMove = useCallback((e: any) => {
    const t = e.nativeEvent.touches;
    if (touch.current.pinch && t.length === 2) {
      const d = Math.hypot(t[1].pageX - t[0].pageX, t[1].pageY - t[0].pageY);
      if (touch.current.d0 > 0) {
        touch.current.moved = true;
        // Tracked UNCLAMPED so the pinch feels continuous under the fingers;
        // clampZoom is what it settles to on release.
        touch.current.scale = Math.min((d / touch.current.d0) * touch.current.base, ZOOM_MAX);
        zoom.setValue(touch.current.scale);
      }
      return;
    }
    // One finger only pans once there is something to pan — at 1x the picture
    // already covers the panel, and dragging it would just reveal black.
    if (t.length === 1 && zoomAt.current.scale > 1) {
      const dx = t[0].pageX - touch.current.x0;
      const dy = t[0].pageY - touch.current.y0;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) touch.current.moved = true;
      const p = clampZoomPan(
        zoomAt.current.x + dx, zoomAt.current.y + dy,
        zoomAt.current.scale, win.width, win.height,
      );
      touch.current.px = p.x;
      touch.current.py = p.y;
      zoomPan.setValue(p);
    }
  }, [zoom, zoomPan, win.width, win.height]);

  const stageTouchEnd = useCallback(() => {
    if (touch.current.pinch) {
      touch.current.pinch = false;
      const scale = clampZoom(touch.current.scale);
      // The pan has to come back inside the SMALLER slack of the new scale, or
      // zooming out strands the picture off-centre against its own black edge.
      const p = clampZoomPan(zoomAt.current.x, zoomAt.current.y, scale, win.width, win.height);
      zoomAt.current = { scale, x: p.x, y: p.y };
      Animated.spring(zoom, { toValue: scale, useNativeDriver: true, bounciness: 0 }).start();
      Animated.spring(zoomPan, { toValue: p, useNativeDriver: true, bounciness: 0 }).start();
      return;
    }
    if (zoomAt.current.scale > 1) {
      zoomAt.current = {
        ...zoomAt.current,
        ...clampZoomPan(touch.current.px, touch.current.py, zoomAt.current.scale, win.width, win.height),
      };
    }
    // A touch that never travelled is a tap, and the tap on this layer is what
    // reveals the chrome. Pinching or panning must not also toggle it.
    if (!touch.current.moved) tapStage();
  }, [zoom, zoomPan, win.width, win.height, tapStage]);

  /** Applied to the renderer, not to the chrome — the controls never zoom. */
  const zoomStyle = {
    transform: [...zoomPan.getTranslateTransform(), { scale: zoom }],
  };

  /** Live translation during a drag. Committed to state on release. */
  const pipDrag = useRef(new Animated.ValueXY()).current;
  // The responder is created ONCE; everything it clamps against — the window,
  // the insets, the current position, the tap handler — changes every render.
  // It reads a ref for the same reason app/chat.tsx does: a captured closure
  // here means clamping a drag against the geometry of some earlier frame.
  const pipGeo = useRef({ at: pipAt, win, pipW, pipH, insets, tap: tapStage });
  pipGeo.current = { at: pipAt, win, pipW, pipH, insets, tap: tapStage };
  const pipPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderMove: Animated.event(
        [null, { dx: pipDrag.x, dy: pipDrag.y }],
        // The corner is laid out with left/top, which the native driver cannot
        // animate. It is one small view following a finger — the JS driver is
        // what this costs.
        { useNativeDriver: false },
      ),
      onPanResponderRelease: (_e, g) => {
        const d = pipGeo.current;
        // Under a few pixels this was a tap, not a drag: hand it to the stage so
        // the double-tap that reveals the chrome works over the corner too.
        if (Math.abs(g.dx) < 4 && Math.abs(g.dy) < 4) d.tap();
        else setPipXY(clampPip(
          d.at.x + g.dx, d.at.y + g.dy,
          d.win.width, d.win.height, d.pipW, d.pipH, d.insets.top, d.insets.bottom, d.insets.left, d.insets.right,
        ));
        pipDrag.setValue({ x: 0, y: 0 });
      },
      // A drag the system takes away (a notification, a call) must not leave the
      // preview translated off wherever the finger had reached.
      onPanResponderTerminate: () => pipDrag.setValue({ x: 0, y: 0 }),
    }),
  ).current;

  /** Clockwise to the next corner, for anyone who cannot (or would rather not) drag. */
  const movePipToNextCorner = () => setPipXY(nextPipCorner(
    pipAt, win.width, win.height, pipW, pipH, pipHome.y,
    insets.top, insets.bottom, insets.left, insets.right,
  ));

  return {
    pipW, pipH, pipOn, setPipOn, pipAt, pipDrag, pipPan, movePipToNextCorner,
    zoomStyle, stageTouchStart, stageTouchMove, stageTouchEnd,
  };
}
