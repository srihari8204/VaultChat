# Design — CC-Wire codec benchmark

## Context

`docs/PERF_BASELINE.md` is a careful document with empty tables. Its own rule —
*"Fill a row only from a `result.json`, and only together with its environment
block"* — is why it stayed empty rather than being filled with guesses, and that
discipline is worth keeping. This change does not write into it. It produces the
one measurement that needs no infrastructure, so the rest of the document keeps
its standard.

## Goals / Non-Goals

**Goals:**
- A repeatable codec baseline, runnable by anyone with the repo and Go.
- Rejection cost measured next to acceptance cost.
- Allocation reported, not just time.

**Non-Goals:**
- Connection, concurrency, end-to-end or multi-node numbers. They need
  infrastructure that is not available here, and reporting a codec figure as a
  throughput figure would be worse than reporting nothing.
- Filling in `PERF_BASELINE.md`. That document wants a full environment block
  and a `result.json`; satisfying it is separate work.
- Any Rust benchmark. Stdlib `#[bench]` needs nightly and `criterion` is a new
  dependency — neither is justified before the Go side has shown the shape.

## Decisions

**Four traffic shapes, not one.** A codec benchmarked only on its happy path
reports the speed of the path nobody takes. Ephemeral typing dominates frame
COUNT; a 4 KiB message dominates BYTES; control ping is rare but strict-priority
and therefore latency-critical. Each stresses a different part of the codec.

**`-benchmem` is mandatory, not optional.** At 100k connections the question is
not how fast one frame decodes, it is how much garbage a million frames make.

**Rejection is a first-class benchmark.** This is the unusual decision and the
one worth defending: an attacker picks which branch runs. Measuring only the
happy path means the expensive branch is the unmeasured one.

**Nothing is written into PERF_BASELINE.md.** That file's contract demands an
environment block and a `result.json`; a partial entry would erode a standard
the repository has so far kept.

## Risks / Trade-offs

- **A codec number is easy to misquote as a throughput number.** Mitigated by
  saying so in the file header, the proposal and here — three places, because
  this is the misreading that would actually cause harm.
- **Single-machine, single-CPU results.** An i7-10610U at 1.80 GHz is not the
  production gateway. The numbers are a BASELINE for relative comparison on the
  same machine, not an absolute capacity claim.
- **Benchmarks rot.** They are not in the default gate, so nothing forces them
  to keep compiling. Accepted: putting them in the gate would slow every run for
  a number nobody reads on every commit.
