// lib/items/crowd.ts — the crowd-find half of the item finder, as pure rules.
//
// The space's registry (GET /chats/:id/items) lists EVERY member's tags, and
// any member may report a sighting of any of them (POST …/items/sighting is
// membership-gated, not owner-gated). The finder screen used to report only
// tags this phone had paired itself, so "any member's phone can help find
// them" was a promise nothing kept. These rules decide which tags are someone
// else's and which heard tags are due a report.
//
// Pure — no react-native imports — so the selftest runs under tsx.

/** The fields of a shared registry row these rules read. */
export interface SharedTag { bleId: string; ownerId: string }

/** Tags the space knows that belong to ANOTHER member and are not paired on
 *  this phone — the ones this phone can only help find. */
export function familyTags<T extends SharedTag>(shared: T[], pairedIds: Set<string>, me: string | null): T[] {
  return shared.filter((s) => !pairedIds.has(s.bleId) && s.ownerId !== me);
}

/** Of the tags heard right now, those not reported in the last `everyMs`. */
export function dueSightings(
  ids: string[], heard: (id: string) => boolean,
  lastReport: Map<string, number>, now: number, everyMs = 60_000,
): string[] {
  const out: string[] = [];
  for (const id of new Set(ids)) {
    if (!heard(id)) continue;
    if ((lastReport.get(id) ?? 0) > now - everyMs) continue;
    out.push(id);
  }
  return out;
}
