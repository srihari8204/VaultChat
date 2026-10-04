// components/chat/Composer.tsx — the message composer: the input pill with
// stickers/attach/camera, the mic-or-send button, and the voice-recording
// strip that replaces it while recording. Moved out of app/chat.tsx unchanged.
// The camera button's slide-up-for-video-note gesture and its animations are
// local to it and moved with it; every action is a prop.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, PanResponder, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { GlassView } from '../ui';
import { useTheme } from '../../lib/theme';
import { formatRecDuration } from './chatFormat';
import { useS } from './chatStyles';

// The glyph ink on S.sendFab (send, mic, the spinner). Its fill is accentDeep
// #1552E0 in BOTH themes, where white is 6.33:1. Not colors.onPrimary: that is
// the ink for the `primary` fill (#1777FE in dark), and its dark value waits on
// an open design decision (see AuroraDark.onPrimary in constants/theme.ts) that
// must not restyle this button by accident. It is white in both palettes today.
const ON_SEND_FAB = '#fff';

export function Composer({
  recording, recElapsedMs, cancelRecording, stopAndSendRecording, editingId, gifOpen, onOpenGif,
  input, onInputChange, composerMax, onPressAttach, sending, onOpenCamera, startRecording, onSend,
}: {
  recording: boolean;
  recElapsedMs: number;
  cancelRecording: () => void;
  stopAndSendRecording: () => void;
  editingId: number | null;
  gifOpen: boolean;
  onOpenGif: () => void;
  input: string;
  onInputChange: (text: string) => void;
  composerMax: number;
  onPressAttach: () => void;
  sending: boolean;
  /** Tap = camera; 'note' = slid up for a round video note. */
  onOpenCamera: (startMode?: 'note') => void;
  startRecording: () => void;
  onSend: (silent?: boolean) => void;
}) {
  const S = useS();
  const { colors } = useTheme();
  // Keep the latest handler in a ref so the once-created PanResponder never goes stale.
  const openCameraRef = useRef(onOpenCamera);
  openCameraRef.current = onOpenCamera;

  // Animation values: camDragY (icon follows finger), hintProg (drag hint 0→1
  // as you slide up, "armed" near 1), chevPulse (idle discovery cue loop).
  const camDragY = useRef(new Animated.Value(0)).current;
  const hintProg = useRef(new Animated.Value(0)).current;
  const chevPulse = useRef(new Animated.Value(0)).current;
  const [camDragging, setCamDragging] = useState(false);
  const camDraggingRef = useRef(false);
  const ARM_DIST = 56; // px to slide up to "arm" the video note
  // ~11s of hinting, then the screen is allowed to go quiet.
  const CHEV_PULSES = 6;

  // Gentle up-chevron above the camera icon so users discover slide-up.
  //
  // BOUNDED, because this is DECORATION ON THE MOST-OPENED SCREEN IN THE APP.
  //
  // It used to be an unbounded Animated.loop: it pulsed for the entire life of
  // the chat screen, forever, whether or not anyone was looking at the camera
  // icon. Two costs, one of them invisible:
  //
  //   * the UI thread never goes idle while a chat is open. Every 950ms tick is
  //     a wake-up and a frame the compositor has to produce, for a hint the
  //     user has either taken or ignored within the first few seconds.
  //   * it makes the screen untestable. `uiautomator dump` waits for an idle
  //     window and NEVER gets one, so no automated check can read a chat screen
  //     at all — which is how this was found.
  //
  // CHEV_PULSES is a discovery cue, not an indicator: after a handful of cycles
  // it has done its job. Anything that reports live STATE (a recording dot, a
  // transfer spinner) must keep looping — this is not that, and the rest of the
  // app's loops are deliberately left alone.
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(chevPulse, { toValue: 1, duration: 950, useNativeDriver: true }),
        Animated.timing(chevPulse, { toValue: 0, duration: 950, useNativeDriver: true }),
      ]),
      { iterations: CHEV_PULSES },
    );
    loop.start();
    // Still stopped on unmount: leaving a running animation attached to a
    // torn-down screen keeps its node alive.
    return () => loop.stop();
  }, [chevPulse]);

  const resetCamDrag = useCallback(() => {
    camDraggingRef.current = false; setCamDragging(false);
    Animated.spring(camDragY, { toValue: 0, useNativeDriver: true, friction: 6, tension: 90 }).start();
    Animated.timing(hintProg, { toValue: 0, duration: 140, useNativeDriver: true }).start();
  }, [camDragY, hintProg]);

  const cameraPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 6,
      onPanResponderMove: (_e, g) => {
        if (!camDraggingRef.current && Math.abs(g.dy) > 6) { camDraggingRef.current = true; setCamDragging(true); }
        const dy = Math.max(-72, Math.min(0, g.dy));
        camDragY.setValue(dy);
        hintProg.setValue(Math.min(1, -dy / ARM_DIST));
      },
      onPanResponderRelease: (_e, g) => {
        const armed = g.dy < -24;
        const tap = Math.abs(g.dy) < 12 && Math.abs(g.dx) < 12;
        resetCamDrag();
        if (armed) openCameraRef.current('note');   // slid up → video note
        else if (tap) openCameraRef.current();       // tap → camera
      },
      onPanResponderTerminate: () => resetCamDrag(),
    }),
  ).current;

  return (
    <>
      {/* Composer — either normal or recording mode */}
      {recording ? (
        <View style={[S.composer, S.recordingComposer]}>
          <View style={S.recordingDot} />
          <Text style={S.recordingTimer}>{formatRecDuration(recElapsedMs)}</Text>
          <Text style={S.recordingHint}>Tap the bin to discard · send to finish</Text>
          <TouchableOpacity style={S.recCancelBtn} onPress={cancelRecording} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel="Discard voice message">
            <Ionicons name="trash-outline" size={22} color={colors.danger} />
          </TouchableOpacity>
          <TouchableOpacity style={S.sendFab} onPress={stopAndSendRecording} activeOpacity={0.85} accessibilityRole="button" accessibilityLabel="Send voice message">
            <Ionicons name="send" size={20} color={ON_SEND_FAB} style={{ marginLeft: 2 }} />
          </TouchableOpacity>
        </View>
      ) : (
        <GlassView kind="chrome" bordered={false} highlight style={S.composerGlass}>
        <View style={S.composer}>
          <View style={S.inputPill}>
            {editingId == null && (
              <TouchableOpacity
                style={S.pillIconBtn}
                onPress={onOpenGif} accessibilityRole="button" accessibilityLabel="Stickers, emoji and GIFs"
                activeOpacity={0.7}
                hitSlop={6}
              >
                {/* ONE button for stickers, emojis and GIFs — they are three
                    tabs of the same KLIPY sheet (/gif/search?type=…), so there
                    is nothing to merge and nothing to duplicate. A sticker
                    glyph rather than a smiley because it opens ON stickers. */}
                <MaterialCommunityIcons
                  name={gifOpen ? 'sticker' : 'sticker-emoji'}
                  size={24}
                  color={gifOpen ? colors.primary : colors.textDim}
                />
              </TouchableOpacity>
            )}
            <TextInput
              style={[S.input, { maxHeight: composerMax }]}
              placeholder={editingId != null ? 'Edit message…' : 'Message'}
              placeholderTextColor={colors.textDim}
              value={input}
              onChangeText={onInputChange}
              multiline
              maxLength={4000}
              accessibilityLabel={editingId != null ? 'Edit message' : 'Message'}
            />
            {editingId == null && (
              <>
                <TouchableOpacity
                  style={S.pillIconBtn}
                  onPress={onPressAttach} accessibilityRole="button" accessibilityLabel="Attach"
                  accessibilityState={{ disabled: sending }}
                  disabled={sending}
                  activeOpacity={0.7}
                  hitSlop={6}
                >
                  <Ionicons name="attach" size={24} color={colors.textDim} style={{ transform: [{ rotate: '45deg' }] }} />
                </TouchableOpacity>
                <View style={S.camWrap}>
                  {/* Drag hint pill — rises + arms as you slide up */}
                  {camDragging && (
                    <Animated.View
                      pointerEvents="none"
                      style={[S.camDragHint, {
                        opacity: hintProg,
                        transform: [
                          { translateY: hintProg.interpolate({ inputRange: [0, 1], outputRange: [4, -8] }) },
                          { scale: hintProg.interpolate({ inputRange: [0, 0.85, 1], outputRange: [0.8, 1, 1.12] }) },
                        ],
                      }]}
                    >
                      <Ionicons name="videocam" size={13} color={colors.onPrimary} />
                      <Text style={S.camDragHintTxt}>Video note</Text>
                    </Animated.View>
                  )}
                  {/* Idle discovery cue — subtle pulsing chevron */}
                  {!camDragging && !sending && (
                    <Animated.View
                      pointerEvents="none"
                      style={[S.camHintChevron, {
                        opacity: chevPulse.interpolate({ inputRange: [0, 1], outputRange: [0.2, 0.65] }),
                        transform: [{ translateY: chevPulse.interpolate({ inputRange: [0, 1], outputRange: [2, -3] }) }],
                      }]}
                    >
                      <Ionicons name="chevron-up" size={12} color={colors.textDim} />
                    </Animated.View>
                  )}
                  <Animated.View
                    style={[S.pillIconBtn, { transform: [{ translateY: camDragY }] }]}
                    {...cameraPan.panHandlers}
                    // The pan gesture is invisible to screen readers, so tap
                    // (camera) and slide-up (video note) are exposed as actions.
                    accessible
                    accessibilityRole="button"
                    accessibilityLabel="Camera"
                    accessibilityHint="Slide up to record a video note"
                    accessibilityActions={[{ name: 'activate' }, { name: 'videoNote', label: 'Record video note' }]}
                    onAccessibilityAction={(e) => {
                      if (e.nativeEvent.actionName === 'activate') openCameraRef.current();
                      else if (e.nativeEvent.actionName === 'videoNote') openCameraRef.current('note');
                    }}
                  >
                    {/* Arming ring fades/scales in while dragging up */}
                    <Animated.View
                      pointerEvents="none"
                      style={[S.camRing, {
                        opacity: hintProg,
                        transform: [{ scale: hintProg.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.15] }) }],
                      }]}
                    />
                    <Ionicons name="camera-outline" size={24} color={colors.textDim} />
                  </Animated.View>
                </View>
              </>
            )}
          </View>
          {/* Mic when input is empty + not editing; otherwise Send takes its place */}
          {editingId == null && input.trim().length === 0 ? (
            <TouchableOpacity
              style={S.sendFab}
              onPress={startRecording} accessibilityRole="button" accessibilityLabel="Record a voice message"
              accessibilityState={{ disabled: sending }}
              disabled={sending}
              activeOpacity={0.85}
            >
              <Ionicons name="mic" size={23} color={ON_SEND_FAB} />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[S.sendFab, (!input.trim() || sending) && S.sendBtnOff]}
              onPress={() => onSend(false)} accessibilityRole="button" accessibilityLabel={editingId != null ? 'Save edit' : 'Send'}
              accessibilityHint={editingId == null ? 'Long-press to send without sound' : undefined}
              accessibilityState={{ disabled: !input.trim() || sending, busy: sending }}
              // The silent long-press, for screen readers (which cannot long-press reliably).
              accessibilityActions={editingId == null ? [{ name: 'activate' }, { name: 'silent', label: 'Send without sound' }] : undefined}
              onAccessibilityAction={(e) => {
                if (e.nativeEvent.actionName === 'activate') onSend(false);
                else if (e.nativeEvent.actionName === 'silent' && input.trim() && !sending) onSend(true);
              }}
              onLongPress={() => { if (input.trim() && !sending && editingId == null) onSend(true); }}
              delayLongPress={300}
              disabled={!input.trim() || sending}
              activeOpacity={0.85}
            >
              {sending
                ? <ActivityIndicator size="small" color={ON_SEND_FAB} />
                : <Ionicons name={editingId != null ? 'checkmark' : 'send'} size={editingId != null ? 24 : 20} color={ON_SEND_FAB} style={editingId != null ? undefined : { marginLeft: 2 }} />}
            </TouchableOpacity>
          )}
        </View>
        </GlassView>
      )}
    </>
  );
}
