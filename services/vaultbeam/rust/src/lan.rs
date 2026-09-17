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

/// The largest chunk count any real transfer can have, and so the largest index
/// list this module will ever build.
///
/// `chunkCount` is not a local constant — it rides the peer's manifest into
/// `session.chunkCount` and lib/vaultBeam/drivers/lan.ts forwards it verbatim to
/// `vb_lan_serve`/`vb_lan_connect`, where ffi.rs reads it as a raw JSON u64. An
/// unbounded value is worse than a panic here: `(0..2^40).collect()` asks for an
/// 8 TiB `Vec<u64>`, and a failed allocation does not unwind — `handle_alloc_error`
/// aborts the process, straight past the `catch_unwind` every FFI entry point
/// relies on. The ceiling therefore has to exist BEFORE the allocation does.
///
/// The number is two real limits divided, not a guess. A transfer is capped at
/// 12 GiB (`vbMaxBytes` in vaultchat-backend-go/internal/routes/vaultbeam.go,
/// mirrored as `MAX_BYTES` in lib/vaultbeamRelay.ts) and the smallest chunk any
/// geometry in the app uses is 256 KiB (the slowest bucket in lib/networkState.ts;
/// the canonical logical chunk is twice that, 512 KiB, in lib/vaultBeam/blockSize.ts).
/// 12 GiB / 256 KiB = 49152, so no legitimate session can reach it.
pub const MAX_CHUNK_COUNT: u64 = (12 * 1024 * 1024 * 1024) / (256 * 1024);

/// Expand runs (or the whole file when absent) into the chunk indices to move.
/// Order is preserved, so an ascending work-list streams ascending.
pub fn run_indices(runs: Option<&[ChunkRun]>, chunk_count: u64) -> Vec<u64> {
    // lan_serve/lan_connect refuse an over-large count outright; clamping again
    // here keeps the helper safe for any other caller, since it cannot report.
    let chunk_count = chunk_count.min(MAX_CHUNK_COUNT);
    match runs {
        None => (0..chunk_count).collect(),
        Some(rs) => {
            let mut out = Vec::new();
            for r in rs {
                // The clamp has to bound the ITERATION, not just what gets kept.
                // `count` is a raw u64 from the caller's JSON, so a run of
                // {start: 0, count: u64::MAX} used to walk 2^64 values while the
                // `g < chunk_count` test silently dropped all but the first few:
                // memory stayed flat, nothing panicked, and the blocking Kotlin
                // worker thread the LAN call occupies simply never came back.
                // A hang is the one failure `catch_unwind` cannot turn into JSON.
                let end = r.start.saturating_add(r.count).min(chunk_count);
                out.extend(r.start.min(end)..end);
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
    if opts.chunk_count > MAX_CHUNK_COUNT {
        return Err(VbError(format!("lan_range: chunkCount {} exceeds {MAX_CHUNK_COUNT}", opts.chunk_count)));
    }
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
    if opts.chunk_count > MAX_CHUNK_COUNT {
        return Err(VbError(format!("lan_range: chunkCount {} exceeds {MAX_CHUNK_COUNT}", opts.chunk_count)));
    }
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
        // The index is checked HERE, beside the length and before either is used
        // for anything, for the same reason `ct_len` is: the frame is attacker-
        // chosen. Being authenticated is not the same as being in range — a peer
        // who holds K_t can seal a chunk under ANY id, and without this test the
        // `idx * chunk_bytes` below decides where that plaintext lands. A
        // negative i32 sign-extends into a huge u64 and the multiply wraps
        // silently (release builds have overflow-checks off), so the sender
        // picks an arbitrary offset in the receiver's file and writes verified
        // plaintext at it. fileio.rs guards `read_cipher_chunk` and
        // `write_cipher_chunk` exactly this way; LAN was the path that did not.
        if idx >= opts.chunk_count {
            return Err(VbError(format!("lanConnect chunk {idx} out of range (count {})", opts.chunk_count)));
        }
        if ct_len < 16 || ct_len as u64 > opts.chunk_bytes + 64 {
            return Err(VbError(format!("lanConnect bad frame len {ct_len}")));
        }
        let mut ct = vec![0u8; ct_len as usize];
        reader.read_exact(&mut ct).map_err(io("lanConnect frame ct"))?;
        let plain = open_chunk(&opts.key, opts.transfer_id, opts.file_id, idx, &ct)?;
        f.seek(SeekFrom::Start(idx * opts.chunk_bytes)).map_err(io("lanConnect seek"))?;
        f.write_all(&plain).map_err(io("lanConnect write"))?;
        received += 1;
        if received.is_multiple_of(16) {
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

    /// `chunkCount` is peer-influenced and `(0..chunk_count).collect()` is an
    /// allocation, not a computation — 2^40 chunks is an 8 TiB Vec<u64> and a
    /// failed allocation ABORTS rather than unwinding, so the catch_unwind at
    /// the FFI boundary never sees it. The ceiling must bite before the Vec.
    #[test]
    fn an_absurd_chunk_count_cannot_reach_the_allocator() {
        // Just over the ceiling: small enough to run, large enough that the
        // clamp is the only thing that can produce this answer.
        assert_eq!(run_indices(None, MAX_CHUNK_COUNT + 1_000).len() as u64, MAX_CHUNK_COUNT);
        // A real 12 GiB / 512 KiB transfer is nowhere near it and is untouched.
        assert_eq!(run_indices(None, 24_576).len(), 24_576);

        // …and the LAN entry points say so rather than silently moving a subset.
        let key = [1u8; 32];
        let e = lan_serve(
            ServeOpts {
                src_path: "/nonexistent", key, transfer_id: "T", file_id: "F", token: vec![0u8; 4],
                chunk_bytes: 512 * 1024, chunk_count: 1 << 40, total_bytes: 1 << 40,
                port: None, runs: None,
            },
            |_p| panic!("must be refused before a socket is bound"),
            |_d, _t| {},
        )
        .unwrap_err();
        assert!(e.0.contains("lan_range"), "got {}", e.0);

        let e = lan_connect(
            ConnectOpts {
                host: "127.0.0.1", port: 1, dst_path: "/nonexistent", key, transfer_id: "T",
                file_id: "F", token: vec![0u8; 4], chunk_bytes: 512 * 1024,
                chunk_count: 1 << 40, runs: None,
            },
            |_d, _t| {},
        )
        .unwrap_err();
        assert!(e.0.contains("lan_range"), "got {}", e.0);
    }

    /// The run bound has to stop the LOOP. Filtering only the push left the
    /// iteration walking 2^64 values with flat memory and no panic — the LAN
    /// call's blocking worker thread simply never returned, which is the one
    /// failure mode catch_unwind cannot turn into a JSON error.
    #[test]
    fn a_giant_run_count_terminates_instead_of_spinning() {
        assert_eq!(run_indices(Some(&[ChunkRun { start: 0, count: u64::MAX }]), 5), vec![0, 1, 2, 3, 4]);
        assert_eq!(run_indices(Some(&[ChunkRun { start: 3, count: u64::MAX }]), 5), vec![3, 4]);
        // A run that starts past the end yields nothing, as it always did.
        assert!(run_indices(Some(&[ChunkRun { start: 9, count: u64::MAX }]), 5).is_empty());
    }

    /// A frame's index is attacker-chosen even when its ciphertext is authentic:
    /// a peer holding K_t can seal a chunk under any id, and `idx * chunk_bytes`
    /// then chooses where that plaintext lands in the destination file.
    #[test]
    fn a_frame_index_past_the_end_is_refused_before_anything_is_written() {
        let key = [11u8; 32];
        let (tid, fid) = ("LanIdx", "LanFile");
        let (total, cb) = (100u64, 16u64);
        let cc = crate::chunk::chunk_count(total, cb); // 7
        let token = b"0123456789abcdef".to_vec();

        let dst = tmp("idx-dst.bin");
        crate::fileio::prealloc(&dst, total).unwrap();
        std::fs::write(&dst, vec![0xAAu8; total as usize]).unwrap();

        // A hostile sender: authentic ciphertext, but under chunk id 9 when the
        // file only has 7 chunks. Deliberately a small overshoot rather than a
        // negative index — a negative i32 sign-extends to ~4.3e9 and, without
        // the bound, seeks tens of gigabytes into the file, which is not
        // something a test should ask a filesystem to do.
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).unwrap();
        let port = listener.local_addr().unwrap().port();
        let tok2 = token.clone();
        let sender = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut tok = vec![0u8; tok2.len()];
            s.read_exact(&mut tok).unwrap();
            let ct = seal_chunk(&key, tid, fid, 9, &[0xEEu8; 16]);
            s.write_all(&9i32.to_be_bytes()).unwrap();
            s.write_all(&(ct.len() as i32).to_be_bytes()).unwrap();
            s.write_all(&ct).unwrap();
            s.flush().unwrap();
            // Hold the connection open so the receiver fails on the index and
            // not on a closed socket.
            std::thread::sleep(Duration::from_millis(300));
        });

        let e = lan_connect(
            ConnectOpts {
                host: "127.0.0.1", port, dst_path: &dst, key, transfer_id: tid, file_id: fid,
                token, chunk_bytes: cb, chunk_count: cc, runs: None,
            },
            |_d, _t| {},
        )
        .unwrap_err();
        assert!(e.0.contains("out of range"), "got {}", e.0);

        // The proof that matters: the destination is byte-for-byte as it was.
        // Without the bound the chunk is written at offset 9*16 = 144 and the
        // 100-byte file grows to 160.
        let out = std::fs::read(&dst).unwrap();
        assert_eq!(out.len(), total as usize, "destination must not have grown");
        assert!(out.iter().all(|&b| b == 0xAA), "no plaintext may have landed");

        sender.join().unwrap();
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
