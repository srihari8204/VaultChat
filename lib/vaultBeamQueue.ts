// lib/vaultBeamQueue.ts — bounded queue for VaultBeam auto-downloads.
//
// Serializes auto-accepted transfers so a burst of incoming files doesn't open N
// simultaneous receives. Concurrency cap 1 (Phase A — conservative), dedupe by
// transferId, and a per-item safety timeout so a wedged runner can't block the
// queue forever (the runner has its own watchdog; this is a backstop).

type Runner = () => Promise<void>;

interface Item { id: string; run: Runner; onStateChange?: (queued: boolean) => void }

const CONCURRENCY = 1;
const ITEM_TIMEOUT_MS = 6 * 60 * 60 * 1000;  // 6h backstop (relay TTL is 24h)

const pending: Item[] = [];
const active = new Set<string>();
const known = new Set<string>();             // dedupe across queued + active

/** Enqueue an auto-download. Returns false if this transferId is already known. */
export function enqueueAutoDownload(id: string, run: Runner, onStateChange?: (queued: boolean) => void): boolean {
  if (!id || known.has(id)) return false;
  known.add(id);
  pending.push({ id, run, onStateChange });
  onStateChange?.(true);
  pump();
  return true;
}

export function isQueuedOrActive(id: string): boolean { return known.has(id); }

export function dropFromQueue(id: string): void {
  const i = pending.findIndex((x) => x.id === id);
  if (i >= 0) pending.splice(i, 1);
  known.delete(id);
  active.delete(id);
  pump();
}

function pump(): void {
  while (active.size < CONCURRENCY && pending.length > 0) {
    const item = pending.shift()!;
    active.add(item.id);
    item.onStateChange?.(false);   // leaving the queue, now running
    (async () => {
      try {
        await Promise.race([
          item.run(),
          new Promise<void>((_, rej) => setTimeout(() => rej(new Error('queue item timeout')), ITEM_TIMEOUT_MS)),
        ]);
      } catch { /* runner reports its own terminal state via the controller store */ }
      finally {
        active.delete(item.id);
        known.delete(item.id);
        pump();
      }
    })();
  }
}

export default { enqueueAutoDownload, isQueuedOrActive, dropFromQueue };
