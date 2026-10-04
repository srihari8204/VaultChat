// components/finance/ledgerDeleteHandoff.ts — the ledger detail's confirmed
// Delete, handed to the Ledger Book list in memory.
//
// It used to travel as a `deleteId` route param, which any link could set:
// vaultchat://finance/ledger?deleteId=<id> queued that ledger's delete with no
// confirmation. Only code in this app can call handOffLedgerDelete, and the
// detail screen calls it only after its own "Delete ledger?" confirmation. The
// list takes it once; a handoff the list never collects (it did not open)
// expires instead of deleting that ledger on some later visit.

const HANDOFF_TTL_MS = 15_000;

let pending: { id: string; at: number } | null = null;

export function handOffLedgerDelete(id: string, now: number = Date.now()): void {
  pending = { id, at: now };
}

/** The handed-off ledger id, once; null when there is none or it expired. */
export function takeLedgerDelete(now: number = Date.now()): string | null {
  const p = pending;
  pending = null;
  return p && now - p.at <= HANDOFF_TTL_MS ? p.id : null;
}

/** True while a handoff waits, without consuming it. */
export function hasLedgerDelete(): boolean {
  return pending !== null;
}
