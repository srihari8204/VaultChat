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
    let mut guard = SESSION.lock().unwrap();
    *guard = Some(Session { route_id, geom, state: NavStepState::default() });
    ok(json!({ "points": points, "lengthM": length_m }))
}

/// `step {routeId, lat, lng, accuracyM, speedMps, headingDeg, tsMs, prevIndex,
/// maneuverBeginIndex}` — the one pass per fix.
fn op_step(args: &Value) -> Value {
    let mut guard = SESSION.lock().unwrap();
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
    *SESSION.lock().unwrap() = None;
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

    #[test]
    fn a_step_for_the_wrong_route_is_refused_rather_than_answered() {
        assert_eq!(call("setRoute", json!({ "routeId": "a", "shape": shape_json(50) }))["ok"], true);
        let wrong = call("step", json!({
            "routeId": "b", "lat": 12.97, "lng": 77.59,
            "accuracyM": 5.0, "speedMps": 1.0, "tsMs": 1.0,
            "prevIndex": 0, "maneuverBeginIndex": 10,
        }));
        assert_eq!(wrong["ok"], false, "{wrong}");
    }
}
