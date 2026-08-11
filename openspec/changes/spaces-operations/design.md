## Context

This change sits directly on `groups-circles`, which is largely built. Before
designing anything new, here is what is already in the repo and must be reused
rather than reinvented:

- **Typed groups + data-driven permissions** — `migrations/070_groups_circles.sql`:
  `chats.group_type`, `group_type_config` (label, icons, caps,
  `default_permissions` JSONB per role), `chats.permission_overrides`,
  `chat_members.permission_grants`, `group_audit_log`, and a cap trigger that
  serialises on the chat row with `FOR NO KEY UPDATE`.
- **The permission resolver** — `vaultchat-backend-go/internal/groups/groups.go`:
  pure, no DB, ten permissions, five ranks (`guest|member|moderator|admin|owner`
  after `073_membership_v2.sql`), rank-aware role management, and a
  `mirrorcheck` package that proves the Go and TypeScript permission tables
  cannot drift. One enforcement point: `chatsRequirePerm`.
- **Membership v2** — `073`/`074`: in-app-only invitations, three approval
  modes, an invitation inbox, ownership transfer behind its own door, removal
  cooldowns, rank-gated removal.
- **Location** — sealed pings. Nothing writes a plaintext coordinate to the
  server. Approximate sharing is grid-snapped *before* sealing. Live group
  location and `trip_update` are relayed by both socket servers behind the same
  membership check.
- **Safe zones, entry/exit alerts, attendance analytics** — shipped in G3/G6,
  per group, computed on device.
- **Group trips** — `lib/groups/trips.ts`, `tripSession.ts`, follow-the-leader,
  ETA fan-out, deviation and arrival alerts, an active-trip dashboard card.
- **Announcements** — permission-gated on the server, pinned, surfaced on the
  dashboard. Broadcast sessions exist separately (`079`–`082`) for live video
  broadcast; that is a different feature and is not what "school announcement"
  means here.
- **Album, tasks, calendar, notes** — per group, encrypted.
- **Map** — bundled-Leaflet WebView with client-side grid clustering.

So the honest scope of Spaces & Operations is: **a role catalog (data), one
visibility edge table, one run engine, one attendance projection, and three
dashboard renderers.** Everything else in the request already exists or is a
non-goal.

## Goals / Non-Goals

**Goals:** a space type that means something operationally; ops roles that need
no migration to add; hard server-side scoping so a parent sees one child; a run
engine that serves school buses, office cabs and any scheduled multi-stop trip;
attendance from geofences; targeted broadcast; incident reporting; run replay.

**Non-Goals (v1):** AI prediction of any kind; multi-campus and multi-company
hierarchies; white-label, SSO, public API, exportable reports; vehicle
telematics; N-way calling; a web admin console.

## Decisions

### The load-bearing one: no plaintext location, for anybody

The request asks for an admin dashboard showing every bus on a map with live
speed, plus server-detected overspeed, route-deviation, long-stop and
GPS-offline alerts. The straightforward build is a `vehicle_positions` table the
driver app POSTs to and the admin app reads. **We are not building that**, and
the reason is not squeamishness: the sealed-ping invariant is the product. A
plaintext position table for school children — the most sensitive location data
imaginable — would be the single highest-value target in the system and would
make every other E2EE claim in VaultChat a marketing line.

Instead:

- A run's live position **is** the driver's normal sealed live-location ping,
  scoped to the space, carrying a `runId`. The admin map subscribes as a member
  with `view_space_ops`; the parent map subscribes with a filter to the run
  their child is on. Both read the same sealed stream through the same
  membership check the socket relay already performs.
- **Detection runs on the emitting device.** The driver's app knows its own
  speed, its own route (the run's stop sequence, resolved through the existing
  Valhalla client), and its own stationary time. Overspeed, deviation and
  long-stop are computed there and emitted as sealed alerts on the existing
  alert path — the same place off-route detection already lives (G5.5).
- **GPS-offline is the one detection the server can do**, because it is the
  *absence* of a ping, which requires no plaintext. A run with no ping for N
  seconds raises a server-side staleness alert. This is deliberate: it is
  exactly the case a device-side detector cannot report, because the device is
  the thing that is gone.

Consequence to accept openly: a malicious driver running a patched client can
suppress their own overspeed alert. The mitigation is the ping gap and the
run's own timestamped stop events — both server-visible — not a plaintext
position feed. A school that needs tamper-proof telematics needs a tachograph,
not a chat app.

### Display roles are data; ranks stay code

`groups.Resolve` resolves five ranks. It does not learn about principals.
`group_type_config` gains:

```jsonc
role_catalog: [
  { "key": "principal",         "label": "Principal",         "rank": "owner"     },
  { "key": "school_admin",      "label": "School Admin",      "rank": "admin"     },
  { "key": "transport_manager", "label": "Transport Manager", "rank": "admin",
    "permissions": ["manage_runs", "view_space_ops", "manage_roster"] },
  { "key": "route_supervisor",  "label": "Route Supervisor",  "rank": "moderator" },
  { "key": "driver",            "label": "Bus Driver",        "rank": "member",
    "permissions": ["drive_run", "report_incident"] },
  { "key": "teacher",           "label": "Teacher",           "rank": "member"    },
  { "key": "parent",            "label": "Parent",            "rank": "member"    },
  { "key": "student",           "label": "Student",           "rank": "guest"     }
]
```

`chat_members` gains a nullable `role_key`. Resolution order becomes: type
default (by rank) → **role_catalog permissions (by role_key)** → group override
→ member grant. That is one extra layer in an existing pure function, not a new
model. `role_key` is display and permission sugar; **rank remains the only thing
that gates rank**, so M.7 holds without modification: a Transport Manager
(`admin`) cannot remove a Principal (`owner`).

Two details the sketch above glosses, settled during S0:

- **The catalog's permission list REPLACES the rank default, it does not add to
  it** — matching every other layer, and for the same reason merge semantics
  were rejected in 070: you cannot revoke through a merge. This is what lets a
  Driver (rank `member`) hold `drive_run` *without* inheriting the member
  default `start_navigation`. A driver re-routing the bus is not a feature. An
  entry with no permission list inherits its rank's default; an entry with an
  empty list holds nothing, which is exactly a Parent — their access comes from
  `space_links`, never from a permission.
- **The catalog layer applies only when the entry's rank matches the member's
  actual rank.** `role_key` lives on `chat_members` independently of `role`, so
  a stale or tampered key naming a higher-ranked entry would otherwise hand that
  member the entry's permissions. Mismatch falls through to the rank default.

Rejected: a `space_roles` table with its own permission rows. It would fork the
resolver, break `mirrorcheck`, and require a migration to add a job title.

### One edge table for all scoped visibility

```sql
space_roster(id, chat_id, user_id NULL, display_name, kind, external_ref, archived_at)
space_links (chat_id, subject_id, object_id, relation, created_at)
-- both ends are space_roster ids; relation ∈ ('guardian_of','supervises','teaches')
```

**The roster was not in the original sketch and is unavoidable.** A six-year-old
has no VaultChat account, so an edge table keyed on `users` cannot express a
school roster at all. Making both ends roster entries also removes the
polymorphism a users-or-roster edge would have needed: staff and parents get
roster entries carrying their `user_id`, children get entries with none, and one
edge shape covers every case.

**What is scoped, and what deliberately is not.** The rule covers the ops roster
and rider records — the things that say where a named child physically is. It
does NOT cover `chat_members`. Being in a chat together is mutual disclosure by
definition; hiding members would break message attribution, mentions and read
receipts, and would fight the product everywhere for no privacy gain (the
parents were already in the group chat). The child never appears in
`chat_members` at all, so nothing leaks there.

**Enforced in both places — and in this deployment only the route half works.**
The intended design is RLS as the gate with routes as a second line. Verified
against production on 2026-08-11, that is not what happens: the API connects as
`DB_USER=vaultchat`, a Postgres **superuser**, and superusers bypass RLS
unconditionally — `FORCE ROW LEVEL SECURITY` forces policies onto the table
*owner*, not onto a superuser. Measured: a parent received 2 of 2 roster rows
through the app's role where the policy returns 1.

So every sensitive read carries the policy's predicate explicitly as well,
composed from the same `SECURITY DEFINER` functions the policies call. Two
callers of one rule, not two rules. The policies stay — they are correct, they
cost nothing, and they become the real gate the moment the API moves to a
non-superuser role (`scripts/enable-rls-force.sql`, never run). Until then the
SQL in the handlers is the only thing between a parent and every child in the
school, which is why it is commented as load-bearing rather than redundant.

The paragraph below describes the intended posture; read it with the above in
mind. The policy on `space_roster` is the gate;
the route checks are the weaker second line. This change adds several roster
readers, and a scoping rule living in each of them is one forgotten `WHERE`
clause away from disclosing every child in a school. With the policy in place,
a handler that forgets to scope returns *fewer* rows than it expected — a
missing row, not a disclosure. Two consequences worth knowing before editing:
the resolver must be `SECURITY DEFINER` (it is called from the policy on the
table it reads, so invoker rights recurse), and the ops-view bypass is a **rank**
check rather than a resolved `view_space_ops`, because resolving the real
permission in PL/pgSQL would be a second copy of the permission model that
`mirrorcheck` cannot see. That makes the policy a floor, with the route checking
the true permission on top — and it constrains the seed: no role below moderator
may hold `view_space_ops`, pinned by `TestNoSubModeratorHoldsOpsView`.

Every "who can see whom" requirement in the request reduces to this:

| Requirement | Rule |
|---|---|
| Parent sees only their child | `guardian_of(parent, child)` |
| Supervisor sees only their reports | `supervises(sup, employee)`, transitive |
| Manager sees their department | transitive closure of `supervises` |
| Driver sees only assigned riders | via `run_riders` on their assigned run, not via links |
| Admin sees everything | `view_space_ops` permission, no link required |

The transitive case (Owner → Super Admin → Manager → Supervisor → Employee) is a
recursive CTE bounded to a small depth. `ponytail:` bounded to depth 6 and no
materialised closure — a space is one org, not a graph database; add a closure
table only if a real customer's hierarchy makes the CTE show up in query timings.

This table is the enforcement point for the single most sensitive claim in the
change. It is checked **server-side on every rider and member read**. A
client-side filter over a full roster would leak every child in the school to
anyone with a proxy.

### One run engine

```
runs        (id, chat_id, kind, name, driver_id, vehicle_label, scheduled_at,
             status, started_at, completed_at)
run_stops   (run_id, seq, label, lat, lng, planned_at)      -- STOPS, not people
run_riders  (run_id, rider_id, stop_id, state, state_at, actor_id, note)
run_events  (run_id, seq, kind, ref_id, at, actor_id, detail)
```

- `kind ∈ ('school_pickup','school_drop','cab_pickup','cab_drop','generic')`.
  Configuration, not structure: the AM school route and the evening cab run are
  the same rows.
- `run_riders.state ∈ ('pending','boarded','dropped','absent','no_show','cancelled')`.
  The driver flow is state transitions on this one column.
- `run_events` is the append-only truth. Dashboards, notifications and replay
  are all folds over it. Nothing derived is stored.
- **Stop coordinates are plaintext and that is fine**: a bus stop is a fixed,
  published place, not a person's location. A rider's *home* pickup point is a
  stop too — so stop rows carry no rider identity, and the `run_riders` join is
  what binds a person to a place, behind the scoping rule above.

Rejected: `bus_routes` + `cab_trips` + `bus_students` + `cab_employees`. Four
tables, four sets of endpoints, four screens, one behaviour.

### Attendance is a projection, not an engine

Business check-in/out = an existing safe-zone entry/exit event, evaluated
against a shift window on the device that owns the event. Present / late /
left-early / missing are derived labels. No new geofence code, no server-side
evaluation (see the location decision above). The supervisor dashboard shows the
projection for exactly the people `supervises` resolves to.

Visitor passes are the one genuinely new row: a time-boxed `visitor_passes`
record with a host, a validity window and a redeem event. It reuses the
invitation machinery's shape but not its table — a visitor is not a member.

### Broadcast targeting

Announcements already exist and are already permission-gated server-side. This
adds an `audience`: `space` | `run:<id>` | `role:<key>` | `subtree:<roster_id>`.
The audience resolves through the same code path as `space_links`, so "message
this department" and "show me this department" cannot disagree — one resolver,
two callers. It rides in the message's existing `meta` JSONB rather than a new
column: `meta.announcement` already lives there and the server already reads it,
so a column would duplicate a field the message spine already carries.

**What an audience is not.** An announcement is an ordinary E2EE message in the
space's chat, so every member's device receives the ciphertext and can decrypt
it. Addressing one scopes **notification and display, not readability** — a
determined member of the same space can read a Bus 4 announcement out of their
own local store. Cryptographic targeting would need a sub-chat with its own
sender keys per audience, which is a much larger feature. What this delivers is
the operational behaviour people actually ask for — don't buzz the whole school
about one bus — and the spec says so plainly rather than implying a
confidentiality property that is not there.

Note: this is **not** `broadcast_sessions` (`079`–`082`), which is live video
broadcast. Same English word, different feature; the naming collision is
called out here so nobody wires an announcement into the egress path.

### Run replay

A fold over `run_events` (timestamped stop arrivals and rider transitions) plus
the viewing device's own decrypted location history for that window. Server
stores no path. An admin replaying a run they did not travel sees the stop/rider
timeline with times — which is what "review completed trips with timestamps"
actually asks for — and the road-level breadcrumb only if their device received
the sealed pings live.

## Risks / Trade-offs

- **Tamper-resistance of device-side detection.** Accepted above; the honest
  mitigation is server-visible ping gaps and stop timestamps.
- **Replay fidelity for admins who were offline.** An admin who never received
  the sealed pings gets the event timeline, not the breadcrumb. Alternative
  would be plaintext storage. Not taking it.
- **Role catalog as JSONB** means a typo in a `rank` value is a data bug, not a
  compile error. Mitigated by validating the catalog on write against
  `groups.IsValidRole` / `IsValidPermission`, which already exist.
- **Caps.** School spaces at 50 members cannot hold 400 students. The cap is
  already server-configurable per type; ops types get much higher caps, and the
  cap trigger's serialisation cost is one row lock per join, which is fine at
  join rates. `ponytail:` no sharding of a space; a single space is one campus.
- **`space_links` recursion depth.** Bounded at 6. A deeper org silently
  truncates — so the resolver returns a flag when it hits the bound rather than
  pretending it saw the whole subtree.

## Migration Plan

Migrations `084`–`087`, additive and idempotent in the house style:

1. `084_space_roles.sql` — `group_type_config.role_catalog` JSONB,
   `chat_members.role_key`, new permission keys seeded into existing type
   defaults, three new space types (`school_transport`, `office_transport`,
   `pet_care`) with catalogs and raised caps.
2. `085_space_links.sql` — the edge table, indexes both directions, and the
   recursive resolver as a SQL function so Go and Node share one implementation.
3. `086_runs.sql` — runs, stops, riders, events; rider-state CHECK; a partial
   unique index preventing two active runs for one driver.
4. `087_space_ops.sql` — incidents, visitor passes, announcement audience column.

Every existing space keeps working: `role_key` is nullable and resolves to the
rank's type default, which is today's behaviour exactly. No backfill required.

## Open Questions

- Should a student be a real user account (`guest` rank) or a roster record
  with no login? v1 assumes **roster record for young children, account for
  older students** — `run_riders.rider_id` therefore references a roster row,
  not `users`, with an optional user link. Flagged because it is expensive to
  reverse.
- Does a parent belong to the school space, or to a per-class sub-space? v1:
  the school space, scoped by `space_links`. Sub-spaces are the multi-campus
  non-goal in miniature.
