# Is Row-Level Security actually enforced?

**Status: the gap is now closable in one deliberate step.** Migrations 067 and
068 plus `db.SysPool` are in place; enforcement is a checklist, not a project.
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
| **068** | `FORCE ROW LEVEL SECURITY` on all six policy-bearing tables |
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
2. Apply **067**. (Safe on its own: adding a policy to a bypassed table changes
   nothing today.)
3. Create the system role, point `DB_SYSTEM_USER`/`DB_SYSTEM_PASS` at it, and
   restart the API. A misconfigured role makes the API refuse to boot rather
   than serve wrong data.
4. Apply **068**. Rollback is `ALTER TABLE <t> NO FORCE ROW LEVEL SECURITY;`,
   effective immediately, touching no data.

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

**Did not:** apply 068 or create the system role. Both are deployment actions on
a database I cannot see, and the second must come first. The reasons that made
this risky are now handled rather than merely documented:

- ~~Chat creation would break immediately.~~ Fixed by **067**, and the failure
  and the fix are both reproduced above.
- ~~Every unbound server query would return zero rows.~~ Those 18 queries now
  run on `db.SysPool`, which is the user pool until a system role exists.

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
