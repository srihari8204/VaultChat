// components/call/CallTimer.tsx — the ONLY thing that re-renders once a second
// during a call.
//
// WHY THIS EXISTS
// ---------------
// Both call screens used to hold the elapsed time in their own state:
//
//     const [seconds, setSeconds] = useState(0);
//     setInterval(() => setSeconds(s => s + 1), 1000);
//
// A 1 Hz setState on the screen component re-renders the WHOLE call screen every
// second for the entire call — the control bar, the filter strip, and on the
// video screen the <RTCView> subtree carrying the live video surfaces. A ten
// minute call meant ~600 full reconciles of the most CPU-sensitive screen in the
// app, which costs frames and battery precisely while the radio, camera and
// encoder are already saturated.
//
// Isolating the tick in a leaf component means the same 600 ticks now re-render
// one <Text>. The parent renders when the CALL changes (connecting → ringing →
// connected), which is what it should have been reacting to all along.
//
// WALL-CLOCK, NOT A COUNTER
// -------------------------
// This derives elapsed time from a start timestamp instead of incrementing a
// counter, which also fixes a real defect: JS timers are throttled when the app
// is backgrounded (and Android Doze throttles them hard). A call survives
// backgrounding by design — that is the entire point of CallForegroundService —
// so an incrementing counter silently UNDER-counts, and the wrong value was
// being both displayed and written to the call log via addCallLog(). Wall-clock
// is correct regardless of how the JS thread was scheduled.
//
// The rendered format is unchanged (lib/format.ts documents the MM:SS contract).

import { memo, useEffect, useState } from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';
import { formatDuration } from '../../lib/format';

export interface CallTimerProps {
  /** Epoch ms the call connected. 0/undefined is treated as "starting now". */
  startedAt: number;
  style?: StyleProp<TextStyle>;
}

/** Seconds elapsed since `startedAt` — the value the log should record. */
export function elapsedSeconds(startedAt: number): number {
  if (!startedAt) return 0;
  return Math.max(0, Math.round((Date.now() - startedAt) / 1000));
}

function CallTimerImpl({ startedAt, style }: CallTimerProps) {
  const [text, setText] = useState(() => formatDuration(elapsedSeconds(startedAt)));

  useEffect(() => {
    // Captured per-effect (no render-phase mutation, which React Compiler is
    // entitled to run twice). A 0 startedAt means "connected right now".
    const origin = startedAt || Date.now();
    // Re-derive from the clock each tick, and only setState when the rendered
    // string actually changes — a tick landing inside the same second, or a
    // drifting interval after a throttle, then costs nothing.
    const tick = () => {
      const next = formatDuration(elapsedSeconds(origin));
      setText(prev => (prev === next ? prev : next));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  return <Text style={style}>{text}</Text>;
}

export const CallTimer = memo(CallTimerImpl);

export default CallTimer;
