// lib/call/mediaKey.selftest.ts — run: npx tsx lib/call/mediaKey.selftest.ts
//
// Who mints the call's shared media key, and when it must change.
//
// Two properties, both security-relevant:
//
//   CONVERGENCE  every participant must end up on the SAME key. If two mint at
//                once the room splits and nobody can decode anybody — a total
//                media failure that looks like "the call broke".
//
//   FORWARD SECRECY  a participant who leaves must stop being able to read the
//                stream. On a mesh that is automatic: their connection is gone.
//                Through an SFU it is NOT — the server keeps forwarding
//                ciphertext and has no idea who holds a key. Only a re-key
//                actually removes them.
//
// Mirrors establishMediaKey / rotateMediaKeyAfterLeave. Pure, runs in Node.

/** Mirrors the deterministic minter rule: lowest uid of everyone present. */
const minterOf = (me: string, others: string[]): string => [me, ...others].sort()[0];
const iMint = (me: string, others: string[]): boolean => minterOf(me, others) === me;

/** Mirrors rotateMediaKeyAfterLeave's guards. */
function shouldRotate(opts: { onSfu: boolean; me: string; others: string[]; disposed?: boolean }): boolean {
  if (!opts.onSfu || opts.disposed) return false;   // mesh re-keys by dropping the link
  if (opts.others.length === 0) return false;       // nobody left to protect from
  return iMint(opts.me, opts.others);
}

let failures = 0;
const check = (name: string, ok: boolean) => { if (!ok) failures++; console.log(`  ${ok ? '✓' : '✗'} ${name}`); };

console.log('\nCall media key: minting and rotation\n');

// ── convergence ───────────────────────────────────────────────────────
const room = ['alice', 'bob', 'carol', 'dave'];
const minters = room.map(me => minterOf(me, room.filter(u => u !== me)));
check('every participant computes the SAME minter', new Set(minters).size === 1);
check('exactly one participant mints',
  room.filter(me => iMint(me, room.filter(u => u !== me))).length === 1);

// Order of the roster must not matter — rosters arrive in arbitrary order.
check('roster order does not change the minter',
  minterOf('dave', ['carol', 'alice', 'bob']) === minterOf('dave', ['bob', 'alice', 'carol']));

// ── forward secrecy on leave ──────────────────────────────────────────
check('a departure on the SFU triggers a re-key',
  shouldRotate({ onSfu: true, me: 'alice', others: ['bob', 'carol'] }));
check('...only from the minter, so two people do not re-key at once',
  !shouldRotate({ onSfu: true, me: 'carol', others: ['alice', 'bob'] }));

// ── cases that must NOT re-key ────────────────────────────────────────
check('mesh calls do not re-key (the link itself is gone)',
  !shouldRotate({ onSfu: false, me: 'alice', others: ['bob'] }));
check('the last person alone does not re-key',
  !shouldRotate({ onSfu: true, me: 'alice', others: [] }));
check('a disposed call does not re-key',
  !shouldRotate({ onSfu: true, me: 'alice', others: ['bob'], disposed: true }));

// ── the minter leaving must not deadlock the room ─────────────────────
// alice mints; alice leaves; bob is now lowest and takes over.
const after = ['bob', 'carol', 'dave'];
check('when the minter leaves, the next-lowest takes over',
  iMint('bob', after.filter(u => u !== 'bob')));
check('...and only that one does',
  after.filter(me => iMint(me, after.filter(u => u !== me))).length === 1);

// ── two leaving at once still converges on one minter ─────────────────
const two = ['carol', 'dave'];
check('after two departures exactly one minter remains',
  two.filter(me => iMint(me, two.filter(u => u !== me))).length === 1);

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all media-key checks passed\n');
process.exit(failures ? 1 : 0);
