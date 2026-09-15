# Receipt path re-audit

Read-only source audit, 2026-09-15. No device, production, or implementation changes. Existing root test results were not independently rerun. Findings below are confirmed code paths; reproduction sequences are not device executions.

## P1 — Undecryptable messages are acknowledged after their envelope is discarded

`lib/syncEngine.ts:97-108` falls back to raw rows when hydration fails and treats `cacheMessages` completion as durable delivery (`:250`). However, `lib/localDb.ts:389` replaces recognized encrypted envelopes with NULL before inserting them; `looksLikeEnvelope` explicitly recognizes GSK1 and dr1 (`:710`). For a first-time row there is no existing plaintext for COALESCE to preserve. This contradicts the fallback's stated guarantee that ciphertext is stored for later retry.

Reproduce: sync a new GSK1/dr1 message while the required key is unavailable / hydration throws. The local row has NULL content, then the delivery pointer advances. When configured delete-on-delivery runs (`vaultchat-backend-go/internal/jobs/jobs.go:489` onward), the server can reclaim the remaining body. Later key recovery cannot recover the discarded envelope from this row. Preserve an unopened envelope durably before acknowledging, while keeping any existing plaintext intact.

## P1 — Receipt state crosses account switches

`lib/receipts.ts:14-25` uses one process-global map and `vc_receipts_v1`, keyed only by chat. There is no session identity/generation or reset. `app/(constants)/authService.ts:378-437` clears local messages and selected AsyncStorage keys on logout but does not remove this key or reset the receipt module. Requests at `lib/receipts.ts:108-118` use the current API session.

Reproduce: account A reads shared group G offline, leaving an unacknowledged read pointer; sign out and sign in as B, another member of G, on the same installation. Reconnect flushes A's pointer as B. The server updates B's membership (`chats_helpers.go:1439-1469`), producing blue receipts without B opening G and potentially satisfying vanish-after-read conditions. Already acknowledged A pointers also suppress B's new receipt attempts below A's watermark. Scope persisted and in-memory state to the account and invalidate pending work at session changes.

## P1 — Delivered endpoint accepts permanently excessive cursors

`vaultchat-backend-go/internal/routes/chats_helpers.go:1319-1374` rejects only zero, then monotonically writes the supplied value to both device and member delivery pointers. It does not bound the value to the chat's message IDs, unlike the read endpoint immediately below it.

Reproduce: authenticated member posts a future/global-foreign positive ID to `/chats/G/delivered`. It becomes the delivery high-water mark and cannot be lowered by subsequent normal receipts. Future messages below that value appear delivered without being received; server reclamation can treat this recipient/device as already satisfied. Reject out-of-range cursors before either write. This is an API validation finding, not evidence that the current ordinary client generates such a request.

## Verified structure and remaining limits

- Background sync and global catch-up emit delivery only; ordinary chat read effects require both active AppState and focused navigation, with a final timer guard (`app/chat.tsx:1318-1347`). Blue rendering requires every eligible recipient's read watermark; grey delivery accepts read as implying delivery (`components/chat/MessageBubble.tsx:1140-1166`).
- Receipt hydration now shares one awaited promise; the serialized/coalesced writer and dirty-flush rerun address the previously described races. Persistence failure rejects the mark call and prevents scheduling its normal flush, but concurrent explicit flushes do not await persistence.
- `syncEngine` also has no session-generation guard around its awaited network/cache work. A response started before logout can reach the global cache after logout clears it. This is an additional source-level race requiring a session-switch harness to establish the exact runtime timing; not counted as a separate confirmed reproduction here.
- Live receipt handlers assign event watermarks directly (`app/chat.tsx:1074,1091`), so externally reordered events can regress visible ticks until refresh. Actual event ordering across production emitters was outside this bounded audit.
