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

/**
 * How many groups a rummy hand is laid out in.
 *
 * From games-web/rummy.js: four by default, five at most. Native rummy apps all
 * do this — a dealt hand arrives already sorted into candidate melds rather
 * than as thirteen loose cards, because arranging from scratch every deal is
 * the tedious part of the game, not the interesting one.
 */
export const DEFAULT_GROUPS = 4;
export const MAX_GROUPS = 5;

export interface SortCard { id: string; suit: string; rank: string }

/**
 * Greedy meld finder — runs of 3+ per suit first, then sets of 3-4.
 *
 * DISPLAY ONLY. It suggests a starting arrangement; the server still judges the
 * declaration. Greedy rather than optimal on purpose: it matches the reference
 * client's output, and a player who disagrees just drags a card.
 *
 * Jokers are deliberately left out of the melds and fall through to the
 * leftovers, so the player decides where to spend them — a joker auto-placed
 * into a run the player did not want is worse than one left loose.
 */
export function findMelds(
  hand: SortCard[],
  isJoker: (c: SortCard) => boolean,
): { melds: string[][]; leftover: string[] } {
  const nats = hand.filter(c => !isJoker(c));
  const used = new Set<string>();
  const melds: string[][] = [];

  for (const suit of ['S', 'H', 'C', 'D']) {
    const sc = nats
      .filter(c => c.suit === suit && !used.has(c.id))
      .sort((a, b) => rankIndex(a.rank) - rankIndex(b.rank));

    let run: SortCard[] = [];
    const flush = () => {
      if (run.length >= 3) {
        melds.push(run.map(c => c.id));
        run.forEach(c => used.add(c.id));
      }
    };
    for (const c of sc) {
      if (run.length === 0) { run = [c]; continue; }
      const d = rankIndex(c.rank) - rankIndex(run[run.length - 1].rank);
      if (d === 1) run.push(c);
      else if (d === 0) { /* duplicate rank — leave it for a set */ }
      else { flush(); run = [c]; }
    }
    flush();
  }

  const byRank = new Map<string, SortCard[]>();
  for (const c of nats) {
    if (used.has(c.id)) continue;
    const list = byRank.get(c.rank) ?? [];
    list.push(c);
    byRank.set(c.rank, list);
  }
  for (const list of byRank.values()) {
    const suits = new Set<string>();
    const grp: SortCard[] = [];
    for (const c of list) if (!suits.has(c.suit)) { suits.add(c.suit); grp.push(c); }
    if (grp.length >= 3) {
      melds.push(grp.map(c => c.id));
      grp.forEach(c => used.add(c.id));
    }
  }

  return { melds, leftover: hand.filter(c => !used.has(c.id)).map(c => c.id) };
}

const RANK_ORDER = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const rankIndex = (r: string) => RANK_ORDER.indexOf(r);

/**
 * Fold a list of groups to at most MAX_GROUPS, padding out to DEFAULT_GROUPS.
 *
 * Overflow is merged into the LAST real group rather than dropped — losing a
 * card here would take it out of the player's hand on screen while the server
 * still has it.
 */
export function capAndPad(groups: Groups): Groups {
  const out = groups.map(g => g.slice());
  while (out.length > MAX_GROUPS) {
    const extra = out.pop() as string[];
    out[out.length - 1] = [...out[out.length - 1], ...extra];
  }
  while (out.length < DEFAULT_GROUPS) out.push([]);
  return out;
}

/**
 * The arrangement a freshly dealt hand starts in: melds first, then the rest
 * ORDERED, then jokers on their own, padded to four.
 *
 * THE LEFTOVER USED TO COME BACK IN DEAL ORDER, which is why Sort looked
 * broken. findMelds returns `hand.filter(...)`, so anything it could not meld
 * kept the order the server dealt it — and in a typical hand that is most of
 * the thirteen cards. The player tapped Sort, two or three cards jumped into a
 * meld at the front, and the remaining eight stayed shuffled. Every reference
 * client (RummyCircle, Ace2Three) leaves the ungrouped cards suit-wise and
 * ascending, because the point of sorting is to SEE the runs you are one card
 * away from — which is exactly what deal order hides.
 *
 * Jokers move to their own trailing group for the same reason the `suit` and
 * `rank` modes already do it: they are the cards you are deciding what to do
 * with, and burying them mid-suit hides them.
 */
export function autoArrange(hand: SortCard[], isJoker: (c: SortCard) => boolean): Groups {
  const { melds, leftover } = findMelds(hand, isJoker);
  const arr: Groups = melds.map(m => m.slice());

  const byId = new Map(hand.map(c => [c.id, c]));
  const rest = leftover.map(id => byId.get(id)).filter((c): c is SortCard => !!c);
  const loose = rest.filter(c => !isJoker(c)).sort(
    (a, b) => (SUIT_ORDER[a.suit] ?? 9) - (SUIT_ORDER[b.suit] ?? 9)
           || rankIndex(a.rank) - rankIndex(b.rank),
  );
  const jokers = rest.filter(isJoker);

  if (loose.length) arr.push(loose.map(c => c.id));
  if (jokers.length) arr.push(jokers.map(c => c.id));
  return capAndPad(arr.length ? arr : [[]]);
}

/* ── how the player likes their hand sorted ─────────────────────────── */

/**
 * The four ways to lay out thirteen cards.
 *
 * - `smart`  — melds first, leftovers after. What a rummy player actually wants
 *              and the default, because arranging from scratch every deal is the
 *              tedious part of the game rather than the interesting one.
 * - `suit`   — a group per suit, ascending. The habit players bring from
 *              card games that are not rummy.
 * - `rank`   — one run of thirteen ordered by rank, for spotting sets.
 * - `manual` — leave it alone. Some players arrange as they draw and an
 *              auto-sort that undoes that mid-hand is actively hostile.
 */
export type SortMode = 'smart' | 'suit' | 'rank' | 'manual';

export const SORT_MODES: SortMode[] = ['smart', 'suit', 'rank', 'manual'];

export const SORT_LABEL: Record<SortMode, string> = {
  smart: 'Smart',
  suit: 'By suit',
  rank: 'By rank',
  manual: 'Manual',
};

/** True for a value that came back from storage as a sort mode. */
export function isSortMode(v: unknown): v is SortMode {
  return typeof v === 'string' && (SORT_MODES as string[]).includes(v);
}

/**
 * Lay the whole hand out in the requested order.
 *
 * `manual` returns the arrangement untouched — it is the one mode that must not
 * move a card, because the player is mid-way through an arrangement of their
 * own and this is the function the Sort button calls.
 *
 * Display only. Nothing here decides what a valid meld is; the server judges the
 * declaration and lib/games/meldHint.ts only advises.
 */
export function sortHand(
  mode: SortMode,
  hand: SortCard[],
  isJoker: (c: SortCard) => boolean,
  current: Groups,
): Groups {
  if (mode === 'manual' || hand.length === 0) return current;
  if (mode === 'smart') return autoArrange(hand, isJoker);

  const byRank = (a: SortCard, b: SortCard) =>
    rankIndex(a.rank) - rankIndex(b.rank) || (SUIT_ORDER[a.suit] ?? 9) - (SUIT_ORDER[b.suit] ?? 9);

  // Jokers go last in their own group either way: they are the cards the player
  // is deciding what to do with, and burying them inside a suit hides them.
  const jokers = hand.filter(isJoker).map(c => c.id);
  const nats = hand.filter(c => !isJoker(c));

  if (mode === 'rank') {
    const all = nats.slice().sort(byRank).map(c => c.id);
    return capAndPad(jokers.length ? [all, jokers] : [all]);
  }

  const suits: Groups = [];
  for (const suit of ['S', 'H', 'C', 'D']) {
    const g = nats.filter(c => c.suit === suit).sort(byRank).map(c => c.id);
    if (g.length) suits.push(g);
  }
  if (jokers.length) suits.push(jokers);
  return capAndPad(suits.length ? suits : [[]]);
}
