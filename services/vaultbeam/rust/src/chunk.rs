//! Chunk crypto + geometry — the VaultBeam wire contract, in Rust.
//!
//! Byte-for-byte with plugins/android/VaultBeamStreamModule.kt and the Step 0
//! golden vectors (services/crypto/__vectors__/vaultbeam.json). GCM is delegated
//! to the Phase 1 crypto-core (`crypto_core::aead`) — one implementation.
//!
//!   nonce = 4B transferId UTF-8 prefix (zero-padded) ‖ u64_be(chunkId)   [12B]
//!   aad   = "<transferId>|<fileId>|<chunkId>"  (UTF-8)
//!   wire  = ciphertext ‖ 16B GCM tag
//!   chunkId = plaintext byte offset (offset/segmented scheme)
//!             OR blockIndex*chunksPerBlock + i (uniform R2) == global chunk index (P2/LAN)

use crypto_core::aead::{gcm_open, gcm_seal};

use crate::VbError;

/// nonce = 4B transferId UTF-8 prefix (zero-padded to 4) ‖ u64 big-endian chunkId.
pub fn chunk_nonce(transfer_id: &str, chunk_id: u64) -> [u8; 12] {
    let mut n = [0u8; 12];
    let tb = transfer_id.as_bytes();
    let take = tb.len().min(4);
    n[..take].copy_from_slice(&tb[..take]);
    n[4..12].copy_from_slice(&chunk_id.to_be_bytes());
    n
}

/// aad = "<transferId>|<fileId>|<chunkId>" (UTF-8). chunkId rendered as decimal,
/// matching Kotlin's `Long.toString` in the string template.
pub fn chunk_aad(transfer_id: &str, file_id: &str, chunk_id: u64) -> Vec<u8> {
    format!("{transfer_id}|{file_id}|{chunk_id}").into_bytes()
}

/// Seal one chunk → `ciphertext ‖ 16B tag`.
pub fn seal_chunk(key: &[u8; 32], transfer_id: &str, file_id: &str, chunk_id: u64, plaintext: &[u8]) -> Vec<u8> {
    gcm_seal(key, &chunk_nonce(transfer_id, chunk_id), &chunk_aad(transfer_id, file_id, chunk_id), plaintext)
}

/// Verify + open one chunk wire (`ct ‖ tag`).
pub fn open_chunk(key: &[u8; 32], transfer_id: &str, file_id: &str, chunk_id: u64, wire: &[u8]) -> Result<Vec<u8>, VbError> {
    gcm_open(key, &chunk_nonce(transfer_id, chunk_id), &chunk_aad(transfer_id, file_id, chunk_id), wire)
        .map_err(|e| VbError(e.0))
}

/// One chunk's position within a block.
#[derive(Debug, Clone, PartialEq)]
pub struct ChunkSpec {
    pub id: u64,           // chunk identity (drives nonce + aad)
    pub plain_offset: u64, // plaintext byte offset in the whole file
    pub plain_len: usize,  // <= chunkBytes; the tail chunk is shorter
}

/// How a chunk's identity (nonce + AAD) is derived from its position.
///
/// `Canonical` is the vbm3 scheme and the only one used by new transfers: the
/// logical chunk size is globally constant, so a chunk's id is its GLOBAL
/// LOGICAL INDEX regardless of which transport carries it or how large the
/// physical block is. That equality across transports is what makes a single
/// resume bitmap meaningful.
///
/// The other two are retained to read data written by older clients during the
/// one-release dual-read window (relay objects expire in 24 h, so the window
/// only needs to exceed a day):
/// * `Uniform` — legacy, `id = blockIndex * chunksPerBlock + i`. Correct only
///   when every block has the same size.
/// * `LegacyOffset` — vbm2 segmented relay, `id = plainOffset`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdScheme {
    Uniform,
    LegacyOffset,
    Canonical,
}

impl IdScheme {
    /// Back-compat default: what the pre-vbm3 code did for a given call shape.
    /// `block_plain_offset = Some` meant the segmented relay path.
    pub fn legacy_default(block_plain_offset: Option<u64>) -> Self {
        if block_plain_offset.is_some() { IdScheme::LegacyOffset } else { IdScheme::Uniform }
    }
}

/// Recompute a block's chunk geometry — identical on the pack (upload) and
/// split (download) side, so no per-chunk length rides the wire.
///
/// `block_plain_offset = Some` supplies the block's plaintext base offset
/// (segmented geometry); `None` derives it as `blockIndex * blockBytes`.
/// `scheme` selects how the chunk id is derived — see [`IdScheme`].
pub fn plan_block(
    block_index: u64,
    chunk_bytes: u64,
    block_bytes: u64,
    total_bytes: u64,
    block_plain_offset: Option<u64>,
    scheme: IdScheme,
) -> Vec<ChunkSpec> {
    // `chunk_bytes` reaches this from a raw JSON number (ffi.rs `chunkBytes`),
    // so zero is something a caller can actually send and it would divide by
    // zero on the next line. An empty plan is the honest answer for a geometry
    // that describes no chunks; the FFI-facing wrappers in fileio.rs turn the
    // same input into a named error rather than a silently empty block.
    if chunk_bytes == 0 {
        return Vec::new();
    }
    let chunks_per_block = block_bytes / chunk_bytes;
    let first_chunk = block_index * chunks_per_block;
    let base = block_plain_offset.unwrap_or(block_index * block_bytes);
    // Reserve what the loop below can actually produce, not what the block
    // geometry nominally allows. The loop stops at `total_bytes`, so a caller
    // sending chunkBytes=1 with a large blockBytes used to ask for a
    // `chunks_per_block`-element reservation — billions of `ChunkSpec`s — for a
    // plan of a handful. That reservation is the dangerous part: a failed
    // allocation aborts the process outright instead of unwinding into the
    // `catch_unwind` at the FFI boundary. This is a tighter hint, never a
    // different plan: the loop's own termination is unchanged.
    let reachable = total_bytes.saturating_sub(base).div_ceil(chunk_bytes);
    let mut out = Vec::with_capacity(chunks_per_block.min(reachable) as usize);
    for i in 0..chunks_per_block {
        let plain_offset = base + i * chunk_bytes;
        if plain_offset >= total_bytes {
            break;
        }
        let id = match scheme {
            IdScheme::Uniform => first_chunk + i,
            IdScheme::LegacyOffset => plain_offset,
            IdScheme::Canonical => plain_offset / chunk_bytes,
        };
        let plain_len = chunk_bytes.min(total_bytes - plain_offset) as usize;
        out.push(ChunkSpec { id, plain_offset, plain_len });
    }
    out
}

/// Pack a block's chunks from an in-memory plaintext slice → concatenated wire.
/// (The file-positional variant lives in `fileio`; this is the pure, tested core.)
pub fn seal_block(key: &[u8; 32], transfer_id: &str, file_id: &str, specs: &[ChunkSpec], plaintext: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    for s in specs {
        let start = s.plain_offset as usize;
        out.extend_from_slice(&seal_chunk(key, transfer_id, file_id, s.id, &plaintext[start..start + s.plain_len]));
    }
    out
}

/// Split + verify + open a block's concatenated wire → `(plain_offset, plaintext)`
/// per chunk. Errors on a short/tampered body (the caller must not mark the block).
pub fn open_block(
    key: &[u8; 32],
    transfer_id: &str,
    file_id: &str,
    specs: &[ChunkSpec],
    block_wire: &[u8],
) -> Result<Vec<(u64, Vec<u8>)>, VbError> {
    let mut out = Vec::with_capacity(specs.len());
    let mut off = 0usize;
    for s in specs {
        let ct_len = s.plain_len + 16; // + GCM tag
        if off + ct_len > block_wire.len() {
            return Err(VbError(format!("short block body: need {} have {}", off + ct_len, block_wire.len())));
        }
        let plain = open_chunk(key, transfer_id, file_id, s.id, &block_wire[off..off + ct_len])?;
        out.push((s.plain_offset, plain));
        off += ct_len;
    }
    Ok(out)
}

/// Uniform chunk count for the P2/LAN tiers (ceil).
pub fn chunk_count(total_bytes: u64, chunk_bytes: u64) -> u64 {
    total_bytes.div_ceil(chunk_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nonce_prefix_and_u64() {
        // "TQF9" = 54 51 46 39; id in the low 8 bytes, big-endian.
        assert_eq!(chunk_nonce("TQF9k2mZ", 0), [0x54, 0x51, 0x46, 0x39, 0, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(chunk_nonce("ab", 1)[..], [0x61, 0x62, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
        assert_eq!(chunk_nonce("TQF9", 0x100000002)[4..], [0, 0, 0, 1, 0, 0, 0, 2]);
    }

    #[test]
    fn block_plan_uniform_tail() {
        // total 100, chunk 16, block 64 → block0 = 4 full; block1 = 2 full + tail(4).
        let b0 = plan_block(0, 16, 64, 100, None, IdScheme::Uniform);
        assert_eq!(b0.iter().map(|s| s.id).collect::<Vec<_>>(), vec![0, 1, 2, 3]);
        let b1 = plan_block(1, 16, 64, 100, None, IdScheme::Uniform);
        assert_eq!(b1.iter().map(|s| (s.id, s.plain_len)).collect::<Vec<_>>(), vec![(4, 16), (5, 16), (6, 4)]);
    }

    #[test]
    fn block_plan_offset_scheme_uses_offset_ids() {
        let b = plan_block(1, 16, 64, 100, Some(64), IdScheme::LegacyOffset);
        assert_eq!(b.iter().map(|s| s.id).collect::<Vec<_>>(), vec![64, 80, 96]);
    }

    #[test]
    fn block_plan_canonical_uses_global_logical_index() {
        // Same block as above, canonical: id = offset / chunkBytes.
        let b = plan_block(1, 16, 64, 100, Some(64), IdScheme::Canonical);
        assert_eq!(b.iter().map(|s| s.id).collect::<Vec<_>>(), vec![4, 5, 6]);
    }

    #[test]
    fn canonical_id_is_transport_invariant() {
        // THE property the whole seamless-resume design rests on: the chunk
        // covering plaintext offset X has the SAME id whether it arrives in a
        // 64-byte physical block, a 32-byte one, or one chunk at a time over a
        // direct transport. `Uniform` does NOT have this property once physical
        // block sizes differ, which is exactly why the scheme changed.
        // Same plaintext base (offset 64), two different physical block sizes.
        let big = plan_block(1, 16, 64, 100, Some(64), IdScheme::Canonical);
        let small = plan_block(1, 16, 32, 100, Some(64), IdScheme::Canonical);
        assert_eq!(big[0].id, small[0].id, "same offset ⇒ same id across physical unit sizes");
        assert_eq!(big[0].plain_offset, small[0].plain_offset);

        // and it equals the direct-transport global index for that offset
        assert_eq!(small[0].id, small[0].plain_offset / 16);

        // The legacy uniform scheme is NOT offset-stable once physical block
        // sizes differ between segments: global block 1 here starts at offset 64
        // (logical chunk 4), but uniform computes 1 * (32/16) = 2. Two transports
        // disagreeing about a chunk's name is precisely RC-2.
        let legacy_small = plan_block(1, 16, 32, 100, Some(64), IdScheme::Uniform);
        assert_eq!(legacy_small[0].id, 2, "uniform derives the id from the block index");
        assert_ne!(legacy_small[0].id, small[0].id, "uniform is not offset-stable");
    }

    #[test]
    fn block_round_trip() {
        let key = [9u8; 32];
        let data: Vec<u8> = (0..100u32).map(|o| (o.wrapping_mul(31).wrapping_add(7)) as u8).collect();
        for scheme in [IdScheme::Uniform, IdScheme::LegacyOffset, IdScheme::Canonical] {
            let specs = plan_block(1, 16, 64, 100, Some(64), scheme);
            let wire = seal_block(&key, "tid", "fid", &specs, &data);
            let opened = open_block(&key, "tid", "fid", &specs, &wire).unwrap();
            for (off, plain) in opened {
                assert_eq!(plain, data[off as usize..off as usize + plain.len()], "{scheme:?}");
            }
        }
    }

    /// `chunkBytes` is a raw JSON number on the way in. Zero used to divide by
    /// zero, and a tiny value with a large `blockBytes` used to reserve billions
    /// of specs for a plan of a handful — and an allocation that fails aborts
    /// the process rather than unwinding into the FFI's catch_unwind.
    #[test]
    fn a_hostile_block_geometry_neither_divides_by_zero_nor_over_reserves() {
        assert!(plan_block(0, 0, 64, 100, None, IdScheme::Uniform).is_empty());
        assert!(plan_block(3, 0, 64, 100, Some(0), IdScheme::Canonical).is_empty());

        // 1 MiB block over 16-byte chunks nominally holds 65536 of them; the
        // 100-byte file means the plan is 7 long, so that is what is reserved.
        let v = plan_block(0, 16, 1 << 20, 100, None, IdScheme::Uniform);
        assert_eq!(v.len(), 7);
        assert!(v.capacity() < 64, "reserved {} for a plan of {}", v.capacity(), v.len());

        // A block entirely past the end of the file reserves nothing at all.
        let past = plan_block(0, 16, 1 << 20, 100, Some(1_000), IdScheme::Canonical);
        assert!(past.is_empty() && past.capacity() == 0);
    }

    #[test]
    fn cross_scheme_open_fails() {
        // A block sealed canonical must NOT open as legacy — the AAD/nonce differ,
        // so a version mix is a clean authentication failure, never a silent
        // mis-decrypt. This is what makes the dual-read window safe.
        let key = [9u8; 32];
        let data: Vec<u8> = (0..100u32).map(|o| (o.wrapping_mul(31).wrapping_add(7)) as u8).collect();
        let canon = plan_block(1, 16, 64, 100, Some(64), IdScheme::Canonical);
        let wire = seal_block(&key, "tid", "fid", &canon, &data);
        let legacy = plan_block(1, 16, 64, 100, Some(64), IdScheme::LegacyOffset);
        assert!(open_block(&key, "tid", "fid", &legacy, &wire).is_err());
    }
}
