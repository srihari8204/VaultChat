// components/CallBar.tsx — the "you are on a call" bar.
//
// WHY THIS EXISTS
// ---------------
// A call used to take the whole app hostage. The engine has always owned the
// call outside React, but the call screen's unmount handler said "hang up", so
// the only way off that screen was Android's system picture-in-picture — which
// shrinks the entire activity and still does not let you open a chat. On a call
// about something IN the app ("send me that file", "what did she say?") you had
// to hang up to answer.
//
// Every mainstream messenger solves this the same way: a persistent bar at the
// top, the call still running behind it, tap to go back. That is this.
//
// It renders directly under the status bar, above the navigator, so it survives
// every screen change — and it hides itself on the call screens themselves,
// where it would be pointing at the screen you are already looking at.

import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, usePathname } from 'expo-router';
import { deriveLayout } from '../constants/layoutMath';
import { getSnapshot, subscribe } from '../lib/call/store';
import { CALL } from '../constants/callTheme';

/** mm:ss, and h:mm:ss once a call runs past the hour. */
function elapsed(connectedAt: number, now: number): string {
  if (!connectedAt) return 'Connecting…';
  const t = Math.max(0, Math.floor((now - connectedAt) / 1000));
  const s = t % 60, m = Math.floor(t / 60) % 60, h = Math.floor(t / 3600);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** The routes that ARE the call — the bar would be redundant there. */
const CALL_ROUTES = ['/videocall', '/voicecall', '/group-call-active', '/incoming-call'];

export function CallBar() {
  const router = useRouter();
  const pathname = usePathname();
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // The bar is mounted ONCE, above the navigator, for the whole life of the
  // process. That made HEADER_TOP the wrong tool: it was read into a
  // module-scope StyleSheet the first time this file was imported - the
  // earliest possible moment, before anything had synced real metrics - and
  // then never read again. A rotation, a fold or a split-screen resize left
  // the green bar padded for the old status bar, either overlapping the clock
  // or floating below it, for as long as the app stayed open.
  //
  // deriveLayout is the same rule HEADER_TOP is computed from, run here
  // against live values, so the bar follows the window without depending on
  // whether the theme provider has synced yet (2026-09-17).
  const insets = useSafeAreaInsets();
  const win = useWindowDimensions();
  const { headerTop } = deriveLayout({
    top: insets.top, bottom: insets.bottom, width: win.width, height: win.height,
  });

  // Ticks only while the bar is actually on screen — see the effect's guard.
  const [now, setNow] = useState(() => Date.now());

  const live = snap.status !== 'ended' && !!snap.chatId;
  const onCallScreen = CALL_ROUTES.some(r => (pathname || '').startsWith(r));
  const show = live && !onCallScreen;

  useEffect(() => {
    if (!show || !snap.connectedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [show, snap.connectedAt]);

  if (!show) return null;

  const name = snap.peerName || 'crazzychat user';
  const kind = snap.kind || 'audio';

  const back = () => {
    if (!snap.chatId) return;
    if (!snap.peerUid) {
      router.push({
        pathname: '/group-call-active',
        params: { chatId: snap.chatId, video: kind === 'video' ? '1' : '0', name: snap.peerName },
      });
      return;
    }
    router.push({
      pathname: kind === 'video' ? '/videocall' : '/voicecall',
      params: {
        chatId: snap.chatId,
        peerUid: snap.peerUid,
        peerName: snap.peerName,
        // NOT incoming: the call is already answered and running. Passing
        // incoming here would send the screen down the acceptIncoming path
        // against a live session.
        resume: '1',
      },
    });
  };

  return (
    <View style={[styles.wrap, { paddingTop: headerTop }]} accessibilityRole="toolbar">
      <TouchableOpacity
        style={styles.tap}
        onPress={back}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={`Return to ${kind} call with ${name}, ${elapsed(snap.connectedAt, now)}`}
      >
        <Ionicons name={kind === 'video' ? 'videocam' : 'call'} size={16} color={CALL.text} />
        <Text style={styles.name} numberOfLines={1}>{name}</Text>
        <Text style={styles.timer} numberOfLines={1} maxFontSizeMultiplier={1.2}>
          {elapsed(snap.connectedAt, now)}
        </Text>
        <Text style={styles.cta} numberOfLines={1} maxFontSizeMultiplier={1.2}>Tap to return</Text>
      </TouchableOpacity>

      {/* Ending from here matters: without it, leaving the call screen would
          mean the only way to hang up is to navigate back into it first. */}
      <TouchableOpacity
        style={styles.end}
        onPress={() => { import('../lib/call/engine').then(m => m.hangUp('local_hangup', true)).catch(() => {}); }}
        accessibilityRole="button"
        accessibilityLabel="End call"
        hitSlop={8}
      >
        <Ionicons name="call" size={15} color={CALL.text} style={{ transform: [{ rotate: '135deg' }] }} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  // Fixed colour, not the app palette: this is an alert surface and must read
  // the same in Light and Dark, exactly like the call screens (callTheme.ts).
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: CALL.bar,
    // paddingTop is applied at the element from live insets - see above.
    paddingBottom: 8,
    paddingHorizontal: 14,
    gap: 10,
  },
  tap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
  name: { color: CALL.text, fontSize: 14, fontWeight: '700', flexShrink: 1, minWidth: 0 },
  timer: {
    color: 'rgba(255,255,255,0.95)',
    fontSize: 13,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    flexShrink: 0,
  },
  cta: {
    color: CALL.barHint,
    fontSize: 12,
    marginLeft: 'auto',
    flexShrink: 0,
    // Hidden on narrow screens rather than squeezing the name.
    display: Platform.OS === 'web' ? 'flex' : 'flex',
  },
  end: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(0,0,0,0.28)',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
});

export default CallBar;
