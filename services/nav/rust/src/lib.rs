//! nav-core — the per-GPS-fix route mathematics, in Rust.
//!
//! # What this is, and what it deliberately is not
//!
//! This is a line-for-line port of `lib/nav/routeProgress.ts`. **The TypeScript
//! remains the reference implementation and the shipping fallback**: if the
//! native library is missing, fails to load, or panics, `lib/nav/native/NavCore.ts`
//! quietly uses the TS path and navigation is unaffected. Nothing in the app
//! depends on this crate existing.
//!
//! # Why it exists at all, with the measurement
//!
//! The original `navigationService.onFix` did a full O(n) haversine scan of the
//! route shape on every fix. Measured (Node 24, synthetic Valhalla-density route):
//!
//! | vertices | full scan | windowed + prefix sums (TS) | speedup |
//! |----------|-----------|-----------------------------|---------|
//! | 500      | 0.0389 ms | 0.0034 ms                   | 11.5x   |
//! | 2000     | 0.1706 ms | 0.0029 ms                   | 58x     |
//! | 6000     | 0.4808 ms | 0.0029 ms                   | 167x    |
//!
//! **The large win is algorithmic and was captured in TypeScript.** This crate
//! removes what remains — the trigonometry itself — and its honest value is
//! microseconds per fix, not milliseconds. It is worth having because the route
//! geometry is cached HERE, so a fix crosses the bridge as ~80 bytes of scalars
//! instead of re-marshalling thousands of coordinates, and because one
//! implementation of the off-route hysteresis is better than two. See
//! `benches`-style timings printed by `cargo test --release -- --nocapture bench`.
//!
//! # The boundary rule
//!
//! ONE call per meaningful location update (`step`), never one call per number.
//! The route is uploaded once (`set_route`) and the filter/hysteresis state
//! lives on this side, so the per-fix payload never grows with route length.

// `deny`, not `forbid`: the maths below must stay free of unsafe, but the C ABI
// in `ffi` cannot be — CStr::from_ptr and CString::from_raw are inherently
// unsafe. `forbid` cannot be lifted per-module, so the lint is denied here and
// allowed ONLY on that module, which keeps the exception visible and narrow.
#![deny(unsafe_code)]

#[allow(unsafe_code)]
pub mod ffi;

// ── geodesy ───────────────────────────────────────────────────────────
//
// Identical formulas to lib/nav/geo.ts. They are duplicated rather than shared
// because there is no way to share them across the language boundary, and the
// parity test is what keeps them honest.

const EARTH_R: f64 = 6_371_000.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LatLng {
    pub lat: f64,
    pub lng: f64,
}

#[inline]
fn to_rad(d: f64) -> f64 {
    d * std::f64::consts::PI / 180.0
}

/// Great-circle distance in metres. Matches geo.ts `haversine` exactly,
/// including the `min(1, ...)` clamp before `asin`.
#[inline]
pub fn haversine(a: LatLng, b: LatLng) -> f64 {
    let d_lat = to_rad(b.lat - a.lat);
    let d_lng = to_rad(b.lng - a.lng);
    let la1 = to_rad(a.lat);
    let la2 = to_rad(b.lat);
    let h = (d_lat / 2.0).sin().powi(2) + la1.cos() * la2.cos() * (d_lng / 2.0).sin().powi(2);
    2.0 * EARTH_R * h.sqrt().min(1.0).asin()
}

// ── geometry ──────────────────────────────────────────────────────────

/// A route shape plus its prefix-sum distance table, built once per route.
pub struct RouteGeometry {
    pub shape: Vec<LatLng>,
    /// `cum[i]` = metres from shape[0] to shape[i].
    pub cum: Vec<f64>,
    pub length_m: f64,
}

impl RouteGeometry {
    pub fn build(shape: Vec<LatLng>) -> Self {
        let n = shape.len();
        let mut cum = vec![0.0; n];
        for i in 1..n {
            cum[i] = cum[i - 1] + haversine(shape[i - 1], shape[i]);
        }
        let length_m = if n > 0 { cum[n - 1] } else { 0.0 };
        RouteGeometry { shape, cum, length_m }
    }
}

/// Where a position sits on the route.
#[derive(Debug, Clone, Copy)]
pub struct Projection {
    pub index: usize,
    pub snapped: LatLng,
    pub cross_track_m: f64,
    pub along_m: f64,
    pub rescanned: bool,
}

/// Local planar projection of `p` onto segment a→b, clamped to the segment.
///
/// Equirectangular with a cos(lat) scale. Over one route segment (tens of
/// metres) the error is far under a centimetre, and unlike a great-circle
/// cross-track this yields the CLAMPED foot of the perpendicular — which is
/// what "how far along this segment am I" needs.
#[inline]
fn project_on_segment(p: LatLng, a: LatLng, b: LatLng) -> (f64, LatLng) {
    let kx = to_rad(a.lat).cos();
    let (ax, ay) = (a.lng * kx, a.lat);
    let (bx, by) = (b.lng * kx, b.lat);
    let (px, py) = (p.lng * kx, p.lat);
    let (dx, dy) = (bx - ax, by - ay);
    let len2 = dx * dx + dy * dy;
    // Valhalla does emit duplicate vertices; project to the start rather than
    // dividing by zero.
    if len2 == 0.0 {
        return (0.0, a);
    }
    let t = (((px - ax) * dx + (py - ay) * dy) / len2).clamp(0.0, 1.0);
    (t, LatLng { lat: ay + t * dy, lng: (ax + t * dx) / kx })
}

pub const SEARCH_WINDOW: usize = 60;
pub const SEARCH_BACK: usize = 10;
/// See routeProgress.ts: this guard is load-bearing after any teleport
/// (reroute, resume from sleep, first fix far from the start).
pub const RESCAN_THRESHOLD_M: f64 = 200.0;

pub fn project(geom: &RouteGeometry, p: LatLng, prev_index: usize, window: usize) -> Projection {
    let n = geom.shape.len();
    if n == 0 {
        return Projection { index: 0, snapped: p, cross_track_m: 0.0, along_m: 0.0, rescanned: false };
    }
    if n == 1 {
        return Projection {
            index: 0,
            snapped: geom.shape[0],
            cross_track_m: haversine(p, geom.shape[0]),
            along_m: 0.0,
            rescanned: false,
        };
    }

    let scan = |lo: usize, hi: usize| -> (usize, f64, f64, LatLng) {
        let mut best_i = lo;
        let mut best_d = f64::INFINITY;
        let mut best_t = 0.0;
        let mut best_pt = geom.shape[lo];
        for i in lo..hi {
            let (t, point) = project_on_segment(p, geom.shape[i], geom.shape[i + 1]);
            let d = haversine(p, point);
            if d < best_d {
                best_d = d;
                best_i = i;
                best_t = t;
                best_pt = point;
            }
        }
        (best_i, best_d, best_t, best_pt)
    };

    let lo = prev_index.saturating_sub(SEARCH_BACK).min(n - 2);
    // Saturating for the same reason `lo` is: `prev_index` is whatever the
    // caller's JSON said (ffi.rs `u()` accepts any u64), and this crate builds
    // with overflow-checks on, so a near-`usize::MAX` index turned a plain `+`
    // into a panic. Every value that does not overflow lands exactly where it
    // did before, and one that does is clamped to the end of the route, where
    // the `bd > RESCAN_THRESHOLD_M` rescan below already recovers it.
    let hi = prev_index.saturating_add(window).min(n - 1).max(lo + 1);
    let (mut bi, mut bd, mut bt, mut bp) = scan(lo, hi);
    let mut rescanned = false;
    if bd > RESCAN_THRESHOLD_M && (lo > 0 || hi < n - 1) {
        rescanned = true;
        let r = scan(0, n - 1);
        bi = r.0;
        bd = r.1;
        bt = r.2;
        bp = r.3;
    }

    let seg_len = geom.cum[bi + 1] - geom.cum[bi];
    Projection {
        index: bi,
        snapped: bp,
        cross_track_m: bd,
        along_m: geom.cum[bi] + seg_len * bt,
        rescanned,
    }
}

pub fn distance_to_index(geom: &RouteGeometry, along_m: f64, to_index: usize) -> f64 {
    let i = to_index.min(geom.cum.len().saturating_sub(1));
    (geom.cum[i] - along_m).max(0.0)
}

pub fn remaining_distance(geom: &RouteGeometry, along_m: f64) -> f64 {
    (geom.length_m - along_m).max(0.0)
}

// ── GPS smoothing ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
pub struct SmoothState {
    pub lat: f64,
    pub lng: f64,
    /// Scalar variance, m². Infinity = no estimate yet.
    pub variance: f64,
    pub ts_ms: f64,
}

impl Default for SmoothState {
    fn default() -> Self {
        SmoothState { lat: 0.0, lng: 0.0, variance: f64::INFINITY, ts_ms: 0.0 }
    }
}

/// Accuracy-weighted scalar Kalman filter — see routeProgress.ts for why this
/// is not a moving average (a moving average lags as much on good fixes as bad).
pub fn smooth_fix(s: SmoothState, lat: f64, lng: f64, accuracy_m: f64, speed_mps: f64, ts_ms: f64) -> SmoothState {
    let acc = accuracy_m.max(1.0);
    let meas_var = acc * acc;
    if !s.variance.is_finite() {
        return SmoothState { lat, lng, variance: meas_var, ts_ms };
    }
    let dt = ((ts_ms - s.ts_ms) / 1000.0).max(0.0);
    // The 1 m/s floor lets a stationary estimate still converge on a genuinely
    // new position instead of freezing solid. And q is NEVER less than the
    // observed jump: a large move with a still sensor (GPS re-acquisition) must
    // be adopted, not blended into a point on a road the phone was never on —
    // see the matching note in routeProgress.ts.
    let jump_m = haversine(LatLng { lat: s.lat, lng: s.lng }, LatLng { lat, lng });
    let q = (speed_mps.max(1.0) * dt).max(jump_m);
    let pred_var = s.variance + q * q;
    let k = pred_var / (pred_var + meas_var);
    SmoothState {
        lat: s.lat + k * (lat - s.lat),
        lng: s.lng + k * (lng - s.lng),
        variance: (1.0 - k) * pred_var,
        ts_ms,
    }
}

// ── off-route decision ────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OffRouteVerdict {
    OnRoute,
    TemporarilyUncertain,
    OffRoute,
    RerouteRequired,
}

impl OffRouteVerdict {
    /// The wire spelling the TS side expects. Kept as an explicit match rather
    /// than a derive so a renamed variant cannot silently change the protocol.
    pub fn as_str(self) -> &'static str {
        match self {
            OffRouteVerdict::OnRoute => "on_route",
            OffRouteVerdict::TemporarilyUncertain => "temporarily_uncertain",
            OffRouteVerdict::OffRoute => "off_route",
            OffRouteVerdict::RerouteRequired => "reroute_required",
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct OffRouteState {
    pub strikes: u32,
    pub clears: u32,
    /// 0 = never rerouted. Tested explicitly, never by arithmetic — see the
    /// matching note in routeProgress.ts, where treating it arithmetically
    /// suppressed the very first reroute.
    pub last_reroute_ms: f64,
    pub reroute_issued: bool,
}

pub const STRIKES_TO_CONFIRM: u32 = 3;
pub const CLEARS_TO_FORGIVE: u32 = 2;
pub const REROUTE_COOLDOWN_MS: f64 = 15_000.0;

pub fn corridor_m(accuracy_m: f64, speed_mps: f64) -> f64 {
    let acc = accuracy_m.max(1.0);
    (3.0 * acc + 0.8 * speed_mps.max(0.0)).max(25.0)
}

/// One bad GPS sample can never reroute. See routeProgress.ts for the rules.
pub fn evaluate_off_route(
    s: OffRouteState,
    cross_track_m: f64,
    accuracy_m: f64,
    speed_mps: f64,
    now_ms: f64,
) -> (OffRouteState, OffRouteVerdict) {
    let inside = cross_track_m <= corridor_m(accuracy_m, speed_mps);

    if inside {
        let clears = s.clears + 1;
        if clears >= CLEARS_TO_FORGIVE {
            return (
                OffRouteState { strikes: 0, clears: 0, reroute_issued: false, ..s },
                OffRouteVerdict::OnRoute,
            );
        }
        let verdict = if s.strikes >= STRIKES_TO_CONFIRM {
            OffRouteVerdict::OffRoute
        } else if s.strikes > 0 {
            OffRouteVerdict::TemporarilyUncertain
        } else {
            OffRouteVerdict::OnRoute
        };
        return (OffRouteState { clears, ..s }, verdict);
    }

    let strikes = s.strikes + 1;
    let next = OffRouteState { strikes, clears: 0, ..s };
    if strikes < STRIKES_TO_CONFIRM {
        return (next, OffRouteVerdict::TemporarilyUncertain);
    }
    let cooled_down = s.last_reroute_ms == 0.0 || now_ms - s.last_reroute_ms >= REROUTE_COOLDOWN_MS;
    if !s.reroute_issued && cooled_down {
        return (
            OffRouteState { reroute_issued: true, last_reroute_ms: now_ms, ..next },
            OffRouteVerdict::RerouteRequired,
        );
    }
    (next, OffRouteVerdict::OffRoute)
}

// ── arrival ───────────────────────────────────────────────────────────

pub const ARRIVAL_RADIUS_M: f64 = 35.0;
pub const ARRIVAL_MAX_SPEED_MPS: f64 = 3.5;

/// Both proximity AND a slowdown: passing the destination at speed on a
/// parallel road is not arriving, and saying so ends the session mid-drive.
pub fn check_arrival(remaining_m: f64, speed_mps: f64) -> bool {
    remaining_m <= ARRIVAL_RADIUS_M && speed_mps <= ARRIVAL_MAX_SPEED_MPS
}

// ── the one coarse-grained pass ───────────────────────────────────────

#[derive(Debug, Clone, Copy)]
pub struct NavStepInput {
    pub lat: f64,
    pub lng: f64,
    pub accuracy_m: f64,
    pub speed_mps: f64,
    pub heading_deg: f64,
    pub ts_ms: f64,
    pub prev_index: usize,
    pub maneuver_begin_index: usize,
}

#[derive(Debug, Clone, Copy)]
pub struct NavStepOutput {
    pub index: usize,
    pub snapped_lat: f64,
    pub snapped_lng: f64,
    pub cross_track_m: f64,
    pub along_m: f64,
    pub dist_to_maneuver_m: f64,
    pub remaining_m: f64,
    pub progress: f64,
    pub verdict: OffRouteVerdict,
    pub arrived: bool,
    pub rescanned: bool,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct NavStepState {
    pub smooth: SmoothState,
    pub off_route: OffRouteState,
}

/// Everything one GPS fix needs, in a single call — the shape that makes the
/// FFI hop worth paying for at all.
pub fn nav_step(geom: &RouteGeometry, input: NavStepInput, state: NavStepState) -> (NavStepOutput, NavStepState) {
    let smooth = smooth_fix(state.smooth, input.lat, input.lng, input.accuracy_m, input.speed_mps, input.ts_ms);
    let pos = LatLng { lat: smooth.lat, lng: smooth.lng };

    let proj = project(geom, pos, input.prev_index, SEARCH_WINDOW);
    let remaining_m = remaining_distance(geom, proj.along_m);
    let dist_to_maneuver_m = distance_to_index(geom, proj.along_m, input.maneuver_begin_index);

    let (off_state, verdict) =
        evaluate_off_route(state.off_route, proj.cross_track_m, input.accuracy_m, input.speed_mps, input.ts_ms);

    (
        NavStepOutput {
            index: proj.index,
            snapped_lat: proj.snapped.lat,
            snapped_lng: proj.snapped.lng,
            cross_track_m: proj.cross_track_m,
            along_m: proj.along_m,
            dist_to_maneuver_m,
            remaining_m,
            progress: if geom.length_m > 0.0 { (proj.along_m / geom.length_m).clamp(0.0, 1.0) } else { 0.0 },
            verdict,
            arrived: check_arrival(remaining_m, input.speed_mps),
            rescanned: proj.rescanned,
        },
        NavStepState { smooth, off_route: off_state },
    )
}

/// The same deterministic fixture routeProgress.ts builds, from the same
/// formula — so parity can be checked without a fixture file that could drift.
pub fn synthetic_route(n: usize) -> Vec<LatLng> {
    let mut out = Vec::with_capacity(n);
    let mut lat = 12.9716_f64;
    let mut lng = 77.5946_f64;
    for i in 0..n {
        lat += 0.000045 + (i as f64 / 40.0).sin() * 0.000012;
        lng += 0.000038 + (i as f64 / 55.0).cos() * 0.000015;
        out.push(LatLng { lat, lng });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geom400() -> RouteGeometry {
        RouteGeometry::build(synthetic_route(400))
    }

    #[test]
    fn cumulative_table_equals_the_naive_walk() {
        let g = geom400();
        let mut walked = 0.0;
        for i in 1..g.shape.len() {
            walked += haversine(g.shape[i - 1], g.shape[i]);
        }
        assert!((g.length_m - walked).abs() < 1e-6);
    }

    #[test]
    fn a_point_on_a_vertex_projects_to_that_vertex() {
        let g = geom400();
        let p = project(&g, g.shape[100], 0, SEARCH_WINDOW);
        assert!(p.cross_track_m < 0.5, "cross track {}", p.cross_track_m);
        assert!((p.along_m - g.cum[100]).abs() < 1.0);
    }

    #[test]
    fn windowed_search_matches_a_full_scan() {
        let g = geom400();
        for idx in [5usize, 50, 199, 398] {
            let p = g.shape[idx];
            let w = project(&g, p, idx.saturating_sub(5), SEARCH_WINDOW);
            let f = project(&g, p, 0, g.shape.len());
            assert_eq!(w.index, f.index, "at {idx}");
            assert!((w.along_m - f.along_m).abs() < 0.01, "at {idx}");
        }
    }

    /// The guard that stops a stale index locking onto the wrong part of the
    /// route after a reroute or a resume.
    #[test]
    fn a_stale_index_triggers_a_rescan() {
        let g = geom400();
        let far = project(&g, g.shape[10], 350, SEARCH_WINDOW);
        assert!(far.rescanned);
        assert!((far.index as i64 - 10).abs() <= 1, "landed at {}", far.index);
    }

    #[test]
    fn along_plus_remaining_equals_total() {
        let g = geom400();
        for idx in [0usize, 77, 200, 399] {
            let p = project(&g, g.shape[idx], idx.saturating_sub(3), SEARCH_WINDOW);
            assert!((p.along_m + remaining_distance(&g, p.along_m) - g.length_m).abs() < 0.01);
        }
    }

    #[test]
    fn a_passed_maneuver_is_never_negative() {
        let g = geom400();
        let p = project(&g, g.shape[200], 197, SEARCH_WINDOW);
        assert_eq!(distance_to_index(&g, p.along_m, 100), 0.0);
    }

    #[test]
    fn an_accurate_fix_pulls_further_than_a_vague_one() {
        let s0 = smooth_fix(SmoothState::default(), 12.9, 77.5, 5.0, 0.0, 1000.0);
        assert_eq!(s0.lat, 12.9);
        let tight = smooth_fix(s0, 12.91, 77.5, 3.0, 10.0, 2000.0);
        let loose = smooth_fix(s0, 12.91, 77.5, 60.0, 10.0, 2000.0);
        assert!(tight.lat > loose.lat);
        assert!(loose.lat >= s0.lat && loose.lat <= 12.91);
    }

    #[test]
    fn a_large_jump_with_a_still_sensor_is_adopted_not_blended() {
        let before = smooth_fix(SmoothState::default(), 12.9000, 77.5000, 5.0, 0.0, 1000.0);
        let jumped = smooth_fix(before, 12.9045, 77.5000, 10.0, 0.06, 9000.0);
        assert!((jumped.lat - 12.9045).abs() < 0.00005, "got {}", jumped.lat);
        let jit = smooth_fix(before, 12.90005, 77.5000, 10.0, 0.0, 2000.0);
        assert!(jit.lat > 12.9000 && jit.lat < 12.90005, "jitter must still be damped");
    }

    #[test]
    fn one_bad_sample_can_never_reroute() {
        let mut st = OffRouteState::default();
        let (s1, v1) = evaluate_off_route(st, 500.0, 8.0, 10.0, 1000.0);
        assert_eq!(v1, OffRouteVerdict::TemporarilyUncertain);
        st = s1;
        let (s2, v2) = evaluate_off_route(st, 500.0, 8.0, 10.0, 2000.0);
        assert_eq!(v2, OffRouteVerdict::TemporarilyUncertain);
        st = s2;
        let (s3, v3) = evaluate_off_route(st, 500.0, 8.0, 10.0, 3000.0);
        assert_eq!(v3, OffRouteVerdict::RerouteRequired);
        // …and not twice for the same excursion
        let (_, v4) = evaluate_off_route(s3, 500.0, 8.0, 10.0, 4000.0);
        assert_eq!(v4, OffRouteVerdict::OffRoute);
    }

    #[test]
    fn returning_to_the_route_takes_two_clean_fixes() {
        let mut st = OffRouteState { strikes: 3, clears: 0, last_reroute_ms: 3000.0, reroute_issued: true };
        let (s1, v1) = evaluate_off_route(st, 5.0, 8.0, 10.0, 5000.0);
        assert_eq!(v1, OffRouteVerdict::OffRoute);
        st = s1;
        let (s2, v2) = evaluate_off_route(st, 5.0, 8.0, 10.0, 6000.0);
        assert_eq!(v2, OffRouteVerdict::OnRoute);
        assert_eq!(s2.strikes, 0);
        assert!(!s2.reroute_issued);
    }

    #[test]
    fn the_cooldown_gates_a_second_excursion() {
        let base = OffRouteState { strikes: 2, clears: 0, last_reroute_ms: 6000.0, reroute_issued: false };
        let (_, soon) = evaluate_off_route(base, 500.0, 8.0, 10.0, 9000.0);
        assert_eq!(soon, OffRouteVerdict::OffRoute);
        let (_, later) = evaluate_off_route(base, 500.0, 8.0, 10.0, 6000.0 + REROUTE_COOLDOWN_MS + 1.0);
        assert_eq!(later, OffRouteVerdict::RerouteRequired);
        // A never-rerouted state must not be gated at all.
        let fresh = OffRouteState { strikes: 2, ..Default::default() };
        let (_, first) = evaluate_off_route(fresh, 500.0, 8.0, 10.0, 3000.0);
        assert_eq!(first, OffRouteVerdict::RerouteRequired);
    }

    #[test]
    fn a_vague_fix_widens_the_corridor() {
        assert!(corridor_m(60.0, 0.0) > 150.0);
        let (_, v) = evaluate_off_route(OffRouteState::default(), 100.0, 60.0, 0.0, 1000.0);
        assert_eq!(v, OffRouteVerdict::OnRoute);
    }

    #[test]
    fn arrival_needs_proximity_and_a_slowdown() {
        assert!(check_arrival(20.0, 1.0));
        assert!(!check_arrival(20.0, 25.0));
        assert!(!check_arrival(300.0, 0.0));
    }

    #[test]
    fn progress_never_goes_backwards_along_the_route() {
        let g = geom400();
        let mut prev_along = -1.0;
        let mut idx = 0usize;
        let mut i = 0usize;
        while i < g.shape.len() {
            let p = project(&g, g.shape[i], idx, SEARCH_WINDOW);
            idx = p.index;
            assert!(p.along_m >= prev_along - 0.01, "went backwards at {i}");
            prev_along = p.along_m;
            i += 7;
        }
    }
}
