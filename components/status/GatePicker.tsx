// components/status/GatePicker.tsx — choose how a status is locked.
//
// THE TWO OPTIONS ARE NOT EQUAL, AND THIS SCREEN SAYS SO.
//
// A puzzle and a question look like the same feature and are not: the question
// withholds the content KEY (scrypt over the answer, per-story salt — nobody
// without the answer can decrypt, whatever client they run), while the puzzle
// only withholds the UI, on a device that already holds the key.
//
// If both were presented as "lock your status", a poster would reasonably
// believe a puzzle protects something. It does not. So each option states what
// it actually does, and only the question is described as private. Making the
// weaker option look equally strong would be the most damaging thing this
// screen could do.

import React, { useMemo } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { GRID_MIN, GRID_MAX, isAcceptableAnswer, ANSWER_MIN_LEN } from '../../lib/status/gate';
import type { Palette } from '../../constants/theme';
import { useColors } from '../../lib/theme';

export type GateDraft =
  | { kind: 'none' }
  | { kind: 'puzzle'; grid: number }
  | { kind: 'question'; prompt: string; answer: string };

interface Props {
  value: GateDraft;
  onChange: (g: GateDraft) => void;
  accent: string;
  text: string;
  dim: string;
  surface: string;
}

const GRIDS = Array.from({ length: GRID_MAX - GRID_MIN + 1 }, (_, i) => GRID_MIN + i);

export default function GatePicker({ value, onChange, accent, text, dim, surface }: Props) {
  const c = useColors();
  const S = useMemo(() => makeS(c), [c]);
  const Opt = ({ kind, icon, title, sub }: {
    kind: GateDraft['kind']; icon: any; title: string; sub: string;
  }) => {
    const on = value.kind === kind;
    return (
      <TouchableOpacity
        style={[S.opt, { backgroundColor: surface, borderColor: on ? accent : 'transparent' }]}
        onPress={() => onChange(
          kind === 'none' ? { kind: 'none' }
            : kind === 'puzzle' ? { kind: 'puzzle', grid: 3 }
            : { kind: 'question', prompt: '', answer: '' },
        )}
        activeOpacity={0.85}
      >
        <Ionicons name={icon} size={20} color={on ? accent : dim} />
        <View style={S.optText}>
          <Text numberOfLines={1} style={[S.optTitle, { color: text }]}>{title}</Text>
          <Text style={[S.optSub, { color: dim }]}>{sub}</Text>
        </View>
        {on ? <Ionicons name="checkmark-circle" size={20} color={accent} /> : null}
      </TouchableOpacity>
    );
  };

  return (
    <View style={S.wrap}>
      <Opt kind="none" icon="earth-outline" title="Anyone in my audience"
           sub="Normal status — opens straight away" />
      <Opt kind="puzzle" icon="grid-outline" title="Solve a puzzle"
           sub="A fun unlock. Not private — anyone in your audience can still see it." />
      <Opt kind="question" icon="lock-closed-outline" title="Answer a question"
           sub="Actually private. Only someone who knows the answer can open it." />

      {value.kind === 'puzzle' && (
        <View style={[S.panel, { backgroundColor: surface }]}>
          <Text style={[S.label, { color: dim }]}>Pieces</Text>
          {/* WRAPS, never scrolls. In a horizontal scroller 9x9 sat entirely
              off-screen on a 1200px device and 8x8 was clipped, so the poster
              could not see — let alone pick — the sizes they were promised.
              A hidden option is the same as a missing one. */}
          <View style={S.chips}>
            {GRIDS.map((g) => {
              const on = value.grid === g;
              return (
                <TouchableOpacity
                  key={g}
                  onPress={() => onChange({ kind: 'puzzle', grid: g })}
                  style={[S.chip, { borderColor: on ? accent : dim, backgroundColor: on ? accent + '22' : 'transparent' }]}
                >
                  <Text style={[S.chipText, { color: on ? accent : dim }]}>{g}×{g}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text style={[S.note, { color: dim }]}>
            {value.grid * value.grid} pieces
            {value.grid >= 7 ? ' — that is a lot on a phone screen' : ''}
          </Text>
        </View>
      )}

      {value.kind === 'question' && (
        <View style={[S.panel, { backgroundColor: surface }]}>
          <Text style={[S.label, { color: dim }]}>Question</Text>
          <TextInput
            value={value.prompt}
            onChangeText={(t) => onChange({ ...value, prompt: t })}
            placeholder="Where did we first meet?"
            placeholderTextColor={dim}
            style={[S.input, { color: text, borderColor: dim }]}
            maxLength={200}
          />
          <Text style={[S.label, { color: dim, marginTop: 12 }]}>Answer</Text>
          <TextInput
            value={value.answer}
            onChangeText={(t) => onChange({ ...value, answer: t })}
            placeholder="Only they would know this"
            placeholderTextColor={dim}
            style={[S.input, { color: text, borderColor: dim }]}
            maxLength={100}
            autoCapitalize="none"
          />
          {/* Spelling and spacing are forgiven; the secret is not recoverable.
              Both facts change what a poster chooses, so both are said here. */}
          <Text style={[S.note, { color: dim }]}>
            Capitals and extra spaces don’t matter.
          </Text>
          <Text style={[S.note, { color: dim }]}>
            Pick something guessers can’t — a birthday or a pet’s name is quick to guess.
            You can’t recover this later, and neither can we.
          </Text>
          {value.answer.length > 0 && !isAcceptableAnswer(value.answer) && (
            <Text style={[S.note, { color: '#E5533D' }]}>
              Needs at least {ANSWER_MIN_LEN} characters.
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

const makeS = (c: Palette) => StyleSheet.create({
  wrap: { gap: 8 },
  opt: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14, borderWidth: 1.5 },
  optText: { flex: 1 },
  optTitle: { fontSize: 15, fontWeight: '600' },
  optSub: { fontSize: 12, marginTop: 2, lineHeight: 16 },
  panel: { padding: 14, borderRadius: 14, marginTop: 2 },
  label: { fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', fontWeight: '700' },
  chips: { marginTop: 10, flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1.5 },
  chipText: { fontSize: 14, fontWeight: '700' },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, marginTop: 6, fontSize: 15 },
  note: { fontSize: 12, marginTop: 8, lineHeight: 17 },
});
