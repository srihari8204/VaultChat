//! P3 (LAN) direct TCP transport — blocking `std::net` on the caller's worker
//! thread (decision #1: no tokio; mirrors Kotlin's Executors(4) model). Same
//! wire as plugins/android/VaultBeamStreamModule.kt so a Kotlin peer and a Rust
//! peer interop:
//!
//!   receiver → [token bytes]
//!   sender   → repeated [i32_be index][i32_be ctLen][ct‖tag]
//!   receiver → [0x01]   (1-byte delivery ack, after every chunk is persisted)

use std::io::{BufReader, BufWriter, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::time::Duration;

use crate::chunk::{open_chunk, seal_chunk};
use crate::fileio::fs_path;
use crate::VbError;

fn io<E: std::fmt::Display>(ctx: &str) -> impl FnOnce(E) -> VbError + '_ {
    move |e| VbError(format!("{ctx}: {e}"))
}

use std::fs::{File, OpenOptions};
use std::io::{Seek, SeekFrom};

/// The device's site-local IPv4 (advertised to the peer over signaling), or
/// None. Private ranges = 10/8, 172.16/12, 192.168/16 (matches Java
/// `isSiteLocalAddress`).
pub fn lan_ip() -> Option<String> {
    let ifaces = if_addrs::get_if_addrs().ok()?;
    for i in ifaces {
        if i.is_loopback() {
            continue;
        }
        if let IpAddr::V4(v4) = i.ip() {
            if is_site_local(&v4) {
                return Some(v4.to_string());
            }
        }
    }
    None
}

fn is_site_local(a: &Ipv4Addr) -> bool {
    let o = a.octets();
    o[0] == 10 || (o[0] == 172 && (16..=31).contains(&o[1])) || (o[0] == 192 && o[1] == 168)
}

/// A contiguous run of logical chunks. `None` runs ⇒ the whole file, which is
/// the pre-resume behaviour and keeps old callers byte-identical.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChunkRun {
    pub start: u64,
    pub count: u64,
}

/// Expand runs (or the whole file when absent) into the chunk indices to move.
/// Order is preserved, so an ascending work-list streams ascending.
pub fn run_indices(runs: Option<&[ChunkRun]>, chunk_count: u64) -> Vec<u64> {
    match runs {
        None => (0..chunk_count).collect(),
        Some(rs) => {
            let mut out = Vec::new();
            for r in rs {
                for g in r.start..r.start.saturating_add(r.count) {
                    if g < chunk_count {
                        out.push(g);
                    }
                }
            }
            out
        }
    }
}

/// SENDER params.
pub struct ServeOpts<'a> {
    pub src_path: &'a str,
    pub key: [u8; 32],
    pub transfer_id: &'a str,
    pub file_id: &'a str,
    pub token: Vec<u8>,
    pub chunk_bytes: u64,
    pub chunk_count: u64,
    pub total_bytes: u64,
    pub port: Option<u16>,
    /// Resume: stream ONLY these chunks. None ⇒ the whole file.
    pub runs: Option<Vec<ChunkRun>>,
}

/// SENDER: bind, report the bound port via `on_bound`, accept, verify the token,
/// stream every chunk (progress via `on_progress` every 16), await the 1-byte
/// ack. Resolves the chunk count on a confirmed delivery.
pub fn lan_serve(
    opts: ServeOpts<'_>,
    mut on_bound: impl FnMut(u16),
    mut on_progress: impl FnMut(u64, u64),
) -> Result<u64, VbError> {
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, opts.port.unwrap_or(0))))
        .map_err(io("lanServe bind"))?;
    let port = listener.local_addr().map_err(io("lanServe local_addr"))?.port();
    on_bound(port);

    let (stream, _) = listener.accept().map_err(io("lanServe accept"))?;
    stream.set_read_timeout(Some(Duration::from_secs(60))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(120))).ok();
    stream.set_nodelay(true).ok();
    let mut reader = BufReader::new(stream.try_clone().map_err(io("lanServe clone"))?);
    let mut writer = BufWriter::new(stream.try_clone().map_err(io("lanServe clone"))?);

    let mut recv_tok = vec![0u8; opts.token.len()];
    reader.read_exact(&mut recv_tok).map_err(io("lanServe token read"))?;
    if recv_tok != opts.token {
        return Err(VbError("lan_auth: bad token".into()));
    }

    let indices = run_indices(opts.runs.as_deref(), opts.chunk_count);
    let expected = indices.len() as u64;
    let mut f = File::open(fs_path(opts.src_path)).map_err(io("lanServe open"))?;
    for (n, &g) in indices.iter().enumerate() {
        let plain_offset = g * opts.chunk_bytes;
        let plain_len = opts.chunk_bytes.min(opts.total_bytes - plain_offset) as usize;
        f.seek(SeekFrom::Start(plain_offset)).map_err(io("lanServe seek"))?;
        let mut plain = vec![0u8; plain_len];
        f.read_exact(&mut plain).map_err(io("lanServe read"))?;
        let ct = seal_chunk(&opts.key, opts.transfer_id, opts.file_id, g, &plain);
        // Wire is UNCHANGED: [i32_be index][i32_be ctLen][ct‖tag]. The index is
        // already carried per frame, so streaming a subset needs no new framing.
        writer.write_all(&(g as i32).to_be_bytes()).map_err(io("lanServe frame idx"))?;
        writer.write_all(&(ct.len() as i32).to_be_bytes()).map_err(io("lanServe frame len"))?;
        writer.write_all(&ct).map_err(io("lanServe frame ct"))?;
        if n % 16 == 0 {
            writer.flush().map_err(io("lanServe flush"))?;
            on_progress(n as u64 + 1, expected);
        }
    }
    writer.flush().map_err(io("lanServe final flush"))?;

    let mut ack = [0u8; 1];
    reader.read_exact(&mut ack).map_err(io("lanServe ack read"))?;
    stream.shutdown(Shutdown::Both).ok();
    if ack[0] == 1 {
        Ok(expected)
    } else {
        Err(VbError("lan_noack: receiver did not confirm delivery".into()))
    }
}

/// RECEIVER params.
pub struct ConnectOpts<'a> {
    pub host: &'a str,
    pub port: u16,
    pub dst_path: &'a str,
    pub key: [u8; 32],
    pub transfer_id: &'a str,
    pub file_id: &'a str,
    pub token: Vec<u8>,
    pub chunk_bytes: u64,
    pub chunk_count: u64,
    /// Resume: expect ONLY these chunks. None ⇒ the whole file. Must match the
    /// sender's runs, which both sides derive from the same session work-list.
    pub runs: Option<Vec<ChunkRun>>,
}

/// RECEIVER: connect, send the token, verify+write every streamed chunk at its
/// offset (progress every 16), then send the 1-byte ack. Resolves chunk count.
pub fn lan_connect(opts: ConnectOpts<'_>, mut on_progress: impl FnMut(u64, u64)) -> Result<u64, VbError> {
    let addr: SocketAddr = format!("{}:{}", opts.host, opts.port)
        .parse()
        .map_err(|_| VbError(format!("lanConnect bad addr {}:{}", opts.host, opts.port)))?;
    let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5)).map_err(io("lanConnect connect"))?;
    stream.set_read_timeout(Some(Duration::from_secs(60))).ok();
    stream.set_nodelay(true).ok();
    let mut reader = BufReader::new(stream.try_clone().map_err(io("lanConnect clone"))?);
    let mut writer = stream.try_clone().map_err(io("lanConnect clone"))?;

    writer.write_all(&opts.token).map_err(io("lanConnect token"))?;
    writer.flush().map_err(io("lanConnect token flush"))?;

    let expected = run_indices(opts.runs.as_deref(), opts.chunk_count).len() as u64;
    let mut f = OpenOptions::new().write(true).read(true).open(fs_path(opts.dst_path)).map_err(io("lanConnect open"))?;
    let mut received = 0u64;
    while received < expected {
        let mut hdr = [0u8; 8];
        reader.read_exact(&mut hdr).map_err(io("lanConnect frame hdr"))?;
        let idx = i32::from_be_bytes(hdr[0..4].try_into().unwrap()) as u64;
        let ct_len = i32::from_be_bytes(hdr[4..8].try_into().unwrap());
        if ct_len < 16 || ct_len as u64 > opts.chunk_bytes + 64 {
            return Err(VbError(format!("lanConnect bad frame len {ct_len}")));
        }
        let mut ct = vec![0u8; ct_len as usize];
        reader.read_exact(&mut ct).map_err(io("lanConnect frame ct"))?;
        let plain = open_chunk(&opts.key, opts.transfer_id, opts.file_id, idx, &ct)?;
        f.seek(SeekFrom::Start(idx * opts.chunk_bytes)).map_err(io("lanConnect seek"))?;
        f.write_all(&plain).map_err(io("lanConnect write"))?;
        received += 1;
        if received % 16 == 0 {
            on_progress(received, expected);
        }
    }
    f.sync_all().ok();
    writer.write_all(&[1u8]).map_err(io("lanConnect ack"))?;
    writer.flush().map_err(io("lanConnect ack flush"))?;
    Ok(expected)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> String {
        let mut p = std::env::temp_dir();
        p.push(format!("vbcore-lan-{}-{name}", std::process::id()));
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn lan_localhost_round_trip() {
        let key = [4u8; 32];
        let (tid, fid) = ("LanXfer", "LanFile");
        let total = 100u64;
        let cb = 16u64;
        let cc = crate::chunk::chunk_count(total, cb);
        let token = b"0123456789abcdef".to_vec();
        let data: Vec<u8> = (0..total as u32).map(|o| (o.wrapping_mul(31).wrapping_add(7)) as u8).collect();

        let src = tmp("src.bin");
        let dst = tmp("dst.bin");
        std::fs::write(&src, &data).unwrap();
        crate::fileio::prealloc(&dst, total).unwrap();

        let (tx, rx) = std::sync::mpsc::channel::<u16>();
        let (src2, tok2) = (src.clone(), token.clone());
        let server = std::thread::spawn(move || {
            lan_serve(
                ServeOpts {
                    src_path: &src2, key, transfer_id: tid, file_id: fid, token: tok2,
                    chunk_bytes: cb, chunk_count: cc, total_bytes: total, port: None, runs: None,
                },
                |port| tx.send(port).unwrap(),
                |_d, _t| {},
            )
        });

        let port = rx.recv().unwrap();
        let recv = lan_connect(
            ConnectOpts {
                host: "127.0.0.1", port, dst_path: &dst, key, transfer_id: tid, file_id: fid,
                token: token.clone(), chunk_bytes: cb, chunk_count: cc, runs: None,
            },
            |_d, _t| {},
        )
        .unwrap();

        assert_eq!(recv, cc);
        assert_eq!(server.join().unwrap().unwrap(), cc, "sender got the delivery ack");
        assert_eq!(std::fs::read(&dst).unwrap(), data, "LAN-transferred file matches source");

        crate::fileio::delete_file(&src);
        crate::fileio::delete_file(&dst);
    }

    #[test]
    fn run_indices_whole_file_and_subset() {
        assert_eq!(run_indices(None, 5), vec![0, 1, 2, 3, 4]);
        let runs = [ChunkRun { start: 1, count: 2 }, ChunkRun { start: 4, count: 1 }];
        assert_eq!(run_indices(Some(&runs), 5), vec![1, 2, 4]);
        // runs past the end are clipped, never panic
        let over = [ChunkRun { start: 3, count: 99 }];
        assert_eq!(run_indices(Some(&over), 5), vec![3, 4]);
        assert!(run_indices(Some(&[]), 5).is_empty());
    }

    /// RESUME: streaming only the missing runs must land those chunks at their
    /// correct offsets and leave every other byte of the destination untouched.
    #[test]
    fn lan_subset_round_trip_leaves_other_bytes_untouched() {
        let key = [7u8; 32];
        let (tid, fid) = ("LanSub", "LanFile");
        let total = 100u64;
        let cb = 16u64;
        let cc = crate::chunk::chunk_count(total, cb);   // 7
        let token = b"0123456789abcdef".to_vec();
        let data: Vec<u8> = (0..total as u32).map(|o| (o.wrapping_mul(31).wrapping_add(7)) as u8).collect();

        let src = tmp("sub-src.bin");
        let dst = tmp("sub-dst.bin");
        std::fs::write(&src, &data).unwrap();
        // Destination pre-filled with a sentinel so untouched regions are visible.
        crate::fileio::prealloc(&dst, total).unwrap();
        std::fs::write(&dst, vec![0xAAu8; total as usize]).unwrap();

        // Only chunks 2,3 and 6 (the tail) are missing.
        let runs = vec![ChunkRun { start: 2, count: 2 }, ChunkRun { start: 6, count: 1 }];
        let (tx, rx) = std::sync::mpsc::channel::<u16>();
        let (src2, tok2, runs2) = (src.clone(), token.clone(), runs.clone());
        let server = std::thread::spawn(move || {
            lan_serve(
                ServeOpts {
                    src_path: &src2, key, transfer_id: tid, file_id: fid, token: tok2,
                    chunk_bytes: cb, chunk_count: cc, total_bytes: total, port: None,
                    runs: Some(runs2),
                },
                |port| tx.send(port).unwrap(),
                |_d, _t| {},
            )
        });

        let port = rx.recv().unwrap();
        let got = lan_connect(
            ConnectOpts {
                host: "127.0.0.1", port, dst_path: &dst, key, transfer_id: tid, file_id: fid,
                token: token.clone(), chunk_bytes: cb, chunk_count: cc, runs: Some(runs.clone()),
            },
            |_d, _t| {},
        )
        .unwrap();

        assert_eq!(got, 3, "exactly the three requested chunks moved");
        assert_eq!(server.join().unwrap().unwrap(), 3, "sender streamed exactly three");

        let out = std::fs::read(&dst).unwrap();
        // requested chunks now hold the real plaintext …
        for g in [2u64, 3, 6] {
            let off = (g * cb) as usize;
            let len = (cb.min(total - g * cb)) as usize;
            assert_eq!(out[off..off + len], data[off..off + len], "chunk {g} landed");
        }
        // … and every other byte is untouched
        for g in [0u64, 1, 4, 5] {
            let off = (g * cb) as usize;
            let len = (cb.min(total - g * cb)) as usize;
            assert!(out[off..off + len].iter().all(|&b| b == 0xAA), "chunk {g} untouched");
        }

        crate::fileio::delete_file(&src);
        crate::fileio::delete_file(&dst);
    }

    #[test]
    fn lan_ip_is_none_or_private() {
        if let Some(ip) = lan_ip() {
            let v4: Ipv4Addr = ip.parse().unwrap();
            assert!(is_site_local(&v4), "lan_ip must be site-local, got {ip}");
        }
    }
}
