// lib/games/fairness.selftest.ts — the dice, the receipts, and the rules sheet.
//
//   npx tsx lib/games/fairness.selftest.ts
//
// The seed is the load-bearing part: it is this device's half of a commit-reveal
// roll, and a seed that repeats — or is empty, or is a constant — hands the whole
// roll back to the server and silently voids the guarantee the sheet claims.
// Nothing on screen would change. That is the failure this file exists for.

import { readFileSync } from 'fs';
import { join } from 'path';
import { rollSeed, receiptFrom, pushReceipt, RECEIPT_LIMIT } from './fairness';
import { readRepo } from './boardSource.testkit';

const ROOT = join(__dirname, '..', '..');
// A board path reads the whole board: the main file and its split-out pieces.
const read = (p: string) => (/^components\/games\/[A-Z]/.test(p) ? readRepo(p) : readFileSync(join(ROOT, p), 'utf8'));
const code = (src: string) =>
  src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

let failed = 0;
function A(ok: boolean, what: string): void {
  if (ok) { console.log('  ok   ' + what); return; }
  failed++;
  console.log('  FAIL ' + what);
}

console.log('\nProvably fair dice\n');

// ── the seed ──────────────────────────────────────────────────────────
const seeds = new Set<string>();
for (let i = 0; i < 500; i++) seeds.add(rollSeed());
A(seeds.size === 500, '1. every roll gets a fresh seed — 500 rolls, 500 seeds');
A([...seeds].every(s => /^[0-9a-f]{32}$/.test(s)),
  '2. each is 128 bits of hex — a short or empty seed is a seed the server can guess');
A(!/Math\.random\(\) *\* *6|% *6/.test(code(read('lib/games/fairness.ts'))),
  '3. the client does not compute a die face — the server rolls, this only contributes');

// ── the receipt ───────────────────────────────────────────────────────
const r = receiptFrom('abc', { game: { pendingDie: 5, serverSeed: 'srv', commit: 'cmt' } });
A(r.clientSeed === 'abc' && r.value === 5 && r.serverSeed === 'srv' && r.commit === 'cmt',
  '4. a receipt records both halves and the number');

const bare = receiptFrom('abc', { game: { pendingDie: 3 } });
A(bare.serverSeed === null && bare.commit === null,
  '5. an unpublished server half reads as null — a receipt that INVENTED it would '
  + 'be worse than no receipt, because it would look like proof');
A(receiptFrom('abc', null).value === null, '5a. and a missing snapshot does not throw');
A(receiptFrom('abc', { game: { pendingDie: '6' } }).value === null,
  '5b. a wrong-typed die is not read as a number');

let list = [] as ReturnType<typeof receiptFrom>[];
for (let i = 0; i < 20; i++) list = pushReceipt(list, receiptFrom(`s${i}`, { game: { pendingDie: 1 } }, i));
A(list.length === RECEIPT_LIMIT && list[0].clientSeed === 's19',
  '6. the drawer keeps the newest few, not an unbounded log');

// ── it is wired to the board ──────────────────────────────────────────
const LUDO = code(read('components/games/Ludo.tsx'));
A(/send\(\{ t: 'roll', clientSeed: cs \}\)/.test(LUDO) && /const cs = rollSeed\(\)/.test(LUDO),
  '7. every ludo roll carries a fresh device seed');
A(/lastSeed\.current = null;/.test(LUDO),
  '7a. and a receipt is filed for OUR roll only — a seed we did not send proves '
  + 'nothing about a number we did not ask for');
A(/Are these dice fair\?/.test(LUDO), '7b. the player can actually open it');

// ── how to play ───────────────────────────────────────────────────────
const RULES = code(read('components/games/rules.tsx'));
for (const g of ['chess', 'rummy', 'ludo', 'tictactoe']) {
  A(new RegExp(`${g}: \\{`).test(RULES), `8. ${g} has rules`);
}
A(/export function useFirstTimeRules/.test(RULES),
  '8a. and they are offered once, before the first move is required');
A(/catch\(\(\) => \{ if \(alive\) setVisible\(true\); \}\)/.test(RULES),
  '8b. a failed read SHOWS them — being shown rules you know costs a tap, not '
  + 'being shown them costs the game');
for (const [name, file] of [
  ['chess', 'components/games/Chess.tsx'],
  ['rummy', 'components/games/Rummy.tsx'],
  ['ludo', 'components/games/Ludo.tsx'],
  ['tictactoe', 'components/games/TicTacToe.tsx'],
] as const) {
  A(new RegExp(`<RulesSheet game="${name}"`).test(read(file)),
    `8c. ${name} renders them from the shared sheet`);
}
A(!/function RulesSheet\(\{ visible, onClose \}/.test(code(read('components/games/Rummy.tsx'))),
  '8d. and rummy no longer keeps its own copy — rules that live beside one board '
  + 'drift from the board next door');

// ── play coins, said out loud ─────────────────────────────────────────
A(/Coins are play coins — not money/.test(read('app/games.tsx')),
  '9. the hub states it beside the balance');
A(/Stakes are in play coins/.test(read('components/games/Rummy.tsx')),
  '9a. and the table list states it beside the stakes');
for (const [what, file] of [
  ['the app', 'app/games.tsx'],
  ['rummy', 'components/games/Rummy.tsx'],
  ['ludo', 'components/games/Ludo.tsx'],
] as const) {
  A(!/(buy|purchase|top ?up|cash ?out|withdraw) coins/i.test(code(read(file))),
    `9b. ${what} offers no way to buy or cash out coins`);
}

console.log(failed === 0 ? '\nAll good.\n' : `\n${failed} FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
