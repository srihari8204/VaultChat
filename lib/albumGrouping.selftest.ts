// lib/albumGrouping.selftest.ts — run: npx tsx lib/albumGrouping.selftest.ts
//
// Album grouping is timeline layout only, so the thing that matters most is
// what it must NEVER do: lose a message, reorder the conversation, or merge
// two different albums. A grouping bug looks exactly like data loss on screen.

import { groupAlbums, type AlbumRow } from './albumGrouping';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

const m = (id: number, albumId?: string, albumIndex?: number): AlbumRow =>
  ({ id, meta: albumId ? { albumId, albumIndex } : null });

/** Every id the timeline would actually show, groups expanded. */
const shown = (rows: AlbumRow[]): number[] =>
  rows.flatMap(r => (r._album ? r._album.map(x => x.id) : [r.id]));

console.log('nothing may be lost');
const mixed = [m(9), m(8, 'a', 2), m(7, 'a', 1), m(6, 'a', 0), m(5), m(4)];
const g = groupAlbums(mixed);
check('every message still reaches the screen',
  shown(g).sort((x, y) => x - y).join() === [4, 5, 6, 7, 8, 9].join(),
  shown(g).join());
check('the album became one row', g.length === 4, `${g.length} rows`);
check('non-album rows are untouched', !g[0]._album && !g[2]._album);

console.log('order');
const album = g.find(r => r._album)!._album!;
check('members are in pick order, not inverted-list order',
  album.map(x => x.id).join() === [6, 7, 8].join(), album.map(x => x.id).join());
check('the standing row is the first picked', g[1].id === 6, String(g[1].id));

console.log('grouping must not over-reach');
// Two albums back to back must not merge.
const two = groupAlbums([m(4, 'b', 0), m(3, 'b', 1), m(2, 'c', 0), m(1, 'c', 1)]);
check('two adjacent albums stay separate', two.length === 2, `${two.length}`);
check('and keep their own members',
  two[0]._album?.length === 2 && two[1]._album?.length === 2);

// An album interrupted by another message renders as two groups rather than
// pulling the interloper out of sequence.
const split = groupAlbums([m(5, 'd', 0), m(4, 'd', 1), m(3), m(2, 'd', 2), m(1, 'd', 3)]);
check('an interrupted album does not swallow the message between',
  split.length === 3, `${split.length} rows`);
check('and the timeline order is preserved',
  shown(split).join() === [5, 4, 3, 2, 1].join(), shown(split).join());

console.log('degenerate cases');
check('a lone album member is left as an ordinary row',
  !groupAlbums([m(1, 'e', 0)])[0]._album);
check('an empty list is fine', groupAlbums([]).length === 0);
check('rows with no meta are fine', groupAlbums([m(1), m(2)]).length === 2);
check('a null meta does not throw',
  groupAlbums([{ id: 1, meta: null }] as AlbumRow[]).length === 1);

console.log('purity');
const input = [m(2, 'f', 1), m(1, 'f', 0)];
const snapshot = JSON.stringify(input);
groupAlbums(input);
check('the caller’s array is not mutated', JSON.stringify(input) === snapshot);

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
