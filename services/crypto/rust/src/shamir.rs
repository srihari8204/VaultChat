//! Byte-compatible port of `services/crypto/shamir.ts` — Shamir SSS over
//! GF(2^8), AES reduction polynomial 0x11b, generator 0x03.
//!
//! Share wire format (frozen): `VCSS1-<k>-<group4>-<idx2>-<payloadHex>`,
//! uppercased. Error messages mirror the TS strings (the UI shows them).

use zeroize::Zeroize;

use crate::{err, CryptoError, Res};

// ── GF(2^8) log/exp tables (generator 3, reduction 0x11b) ──────────────

const fn gmul_slow(a: u8, b: u8) -> u8 {
    let mut p = 0u8;
    let mut a = a;
    let mut b = b;
    while b != 0 {
        if b & 1 != 0 {
            p ^= a;
        }
        let hi = a & 0x80;
        a <<= 1;
        if hi != 0 {
            a ^= 0x1b;
        }
        b >>= 1;
    }
    p
}

const fn build_tables() -> ([u8; 512], [u8; 256]) {
    let mut exp = [0u8; 512];
    let mut log = [0u8; 256];
    let mut x: u8 = 1;
    let mut i = 0;
    while i < 255 {
        exp[i] = x;
        log[x as usize] = i as u8;
        x = gmul_slow(x, 3);
        i += 1;
    }
    let mut j = 255;
    while j < 512 {
        exp[j] = exp[j - 255];
        j += 1;
    }
    (exp, log)
}

const TABLES: ([u8; 512], [u8; 256]) = build_tables();

fn gmul(a: u8, b: u8) -> u8 {
    if a == 0 || b == 0 {
        0
    } else {
        TABLES.0[TABLES.1[a as usize] as usize + TABLES.1[b as usize] as usize]
    }
}
fn ginv(a: u8) -> u8 {
    TABLES.0[255 - TABLES.1[a as usize] as usize]
}

/// Horner evaluation of a polynomial (coeffs[0] = constant term) at x.
fn eval_poly(coeffs: &[u8], x: u8) -> u8 {
    let mut r = 0u8;
    let mut i = coeffs.len();
    while i > 0 {
        i -= 1;
        r = gmul(r, x) ^ coeffs[i];
    }
    r
}

fn h2(n: u8) -> String {
    format!("{n:02x}")
}

// ── split ──────────────────────────────────────────────────────────────

/// Split `secret` into `n` shares with threshold `k` (2 <= k <= n <= 255).
/// Randomized — coverage is round-trip/interop, not byte vectors.
pub fn split_secret(secret: &[u8], n: u32, k: u32) -> Res<Vec<String>> {
    if secret.is_empty() {
        return err("Secret must be non-empty");
    }
    if k < 2 {
        return err("Threshold k must be at least 2");
    }
    if n < k {
        return err("Share count n must be >= threshold k");
    }
    if n > 255 {
        return err("At most 255 shares");
    }
    let n = n as usize;
    let k = k as usize;

    let mut group = [0u8; 2];
    getrandom::getrandom(&mut group).expect("OS RNG unavailable");
    let group_hex = hex::encode(group);

    let mut payloads: Vec<Vec<u8>> = vec![vec![0u8; secret.len()]; n];
    let mut coeffs = vec![0u8; k];
    for (b, &sb) in secret.iter().enumerate() {
        coeffs[0] = sb;
        getrandom::getrandom(&mut coeffs[1..]).expect("OS RNG unavailable");
        for (si, payload) in payloads.iter_mut().enumerate() {
            payload[b] = eval_poly(&coeffs, (si + 1) as u8);
        }
    }
    coeffs.zeroize();

    let shares = payloads
        .iter()
        .enumerate()
        .map(|(si, p)| {
            format!("VCSS1-{}-{}-{}-{}", k, group_hex, h2((si + 1) as u8), hex::encode(p))
                .to_uppercase()
        })
        .collect();
    for p in payloads.iter_mut() {
        p.zeroize();
    }
    Ok(shares)
}

// ── parse / combine ────────────────────────────────────────────────────

struct ParsedShare {
    k: u32,
    group: String,
    x: u8,
    payload: Vec<u8>,
}

fn parse_share(raw: &str) -> Res<ParsedShare> {
    let s = raw.trim().to_uppercase();
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() != 5 || parts[0] != "VCSS1" {
        return err("Not a VaultChat recovery share");
    }
    let k: u32 = parts[1].parse().map_err(|_| CryptoError("Bad share (threshold)".into()))?;
    if k < 2 {
        return err("Bad share (threshold)");
    }
    let group = parts[2].to_lowercase();
    let x = u32::from_str_radix(parts[3], 16).map_err(|_| CryptoError("Bad share (index)".into()))?;
    if !(1..=255).contains(&x) {
        return err("Bad share (index)");
    }
    let payload =
        hex::decode(parts[4].to_lowercase()).map_err(|_| CryptoError("Bad share (empty)".into()))?;
    if payload.is_empty() {
        return err("Bad share (empty)");
    }
    Ok(ParsedShare { k, group, x: x as u8, payload })
}

/// Threshold declared by a single share — lets the UI say "need K of these".
pub fn share_threshold(raw: &str) -> Res<u32> {
    Ok(parse_share(raw)?.k)
}

/// Reconstruct the secret from >= k shares of the same split (Lagrange at x=0).
pub fn combine_shares(raw_shares: &[String]) -> Res<Vec<u8>> {
    let mut parsed = Vec::with_capacity(raw_shares.len());
    for r in raw_shares {
        parsed.push(parse_share(r)?);
    }
    if parsed.is_empty() {
        return err("No shares provided");
    }

    let group = parsed[0].group.clone();
    let len = parsed[0].payload.len();
    let k = parsed[0].k;
    for p in &parsed {
        if p.group != group {
            return err("These shares are from different backups — they don’t match");
        }
        if p.payload.len() != len {
            return err("Share lengths differ — one is corrupted");
        }
    }
    let mut seen = std::collections::HashSet::new();
    for p in &parsed {
        if !seen.insert(p.x) {
            return err("Duplicate share — enter different shares");
        }
    }
    if (parsed.len() as u32) < k {
        return err(format!("Need at least {} shares — you have {}", k, parsed.len()));
    }

    let xs: Vec<u8> = parsed.iter().map(|p| p.x).collect();
    let mut out = vec![0u8; len];
    for (b, ob) in out.iter_mut().enumerate() {
        let mut acc = 0u8;
        for i in 0..parsed.len() {
            let yi = parsed[i].payload[b];
            let mut num = 1u8;
            let mut den = 1u8;
            for (j, &xj) in xs.iter().enumerate() {
                if j == i {
                    continue;
                }
                num = gmul(num, xj); // (0 - xj) == xj in GF(2^8)
                den = gmul(den, xs[i] ^ xj); // (xi - xj) == xi ^ xj
            }
            acc ^= gmul(yi, gmul(num, ginv(den)));
        }
        *ob = acc;
    }
    for p in parsed.iter_mut() {
        p.payload.zeroize();
    }
    Ok(out)
}
