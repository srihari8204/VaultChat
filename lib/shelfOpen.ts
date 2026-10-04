// lib/shelfOpen.ts — which shelf rows may be listed, and the /media-viewer
// params a row opens with.
//
// PURE (no react-native import) so it is Node-tested (shelfOpen.selftest.ts).
//
// The shelf used to open every file as plain, own-nothing media: no
// `encrypted`, so media-viewer could not tell "plaintext" from "E2EE but no
// key" and could write ciphertext into a .pdf (mediaStore.MediaKeyMissingError);
// no `isMine`, so the sender's own copy was downloaded back; and view-once media
// was listed and opened with no protection at all.

export interface ShelfOpenRow {
  attachmentId: string;
  chatId: string;
  senderId: string | null;
  filename: string;
  mime: string | null;
  kind: string;
  encrypted?: boolean;
  viewOnce?: boolean;
}

/** View-once media never belongs in a library view: it is promised to be seen
 *  once, in the protected viewer, from the chat bubble only. */
export function shelfListable(row: { viewOnce?: boolean }): boolean {
  return !row.viewOnce;
}

/** Route params for /media-viewer. `myId` is the signed-in user's id (or null
 *  when unknown — then nothing is claimed as mine). */
export function shelfOpenParams(row: ShelfOpenRow, myId: string | null): Record<string, string> {
  return {
    attachmentId: row.attachmentId,
    filename: row.filename,
    mime: row.mime ?? '',
    msgType: row.kind === 'image' ? 'image' : row.kind === 'video' ? 'video' : row.kind === 'audio' ? 'audio' : 'file',
    chatId: row.chatId,
    encrypted: row.encrypted ? '1' : '',
    isMine: myId && row.senderId && String(row.senderId) === String(myId) ? '1' : '',
  };
}

export default {};
