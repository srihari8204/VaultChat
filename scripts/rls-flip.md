# Turning row-level security on in production

**Audit P1-05.** Production connects to Postgres as `vaultchat` — a superuser,
with `BYPASSRLS`, owning all 170 tables. So all 31 RLS-enabled tables (27 of
them `FORCE ROW LEVEL SECURITY`) are bypassed, and `db.WithUser`'s
`SET LOCAL app.current_user_id` currently defends nothing. Every authorization
decision rests on the explicit `WHERE` clause in each handler.

That is not a reason to panic — the handler checks are real, and the
authorization tests now run against them in CI. It *is* a reason to stop
describing RLS as a control until this is done.

## Why this is a separate, deliberate step

The change itself is two environment variables. Everything risky about it is
what happens on the *first* query that a policy refuses, and that is why the
prerequisites below were done first and separately.

**Prerequisite, already done:** migration 128. Creating or dropping a partition
requires OWNERSHIP of the parent table — not `CREATE` on the schema, not
`BYPASSRLS`. Neither new role has it and neither should. 128 moves both
operations into `SECURITY DEFINER` functions. Without it, message sends start
failing **on the hour**, not at deploy time, which is the worst possible way to
find out.

**Rehearsed, already done:** the full `internal/routes` and `internal/jobs`
suites run green against a scratch database as a real `NOSUPERUSER NOBYPASSRLS`
role. That rehearsal is what turned up the partition problem, plus a VaultBeam
fixture that depended on rows another test created and a metrics baseline read
too early. All three are fixed.

**What the rehearsal does not cover:** routes with no test. The suite is good
and it is not complete, so the first real failure mode to expect after the flip
is `permission denied` or an empty result on a path nobody exercised.

## Do it in a window, not in a hurry

### 1. Create the roles (safe — changes nothing on its own)

```sh
psql "$DATABASE_URL" \
  -v app_pass="'<generated>'" \
  -v sys_pass="'<generated>'" \
  -f scripts/rls-roles.sql
```

Creating a role and granting it privileges has no effect until something
connects as it. Re-run it after any migration that adds tables — the script is
idempotent and also sets default privileges so future tables are covered.

### 2. Flip

In `vaultchat-backend/.env`:

```
DB_USER=vaultchat_app
DB_PASS=<app_pass>
DB_SYSTEM_USER=vaultchat_sys
DB_SYSTEM_PASS=<sys_pass>
```

PgBouncer authenticates with `auth_user=vaultchat` and an auth query, so both
roles resolve without a `userlist.txt` edit — but check this before the window,
not during it.

```sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.box.yml up -d go-api
```

`connectSystem` is **fatal** on failure by design: if a system role is
configured and unreachable, the server refuses to start rather than quietly
demoting to the user role, which would leave every sweep and fan-out reading
zero rows — a backend that boots, serves, and is wrong.

### 3. Watch the things a policy refusal looks like

```sh
curl -s https://api.corefinite.com/ready
docker logs --since 5m vaultchat-go-api-1 2>&1 | grep -iE 'permission denied|SQLSTATE 42501|no rows'
```

Then exercise, on a real device: send and receive a message, open a group,
start a call, open Shop Book, open Spaces. Empty lists are the symptom to watch
for — a policy that refuses rows does not error, it returns nothing, so a screen
that is suddenly empty is the signal, not a crash.

### 4. Roll back in under a minute

Put `DB_USER=vaultchat` back, remove `DB_SYSTEM_USER`, restart. That is the
whole rollback: no migration to undo, no data to repair, and the roles can stay
where they are for the next attempt.

## After it holds

- Delete the sentence in `004_rls.sql` and `099_message_bodies.sql` saying the
  API connects as a superuser, because it will no longer be true.
- Turn `FORCE ROW LEVEL SECURITY` on for the four tables that still lack it —
  but read `004_rls.sql` first: `chats` has **no INSERT policy at all**, so
  forcing it denies every chat creation until one is written.
- Re-run `scripts/rls-roles.sql` as part of the deploy, so a new table never
  arrives without grants.
