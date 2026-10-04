// lib/vaultcheck/checkError.selftest.ts — run: npx tsx lib/vaultcheck/checkError.selftest.ts
//
// rerate7/J regression 1: every VaultCheck failure had collapsed to the
// generic line, losing the timeout's "still running — Try again keeps waiting"
// guidance. The screen's own copy passes through; anything else is fixed text.

import assert from 'node:assert/strict';
import { CHECK_FAILED_TEXT, VaultCheckMessage, vaultCheckErrorText } from './checkError';

const timeout = 'The check is taking too long. It is still running on this device — Try again to keep waiting for it, or try a shorter clip.';
assert.equal(vaultCheckErrorText(new VaultCheckMessage(timeout)), timeout, 'the timeout guidance is shown');
assert.equal(vaultCheckErrorText(new VaultCheckMessage('Could not locate the media on this device.')), 'Could not locate the media on this device.');
assert.equal(vaultCheckErrorText(new Error('java.lang.IllegalStateException: MediaMetadataRetriever')), CHECK_FAILED_TEXT, 'native text is not shown');
assert.equal(vaultCheckErrorText(new Error('Network request failed')), 'Check your connection and try again.');
assert.equal(vaultCheckErrorText(undefined), CHECK_FAILED_TEXT);
assert.ok(new VaultCheckMessage('x') instanceof Error);

console.log('checkError.selftest: all checks passed');
