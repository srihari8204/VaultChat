# Is Row-Level Security actually enforced?

**Status: needs one read-only command against production to answer.**
I found this while building the call-session schema (066) and verifying it
against a real Postgres. I have not touched any existing table.

---

## The finding

`004_rls.sql` sets up a careful RLS model — chat membership gates chats,
chat_members, messages and more — and tells you to verify it with:

```
\du vaultchat_app
```

That checks the `BYPASSRLS` **attribute**, which is a necessary check but not a
sufficient one. Postgres exempts a table's **owner** from that table's own
policies unless the table is explicitly set to `FORCE ROW LEVEL SECURITY`. No
migration in this repo sets FORCE on any table.

So if the role the app connects as also owns these tables — which is the normal
outcome when migrations are applied as that role — **every policy in 004_rls.sql
is inert**, and `\du` will not tell you.

### Demonstrated, not theorised

On a scratch Postgres 16, a table owned by the connecting role with a policy of
`USING (false)` — deny everything:

```
SELECT count(*) FROM owned_by_app;   →  1     -- the row is returned
ALTER TABLE owned_by_app FORCE ROW LEVEL SECURITY;
SELECT count(*) FROM owned_by_app;   →  0     -- now the policy applies
```

### Corroborating evidence in this repo

`chats` has RLS enabled and **no INSERT policy at all**. With RLS in force, no
policy means *deny* — an ordinary role cannot insert a chat. The comment in
`004_rls.sql` describes this as "INSERT is intentionally unrestricted at the row
level", which is the opposite of what Postgres does.

Chat creation demonstrably works in production. Both facts can only be true at
once if RLS is being bypassed there. That is not proof — the app role might not
own the tables and something else might explain it — but it is the reading that
fits.

I hit this concretely: seeding a chat as the app role in the new RLS test fails
with `new row violates row-level security policy for table "chats"`, which is
why `scripts/test-call-rls.sh` seeds its fixtures as an admin role.

---

## How to check, in one command

Read-only, safe against production:

```
psql "$DATABASE_URL" -f vaultchat-backend/scripts/check-rls.sql
```

Read the `verdict` column:

| verdict | meaning |
|---|---|
| `OFF — no policies apply` | RLS not enabled on that table |
| `INERT — you own it and FORCE is off` | **policies exist and are bypassed** |
| `enforced for you (you are not the owner)` | policies apply |
| `ENFORCED` | policies apply unconditionally |

---

## What I did and did not change

**Did:** the two new tables (`calls`, `call_participants`) are `FORCE ROW LEVEL
SECURITY`. They are new, so there is no existing behaviour to break, and the
call-role model is exactly the kind of thing that must not depend on a
deployment detail. `scripts/test-call-rls.sh` proves the policies hold.

**Did not:** flip FORCE on any existing table. That is a behaviour change with
real breakage risk, and it needs its own verification pass rather than riding
along with a call feature:

- Chat creation would break immediately — `chats` has no INSERT policy, so with
  FORCE on, every `INSERT INTO chats` is denied. A policy has to be written
  first.
- Any server path that queries **without** `SET app.current_user_id` currently
  succeeds via owner-bypass and would start returning zero rows: system fan-out,
  sweepers, BullMQ workers, migration-adjacent scripts. `db.WithUser` sets it,
  but `db.Pool.Query` used directly does not — and there are such calls (for
  example `callerIdentity` and `fcmTokensFor` in `routes/calls.go`, which read
  `users` and `devices`; neither table has RLS today, so they are fine now, but
  they show the pattern exists).

The safe order, if you want it enforced:

1. Run `check-rls.sql` against production and find out which case you're in.
2. If INERT: write the missing `chats` INSERT policy.
3. Audit every direct `db.Pool` query for one that reads a user-owned table
   without a bound user.
4. Enable FORCE **one table at a time**, exercising the app after each.

That is a self-contained piece of work. I can do it if you want it — say the
word and I'll scope it as its own change with its own test pass.

---

## If it turns out RLS *is* enforced

Then nothing here is urgent: the model works as designed, `chats` inserts must
be happening through a path I haven't traced, and the only leftover is that the
verification instruction in `004_rls.sql` should mention ownership alongside
`BYPASSRLS`. Worth a one-line fix either way.
