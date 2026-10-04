// lib/media/fileUrl.selftest.ts — run: npx tsx lib/media/fileUrl.selftest.ts
import assert from 'node:assert/strict';
import { filePathOf, sameFileUrl } from './fileUrl';

const app = 'file:///var/mobile/Containers/Data/Documents/media/My Report é.pdf';
// What WKWebView reports for that file.
const reported = 'file:///var/mobile/Containers/Data/Documents/media/My%20Report%20%C3%A9.pdf';
assert.ok(sameFileUrl(reported, app), 'space and non-ASCII match once decoded');
assert.ok(sameFileUrl('file:///a/b.pdf', 'file://' + '/a/b.pdf'));
assert.ok(sameFileUrl('file:///a/b.pdf', '/a/b.pdf'), 'bare path');
assert.ok(sameFileUrl('file:///a/b.pdf#page=2', 'file:///a/b.pdf'), 'in-document anchor is the same file');
assert.ok(!sameFileUrl('file:///a/c.pdf', 'file:///a/b.pdf'), 'another file');
assert.ok(!sameFileUrl('https://evil.example/a/b.pdf', 'file:///a/b.pdf'), 'a link out is refused');
assert.ok(!sameFileUrl('about:blank', 'file:///a/b.pdf'));
assert.equal(filePathOf('file:///a/100%.pdf'), '/a/100%.pdf', 'a malformed escape is kept raw');
console.log('fileUrl selftest: all passed');
