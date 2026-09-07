// components/games/rules.tsx — how each of the four games plays.
//
// Every reference client has this and ours had it for rummy only, in the middle
// of Rummy.tsx. A player who does not know the rules of a table they have just
// been invited to has one option without it: play badly and find out.
//
// The text says what the SERVER does, because that is the part players get
// wrong about these boards — the table shuffles, times, and judges, and the
// screen only shows what it decided. Every sheet ends on that.
//
// One place, four texts: rules that live next to a board drift from the board
// next door, and a rule this app states must be the rule the table plays.

import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Sheet } from './feedback';
import { Btn, useType } from './ui';
import { C, S } from '../../lib/games/theme';
import type { GameKind } from '../../lib/gamesSocket';

type Section = { head: string; lines: string[] };

const RULES: Record<GameKind, { title: string; sections: Section[] }> = {
  rummy: {
    title: 'Points rummy, 13 cards',
    sections: [
      { head: 'The turn', lines: [
        'Two decks and jokers. Each turn you take one card — from the closed deck or the open pile — and throw one away.',
      ] },
      { head: 'A winning hand', lines: [
        'All thirteen cards melded into sequences and sets, with at least two sequences, and at least one of those PURE — a run in one suit with no joker in it.',
        'Sequence: three or more cards in a row, one suit. Set: three or four of the same rank, no suit twice.',
      ] },
      { head: 'Jokers', lines: [
        'The printed jokers and every card of the round’s wild rank stand in for any card. A meld using one is impure, and cannot be your pure sequence.',
      ] },
      { head: 'Scoring', lines: [
        'The winner scores 0. Everyone else counts their unmelded cards: face cards and aces are 10, the rest are face value, jokers are free. Capped at 80.',
        'Declare without a pure sequence and the whole hand counts against you.',
        'Drop before your first turn and you lose 20. Drop later and you lose 40 — still cheaper than carrying a hand that cannot make two sequences.',
      ] },
      { head: 'The table decides', lines: [
        'The server shuffles, deals, times every turn and judges every declaration. The ✓ and ✗ badges on your groups are only a hint — they never gate an action, and if they ever disagree with the table, the table is right.',
      ] },
    ],
  },
  chess: {
    title: 'Chess, refereed by the table',
    sections: [
      { head: 'Playing', lines: [
        'Tap a piece to see where it can go, then tap a square. Only legal moves are offered — the table sends the complete list every time it is your turn, so anything you can tap is a move you are allowed to make.',
        'A pawn reaching the far rank asks you which piece it becomes.',
      ] },
      { head: 'The clock', lines: [
        'Each side has its own clock and it runs only on that side’s turn. Run out and the game ends there.',
      ] },
      { head: 'Ending it', lines: [
        'Checkmate, stalemate, a clock, or an agreed draw — you can offer one, and it takes effect only if your opponent accepts.',
      ] },
      { head: 'The table decides', lines: [
        'Legality, check, checkmate and the result are all the server’s. This screen never works out a move for itself, which is why the two of you always see the same board.',
      ] },
    ],
  },
  ludo: {
    title: 'Ludo, two to four players',
    sections: [
      { head: 'Playing', lines: [
        'Roll, then tap a token the roll allows. Only the tokens that can legally move are lit; the rest cannot be tapped.',
        'A six brings a token out of the yard. Land on an opponent and they go home; a token on a star square is safe.',
      ] },
      { head: 'Winning', lines: [
        'Get all four tokens home. The exact count matters at the end — an overshoot does not move.',
      ] },
      { head: 'The dice', lines: [
        'Your phone sends a random seed with every roll and the table combines it with its own, so neither side alone decides the number. Tap “Are these dice fair?” at the table to see your seed and what the table published for each of your rolls — this server does not publish its own half, so the receipt shows what it gave and what it withheld.',
      ] },
      { head: 'The table decides', lines: [
        'The server rolls, settles every capture and calls the winner. Nothing on this phone decides a number.',
      ] },
    ],
  },
  tictactoe: {
    title: 'Tic-tac-toe',
    sections: [
      { head: 'Playing', lines: [
        'Take turns marking a square. Three in a row — across, down or diagonally — wins. Fill the grid with no line and it is a draw.',
      ] },
      { head: 'The table decides', lines: [
        'The server holds the grid, calls the turn and calls the winner. If a tap is not yours to make, the square will not take it.',
      ] },
    ],
  },
};

export function RulesSheet({
  game, visible, onClose,
}: { game: GameKind; visible: boolean; onClose: () => void }) {
  const t = useType();
  const r = RULES[game];
  return (
    <Sheet visible={visible} title="How this game plays" onClose={onClose}>
      <ScrollView style={{ maxHeight: 380 }} contentContainerStyle={{ gap: S[2] }}>
        <Text numberOfLines={1} style={{ color: C.text, fontSize: t.md, fontWeight: '800' }}>{r.title}</Text>
        {r.sections.map(sec => (
          <React.Fragment key={sec.head}>
            <Text style={{ color: C.text, fontSize: t.md, fontWeight: '800' }}>{sec.head}</Text>
            {sec.lines.map(line => (
              <Text key={line} style={{ color: C.muted, fontSize: t.sm, lineHeight: 20 }}>{line}</Text>
            ))}
          </React.Fragment>
        ))}
      </ScrollView>
      <Btn label="Got it" kind="gold" onPress={onClose} />
    </Sheet>
  );
}

/**
 * Offer the rules the first time someone opens a game, and never again.
 *
 * Read before the first move is required, which on these boards means the
 * lobby. A failed read shows the sheet rather than hiding it: being shown rules
 * you already know costs a tap, and not being shown them costs the game.
 */
export function useFirstTimeRules(game: GameKind): { visible: boolean; open: () => void; close: () => void } {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(`games.rulesSeen.${game}`)
      .then(v => { if (alive && !v) setVisible(true); })
      .catch(() => { if (alive) setVisible(true); });
    return () => { alive = false; };
  }, [game]);

  const close = useCallback(() => {
    setVisible(false);
    AsyncStorage.setItem(`games.rulesSeen.${game}`, '1').catch(() => {});
  }, [game]);

  return { visible, open: () => setVisible(true), close };
}
