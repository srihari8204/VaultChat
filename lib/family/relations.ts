// lib/family/relations.ts — "Mother", "Father", "Brother" on the roster.
//
// DELIBERATELY THIN. The server owns this entirely (migration 109 +
// internal/routes/family_relations.go): it stores the labels, enforces that
// both parties are members, and returns a ready {memberId: relation} map. This
// module fetches that map and hands it to the UI. There is no client-side
// model, no merge, no cache invalidation and no rules about who may be what —
// all of that would be logic living twice.
//
// The relation is keyed by VIEWER on the server, so what comes back is "the
// labels I hold", already scoped. The app never filters.

// `api` is lazy-required inside the calls, not imported at the top, so the pure
// half (memberLabel + the presets) stays free of the react-native graph and the
// self-check runs under tsx. Same reason as lib/nav/routing.ts.
 
const apiMod = () => require('../api').api as (path: string, opts?: any) => Promise<any>;

/** memberId → relation label, exactly as the server returns it. */
export type RelationMap = Record<string, string>;

/**
 * Presets the picker offers. Purely a UI convenience — the column is free text
 * and the endpoint accepts anything up to 40 chars, because families do not fit
 * a fixed list ("Chinnanna", "Bava", "Step-mum" are all real answers). A fixed
 * enum here would be a product decision hiding in a constant.
 */
export const RELATION_PRESETS = [
  'Mother', 'Father', 'Brother', 'Sister', 'Son', 'Daughter',
  'Husband', 'Wife', 'Grandfather', 'Grandmother', 'Uncle', 'Aunt',
  'Cousin', 'Friend',
] as const;

/** Every label I hold in this space. Never throws — a failed fetch just means
 *  the roster renders names alone, which is how it looked before this existed. */
export async function getRelations(circleId: string): Promise<RelationMap> {
  try {
    const res = await apiMod()(`/chats/${encodeURIComponent(circleId)}/relations`);
    const map = res?.relations;
    return map && typeof map === 'object' ? map as RelationMap : {};
  } catch {
    return {};
  }
}

/**
 * Set or clear one member's relation. An empty string clears it — the server
 * deletes the row rather than storing a blank, so there is no second call and
 * no "" to render around.
 *
 * Returns false when the server refused, so the caller can leave the previous
 * label on screen instead of showing a change that did not persist.
 */
export async function setRelation(circleId: string, memberId: string, relation: string): Promise<boolean> {
  try {
    await apiMod()(`/chats/${encodeURIComponent(circleId)}/relations/${encodeURIComponent(memberId)}`, {
      method: 'PUT',
      json: { relation },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * How a member's row reads. The relation LEADS when it exists, because that is
 * the thing being asked for — "Mother" identifies a person on a family map far
 * faster than a display name does, and the name stays for disambiguation when
 * two people share a relation ("Brother · Arun", "Brother · Ravi").
 *
 * Pure, so the formatting rule is testable without a server.
 */
export function memberLabel(name: string, relation?: string | null): string {
  const rel = (relation ?? '').trim();
  if (!rel) return name;
  if (!name.trim()) return rel;
  // A label identical to the name would render as "Mother · Mother".
  if (rel.toLowerCase() === name.trim().toLowerCase()) return rel;
  return `${rel} · ${name}`;
}

// ── self-check: `npx tsx lib/family/relations.ts` ──────────────────────────
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('relations: ' + m); };

  A(memberLabel('Arun Prakash', 'Mother') === 'Mother · Arun Prakash', 'relation must lead');
  A(memberLabel('Arun Prakash') === 'Arun Prakash', 'no relation renders the name alone');
  A(memberLabel('Arun Prakash', '  ') === 'Arun Prakash', 'whitespace is not a relation');
  A(memberLabel('Arun Prakash', null) === 'Arun Prakash', 'null is not a relation');
  A(memberLabel('', 'Mother') === 'Mother', 'a missing name falls back to the relation');
  A(memberLabel('Mother', 'mother') === 'mother', 'must not render "mother · Mother"');
  // Two siblings stay distinguishable — the reason the name is kept at all.
  A(memberLabel('Arun', 'Brother') !== memberLabel('Ravi', 'Brother'), 'same relation must stay distinguishable');
  A(RELATION_PRESETS.length > 0 && RELATION_PRESETS.includes('Mother'), 'presets must include the obvious ones');

  console.log('family/relations self-check: OK');
}

export default {};
