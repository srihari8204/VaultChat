// lib/mediaToolsFixesZR.selftest.ts — run: npx tsx lib/mediaToolsFixesZR.selftest.ts
//
// Source-level guards for the round-3 fixes in screens that have no pure seam
// of their own (React Native screens cannot be imported under Node), plus the
// one piece of math the image editor's capture crop reuses.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { containFrame, toImageCrop } from './imageEditMath';

const read = (f: string) => readFileSync(f, 'utf8');

// image-editor: cropping the screen-sized capture to the photo's frame reuses
// toImageCrop with the canvas as the "frame". A 400×300 canvas holding a 4:3
// landscape → no bands; a portrait photo → only the centre column is kept.
{
  const canvas = { x: 0, y: 0, w: 400, h: 300 };
  const f1 = containFrame(400, 300, 4000, 3000);
  assert.deepEqual(toImageCrop(f1, canvas, 1200, 900), { originX: 0, originY: 0, width: 1200, height: 900 });
  const f2 = containFrame(400, 300, 1000, 2000);          // 150×300 at x=125
  assert.deepEqual(toImageCrop(f2, canvas, 1200, 900), { originX: 375, originY: 0, width: 450, height: 900 });
}

// delete-account: the MPIN is checked client-side before the delete, and is
// still sent in the delete body.
{
  const src = read('app/delete-account.tsx');
  const pre = src.indexOf('await verifyMpinRemote(userId, mpin)');
  const del = src.indexOf('await deleteAccount(mpin, reason');
  assert.ok(pre > 0 && del > pre, 'verifyMpinRemote runs before deleteAccount(mpin, …)');
  assert.ok(/ponytail:[^]*extra[\s/]*attempt/.test(src), 'the pre-check is documented as a ponytail shortcut');
  for (const code of ['invalid_mpin', 'locked', 'mpin_required']) assert.ok(src.includes(`'${code}'`), `maps ${code}`);
}

// docscanner: plaintext is deleted only after the sealed list is saved, and a
// failed list save fails the scan.
{
  const src = read('app/docscanner.tsx');
  const seal = src.indexOf('await AsyncStorage.setItem(RECENT_KEY, await sealJson(docs));\n      } catch');
  const del = src.indexOf('if (m.plain) await FileSystem.deleteAsync(m.plain');
  assert.ok(seal > 0 && del > seal, 'migration deletes plaintext after the sealed save');
  assert.ok(!/migrateDoc[^]*?deleteAsync\(doc\.pdfUri[^]*?function DocScannerContent/.test(src), 'migrateDoc no longer deletes plaintext');
  assert.ok(!/sealJson\(docs\.slice\(0, 20\)\)\); \} catch \{\}/.test(src), 'persistRecent does not swallow a failed save');
  const persist = src.indexOf('await changeRecent(stored => [doc, ...stored.filter(d => d.id !== doc.id)]);');
  const ready = src.indexOf("setStep('preview');");
  assert.ok(persist > 0 && ready > persist, '"PDF ready" only after the list is saved');
  assert.ok(!src.includes('can never lose a scan'));
}

// in-chat search: both query paths skip view-once / Invisible Ink rows.
{
  const src = read('lib/localDb.ts');
  const fn = src.slice(src.indexOf('export async function searchCachedMessagesInChat'), src.indexOf('export async function pruneMessageCache'));
  assert.equal((fn.match(/searchHidden\(r\.meta\)/g) || []).length, 2, 'FTS and fallback scans both filter protected rows');
  assert.equal((fn.match(/\bmeta FROM messages|m\.meta\b/g) || []).length, 2, 'both queries select meta');
}

// scheduled: locked chats are masked, failing closed.
{
  const src = read('app/scheduled.tsx');
  assert.ok(src.includes("isChatLocked(id).catch(() => true)"), 'scheduled fails closed on a lock read error');
  assert.ok(src.includes("'🔒 Locked chat'"));
}

// chat-wallpaper: a per-chat screen can follow all chats (removes its key).
{
  const src = read('app/chat-wallpaper.tsx');
  assert.ok(src.includes('Same as all chats'), 'offers "Same as all chats"');
  assert.ok(/if \(chatId && inherit\) await AsyncStorage\.removeItem\(storageKey\)/.test(src), 'inherit removes the per-chat key');
}

// backup-e2ee: turning off goes through the transactional switch (keeps the secret on failure).
{
  const src = read('lib/cloudBackup.ts');
  const fn = src.slice(src.indexOf('export function disableE2EEBackup'), src.indexOf('export function isSecretRequired'));
  assert.ok(/backupLock\(\(\) => switchBackupSecret\(e2eeSlot, pendingMarker, null,/.test(fn), 'disable uses the transactional switch');
  assert.ok(read('app/backup-e2ee.tsx').includes('await getBackupMode().catch(() => null)'), 'screen re-reads the true mode');
}

// media-viewer: the tap wrapper does not swallow the video controls.
{
  const src = read('app/media-viewer.tsx');
  assert.ok(/onPress=\{\(\) => setCtrl\(!ctrl\)\} accessible=\{false\} accessibilityRole="none"/.test(src), 'controls wrapper is not accessible');
  assert.ok(src.includes('setAuthFailed(true)'), 'a missing token ends in an error, not a spinner');
}

// image-editor: hardware back / swipe asks before dropping edits.
assert.ok(/addListener\('beforeRemove'/.test(read('app/image-editor.tsx')), 'image-editor guards beforeRemove');

// story-viewer: a reachable pause; resume continues the bar.
{
  const src = read('app/story-viewer.tsx');
  assert.ok(src.includes("'Pause story'") && src.includes("'Resume story'"));
  assert.ok(/duration: Math\.max\(0, total \* \(1 - progressFrac\.current\)\)/.test(src), 'resume uses the remaining time');
}

// video-player: no unguarded control awaits.
{
  const src = read('app/video-player.tsx');
  assert.ok(src.includes('setPositionAsync(newPos).catch('));
  for (const call of ['setRateAsync', 'setIsMutedAsync']) {
    const at = src.indexOf(call);
    assert.ok(src.lastIndexOf('try {', at) > src.lastIndexOf('useCallback', at), `${call} is inside try`);
  }
}

console.log('mediaToolsFixesZR selftest: ok');
