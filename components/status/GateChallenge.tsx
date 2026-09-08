// components/status/GateChallenge.tsx — what a viewer sees before a locked status.
//
// Two gates, one screen, and they behave differently on purpose:
//
//   PUZZLE    The content is already decryptable on this device. Solving is a
//             UI transition. It is presented as a game, not a lock, because
//             calling it a lock would be a lie the user could act on.
//
//   QUESTION  The answer derives the key. A wrong answer cannot be told apart
//             from a tampered envelope — both simply fail to decrypt — so the
//             only honest feedback is "that is not it", with no hint, no
//             partial match, and no attempt counter that would imply the server
//             is checking. It is not; nothing here talks to the server at all.
//
// The poster never sees their own gate: they hold the raw key locally
// (putMediaKey at post time), so their own status opens straight away.

import React, { useCallback, useState, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import PuzzleBoard from './PuzzleBoard';
import type { Palette } from '../../constants/theme';
import { useColors } from '../../lib/theme';

interface Props {
  kind: 'puzzle' | 'question';
  /** puzzle: grid size. */
  grid?: number;
  /** puzzle: the image to cut up.
   *
   *  HONEST NOTE: today the viewer passes the DECRYPTED media itself, because
   *  for a puzzle it already holds the key — the pieces reveal nothing it could
   *  not already see, so this is not a leak. It is still not ideal: a separate
   *  low-resolution preview would keep the full image off screen until solved,
   *  and would be required if a puzzle ever gated content the viewer could NOT
   *  otherwise decrypt. It cannot, and must not be changed to imply it can. */
  previewUri?: string;
  /** puzzle: the preview is still being produced (media decrypting, or the
   *  video frame being extracted). Kept SEPARATE from `previewUri` being
   *  absent, because the two need opposite treatment: pending must wait, while
   *  genuinely-absent must let the viewer through. Collapsing them showed the
   *  Open button during every decrypt, which skipped the puzzle on a fast tap. */
  previewPending?: boolean;
  /** question: what to ask. */
  prompt?: string;
  /** question: returns true when the answer unlocked the key. */
  onAnswer?: (answer: string) => Promise<boolean>;
  onSolved: () => void;
  onDismiss: () => void;
  accent: string;
}

export default function GateChallenge({
  kind, grid, previewUri, previewPending, prompt, onAnswer, onSolved, onDismiss, accent,
}: Props) {
  const c = useColors();
  const S = useMemo(() => makeS(c), [c]);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState(false);

  const submit = useCallback(async () => {
    if (busy || !onAnswer || !answer.trim()) return;
    setBusy(true);
    setWrong(false);
    try {
      const ok = await onAnswer(answer);
      if (ok) onSolved();
      else setWrong(true);
    } catch {
      // Deriving the key is scrypt work and can be interrupted; a failure here
      // is indistinguishable from a wrong answer, so it is reported the same
      // way rather than as an error the viewer cannot act on.
      setWrong(true);
    } finally {
      setBusy(false);
    }
  }, [answer, busy, onAnswer, onSolved]);

  // Live window, not a static read: this challenge can be on screen when the
  // device rotates, and a board sized for portrait either overflows the
  // landscape width or leaves the puzzle tiny. useWindowDimensions
  // re-renders on the change; Dimensions.get does not subscribe.
  const { width: winW } = useWindowDimensions();
  const board = Math.min(winW - 48, 340);

  return (
    <View style={S.wrap}>
      <TouchableOpacity style={S.close} onPress={onDismiss} hitSlop={12}>
        <Ionicons name="close" size={26} color="#fff" />
      </TouchableOpacity>

      {kind === 'puzzle' ? (
        <>
          <Ionicons name="grid-outline" size={30} color={accent} />
          <Text style={S.title}>Solve to see it</Text>
          {previewUri && grid ? (
            <View style={{ marginTop: 18 }}>
              <PuzzleBoard
                uri={previewUri}
                grid={grid}
                size={board}
                onSolved={onSolved}
                accent={accent}
                dim="rgba(255,255,255,0.55)"
              />
            </View>
          ) : previewPending ? (
            // Still decrypting. Showing the Open fallback here would hand the
            // viewer a one-tap skip past the puzzle every single time.
            <View style={{ marginTop: 28, alignItems: 'center', gap: 12 }}>
              <ActivityIndicator color={accent} size="large" />
              <Text style={S.hint}>Getting the pieces ready…</Text>
            </View>
          ) : (
            // No preview means nothing to cut up. Letting the viewer through is
            // correct: the puzzle was never protection, and trapping them behind
            // a board that cannot render would deny access it never guarded.
            <TouchableOpacity style={[S.btn, { backgroundColor: accent }]} onPress={onSolved}>
              <Text style={S.btnText}>Open</Text>
            </TouchableOpacity>
          )}
        </>
      ) : (
        <>
          <Ionicons name="lock-closed-outline" size={30} color={accent} />
          <Text style={S.title}>{prompt || 'Answer to unlock'}</Text>
          <TextInput
            value={answer}
            onChangeText={(t) => { setAnswer(t); setWrong(false); }}
            placeholder="Your answer"
            placeholderTextColor="rgba(255,255,255,0.45)"
            style={S.input}
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={submit}
            returnKeyType="go"
            editable={!busy}
          />
          {wrong && <Text style={S.wrong}>That’s not it. Try again.</Text>}
          <TouchableOpacity
            style={[S.btn, { backgroundColor: accent, opacity: busy || !answer.trim() ? 0.5 : 1 }]}
            onPress={submit}
            disabled={busy || !answer.trim()}
          >
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={S.btnText}>Unlock</Text>}
          </TouchableOpacity>
          <Text style={S.hint}>Capitals and extra spaces don’t matter.</Text>
        </>
      )}
    </View>
  );
}

const makeS = (c: Palette) => StyleSheet.create({
  wrap: { flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', padding: 24 },
  close: { position: 'absolute', top: 48, left: 20, zIndex: 2 },
  title: { color: '#fff', fontSize: 19, fontWeight: '600', marginTop: 14, textAlign: 'center', lineHeight: 26 },
  input: {
    width: '100%', marginTop: 20, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14,
    backgroundColor: 'rgba(255,255,255,0.10)', color: '#fff', fontSize: 16,
  },
  wrong: { color: '#FF8A7A', marginTop: 10, fontSize: 13 },
  btn: { marginTop: 18, paddingHorizontal: 32, paddingVertical: 14, borderRadius: 999, minWidth: 160, alignItems: 'center' },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  hint: { color: 'rgba(255,255,255,0.45)', fontSize: 12, marginTop: 14 },
});
