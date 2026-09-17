// lib/backupSecrets.selftest.ts — run: npx tsx lib/backupSecrets.selftest.ts
//
// KEY MATERIAL MUST NOT RIDE IN A BACKUP BUNDLE.
//
// lib/cloudBackup.ts documents this threat itself and excluded the `e2eeKeys`
// FIELD because of it. That exclusion held — the long-term identity lives in
// SecureStore, which the bundle never touches. What it missed is that the
// bundle also copies the WHOLE of AsyncStorage, and two kinds of key material
// live there:
//
//   vc_mk_*       per-file media keys. lib/mediaKeyStore.ts's own header says
//                 "The key never leaves the device"; the sweep sent them to a
//                 server that, in the DEFAULT account-managed mode, also holds
//                 the bundle key AND the attachment ciphertext.
//   vc_peer_ik_*  pinned peer identity keys behind the "safety number changed"
//                 warning. Exported they leak the contact graph; imported they
//                 let a bundle pre-acknowledge a key change and silence the
//                 MITM warning for a chosen peer.
//
// Both directions are checked: applyEncryptedBackup does a blanket multiSet, so
// filtering only the export would still let an old bundle write them back.
//
// 2026-09-17, second pass. Two assertions here constrained nothing:
//
//   • BACKUP_SECRET_PREFIXES.length === 2 compared a literal to itself. It
//     could only ever fail by someone adding a CORRECT third prefix, which is
//     the one change it should have welcomed.
//   • "the media-key promise is still true" read mediaKeyStore.ts for the
//     PHRASE "never leaves the device". A sentence in a header comment is not a
//     promise a program keeps. Renaming the actual prefix from vc_mk_ to
//     anything else silently un-covered every media key and left the phrase,
//     and the assertion, exactly where they were.
//
// What replaces them is the cross-file link that was never checked: the key
// names the WRITERS build are extracted from their own source and run through
// isSecretBackupKey. That is the real contract — the filter is a list of string
// prefixes, and nothing but this stops it drifting away from the code that
// produces them.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isSecretBackupKey, BACKUP_SECRET_PREFIXES } from './backupSecretKeys';

let n = 0;
const ok = (label: string, cond: boolean) => { assert.ok(cond, label); n++; console.log('  ok  ' + label); };
const code = (p: string) =>
  fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

ok('a media key is recognised as secret', isSecretBackupKey('vc_mk_abc123'));
ok('a peer identity pin is recognised as secret', isSecretBackupKey('vc_peer_ik_u42'));
ok('a peer key-change ack is recognised too', isSecretBackupKey('vc_peer_ik_ack_u42'));

// The bundle exists to restore readable history, so ordinary keys must survive.
ok('the story feed cache still travels', !isSecretBackupKey('vc_stories_feed'));
ok('drafts still travel', !isSecretBackupKey('vc_draft_index'));
ok('the call log still travels', !isSecretBackupKey('vc_call_log_v1'));
ok('a chat lock table still travels', !isSecretBackupKey('vc_locked_chats'));
ok('an empty key is not treated as secret', !isSecretBackupKey(''));
ok('a lookalike that is not the prefix is not excluded', !isSecretBackupKey('vc_mkt_banner'));

// ── The writers and the filter must still be talking about the same keys ──
// Every template-literal AsyncStorage key built in these files, pulled out of
// their source and run through the real function. The literals above only say
// what this test remembers; this says what the app actually writes.
const keyTemplates = (p: string) =>
  [...code(p).matchAll(/`(vc_[A-Za-z0-9_]*)\$\{/g)].map((m) => m[1]);

const MEDIA = keyTemplates('lib/mediaKeyStore.ts');
ok('mediaKeyStore.ts still builds its keys from a template', MEDIA.length > 0);
ok('every key mediaKeyStore.ts writes is excluded from a bundle',
   MEDIA.every((pre) => isSecretBackupKey(pre + 'attachment-1')));

const PEER = keyTemplates('lib/keyChange.ts');
ok('keyChange.ts still builds its keys from a template', PEER.length >= 2);
ok('every key keyChange.ts writes is excluded from a bundle',
   PEER.every((pre) => isSecretBackupKey(pre + 'peer-1')));

// The other direction: a prefix nothing produces is a rule that protects
// nothing, and hides the fact that the key it meant to catch got renamed.
const WRITERS = [...MEDIA, ...PEER];
ok('every declared prefix matches a key some writer actually builds',
   BACKUP_SECRET_PREFIXES.every((pre) => WRITERS.some((w) => w.startsWith(pre))));

// ── Wiring: one rule, applied on export AND on restore ────────────────
// Scoped to the statement that does the work, rather than matched as one byte
// sequence, so re-ordering the two conditions is not a failure and deleting
// either of them is.
const backup = code('lib/cloudBackup.ts');
const sweep = backup.split('\n').find((l) => /asyncStorage\[k\]\s*=\s*v/.test(l)) ?? '';
ok('the export sweep filters key material', /isSecret(?:BackupKey)?\(\s*k\s*\)/.test(sweep));
ok('...and still drops this install\'s own device-local flags', /DEVICE_LOCAL_KEYS/.test(sweep));

const entriesAt = backup.indexOf('const entries');
const multiSetAt = backup.indexOf('multiSet', entriesAt);
ok('the restore builds its multiSet entries in one place',
   entriesAt !== -1 && multiSetAt !== -1 && multiSetAt > entriesAt);
ok('the restore filters key material as well',
   /!isSecretBackupKey\(\s*k\s*\)/.test(backup.slice(entriesAt, multiSetAt)));

console.log(`\nbackupSecrets.selftest: ${n} assertions passed`);
