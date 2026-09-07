//! The measurement that decides whether this crate is worth shipping.
//!
//! `#[ignore]` so a normal `cargo test` stays fast; run it deliberately:
//!
//! ```text
//! cargo test --release -- --ignored --nocapture
//! ```
//!
//! Compare against the TypeScript numbers printed by the same workload in
//! `lib/nav/routeProgress.ts`'s header table. Release mode matters: a debug
//! build of this crate is several times slower than the JS it replaces, which
//! is itself a good reason never to quote a debug figure at anyone.

use nav_core::{
    nav_step, synthetic_route, NavStepInput, NavStepState, RouteGeometry,
};
use std::time::Instant;

fn bench_one(n: usize, fixes: usize) {
    let shape = synthetic_route(n);
    let geom = RouteGeometry::build(shape.clone());
    let mut state = NavStepState::default();

    let mk = |k: usize| {
        let i = (k * 7) % (n - 2);
        NavStepInput {
            lat: shape[i].lat + 0.00002,
            lng: shape[i].lng - 0.00002,
            accuracy_m: 5.0,
            speed_mps: 8.0,
            heading_deg: 45.0,
            ts_ms: 1000.0 + k as f64 * 1000.0,
            prev_index: 0, // worst case for the window: never seeded
            maneuver_begin_index: n - 1,
        }
    };

    // warm
    for k in 0..64 {
        let (_, s) = nav_step(&geom, mk(k), state);
        state = s;
    }

    let t0 = Instant::now();
    let mut sink = 0.0f64;
    for k in 0..fixes {
        let (out, s) = nav_step(&geom, mk(k), state);
        state = s;
        sink += out.remaining_m; // keep the optimiser honest
    }
    let per = t0.elapsed().as_secs_f64() * 1000.0 / fixes as f64;
    println!(
        "  {n:>5} vertices ({:>5.1} km)   {per:.5} ms/fix        [sink {:.0}]",
        geom.length_m / 1000.0,
        sink
    );
}

/// The realistic case: the window is seeded from the previous fix, which is how
/// the engine actually drives it.
fn bench_sequential(n: usize) {
    let shape = synthetic_route(n);
    let geom = RouteGeometry::build(shape.clone());
    let mut state = NavStepState::default();
    let mut prev = 0usize;

    let t0 = Instant::now();
    let mut sink = 0.0f64;
    let mut steps = 0usize;
    let mut i = 0usize;
    while i < n - 2 {
        let input = NavStepInput {
            lat: shape[i].lat + 0.00002,
            lng: shape[i].lng - 0.00002,
            accuracy_m: 5.0,
            speed_mps: 8.0,
            heading_deg: 45.0,
            ts_ms: 1000.0 + steps as f64 * 1000.0,
            prev_index: prev,
            maneuver_begin_index: n - 1,
        };
        let (out, s) = nav_step(&geom, input, state);
        state = s;
        prev = out.index;
        sink += out.remaining_m;
        steps += 1;
        i += 1;
    }
    let per = t0.elapsed().as_secs_f64() * 1000.0 / steps as f64;
    println!(
        "  {n:>5} vertices ({:>5.1} km)   {per:.5} ms/fix        [sink {:.0}]",
        geom.length_m / 1000.0,
        sink
    );
}

#[test]
#[ignore]
fn bench_nav_step() {
    println!("\nnav-core — full navStep (smoothing + projection + off-route + arrival)");
    println!("\n  cold window (prevIndex always 0 — the rescan-heavy worst case):");
    for n in [500usize, 2000, 6000] {
        bench_one(n, 2000);
    }
    println!("\n  sequential (prevIndex seeded from the last fix — how it really runs):");
    for n in [500usize, 2000, 6000] {
        bench_sequential(n);
    }
    println!();
}
