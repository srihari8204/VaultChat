// lib/vaultBeamIngest.ts — VaultBeam auto-download ingest.
//
// Called from the `new_message` handlers (foreground app + background service).
// For an incoming vaultbeam message it runs the policy engine and, if eligible,
// queues an auto-download. Flag-gated (VB_AUTODOWNLOAD) and fail-safe: anything
// uncertain leaves the normal Manual-Accept card untouched — this never blocks
// or alters the existing manual flow.

import { VB_AUTODOWNLOAD } from '../constants/flags';
import { getSettings } from './vaultBeamSettings';
import { shouldAutoDownload } from './vaultBeamAutoDownload';
import { enqueueAutoDownload } from './vaultBeamQueue';
import { parseManifest, markTransferQueued, autoStartReceive } from './vaultBeamController';
import { isNativeStreamAvailable } from './vaultBeamStreamNative';

const pick = <T,>(...vals: T[]): T | undefined => vals.find((v) => v != null);

// Cache the current user id so the persistent new_message listener needn't
// thread it through (avoids stale-closure bugs at both call sites).
let _selfId: string | null | undefined;
async function selfId(): Promise<string | null> {
  if (_selfId !== undefined) return _selfId;
  try { const { getCurrentUserAsync } = await import('../app/(constants)/authService'); _selfId = (await getCurrentUserAsync())?.id ?? null; }
  catch { _selfId = null; }
  return _selfId;
}

/**
 * Evaluate an incoming message for VaultBeam auto-download.
 * @param m  raw new_message payload
 */
export async function onIncomingVaultbeamMessage(m: any): Promise<void> {
  try {
    if (!VB_AUTODOWNLOAD) return;                       // feature off → manual only, as today
    if (!m?.meta?.vaultbeam) return;                    // not a VaultBeam invite
    if (!isNativeStreamAvailable()) return;             // can't receive on this build → leave manual

    const transferId: string | undefined = m.meta.transferId;
    const size = Number(m.meta.size) || 0;              // plaintext in meta — size-gate before decrypt
    const senderId: string | null = (pick(m.senderId, m.sender_id, m?.sender?.id) as string) ?? null;
    const chatId: string | undefined = pick(m.chatId, m.chat_id) as string | undefined;
    if (!transferId || !chatId) return;
    const me = await selfId();
    if (me && senderId && senderId === me) return;      // our own send

    const settings = await getSettings();
    if (settings.mode !== 'auto') return;               // user wants manual approval

    // Cheap size pre-check on plaintext meta before we spend a decrypt.
    const pre = await shouldAutoDownload({ size, senderId }, settings);
    if (!pre.auto) return;                              // not eligible → leave the manual card

    // Decrypt the manifest (name/key/fileId/token) to actually start the receive.
    const { hydrateMessages } = await import('./chatService');
    const [hm] = await hydrateMessages(chatId, [m as any]).catch(() => [m]);
    const manifest = parseManifest((hm as any)?.content ?? m.content);
    if (!manifest) return;                              // undecryptable yet → manual card handles it

    // Re-check against the authoritative manifest size, then enqueue.
    const decision = await shouldAutoDownload({ size: manifest.size || size, senderId }, settings);
    if (!decision.auto) return;

    markTransferQueued(transferId, manifest.name, manifest.size || size);
    // Same server stamp the manual card passes. Auto-download must not be the
    // path that quietly accepts an offer the manual card would refuse.
    const offerCreatedAt: string | null = (pick(m.createdAt, m.created_at) as string) ?? null;
    enqueueAutoDownload(transferId, () => autoStartReceive({ transferId, manifest, peerId: senderId ?? '', offerCreatedAt }));
  } catch { /* fail-safe: never let ingest break message delivery */ }
}

export default { onIncomingVaultbeamMessage };
