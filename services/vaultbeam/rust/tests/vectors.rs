//! Proves vaultbeam-core reproduces the frozen wire contract byte-for-byte.
//! Reads the SAME golden file the JS oracle/guard writes:
//!   services/crypto/__vectors__/vaultbeam.json
//! (../../crypto/__vectors__/vaultbeam.json from this crate). This is the
//! cross-version interop contract — a change that breaks it is a bug.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

use vaultbeam_core::chunk::{chunk_aad, chunk_count, chunk_nonce, open_block, plan_block, seal_block, seal_chunk};

fn golden() -> Value {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("../../crypto/__vectors__/vaultbeam.json");
    let raw = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()));
    serde_json::from_str(&raw).unwrap()
}

fn key32(v: &Value) -> [u8; 32] {
    hex::decode(v["inputs"]["keyHex"].as_str().unwrap()).unwrap().try_into().unwrap()
}
fn u64_of(v: &Value, k: &str) -> u64 {
    v[k].as_u64().unwrap()
}

#[test]
fn chunk_vectors_byte_identical() {
    let g = golden();
    let key = key32(&g);
    for c in g["chunks"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let tid = c["transferId"].as_str().unwrap();
        let fid = c["fileId"].as_str().unwrap();
        let id = u64_of(c, "chunkId");
        let plain = hex::decode(c["plaintextHex"].as_str().unwrap()).unwrap();

        assert_eq!(hex::encode(chunk_nonce(tid, id)), c["nonceHex"].as_str().unwrap(), "nonce: {name}");
        assert_eq!(String::from_utf8(chunk_aad(tid, fid, id)).unwrap(), c["aad"].as_str().unwrap(), "aad: {name}");
        let wire = seal_chunk(&key, tid, fid, id, &plain);
        assert_eq!(hex::encode(&wire), c["wireHex"].as_str().unwrap(), "wire: {name}");
        assert_eq!(vaultbeam_core::chunk::open_chunk(&key, tid, fid, id, &wire).unwrap(), plain, "open: {name}");
    }
}

#[test]
fn block_layout_vectors_byte_identical() {
    let g = golden();
    let key = key32(&g);
    let file_data = hex::decode(g["inputs"]["fileDataHex"].as_str().unwrap()).unwrap();
    for b in g["blocks"].as_array().unwrap() {
        let name = b["name"].as_str().unwrap();
        let tid = b["transferId"].as_str().unwrap();
        let fid = b["fileId"].as_str().unwrap();
        let block_index = u64_of(b, "blockIndex");
        let chunk_bytes = u64_of(b, "chunkBytes");
        let block_bytes = u64_of(b, "blockBytes");
        let total = u64_of(b, "totalBytes");
        let bpo = if b["offsetScheme"].as_bool().unwrap() { b["blockPlainOffset"].as_u64() } else { None };

        let specs = plan_block(block_index, chunk_bytes, block_bytes, total, bpo);
        let want_ids: Vec<u64> = b["chunkIds"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap()).collect();
        assert_eq!(specs.iter().map(|s| s.id).collect::<Vec<_>>(), want_ids, "chunk ids: {name}");

        let wire = seal_block(&key, tid, fid, &specs, &file_data);
        assert_eq!(hex::encode(&wire), b["wireHex"].as_str().unwrap(), "block wire: {name}");

        // split + open round-trips to the exact plaintext regions
        for (off, plain) in open_block(&key, tid, fid, &specs, &wire).unwrap() {
            assert_eq!(plain, file_data[off as usize..off as usize + plain.len()], "block open: {name}");
        }
    }
}

#[test]
fn lan_frames_byte_identical() {
    let g = golden();
    let key = key32(&g);
    let file_data = hex::decode(g["inputs"]["fileDataHex"].as_str().unwrap()).unwrap();
    let cb = g["inputs"]["chunkBytes"].as_u64().unwrap();
    let lan = &g["lan"];
    let tid = lan["transferId"].as_str().unwrap();
    let fid = lan["fileId"].as_str().unwrap();
    let total = lan["totalBytes"].as_u64().unwrap();
    let cc = chunk_count(total, cb);
    assert_eq!(cc, lan["chunkCount"].as_u64().unwrap(), "chunk count");

    let mut frames = Vec::new();
    for gi in 0..cc {
        let off = gi * cb;
        let len = cb.min(total - off) as usize;
        let ct = seal_chunk(&key, tid, fid, gi, &file_data[off as usize..off as usize + len]);
        frames.extend_from_slice(&(gi as i32).to_be_bytes());
        frames.extend_from_slice(&(ct.len() as i32).to_be_bytes());
        frames.extend_from_slice(&ct);
    }
    assert_eq!(hex::encode(&frames), lan["framesHex"].as_str().unwrap(), "LAN frames");
}

#[test]
fn block_from_file_matches_vectors_and_round_trips() {
    let g = golden();
    let key = key32(&g);
    let file_data = hex::decode(g["inputs"]["fileDataHex"].as_str().unwrap()).unwrap();

    let mut src = std::env::temp_dir();
    src.push(format!("vbcore-blk-src-{}.bin", std::process::id()));
    std::fs::write(&src, &file_data).unwrap();
    let src = src.to_string_lossy().into_owned();

    for b in g["blocks"].as_array().unwrap() {
        let tid = b["transferId"].as_str().unwrap();
        let fid = b["fileId"].as_str().unwrap();
        let bi = u64_of(b, "blockIndex");
        let cb = u64_of(b, "chunkBytes");
        let bb = u64_of(b, "blockBytes");
        let total = u64_of(b, "totalBytes");
        let bpo = if b["offsetScheme"].as_bool().unwrap() { b["blockPlainOffset"].as_u64() } else { None };

        // seal from the file == the golden block wire
        let ct = vaultbeam_core::fileio::seal_block_from_file(&src, &key, tid, fid, bi, cb, bb, total, bpo).unwrap();
        assert_eq!(hex::encode(&ct), b["wireHex"].as_str().unwrap(), "seal_block_from_file: {}", b["name"]);

        // write that body into a fresh prealloc'd dst → the plaintext regions match
        let mut dst = std::env::temp_dir();
        dst.push(format!("vbcore-blk-dst-{}-{bi}.bin", std::process::id()));
        let dst = dst.to_string_lossy().into_owned();
        vaultbeam_core::fileio::prealloc(&dst, total).unwrap();
        let n = vaultbeam_core::fileio::write_block_from_body(&dst, &key, tid, fid, bi, cb, bb, total, bpo, &ct).unwrap();
        assert!(n > 0);
        let written = std::fs::read(&dst).unwrap();
        for spec in vaultbeam_core::chunk::plan_block(bi, cb, bb, total, bpo) {
            let o = spec.plain_offset as usize;
            assert_eq!(written[o..o + spec.plain_len], file_data[o..o + spec.plain_len], "block open write: {}", b["name"]);
        }
        vaultbeam_core::fileio::delete_file(&dst);
    }
    vaultbeam_core::fileio::delete_file(&src);
}

#[test]
fn sha256_vector() {
    let g = golden();
    let data = hex::decode(g["sha256"]["dataHex"].as_str().unwrap()).unwrap();
    assert_eq!(hex::encode(Sha256::digest(&data)), g["sha256"]["hex"].as_str().unwrap());
}
