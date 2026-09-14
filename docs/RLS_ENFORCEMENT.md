# Is Row-Level Security actually enforced?

**Status: the gap is now closable in one deliberate step.** Migration 067,
`scripts/enable-rls-force.sql` and `db.SysPool` are in place; enforcement is a
checklist, not a project.
Nothing is enforced until you run step 3 below, and until then behaviour is
byte-for-byte what it was.

I found this while building the call-session schema (066) and verifying it
against a real Postgres.

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

## What shipped

| | |
|---|---|
| `scripts/check-rls.sql` | read-only diagnostic — tells you which case you're in |
| **067** | the missing `chats` INSERT policy |
| `db.SysPool` | a pool for queries that have no acting user, falling back to `db.Pool` when unconfigured |
| `scripts/enable-rls-force.sql` | `FORCE ROW LEVEL SECURITY` on all six policy-bearing tables — **guarded**, and deliberately not a migration |
| `internal/db/syspool_test.go` | pins both halves of the fallback |

All four measured on a real Postgres 16, with FORCE on and a `BYPASSRLS` role:

```
without 067, as the app role:   ERROR: new row violates RLS policy for "chats"
with    067, as the app role:   INSERT 0 1
chat visible to a non-member:   0        ← the protection now exists
chat visible to the member:     1
unbound read, app role:         0 rows   ← every sweep, if you skip the system role
unbound read, system role:      1 row    ← what SysPool restores
```

That last pair is the whole argument for the system role: it is not a
precaution, it is the measured difference between a working sweep and one that
silently does nothing.

## How to turn it on

1. `psql "$DATABASE_URL" -f vaultchat-backend/scripts/check-rls.sql` — if the
   verdict is already `enforced`/`ENFORCED`, stop, there is nothing to do.
2. Apply **067** — it rides the normal `migrate.js up`, and is safe on its own:
   adding a policy to a bypassed table changes nothing today.
3. Create the system role, point `DB_SYSTEM_USER`/`DB_SYSTEM_PASS` at it, and
   restart the API. A misconfigured role makes the API refuse to boot rather
   than serve wrong data.
4. Run `psql "$DATABASE_URL" -f vaultchat-backend/scripts/enable-rls-force.sql`.
   Rollback is `ALTER TABLE <t> NO FORCE ROW LEVEL SECURITY;`, effective
   immediately, touching no data.

> **Why step 4 is not a migration.** It was numbered `068` at first, and that was
> wrong: `deploy.sh` step 4 runs `node migrate.js up`, which applies *every*
> pending file. A routine deploy would therefore have enforced RLS with no system
> role configured, and every user-less query would have started returning zero
> rows — silently, with no error and no crash.
>
> It now lives in `scripts/`, outside the migration runner, and **refuses to run**
> unless a non-superuser `BYPASSRLS` login role exists. Enforcing RLS is an
> operational switch, not a schema change: it alters no data and its rollback is
> one statement per table. It should be thrown by a person who has read this
> page, not swept up by an automated run.

## The 18 queries that made step 3 necessary

Queries against a policy-bearing table with no bound user, now on `db.SysPool`.
They fall into three kinds, and none of them is a mistake to be converted:

- **No actor exists.** Retention sweeps (`internal/jobs`), presence and
  notification fan-out (`internal/realtime`), the admin console (x-admin-key,
  not a user JWT). Binding a user is meaningless here.
- **Cross-user by design.** Invite-link resolution reads a chat you are *not yet
  a member of* — that is what an invite is. Story access reads another user's
  story. Presence fan-out deliberately reads *other people's* memberships.
  Binding a user would return the wrong answer.
- **Explicit checks that predate RLS.** Several routes read a row and then check
  membership themselves, specifically to return 403 rather than 404. RLS would
  hide the row and silently turn those into 404s — a behaviour change, not an
  improvement.

The third kind was the honest follow-up, and **one of them is now done**:
`POST /user/bookmarks` reads a message by id and then checks membership itself.
That read is bound to the caller now, so the database backs the check up instead
of it standing alone. Measured both ways on Postgres 16:

```
ENFORCED (owner=postgres, FORCE on)      member: 1 row | non-member: 0 rows
BYPASSED (owner=app, FORCE off)          member: 1 row | non-member: 1 row
```

Which means the handler behaves correctly under either:

| | outcome |
|---|---|
| RLS enforced | the read returns nothing → **404**, the membership check never runs |
| RLS bypassed (today) | the read succeeds → the manual check answers **403**, exactly as before |

So enforcing RLS turns some 403s into 404s here. That is the safer direction: a
403 confirms the message exists, a 404 does not.

### Deliberately not changed: the bookmarks LIST

`GET /user/bookmarks` LEFT JOINs `messages` and `chats` to render each saved
item. Binding it to the caller would blank out any bookmark whose chat the user
has since **left** — their own saved item would lose its content.

That is a product decision, not a security fix, and it cuts both ways: retaining
a message from a chat you left is arguably the leak, and losing your own saved
item is arguably the bug. The stored body is E2EE ciphertext either way, so the
exposure is smaller than it first looks. Left alone deliberately — say which
behaviour you want and it is a one-line change.

### Also corrected

One query marked `SysPool` was `SELECT NOW()`. It touches no table, so there is
nothing for RLS to gate, and labelling it as a system query weakened the very
thing the label is for: `SysPool` is meant to be a claim a reviewer can trust —
"this must see rows no user may see". It is back on the plain pool.

## What I did and did not change

**Did:** the two new tables (`calls`, `call_participants`) are `FORCE ROW LEVEL
SECURITY`. They are new, so there is no existing behaviour to break, and the
call-role model is exactly the kind of thing that must not depend on a
deployment detail. `scripts/test-call-rls.sh` proves the policies hold.

**Did not:** enable FORCE or create the system role. Both are deployment actions on
a database I cannot see, and the second must come first. The reasons that made
this risky are now handled rather than merely documented:

- ~~Chat creation would break immediately.~~ Fixed by **067**, and the failure
  and the fix are both reproduced above.
- ~~Every unbound server query would return zero rows.~~ Those 18 queries now
  run on `db.SysPool`, which is the user pool until a system role exists — and
  the enforcement script refuses to run before that role is there.

What remains is genuinely yours: creating a role and applying a migration.

### Scope note

RLS covers **six** tables. Everything else — stories, channels, communities,
shopbook, vaultbeam, devices, users — has never had RLS and is protected by the
route layer's own checks. That is a defensible design, but it means enforcing
these six is defence-in-depth for chats, messages, attachments and calls, not a
blanket guarantee across the schema. Extending RLS further is a separate piece
of work with a much larger surface.

---

## If it turns out RLS *is* enforced

Then nothing here is urgent: the model works as designed, `chats` inserts must
be happening through a path I haven't traced, and the only leftover is that the
verification instruction in `004_rls.sql` should mention ownership alongside
`BYPASSRLS`. Worth a one-line fix either way.

---

# Enforcement plan

*Appended after re-verifying the finding above against the repository as it
stands. Nothing in this section has been applied. Docker does not start on the
machine this was written on and there is no production database reachable from
it, so every claim below is either a citation or an assertion tested in Go —
and is labelled as such.*

## 0. Verify the premise before changing anything

Run this first. It is read-only, it takes milliseconds, and it is the whole
justification for the rest of the section. If it says RLS is enforced, **stop**
— nothing below applies to you.

```sql
-- Does row-level security actually apply to this connection?
-- READ-ONLY. Safe against production. Run it as the role the API connects as
-- (DB_USER), through the same pooler — not as postgres from a shell.
SELECT
  current_user                                     AS connected_as,
  r.rolsuper                                       AS is_superuser,
  r.rolbypassrls                                   AS has_bypassrls,
  count(*) FILTER (WHERE c.relrowsecurity)         AS tables_with_rls,
  count(*) FILTER (WHERE c.relforcerowsecurity)    AS tables_forced,
  count(*) FILTER (WHERE c.relrowsecurity
                     AND pg_get_userbyid(c.relowner) = current_user
                     AND NOT c.relforcerowsecurity) AS inert_via_ownership,
  CASE
    WHEN r.rolsuper OR r.rolbypassrls
      THEN 'BYPASSED ENTIRELY - this role ignores every policy, FORCE included'
    WHEN count(*) FILTER (WHERE c.relrowsecurity
                            AND pg_get_userbyid(c.relowner) = current_user
                            AND NOT c.relforcerowsecurity) > 0
      THEN 'PARTLY INERT - you own tables that are not FORCEd'
    ELSE 'ENFORCED for this role'
  END                                              AS verdict
FROM pg_roles r
CROSS JOIN pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE r.rolname = current_user
  AND n.nspname = 'public' AND c.relkind = 'r'
GROUP BY 1, 2, 3;
```

`vaultchat-backend/scripts/check-rls.sql` gives the same picture per table and
is worth running alongside — but **read its `verdict` column with care: it is
wrong for a superuser.** It reports `ENFORCED` for any table with
`relforcerowsecurity`, and FORCE does not constrain a superuser. On this
deployment it would label `call_invites` enforced when it is not. The query
above checks the role first, which is the correct order.

## The verdict here, and the evidence

**RLS is inert. Every policy in this schema is decorative today.** Three
independent citations, no database required:

| where | what it says |
|---|---|
| `docker-compose.yml:233-234` | `POSTGRES_USER: vaultchat` — the postgres image passes this to `initdb --username`, which makes it the **bootstrap superuser**. |
| `docker-compose.yml:61`, `vaultchat-backend/.env:21` | `DB_USER=vaultchat` — the API and `migrate.js` both connect as that superuser, so it also **owns every table**. |
| `docs/REBUILD_RISKS.md:180-186` | A dump of live `pg_roles` from the box: `vaultchat SUPERUSER BYPASSRLS <- what everything actually connects as today`. |

Both exemptions apply at once, and the superuser one cannot be lifted by
anything — not `FORCE`, not `NOINHERIT`, not a policy. `db.WithUser` sets
`app.current_user_id` on every request and no policy is ever consulted about it.

**Correcting the scale, since the earlier numbers circulate:**
`scripts/rls-roles.sql` and `scripts/rls-flip.md` both say "31 RLS-enabled
tables, 27 of them FORCE". Grepped against `vaultchat-backend/migrations/`,
**33 tables get `ENABLE ROW LEVEL SECURITY` and exactly one gets `FORCE`** —
`call_invites`, in `123_call_invites.sql:50`. The 27 presumably came from a
live `pg_class` read after `scripts/enable-rls-force.sql` (6 tables) or similar
hand-run SQL, which is itself the point: **the FORCE state of this database is
not reproducible from the migrations.** Step 0 tells you the truth for your
deployment; the repo cannot.

The verdict does not change either way. A superuser bypasses 1 forced table and
27 forced tables identically.

## The danger, stated once and plainly

**A policy that is subtly wrong returns zero rows. It does not error.**

This is the single fact that should govern the pace of the cutover. Every other
class of bug in this codebase announces itself: a panic, a 500, a failing test.
This one does not. The API boots. `/ready` returns 200. Logs are clean. Metrics
show queries completing successfully and quickly — faster, in fact, since they
return nothing. And every chat list, message thread, call and Space is empty.

Three consequences worth holding separately:

1. **The failure is total and immediate.** Not a slow leak, not one endpoint.
   The instant the process connects as a role the policies apply to, every read
   on all 33 tables is re-evaluated. There is no partial state to triage from.
2. **It looks like a bug, not a security event.** Which means the reflex is to
   debug the app — check the client, check the cache, check the socket layer —
   while the cause is one environment variable. Budget for that, or the
   rollback takes an hour instead of a minute.
3. **It is invisible to the test suite that would catch anything else.** Routes
   tests assert on handler behaviour, and the handlers are correct. The thing
   that changed is below them.

`scripts/rls-flip.md` records that the `internal/routes` and `internal/jobs`
suites were rehearsed green against a scratch database as a real
`NOSUPERUSER NOBYPASSRLS` role. That rehearsal is the strongest evidence
available and it is still not coverage: **routes with no test are not
rehearsed.** Expect the first real failure on a path nobody exercises in CI.

## What is now prepared

| file | what it does |
|---|---|
| `vaultchat-backend/migrations/133_rls_roles.sql` | Creates `vaultchat_app` and `vaultchat_sys` **NOLOGIN, passwordless**, grants data privileges on current and future objects, owns nothing, and aborts if either role comes out privileged or owning a table. |
| `vaultchat-backend-go/internal/db/rls.go` | `DB_RLS_ENFORCE`, default **off**. On, it asserts at boot that both roles are what the cutover requires and refuses to start otherwise. Off, it runs no query at all. |
| `vaultchat-backend-go/internal/db/rls_test.go` | Six tests, no database. They pin the default-off behaviour and each refusal. |
| the query in step 0 above | Read-only verification. |

Already in the tree and reused rather than rewritten: `db.WithUser`
(the `SET LOCAL` half — it has always been there), `db.SysPool`,
`scripts/rls-roles.sql`, `scripts/enable-rls-force.sql`,
`scripts/check-rls.sql`, `scripts/rls-flip.md`, migration `128`
(partition DDL as `SECURITY DEFINER`, without which message sends begin failing
*on the hour* rather than at deploy time).

**Why 133 exists when `scripts/rls-roles.sql` already does this.** That script
is not reproducible: it is outside the migration sequence, it needs psql
meta-commands (`\gset`, `\if`) that `migrate.js` cannot execute, and grants for
every table added since exist only because somebody remembered to re-run it.
`docs/REBUILD_RISKS.md:194` flags precisely that and recommends promoting it.
133 takes over the create-and-grant half so a rebuilt database has the roles
without anyone remembering. The script keeps the password half, which a
migration must not hold.

**Why 133 is safe to apply on its own, including in a routine `migrate.js up`.**
The roles are `NOLOGIN` with no password. Nothing can connect as them. A role
nothing connects as cannot change one query's result, and grants to it are
equally inert. This is the property that makes it correct for the automated
runner — and the same property `scripts/enable-rls-force.sql` lacks, which is
why that one is deliberately not a migration.

## Cutover

Six steps. Steps 1-3 change no behaviour and can be done on any ordinary day.
Step 4 is the only one that can break anything, and it breaks everything at
once. Do it in a window, with a person watching, not at the end of a deploy.

### 1. Verify — read-only

Run step 0. Verdict `BYPASSED ENTIRELY` means proceed. Anything else means stop
and re-read: the premise of this document does not hold for your deployment.

### 2. Apply migration 133

```sh
cd vaultchat-backend && node migrate.js status   # expect 133 pending
node migrate.js up
```

*Verify:* `SELECT rolname, rolcanlogin, rolsuper, rolbypassrls FROM pg_roles
WHERE rolname LIKE 'vaultchat%';` — both new roles `rolcanlogin = f`,
`rolsuper = f`, and `vaultchat_sys` alone with `rolbypassrls = t`. The app is
untouched; do not restart anything.

*Rollback:* none needed. If you want it gone anyway, the statements are
commented at the foot of the migration file.

### 3. Arm the roles — still no behaviour change

Two statements, outside the migration runner, with passwords you generate:

```sql
ALTER ROLE vaultchat_app LOGIN PASSWORD '<generated>';
ALTER ROLE vaultchat_sys LOGIN PASSWORD '<generated>';
```

*Verify:* connect as each with `psql` and run
`SELECT count(*) FROM chat_members;`. **Both should still return the full count**
— policies exist but no table the app reads is `FORCE`d and neither role owns
anything, so nothing is refused yet. A `permission denied` here means a missing
grant, and it is much better to find that now than in step 4.

*Also check, before the window rather than during it:* PgBouncer authenticates
with `auth_user=vaultchat` and an auth query, so both roles resolve without a
`userlist.txt` edit (`docs/REBUILD_RISKS.md:203`). Confirm it.

*Rollback:* `ALTER ROLE vaultchat_app NOLOGIN;` and the same for `_sys`.

### 4. Flip the API — the one dangerous step

```sh
# vaultchat-backend/.env
DB_USER=vaultchat_app
DB_PASS=<app_pass>
DB_SYSTEM_USER=vaultchat_sys
DB_SYSTEM_PASS=<sys_pass>
DB_RLS_ENFORCE=1
```

`DB_RLS_ENFORCE=1` is what makes `rls.go` assert, at boot, that you did not
forget `DB_SYSTEM_USER` — the mistake that otherwise turns every retention
sweep, presence fan-out and invite-link lookup into a silent no-op. Setting it
without repointing `DB_USER` is also refused: a flag claiming enforcement on a
superuser connection is worse than no flag.

```sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.box.yml up -d go-api
```

*Verify — in this order, and on a real device, not with curl alone:*

```sh
docker logs --since 5m vaultchat-go-api-1 2>&1 | grep -iE 'DB_RLS_ENFORCE|permission denied|SQLSTATE 42501'
curl -s https://api.corefinite.com/ready
```

Then: send and receive a message, open a group, start a call, open Shop Book,
open Spaces. **Empty is the symptom. Not errors — empty.** A screen that
renders fine with nothing in it is the signal to roll back.

*Rollback — under a minute:* `DB_USER=vaultchat`, remove `DB_SYSTEM_USER` and
`DB_RLS_ENFORCE`, restart. No migration to undo, no data to repair, roles stay
where they are for the next attempt.

### 5. Enforce ownership — per table, one at a time

Steps 1-4 only remove the *superuser* exemption. Because neither new role owns
anything, that is already enough for policies to apply. `FORCE` matters only if
a future change makes one of these roles an owner, and for the six tables
`scripts/enable-rls-force.sql` covers it is defence in depth:

```sh
psql "$DATABASE_URL" -f vaultchat-backend/scripts/enable-rls-force.sql
```

It refuses to run until a non-superuser `BYPASSRLS` login role exists, so it
cannot precede step 3. **Read `004_rls.sql` first** — and note that this
document records `chats` as having had no INSERT policy, fixed by `067`.
Confirm `067` is applied before forcing `chats`, or chat creation stops.

*Verify:* re-run step 0 and exercise chat creation specifically.
*Rollback:* `ALTER TABLE <t> NO FORCE ROW LEVEL SECURITY;` — immediate, per
table, touches no data.

### 6. Clean up the record

- Delete the sentences in `004_rls.sql` and `099_message_bodies.sql` saying the
  API connects as a superuser, once it does not.
- Fix the `verdict` column in `scripts/check-rls.sql` to check `rolsuper` /
  `rolbypassrls` before `relforcerowsecurity`. It currently reports `ENFORCED`
  for a table a superuser bypasses.
- Add a deploy step that re-runs 133, so a new table never arrives without
  grants.

## What was deliberately not done

- **Nothing applied.** No migration run, no role created, no env changed.
- **No new verification script.** `scripts/check-rls.sql` exists and mostly
  works; the corrected query lives in step 0 rather than as a seventh file in
  `scripts/`.
- **Ownership is not re-checked at every boot.** Migration 133 asserts it at
  apply time and step 0 shows it read-only. Scanning 170 tables on every
  process start buys nothing that costs nothing.
- **The 18 `SysPool` queries were not revisited.** They are already converted
  and argued for above; nothing found here changes that analysis.
