// lib/games/meldHint.ts — what each group LOOKS like, as a hint.
//
// ═══════════════════════════════════════════════════════════════════════
//  THIS IS ADVISORY. THE SERVER JUDGES THE DECLARATION.
// ═══════════════════════════════════════════════════════════════════════
//
// Nothing here may gate an action. It labels groups and warns before a
// declaration; it never disables Declare, never rejects a hand, and never
// decides a score. That boundary is the whole design: if this code and the
// server ever disagree, the player must still be able to do what they intended
// and the server's answer must still be the one that counts.
//
// Ported from games-web/rummy.js classifyGroup/analyzeGroups, which carries the
// same warning. Copied rather than re-derived so the hint agrees with the
// client the server was built alongside — a hint that quietly disagrees is
// worse than no hint, because it invites an 80-point misdeclare while looking
// helpful.
//
// 13-card Indian rummy: a valid hand needs every card melded, at least two
// sequences, and at least one of those PURE (no joker).

export type MeldType = 'pure' | 'impure' | 'set' | 'invalid' | 'empty';

export interface MeldVerdict {
  type: MeldType;
  /** Short badge text: "Pure Sequence", "Set", "18 pts", "2 cards". */
  label: string;
  /** Deadwood this group would cost if the hand were declared now. */
  points: number;
}

export interface HandVerdict {
  groups: MeldVerdict[];
  hasPure: boolean;
  hasTwoSeq: boolean;
  allArranged: boolean;
  /** The hint's opinion. NOT permission — the server still decides. */
  valid: boolean;
  deadwood: number;
  /** What declaring right now would score against you, capped at MAX_LOSS. */
  fullCount: number;
  /**
   * Face value of the cards sitting in groups that currently READ as melds.
   *
   * The counterpart to `deadwood`, and the reason it exists is that deadwood
   * alone only ever tells a player how badly they are doing. Points rummy
   * scores DOWN, so every number on the screen was a penalty and none of them
   * moved when a player got something right — melding three tens changed the
   * deadwood by the same amount as discarding them. This is the number that
   * goes UP as the hand comes together.
   *
   * Advisory like everything else here: it is what the badges say, not what
   * the server will rule.
   */
  melded: number;
}

export interface HintCard { id: string; suit: string; rank: string }

/**
 * The most a hand can ever score against you.
 *
 * Indian rummy caps a wrong declaration at 80 no matter what you are holding —
 * thirteen face cards would otherwise be 130. Exported because the score strip
 * needs the SAME number: it was a bare `80` here, and the strip showed the
 * uncapped deadwood beside it, so a player at 90 was told they stood to lose
 * ten points more than the game can actually take. Caught on the Honor.
 */
export const MAX_LOSS = 80;

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const rankNum = (r: string) => RANKS.indexOf(r) + 1;

/** A printed joker, or any card of the round's wild rank. */
function isJoker(c: HintCard | undefined, wildRank?: string | null): boolean {
  return !!c && (c.suit === 'JOKER' || (!!wildRank && c.rank === wildRank));
}

/** A, 10, J, Q, K are ten; jokers are free; everything else is its face value. */
function cardPoints(c: HintCard | undefined, wildRank?: string | null): number {
  if (!c || isJoker(c, wildRank)) return 0;
  const n = rankNum(c.rank);
  return n >= 10 || n === 1 ? 10 : n;
}

/** Classify one group. */
export function classifyGroup(cards: (HintCard | undefined)[], wildRank?: string | null): MeldVerdict {
  const present = cards.filter(Boolean) as HintCard[];
  if (present.length === 0) return { type: 'empty', label: '', points: 0 };

  const jokers = present.filter(c => isJoker(c, wildRank));
  const nats = present.filter(c => !isJoker(c, wildRank));
  const pts = nats.reduce((a, c) => a + cardPoints(c, wildRank), 0);

  if (present.length < 3) {
    return { type: 'invalid', label: `${present.length} card${present.length > 1 ? 's' : ''}`, points: pts };
  }

  // A run: naturals all one suit with distinct ranks, jokers filling the gaps
  // INSIDE the span. A joker on the end extends the run rather than filling a
  // hole, which is why only internal gaps are counted against them.
  const oneSuit = nats.length === 0 || nats.every(c => c.suit === nats[0].suit);
  const ranks = nats.map(c => rankNum(c.rank)).sort((a, b) => a - b);
  const distinct = ranks.every((r, i) => i === 0 || r !== ranks[i - 1]);

  if (oneSuit && distinct) {
    const span = ranks.length ? ranks[ranks.length - 1] - ranks[0] + 1 : 0;
    const internalGaps = ranks.length ? span - ranks.length : 0;
    if (internalGaps <= jokers.length && nats.length + jokers.length >= 3) {
      return jokers.length
        ? { type: 'impure', label: 'Sequence', points: 0 }
        : { type: 'pure', label: 'Pure Sequence', points: 0 };
    }
  }

  // A set: one rank, no repeated suit, three or four cards.
  const sameRank = nats.length === 0 || nats.every(c => c.rank === nats[0].rank);
  const suits = new Set<string>();
  let dupSuit = false;
  for (const c of nats) {
    if (suits.has(c.suit)) dupSuit = true;
    suits.add(c.suit);
  }
  if (sameRank && !dupSuit && present.length >= 3 && present.length <= 4) {
    return { type: 'set', label: 'Set', points: 0 };
  }

  return { type: 'invalid', label: `${pts} pts`, points: pts };
}

/** The whole hand, for the status strip and the declare warning. */
export function analyzeHand(
  groups: string[][],
  card: (id: string) => HintCard | undefined,
  wildRank?: string | null,
): HandVerdict {
  const verdicts = groups.map(g => classifyGroup(g.map(card), wildRank));
  const seqs = verdicts.filter(g => g.type === 'pure' || g.type === 'impure');
  const pure = verdicts.filter(g => g.type === 'pure');
  const total = groups.reduce((a, g) => a + g.length, 0);

  const allMelded = verdicts.every(g => g.type !== 'invalid');
  const hasPure = pure.length >= 1;
  const hasTwoSeq = seqs.length >= 2;
  const allArranged = allMelded && total >= 13;

  const deadwood = verdicts.reduce((a, g) => a + (g.type === 'invalid' ? g.points : 0), 0);
  const full = groups.reduce(
    (a, g) => a + g.reduce((b, id) => b + cardPoints(card(id), wildRank), 0),
    0,
  );
  // Face value held in groups that classify as a run or a set. A joker is worth
  // nothing (cardPoints says so), so a meld carried by jokers scores less than
  // one made of naturals — which is the truth about how much of the hand is
  // really done.
  const melded = groups.reduce((a, g, i) => {
    const t = verdicts[i].type;
    if (t !== 'pure' && t !== 'impure' && t !== 'set') return a;
    return a + g.reduce((b, id) => b + cardPoints(card(id), wildRank), 0);
  }, 0);

  return {
    groups: verdicts,
    hasPure,
    hasTwoSeq,
    allArranged,
    valid: hasPure && hasTwoSeq && allArranged,
    deadwood,
    fullCount: Math.min(MAX_LOSS, full),
    melded,
  };
}
