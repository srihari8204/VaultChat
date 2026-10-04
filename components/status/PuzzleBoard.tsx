// components/status/PuzzleBoard.tsx — the tap-to-swap jigsaw a viewer solves.
//
// TAP TWO PIECES TO SWAP THEM, rather than drag-and-drop. Three reasons, and
// the first is the one that decides it:
//
//   * Every permutation is reachable, so a status can never be published that
//     nobody can open. A sliding puzzle would look more familiar and be a
//     trap — half of random 15-puzzle shuffles are unsolvable.
//   * At 9x9 a piece is ~40px on a phone. Dragging something that small next to
//     80 identical neighbours is fiddly; two taps is not.
//   * It needs no gesture handler competing with the story viewer's own
//     tap-to-advance and swipe-to-dismiss.
//
// The image is rendered ONCE per piece, scaled up by `grid` and offset, so each
// tile shows its own crop. That is why the pieces are genuinely part of one
// picture rather than N separate downloads.
//
// HONESTY: this gate is ENGAGEMENT, not protection. The viewer already holds
// the content key by the time this renders — solving decides when the UI
// reveals it, and a modified client skips it. The image handed to this
// component should therefore be a degraded preview, never the full-resolution
// media. See lib/status/gate.ts.

import React, { useCallback, useMemo, useState } from 'react';
import { View, Image, TouchableOpacity, StyleSheet, Text } from 'react-native';
import { isSolved, shuffle, pieceCount } from '../../lib/status/gate';

interface Props {
  /** Degraded preview to cut into pieces. */
  uri: string;
  /** 3..9. */
  grid: number;
  /** Board edge in px. */
  size: number;
  /** Fired once, when the arrangement first becomes correct. */
  onSolved: () => void;
  accent: string;
  dim: string;
}

export default function PuzzleBoard({ uri, grid, size, onSolved, accent, dim }: Props) {
  const count = pieceCount(grid);
  // Shuffled ONCE per mount. Re-shuffling on re-render would silently undo a
  // viewer's progress every time the parent re-rendered.
  const [order, setOrder] = useState<number[]>(() => shuffle(count, Math.random));
  const [picked, setPicked] = useState<number | null>(null);
  const [done, setDone] = useState(false);

  const tile = size / grid;

  const tap = useCallback((slot: number) => {
    if (done) return;
    if (picked === null) { setPicked(slot); return; }
    if (picked === slot) { setPicked(null); return; }   // tap again to deselect

    setOrder((prev) => {
      const next = [...prev];
      [next[picked], next[slot]] = [next[slot], next[picked]];
      // Fire on the transition only. onSolved is a navigation/reveal trigger,
      // and calling it on every later render would re-trigger the reveal.
      if (!done && isSolved(next)) { setDone(true); setTimeout(onSolved, 220); }
      return next;
    });
    setPicked(null);
  }, [picked, done, onSolved]);

  const tiles = useMemo(() => order.map((piece, slot) => {
    const pr = Math.floor(piece / grid);
    const pc = piece % grid;
    return (
      <TouchableOpacity
        key={slot}
        activeOpacity={0.85}
        onPress={() => tap(slot)}
        // The picture cannot be spoken, but each slot can be named and picked:
        // "row 2, column 3", selected while it waits for its swap partner.
        accessibilityRole="button"
        accessibilityLabel={`Piece at row ${Math.floor(slot / grid) + 1}, column ${(slot % grid) + 1}`}
        accessibilityState={{ selected: picked === slot, disabled: done }}
        style={[
          S.slot,
          {
            width: tile, height: tile,
            left: (slot % grid) * tile,
            top: Math.floor(slot / grid) * tile,
            borderColor: picked === slot ? accent : 'transparent',
            borderWidth: picked === slot ? 2 : 0,
          },
        ]}
      >
        <View style={S.clip}>
          <Image
            source={{ uri }}
            style={{
              width: size, height: size,
              marginLeft: -pc * tile,
              marginTop: -pr * tile,
            }}
          />
        </View>
      </TouchableOpacity>
    );
  }), [order, picked, done, grid, tile, size, uri, accent, tap]);

  return (
    <View>
      <View style={[S.board, { width: size, height: size, borderColor: dim }]}>
        {tiles}
      </View>
      <Text style={[S.hint, { color: dim }]} accessibilityLiveRegion="polite">
        {done ? 'Solved' : picked === null ? 'Tap a piece, then tap where it goes' : 'Now tap its place'}
      </Text>
    </View>
  );
}

const S = StyleSheet.create({
  board: { position: 'relative', borderRadius: 14, overflow: 'hidden', borderWidth: 1 },
  slot: { position: 'absolute', borderRadius: 4, overflow: 'hidden' },
  clip: { flex: 1, overflow: 'hidden' },
  hint: { textAlign: 'center', marginTop: 10, fontSize: 13 },
});
