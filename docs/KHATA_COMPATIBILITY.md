# Khata compatibility rule

Two ledger behaviours coexist deliberately. This file exists because they
contradict each other, and the contradiction is intentional rather than an
oversight — anyone reading only one of them will "fix" the other.

## The rule

| Surface | Behaviour | Why |
|---|---|---|
| **Existing ShopBook ledger** | Preserve exactly as it works today — entries remain editable | Shipped behaviour with users depending on it |
| **New Khata transactions** | Append-only — never overwrite a financial row | Offline sync replays events; an editable row has no single truth |
| **Customer profile** (name, mobile, alt mobile, address, notes) | Editable | It is a contact record, not a financial fact |

## Where the contradiction comes from

`vaultchat-backend/migrations/110_shopbook_documents.sql` says, in its own words:

> Entries become editable (owner corrects a wrong amount), so the stamp needs
> somewhere to land.

That is why `shopbook_ledger.updated_at` exists. The shipped khata therefore
permits an owner to change a recorded amount in place.

The offline Khata specification requires the opposite: a wrong transaction is
corrected by appending a compensating entry, never by rewriting the original.

Both are defensible. An owner fixing a typo seconds after typing it is not the
same problem as two devices reconciling a week of offline entries.

## What must NOT happen

- **Do not** modify migration 110, `shopbook_ledger.updated_at`, or any existing
  ledger handler to force the append-only rule. Existing behaviour is preserved.
- **Do not** add an `UPDATE` path for amounts on the new Khata surface.
- **Do not** store a mutable balance anywhere. The balance is derived, and it is
  derived today by `SUM(CASE WHEN type='purchase' THEN amount ELSE -amount END)`
  in `shopbook.go` (see `sbOwnerLedger` / `sbCustomerLedger`). That query is the
  source of truth for both surfaces and must stay that way.

## How append-only is achieved without new machinery

Nothing new is required to enforce it:

- `shopbook_ledger` is already one row per transaction with an immutable
  `created_at`.
- Corrections append a row. The existing type vocabulary is
  `purchase | payment | credit_note | refund` (migration 095); an `adjustment`
  type would be an additive CHECK extension if the offline layer needs one.
- Replay safety is the partial unique index on
  `(shop_id, idempotency_key) WHERE idempotency_key <> ''` (migration 092),
  which the offline layer populates as `<device_id>:<local_transaction_id>`.
  `sbIdemKey` truncates at 100 characters; two UUIDs plus a separator is 73, so
  the existing mechanism carries offline identity unchanged.

Verified by `vaultchat-backend/migrations/tests/111_khata_walkin_test.sql` §6 and
by `TestSBDuplicateKhataEntryCreatesOneRow` in
`vaultchat-backend-go/internal/routes/shopbook_flows_test.go`.

## Enforcement point

Append-only is a property of the **new Khata write path**, not of the table. The
table is shared, so a database-level immutability trigger would break the
existing editable behaviour that 110 deliberately introduced. The rule therefore
lives in whichever handler the offline Khata layer adds, and this document is the
reason a future reader will not "unify" the two.
