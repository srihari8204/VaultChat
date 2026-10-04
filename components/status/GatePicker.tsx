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

import React, { useState } from 'react';
import { View, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
// AppText, not RN Text: it follows the vision-comfort scale the rest of the
// status screen already gets.
import { AppText as Text } from '../ui/Text';
import { Ionicons } from '@expo/vector-icons';
import { GRID_MIN, GRID_MAX, isAcceptableAnswer, ANSWER_MIN_LEN } from '../../lib/status/gate';
import { AuroraDark } from '../../constants/theme';
import { tint } from '../../lib/tintColor';

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

// The picker is drawn on the status preview, which is always dark
// (app/(tabs)/status.tsx), so its error ink is the dark palette's danger.
const ERROR_INK = AuroraDark.danger;

type Ink = Pick<Props, 'accent' | 'text' | 'dim' | 'surface'>;

// Hoisted out of render so React keeps one component identity across renders.
function Opt({ kind, icon, title, sub, value, onChange, ink }: {
  kind: GateDraft['kind']; icon: React.ComponentProps<typeof Ionicons>['name']; title: string; sub: string;
  value: GateDraft; onChange: (g: GateDraft) => void; ink: Ink;
}) {
  const on = value.kind === kind;
  return (
    <TouchableOpacity
      style={[S.opt, { backgroundColor: ink.surface, borderColor: on ? ink.accent : 'transparent' }]}
      onPress={() => onChange(
        kind === 'none' ? { kind: 'none' }
          : kind === 'puzzle' ? { kind: 'puzzle', grid: 3 }
          : { kind: 'question', prompt: '', answer: '' },
      )}
      activeOpacity={0.85}
      accessibilityRole="radio"
      accessibilityLabel={`${title}. ${sub}`}
      accessibilityState={{ checked: on }}
    >
      <Ionicons name={icon} size={20} color={on ? ink.accent : ink.dim} />
      <View style={S.optText}>
        <Text numberOfLines={1} style={[S.optTitle, { color: ink.text }]}>{title}</Text>
        <Text style={[S.optSub, { color: ink.dim }]}>{sub}</Text>
      </View>
      {on ? <Ionicons name="checkmark-circle" size={20} color={ink.accent} /> : null}
    </TouchableOpacity>
  );
}

export default function GatePicker({ value, onChange, accent, text, dim, surface }: Props) {
  // Hidden by default (shoulder-surfing), but the poster must be able to check
  // it: a typo here locks every viewer out and cannot be recovered.
  const [showAnswer, setShowAnswer] = useState(false);
  const ink: Ink = { accent, text, dim, surface };
  const opt = { value, onChange, ink };

  return (
    <View style={S.wrap} accessibilityRole="radiogroup">
      <Opt {...opt} kind="none" icon="earth-outline" title="Anyone in my audience"
           sub="Normal status — opens straight away" />
      <Opt {...opt} kind="puzzle" icon="grid-outline" title="Solve a puzzle"
           sub="A fun unlock. Not private — anyone in your audience can still see it." />
      <Opt {...opt} kind="question" icon="lock-closed-outline" title="Answer a question"
           sub="Actually private. Only someone who knows the answer can open it." />

      {value.kind === 'puzzle' && (
        <View style={[S.panel, { backgroundColor: surface }]}>
          <Text style={[S.label, { color: dim }]}>Pieces</Text>
          {/* WRAPS, never scrolls. In a horizontal scroller 9x9 sat entirely
              off-screen on a 1200px device and 8x8 was clipped, so the poster
              could not see — let alone pick — the sizes they were promised.
              A hidden option is the same as a missing one. */}
          <View style={S.chips} accessibilityRole="radiogroup">
            {GRIDS.map((g) => {
              const on = value.grid === g;
              return (
                <TouchableOpacity
                  key={g}
                  onPress={() => onChange({ kind: 'puzzle', grid: g })}
                  style={[S.chip, { borderColor: on ? accent : dim, backgroundColor: on ? tint(accent, 0.13) : 'transparent' }]}
                  accessibilityRole="radio"
                  accessibilityLabel={`${g} by ${g}, ${g * g} pieces`}
                  accessibilityState={{ checked: on }}
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
            accessibilityLabel="Question"
          />
          <Text style={[S.label, { color: dim, marginTop: 12 }]}>Answer</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <TextInput
              value={value.answer}
              onChangeText={(t) => onChange({ ...value, answer: t })}
              placeholder="Only they would know this"
              placeholderTextColor={dim}
              style={[S.input, { color: text, borderColor: dim, flex: 1 }]}
              maxLength={100}
              autoCapitalize="none"
              // The answer is the key to the story: keep it out of the keyboard's
              // learned words and suggestions, and hidden unless the poster asks.
              secureTextEntry={!showAnswer}
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
              accessibilityLabel="Answer"
            />
            <TouchableOpacity
              onPress={() => setShowAnswer((v) => !v)}
              style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
              accessibilityRole="button"
              accessibilityLabel={showAnswer ? 'Hide answer' : 'Show answer'}
            >
              <Ionicons name={showAnswer ? 'eye-off-outline' : 'eye-outline'} size={20} color={dim} />
            </TouchableOpacity>
          </View>
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
            <Text style={[S.note, { color: ERROR_INK }]} accessibilityLiveRegion="polite">
              Needs at least {ANSWER_MIN_LEN} characters.
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

// Static: every colour here comes from the props (the preview is always dark),
// so the styles read nothing from the app palette.
const S = StyleSheet.create({
  wrap: { gap: 8 },
  opt: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14, borderWidth: 1.5 },
  optText: { flex: 1 },
  optTitle: { fontSize: 15, fontWeight: '600' },
  optSub: { fontSize: 12, marginTop: 2, lineHeight: 16 },
  panel: { padding: 14, borderRadius: 14, marginTop: 2 },
  label: { fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', fontWeight: '700' },
  chips: { marginTop: 10, flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, minHeight: 44, justifyContent: 'center', borderRadius: 999, borderWidth: 1.5 },
  chipText: { fontSize: 14, fontWeight: '700' },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, marginTop: 6, fontSize: 15 },
  note: { fontSize: 12, marginTop: 8, lineHeight: 17 },
});
