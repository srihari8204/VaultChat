// lib/vaultBeam/backgroundService.ts — keep transfers alive off-screen.
//
// # THE DEFECT
//
// The transfer engine is JS in the RN runtime, which Android suspends once the
// app leaves the foreground. Measured in production: a 2.24 GB send moved from
// 160 to 224 blocks in EIGHT HOURS — it stopped when the app was backgrounded
// and only advanced when someone reopened it. Nothing was corrupted (the bitmap
// and persisted send resume correctly), but a transfer that only runs while you
// watch it is not a transfer.
//
// A foreground service of type dataSync is the sanctioned fix. This module is
// the JS half: it decides WHEN the service should exist and WHAT it should say.
//
// # THE RULE THAT KEEPS THIS HONEST
//
// The service is a lifetime holder, nothing more. It owns no transfer state.
// Everything below is derived from the transfer store, which stays the single
// source of truth — so if the service is killed, restarted, or never starts at
// all, the transfer's own state is unaffected.
//
// # WHAT IT MUST NEVER CLAIM
//
// The notification text is built from the SAME transport label the bubble uses,
// never re-derived. "Delivered" is not said for bytes merely staged to R2, and
// completion is not announced before the whole-file digest has passed — those
// are the transfer's words, and this only repeats them.
//
// PURE enough to self-check: the native module is required lazily, so the
// decision logic runs under `npx tsx`.

export interface ActiveTransfer {
  transferId: string;
  role: 'sender' | 'recipient';
  status: string;
  done: number;
  total: number;
  bytes: number;
  totalBytes: number;
  transport?: string;
  rateBps?: number;
}

/**
 * Statuses that genuinely need the process kept alive.
 *
 * `sent` is deliberately absent: the sender has finished staging to R2 and the
 * peer pulls on its own schedule — holding a wake lock for that would burn
 * battery for work nobody is doing. `incoming` is absent for the same reason:
 * nothing is running until the user accepts.
 */
const ACTIVE = new Set(['uploading', 'receiving', 'queued']);

export function isActive(status: string | undefined): boolean {
  return !!status && ACTIVE.has(status);
}

/** The transfers that justify a running service. */
export function activeTransfers(all: Iterable<ActiveTransfer>): ActiveTransfer[] {
  return [...all].filter((t) => isActive(t.status));
}

function fmtBytes(n: number): string {
  if (!n || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

/**
 * Percent of the FILE, not of the current block plan.
 *
 * The block plan grows while the transfer runs (relayGrow appends segments), so
 * done/plannedBlocks slides backwards every time it grows — measured on a real
 * 755 MB send as 32 -> 96 -> 157 blocks. `totalBytes` comes from the manifest
 * and is immutable, so this denominator cannot move.
 *
 * Floor rather than round: a notification must not read 100% while bytes are
 * still outstanding.
 */
function pct(t: ActiveTransfer): number {
  if (t.totalBytes > 0) {
    const safe = Math.max(0, Math.min(t.bytes, t.totalBytes));
    return Math.min(100, Math.floor((safe / t.totalBytes) * 100));
  }
  if (t.total > 0) return Math.min(100, Math.floor((t.done / t.total) * 100));
  return 0;
}

/**
 * One consolidated line for all active transfers.
 *
 * Deliberately carries no filename and no peer: this renders on a lock screen.
 * Sizes and percentages are not secrets; what someone is sending, and to whom,
 * is.
 */
export function notificationText(active: ActiveTransfer[]): { title: string; text: string } {
  if (active.length === 0) return { title: 'VaultBeam', text: 'No active transfers' };

  if (active.length === 1) {
    const t = active[0];
    const verb = t.role === 'sender' ? 'Sending' : 'Receiving';
    const parts = [`${verb} ${fmtBytes(t.totalBytes)}`, `${pct(t)}%`];
    if (t.rateBps && t.rateBps > 0) parts.push(`${fmtBytes(t.rateBps)}/s`);
    // The transport as the transfer itself labelled it — never re-derived here,
    // so this cannot say DIRECT while the bytes are going through TURN.
    if (t.transport) parts.push(t.transport);
    return { title: 'VaultBeam', text: parts.join(' · ') };
  }

  const up = active.filter((t) => t.role === 'sender').length;
  const down = active.length - up;
  const bits: string[] = [];
  if (up) bits.push(`${up} sending`);
  if (down) bits.push(`${down} receiving`);
  const avg = Math.round(active.reduce((s, t) => s + pct(t), 0) / active.length);
  return { title: 'VaultBeam transfers', text: `${bits.join(' · ')} · ${avg}%` };
}

/** What the caller should do with the service, given the current transfers. */
export type ServiceAction = 'start' | 'update' | 'stop' | 'none';

export function decide(running: boolean, activeCount: number): ServiceAction {
  if (activeCount > 0) return running ? 'update' : 'start';
  return running ? 'stop' : 'none';
}

// ── native binding ─────────────────────────────────────────────────
let running = false;
let lastText = '';

function native(): any | null {
  try {
    const { NativeModules } = require('react-native');
    return NativeModules?.VaultBeamStream ?? null;
  } catch { return null; }
}

/**
 * Reconcile the service against the current transfers.
 *
 * Idempotent and best-effort: a device that refuses the promotion (background
 * start restrictions, an OEM battery manager) still transfers while the app is
 * foreground. Losing background protection must never fail a transfer, so every
 * error is swallowed.
 */
export function syncService(all: Iterable<ActiveTransfer>): void {
  const active = activeTransfers(all);
  const action = decide(running, active.length);
  if (action === 'none') return;

  const n = native();
  if (!n) return;                       // older build / not Android

  try {
    if (action === 'stop') {
      running = false; lastText = '';
      n.stopTransferService?.();
      return;
    }
    const { title, text } = notificationText(active);
    if (action === 'start') {
      running = true; lastText = text;
      n.startTransferService?.(title, text);
      return;
    }
    if (text !== lastText) {            // don't re-render an unchanged line
      lastText = text;
      n.updateTransferService?.(title, text);
    }
  } catch { /* never fail a transfer over a notification */ }
}

/** Test seam. */
export function __reset(): void { running = false; lastText = ''; }
export function __running(): boolean { return running; }

export default { isActive, activeTransfers, notificationText, decide, syncService };

// ── self-check ────────────────────────────────────────────────────
if (require.main === module) {
  let failures = 0;
  const A = (ok: boolean, what: string): void => {
    if (!ok) { failures++; console.error('  FAIL', what); } else console.log('  ok  ', what);
  };
  const mk = (o: Partial<ActiveTransfer>): ActiveTransfer => ({
    transferId: 't', role: 'sender', status: 'uploading',
    done: 0, total: 0, bytes: 0, totalBytes: 0, ...o,
  });

  console.log('\nVaultBeam background service\n');

  // ── which statuses justify a service ─────────────────────────────
  for (const s of ['uploading', 'receiving', 'queued']) A(isActive(s), `1. "${s}" keeps the service alive`);
  for (const s of ['complete', 'failed', 'cancelled', 'expired', 'incoming', 'paused', undefined]) {
    A(!isActive(s as any), `2. "${s}" does not`);
  }
  A(!isActive('sent'),
    '3. "sent" does NOT — staging is finished and the peer pulls on its own time');

  // ── lifecycle decisions ──────────────────────────────────────────
  A(decide(false, 1) === 'start', '4. first active transfer starts the service');
  A(decide(true, 1) === 'update', '5. a running service is updated, not restarted');
  A(decide(true, 3) === 'update', '6. three transfers share ONE service');
  A(decide(true, 0) === 'stop', '7. the last transfer ending stops it');
  A(decide(false, 0) === 'none', '8. nothing to do when idle');

  // ── the text is truthful and leaks nothing ───────────────────────
  {
    // bytes, not blocks: progress is measured against the immutable file size,
    // so a fixture that only sets done/total now correctly reports 0%.
    const MB = 1024 * 1024;
    const one = notificationText([mk({
      // ceil, not floor: 34% of 780 MiB is not a whole number of bytes, and
      // flooring lands just under the boundary — which the display then
      // correctly renders as 33%.
      totalBytes: 780 * MB, bytes: Math.ceil(780 * MB * 0.34),
      done: 34, total: 100, transport: 'WEBRTC_DIRECT', rateBps: 8.7 * MB,
    })]);
    A(/Sending/.test(one.text), '9. the sender direction is stated');
    A(/34%/.test(one.text), '10. progress is stated');
    A(/WEBRTC_DIRECT/.test(one.text), '11. the transport label is passed through verbatim');
    A(!/TURN|R2_RELAY/.test(one.text), '12. and no other transport is implied');

    const recv = notificationText([mk({ role: 'recipient', status: 'receiving', totalBytes: 1024, done: 1, total: 2 })]);
    A(/Receiving/.test(recv.text), '13. the receive direction is stated');
  }
  {
    const t = notificationText([
      mk({ transferId: 'a' }),
      mk({ transferId: 'b', role: 'recipient', status: 'receiving' }),
      mk({ transferId: 'c' }),
    ]);
    A(/2 sending/.test(t.text) && /1 receiving/.test(t.text),
      '14. several transfers collapse into one consolidated line');
  }
  A(notificationText([]).text === 'No active transfers', '15. the empty case says so plainly');

  // Nothing identifying may reach a lock screen.
  {
    const t = notificationText([mk({ totalBytes: 1024, transport: 'R2_RELAY' })]);
    for (const leak of ['.mp4', 'Leo', 'http', 'X-Amz', 'file://', '/data/']) {
      A(!t.text.includes(leak) && !t.title.includes(leak),
        `16. the notification never contains ${leak}`);
    }
  }
  // It must not upgrade the truth.
  {
    const t = notificationText([mk({ status: 'uploading', transport: 'R2_RELAY', totalBytes: 10 })]);
    A(!/Delivered|Complete/i.test(t.text),
      '17. staging to R2 is never rendered as delivered or complete');
  }

  // ── filtering ────────────────────────────────────────────────────
  {
    const all = [mk({ transferId: 'a' }), mk({ transferId: 'b', status: 'complete' }), mk({ transferId: 'c', status: 'receiving', role: 'recipient' })];
    A(activeTransfers(all).length === 2, '18. only active transfers are counted');
    A(!activeTransfers(all).some((t) => t.transferId === 'b'), '19. a completed one is excluded');
  }

  // ── never throws without a native module ─────────────────────────
  {
    let threw = false;
    try { syncService([mk({})]); syncService([]); } catch { threw = true; }
    A(!threw, '20. syncService is inert and silent when the native module is absent');
  }

  console.log(failures === 0
    ? '\nALL BACKGROUND-SERVICE CHECKS PASSED ✓  (device background proof separate)\n'
    : `\n${failures} FAILED ✗\n`);
  process.exit(failures === 0 ? 0 : 1);
}
