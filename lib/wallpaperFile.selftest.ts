// lib/wallpaperFile.selftest.ts — run: npx tsx lib/wallpaperFile.selftest.ts
import assert from 'node:assert/strict';
import { replacedWallpaperFile } from './wallpaperFile';

const DIR = 'file:///data/docs/wallpapers/';
const img = (v: string) => JSON.stringify({ type: 'image', value: v });
const old = DIR + 'c1_100.jpg';

assert.equal(replacedWallpaperFile(img(old), DIR + 'c1_200.jpg', DIR), old, 'new photo replaces old copy');
assert.equal(replacedWallpaperFile(img(old), null, DIR), old, 'reset/solid/gradient drops the copy');
assert.equal(replacedWallpaperFile(img(old), old, DIR), null, 're-saving the same file keeps it');
assert.equal(replacedWallpaperFile(null, null, DIR), null, 'nothing stored');
assert.equal(replacedWallpaperFile('__default__', null, DIR), null, 'sentinel is not JSON');
assert.equal(replacedWallpaperFile(JSON.stringify({ type: 'solid', value: '#fff' }), null, DIR), null);
assert.equal(replacedWallpaperFile(img('file:///cache/picker/x.jpg'), null, DIR), null, 'never outside our dir');
assert.equal(replacedWallpaperFile(img(DIR + '../secrets.db'), null, DIR), null, 'no traversal out of the dir');
assert.equal(replacedWallpaperFile(img(DIR), null, DIR), null, 'not the dir itself');
assert.equal(replacedWallpaperFile(img(DIR + '..'), null, DIR), null, 'not the parent dir');
assert.equal(replacedWallpaperFile(img(old), null, ''), null, 'no documents dir');
assert.equal(replacedWallpaperFile('{bad', null, DIR), null);
assert.equal(replacedWallpaperFile('null', null, DIR), null);

console.log('wallpaperFile selftest: ok');
