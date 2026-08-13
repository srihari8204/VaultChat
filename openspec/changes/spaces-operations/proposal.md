# Spaces & Operations

## Why

`groups-circles` already made the group a first-class typed object: twelve types,
a data-driven permission matrix, per-type caps, invitations, safe zones, alerts,
history, tasks, calendar, album, notes, announcements, group trips and
on-device analytics. What it did **not** do is make a type mean anything
operationally. Today a School group and a Friends group differ by an icon, a
colour and a default permission row. Nothing in the product knows what a bus is,
what a route is, who a child's parent is, or that a driver must see one manifest
and nothing else.

That gap is the whole opportunity. A school does not want a chat with a map. It
wants: *this bus, this route, these 40 children, picked up, at school, dropped,
and the parent of child #17 sees child #17 and no one else.* An office cab fleet
wants the identical thing with employees instead of children. An office wants
the same thing with a geofence instead of a vehicle. Three verticals, one
engine.

The lazy read of the request — build a School product, a Business product and a
Transport product — is three products to maintain. The correct read is that all
three are **a roster, a scoped visibility edge, and a run with checkpoints**,
sitting on machinery this repo already has. This change builds that engine once
and configures it three ways.

It also renames the module. "Family" is one type of space, not the frame.
Groups & Circles becomes **Spaces**.

## What Changes

- **Rename to Spaces.** Family becomes one space type among many. This is a
  labelling and navigation change, not a schema change: `chats.group_type` keeps
  its name, and the twelve seeded types stay. Three ops types are added —
  `school_transport`, `office_transport`, `pet_care` — alongside the existing
  `school`, `business` and `office`.
- **Ops roles become data, not code.** `group_type_config` gains a
  `role_catalog`: a per-type list of display roles (Principal, Transport
  Manager, Route Supervisor, Driver, Teacher, Parent, Student; HR Manager,
  Department Manager, Supervisor, Employee; Fleet Manager, Dispatcher,
  Cab Driver) each mapped onto one of the five existing ranks
  (`owner|admin|moderator|member|guest`) with a permission preset. No new role
  enum, no per-vertical permission code, no migration to add a role.
- **Scoped visibility via one edge table.** `space_links(space, subject,
  object, relation)` — parent→child, supervisor→employee, driver→run. One rule
  resolves "a parent sees their child and no other child" and "a supervisor sees
  their reports and no other department". This single table is what makes the
  School, Business and Transport privacy requirements the same feature.
- **Runs: one engine for buses, cabs and any scheduled trip.** `runs`,
  `run_stops`, `run_riders`, `run_events`. A run has a driver, a vehicle, an
  ordered stop list, a rider manifest and a lifecycle
  (`scheduled → started → completed|cancelled`). Riders move
  `pending → boarded → dropped | absent | no_show`. The school AM route, the
  school PM route and the office cab shuttle are the same rows with different
  configuration.
- **Driver screen is the manifest, and nothing else.** Next stop, rider, call
  parent/employee, mark boarded, mark absent, next. A driver's data scope is
  their assigned runs; the space dashboard, other routes and unrelated rider
  records are not fetched, not just not rendered.
- **Live tracking rides the existing sealed-ping path.** A run's live position
  is the driver's device sealing a location ping to the space, exactly as group
  trips do today. Speed, deviation, long-stop and GPS-offline detection are
  computed **on the driver's device** and emitted as sealed alerts. The server
  never stores a plaintext vehicle position. (See design.md — this is the
  load-bearing constraint of the whole change.)
- **Attendance is a safe zone plus a shift window.** Business check-in/out
  reuses the geofence entry/exit events that already fire per group; a shift
  window turns them into present/late/left-early. No second geofence engine.
- **Targeted broadcast.** Announcements gain an audience selector: whole space,
  one run, one role, or one link subtree (this department, this class). Reuses
  the existing announcement spine.
- **Incidents.** A driver reports a breakdown, accident or route issue with
  notes and photos; photos go to the existing space album, the record notifies
  the ops role.
- **Run replay.** Derived on-device from the run's own event stream plus the
  reporter's location history — no new server-side location storage.
- **Dashboards are derived counts.** School, transport, supervisor and fleet
  dashboards are aggregations over `runs`/`run_riders`/geofence events. Nothing
  new is persisted to render them.

## Decisions taken (defaults, pending override)

1. **No plaintext location on the server, including for admins.** The obvious
   implementation of "admin sees all buses on one map" is a server-side vehicle
   position table, and it would break the sealed-ping invariant the entire
   product rests on. The admin map is instead a space member subscribing to the
   space's sealed live-location topic — the same mechanism a parent uses. The
   cost is that server-side geofence/overspeed evaluation is impossible; the
   detection therefore runs on the emitting device, which is where the existing
   off-route detection already runs. This is a hard constraint, not a
   preference.
2. **One `runs` engine, not a `bus_routes` table and a `cab_trips` table.** The
   differences between a school bus and an office cab are configuration (rider
   type, whether a guardian is notified, whether a PIN is required), not
   structure.
3. **Display roles are data; ranks are code.** Adding "Route Supervisor" must
   never require a migration or a Go release. `groups.Resolve` is unchanged: it
   still resolves five ranks. The catalog maps a label to a rank plus a
   permission set.
4. **Rank still gates rank.** `M.7` (removal gated on rank, not just the
   permission) applies unchanged to ops roles — a Transport Manager mapped to
   `admin` cannot remove a Principal mapped to `owner`.
5. **Pickup PIN/QR is opt-in per space, defaulting off.** It is a real safety
   feature for young children and pure friction everywhere else.
6. **AI, multi-campus, white-label, SSO, API access and exportable reports are
   out of scope.** They are listed in the request as premium/AI tiers; none of
   them can be designed honestly before one real school is running on the base
   engine. Called out in Non-goals so they read as deferred, not forgotten.

## Non-goals

- AI delay prediction, route optimisation, occupancy forecasting, driver
  scoring. All of them need historical run data this change is what produces.
- Multi-campus / multi-company hierarchies above a single space.
- White-label branding, SSO, public API, exportable reports.
- Fuel, maintenance and vehicle telematics integration.
- Group calling — still blocked on SFU + TURN provisioning (`groups-circles` G7).
  Ops calls fall back to the existing 1:1 path, which is what a driver→parent
  call actually needs anyway.

## Capabilities

### New Capabilities
- `spaces-core`: the Spaces rename, per-type role catalogs, ops space types,
  and the `space_links` scoped-visibility rule.
- `space-runs`: runs, stops, rider manifests, the driver flow, the
  guardian/rider view, live run tracking and run replay.
- `space-attendance`: geofence check-in/out against shift windows, presence
  dashboards, visitor passes.
- `space-ops-comms`: audience-targeted broadcast, incident reports, and the ops
  safety alert set (SOS, overspeed, deviation, long stop, GPS offline).

### Modified Capabilities
- `groups-core`: "Group" becomes "Space" in the UI; the role model gains a
  display-role layer above the existing five ranks. The permission resolution
  order is unchanged.
- `group-navigation`: group trips gain a run-backed variant with a fixed stop
  sequence and a manifest, rather than a free-form shared destination.

## Impact

- **Client**: navigation rename to Spaces; a per-type dashboard renderer keyed
  off `group_type`; a driver run screen; a guardian/rider run card; an ops admin
  map reusing the existing clustered live map; incident and broadcast composers.
- **Backend**: migrations for `role_catalog`, `space_links`, `runs`,
  `run_stops`, `run_riders`, `run_events`, `space_incidents`, `visitor_passes`;
  endpoints for run lifecycle and rider state; new permission keys
  (`manage_runs`, `drive_run`, `view_space_ops`, `manage_roster`,
  `report_incident`) added to `groups.All` and mirrored in TypeScript — the
  existing `mirrorcheck` covers the drift.
- **Storage**: no new plaintext location storage. Run events store stop and
  rider state transitions with timestamps, not coordinates.
- **Security**: `space_links` is the enforcement point for the most sensitive
  claim in this change — a parent cannot read another child's record. It is
  checked server-side on every rider read, not filtered client-side.
- **Blocked**: nothing. Every phase below can ship without new infrastructure.
