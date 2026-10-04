// lib/statusAudienceBase.ts — who the Status privacy picker can list.
//
// The server's "My contacts" for status is everyone the author shares an
// active chat with, groups included, minus blocks (vaultchat-backend-go
// stories.go audienceBaseIDs). The picker used to list only direct-chat peers,
// so people met only in a group could not be excluded or picked.
// `GET /stories/audience?base=1` answers `{ people: [{ id, name, photoURL }] }`
// for that set. It is written but NOT deployed: today's server ignores `base`
// and answers `{ viewerIds }`. So a reply without a `people` array means "not
// supported", and the picker keeps today's direct-chat list and its note.
// Pure, so lib/statusAudienceBase.selftest.ts runs it.

export type AudiencePerson = { id: string; name: string; photoURL: string | null };

const FALLBACK_NAME = 'crazzychat user';

/** The people in a `?base=1` reply, or null when the server did not send that list. */
export function parseAudienceBase(r: unknown): AudiencePerson[] | null {
  const people = (r as { people?: unknown } | null)?.people;
  if (!Array.isArray(people)) return null;
  const out: AudiencePerson[] = [];
  const seen = new Set<string>();
  for (const p of people) {
    const x = p as { id?: unknown; name?: unknown; photoURL?: unknown } | null;
    if (typeof x?.id !== 'string' || !x.id || seen.has(x.id)) continue;
    seen.add(x.id);
    out.push({
      id: x.id,
      name: typeof x.name === 'string' && x.name.trim() ? x.name : FALLBACK_NAME,
      photoURL: typeof x.photoURL === 'string' && x.photoURL ? x.photoURL : null,
    });
  }
  return out;
}

/**
 * The picker's list: the server's set when it sent one, plus any direct-chat
 * peer it did not name (nobody who was pickable before disappears), each
 * person once. Without the server's set it is the direct-chat peers alone.
 */
export function pickerPeople(base: AudiencePerson[] | null, direct: AudiencePerson[]): AudiencePerson[] {
  const out: AudiencePerson[] = [];
  const seen = new Set<string>();
  for (const p of [...(base ?? []), ...direct]) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}
