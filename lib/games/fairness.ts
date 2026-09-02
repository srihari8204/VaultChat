// lib/games/fairness.ts — the dice, and how a player can check them.
//
// Ludo's roll has always been commit-reveal: the device sends its own seed, the
// server combines it with a secret it has already committed to, and neither
// side alone decides the number. That is a real guarantee and it was completely
// invisible — which is worth nothing, because a player who suspects the dice
// has no way to look. Ludo King and RummyCircle both advertise provable
// fairness for exactly this reason: everyone assumes dice are rigged.
//
// So this keeps the last few rolls: what THIS device contributed, what the
// server published, and what came out. It proves nothing on its own — the check
// is that the same numbers are there to compare — and it is deliberately a
// record, not a re-derivation: recomputing the die here would be this client
// deciding a roll it does not referee.

/**
 * This player's half of the roll.
 *
 * Sending a constant would hand the whole roll to the server and quietly void
 * the commitment, so this is 128 bits of fresh randomness per roll.
 */
export function rollSeed(): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return s;
}

export interface RollReceipt {
  /** What this device sent. */
  clientSeed: string;
  /** What the server published for the roll, when it publishes one. */
  serverSeed: string | null;
  /** The commitment the server made before it knew our seed. */
  commit: string | null;
  /** The number that came out. */
  value: number | null;
  at: number;
}

/** Keep the recent ones only — this is a receipt drawer, not an audit log. */
export const RECEIPT_LIMIT = 8;

/**
 * Read whatever the server published about the roll.
 *
 * The protocol is reverse-engineered, so every field here is optional and
 * several spellings are accepted: a missing one shows as "not published",
 * never as a fabricated value. A receipt that invented the server's half would
 * be worse than no receipt at all.
 */
export function receiptFrom(clientSeed: string, raw: any, at = Date.now()): RollReceipt {
  const g = raw?.game ?? raw ?? {};
  const str = (...vs: unknown[]) => {
    for (const v of vs) if (typeof v === 'string' && v) return v;
    return null;
  };
  const num = (...vs: unknown[]) => {
    for (const v of vs) if (typeof v === 'number' && Number.isFinite(v)) return v;
    return null;
  };
  return {
    clientSeed,
    serverSeed: str(g.serverSeed, g.server_seed, raw?.serverSeed, g.reveal),
    commit: str(g.commit, g.serverCommit, raw?.commit, g.commitHash),
    value: num(g.pendingDie, g.die, raw?.die),
    at,
  };
}

/** Newest first, capped. */
export function pushReceipt(list: RollReceipt[], r: RollReceipt): RollReceipt[] {
  return [r, ...list].slice(0, RECEIPT_LIMIT);
}
