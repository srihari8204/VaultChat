//! `ccwire-connect` — point it at a real server and watch it connect.
//!
//! NOT PART OF ANY SHIPPING ARTEFACT. This is the "a human can actually run it"
//! half of the crate: it exists so the networking can be exercised against the
//! real Go endpoint rather than only against the test harness.
//!
//! ```text
//!   CCWIRE_WS=1 ./vaultchat-backend-go        # the endpoint is off by default
//!   cargo run --bin ccwire-connect -- ws://127.0.0.1:8080/ccwire/v1 "$ACCESS_TOKEN"
//! ```
//!
//! What it does, in order:
//!   1. opens a WebSocket with `Authorization: Bearer <token>` on the UPGRADE
//!      (a bad token is a 401 here, before any socket exists)
//!   2. ClientHello → ServerHello, printing the negotiated capabilities and the
//!      limits the server bound us to
//!   3. sits on the connection answering Ping with Pong and sending its own Ping
//!      after 10 s of silence, printing every application frame that arrives
//!   4. on disconnect, waits out `transport-core`'s jittered backoff and
//!      reconnects — forever, unless the server said AUTH, in which case it
//!      stops, because no amount of waiting renews a token
//!
//! The token is read from argv for the sake of being runnable in one line, and
//! is never printed.

use std::process::ExitCode;

use transport_core::conn::{CloseReason, Event};
use transport_core::session::{Capabilities, ErrorClass, Session};
use transport_net::{wait_for_retry, Connection};

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: ccwire-connect <ws://host/ccwire/v1> <access-token> [device-id]");
        return ExitCode::from(2);
    }
    let (url, token) = (&args[1], &args[2]);
    let device = args.get(3).map(String::as_str).unwrap_or("ccwire-connect");

    // The seed fixes this client's jitter for its whole life, so a support log
    // can reproduce exactly when it woke up. Derived from the device id rather
    // than from a random source for that reason.
    let seed = device.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| {
        (h ^ b as u64).wrapping_mul(0x100_0000_01b3)
    });

    // ONE session across every reconnect: the attempt counter lives in here, and
    // a session recreated per attempt is a backoff permanently stuck at attempt
    // zero.
    let mut session = Session::new(Capabilities::all(), seed);

    loop {
        let class = match attempt(url, token, device, &mut session).await {
            Ok(class) => class,
            Err(e) => {
                eprintln!("[ccwire] connect failed: {e}");
                // A failed connect is retryable by default. A 401 is not, and
                // tungstenite reports it as an HTTP error we can recognise.
                if format!("{e}").contains("401") {
                    ErrorClass::Auth
                } else {
                    ErrorClass::Retryable
                }
            }
        };
        let now = 0; // A fresh clock per attempt; the delay is relative anyway.
        if !wait_for_retry(&mut session, class, now).await {
            eprintln!("[ccwire] not retryable ({class:?}) — stopping");
            return ExitCode::FAILURE;
        }
        eprintln!("[ccwire] reconnecting (attempt {})", session.attempt());
    }
}

/// One connection's life. Returns the class to recover from.
async fn attempt(
    url: &str,
    token: &str,
    device: &str,
    session: &mut Session,
) -> Result<ErrorClass, transport_net::NetError> {
    let mut c = Connection::open(url, token, session).await?;
    eprintln!("[ccwire] upgraded: {url}");

    let accepted = c.handshake(device, &[]).await?;
    eprintln!("[ccwire] handshake ok: {accepted:?}");
    eprintln!("[ccwire] negotiated: {:?}", c.session().negotiated());
    eprintln!("[ccwire] limits:     {:?}", c.session().limits());
    eprintln!(
        "[ccwire] heartbeat:  {} ms interval / {} ms timeout",
        c.session().heartbeat_interval_ms(),
        c.session().heartbeat_timeout_ms()
    );

    while let Some(e) = c.next_event().await {
        match e {
            Event::Open => {}
            Event::Frame(p) => eprintln!("[ccwire] frame: {} bytes", p.len()),
            Event::Closed(CloseReason::Transport) => {
                eprintln!("[ccwire] socket closed");
                return Ok(ErrorClass::Retryable);
            }
            Event::Closed(r) => {
                // A protocol error is NOT retryable on a timer: reconnecting
                // into the same disagreement just repeats it.
                eprintln!("[ccwire] closed: {r:?}");
                return Ok(ErrorClass::Fatal);
            }
        }
    }
    Ok(ErrorClass::Retryable)
}
