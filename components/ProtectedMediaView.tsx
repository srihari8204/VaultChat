// components/ProtectedMediaView.tsx — VaultView protected render surface.
//
// Wraps protected media (view-once / revocable) with the three things the plain
// viewer cannot do:
//
//   1. Capture guard — refuses to render at all while the screen is being
//      recorded/mirrored or an external display is attached. On Android
//      FLAG_SECURE already blocks capture outright, so this mostly matters on
//      iOS, where blocking is impossible and refusing to decrypt is the only
//      real defence.
//   2. Dynamic watermark — the viewer's own name/number and a live timestamp,
//      tiled across the media. Anyone who photographs the screen with a second
//      phone captures their own identity along with it.
//   3. Honest status line — tells the viewer what is actually in force on THIS
//      device, rather than a fixed marketing claim. A build without the native
//      guard says so.
//
// The watermark is a deterrent and an attribution aid, not a barrier. It does
// not stop a second camera; it makes using one costly. Copy in this component
// is deliberately worded to avoid implying otherwise.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Dimensions, AppState, type AppStateStatus, type ViewStyle, useWindowDimensions} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { watch, capabilities, isSafeToRender, setSecure, type GuardState } from '../lib/screenGuard';
import type { Palette } from '../constants/theme';
import { useColors } from '../lib/theme';

export interface ProtectedMediaViewProps {
  /** Identity stamped into the overlay — the VIEWER, not the sender. */
  watermarkName?: string;
  watermarkPhone?: string;
  /** Rendered only while it is safe to do so. */
  children: React.ReactNode;
  /** Fires when the guard blocks rendering, so the caller can alert the sender. */
  onBlocked?: (reason: 'captured' | 'external') => void;
  /** Hide the bottom status line (e.g. when the host screen shows its own). */
  hideStatus?: boolean;
}

export default function ProtectedMediaView({

  watermarkName, watermarkPhone, children, onBlocked, hideStatus,
}: ProtectedMediaViewProps) {
  const c = useColors();
  const S = useMemo(() => makeS(c), [c]);
  // Reactive size. The module-level Dimensions.get above is captured ONCE at
  // import and never updates, so it froze the layout at the size the app
  // launched with. Shadowing it here makes every use in this component follow
  // rotation; StyleSheet.create keeps the initial value, which is fine for
  // static rules.
  const { width: SW, height: SH } = useWindowDimensions();

  const [guard, setGuard] = useState<GuardState>({
    captured: false, external: false, blockingSupported: false, available: false,
  });
  // Start blocked. Rendering protected media before the first guard reading has
  // arrived would show a frame during an active recording — the exact failure
  // this component exists to prevent.
  const [ready, setReady] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const blockedOnce = useRef<string | null>(null);

  // FLAG_SECURE while this surface is mounted (no-op on iOS by design).
  //
  // On unmount we re-assert the app-wide default, which is ALSO secure
  // (app/_layout.tsx calls preventScreenCaptureAsync at boot) — we must not
  // call setSecure(false) here. FLAG_SECURE is a window-level flag, so clearing
  // it would clear it for whatever screen the user lands on next: returning
  // from a protected photo into a chat set to "Block screenshots" would leave
  // that chat capturable, because chat.tsx applies its policy on mount and
  // never re-runs on the way back.
  useEffect(() => {
    setSecure(true).catch(() => {});
    return () => { setSecure(true).catch(() => {}); };
  }, []);

  useEffect(() => {
    const stop = watch(s => { setGuard(s); setReady(true); });
    return stop;
  }, []);

  // Re-check on foreground: a recording can start while the app is backgrounded,
  // and on some OS versions the transition event is missed.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st: AppStateStatus) => {
      if (st === 'active') setNow(Date.now());
    });
    return () => sub.remove();
  }, []);

  // Live timestamp in the watermark — a still photo of the screen carries the
  // moment it was taken.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const { safe, reason } = isSafeToRender(guard);
  const caps = capabilities();

  useEffect(() => {
    if (!ready || safe || !reason) return;
    if (blockedOnce.current === reason) return;
    blockedOnce.current = reason;
    onBlocked?.(reason);
  }, [ready, safe, reason, onBlocked]);

  const stamp = useMemo(() => {
    const d = new Date(now);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${d.getDate()}/${d.getMonth() + 1} ${hh}:${mm}`;
  }, [now]);

  const label = [watermarkName, watermarkPhone].filter(Boolean).join(' · ');

  if (!ready) {
    return (
      <View style={S.blocked}>
        <Ionicons name="lock-closed-outline" size={34} color="#9CA3AF" />
        <Text style={S.blockedTitle}>Checking screen…</Text>
      </View>
    );
  }

  if (!safe) {
    return (
      <View style={S.blocked}>
        <Ionicons name={reason === 'captured' ? 'videocam-off-outline' : 'tv-outline'} size={40} color="#FF3C6E" />
        <Text style={S.blockedTitle}>
          {reason === 'captured' ? 'Screen recording detected' : 'External display detected'}
        </Text>
        <Text style={S.blockedBody}>
          {reason === 'captured'
            ? 'Stop the recording or mirroring to view this message.'
            : 'Disconnect the TV, projector or mirroring to view this message.'}
        </Text>
      </View>
    );
  }

  // Tile the watermark so cropping any corner still leaves copies behind.
  const rows = Math.ceil(SH / 140);
  const cols = Math.ceil(SW / 180);

  return (
    <View style={S.wrap}>
      {children}

      <View style={S.overlay} pointerEvents="none">
        {Array.from({ length: rows }).map((_, r) => (
          <View key={r} style={S.wmRow}>
            {Array.from({ length: cols }).map((__, c) => (
              <Text key={c} style={S.wmText} numberOfLines={2}>
                {label || 'VaultChat'}{'\n'}{stamp}
              </Text>
            ))}
          </View>
        ))}
      </View>

      {!hideStatus && (
        <View style={S.status} pointerEvents="none">
          <Ionicons
            name={caps.canBlock ? 'shield-checkmark' : 'shield-half'}
            size={13}
            color={caps.canBlock ? '#00D4AA' : '#FFC53D'}
          />
          <Text style={S.statusTxt}>
            {caps.canBlock
              ? 'Screenshots blocked on this device'
              : caps.canDetectCapture
                ? 'Screenshots can\'t be blocked on iOS — the sender is told instead'
                : 'Limited protection on this build — screen capture is not monitored'}
          </Text>
        </View>
      )}
    </View>
  );
}

// Typed separately: a mixed rotate+scale array inside StyleSheet.create makes
// TS collapse EVERY key in the sheet to a style union (11 downstream errors).
const wmTransform: ViewStyle = { transform: [{ rotate: '-24deg' }, { scale: 1.4 }] };

const makeS = (c: Palette) => StyleSheet.create({
  wrap: { flex: 1 },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'space-around',
    ...wmTransform,
  },
  wmRow: { flexDirection: 'row', justifyContent: 'space-around' },
  wmText: {
    color: 'rgba(255,255,255,0.16)',
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
  },
  status: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 10, paddingHorizontal: 16,
    backgroundColor: 'rgba(0,0,0,0.72)',
  },
  statusTxt: { color: '#D1D5DB', fontSize: 11, flexShrink: 1 },   // theme-exempt: sits on the fixed rgba(0,0,0,0.72) bar below
  blocked: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.bg, padding: 32, gap: 10,
  },
  blockedTitle: { color: c.text, fontSize: 16, fontWeight: '800', textAlign: 'center' },
  blockedBody: { color: c.textDim, fontSize: 13, textAlign: 'center', lineHeight: 19 },
});
