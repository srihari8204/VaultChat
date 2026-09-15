//! Opt-in HTTP/3 carrier. One reliable bidirectional stream carries the existing
//! CC-Wire byte stream; JS remains its sole frame/session/reconnect owner.
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use wtransport::{ClientConfig, Endpoint, VarInt, endpoint::ConnectOptions, tls::rustls};
use crate::carrier::{Event, Outbound};

fn client_config(roots: rustls::RootCertStore) -> ClientConfig {
    // Android's native cert store is not exposed to rustls-native-certs. Reuse
    // the Mozilla roots used by WSS, retaining hostname and certificate checks.
    let mut tls = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(rustls::crypto::ring::default_provider()))
        .with_protocol_versions(&[&rustls::version::TLS13]).expect("TLS 1.3 supported")
        .with_root_certificates(roots).with_no_client_auth();
    tls.alpn_protocols = vec![wtransport::tls::WEBTRANSPORT_ALPN.to_vec()];
    ClientConfig::builder().with_bind_default().with_custom_tls(tls)
        .max_idle_timeout(Some(Duration::from_secs(30))).expect("valid idle timeout").build()
}

pub(crate) async fn drive(url: &str, token: &str, rx: mpsc::Receiver<Outbound>, stop: watch::Receiver<bool>, emit: &mut impl FnMut(Event)) -> u16 {
    let roots = rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    drive_with_config(url, token, rx, stop, emit, client_config(roots)).await
}

async fn drive_with_config(url: &str, token: &str, mut rx: mpsc::Receiver<Outbound>, mut stop: watch::Receiver<bool>, emit: &mut impl FnMut(Event), config: ClientConfig) -> u16 {
    if !url.starts_with("https://") || token.is_empty() || token.len() > 16384 || token.bytes().any(|b| !(32..=126).contains(&b)) { return 1008; }
    let Ok(endpoint) = Endpoint::client(config) else { return 1006 };
    let options = ConnectOptions::builder(url)
        .add_header("authorization", format!("Bearer {token}"))
        // Required by the server's pinned webtransport-go draft-02 handshake.
        .add_header("sec-webtransport-http3-draft02", "1").build();
    let connect = async {
        let connection = endpoint.connect(options).await.map_err(|error| {
            #[cfg(test)] eprintln!("WebTransport test connect: {error:?}");
            #[cfg(not(test))] let _ = error;
        })?;
        let streams = connection.open_bi().await.map_err(|error| {
            #[cfg(test)] eprintln!("WebTransport test open stream: {error:?}");
            #[cfg(not(test))] let _ = error;
        })?.await.map_err(|error| {
            #[cfg(test)] eprintln!("WebTransport test stream header: {error:?}");
            #[cfg(not(test))] let _ = error;
        })?;
        Ok::<_, ()>((connection, streams))
    };
    let connected = tokio::select! {
        biased;
        _ = stop.changed() => return 1000,
        result = tokio::time::timeout(Duration::from_secs(8), connect) => result,
    };
    let Ok(Ok((connection, (mut send, mut receive)))) = connected else { return 1006 };
    emit(Event::Open);
    let mut bytes = [0; 16 * 1024];
    let code = loop {
        tokio::select! {
            biased;
            _ = stop.changed() => break 1000,
            next = rx.recv() => {
                let Some(next) = next else { break 1000 };
                let sent = tokio::select! {
                    biased;
                    _ = stop.changed() => break 1000,
                    result = tokio::time::timeout(Duration::from_secs(10), send.write_all(&next.bytes)) => result,
                };
                if !matches!(sent, Ok(Ok(()))) { break 1006; }
            }
            read = receive.read(&mut bytes) => match read {
                Ok(Some(n)) if n > 0 => emit(Event::Binary(bytes[..n].to_vec())),
                _ => break 1006,
            }
        }
    };
    connection.close(VarInt::from_u32(0), b"closed");
    endpoint.close(VarInt::from_u32(0), b"closed");
    code
}

#[cfg(test)]
mod tests {
    use super::*;
    use transport_core::{conn::{Conn, Event as FrameEvent}, parse::{Frame, Limits, encode_frame, decode_frame}};

    #[tokio::test]
    #[ignore = "requires Go TestCCWireWebTransportInteropServer and CCWIRE_WT_INTEROP_DIR"]
    async fn go_webtransport_interop() {
        let dir = std::path::PathBuf::from(std::env::var("CCWIRE_WT_INTEROP_DIR").expect("fixture directory"));
        let fixture: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join("fixture.json")).expect("fixture")).expect("fixture JSON");
        let url = fixture["url"].as_str().unwrap();
        let token = fixture["token"].as_str().unwrap();
        let ca = wtransport::tls::Certificate::load_pemfile(fixture["ca"].as_str().unwrap()).await.unwrap();
        let mut roots = rustls::RootCertStore::empty();
        roots.add(rustls::pki_types::CertificateDer::from(ca.der().to_vec())).unwrap();

        // The native production path must reject this untrusted local test CA.
        let (_tx, rx) = mpsc::channel(4);
        let (_stop, stopped) = watch::channel(false);
        assert_eq!(drive(url, token, rx, stopped, &mut |_| panic!("untrusted CA opened")).await, 1006);
        // Trusting a CA is insufficient without a valid application credential.
        let (_tx, rx) = mpsc::channel(4);
        let (_stop, stopped) = watch::channel(false);
        assert_eq!(drive_with_config(url, "invalid", rx, stopped, &mut |_| panic!("invalid auth opened"), client_config(roots.clone())).await, 1006);

        let encode = |field, body: &[u8]| {
            let frame = Frame { request_id: "interop", traffic_class: 1, stream: 1, seq: 0, depends_on: 0, body_field: Some(field), body, unknown: Vec::new() };
            transport_core::frame::encode(&encode_frame(&frame, &Limits::default(), 0).unwrap(), 0).unwrap()
        };
        let hello = encode(16, &[]);
        let ping = encode(19, &[8, 42]);
        let (tx, rx) = mpsc::channel(4);
        let (stop, stopped) = watch::channel(false);
        let mut framed = Conn::new();
        framed.on_open();
        let mut fields = Vec::new();
        let code = tokio::time::timeout(Duration::from_secs(15), drive_with_config(url, token, rx, stopped, &mut |event| match event {
            Event::Open => {
                // Real QUIC stream fragmentation and pipelining, same shared frame codec.
                tx.try_send(Outbound::test(hello[..2].to_vec())).unwrap();
                tx.try_send(Outbound::test([&hello[2..], &ping].concat())).unwrap();
            }
            Event::Binary(bytes) => for event in framed.on_bytes(&bytes) {
                if let FrameEvent::Frame(payload) = event {
                    let frame = decode_frame(&payload, &Limits::default(), 0, 0).unwrap();
                    fields.push(frame.body_field.unwrap());
                    if frame.body_field == Some(20) { assert_eq!(frame.body, &[8, 42]); stop.send(true).unwrap(); }
                }
            },
            Event::Closed(_) => unreachable!(),
        }, client_config(roots))).await.expect("Go/Rust WebTransport exchange timed out");
        assert_eq!(code, 1000);
        assert_eq!(fields, [17, 20]);
        std::fs::write(dir.join("done"), "verified TLS, auth, ServerHello and Pong").unwrap();
    }
}
