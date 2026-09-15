//! Android carrier: opaque binary WebSocket messages, no second CC-Wire session.
//! TLS uses the same verified rustls/WebPKI roots as the standalone client.
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue, protocol::WebSocketConfig, Message};

pub const MAX_BYTES: usize = transport_core::config::MAX_FRAME_BYTES + transport_core::config::HEADER_BYTES;
const MAX_SOCKETS: usize = 2; // One active account plus a connection being retired.
const QUEUE: usize = 4;
type Receivers = (mpsc::Receiver<Vec<u8>>, watch::Receiver<bool>);
struct Socket {
    send: mpsc::Sender<Vec<u8>>,
    cancel: watch::Sender<bool>,
    receivers: Option<Receivers>,
}
#[derive(Default)]
struct Registry { next: u64, sockets: HashMap<u64, Socket> }
fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(Registry::default()))
}

pub enum Event { Open, Binary(Vec<u8>), Closed(u16) }

pub fn create() -> u64 {
    let Ok(mut registry) = registry().lock() else { return 0 };
    if registry.sockets.len() >= MAX_SOCKETS { return 0; }
    registry.next = registry.next.wrapping_add(1).max(1);
    let id = registry.next;
    let (send, receive) = mpsc::channel(QUEUE);
    let (cancel, stopped) = watch::channel(false);
    registry.sockets.insert(id, Socket { send, cancel, receivers: Some((receive, stopped)) });
    id
}

pub fn send(id: u64, bytes: Vec<u8>) -> bool {
    if bytes.is_empty() || bytes.len() > MAX_BYTES { return false; }
    let Ok(registry) = registry().lock() else { return false };
    registry.sockets.get(&id).is_some_and(|socket| socket.send.try_send(bytes).is_ok())
}

pub fn close(id: u64) {
    if let Ok(mut registry) = registry().lock() {
        if let Some(socket) = registry.sockets.remove(&id) { let _ = socket.cancel.send(true); }
    }
}

pub fn run(id: u64, url: &str, token: &str, mut emit: impl FnMut(Event)) {
    // tokio-tungstenite disables rustls's default features. Install our explicit
    // ring provider before any WSS TLS builder runs (also in WSS-only builds).
    let _ = rustls::crypto::ring::default_provider().install_default();
    let receivers = registry().lock().ok().and_then(|mut r| r.sockets.get_mut(&id)?.receivers.take());
    let Some((rx, stop)) = receivers else { emit(Event::Closed(1000)); return };
    let code = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt.block_on(drive(url, token, rx, stop, &mut emit)),
        Err(_) => 1011,
    };
    close(id);
    emit(Event::Closed(code));
}

async fn drive(url: &str, token: &str, mut rx: mpsc::Receiver<Vec<u8>>, mut stop: watch::Receiver<bool>, emit: &mut impl FnMut(Event)) -> u16 {
    #[cfg(feature = "webtransport")]
    if url.starts_with("https://") { return crate::webtransport::drive(url, token, rx, stop, emit).await; }
    let Ok(mut request) = url.into_client_request() else { return 1002 };
    let secure = request.uri().scheme_str() == Some("wss");
    #[cfg(test)]
    let secure = secure || request.uri().host() == Some("127.0.0.1");
    if !secure || token.is_empty() || token.len() > 16_384 { return 1008; }
    let Ok(auth) = HeaderValue::from_str(&format!("Bearer {token}")) else { return 1008 };
    request.headers_mut().insert("Authorization", auth);
    let config = WebSocketConfig::default().max_message_size(Some(MAX_BYTES)).max_frame_size(Some(MAX_BYTES));
    let connect = tokio_tungstenite::connect_async_with_config(request, Some(config), false);
    let result = tokio::select! {
        biased;
        _ = stop.changed() => return 1000,
        result = tokio::time::timeout(Duration::from_secs(15), connect) => result,
    };
    let mut ws = match result {
        Ok(Ok((ws, _))) => ws,
        Ok(Err(tokio_tungstenite::tungstenite::Error::Http(response))) if response.status().as_u16() == 401 => return 4401,
        _ => return 1006,
    };
    emit(Event::Open);
    loop {
        tokio::select! {
            biased;
            _ = stop.changed() => {
                let _ = tokio::time::timeout(Duration::from_secs(1), ws.close(None)).await;
                return 1000;
            }
            bytes = rx.recv() => {
                let Some(bytes) = bytes else { return 1000 };
                // Bound a stalled write; cancellation must also interrupt a write.
                tokio::select! {
                    biased;
                    _ = stop.changed() => return 1000,
                    result = tokio::time::timeout(Duration::from_secs(10), ws.send(Message::Binary(bytes.into()))) => {
                        if !matches!(result, Ok(Ok(()))) { return 1006; }
                    }
                }
            }
            message = ws.next() => match message {
                Some(Ok(Message::Binary(bytes))) => emit(Event::Binary(bytes.to_vec())),
                Some(Ok(Message::Close(frame))) => return frame.map(|f| u16::from(f.code)).unwrap_or(1000),
                Some(Ok(Message::Ping(_))) => {
                    if !matches!(tokio::time::timeout(Duration::from_secs(5), ws.flush()).await, Ok(Ok(()))) { return 1006; }
                }
                Some(Ok(Message::Pong(_))) => {},
                Some(Ok(_)) => return 1003,
                _ => return 1006,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "set CCWIRE_WSS_TEST_URL to an authenticated WSS endpoint"]
    fn verified_wss_reaches_authentication() {
        let url = std::env::var("CCWIRE_WSS_TEST_URL").expect("WSS test URL");
        let id = create();
        let mut closed = false;
        run(id, &url, "invalid-test-token", |event| match event {
            Event::Closed(code) => { assert_eq!(code, 4401, "verified TLS must reach the HTTP auth rejection"); closed = true; },
            _ => panic!("invalid token must never open an authenticated session"),
        });
        assert!(closed);
    }

    #[test]
    fn binary_io_auth_queue_and_cancel() {
        // Exercise the TLS configuration even when the socket fixture is plain
        // loopback WS; absence of a provider otherwise hides until a real phone.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let _tls = rustls::ClientConfig::builder().with_root_certificates(rustls::RootCertStore::empty()).with_no_client_auth();
        let id = create();
        assert_ne!(id, 0);
        for _ in 0..QUEUE { assert!(send(id, vec![1])); }
        assert!(!send(id, vec![2]));
        assert!(!send(id, vec![0; MAX_BYTES + 1]));
        close(id);
        assert!(!send(id, vec![1]));

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let server = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            rt.block_on(async {
                let listener = tokio::net::TcpListener::from_std(listener).unwrap();
                let (stream, _) = listener.accept().await.unwrap();
                let mut ws = tokio_tungstenite::accept_hdr_async(stream, |req: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
                    assert_eq!(req.headers()["Authorization"], "Bearer test-token");
                    Ok(response)
                }).await.unwrap();
                let bytes = ws.next().await.unwrap().unwrap();
                assert_eq!(bytes, Message::Binary(vec![0, 255, 1].into()));
                ws.send(bytes).await.unwrap();
                let _ = ws.next().await;
            });
        });
        let id = create();
        let mut received = false;
        run(id, &format!("ws://{address}/ccwire/v1"), "test-token", |event| match event {
            Event::Open => assert!(send(id, vec![0, 255, 1])),
            Event::Binary(bytes) => { assert_eq!(bytes, vec![0, 255, 1]); received = true; close(id); },
            Event::Closed(code) => assert_eq!(code, 1000),
        });
        assert!(received);
        server.join().unwrap();
    }
}
