# Audit 04: delivery cursor scope

Confirmed and fixed in `vaultchat-backend-go/internal/routes/chats_helpers.go`:

- The delivered route accepted arbitrary positive IDs before writing both the per-device and account high-water marks. A future or another chat's ID could suppress subsequent cold-sync delivery and falsely advance grey ticks.
- Validation now precedes both writes, requires active membership, rejects IDs above this chat's maximum and any retained ID belonging to another chat. Nonpositive IDs are rejected. Neither validation nor membership depends on RLS.
- As with the existing read route, an absent row below the current chat maximum remains acceptable because legitimate history can have been purged. Without a retained row, original ownership cannot be reconstructed; no schema migration is introduced.
- Both write statements also scope active membership. Duplicate and out-of-order valid receipts preserve monotonic behavior. Existing read privacy and fanout rules are unchanged.

`TestDeliveryCursorScratchDB` exercises the actual authenticated handler against temporary PostgreSQL tables, including per-device headers, invalid/future/foreign IDs, outsiders, departed members, valid advances, purged holes, duplicates and out-of-order receipts. It requires an explicitly configured localhost `SYNC_TEST_DSN` and never reads application tables. Root integration work will execute it in the disposable PostgreSQL container.

Focused route tests compiled and passed locally; PostgreSQL-dependent cases skip without the DSN. No deployment or phone verification is claimed by this audit. Ponytail diff review found no additional abstraction or dependency to remove.
