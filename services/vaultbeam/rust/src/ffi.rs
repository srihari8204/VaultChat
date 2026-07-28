//! FFI boundary for the Nitro C++ wrapper + the host CLI (`vb-cli`), mirroring
//! the crypto-core pattern: JSON-in / JSON-out, bytes as base64 (matching the
//! existing JS surface: `keyB64`, `ctB64`). Large FILE bytes never cross here —
//! Rust does positional IO by path.
//!
//! Two entrypoints:
//!   * `vb_call(op, args_json)` — request/response ops (prealloc, read/write
//!     cipher chunk, sha256, delete, lanIp, and the pure sealChunk/openChunk the
//!     parity suite drives against the Kotlin/JS oracle).
//!   * `vb_lan_serve` / `vb_lan_connect` — long-running LAN with a C event
//!     callback (`vbLanBound` / `vbLanProgress`) forwarded to the JS emitter.
//!
//! Response envelope: `{"ok":true,"result":…}` | `{"ok":false,"error":"…"}`.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Value};
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_void};

use crate::{chunk, fileio, lan, VbError};

type Res<T> = Result<T, VbError>;

fn s<'a>(a: &'a Value, k: &str) -> Res<&'a str> {
    a.get(k).and_then(Value::as_str).ok_or_else(|| VbError(format!("vaultbeam: arg '{k}' must be a string")))
}
fn u64_(a: &Value, k: &str) -> Res<u64> {
    a.get(k).and_then(Value::as_u64).ok_or_else(|| VbError(format!("vaultbeam: arg '{k}' must be a u64")))
}
fn key32(a: &Value, k: &str) -> Res<[u8; 32]> {
    let raw = B64.decode(s(a, k)?).map_err(|_| VbError(format!("vaultbeam: arg '{k}' must be base64")))?;
    raw.try_into().map_err(|_| VbError(format!("vaultbeam: arg '{k}' must decode to 32 bytes")))
}
fn b64(a: &Value, k: &str) -> Res<Vec<u8>> {
    B64.decode(s(a, k)?).map_err(|_| VbError(format!("vaultbeam: arg '{k}' must be base64")))
}

/// Request/response ops. LAN serve/connect are NOT here (they need the event cb).
pub fn dispatch(op: &str, a: &Value) -> Res<Value> {
    match op {
        // pure chunk crypto — the parity suite drives these against Kotlin/JS.
        "sealChunk" => {
            let ct = chunk::seal_chunk(&key32(a, "keyB64")?, s(a, "transferId")?, s(a, "fileId")?, u64_(a, "chunkId")?, &b64(a, "plaintextB64")?);
            Ok(json!(B64.encode(ct)))
        }
        "openChunk" => {
            let plain = chunk::open_chunk(&key32(a, "keyB64")?, s(a, "transferId")?, s(a, "fileId")?, u64_(a, "chunkId")?, &b64(a, "ctB64")?)?;
            Ok(json!(B64.encode(plain)))
        }

        // file IO
        "prealloc" => Ok(json!(fileio::prealloc(s(a, "path")?, u64_(a, "totalBytes")?)?)),
        "readCipherChunk" => {
            let ct = fileio::read_cipher_chunk(
                s(a, "srcPath")?, &key32(a, "keyB64")?, s(a, "transferId")?, s(a, "fileId")?,
                u64_(a, "chunkIndex")?, u64_(a, "chunkBytes")?, u64_(a, "chunkCount")?, u64_(a, "totalBytes")?,
            )?;
            Ok(json!(B64.encode(ct)))
        }
        "writeCipherChunk" => {
            let n = fileio::write_cipher_chunk(
                s(a, "dstPath")?, &key32(a, "keyB64")?, s(a, "transferId")?, s(a, "fileId")?,
                u64_(a, "chunkIndex")?, u64_(a, "chunkBytes")?, u64_(a, "chunkCount")?, &b64(a, "ctB64")?,
            )?;
            Ok(json!(n))
        }
        "sha256" => Ok(json!(fileio::sha256_file(s(a, "path")?)?)),
        "deleteFile" => Ok(json!(fileio::delete_file(s(a, "path")?))),
        "lanIp" => Ok(match lan::lan_ip() {
            Some(ip) => json!(ip),
            None => Value::Null,
        }),

        _ => Err(VbError(format!("vaultbeam: unknown op '{op}'"))),
    }
}

fn error_json(msg: &str) -> String {
    json!({ "ok": false, "error": msg }).to_string()
}

/// One request line `{"op":"…","args":{…}}` → one response JSON string.
/// Backs the host CLI (`vb-cli`) used by the Step 5 parity suite. Never panics.
pub fn handle_line(line: &str) -> String {
    std::panic::catch_unwind(|| {
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => return error_json(&format!("vaultbeam: bad request JSON: {e}")),
        };
        let op = match v.get("op").and_then(Value::as_str) {
            Some(o) => o,
            None => return error_json("vaultbeam: request missing 'op'"),
        };
        let args = v.get("args").cloned().unwrap_or_else(|| json!({}));
        match dispatch(op, &args) {
            Ok(r) => json!({ "ok": true, "result": r }).to_string(),
            Err(e) => error_json(&e.0),
        }
    })
    .unwrap_or_else(|_| error_json("vaultbeam: internal panic"))
}

// ── C ABI (for the Nitro C++ wrapper) ───────────────────────────────────────

fn respond(op: &str, args_json: &str) -> String {
    let args: Value = match serde_json::from_str(args_json) {
        Ok(v) => v,
        Err(e) => return error_json(&format!("vaultbeam: bad args JSON: {e}")),
    };
    match dispatch(op, &args) {
        Ok(v) => json!({ "ok": true, "result": v }).to_string(),
        Err(e) => error_json(&e.0),
    }
}

/// # Safety
/// `op`/`args_json` must be NUL-terminated C strings (or null → error). The
/// returned pointer must be released with `vb_free`.
#[no_mangle]
pub extern "C" fn vb_call(op: *const c_char, args_json: *const c_char) -> *mut c_char {
    let out = std::panic::catch_unwind(|| {
        if op.is_null() || args_json.is_null() {
            return error_json("vaultbeam: null argument");
        }
        let op = unsafe { CStr::from_ptr(op) }.to_string_lossy().into_owned();
        let args = unsafe { CStr::from_ptr(args_json) }.to_string_lossy().into_owned();
        respond(&op, &args)
    })
    .unwrap_or_else(|_| error_json("vaultbeam: internal panic"));
    CString::new(out).map(CString::into_raw).unwrap_or(std::ptr::null_mut())
}

/// Event callback the wrapper registers: `(ctx, event_name, json_payload)`.
pub type EventCb = extern "C" fn(*mut c_void, *const c_char, *const c_char);

fn emit(cb: EventCb, ctx: *mut c_void, name: &str, payload: &Value) {
    if let (Ok(n), Ok(p)) = (CString::new(name), CString::new(payload.to_string())) {
        cb(ctx, n.as_ptr(), p.as_ptr());
    }
}

fn lan_serve_inner(a: &Value, cb: EventCb, ctx: *mut c_void) -> Res<Value> {
    let key = key32(a, "keyB64")?;
    let token = b64(a, "token")?;
    let tid = s(a, "transferId")?.to_string();
    let count = lan::lan_serve(
        lan::ServeOpts {
            src_path: s(a, "srcPath")?, key, transfer_id: &tid, file_id: s(a, "fileId")?, token,
            chunk_bytes: u64_(a, "chunkBytes")?, chunk_count: u64_(a, "chunkCount")?,
            total_bytes: u64_(a, "totalBytes")?, port: a.get("port").and_then(Value::as_u64).map(|p| p as u16),
        },
        |port| emit(cb, ctx, "vbLanBound", &json!({ "transferId": tid, "port": port })),
        |done, total| emit(cb, ctx, "vbLanProgress", &json!({ "transferId": tid, "done": done, "total": total })),
    )?;
    Ok(json!(count))
}

fn lan_connect_inner(a: &Value, cb: EventCb, ctx: *mut c_void) -> Res<Value> {
    let key = key32(a, "keyB64")?;
    let token = b64(a, "token")?;
    let tid = s(a, "transferId")?.to_string();
    let count = lan::lan_connect(
        lan::ConnectOpts {
            host: s(a, "host")?, port: u64_(a, "port")? as u16, dst_path: s(a, "dstPath")?, key,
            transfer_id: &tid, file_id: s(a, "fileId")?, token,
            chunk_bytes: u64_(a, "chunkBytes")?, chunk_count: u64_(a, "chunkCount")?,
        },
        |done, total| emit(cb, ctx, "vbLanProgress", &json!({ "transferId": tid, "done": done, "total": total })),
    )?;
    Ok(json!(count))
}

fn lan_ffi(args_json: *const c_char, cb: EventCb, ctx: *mut c_void, f: fn(&Value, EventCb, *mut c_void) -> Res<Value>) -> *mut c_char {
    let out = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if args_json.is_null() {
            return error_json("vaultbeam: null args");
        }
        let raw = unsafe { CStr::from_ptr(args_json) }.to_string_lossy().into_owned();
        match serde_json::from_str::<Value>(&raw) {
            Ok(a) => match f(&a, cb, ctx) {
                Ok(v) => json!({ "ok": true, "result": v }).to_string(),
                Err(e) => error_json(&e.0),
            },
            Err(e) => error_json(&format!("vaultbeam: bad args JSON: {e}")),
        }
    }))
    .unwrap_or_else(|_| error_json("vaultbeam: internal panic"));
    CString::new(out).map(CString::into_raw).unwrap_or(std::ptr::null_mut())
}

/// # Safety
/// `args_json` a NUL-terminated C string; `cb` a valid fn for `ctx`'s lifetime.
#[no_mangle]
pub extern "C" fn vb_lan_serve(args_json: *const c_char, cb: EventCb, ctx: *mut c_void) -> *mut c_char {
    lan_ffi(args_json, cb, ctx, lan_serve_inner)
}

/// # Safety
/// As `vb_lan_serve`.
#[no_mangle]
pub extern "C" fn vb_lan_connect(args_json: *const c_char, cb: EventCb, ctx: *mut c_void) -> *mut c_char {
    lan_ffi(args_json, cb, ctx, lan_connect_inner)
}

/// Release a string returned by `vb_call` / `vb_lan_*`.
///
/// # Safety
/// `ptr` must be a pointer previously returned by this module (or null).
#[no_mangle]
pub extern "C" fn vb_free(ptr: *mut c_char) {
    if !ptr.is_null() {
        unsafe { drop(CString::from_raw(ptr)) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(op: &str, args: Value) -> Value {
        let resp: Value = serde_json::from_str(&handle_line(&json!({ "op": op, "args": args }).to_string())).unwrap();
        assert_eq!(resp["ok"], json!(true), "op {op} failed: {resp}");
        resp["result"].clone()
    }

    #[test]
    fn seal_open_round_trip_through_dispatch() {
        let key_b64 = B64.encode([9u8; 32]);
        let plain_b64 = B64.encode(b"hello vaultbeam");
        let ct = call("sealChunk", json!({ "keyB64": key_b64, "transferId": "T", "fileId": "F", "chunkId": 5, "plaintextB64": plain_b64 }));
        let back = call("openChunk", json!({ "keyB64": key_b64, "transferId": "T", "fileId": "F", "chunkId": 5, "ctB64": ct }));
        assert_eq!(back, json!(plain_b64));
    }

    #[test]
    fn sealchunk_matches_golden_vector() {
        // vaultbeam.json chunk "uniform id=0" through the FFI dispatch.
        let ct = call("sealChunk", json!({
            "keyB64": B64.encode(hex::decode("905889933a2d781100639fc38bf9e0c22442034f15c4f51b904e608693b32bba").unwrap()),
            "transferId": "TQF9k2mZ7pXaLdRb", "fileId": "file-9d3c1f", "chunkId": 0,
            "plaintextB64": B64.encode(hex::decode("0726456483a2c1e0ff1e3d5c7b9ab9d8").unwrap()),
        }));
        assert_eq!(hex::encode(B64.decode(ct.as_str().unwrap()).unwrap()),
                   "8db4dd706c28a1b6bdfa2cfc9ea9cf33ad1c24791f81de7ef3f37335751f440a");
    }

    #[test]
    fn errors_are_structured() {
        let resp: Value = serde_json::from_str(&handle_line(r#"{"op":"nope","args":{}}"#)).unwrap();
        assert_eq!(resp["ok"], json!(false));
        assert!(resp["error"].as_str().unwrap().contains("unknown op"));
    }
}
