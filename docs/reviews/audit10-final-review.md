# Audit 10: final integration and security re-audit

Reviewed current receipt ownership/persistence, pending-envelope recovery, exclusive transport selection, event authorization/bounds, native interoperability evidence and the prepared rollout/rollback. Production source was read-only for this audit; root owns the APK, deployment and phone tests. Backend candidate under review is `a87ebdea3825f347`.

## Follow-up fixed and checked

The live `onMemberDelivered` and `onMemberRead` handlers in `app/chat.tsx` directly assigned incoming watermarks, allowing delayed older fanout events to regress grey/blue ticks despite the database remaining monotonic. Root fixed both handlers to validate the numeric cursor and merge with `Math.max(existing, incoming)`; outbox delivery uses the same validated value. This client-only fix does not require a backend rebuild.

`node node_modules/tsx/dist/cli.mjs lib/receiptEvents.selftest.ts` passed. It extracts the actual production arrow functions using the TypeScript AST and executes them with controlled chat state and outbox callbacks. Cases cover reordered and duplicate events, numeric wire strings, nonfinite/unsafe/fractional/nonpositive/missing cursors, malformed events, other-member isolation and invalid events never releasing recovery copies. No production source was changed by this regression-test follow-up.

## Fixes and safeguards reviewed

- Account-owned receipt snapshots replace the unscoped installation store. In-flight requests pass the expected user through the API token selection and refresh path. Pending old-account snapshots cannot be attributed to another login. Refusing to import unowned legacy read intent is a deliberate compatibility limit, not a claim to recover its ownership.
- Incoming undecryptable envelopes are retained separately in sealed local storage while readable plaintext remains visible. The chat retry explicitly removes these IDs from its plaintext shortcut, preventing an old edit's plaintext from satisfying the new envelope's decryption. Deletes clear pending ciphertext, and local tombstones remain sticky.
- Server delivery validation precedes both device and account writes, with active-membership scope independent of RLS. Future and retained foreign-chat IDs are rejected. Root reports the new delivery handler and sync-pagination scratch tests both passed against real isolated PostgreSQL, with container cleanup completed. This audit did not rerun those remote tests.
- Shared app-event callbacks retain existing authorization and server identity stamping. Capability negotiation gates the generic payload path; fragment and physical-frame limits remain separate. The facade closes its primary owner before switching carrier and does not add a second durable offline event queue.
- Audits 06 and 08 report real desktop Go/Rust WebTransport interoperability and shared-event parity checks. Those are evidence for protocol compatibility, not handset JNI operation or production delivery.
- The new deployment script preserves the exact six current overlays plus one final candidate override. It pins image IDs, refuses baseline drift, compares effective configuration outside approved API fields and restarts only `go-api`. Health/readiness, DB/Redis, build and unauthenticated route checks run direct and public; rollback restores the retained image and disables app events while preserving WebTransport. No migration is included.

## Executed here and remaining release checks

`node node_modules/tsx/dist/cli.mjs lib/ccwire/eventsSocket.selftest.ts` passed negotiation, payloads, lifecycle, bounds, single-carrier selection and legacy refusal. The identified live-watermark follow-up is fixed and its executable regression passed. No additional source-level release blocker was found in this scoped re-audit.

The root must complete final consolidated frontend checks after all edits, candidate backend checks, APK build/install, deployment verification and actual two-phone send/delivery/read/edit/delete/reconnect checks. Redmi automation restrictions remain respected. Neither this report nor earlier code-level tests establish that both phones currently work. Resource improvements require the comparable measurements described in audit 09; no lower-RAM or worldwide-network claim is established.
