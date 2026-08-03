// components/call/CallReactions.tsx — tapped reactions, floating up and gone.
//
// Two pieces: the picker row, and the overlay that animates what arrives.
//
// The animation runs on the NATIVE driver and each emoji animates exactly ONCE,
// keyed by its id. That matters more than it looks: the reducer keeps a bounded
// list of recent reactions (MAX_CALL_REACTIONS), so every re-render of the call
// screen hands this component the same few entries again. Driving the animation
// from a mount effect keyed by id means a re-render never re-fires a burst, and
// the JS thread stays out of the per-frame path entirely — which is the whole
// point during a video call, when the encoder already owns the CPU.

import { memo, useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { CallReaction } from '../../lib/call/types';

/** The set a user can send. Short, and identical on both platforms. */
export const CALL_EMOJI = ['❤️', '😂', '👍', '👏', '🎉', '😮'] as const;

const Floater = memo(function Floater({ emoji, lane }: { emoji: string; lane: number }) {
  const t = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(t, {
      toValue: 1, duration: 2600, easing: Easing.out(Easing.quad), useNativeDriver: true,
    }).start();
  }, [t]);

  return (
    <Animated.Text
      style={[
        S.floater,
        {
          right: 18 + lane * 26,
          opacity: t.interpolate({ inputRange: [0, 0.15, 0.75, 1], outputRange: [0, 1, 1, 0] }),
          transform: [
            { translateY: t.interpolate({ inputRange: [0, 1], outputRange: [0, -190] }) },
            { scale: t.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0.6, 1.15, 0.9] }) },
          ],
        },
      ]}
    >
      {emoji}
    </Animated.Text>
  );
});

/**
 * Which of the three columns an emoji floats up. Derived from the id, NOT from
 * the array index: the reducer caps the list, so indices shift when an old entry
 * is dropped, and an index-derived lane would slide a mid-flight emoji sideways.
 */
function laneOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % 3;
}

/** Overlay. Absolutely positioned and pointerEvents="none" — never eats a tap. */
export const ReactionOverlay = memo(function ReactionOverlay(
  { reactions }: { reactions: readonly CallReaction[] },
) {
  return (
    <View style={S.overlay} pointerEvents="none">
      {reactions.map(r => <Floater key={r.id} emoji={r.emoji} lane={laneOf(r.id)} />)}
    </View>
  );
});

/** The picker row, shown above the control bar while open. */
export const ReactionPicker = memo(function ReactionPicker(
  { onPick }: { onPick: (emoji: string) => void },
) {
  return (
    <View style={S.picker}>
      {CALL_EMOJI.map(e => (
        <TouchableOpacity key={e} onPress={() => onPick(e)} hitSlop={6} style={S.pick}>
          <Text style={S.pickText}>{e}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
});

const S = StyleSheet.create({
  overlay:   { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end', paddingBottom: 140 },
  floater:   { position: 'absolute', bottom: 0, fontSize: 30 },
  picker:    { flexDirection: 'row', justifyContent: 'center', gap: 6, paddingBottom: 10 },
  pick:      { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
               backgroundColor: 'rgba(255,255,255,0.12)' },
  pickText:  { fontSize: 22 },
});

export default ReactionOverlay;
