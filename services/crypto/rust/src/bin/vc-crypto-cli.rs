//! Line-delimited JSON REPL over the FFI dispatcher.
//!
//! Lets Node-side tests (services/crypto/parity.selftest.ts) drive the Rust
//! core on the host without native bindings:
//!   stdin :  {"op":"ratchetEncrypt","args":{...}}\n   one request per line
//!   stdout:  {"ok":true,"result":...}\n               one response per line

use std::io::{BufRead, Write};

fn main() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let resp = crypto_core::ffi::handle_line(&line);
        if writeln!(stdout, "{resp}").is_err() {
            break;
        }
        let _ = stdout.flush();
    }
}
