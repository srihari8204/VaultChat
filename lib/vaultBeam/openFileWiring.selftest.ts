// openFileWiring.selftest.ts — the open path must reference, never copy.
//
// These are SOURCE assertions, and they live here rather than inside
// openFile.ts for a reason that cost a release build:
//
//   openFile.ts is imported by the app. Metro bundles a module whole — it does
//   not tree-shake `if (require.main === module)` — so a `require('fs')` in
//   that block ships to the APK and the release build dies with
//   "Unable to resolve module fs". A *.selftest.ts is imported by nothing, so
//   Metro never sees it and `fs` is free.
//
// The rule this file encodes: any check that has to READ SOURCE belongs in a
// selftest file, never in a module the app imports.
//
//   npx tsx lib/vaultBeam/openFileWiring.selftest.ts

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
/** Production half only, comments removed — prose about the OLD bug is not the bug. */
const prod = (s: string) =>
  s.split('// ── self-check')[0]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

const OPEN = prod(read('lib', 'vaultBeam', 'openFile.ts'));
const CTRL = prod(read('lib', 'vaultBeamController.ts'));
const BUBBLE = prod(read('components', 'VaultBeamBubble.tsx'));

let failures = 0;
const A = (ok: boolean, what: string): void => {
  if (!ok) { failures++; console.error('  FAIL', what); } else console.log('  ok  ', what);
};

console.log('\nVaultBeam open-file wiring\n');

// ── 1. A 780 MB FILE IS REFERENCED, NOT COPIED ─────────────────────
for (const f of ['readAsStringAsync', 'base64', 'copyAsync', 'moveAsync', 'readFile', 'Buffer.from']) {
  A(!OPEN.includes(f), `1. openFile never calls ${f} — the file is referenced in place`);
}

// ── 2. THE MECHANISM ───────────────────────────────────────────────
A(OPEN.includes('getContentUriAsync'),
  '2. uses the FileProvider that already ships (expo-file-system)');
A(OPEN.includes("'android.intent.action.VIEW'"),
  '3. ACTION_VIEW — "open", not a share sheet');
A(!OPEN.includes('shareAsync') && !OPEN.includes('Uri.fromFile'),
  '4. never shareAsync as "open", and never a file:// handed to another app');
A(/flags: 1,/.test(OPEN),
  '5. FLAG_GRANT_READ_URI_PERMISSION only — read, never write');
A(!/flags:\s*(?!1,)\d/.test(OPEN), '6. and no other intent flags are smuggled in');

// ── 3. NO SOURCE-READING IN APP-IMPORTED MODULES ───────────────────
// The rule that broke the build. Every module the app imports must be free of
// fs, or Metro fails to resolve it.
for (const f of ['openFile.ts', 'transferMetrics.ts', 'transportEpoch.ts',
                 'completionForensics.ts', 'blockSize.ts', 'senderWorkList.ts',
                 'reportReceived.ts', 'transportLabel.ts', 'fileDigest.ts']) {
  // Comments stripped (Metro parses the AST, so `require('fs')` in prose is
  // inert) but the self-check block KEPT — that half is bundled too, and it is
  // exactly where the offending require lived.
  const whole = read('lib', 'vaultBeam', f)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  A(!/require\(['"]fs['"]\)|from ['"]fs['"]/.test(whole),
    `7. ${f} never touches fs — it is bundled into the APK`);
}

// ── 4. BOTH ROLES CAN OPEN ─────────────────────────────────────────
A(/savedPath: opts\.srcPath/.test(CTRL),
  '8. the SENDER keeps a handle on the file it sent');
A(/openSaved\(st\.savedPath, st\.name\)/.test(BUBBLE),
  '9. the bubble passes the filename, so MIME comes from the real extension');
A((BUBBLE.match(/label="Open"/g) ?? []).length >= 3,
  '10. Open is offered on sender sent/delivered AND receiver saved');

// ── 4b. VIDEO PLAYS IN-APP, UNDER FLAG_SECURE ──────────────────────
A(/isVideo\(st\.name \|\| st\.savedPath\)/.test(BUBBLE),
  '10b. the bubble routes video to the in-app player');
A(/pathname: '\/video-player'/.test(BUBBLE),
  '10c. reusing the existing player screen, not a new one');
A(BUBBLE.indexOf('isVideo(') < BUBBLE.indexOf('openSaved(st.savedPath'),
  '10d. the in-app branch is taken BEFORE the external handoff');
// The root layout no longer calls expo-screen-capture directly — every caller
// goes through screenGuard.setSecure, which is where the "never in a dev build"
// rule lives. Assert the wiring, not the old call site.
A(/setSecure\(true\)/.test(read('app', '_layout.tsx')),
  '10e. the root layout holds FLAG_SECURE, which is what makes in-app safer');

// ── 4c. A PICKED content:// URI IS USED DIRECTLY ───────────────────
// DocumentPicker now runs with copyToCacheDirectory:false so a 12 GB pick is
// streamed in place. That makes the sender's savedPath a content:// URI, which
// must never be wrapped as file://content://... nor re-minted by the provider.
A(/path\.startsWith\('content:\/\/'\)/.test(OPEN),
  '10f. openFile detects an already-content URI');
A(/contentUri = path;/.test(OPEN),
  '10g. and uses it directly, without the FileProvider');
{
  const chat = readFileSync(join(ROOT, 'app', 'chat.tsx'), 'utf8');
  A(/copyToCacheDirectory: false/.test(chat),
    '10h. the picker no longer duplicates the file before transferring');
}

// ── 5. ONLY A FINISHED TRANSFER ────────────────────────────────────
A(/status === 'complete' \|\| status === 'sent'/.test(OPEN),
  '11. canOpen admits only finished transfers — a partial file is sparse');

// ── 6. NO NATIVE EXCEPTION TEXT REACHES THE USER ───────────────────
A(/messageFor\(r\.failure \?\? 'UNKNOWN_ERROR'\)/.test(BUBBLE),
  '12. the alert renders a mapped message, never e.message');
A(!/Alert\.alert\('Cannot open', e\?\.message/.test(BUBBLE),
  '13. and the old raw-exception alert is gone');

// ── 7. THE TRANSFER PATH IS UNTOUCHED ──────────────────────────────
for (const f of ['relayComplete', 'clearRecvBitmap', 'recvMask', 'uploadedMask', 'ChunkBitmap']) {
  A(!OPEN.includes(f), `14. opening a file never touches ${f} — it mutates no transfer state`);
}

console.log(failures === 0
  ? '\nALL OPEN-FILE WIRING CHECKS PASSED ✓  (device open still required)\n'
  : `\n${failures} FAILED ✗\n`);
process.exit(failures === 0 ? 0 : 1);
