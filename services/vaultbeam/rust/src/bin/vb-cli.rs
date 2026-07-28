//! vb-cli — line-delimited JSON REPL over the vaultbeam-core FFI dispatch, the
//! host-side twin of the Nitro binding (mirrors crypto-core's vc-crypto-cli).
//! The Step 5 parity suite drives this from Node to prove Rust ↔ Kotlin/JS
//! byte-equality (sealChunk/openChunk/sha256) without a device.
//!
//!   echo '{"op":"sealChunk","args":{…}}' | vb-cli   →   {"ok":true,"result":"…"}

use std::io::{BufRead, Write};

fn main() {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let _ = writeln!(out, "{}", vaultbeam_core::ffi::handle_line(&line));
        let _ = out.flush();
    }
}
