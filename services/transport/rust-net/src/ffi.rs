//! C ABI used only by the Android JNI shim. Pointers are borrowed for each call.
use std::ffi::{c_char, c_void, CStr};
use crate::carrier::{self, Event};

#[no_mangle]
pub extern "C" fn vc_transport_create() -> u64 { carrier::create() }

#[no_mangle]
pub extern "C" fn vc_transport_supports_webtransport() -> bool { cfg!(feature = "webtransport") }

#[no_mangle]
pub extern "C" fn vc_transport_close(id: u64) { carrier::close(id); }

/// `bytes` must address `len` bytes for this synchronous call.
#[no_mangle]
pub unsafe extern "C" fn vc_transport_send(id: u64, bytes: *const u8, len: usize) -> bool {
    if bytes.is_null() || len == 0 || len > carrier::MAX_BYTES { return false; }
    carrier::send(id, std::slice::from_raw_parts(bytes, len).to_vec())
}

/// Strings are NUL-terminated UTF-8; callback/context remain valid until return.
/// Event kinds: 0=open, 1=binary, 2=closed (code). Bytes live only during callback.
#[no_mangle]
pub unsafe extern "C" fn vc_transport_run(id: u64, url: *const c_char, token: *const c_char,
    callback: extern "C" fn(*mut c_void, u32, *const u8, usize, u16), context: *mut c_void) {
    if url.is_null() || token.is_null() { carrier::close(id); return; }
    let url = CStr::from_ptr(url).to_str().unwrap_or("");
    let token = CStr::from_ptr(token).to_str().unwrap_or("");
    // A native networking failure must close this carrier, never unwind through
    // JNI and abort the entire app. The JS owner then performs its normal fallback.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        carrier::run(id, url, token, |event| match event {
            Event::Open => callback(context, 0, std::ptr::null(), 0, 0),
            Event::Binary(bytes) => callback(context, 1, bytes.as_ptr(), bytes.len(), 0),
            Event::Closed(code) => callback(context, 2, std::ptr::null(), 0, code),
        });
    }));
    if result.is_err() {
        carrier::close(id);
        callback(context, 2, std::ptr::null(), 0, 1011);
    }
}
