// lib/games/handGroups.ts — how a rummy player arranges their hand.
//
// Grouping is COSMETIC. The server judges a declaration; these groups only say
// how the player laid the cards out, and the games server persists them per
// seat (`arrange`) so a reconnect restores the arrangement rather than dumping
// thirteen loose cards back on someone mid-hand.
//
// The whole problem here is reconciliation. The hand is authoritative and
// changes under the arrangement constantly — a draw adds a card, a discard
// removes one, and a fresh deal replaces all thirteen. The arrangement has to
// survive all three without ever inventing, duplicating or losing a card,
// because a group holding a card the player no longer owns produces a
// declaration the server rejects for reasons the player cannot see.

/** A group is a list of card ids. The last group is the ungrouped remainder. */
export type Groups = string[][];

/**
 * Fold the authoritative hand into the existing arrangement.
 *
 * - ids no longer in the hand are dropped (discarded, or a new deal)
 * - ids in the hand that no group holds are appended to the LAST group, which
 *   is the loose pile a freshly drawn card belongs in
 * - empty groups are removed, except the loose pile, which always exists so
 *   there is somewhere for the next draw to land
 *
 * Deliberately total: any hand and any prior arrangement produce a valid
 * arrangement containing exactly the hand, once each.
 */
export function reconcile(groups: Groups, hand: string[]): Groups {
  const own = new Set(hand);
  const seen = new Set<string>();

  const kept: Groups = groups
    .map(g => g.filter(id => {
      if (!own.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    }))
    .filter((g, i, arr) => g.length > 0 || i === arr.length - 1);

  if (kept.length === 0) kept.push([]);

  const fresh = hand.filter(id => !seen.has(id));
  kept[kept.length - 1] = [...kept[kept.length - 1], ...fresh];
  return kept;
}

/**
 * Pull `picked` out of wherever they are and into a new group of their own.
 *
 * The loose pile is kept last so a later draw still has a home, which is why
 * the new group is spliced in BEFORE it rather than appended.
 */
export function groupUp(groups: Groups, picked: string[]): Groups {
  const take = new Set(picked);
  if (take.size === 0) return groups;

  const rest = groups.map(g => g.filter(id => !take.has(id)));
  // Preserve the order the player sees rather than the order they tapped.
  const ordered = groups.flat().filter(id => take.has(id));

  const loose = rest.pop() ?? [];
  return [...rest.filter(g => g.length > 0), ordered, loose];
}

/** Dissolve every group holding one of `picked`, returning those cards loose. */
export function ungroup(groups: Groups, picked: string[]): Groups {
  const take = new Set(picked);
  if (take.size === 0) return groups;

  const freed: string[] = [];
  const kept: Groups = [];
  groups.forEach((g, i) => {
    const isLoose = i === groups.length - 1;
    if (!isLoose && g.some(id => take.has(id))) freed.push(...g);
    else kept.push(g);
  });

  if (kept.length === 0) kept.push([]);
  kept[kept.length - 1] = [...kept[kept.length - 1], ...freed];
  return kept;
}

const SUIT_ORDER: Record<string, number> = { S: 0, H: 1, C: 2, D: 3, JOKER: 4 };
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

/**
 * Sort the loose pile by suit then rank.
 *
 * Only the loose pile: re-sorting the player's own groups would undo the
 * arrangement they are in the middle of building, which is the one thing this
 * screen exists to preserve. This is presentation — it never decides what a
 * valid meld is.
 */
export function sortLoose(groups: Groups, card: (id: string) => { suit: string; rank: string } | undefined): Groups {
  if (groups.length === 0) return groups;
  const out = groups.slice();
  const loose = out[out.length - 1].slice();
  loose.sort((a, b) => {
    const ca = card(a), cb = card(b);
    if (!ca || !cb) return 0;
    const s = (SUIT_ORDER[ca.suit] ?? 9) - (SUIT_ORDER[cb.suit] ?? 9);
    return s !== 0 ? s : RANKS.indexOf(ca.rank) - RANKS.indexOf(cb.rank);
  });
  out[out.length - 1] = loose;
  return out;
}

/** True when the two arrangements are the same, so `arrange` is not resent. */
export function sameGroups(a: Groups, b: Groups): boolean {
  if (a.length !== b.length) return false;
  return a.every((g, i) => g.length === b[i].length && g.every((id, j) => id === b[i][j]));
}

/**
 * Move one card into a specific group — the drop half of drag-and-drop.
 *
 * `target` is an index into the CURRENT groups array. Out-of-range drops land
 * in the loose pile rather than being refused: a finger released between two
 * rows should put the card somewhere sensible, not silently do nothing and
 * leave the player wondering whether the gesture registered.
 *
 * Removing the card first, then inserting, is what makes a move within the same
 * group behave — otherwise the index shifts under the insert.
 */
export function moveCard(groups: Groups, cardId: string, target: number): Groups {
  if (!groups.some(g => g.includes(cardId))) return groups;

  const without = groups.map(g => g.filter(id => id !== cardId));
  const idx = target >= 0 && target < without.length ? target : without.length - 1;
  const out = without.map((g, i) => (i === idx ? [...g, cardId] : g));

  // Empty groups are dropped, but the loose pile always survives so the next
  // draw and the next drop both have somewhere to land.
  const kept = out.filter((g, i, arr) => g.length > 0 || i === arr.length - 1);
  return kept.length ? kept : [[]];
}
