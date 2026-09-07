//! JS ↔ Rust parity.
//!
//! `lib/nav/routeProgress.ts` is the reference implementation and the shipping
//! fallback. This test replays the vectors that file emits and asserts the Rust
//! port answers identically, so a divergence is caught HERE rather than as a
//! distance that quietly differs depending on whether the native library
//! happened to load on a given device — which would be almost impossible to
//! reproduce and is exactly the failure mode a dual implementation invites.
//!
//! Regenerate after any change to either implementation:
//!
//! ```text
//! npx tsx lib/nav/routeProgress.ts --vectors > services/nav/__vectors__/routeProgress.json
//! ```
//!
//! Tolerances are tight on purpose. Both sides do the same f64 operations in
//! the same order, so the only legitimate difference is the last bit or two of
//! floating point; anything larger is an algorithmic divergence, not noise.

use nav_core::{project, remaining_distance, synthetic_route, RouteGeometry, SEARCH_WINDOW};
use serde_json::Value;

/// Sub-millimetre. If this ever needs loosening, the two implementations have
/// genuinely diverged and the fix is in the code, not in the tolerance.
const TOL_M: f64 = 0.001;

fn vectors() -> Option<Value> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../__vectors__/routeProgress.json");
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

#[test]
fn rust_matches_the_typescript_reference() {
    let Some(v) = vectors() else {
        panic!(
            "services/nav/__vectors__/routeProgress.json is missing or unreadable.\n\
             Regenerate: npx tsx lib/nav/routeProgress.ts --vectors > services/nav/__vectors__/routeProgress.json"
        );
    };

    // The fixture is built from the SAME formula on both sides (synthetic_route
    // / syntheticRoute), so the shape itself is part of what is being proven.
    let geom = RouteGeometry::build(synthetic_route(400));

    let expected_len = v["lengthM"].as_f64().expect("lengthM");
    assert!(
        (geom.length_m - expected_len).abs() < TOL_M,
        "route length diverged: rust {} vs ts {}",
        geom.length_m,
        expected_len
    );

    let samples = v["samples"].as_array().expect("samples");
    assert!(!samples.is_empty(), "vector file has no samples");

    let mut prev_index = 0usize;
    for s in samples {
        let i = s["i"].as_u64().unwrap();
        let lat = s["lat"].as_f64().unwrap();
        let lng = s["lng"].as_f64().unwrap();

        let p = project(&geom, nav_core::LatLng { lat, lng }, prev_index, SEARCH_WINDOW);
        prev_index = p.index;

        assert_eq!(
            p.index as u64,
            s["index"].as_u64().unwrap(),
            "index diverged at sample i={i}"
        );
        assert!(
            (p.along_m - s["alongM"].as_f64().unwrap()).abs() < TOL_M,
            "alongM diverged at i={i}: rust {} vs ts {}",
            p.along_m,
            s["alongM"].as_f64().unwrap()
        );
        assert!(
            (p.cross_track_m - s["crossTrackM"].as_f64().unwrap()).abs() < TOL_M,
            "crossTrackM diverged at i={i}: rust {} vs ts {}",
            p.cross_track_m,
            s["crossTrackM"].as_f64().unwrap()
        );
        assert!(
            (remaining_distance(&geom, p.along_m) - s["remainingM"].as_f64().unwrap()).abs() < TOL_M,
            "remainingM diverged at i={i}"
        );
    }

    println!("parity: {} samples matched within {TOL_M} m", samples.len());
}
