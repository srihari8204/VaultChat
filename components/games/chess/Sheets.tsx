// components/games/chess/Sheets.tsx — the players sheet, the board swatches and
// the promotion picker. Split out of components/games/Chess.tsx; behaviour unchanged.

import React from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { Btn, PlayerRow, useType } from '../ui';
import { Sheet } from '../feedback';
import type { GameState } from '../../../lib/games/useGameSocket';
import { C, S, R, white } from '../../../lib/games/theme';
import { CR, CR_LIT } from '../../../lib/games/chessRoom';
import { PIECE_NAME } from '../../../lib/games/pieceNames';
import { openInvite } from '../../../lib/games/invite';
import { OutlinedGlyph } from './Square';
import { THEMES, PIECE_STROKE, type ThemeName, type Ink, type Move } from './style';

/**
 * Who is at this table.
 *
 * The seat cards above the board say who is playing and whose move it is; this
 * says what they have won, which side each is on, and how to get another person
 * here. It reads the SAME lobby roster the lobby screen renders — there is no
 * second player list to fall out of step with it.
 */
export function PlayersSheet({
  visible, onClose, state, myColor, roomId,
}: {
  visible: boolean; onClose: () => void; state: GameState;
  myColor: 'w' | 'b' | null; roomId: string;
}) {
  const t = useType();
  const members = state.lobby?.members ?? [];

  // A SIDE IS ONLY CLAIMED WHEN IT IS ACTUALLY DERIVABLE. The frame carries
  // `color` for THIS client and nobody else, so the other seat's colour is an
  // inference that holds for exactly two seated players and breaks the moment
  // there are three. A roster that guesses is worse than one that says nothing.
  const canSay = members.length === 2 && myColor != null;
  const sideOf = (id: string): string | null => {
    if (!canSay) return null;
    const mineSide = myColor === 'w' ? 'White' : 'Black';
    const theirs = myColor === 'w' ? 'Black' : 'White';
    return id === state.you ? mineSide : theirs;
  };

  return (
    <Sheet visible={visible} title="At this table" onClose={onClose}>
      {members.length === 0 ? (
        <Text style={{ color: CR.muted, fontSize: t.sm, lineHeight: 19 }}>
          The table has not sent its seats yet.
        </Text>
      ) : members.map(m => (
        <PlayerRow
          key={m.vaultId}
          name={m.name}
          tag={m.vaultId === state.you ? 'you' : m.isBot ? 'bot' : undefined}
          subtitle={
            [sideOf(m.vaultId), typeof m.wins === 'number' ? `${m.wins} wins` : null]
              .filter(Boolean).join('  ·  ') || undefined
          }
        />
      ))}

      {state.spectator ? (
        <Text style={{ color: CR.muted, fontSize: t.sm, lineHeight: 19 }}>
          You are watching this game, not playing it.
        </Text>
      ) : null}

      {!!roomId && (
        <Text style={{ color: CR.muted, fontSize: t.sm }} selectable>
          Room code: <Text style={{ color: CR.gold2, fontWeight: '800' }}>{roomId}</Text>
        </Text>
      )}

      <Btn
        label="Invite a friend"
        icon="link"
        onPress={() => { void openInvite('chess', roomId); }}
        disabled={!roomId}
      />
    </Sheet>
  );
}

export function Swatches({ value, onChange }: { value: ThemeName; onChange: (n: ThemeName) => void }) {
  return (
    <View style={{ flexDirection: 'row', gap: S[2], justifyContent: 'center', paddingVertical: S[2] }}>
      {(Object.keys(THEMES) as ThemeName[]).map(n => (
        <Pressable
          key={n}
          onPress={() => onChange(n)}
          accessibilityRole="button"
          accessibilityLabel={`${n} board`}
          accessibilityState={{ selected: value === n }}
          // 34dp is 10dp short of the 44dp floor this file uses elsewhere
          // (Ludo.tsx's tokens). The row's own gap is 8dp, so a symmetric
          // hitSlop of 5 would overlap the neighbour by 2dp either side —
          // asymmetric instead: 5 top/bottom reaches 44 vertically, 4
          // left/right reaches 42 horizontally with the gap untouched.
          hitSlop={{ top: 5, bottom: 5, left: 4, right: 4 }}
          style={{
            width: 34, height: 34, borderRadius: R[1], overflow: 'hidden', flexDirection: 'row',
            borderWidth: 2, borderColor: value === n ? CR.line : white(0.16),
            // Every board theme is opaque now, so this backdrop is covered in
            // all seven cases — it is kept because a translucent theme added
            // later would otherwise preview against nothing. CR_LIT is the room
            // as it actually composites, not CR.bg, which is the ground before
            // the ambient wash and a colour no real pixel is.
            backgroundColor: CR_LIT,
          }}
        >
          <View style={{ flex: 1, backgroundColor: THEMES[n].light }} />
          <View style={{ flex: 1, backgroundColor: THEMES[n].dark }} />
        </Pressable>
      ))}
    </View>
  );
}

export function PromoPicker({
  opts, color, onPick, onCancel, ink,
}: {
  opts: Move[]; color: 'w' | 'b'; onPick: (m: Move) => void; onCancel: () => void;
  /** The board's ink. Without it the picker offers a BLACK queen while every
   *  piece on the glass board behind it is ice — the exact mismatch
   *  OutlinedGlyph's own comment warns is most obvious here. */
  ink?: Ink;
}) {
  const seen = new Set<string>();
  const choices = opts.filter(o => o.promo && !seen.has(o.promo) && seen.add(o.promo));
  return (
    // `accessible={false}`: the default would make this backdrop swallow its
    // whole subtree into one unlabelled node, same defect as Sheet — the four
    // "Promote to Q/R/B/N" buttons below would announce as nothing. Tapping
    // the backdrop to cancel is a sighted-only convenience either way, so an
    // explicit Cancel button carries that action for accessibility instead.
    // In a Modal so hardware back cancels the promotion (onRequestClose) rather
    // than reaching the hub's "Leave this table?" handler.
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={onCancel}>
    <Pressable
      onPress={onCancel}
      accessible={false}
      accessibilityRole="none"
      style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(3,12,9,.76)', alignItems: 'center', justifyContent: 'center' }}
    >
      <View style={{
        flexDirection: 'row', alignItems: 'center', gap: S[3], padding: S[4], borderRadius: R[3],
        backgroundColor: white(0.10), borderWidth: 1, borderColor: CR.lineSoft,
        boxShadow: `0 20px 50px rgba(0,0,0,0.5), inset 0 1px 0 ${white(0.18)}`,
      }}>
        {choices.map(m => (
          <Pressable key={m.promo} onPress={() => onPick(m)} accessibilityRole="button" accessibilityLabel={`Promote to ${PIECE_NAME[String(m.promo).toLowerCase()] ?? m.promo}`}>
            <OutlinedGlyph t={m.promo as string} c={color} size={46} stroke={PIECE_STROKE} ink={ink} />
          </Pressable>
        ))}
        {/* A bare Text in a Pressable is a ~16dp-tall target, and it is the only
            AT-reachable way out of this picker — the backdrop tap is
            sighted-only by design (see the comment above). */}
        <Pressable
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          style={{ minHeight: 44, minWidth: 44, paddingHorizontal: S[2], alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={{ color: C.muted, fontSize: 13, fontWeight: '700' }}>Cancel</Text>
        </Pressable>
      </View>
    </Pressable>
    </Modal>
  );
}
