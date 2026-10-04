// components/finance/chittiNumber.ts — the ticket number for a new chitti member.
//
// `members.length + 1` collided once a member was removed: delete #2 of
// three and the next member was a second #3. One past the highest number in
// use can never collide; gaps left by removals are simply not reused.
export function nextMemberNumber(members: readonly { number: number }[]): number {
  let max = 0;
  for (const m of members) if (Number.isFinite(m.number) && m.number > max) max = m.number;
  return Math.floor(max) + 1;
}
