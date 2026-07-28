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

/// Recompute a block's chunk geometry — identical on the pack (upload) and
/// split (download) side, so no per-chunk length rides the wire.
///
/// `block_plain_offset = Some` ⇒ segmented/offset scheme (chunkId = plaintext
/// offset). `None` ⇒ uniform R2 (chunkId = blockIndex*chunksPerBlock + i).
pub fn plan_block(
    block_index: u64,
    chunk_bytes: u64,
    block_bytes: u64,
    total_bytes: u64,
    block_plain_offset: Option<u64>,
) -> Vec<ChunkSpec> {
    let chunks_per_block = block_bytes / chunk_bytes;
    let first_chunk = block_index * chunks_per_block;
    let offset_scheme = block_plain_offset.is_some();
    let base = block_plain_offset.unwrap_or(block_index * block_bytes);
    let mut out = Vec::with_capacity(chunks_per_block as usize);
    for i in 0..chunks_per_block {
        let plain_offset = base + i * chunk_bytes;
        if plain_offset >= total_bytes {
            break;
        }
        let id = if offset_scheme { plain_offset } else { first_chunk + i };
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
        let b0 = plan_block(0, 16, 64, 100, None);
        assert_eq!(b0.iter().map(|s| s.id).collect::<Vec<_>>(), vec![0, 1, 2, 3]);
        let b1 = plan_block(1, 16, 64, 100, None);
        assert_eq!(b1.iter().map(|s| (s.id, s.plain_len)).collect::<Vec<_>>(), vec![(4, 16), (5, 16), (6, 4)]);
    }

    #[test]
    fn block_plan_offset_scheme_uses_offset_ids() {
        let b = plan_block(1, 16, 64, 100, Some(64));
        assert_eq!(b.iter().map(|s| s.id).collect::<Vec<_>>(), vec![64, 80, 96]);
    }

    #[test]
    fn block_round_trip() {
        let key = [9u8; 32];
        let data: Vec<u8> = (0..100u32).map(|o| (o.wrapping_mul(31).wrapping_add(7)) as u8).collect();
        let specs = plan_block(1, 16, 64, 100, None);
        let wire = seal_block(&key, "tid", "fid", &specs, &data);
        let opened = open_block(&key, "tid", "fid", &specs, &wire).unwrap();
        for (off, plain) in opened {
            assert_eq!(plain, data[off as usize..off as usize + plain.len()]);
        }
    }
}
