# VaultChat real E2EE — core + integration plan

`services/crypto/e2ee.ts` is the **genuine** end-to-end-encryption core: real
X3DH key agreement + Double Ratchet, built on audited pure-JS primitives
(`@noble/curves`, `@noble/hashes`, `@noble/ciphers`). It replaces the fake
skeleton in `services/doubleRatchetService.ts`, whose `dhExchange` was HMAC
(not Diffie–Hellman) and therefore provided **no** confidentiality.

Because it is pure JS, the same code runs in Node (where it is tested) and in
Hermes/React Native — no native module, no Node↔RN crypto divergence.

## Status: WIRED behind a default-OFF flag (bundle-verified, awaiting device test)

Built + Node-tested (47/47 across four suites) and now **wired into the live
seam behind `E2EE_ENABLED` (constants/flags.ts), which is `false`**. With the
flag off the message path is byte-identical to pre-E2EE and none of the crypto
runs at runtime (it's lazy-imported inside the enabled branch). `expo export`
confirms the whole crypto chain bundles cleanly in Metro (noble v2 subpath
exports resolve; Hermes compiles it). Remaining before flipping the flag on:
search index, group sender-keys, attachment encryption, and a two-device
round-trip on real hardware.

| Module | What | Tested by |
|--------|------|-----------|
| `e2ee.ts` | X3DH + Double Ratchet core | `e2ee.selftest.ts` (14) |
| `e2eeSession.ts` | identity/session manager (pure, injectable) | `e2eeSession.selftest.ts` (15) |
| `e2eeStorage.ts` | chunked KV (SecureStore 2 KB-cap workaround) | `e2eeStorage.selftest.ts` (11) |
| `messageStore.ts` | plaintext cache + per-peer serialization lock | `messageStore.selftest.ts` (7) |
| `e2eeSession.rn.ts` | RN bindings + `e2eeEncrypt`/`e2eeDecrypt` glue | (RN-only; composes tested logic) |

Seam touch-points: `lib/chatService.ts` (`encryptForChat`/`decryptFromChat`,
`chatId→peer` cache, own-plaintext caching), `lib/messageQueue.ts` (cache on
queued send), `app/chat.tsx` (passes messageId to decrypt; provisions the key
bundle on chat open).

### ⚠️ The hard remaining piece: a local plaintext message store

The seam swap is **not** just `encryptForChat`/`decryptFromChat`. A forward-secret
ratchet means you **cannot** recover plaintext you already sent, nor re-decrypt
old messages on reload (the chain has advanced, keys are erased). So the app
needs a **local, on-device plaintext message store** (keyed by message id):
write plaintext on send (local echo) and on first successful decrypt; render
history from it; the server only ever holds ciphertext + the ratchet header.
Without this, own-sent bubbles and reloaded history render as undecryptable.
This is the main architectural work left and is why wiring is a dedicated,
device-tested session — not a flag flip.

## Run the self-test

```bash
# Node ≥ 22 (native TS):
node --experimental-strip-types services/crypto/e2ee.selftest.ts

# Any Node 18–20 (transpile via the backend's esbuild):
node -e "require('./vaultchat-backend/node_modules/esbuild').buildSync({entryPoints:['services/crypto/e2ee.selftest.ts'],bundle:true,platform:'node',format:'cjs',outfile:'services/crypto/_selftest.cjs'})" && node services/crypto/_selftest.cjs && rm services/crypto/_selftest.cjs
```

Covers: X3DH SK agreement (±OPK), forged-prekey rejection, bidirectional
ratcheting, distinct per-message keys, out-of-order delivery, AEAD tamper
rejection, wrong-recipient confidentiality, state serialization, wire encode.
All 14 currently pass.

## Wiring plan (the remaining work)

1. **Identity provisioning.** On first login, generate IK (X25519), a signing
   key (Ed25519), an SPK (X25519, signed), and a batch of OPKs. Upload publics
   via the live `POST /user/keybundle`; keep privates in SecureStore. Confirm
   the backend bundle field names map to `PreKeyBundle` (identityKey,
   signingKey, signedPreKey, signedPreKeySig, oneTimePreKey[+id]) — adjust the
   adapter, **not** the routes (they store opaque blobs).
2. **Session bootstrap.** First message to a peer: `GET /user/:id/keybundle`
   → `x3dhInitiator` → `ratchetInitAlice`. Send the `InitialHeader`
   (ephemeral + IK + consumed OPK id) in `meta.x3dh` alongside the first
   `encodeEnvelope(...)` ciphertext. Receiver runs `x3dhResponder` +
   `ratchetInitBob` on first inbound message.
3. **Seam swap.** Implement `encryptForChat`/`decryptFromChat` over a
   per-(chatId, peerId) `RatchetState` persisted via `serializeState` /
   `deserializeState` in SecureStore. Keep call sites unchanged.
4. **Versioning / migration.** Mark encrypted messages (e.g. `meta.enc='dr1'`)
   so pre-E2EE plaintext history still renders. `decryptFromChat` returns
   plaintext as-is when the marker is absent.
5. **Offline queue** (`lib/messageQueue.ts`) — encrypt-on-enqueue so queued
   blobs are already ciphertext; the ratchet advance must be committed
   atomically with the enqueue to avoid key reuse.
6. **Search** (`app/search.tsx`) — server `LIKE` over `content` returns nothing
   once content is ciphertext. Switch to a local AsyncStorage index built from
   decrypted messages.
7. **Groups** — sender-keys: one symmetric chain per sender, the sender key
   distributed to members over the pairwise ratchet sessions on join.
8. **Attachments** — per-file AES-GCM; wrap the file key inside the message
   envelope.

## Security notes / not-yet-done

- **No third-party review.** Do not advertise "Signal Protocol" in the store
  listing until the wiring above is complete and independently reviewed.
- Identity model uses an X25519 IK for DH + a separate Ed25519 key for SPK
  signatures (rather than XEdDSA over a single key). Safety-number / key
  verification UI is future work.
- `MAX_SKIP` is 1000; tune against expected out-of-order windows.
- No replay cache beyond the ratchet’s own monotonic chain semantics; the
  transport (authenticated REST + per-message AEAD) is relied on for that.

## Wiring-time gotchas (discovered 2026-06-05)

- **Metro resolution: cleared.** `metro.config.js` already sets
  `resolver.unstable_enablePackageExports = true` (Expo SDK 54), so noble v2’s
  `.js`-subpath exports (`@noble/hashes/hkdf.js`, etc.) resolve. The crypto
  modules are currently NOT reachable from the app entry, so Metro doesn’t
  bundle them yet — the first import from `chatService` is what activates them.
- **SecureStore size limit.** expo-secure-store warns/fails above ~2048 bytes
  per value (Android). The identity blob with a 20-key OTPK pool (~5 KB) will
  NOT fit in one item. Storage strategy for the RN bindings:
  - long-term identity (IK/signing/SPK privates + SPK sig/id): one SecureStore
    item (small, must stay encrypted-at-rest);
  - OTPK private pool: chunk across multiple SecureStore items (e.g. 1 key per
    item, or batches of ≤5), or a smaller `OPK_BATCH`;
  - per-peer ratchet session: one SecureStore item per peer (bounded — prune
    `MKSKIPPED`); large skipped-key sets may also need chunking.
  Do NOT fall back to plain AsyncStorage for any private key (not encrypted).
- **Verification gates before enabling** (cannot be done headless): run
  `npx expo export --platform android` to confirm Metro bundles the noble
  imports, then an on-device round-trip between two real installs before
  flipping the seam from plaintext to E2EE. Ship the seam behind a default-OFF
  flag first.
/