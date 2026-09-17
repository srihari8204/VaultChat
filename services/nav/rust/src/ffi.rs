//! FFI boundary: a single C-ABI entrypoint + JSON dispatcher.
//!
//! Deliberately the SAME shape as `services/crypto/rust/src/ffi.rs`
//! (`vc_crypto_call` / `vc_crypto_free`), because that idiom already ships in
//! this app and a second, different native calling convention would be one more
//! thing to get wrong at 3am. The C++ Nitro wrapper is a near-copy of
//! `HybridCryptoCore.cpp` for the same reason.
//!
//! Response envelope: `{"ok":true,"result":...}` | `{"ok":false,"error":"..."}`.
//!
//! # The session lives on THIS side
//!
//! `setRoute` uploads the geometry once and builds the prefix-sum table here;
//! `step` then crosses the boundary carrying only scalars. That is the whole
//! reason the native hop pays for itself — a per-fix call that re-marshalled a
//! 6000-vertex shape would cost far more than the trigonometry it saves.
//!
//! One session, not a map of them: the app navigates to one destination at a
//! time. If that ever stops being true this becomes a HashMap keyed by route id
//! and nothing else changes.

use serde_json::{json, Value};
use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::sync::Mutex;

use crate::{
    nav_step, LatLng, NavStepInput, NavStepState, RouteGeometry,
};

struct Session {
    route_id: String,
    geom: RouteGeometry,
    state: NavStepState,
}

// A plain Mutex, not a lock-free structure: this is touched once per GPS fix
// (~1 Hz) from one thread. Anything cleverer would be complexity bought with
// nothing.
static SESSION: Mutex<Option<Session>> = Mutex::new(None);

/// Take the session lock, ignoring poison.
///
/// `op_step` holds this guard across the whole of `nav_step`, so ANY panic in
/// the maths unwinds with the guard held and poisons the mutex for the rest of
/// the process. With `.lock().unwrap()` that single caught panic was terminal:
/// every later `vc_nav_call` — step, setRoute, even clearRoute, which exists to
/// recover — panicked on the lock itself, so restarting navigation could not
/// clear it. `selfCheck` takes no lock, so the health probe kept answering "ok"
/// while nothing else worked.
///
/// Ignoring the poison is right rather than merely convenient: the data behind
/// it is a route and a filter state, not an invariant a half-finished write can
/// corrupt. A panicking step leaves `sess.state` exactly as the previous fix
/// left it, which is the same state a dropped fix would leave, and the next
/// `setRoute` overwrites the whole thing regardless.
fn session() -> std::sync::MutexGuard<'static, Option<Session>> {
    SESSION.lock().unwrap_or_else(|e| e.into_inner())
}

fn err(msg: impl Into<String>) -> Value {
    json!({ "ok": false, "error": msg.into() })
}
fn ok(result: Value) -> Value {
    json!({ "ok": true, "result": result })
}

fn f(args: &Value, key: &str) -> f64 {
    args.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}
fn u(args: &Value, key: &str) -> usize {
    args.get(key).and_then(Value::as_u64).unwrap_or(0) as usize
}

/// `setRoute {routeId, shape:[[lat,lng], …]}` — build the geometry once.
fn op_set_route(args: &Value) -> Value {
    let route_id = args.get("routeId").and_then(Value::as_str).unwrap_or("").to_string();
    let Some(raw) = args.get("shape").and_then(Value::as_array) else {
        return err("nav-core: shape[] required");
    };
    let mut shape = Vec::with_capacity(raw.len());
    for p in raw {
        let Some(pair) = p.as_array() else {
            return err("nav-core: each shape entry must be [lat,lng]");
        };
        if pair.len() < 2 {
            return err("nav-core: each shape entry must be [lat,lng]");
        }
        let (lat, lng) = (pair[0].as_f64().unwrap_or(f64::NAN), pair[1].as_f64().unwrap_or(f64::NAN));
        // A NaN coordinate would poison every distance downstream and surface
        // as a blank ETA rather than an error; refuse it at the door.
        if !lat.is_finite() || !lng.is_finite() {
            return err("nav-core: shape contains a non-finite coordinate");
        }
        shape.push(LatLng { lat, lng });
    }
    if shape.len() < 2 {
        return err("nav-core: a route needs at least 2 points");
    }
    let geom = RouteGeometry::build(shape);
    let length_m = geom.length_m;
    let points = geom.shape.len();
    let mut guard = session();
    *guard = Some(Session { route_id, geom, state: NavStepState::default() });
    ok(json!({ "points": points, "lengthM": length_m }))
}

/// A GPS millisecond epoch cannot exceed the largest integer JavaScript holds
/// exactly, because the only thing that produces one is `Date.now()` or a
/// platform fix timestamp on the other side of the bridge. (2^53 ms is roughly
/// the year 287396.)
const MAX_TS_MS: f64 = 9_007_199_254_740_991.0;
/// 10 km/s. Low-earth orbit is about 7.8; nothing this app navigates comes near
/// it, so the bound cannot reject a fix a phone actually produced.
const MAX_SPEED_MPS: f64 = 10_000.0;
/// 10 000 km — larger than the Earth's radius, so no accuracy radius any
/// location provider reports can be outside it.
const MAX_ACCURACY_M: f64 = 10_000_000.0;

/// Why this fix is not usable, or None.
///
/// lat/lng were checked for finiteness above and the rest of the telemetry was
/// not, which is a narrower door than it looks. `tsMs` is the one that matters:
/// it feeds `smooth_fix` unmediated, and a finite-but-absurd value such as 1e308
/// makes `dt` enormous, overflows `pred_var` to +inf, leaves `k = inf / inf`
/// NaN, and drives the smoothed position to NaN. Nothing panics and nothing
/// hangs — that is precisely the problem. Downstream, `json!` writes a NaN f64
/// as **null**, so the caller gets `snappedLat`/`snappedLng` of null inside an
/// `{"ok":true}` envelope; `project` reports index 0, because the NaN reaches
/// `haversine`'s `.min(1.0)` clamp where f64::min discards NaN in favour of the
/// other operand, turning every candidate segment into the same half-
/// circumference distance so the first one scanned wins; and that ~20 000 km
/// cross-track is far outside any corridor, so `evaluate_off_route` books a
/// strike against a driver who has not moved.
///
/// It self-heals on the following fix — a NaN variance is not finite, so the
/// filter resets — and that is what makes it dangerous rather than harmless: a
/// value that recurs alternates clean and poisoned fixes, and the strikes
/// accumulate to a demanded reroute. Refusing the fix costs one dropped sample,
/// and the TypeScript reference implementation answers it instead.
///
/// Each test bounds MAGNITUDE and deliberately not sign, because a negative
/// value here is already handled and is something a real caller sends: iOS
/// reports `accuracy: -1` for a fix it could not qualify, and both
/// implementations neutralise that identically with `max(1.0)` (and speed with
/// `max(0.0)` in `corridor_m`). Rejecting it would refuse a fix that works
/// today. An absurd MAGNITUDE is the thing neither implementation survives.
fn implausible_telemetry(i: &NavStepInput) -> Option<&'static str> {
    if !i.ts_ms.is_finite() || i.ts_ms.abs() > MAX_TS_MS {
        return Some("nav-core: tsMs is not a plausible timestamp");
    }
    if !i.accuracy_m.is_finite() || i.accuracy_m.abs() > MAX_ACCURACY_M {
        return Some("nav-core: accuracyM is not a plausible accuracy");
    }
    if !i.speed_mps.is_finite() || i.speed_mps.abs() > MAX_SPEED_MPS {
        return Some("nav-core: speedMps is not a plausible speed");
    }
    // headingDeg feeds nothing today, so this is the cheap half of the check:
    // it keeps a garbage bearing from becoming a live input the day something
    // starts reading it. Deliberately loose — a thousand full turns — because
    // every caller supplies either 0 or a 0..360 bearing from geo.ts and the
    // only value worth refusing is one that is not a number of degrees at all.
    // The finiteness test can only fire for a direct Rust caller: JSON has no
    // spelling for NaN, so serde hands that path a null and `f()` reads 0.0.
    if !i.heading_deg.is_finite() || i.heading_deg.abs() > 360_000.0 {
        return Some("nav-core: headingDeg is not a plausible bearing");
    }
    None
}

/// `step {routeId, lat, lng, accuracyM, speedMps, headingDeg, tsMs, prevIndex,
/// maneuverBeginIndex}` — the one pass per fix.
fn op_step(args: &Value) -> Value {
    let mut guard = session();
    let Some(sess) = guard.as_mut() else {
        return err("nav-core: no route set");
    };
    // A step for a route we no longer hold is a caller bug, and answering it
    // with numbers from the PREVIOUS route would be worse than refusing: the
    // TS side falls back and the user sees correct distances either way.
    if let Some(rid) = args.get("routeId").and_then(Value::as_str) {
        if !rid.is_empty() && rid != sess.route_id {
            return err("nav-core: routeId does not match the active route");
        }
    }

    let input = NavStepInput {
        lat: f(args, "lat"),
        lng: f(args, "lng"),
        accuracy_m: f(args, "accuracyM"),
        speed_mps: f(args, "speedMps"),
        heading_deg: f(args, "headingDeg"),
        ts_ms: f(args, "tsMs"),
        prev_index: u(args, "prevIndex"),
        maneuver_begin_index: u(args, "maneuverBeginIndex"),
    };
    if !input.lat.is_finite() || !input.lng.is_finite() {
        return err("nav-core: non-finite fix");
    }
    if let Some(why) = implausible_telemetry(&input) {
        return err(why);
    }

    let (out, next) = nav_step(&sess.geom, input, sess.state);
    sess.state = next;

    ok(json!({
        "index": out.index,
        "snappedLat": out.snapped_lat,
        "snappedLng": out.snapped_lng,
        "crossTrackM": out.cross_track_m,
        "alongM": out.along_m,
        "distToManeuverM": out.dist_to_maneuver_m,
        "remainingM": out.remaining_m,
        "progress": out.progress,
        "verdict": out.verdict.as_str(),
        "arrived": out.arrived,
        "rescanned": out.rescanned,
    }))
}

/// `clearRoute {}` — drop the session. Called on stopNavigation so a finished
/// journey's geometry does not sit in native memory (§25: do not hold location
/// data longer than necessary).
fn op_clear_route() -> Value {
    *session() = None;
    ok(json!({ "cleared": true }))
}

/// `selfCheck {}` — the probe the TS wrapper runs before trusting this library,
/// exactly as CryptoCore does. It exercises real geometry rather than returning
/// a constant, so a miscompiled or mismatched .so fails here instead of on the
/// road.
fn op_self_check() -> Value {
    let geom = RouteGeometry::build(crate::synthetic_route(64));
    let p = crate::project(&geom, geom.shape[32], 0, crate::SEARCH_WINDOW);
    if p.cross_track_m > 0.5 || (p.along_m - geom.cum[32]).abs() > 1.0 {
        return err("nav-core: self-check geometry mismatch");
    }
    ok(json!({ "version": env!("CARGO_PKG_VERSION"), "ok": true }))
}

fn dispatch(op: &str, args: &Value) -> Value {
    match op {
        "setRoute" => op_set_route(args),
        "step" => op_step(args),
        "clearRoute" => op_clear_route(),
        "selfCheck" => op_self_check(),
        other => err(format!("nav-core: unknown op '{other}'")),
    }
}

/// The single C entrypoint. Returns a heap `char*` the caller must release with
/// `vc_nav_free`. Never panics across the boundary — a panic becomes an error
/// object and the TS wrapper falls back to routeProgress.ts.
///
/// # Safety
/// `op` and `args_json` must be valid NUL-terminated C strings.
#[no_mangle]
pub unsafe extern "C" fn vc_nav_call(op: *const c_char, args_json: *const c_char) -> *mut c_char {
    let out = std::panic::catch_unwind(|| {
        if op.is_null() || args_json.is_null() {
            return err("nav-core: null argument").to_string();
        }
        // SAFETY: the contract above; the C++ wrapper always passes c_str().
        let op_s = match unsafe { CStr::from_ptr(op) }.to_str() {
            Ok(s) => s,
            Err(_) => return err("nav-core: op is not UTF-8").to_string(),
        };
        let args_s = match unsafe { CStr::from_ptr(args_json) }.to_str() {
            Ok(s) => s,
            Err(_) => return err("nav-core: args are not UTF-8").to_string(),
        };
        let args: Value = serde_json::from_str(args_s).unwrap_or(Value::Null);
        dispatch(op_s, &args).to_string()
    })
    .unwrap_or_else(|_| err("nav-core: panicked").to_string());

    // serde_json escapes control characters (NUL included), so CString::new
    // cannot fail here; a null return is still handled by the C++ side.
    CString::new(out).map(CString::into_raw).unwrap_or(std::ptr::null_mut())
}

/// Release a string returned by `vc_nav_call`.
///
/// # Safety
/// `ptr` must be a pointer previously returned by `vc_nav_call`, freed once.
#[no_mangle]
pub unsafe extern "C" fn vc_nav_free(ptr: *mut c_char) {
    if !ptr.is_null() {
        unsafe { drop(CString::from_raw(ptr)) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(op: &str, args: Value) -> Value {
        let o = CString::new(op).unwrap();
        let a = CString::new(args.to_string()).unwrap();
        let raw = unsafe { vc_nav_call(o.as_ptr(), a.as_ptr()) };
        assert!(!raw.is_null());
        let s = unsafe { CStr::from_ptr(raw) }.to_str().unwrap().to_string();
        unsafe { vc_nav_free(raw) };
        serde_json::from_str(&s).unwrap()
    }

    // There is ONE global session, so these tests are not independent of each
    // other: without this, a route set by one test can be replaced by another
    // between a setRoute and its step, and the failure looks like a bug in the
    // code under test. Poison is ignored for the same reason the real session
    // lock ignores it — a test that panics must not take the rest of the suite
    // with it.
    static SERIAL: Mutex<()> = Mutex::new(());
    fn serial() -> std::sync::MutexGuard<'static, ()> {
        SERIAL.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn shape_json(n: usize) -> Value {
        Value::Array(
            crate::synthetic_route(n)
                .into_iter()
                .map(|p| json!([p.lat, p.lng]))
                .collect(),
        )
    }

    #[test]
    fn self_check_passes_over_the_c_boundary() {
        let r = call("selfCheck", json!({}));
        assert_eq!(r["ok"], true, "{r}");
    }

    #[test]
    fn a_full_session_round_trips() {
        let _s = serial();
        let set = call("setRoute", json!({ "routeId": "r1", "shape": shape_json(200) }));
        assert_eq!(set["ok"], true, "{set}");
        assert_eq!(set["result"]["points"], 200);

        let pts = crate::synthetic_route(200);
        let step = call("step", json!({
            "routeId": "r1", "lat": pts[50].lat, "lng": pts[50].lng,
            "accuracyM": 5.0, "speedMps": 8.0, "headingDeg": 45.0,
            "tsMs": 1000.0, "prevIndex": 48, "maneuverBeginIndex": 120,
        }));
        assert_eq!(step["ok"], true, "{step}");
        assert_eq!(step["result"]["verdict"], "on_route");
        assert!(step["result"]["remainingM"].as_f64().unwrap() > 0.0);
        assert!(step["result"]["distToManeuverM"].as_f64().unwrap() > 0.0);

        assert_eq!(call("clearRoute", json!({}))["ok"], true);
        assert_eq!(call("step", json!({ "lat": 1.0, "lng": 1.0 }))["ok"], false);
    }

    #[test]
    fn bad_input_is_an_error_not_a_crash() {
        assert_eq!(call("nonsense", json!({}))["ok"], false);
        assert_eq!(call("setRoute", json!({ "shape": [] }))["ok"], false);
        assert_eq!(call("setRoute", json!({ "shape": [[1.0, 2.0]] }))["ok"], false);
        let nan = call("setRoute", json!({ "shape": [[1.0, 2.0], [null, 3.0]] }));
        assert_eq!(nan["ok"], false, "{nan}");
    }

    /// One caught panic used to be terminal. `op_step` holds the session guard
    /// across `nav_step`, so an unwind poisons the mutex, and `.lock().unwrap()`
    /// then panicked on EVERY later call for the life of the process — including
    /// `clearRoute`, the one thing that exists to recover. `selfCheck` takes no
    /// lock, so a health probe kept reporting the library fine.
    #[test]
    fn a_poisoned_session_lock_does_not_brick_every_later_call() {
        let _s = serial();
        // Poison it the way a panicking step would: unwind with the guard held.
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let _ = std::thread::spawn(|| {
            let _guard = SESSION.lock().unwrap();
            panic!("simulated panic inside nav_step");
        })
        .join();
        std::panic::set_hook(prev);
        assert!(SESSION.is_poisoned(), "the test did not actually poison the lock");

        // Everything must still work afterwards — this is the whole point.
        assert_eq!(call("selfCheck", json!({}))["ok"], true);
        let set = call("setRoute", json!({ "routeId": "poison", "shape": shape_json(80) }));
        assert_eq!(set["ok"], true, "{set}");
        let pts = crate::synthetic_route(80);
        let step = call("step", json!({
            "routeId": "poison", "lat": pts[20].lat, "lng": pts[20].lng,
            "accuracyM": 5.0, "speedMps": 8.0, "headingDeg": 45.0,
            "tsMs": 1000.0, "prevIndex": 18, "maneuverBeginIndex": 60,
        }));
        assert_eq!(step["ok"], true, "a step after a poisoned lock must work: {step}");
        assert_eq!(call("clearRoute", json!({}))["ok"], true);
    }

    /// A finite-but-absurd tsMs produced no panic and no hang — it produced a
    /// NaN smoothed position, an infinite cross-track serialised as JSON null
    /// inside an `{"ok":true}` envelope, a snap to route index 0, and an
    /// off-route strike against a driver who never left the road.
    #[test]
    fn absurd_telemetry_is_refused_rather_than_answered_with_nulls() {
        let _s = serial();
        assert_eq!(call("setRoute", json!({ "routeId": "tel", "shape": shape_json(120) }))["ok"], true);
        let pts = crate::synthetic_route(120);
        let good = json!({
            "routeId": "tel", "lat": pts[40].lat, "lng": pts[40].lng,
            "accuracyM": 5.0, "speedMps": 8.0, "headingDeg": 45.0,
            "tsMs": 1000.0, "prevIndex": 38, "maneuverBeginIndex": 90,
        });

        for (field, value) in [
            ("tsMs", 1e308_f64), ("tsMs", -1e308),
            ("speedMps", 1e308), ("speedMps", -1e308),
            ("accuracyM", 1e308), ("accuracyM", -1e308),
            ("headingDeg", 1e308),
        ] {
            let mut bad = good.clone();
            bad[field] = json!(value);
            let r = call("step", bad);
            assert_eq!(r["ok"], false, "{field}={value} must be refused, got {r}");
        }

        // Ordinary small negatives stay ACCEPTED: iOS reports accuracy -1 for a
        // fix it could not qualify, and both implementations already neutralise
        // that with max(1.0). Refusing it would break a caller that works today.
        for (field, value) in [("accuracyM", -1.0_f64), ("speedMps", -1.0)] {
            let mut edge = good.clone();
            edge[field] = json!(value);
            let r = call("step", edge);
            assert_eq!(r["ok"], true, "{field}={value} must still be accepted, got {r}");
        }

        // An ordinary fix is completely unaffected …
        let ok = call("step", good.clone());
        assert_eq!(ok["ok"], true, "{ok}");
        assert!(ok["result"]["snappedLat"].as_f64().is_some(), "{ok}");

        // … and now that the filter holds a finite variance, the precise damage
        // the absurd tsMs used to do, asserted directly: a success envelope
        // carrying a null position and a snap back to the start of the route.
        let mut poison = good.clone();
        poison["tsMs"] = json!(1e308);
        poison["prevIndex"] = json!(40);
        let r = call("step", poison);
        assert!(
            !(r["ok"] == true && r["result"]["snappedLat"].is_null()),
            "a NaN position must never ship inside an ok envelope: {r}"
        );
        assert_eq!(r["ok"], false, "{r}");
        assert_eq!(call("clearRoute", json!({}))["ok"], true);
    }

    /// `prevIndex` is whatever the caller's JSON said, and this crate builds
    /// with overflow-checks on, so `prev_index + window` panicked on a huge one
    /// while the `lo` on the line above was already saturating.
    #[test]
    fn a_huge_prev_index_is_clamped_rather_than_overflowing() {
        let _s = serial();
        assert_eq!(call("setRoute", json!({ "routeId": "big", "shape": shape_json(100) }))["ok"], true);
        let pts = crate::synthetic_route(100);
        let r = call("step", json!({
            "routeId": "big", "lat": pts[10].lat, "lng": pts[10].lng,
            "accuracyM": 5.0, "speedMps": 8.0, "headingDeg": 45.0,
            "tsMs": 1000.0, "prevIndex": u64::MAX, "maneuverBeginIndex": 50,
        }));
        assert_eq!(r["ok"], true, "{r}");
        // The stale-index rescan does its job and still finds the real position.
        assert_eq!(r["result"]["rescanned"], true, "{r}");
        assert!(r["result"]["index"].as_u64().unwrap() <= 11, "{r}");
        assert_eq!(call("clearRoute", json!({}))["ok"], true);
    }

    #[test]
    fn a_step_for_the_wrong_route_is_refused_rather_than_answered() {
        let _s = serial();
        assert_eq!(call("setRoute", json!({ "routeId": "a", "shape": shape_json(50) }))["ok"], true);
        let wrong = call("step", json!({
            "routeId": "b", "lat": 12.97, "lng": 77.59,
            "accuracyM": 5.0, "speedMps": 1.0, "tsMs": 1.0,
            "prevIndex": 0, "maneuverBeginIndex": 10,
        }));
        assert_eq!(wrong["ok"], false, "{wrong}");
    }
}
