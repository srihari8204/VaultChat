## Purpose

Makes a VaultBeam transfer a single continuous session that outlives the transport carrying
it. LAN, WebRTC P2P, TURN and the Cloudflare R2 relay become interchangeable drivers over
one canonical chunk grid and one shared, monotonic pair of bitmaps, so switching transport —
for any reason, at any point, in either direction — never restarts, never duplicates, and
never moves the progress bar backwards.

## ADDED Requirements

### Requirement: Single transfer session
The system SHALL maintain exactly one transfer session per transfer, identified by one
`transferId`, one `fileId`, one per-transfer key `K_t`, and one manifest, for the whole life
of the transfer. Changing transport SHALL NOT create a new session, a new upload, or a new
relay row, and SHALL NOT re-mint any identifier or key.

#### Scenario: Transport change preserves identity
- **WHEN** a transfer moves from P2P to the R2 relay mid-flight
- **THEN** the `transferId`, `fileId`, `K_t`, manifest and `vb_transfer` row are the same as
  before the change, and no second session exists in the registry

#### Scenario: One session per transferId
- **WHEN** an auto-download and a manual Accept target the same `transferId` concurrently
- **THEN** exactly one session runs, and the second call is a no-op

### Requirement: Canonical chunk grid
The system SHALL use a single chunk grid across every transport: chunk size fixed at
512 KiB, chunk index `g = plaintextOffset / 512 KiB`, and chunk identity `g` binding the
AES-256-GCM nonce and AAD. Adaptive geometry SHALL vary only how many canonical chunks are
packed into one relay object, never the chunk size or identity.

#### Scenario: Same chunk identity on every transport
- **WHEN** chunk `g` is sealed for the LAN, P2P and relay transports
- **THEN** all three use nonce `4B(transferId) ‖ u64_be(g)` and AAD
  `"<transferId>|<fileId>|<g>"`

#### Scenario: Throughput change repacks blocks, not chunks
- **WHEN** measured throughput drops mid-transfer and the next segment selects a smaller
  block size
- **THEN** the block holds fewer canonical chunks, and every chunk keeps its 512 KiB size
  and its identity

### Requirement: Shared progress state
The system SHALL maintain, per session, a receiver-authoritative `PeerHave` bitmap and a
server-authoritative `R2Have` bitmap, and SHALL derive all progress from `PeerHave` alone as
verified bytes. Progress SHALL NOT be derived from bytes queued, buffered, requested, or
staged. `PeerHave` SHALL be monotonic — no code path may clear a set bit.

#### Scenario: Progress never resets on transport change
- **WHEN** a direct tier fails at 90 % and the relay takes over
- **THEN** the reported progress on both devices stays at 90 % and continues upward

#### Scenario: Buffered bytes are not progress
- **WHEN** the sender has pushed chunks into the SCTP buffer that the receiver has not yet
  verified
- **THEN** those bytes are excluded from the reported progress

#### Scenario: Progress survives a restart
- **WHEN** the app is killed and relaunched mid-transfer
- **THEN** the restored progress equals the verified bytes recorded before the kill

### Requirement: Work-list derivation excludes delivered chunks
The system SHALL derive the sender's work-list as `¬PeerHave ∧ ¬R2Have ∧ ¬inflight` in
ascending chunk order, and the receiver's as
`¬PeerHave ∧ (R2Have ∨ peerOffering) ∧ ¬inflight`. A chunk in `PeerHave` SHALL be treated as
immutable and SHALL NOT be re-encrypted, re-uploaded, re-downloaded or re-written on any
transport.

#### Scenario: Verified chunks are never re-uploaded
- **WHEN** the receiver has verified chunks 0–1000 over P2P and the session falls back to
  the relay
- **THEN** the sender uploads only chunks 1001 onward

#### Scenario: Lost final acknowledgement costs nothing
- **WHEN** the receiver has verified every chunk but the sender's final delivery ack is lost
- **THEN** the derived work-list is empty and the session completes without transferring any
  further bytes

#### Scenario: Missing tail is sent first
- **WHEN** the receiver already holds a contiguous prefix and the relay driver starts
- **THEN** the first chunk uploaded is one the receiver is missing, not one it already holds

### Requirement: Bitmap publication and merge
The receiver SHALL publish `PeerHave` live over a sealed `vaultbeam_have` signaling event and
durably through `POST /vaultbeam/relay/received`, which the sender SHALL read from
`GET /vaultbeam/relay/:transferId`. All merges SHALL be union-only, so a stale, duplicated or
out-of-order mask can never clear a bit.

#### Scenario: Sender learns delivered chunks while offline peer state changes
- **WHEN** the sender resumes a transfer after the peer has downloaded more chunks
- **THEN** the sender reads the persisted `recv_mask` and excludes those chunks from its
  work-list

#### Scenario: Stale mask is harmless
- **WHEN** an older `PeerHave` mask arrives after a newer one
- **THEN** the merged bitmap retains every bit set by the newer mask

### Requirement: Transport driver independence
Every transport SHALL be a driver that reports verified chunks to the session and SHALL NOT
maintain its own progress state, byte counters, completion totals, or transport-selection
logic. A driver SHALL report a chunk verified only after it is GCM-verified, written at its
offset, and durable. Adding a transport SHALL require no change to the session state model.

#### Scenario: Driver holds no progress
- **WHEN** a driver is disposed and replaced mid-transfer
- **THEN** no progress information is lost, because the session held all of it

#### Scenario: TURN is not a separate transport
- **WHEN** ICE selects a TURN relay candidate pair for the datachannel
- **THEN** the session state and progress accounting are identical to a direct pair

### Requirement: Fallback and re-promotion without restart
On driver failure the system SHALL demote that driver with a cooldown, keep the session
active, re-derive the work-list from the bitmaps, and continue on the next available driver.
When a cheaper driver becomes available again the system SHALL re-promote it and continue
from the current work-list. Transport exhaustion SHALL NOT be a terminal state; the session
SHALL park and retry.

#### Scenario: P2P to relay
- **WHEN** the P2P datachannel stalls
- **THEN** the relay driver continues the same session from the current bitmaps with no
  reset and no duplicate transfer

#### Scenario: Relay to P2P
- **WHEN** the peer comes back online during a relay transfer
- **THEN** the P2P driver resumes from the current work-list, and chunks already staged on
  R2 are not re-sent over P2P

#### Scenario: No transport available
- **WHEN** every driver is unavailable and the work-list is non-empty
- **THEN** the session stays active with a retry timer rather than failing

### Requirement: Crash and reboot recovery
The system SHALL persist session identity, both bitmaps, and the sender's source-file
reference to op-sqlite, flushing on every transport change, pause, terminal state and
background transition. On launch the system SHALL restore each non-terminal session and
continue from the last verified chunk.

#### Scenario: Resume after app kill
- **WHEN** the app is killed mid-transfer and relaunched
- **THEN** the session resumes from the persisted bitmaps without re-transferring verified
  chunks

#### Scenario: Source file evicted
- **WHEN** a sender's cached source file is missing, or its size or mtime no longer match the
  session
- **THEN** the session fails with a clear reason rather than uploading mismatched bytes

#### Scenario: Destination file survives
- **WHEN** a receiver resumes after a kill
- **THEN** previously written regions of the preallocated destination file are retained and
  not rewritten

### Requirement: Failed-chunk retry isolation
The system SHALL retry only failed chunks, with bounded backoff inside the driver, and SHALL
NOT fail or restart the session because individual chunks failed. A failed chunk SHALL be
removed from the in-flight set and returned to the work-list. The session SHALL fail only on
unrecoverable conditions such as authentication failure, a transfer marked gone, or
insufficient storage.

#### Scenario: Transient block failure
- **WHEN** a block upload fails with a network error
- **THEN** only that block's chunks return to the work-list and are retried, and no other
  chunk is affected

#### Scenario: Integrity failure does not restart the file
- **WHEN** a chunk fails its GCM verification
- **THEN** that chunk is discarded and re-requested, and verified chunks are untouched

### Requirement: Single worker per role
The system SHALL run at most one upload worker, one download worker, one active transport
driver, and one transport controller per transfer, and SHALL release every listener, timer,
socket and native subscription when a driver is disposed.

#### Scenario: Repeated fallback does not accumulate resources
- **WHEN** a session cycles between transports many times
- **THEN** socket listener, timer and native subscription counts return to their steady-state
  values after each cycle

#### Scenario: Completed chunks are never re-encrypted
- **WHEN** a session switches transport
- **THEN** no chunk in `PeerHave` is read from disk or encrypted again
