import { APP_EVENT_LOGICAL_MAX, type Fragment } from './codec';

interface Parts { total: number; bytes: number; received: number; expires: number; chunks: Map<number, Uint8Array> }
/** Per connection; copies only arrived bytes, never reserves a peer's claim. */
export class AppEventFragments {
  private sets = new Map<string, Parts>();
  bytes = 0;
  get size(): number { return this.sets.size; }
  get nextExpiry(): number { return Math.min(...[...this.sets.values()].map((s) => s.expires)); }
  clear(): void { this.sets.clear(); this.bytes = 0; }
  private remove(id: string): void {
    this.bytes -= this.sets.get(id)?.received ?? 0;
    this.sets.delete(id);
  }
  expire(now: number): void {
    for (const [id, set] of this.sets) if (set.expires <= now) this.remove(id);
  }
  accept(f: Fragment, now: number): Uint8Array | null {
    const id = f.fragment_id ?? '';
    const previous = this.sets.get(id);
    if (previous && previous.expires <= now) { this.remove(id); throw new Error('expired fragment'); }
    this.expire(now);
    const total = f.total ?? 0, index = f.index ?? 0;
    const declared = Number(f.total_bytes ?? '0');
    const chunk = f.chunk ?? new Uint8Array();
    const refuse = (): never => { this.remove(id); throw new Error('invalid app event fragment'); };
    if (!id || id.length > 128 || !Number.isInteger(total) || total < 1 || total > 16 ||
      !Number.isInteger(index) || index < 0 || index >= total ||
      !Number.isSafeInteger(declared) || declared < 1 || declared > APP_EVENT_LOGICAL_MAX ||
      !!f.last !== (index === total - 1) || !chunk.length || chunk.length > declared) refuse();
    let set = this.sets.get(id);
    if (set && (set.total !== total || set.bytes !== declared || set.chunks.has(index))) refuse();
    if (!set) {
      if (this.sets.size >= 8) refuse();
      set = { total, bytes: declared, received: 0, expires: now + 30000, chunks: new Map() };
      this.sets.set(id, set);
    }
    if (set.received + chunk.length > declared || this.bytes + chunk.length > APP_EVENT_LOGICAL_MAX) refuse();
    set.chunks.set(index, chunk.slice());
    set.received += chunk.length; this.bytes += chunk.length;
    if (set.chunks.size !== total) return null;
    if (set.received !== declared) refuse();
    const combined = new Uint8Array(declared);
    let offset = 0;
    for (let i = 0; i < total; i++) { const part = set.chunks.get(i)!; combined.set(part, offset); offset += part.length; }
    this.remove(id);
    return combined;
  }
}
