// components/notes/noteOrphans.ts — which stored note attachments nothing
// references any more, so app/encrypted-notes.tsx can delete them when the
// notes open. They come from a draft that was replaced while it was kept (a
// newer draft overwrote it before it could be opened), a draft the app was
// killed with, or a draft that can never open. Pure (Node-tested in
// noteOrphans.selftest.ts).

/** Ids in `stored` that no saved note (trash included) lists and that are not
 *  in `keep` (the draft being restored, or the one open in the editor). */
export function orphanAttachmentIds(
  stored: readonly string[],
  notes: readonly { attachments?: readonly { id: string }[] }[],
  keep: readonly string[] = [],
): string[] {
  const used = new Set<string>(keep);
  for (const n of notes) for (const a of n.attachments ?? []) used.add(a.id);
  return stored.filter((id) => !used.has(id));
}
