// components/fileviewer/fileTypes.selftest.ts — run: npx tsx components/fileviewer/fileTypes.selftest.ts
import assert from 'node:assert/strict';
import { detectType, formatBytes, formatDuration, formatOf, resolveMime } from './fileTypes';

// The caller's mime wins over the extension.
assert.equal(detectType('scan.bin', 'application/pdf'), 'pdf');
assert.equal(detectType('x', 'image/png'), 'image');
assert.equal(detectType('report', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'office');
assert.equal(detectType('sheet', 'application/vnd.ms-excel'), 'office');
// Extension fallback, case-insensitive; tsv/conf are routed here by lib/docOpen.
assert.equal(detectType('A.DOCX'), 'office');
assert.equal(detectType('data.tsv'), 'text');
assert.equal(detectType('nginx.conf'), 'text');
assert.equal(detectType('song.flac'), 'audio');
assert.equal(detectType('clip.mkv'), 'video');
assert.equal(detectType('archive.7z'), 'unknown');
assert.equal(detectType(''), 'unknown');

// An intent with no type matches no activity: always produce one when there is an extension.
assert.equal(resolveMime('a.pdf'), 'application/pdf');
assert.equal(resolveMime('a.weird'), '*/*');
assert.equal(resolveMime(''), undefined);
assert.equal(resolveMime('a.pdf', 'text/plain'), 'text/plain');

assert.equal(formatBytes(0), '');
assert.equal(formatBytes(512), '512 B');
assert.equal(formatBytes(1536), '1.5 KB');
assert.equal(formatBytes(5 * 1048576), '5.0 MB');
assert.equal(formatDuration(0), '0:00');
assert.equal(formatDuration(65_000), '1:05');

// What a person calls the file, not the internal bucket.
assert.equal(formatOf('r.docx', 'office').label, 'Word');
assert.equal(formatOf('r.xlsx', 'office').label, 'Excel');
assert.equal(formatOf('notes.md', 'text').label, 'MD');
assert.equal(formatOf('', 'unknown').label, 'UNKNOWN');

console.log('fileTypes selftest: all passed');
