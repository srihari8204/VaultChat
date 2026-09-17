# Cold-start: measure first, correct the record, change only what evidence supports

## Why

Earlier cold-start conclusions in this workstream were asserted without proof, and
several are unsound as stated:

- `Protobuf submits / acks: 0 / 0` was read as "no protobuf traffic during cold start".
  That only holds if those counters cover every encoded AND decoded frame. Unverified.
- `db_ready +66ms` was quoted as if it bounded startup work. It marks one event; what
  has and has not happened at that point was never established.
- `first frame 859ms` was compared against a ~13.4s figure measured to a DIFFERENT
  endpoint (readiness, not first draw). Those two numbers are not comparable.
- "startup HTTP uses JSON" was reported; "JSON dominates startup" does not follow.
- A protobuf ENVELOPE was treated as proving the encoding of its nested payload.
- 237 suites passing was reported alongside an APK that was never rebuilt from the
  tree those tests ran against.

This change corrects the record and replaces assertion with evidence.

## What changes

Phase A (source): the real startup dependency graph with file:line citations, and a
per-layer format table - HTTP body, CC-Wire envelope, the payload NESTED inside it, and
local persistence - each proven from the implementation rather than a comment or schema.

Phase B (instrumentation): EXTEND `lib/perf.ts` and the existing perf-debug screen.
No second timing framework. Bounded, opt-in, numeric only. Counters added at the real
frame/codec boundaries where the existing ones are shown not to cover them.

Phase C (baseline): a release build from THIS tree, with recorded build identity, device,
ABI, network, dataset and lock state. Repeated launches, median and spread, not one best
run.

Phase D: fix only a delay the trace actually demonstrates, at the smallest responsible
code path, with a regression test.

## Non-goals

- No new database, no schema migration.
- No migration of HTTP to protobuf; no replacement of CC-Wire; no new transport.
- No unauthenticated socket, no weakened certificate verification, no shortened timeout
  that would penalise a legitimately slow connection.
- No reopening of the font, splash, ABI, signing or responsive-layout work.
- No dependency upgrades, no new profiling packages.

## Success

Every performance claim names its build, device and measurement boundary. Before/after
distinguishes improvement from noise. Anything not measured is labelled "not measured",
"not run" or "not verified" - including, where it applies, the whole of Phase C.

## Known state at proposal time

Branch `hetzner-deploy`, HEAD `0965e71`, working tree dirty (312 files - this session's
uncommitted work). The installed APK dates from 2026-09-18 00:02 and PREDATES most of
those changes, so it cannot be used as evidence for this tree. No device is currently
attached: device measurement is NOT RUN, not pending-and-assumed-fine.
