// lib/camera/cameraMode.selftest.ts — run: npx tsx lib/camera/cameraMode.selftest.ts
//
// Two things here are worth pinning down, because both fail SILENTLY on a
// device and look like something else:
//
//   1. The microphone. Merging photo/video/scan into one screen merges three
//      permission flows. If the screen asks for the mic on open, every user who
//      only ever takes a photo gets a mic prompt they never earned — and it
//      reads as spyware, not as a bug.
//   2. The return path. The camera must address the chat by ID. Popping the
//      stack works right up until the chat was opened from a notification deep
//      link, where there is nothing underneath — and then ✕ lands the user on
//      the chats list instead of the conversation they were in.

import {
  captureModes, fileUri, needsMic, nextFlash, previewMode, returnParams,
} from './cameraMode';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

console.log('\nCamera mode self-test\n');

// ── the privacy-relevant one ───────────────────────────────────────────
console.log('Only VIDEO may ask for the microphone:');
check('PHOTO never asks', !needsMic('PHOTO'));
check('SCAN never asks', !needsMic('SCAN'));
check('VIDEO asks', needsMic('VIDEO'));
check('exactly one mode of three asks',
  captureModes.filter(needsMic).length === 1);

// ── the return path ────────────────────────────────────────────────────
console.log('\nDismiss returns to the chat by id, and stages nothing:');
const target = { chatId: 'c-42', peerUid: 'u-7', peerName: 'Asha' };
eq('✕ carries the chat id back',
  returnParams(target), { chatId: 'c-42', id: 'c-42', peerUid: 'u-7', peerName: 'Asha' });
check('both keys chat.tsx reads are set, so a param REPLACE cannot lose the chat',
  returnParams(target).id === returnParams(target).chatId);
check('✕ stages no attachment',
  Object.keys(returnParams(target)).every(k => !k.startsWith('captured')));
check('a chat opened with no peer still carries its id',
  returnParams({ chatId: 'c-42' }).chatId === 'c-42');

console.log('\nA capture returns to the SAME chat, with the asset:');
const shot = returnParams(target, { uri: 'file:///a.jpg', type: 'image', viewOnce: true });
eq('chat id survives the capture', shot.chatId, 'c-42');
eq('uri travels', shot.capturedUri, 'file:///a.jpg');
eq('view-once travels as 1', shot.capturedViewOnce, '1');
eq('view-once off travels as 0',
  returnParams(target, { uri: 'file:///a.jpg', type: 'image' }).capturedViewOnce, '0');

console.log('\nA scanned PDF is a file, and view-once cannot apply to it:');
const pdf = returnParams(target, { uri: 'file:///d.pdf', type: 'file', viewOnce: true, filename: 'Scan.pdf' });
eq('type is file', pdf.capturedType, 'file');
eq('filename travels', pdf.capturedName, 'Scan.pdf');
eq('view-once is refused on a file — there are no image bytes to mark',
  pdf.capturedViewOnce, '0');

// ── flash + preview ────────────────────────────────────────────────────
console.log('\nFlash cycles off → auto → on → off:');
eq('off → auto', nextFlash('off'), 'auto');
eq('auto → on', nextFlash('auto'), 'on');
eq('on → off', nextFlash('on'), 'off');
check('three taps return to where it started',
  nextFlash(nextFlash(nextFlash('off'))) === 'off');

console.log('\nThe preview stays a picture preview unless we are recording:');
eq('SCAN previews as picture', previewMode('SCAN'), 'picture');
eq('PHOTO previews as picture', previewMode('PHOTO'), 'picture');
eq('VIDEO previews as video', previewMode('VIDEO'), 'video');

console.log('\nML Kit paths get a scheme before anything tries to read them:');
eq('a bare path is prefixed', fileUri('/data/x.jpg'), 'file:///data/x.jpg');
eq('an existing scheme is left alone', fileUri('file:///data/x.jpg'), 'file:///data/x.jpg');
eq('an http url is left alone', fileUri('https://a/b.jpg'), 'https://a/b.jpg');

console.log(failures === 0 ? '\nAll camera mode checks passed.\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
