// lib/games/tableCode.selftest.ts — "Join a table by code" opens the right game.
//
//   npx tsx lib/games/tableCode.selftest.ts

import assert from 'assert';
import { parseTableCode } from './tableCode';
import { inviteText, tableLink } from './inviteLink';

// A bare code carries no game, so the hub must ask rather than guess rummy.
assert.deepStrictEqual(parseTableCode('K7P2QX'), { game: null, room: 'K7P2QX' });
assert.deepStrictEqual(parseTableCode('  ab-c_1 '), { game: null, room: 'ab-c_1' });
// Same stripping the old inline code did.
assert.deepStrictEqual(parseTableCode('K7 P2/QX'), { game: null, room: 'K7P2QX' });

// Nothing usable.
assert.strictEqual(parseTableCode(''), null);
assert.strictEqual(parseTableCode('   '), null);
assert.strictEqual(parseTableCode('/// ???'), null);

// The link an invite carries names its game.
for (const game of ['chess', 'ludo', 'rummy', 'tictactoe'] as const) {
  const link = tableLink(game, 'ROOM42')!;
  assert.deepStrictEqual(parseTableCode(link), { game, room: 'ROOM42' }, link);
  // ...and so does the whole invite line pasted from a chat.
  assert.deepStrictEqual(parseTableCode(inviteText(game, 'ROOM42')), { game, room: 'ROOM42' });
}

// Unknown game in a link: keep the room, ask for the game.
assert.deepStrictEqual(parseTableCode('vaultchat://games?game=poker&room=R1'), { game: null, room: 'R1' });
// A link whose room is not a slug is refused rather than rewritten.
assert.strictEqual(parseTableCode('vaultchat://games?game=chess&room=a%2Fb'), null);
assert.strictEqual(parseTableCode('vaultchat://games?game=chess&room=%E0%A4%A'), null);

console.log('tableCode selftest: all assertions passed');
