//! Positional file IO — the P2 per-chunk primitives + prealloc/sha256/delete.
//! JS never holds a file byte; Rust reads/writes chunks at their offsets by path.
//! Byte-identical semantics to plugins/android/VaultBeamStreamModule.kt.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::chunk::{open_block, open_chunk, plan_block, seal_chunk, IdScheme};
use crate::VbError;

fn io<E: std::fmt::Display>(ctx: &str) -> impl FnOnce(E) -> VbError + '_ {
    move |e| VbError(format!("{ctx}: {e}"))
}

/// Strip a `file://` URI to a filesystem path (callers pass app-owned paths).
pub fn fs_path(p: &str) -> &str {
    p.strip_prefix("file://").unwrap_or(p)
}

/// Preallocate the destination shell so out-of-order/resumed positional writes
/// land at the right offsets (`RandomAccessFile.setLength` equivalent).
pub fn prealloc(path: &str, total_bytes: u64) -> Result<bool, VbError> {
    let p = Path::new(fs_path(path));
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(io("prealloc mkdirs"))?;
    }
    // truncate(false) is LOAD-BEARING, not a lint silencer. This shell is
    // opened again on every resumed transfer, and clippy's default suggestion
    // (truncate(true)) would zero every chunk already received — silently
    // turning a resumed 12 GB transfer into a restarted one. set_len below both
    // grows and shrinks, so the length is still set exactly; what must not
    // happen is the CONTENT being discarded on open.
    let f = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .read(true)
        .open(p)
        .map_err(io("prealloc open"))?;
    f.set_len(total_bytes).map_err(io("prealloc set_len"))?;
    Ok(true)
}

/// SENDER (P2): read chunk `g` from `src_path` @ its offset, seal → wire bytes
/// (JS base64-encodes for the datachannel). `g` is the GLOBAL chunk index; id = g.
// 8 arguments against clippy's default of 7. Left as arguments on purpose:
// these are chunk-level crypto/IO calls whose parameters are each independently
// meaningful (path, key, transfer id, indices, offsets), and bundling them into
// a params struct to satisfy a threshold would add an indirection that makes a
// mis-ordered field EASIER to introduce, not harder — the opposite of what the
// lint is protecting against.
#[allow(clippy::too_many_arguments)]
pub fn read_cipher_chunk(
    src_path: &str,
    key: &[u8; 32],
    transfer_id: &str,
    file_id: &str,
    g: u64,
    chunk_bytes: u64,
    chunk_count: u64,
    total_bytes: u64,
) -> Result<Vec<u8>, VbError> {
    if g >= chunk_count {
        return Err(VbError(format!("chunk {g} out of range (count {chunk_count})")));
    }
    let plain_offset = g * chunk_bytes;
    let plain_len = chunk_bytes.min(total_bytes - plain_offset) as usize;
    let mut f = File::open(fs_path(src_path)).map_err(io("readCipherChunk open"))?;
    f.seek(SeekFrom::Start(plain_offset)).map_err(io("readCipherChunk seek"))?;
    let mut plain = vec![0u8; plain_len];
    f.read_exact(&mut plain).map_err(io("readCipherChunk read"))?;
    Ok(seal_chunk(key, transfer_id, file_id, g, &plain))
}

/// RECIPIENT (P2): verify + open a chunk wire and write plaintext @ its offset.
/// Returns the plaintext byte count. `g` is the GLOBAL chunk index; id = g.
// 8 arguments against clippy's default of 7 — see read_cipher_chunk above for
// why these stay as arguments rather than becoming a params struct.
#[allow(clippy::too_many_arguments)]
pub fn write_cipher_chunk(
    dst_path: &str,
    key: &[u8; 32],
    transfer_id: &str,
    file_id: &str,
    g: u64,
    chunk_bytes: u64,
    chunk_count: u64,
    wire: &[u8],
) -> Result<usize, VbError> {
    if g >= chunk_count {
        return Err(VbError(format!("chunk {g} out of range (count {chunk_count})")));
    }
    let plain = open_chunk(key, transfer_id, file_id, g, wire)?;
    let plain_offset = g * chunk_bytes;
    let mut f = OpenOptions::new().write(true).read(true).open(fs_path(dst_path)).map_err(io("writeCipherChunk open"))?;
    f.seek(SeekFrom::Start(plain_offset)).map_err(io("writeCipherChunk seek"))?;
    f.write_all(&plain).map_err(io("writeCipherChunk write"))?;
    Ok(plain.len())
}

/// SENDER (R2 relay): read a block's chunks from `src_path` @ their offsets,
/// seal each, and return the concatenated block ciphertext (the platform layer
/// HTTP-PUTs it to the presigned URL — "Design A′": crypto+layout+IO in Rust,
/// the trivial HTTPS transport stays platform-native to avoid a Rust TLS stack).
/// Byte-identical to Kotlin `uploadBlock`'s body.
#[allow(clippy::too_many_arguments)]
pub fn seal_block_from_file(
    src_path: &str,
    key: &[u8; 32],
    transfer_id: &str,
    file_id: &str,
    block_index: u64,
    chunk_bytes: u64,
    block_bytes: u64,
    total_bytes: u64,
    block_plain_offset: Option<u64>,
    scheme: IdScheme,
) -> Result<Vec<u8>, VbError> {
    // chunkBytes arrives as a raw JSON number. Zero is the whole geometry
    // collapsing — it is what chunksPerBlock divides by — and answering with an
    // empty block would look like a successful upload of nothing. Name it.
    if chunk_bytes == 0 {
        return Err(VbError("uploadBlock: chunkBytes must be non-zero".into()));
    }
    let specs = plan_block(block_index, chunk_bytes, block_bytes, total_bytes, block_plain_offset, scheme);
    let mut f = File::open(fs_path(src_path)).map_err(io("uploadBlock open"))?;
    let mut out = Vec::new();
    for s in &specs {
        f.seek(SeekFrom::Start(s.plain_offset)).map_err(io("uploadBlock seek"))?;
        let mut plain = vec![0u8; s.plain_len];
        f.read_exact(&mut plain).map_err(io("uploadBlock read"))?;
        out.extend_from_slice(&seal_chunk(key, transfer_id, file_id, s.id, &plain));
    }
    Ok(out)
}

/// RECIPIENT (R2 relay): given a block's raw body (platform HTTP-GET'd), verify+
/// open each chunk and write plaintext @ its offset. Errors on a short/tampered
/// body (the block is not marked). Returns chunks written. Mirrors Kotlin
/// `downloadBlock` after the GET.
#[allow(clippy::too_many_arguments)]
pub fn write_block_from_body(
    dst_path: &str,
    key: &[u8; 32],
    transfer_id: &str,
    file_id: &str,
    block_index: u64,
    chunk_bytes: u64,
    block_bytes: u64,
    total_bytes: u64,
    block_plain_offset: Option<u64>,
    scheme: IdScheme,
    body: &[u8],
) -> Result<usize, VbError> {
    // As in seal_block_from_file: a zero chunkBytes plans no chunks at all, and
    // reporting "0 chunks written, fine" for a block the peer really sent would
    // let the caller mark it received. Refuse it by name instead.
    if chunk_bytes == 0 {
        return Err(VbError("downloadBlock: chunkBytes must be non-zero".into()));
    }
    let specs = plan_block(block_index, chunk_bytes, block_bytes, total_bytes, block_plain_offset, scheme);
    let opened = open_block(key, transfer_id, file_id, &specs, body)?;
    let mut f = OpenOptions::new().write(true).read(true).open(fs_path(dst_path)).map_err(io("downloadBlock open"))?;
    for (off, plain) in &opened {
        f.seek(SeekFrom::Start(*off)).map_err(io("downloadBlock seek"))?;
        f.write_all(plain).map_err(io("downloadBlock write"))?;
    }
    Ok(opened.len())
}

/// Whole-file SHA-256 (lowercase hex), streamed — never a full read into memory.
pub fn sha256_file(path: &str) -> Result<String, VbError> {
    let mut f = File::open(fs_path(path)).map_err(io("sha256 open"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(io("sha256 read"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

pub fn delete_file(path: &str) -> bool {
    std::fs::remove_file(fs_path(path)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> String {
        let mut p = std::env::temp_dir();
        p.push(format!("vbcore-{}-{name}", std::process::id()));
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn prealloc_read_write_round_trip() {
        let key = [5u8; 32];
        let (tid, fid) = ("Trans1", "File1");
        let total = 100u64;
        let cb = 16u64;
        let cc = crate::chunk::chunk_count(total, cb); // 7
        let data: Vec<u8> = (0..total as u32).map(|o| (o.wrapping_mul(31).wrapping_add(7)) as u8).collect();

        let src = tmp("src.bin");
        let dst = tmp("dst.bin");
        std::fs::write(&src, &data).unwrap();
        assert!(prealloc(&dst, total).unwrap());
        assert_eq!(std::fs::metadata(&dst).unwrap().len(), total);

        for g in 0..cc {
            let wire = read_cipher_chunk(&src, &key, tid, fid, g, cb, cc, total).unwrap();
            let n = write_cipher_chunk(&dst, &key, tid, fid, g, cb, cc, &wire).unwrap();
            assert_eq!(n as u64, cb.min(total - g * cb));
        }
        assert_eq!(std::fs::read(&dst).unwrap(), data, "reassembled file matches source");
        assert_eq!(sha256_file(&src).unwrap(), sha256_file(&dst).unwrap());

        // out-of-range + tamper rejection
        assert!(read_cipher_chunk(&src, &key, tid, fid, cc, cb, cc, total).is_err());
        let mut w = read_cipher_chunk(&src, &key, tid, fid, 0, cb, cc, total).unwrap();
        w[0] ^= 1;
        assert!(write_cipher_chunk(&dst, &key, tid, fid, 0, cb, cc, &w).is_err());

        assert!(delete_file(&src));
        assert!(delete_file(&dst));
        assert!(!delete_file(&src)); // second delete → false, no panic
    }

    /// A zero chunkBytes is a geometry that describes nothing, and the block
    /// ops must say so by name rather than panic on the division inside
    /// plan_block or report a successful transfer of no chunks.
    #[test]
    fn a_zero_chunk_size_is_a_named_error_from_the_block_ops() {
        let key = [3u8; 32];
        let src = tmp("zero-src.bin");
        std::fs::write(&src, vec![0u8; 100]).unwrap();

        let e = seal_block_from_file(&src, &key, "T", "F", 0, 0, 64, 100, None, IdScheme::Uniform).unwrap_err();
        assert!(e.0.contains("chunkBytes"), "got {}", e.0);

        let e = write_block_from_body(&src, &key, "T", "F", 0, 0, 64, 100, None, IdScheme::Uniform, &[]).unwrap_err();
        assert!(e.0.contains("chunkBytes"), "got {}", e.0);

        // A real geometry is unaffected.
        assert!(seal_block_from_file(&src, &key, "T", "F", 0, 16, 64, 100, None, IdScheme::Uniform).is_ok());
        delete_file(&src);
    }

    #[test]
    fn fs_path_strips_uri() {
        assert_eq!(fs_path("file:///data/x"), "/data/x");
        assert_eq!(fs_path("/data/x"), "/data/x");
    }
}
