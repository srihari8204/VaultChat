// lib/notesAttachments.selftest.ts — run: npx tsx lib/notesAttachments.selftest.ts
//
// A note attachment is stored sealed; opening one decrypts a temp copy for the
// viewer or the share sheet. That copy used to be written to the cache root
// and never deleted, so every attachment ever opened stayed on disk in the
// clear. Now every copy goes into one folder, and closeOpenedAttachments
// removes it (the screen calls it on close, after a share, on lock and on open).
// expo-file-system and the notes key are stubbed in memory.

import assert from 'node:assert/strict';

const files = new Map<string, string>();
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request: string, ...rest: unknown[]) {
  if (request === 'expo-file-system/legacy') {
    return {
      documentDirectory: 'file:///doc/', cacheDirectory: 'file:///cache/',
      EncodingType: { UTF8: 'utf8', Base64: 'base64' },
      getInfoAsync: async (p: string) => ({ exists: [...files.keys()].some((k) => k.startsWith(p)) }),
      makeDirectoryAsync: async () => {},
      readAsStringAsync: async (p: string) => { const v = files.get(p); if (v == null) throw new Error('ENOENT'); return v; },
      writeAsStringAsync: async (p: string, v: string) => { files.set(p, v); },
      deleteAsync: async (p: string) => { for (const k of [...files.keys()]) if (k === p || k.startsWith(p)) files.delete(k); },
      readDirectoryAsync: async (p: string) => [...files.keys()].filter((k) => k.startsWith(p)).map((k) => k.slice(p.length)),
    };
  }
  if (request === './notesCrypto') {
    // "Sealing" is base64 here; the real cipher is tested in notesCrypto.selftest.
    return {
      encryptBytesToString: async (b: Uint8Array) => 'sealed:' + Buffer.from(b).toString('base64'),
      decryptStringToBytes: async (s: string) => (s.startsWith('sealed:') ? new Uint8Array(Buffer.from(s.slice(7), 'base64')) : null),
    };
  }
  return origLoad.call(this, request, ...rest);
};
const na = require('./notesAttachments') as typeof import('./notesAttachments');

(async () => {
  files.set('file:///cache/pick.jpg', Buffer.from('JPEGDATA').toString('base64'));
  const att = await na.addAttachment('file:///cache/pick.jpg', 'beach.jpg', 'image/jpeg');
  files.delete('file:///cache/pick.jpg');
  assert.ok(files.get(`file:///doc/note_attachments/${att.id}.enc`)?.startsWith('sealed:'), 'stored sealed');

  const uri = await na.openAttachment(att);
  assert.equal(uri, `file:///cache/notes_open/${att.id}.jpg`, 'the copy goes into the one open folder');
  assert.equal(Buffer.from(files.get(uri!)!, 'base64').toString(), 'JPEGDATA');
  assert.deepEqual([...files.keys()].filter((k) => k.startsWith('file:///cache/') && !k.startsWith('file:///cache/notes_open/')), [],
    'nothing decrypted at the cache root');

  await na.closeOpenedAttachments();
  assert.deepEqual([...files.keys()].filter((k) => k.startsWith('file:///cache/')), [], 'closing deletes every decrypted copy');
  assert.ok(files.has(`file:///doc/note_attachments/${att.id}.enc`), 'the sealed attachment stays');
  await na.closeOpenedAttachments();   // nothing open: still fine

  assert.equal(await na.openAttachment({ ...att, id: 'missing' }), null, 'a missing attachment opens as null');
  console.log('notesAttachments.selftest: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
