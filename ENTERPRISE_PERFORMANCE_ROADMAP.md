# VaultChat Enterprise Performance Roadmap
## Vision 2030: 100M-1B Users, Near-Zero Latency, Offline-First

**Focus:** Maximum performance without budget constraints  
**Target Scale:** 100M concurrent users globally  
**Timeline:** 24-36 months to production-ready  
**Performance Goals:** <100ms message latency, <500ms startup, 99.99% uptime

---

## Executive Summary: Current vs. Enterprise Vision

### Current Architecture (Phase 1)
```
Strengths:
✅ Socket.IO proven for realtime
✅ Go backend started (migration from Node)
✅ PostgreSQL + Redis foundation
✅ E2EE cryptography implemented
✅ Kafka infrastructure built

Gaps:
❌ JSON serialization (60% bandwidth waste)
❌ No Vault Protocol (using Socket.IO framing)
❌ Multi-socket risk (potential for feature creep)
❌ No channel multiplexing (flat priority model)
❌ Async storage (no SQLite queue, unbounded memory)
❌ No per-chat delta sync (full resync on reconnect)
❌ No Rust native performance layer
❌ No geographic distribution
❌ No database sharding
❌ Single region only
```

### Enterprise Vision (Phase 10)
```
✅ Protocol Buffers mandatory
✅ Vault Protocol custom layer
✅ Single connection + 8 logical channels
✅ One heartbeat for all subsystems
✅ Offline-first SQLite queue
✅ Per-chat delta sync
✅ Rust for compute-intensive tasks
✅ Global geographic distribution
✅ Database sharding (chat_id hash)
✅ Multi-region active-active
```

---

## Phase-by-Phase Transformation Plan

### PHASE 1: Foundation (Weeks 1-8) — 10K Users

**Goal:** Establish clean architecture for enterprise scale

#### 1.1 Implement SQLite Queue Layer
- Replace AsyncStorage with SQLite for message queue
- Implement bounded storage (1GB max per device)
- Add transaction support
- Create queue state machine: `queued → sending → sent → failed → archived`

**Implementation:**
```typescript
// lib/db/messageQueue.ts
interface QueuedMessage {
  id: string;           // clientId for idempotency
  chatId: string;
  content: string;
  encryption: EncryptionMetadata;
  timestamp: number;
  status: 'queued' | 'sending' | 'sent' | 'failed';
  retryCount: number;
  createdAt: number;
  expiresAt: number;    // 30-day TTL
}

CREATE TABLE message_queue (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  content BLOB NOT NULL,
  encryption_key_version INTEGER,
  timestamp INTEGER,
  status TEXT,
  retry_count INTEGER DEFAULT 0,
  created_at INTEGER,
  expires_at INTEGER,
  INDEX (chat_id, status, created_at)
);
```

**Performance target:** <5ms insert, <10ms query for 1000 queued items

#### 1.2 Implement Per-Chat Delta Sync
- Replace global sync cursor with per-chat cursor
- Reduce reconnect sync from 5-10s to 500-1000ms
- Schema:
```sql
CREATE TABLE sync_cursor (
  chat_id TEXT PRIMARY KEY,
  last_message_id TEXT,
  last_synced_at INTEGER,
  pending_count INTEGER,
  INDEX (last_synced_at)
);
```

**Sync algorithm:**
```
On reconnect:
1. FOR EACH chat_id WHERE pending_count > 0:
   2. GET last_message_id from sync_cursor
   3. Fetch messages after cursor (batch 50)
   4. Apply deltas (edits, deletes, reactions)
   5. Update sync_cursor
   6. Render dirty chats
7. Parallel: Background sync remaining chats
```

**Performance target:** Reconnect with 100 chats = 500ms (vs 10s currently)

#### 1.3 Clean Architecture: Remove Multi-Socket Anti-Pattern
- Audit codebase for multiple socket.io listeners
- Consolidate into single shared socket instance
- Establish socket ownership rules
- No module should create `io.on()` listeners (use event bus instead)

**Target:** Single socket.io instance, 0 unauthorized listeners

#### 1.4 Network State Detection
Implement 4-state machine:
```typescript
type NetworkState = 'offline' | 'slow' | 'online' | 'fast';

interface NetworkQuality {
  state: NetworkState;
  latency: number;        // ms
  bandwidth: number;      // Mbps (estimated)
  jitter: number;         // ms
  packetLoss: number;     // %
}

// State transitions
OFFLINE  → ONLINE  (socket connects successfully)
ONLINE   → SLOW    (latency > 150ms OR packet loss > 1%)
SLOW     → ONLINE  (latency < 100ms AND packet loss < 0.1%)
ONLINE   → OFFLINE (socket timeout 30s)
```

**Impact:**
- Adaptive retry backoff based on network quality
- UI indicators (connection strength)
- Disable video auto-play on slow networks
- Compress media based on bandwidth

---

### PHASE 2: Protocol & Serialization (Weeks 9-16) — 30K Users

**Goal:** Replace JSON with binary protocol, establish Vault Protocol layer

#### 2.1 Protocol Buffers Migration (Complete)
Define proto for all 75 Socket.IO events:

```protobuf
// vault/messages.proto
syntax = "proto3";

package vault.messages;

message TextMessage {
  string id = 1;
  string chat_id = 2;
  string sender_id = 3;
  bytes content = 4;        // E2EE encrypted
  int64 timestamp = 5;
  EncryptionMetadata encryption = 6;
  string reply_to_id = 7;
  repeated Reaction reactions = 8;
  int32 edit_count = 9;
  bool is_deleted = 10;
}

message EncryptionMetadata {
  int32 key_version = 1;
  bytes nonce = 2;
  string algorithm = 3;     // "AES-256-GCM", "ChaCha20-Poly1305"
  int32 salt_rounds = 4;
}

message VaultMessage {
  int32 channel_id = 1;      // 1-8
  int32 priority = 2;        // 0-255
  string message_type = 3;   // "message", "typing", "presence", etc
  bytes payload = 4;         // Actual message (encrypted if needed)
  string correlation_id = 5; // For request-response matching
  bool requires_ack = 6;
  int32 sequence_number = 7; // For ordering within channel
}
```

**Migration strategy:**
- Phase 2a: Dual-stack (JSON → Protobuf conversion layer)
- Phase 2b: Gradual client rollout (10% → 50% → 100%)
- Phase 2c: Server-side Protobuf only
- Phase 2d: Remove JSON support

**Performance gain:** 60% payload reduction (200 bytes → 80 bytes avg)

#### 2.2 Vault Protocol Layer
Custom application protocol on top of Protobuf WebSocket:

```typescript
// Structure: [FRAME_HEADER (14 bytes)] [VAULT_MESSAGE (protobuf)] [CHECKSUM (4 bytes)]

interface VaultFrameHeader {
  version: 2,              // 1 byte (0x02)
  channelId: 1-8,          // 1 byte (multiplexing)
  priority: 0-255,         // 1 byte
  flags: {
    requiresAck: 1 bit,
    isEncrypted: 1 bit,
    isCompressed: 1 bit,
    isRetry: 1 bit,
    reserved: 4 bits
  },
  sequenceNumber: 0-65535, // 2 bytes
  payloadLength: 0-1MB,    // 4 bytes (varint encoded, typically 2-3 bytes)
  timestampDelta: int32,   // 4 bytes (timestamp - last_timestamp for compression)
  checksum: uint32         // CRC32 of payload
}

Total header: 14-16 bytes (vs 50+ bytes Socket.IO)
```

**Responsibilities:**
- Message framing ✅
- Channel multiplexing ✅
- Priority queuing ✅
- ACK/NACK tracking ✅
- Sequence guarantees (per channel) ✅
- Compression negotiation ✅
- Version negotiation ✅
- Authentication metadata ✅
- Flow control (backpressure) ✅
- Retry metadata ✅

**Channel definitions:**
```
Channel 1: Messaging      (Priority: 200-255, Ordered, Reliable)
Channel 2: Calls          (Priority: 180-220, Ordered, Real-time)
Channel 3: Presence       (Priority: 50-100, Unordered, Best-effort)
Channel 4: Notifications  (Priority: 100-150, Ordered, Reliable)
Channel 5: Sync           (Priority: 160-180, Ordered, Reliable)
Channel 6: File Transfer  (Priority: 140-160, Ordered, Reliable)
Channel 7: AI             (Priority: 20-50, Unordered, Best-effort)
Channel 8: Admin          (Priority: 240-255, Ordered, Reliable)
```

**Performance targets:**
- Frame parsing: <1ms for 1000 frames
- Serialization: 280 MB/s (vs 100 MB/s JSON)
- Deserialization: 450 MB/s (vs 80 MB/s JSON)

#### 2.3 WebSocket Transport (Raw)
Migrate from Socket.IO to raw WebSocket for lower overhead:

```typescript
// Current: Socket.IO frame ~50+ bytes overhead
// New: Vault Protocol frame ~14 bytes overhead

// Connection lifecycle:
1. WebSocket.open()
2. Send VAULT_HANDSHAKE (channel 8, version negotiation)
3. Server responds VAULT_HANDSHAKE_ACK
4. Send AUTH (channel 8, JWT + device info)
5. Server responds AUTH_ACK
6. Ready for messaging

// On disconnect:
1. Close code 4000 = normal, 4001 = auth failed, 4002 = version mismatch
2. Client auto-reconnects with exponential backoff
```

**Benefits:**
- 50-byte frame overhead → 14 bytes
- Total message: 230 bytes → 94 bytes (60% reduction)
- Bandwidth at 100M concurrent: 1.5B msg/day = 140 TB/day JSON → 56 TB/day Protobuf

---

### PHASE 3: Startup & Offline Performance (Weeks 17-24) — 100K Users

**Goal:** <300ms chat list, <500ms usable, zero network waits

#### 3.1 Startup Critical Path
Target: Chats visible in 300ms

```
Timeline:
0-50ms:     App init, security scan (async Sentry)
50-100ms:   SecureStore read (JWT, MFA flag, parallel)
100-150ms:  SQLite open + schema migration
150-200ms:  Load cache from MMKV (chat list, unread counts)
200-250ms:  Render skeleton + cached chats
250-300ms:  Socket connection started (async)
300ms:      CHATS VISIBLE (from local cache)
            ↓
300-500ms:  Background: Fetch live unread, recent messages
500ms:      APPLICATION USABLE
            ↓
500ms-5s:   Background: Sync all chats, download media, build search index
```

**Implementation details:**

```typescript
// app/_layout.tsx - Critical path only
export default function RootLayout() {
  const [isReady, setIsReady] = useState(false);
  
  useEffect(() => {
    const init = async () => {
      // CRITICAL PATH (must complete in 250ms)
      const tasks = await Promise.all([
        SecureStore.getItemAsync('jwt'),        // 10ms
        SecureStore.getItemAsync('mfa_enabled'), // 10ms
        localDb.init(),                          // 100ms
        mmkv.getChats(),                         // 30ms
      ]);
      
      setIsReady(true); // Show cached chat list
      
      // BACKGROUND (after UI renders)
      requestAnimationFrame(() => {
        socket.connect(); // 100-300ms handshake
        syncEngine.startSync(); // Async
        mediaCache.startDownload(); // Async
      });
    };
    
    init().catch(console.error);
  }, []);
  
  if (!isReady) return <SplashScreen />;
  return <App />;
}
```

#### 3.2 Unread Count Optimization
Current: 50ms per query (GROUP BY aggregation)  
Target: <1ms per query

```sql
-- Add precomputed table
CREATE TABLE unread_counts (
  chat_id TEXT PRIMARY KEY,
  unread_count INTEGER DEFAULT 0,
  last_updated INTEGER,
  INDEX (last_updated DESC)
);

-- Update on message receipt
UPDATE unread_counts SET unread_count = unread_count + 1 
WHERE chat_id = ? AND user_id = ?;

-- Query now: instant
SELECT chat_id, unread_count FROM unread_counts 
WHERE unread_count > 0 ORDER BY last_updated DESC;
```

**Trigger-based updates:**
```sql
CREATE TRIGGER on_message_insert
AFTER INSERT ON messages
FOR EACH ROW BEGIN
  UPDATE unread_counts 
  SET unread_count = unread_count + 1,
      last_updated = NEW.timestamp
  WHERE chat_id = NEW.chat_id 
    AND user_id != NEW.sender_id;
END;
```

#### 3.3 Avatar Image Caching
Current: Refetch 20% of time  
Target: Zero refetch for 7 days

```typescript
interface AvatarCache {
  url: string;
  etag: string;
  lastCheck: number;    // timestamp
  localPath: string;
  ttl: number;          // 7 days in ms
}

// Check only every 7 days
async function getAvatar(userId: string) {
  const cached = await mmkv.getAvatar(userId);
  
  if (cached && Date.now() - cached.lastCheck < 7 * 24 * 60 * 60 * 1000) {
    return cached.localPath; // Zero network call
  }
  
  // Fetch with conditional request
  const headers = cached ? { 'If-None-Match': cached.etag } : {};
  const response = await fetch(avatarUrl, { headers });
  
  if (response.status === 304) {
    // Not modified, update timestamp
    cached.lastCheck = Date.now();
    await mmkv.setAvatar(userId, cached);
    return cached.localPath;
  }
  
  // Download and cache
  const blob = await response.blob();
  const path = await saveToCache(blob);
  await mmkv.setAvatar(userId, {
    url: avatarUrl,
    etag: response.headers.get('etag'),
    lastCheck: Date.now(),
    localPath: path,
    ttl: 7 * 24 * 60 * 60 * 1000,
  });
  
  return path;
}
```

#### 3.4 Progressive Media Loading
Never block message list scroll:

```
Priority 1: Text messages (instant)
Priority 2: Thumbnail (50x50, <10KB, <50ms)
Priority 3: Preview (200x200, <50KB, <200ms)
Priority 4: Full image (background, can take seconds)
Priority 5: Video (download background, stream on tap)

Scroll performance:
- Message list renders skeleton + thumbnails
- Scrolling never waits for images
- Images load asynchronously
- Preview shows as user scrolls past
- Full image loads on tap
```

**Implementation:**
```typescript
// components/Message.tsx
export function Message({ message }: Props) {
  const [thumbnail, setThumbnail] = useState<string>();
  const [preview, setPreview] = useState<string>();
  const [fullImage, setFullImage] = useState<string>();
  
  // FAST: Render message text + skeleton immediately
  return (
    <View>
      <Text>{message.text}</Text>
      
      {message.hasImage && (
        <View style={{ width: 200, height: 200, backgroundColor: '#ddd' }}>
          {/* Thumbnail or preview or full */}
          <Image source={{ uri: fullImage || preview || thumbnail }} />
        </View>
      )}
    </View>
  );
  
  // SLOW: Load images in background
  useEffect(() => {
    // Load thumbnail (50x50, <10KB)
    mediaCache.getThumbnail(message.imageId)
      .then(setThumbnail);
    
    // Load preview (200x200, <50KB) after 500ms
    const previewTimer = setTimeout(() => {
      mediaCache.getPreview(message.imageId)
        .then(setPreview);
    }, 500);
    
    // Load full image on tap only
    
    return () => clearTimeout(previewTimer);
  }, [message.imageId]);
}
```

---

### PHASE 4: E2EE & Security (Weeks 25-32) — 300K Users

**Goal:** Enterprise-grade encryption with zero performance overhead

#### 4.1 Complete E2EE Integration
Current: Crypto module exists but not wired  
Target: All messages encrypted, transparent to user

```typescript
// lib/crypto/e2ee.ts - Wire into chatService

interface E2EESession {
  chatId: string;
  sessionKey: CryptoKey;      // AES-256-GCM key
  keyVersion: number;
  ratchetState: RatchetState; // Double Ratchet state
  spkBundle: SignedPreKeyBundle; // X3DH
}

// Send message flow
async function sendMessage(chatId: string, text: string) {
  // 1. Get/create E2EE session
  let session = await e2eeService.getSession(chatId);
  if (!session) {
    session = await e2eeService.createSession(chatId); // X3DH
  }
  
  // 2. Encrypt with current ratchet state
  const plaintext = new TextEncoder().encode(text);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    session.sessionKey,
    plaintext
  );
  
  // 3. Advance ratchet (Double Ratchet)
  session = await e2eeService.advanceRatchet(session);
  
  // 4. Send encrypted message
  const encryptedMessage = {
    content: ciphertext,
    nonce,
    keyVersion: session.keyVersion,
    ratchetPublicKey: session.ratchetPublicKey,
  };
  
  return socket.emit('message:send', {
    chatId,
    encryptedMessage,
    clientId: uuid(),
  });
}

// Receive message flow
socket.on('message:new', async (data) => {
  const { chatId, senderUserId, encryptedMessage } = data;
  
  // 1. Get sender's E2EE session
  const session = await e2eeService.getRemoteSession(
    chatId,
    senderUserId
  );
  
  // 2. Decrypt message (automatic ratchet advancement)
  const plaintext = await e2eeService.decryptMessage(
    session,
    encryptedMessage
  );
  
  // 3. Store in queue (already encrypted locally)
  await messageQueue.add({
    chatId,
    content: plaintext,
    fromUser: senderUserId,
    timestamp: Date.now(),
  });
  
  // 4. UI updates automatically
});
```

**Performance:** Encryption/decryption happens in <5ms using Rust-optimized crypto (Phase 5)

#### 4.2 Key Rotation & OPK Management
- **SPK rotation:** Every 24 hours
- **OPK pool:** Maintain 20-50 pre-generated keys
- **Ratchet advancement:** Automatic per message
- **Key derivation:** HKDF-SHA256

```typescript
// Auto-rotate SPK every 24 hours
setInterval(async () => {
  const spk = await e2eeService.generateSignedPreKey();
  await server.updateSignedPreKey(spk);
}, 24 * 60 * 60 * 1000);

// Monitor OPK pool, maintain 30-50
setInterval(async () => {
  const poolSize = await e2eeService.getOPKPoolSize();
  if (poolSize < 30) {
    const newKeys = await e2eeService.generateOPKs(20);
    await server.uploadOPKs(newKeys);
  }
}, 6 * 60 * 60 * 1000);
```

---

### PHASE 5: Rust Performance Layer (Weeks 33-40) — 1M Users

**Goal:** Native performance for compute-intensive operations

#### 5.1 Rust Native Modules
Build FFI bindings for:

```rust
// rust/src/lib.rs

// 1. Encryption (AES-256-GCM, ChaCha20-Poly1305)
pub fn encrypt_aes_256_gcm(
    plaintext: &[u8],
    key: &[u8; 32],
    nonce: &[u8; 12],
) -> Result<Vec<u8>, CryptoError>;

pub fn decrypt_aes_256_gcm(
    ciphertext: &[u8],
    key: &[u8; 32],
    nonce: &[u8; 12],
) -> Result<Vec<u8>, CryptoError>;

// 2. Hashing (SHA-256, BLAKE3)
pub fn hash_sha256(data: &[u8]) -> [u8; 32];
pub fn hash_blake3(data: &[u8]) -> [u8; 32];

// 3. HKDF key derivation
pub fn hkdf_expand(
    salt: &[u8],
    input: &[u8],
    length: usize,
) -> Vec<u8>;

// 4. Binary serialization helpers (Protobuf encode/decode)
pub fn encode_message(msg: &VaultMessage) -> Vec<u8>;
pub fn decode_message(data: &[u8]) -> Result<VaultMessage, Error>;

// 5. Compression (zstd, gzip)
pub fn compress_zstd(data: &[u8]) -> Vec<u8>;
pub fn decompress_zstd(data: &[u8]) -> Result<Vec<u8>, Error>;

// 6. File operations
pub fn encrypt_file(input: &Path, output: &Path, key: &[u8; 32]) -> Result<(), Error>;
pub fn decrypt_file(input: &Path, output: &Path, key: &[u8; 32]) -> Result<(), Error>;

// 7. Thumbnail generation
pub fn generate_thumbnail(image_data: &[u8], width: u32, height: u32) -> Vec<u8>;

// 8. Search indexing (BM25)
pub fn build_search_index(messages: Vec<Message>) -> SearchIndex;
pub fn search(index: &SearchIndex, query: &str, limit: usize) -> Vec<SearchResult>;

// 9. AI text processing (tokenization, embeddings)
pub fn tokenize_text(text: &str) -> Vec<String>;
pub fn compute_embeddings(text: &str) -> Vec<f32>;
```

**Performance gains:**
- Encryption: 100 MB/s (vs 20 MB/s in JS)
- Hashing: 500 MB/s (vs 50 MB/s)
- Compression: 800 MB/s (vs 100 MB/s)
- Thumbnail generation: 50ms per image (vs 500ms)

#### 5.2 React Native FFI Integration
```typescript
// native/rust_crypto.ts
import { NativeModules } from 'react-native';

const RustCrypto = NativeModules.RustCrypto;

export async function encryptMessage(
  plaintext: string,
  key: Uint8Array,
  nonce: Uint8Array
): Promise<Uint8Array> {
  return await RustCrypto.encryptAES256GCM(
    Buffer.from(plaintext),
    key,
    nonce
  );
}

export async function decryptMessage(
  ciphertext: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array
): Promise<string> {
  const decrypted = await RustCrypto.decryptAES256GCM(
    ciphertext,
    key,
    nonce
  );
  return Buffer.from(decrypted).toString('utf8');
}
```

---

### PHASE 6: Call System Excellence (Weeks 41-48) — 3M Users

**Goal:** Sub-2 second call setup, <100ms latency, 99.9% connection rate

#### 6.1 Enterprise WebRTC
Replace basic WebRTC with production hardened:

```typescript
interface CallConnection {
  state: 'new' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'failed';
  peerConnection: RTCPeerConnection;
  dataChannel: RTCDataChannel;
  iceGatheringState: RTCIceGatheringState;
  connectionState: RTCIceConnectionState;
  audioTrack: MediaStreamTrack;
  videoTrack: MediaStreamTrack;
  stats: {
    currentRoundTripTime: number;
    availableOutgoingBitrate: number;
    availableIncomingBitrate: number;
    fractionLost: number;
    packetsLost: number;
  };
}

class EnterpriseWebRTC {
  // Timeouts with automatic recovery
  private ICE_GATHERING_TIMEOUT = 3000;  // 3s
  private DTLS_CONNECT_TIMEOUT = 5000;   // 5s
  private OVERALL_CONNECT_TIMEOUT = 8000; // 8s
  
  async setupCall(
    remoteUserId: string,
    initiator: boolean
  ): Promise<CallConnection> {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: ['stun:stun.l.google.com:19302'] },
        // Use TURN for relay (required for enterprise)
        {
          urls: ['turn:turn.example.com:3478'],
          username: 'user',
          credential: 'password',
        },
      ],
    });
    
    // 1. Setup audio/video tracks
    const stream = await this.getMediaStream();
    stream.getTracks().forEach(track => pc.addTrack(track, stream));
    
    // 2. Setup data channel (backup messaging)
    const dc = pc.createDataChannel('backup');
    this.setupDataChannel(dc);
    
    // 3. ICE candidate handling with timeout
    const icePromise = this.gatherICECandidates(pc);
    const iceTimer = setTimeout(() => {
      console.warn('ICE gathering timeout after 3s');
      // Continue anyway - we have initial candidates
    }, this.ICE_GATHERING_TIMEOUT);
    
    // 4. Create offer/answer
    if (initiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      // Send to remote via signaling
      await this.sendSignaling('offer', offer);
    }
    
    // 5. Wait for connection with timeout
    const connected = await Promise.race([
      this.waitForConnected(pc),
      this.delay(this.OVERALL_CONNECT_TIMEOUT),
    ]);
    
    if (!connected) {
      console.error('Call connection timeout');
      // Attempt recovery (see below)
      await this.attemptRecovery(pc);
    }
    
    clearTimeout(iceTimer);
    
    return {
      state: pc.connectionState as any,
      peerConnection: pc,
      dataChannel: dc,
      iceGatheringState: pc.iceGatheringState,
      connectionState: pc.iceConnectionState,
      audioTrack: stream.getAudioTracks()[0],
      videoTrack: stream.getVideoTracks()[0],
      stats: {},
    };
  }
  
  // Automatic recovery from connection failure
  private async attemptRecovery(pc: RTCPeerConnection) {
    console.log('Attempting recovery...');
    
    // 1. Close and recreate (full restart)
    pc.close();
    
    // 2. Wait 2 seconds before retry
    await this.delay(2000);
    
    // 3. Reconnect
    return this.setupCall(this.remoteUserId, false);
  }
  
  // Network transition safety (WiFi ↔ Mobile)
  async handleNetworkTransition(from: NetworkType, to: NetworkType) {
    console.log(`Network change: ${from} → ${to}`);
    
    // Pause video on poor networks
    if (to === 'slow' || to === 'offline') {
      this.pauseVideo();
    } else if (to === 'fast') {
      this.resumeVideo();
    }
    
    // Adjust bitrate
    const bitrate = to === 'fast' ? 2000 : to === 'online' ? 800 : 300;
    await this.setBitrate(bitrate);
  }
  
  // Screen rotation safety
  async handleScreenRotation() {
    const pc = this.callConnection.peerConnection;
    
    // Pause video during rotation
    this.pauseVideo();
    
    // Get new stream
    const newStream = await this.getMediaStream();
    const newVideoTrack = newStream.getVideoTracks()[0];
    
    // Replace track
    const videoSender = pc
      .getSenders()
      .find(s => s.track?.kind === 'video');
    
    if (videoSender) {
      await videoSender.replaceTrack(newVideoTrack);
    }
    
    this.resumeVideo();
  }
  
  // Activity lifecycle protection (Android)
  async handleActivityPause() {
    // Pause video, keep audio
    this.pauseVideo();
    this.setMinimumBitrate(50); // Audio only
  }
  
  async handleActivityResume() {
    // Resume video
    this.resumeVideo();
    this.setMinimumBitrate(300);
  }
}
```

**Performance targets:**
- Call setup: <2 seconds (vs current 4-6s)
- ICE gathering: <3 seconds (with fallback to relay)
- DTLS handshake: <2 seconds
- First frame: <4 seconds total
- Latency: <100ms median (p99 <200ms)
- Reconnect: <5 seconds (automatic)

#### 6.2 Group Calls (5-50 participants)
- **<5 participants:** Full mesh (each device sends to all others)
- **5-50 participants:** SFU (Selective Forwarding Unit) - one server relays media

```typescript
interface GroupCall {
  id: string;
  initiator: string;
  participants: Map<string, ParticipantConnection>;
  maxParticipants: 50;
  sfuServer?: string; // For >5 participants
}

class ParticipantConnection {
  userId: string;
  peerConnection: RTCPeerConnection;
  audioTrack: MediaStreamTrack;
  videoTrack: MediaStreamTrack;
  screenShare?: RTCPeerConnection;
  state: 'joining' | 'connected' | 'leaving';
}

async function startGroupCall(
  chatId: string,
  initiator: string,
  participantIds: string[]
) {
  const call: GroupCall = {
    id: uuid(),
    initiator,
    participants: new Map(),
    maxParticipants: 50,
    sfuServer: participantIds.length > 5 ? await selectSFU() : undefined,
  };
  
  for (const userId of participantIds) {
    // Establish connection
    const pc = call.sfuServer
      ? await this.setupSFUConnection(call.sfuServer, userId)
      : await this.setupMeshConnection(userId);
    
    call.participants.set(userId, {
      userId,
      peerConnection: pc,
      audioTrack: null,
      videoTrack: null,
      state: 'connecting',
    });
  }
  
  return call;
}
```

---

### PHASE 7: Backend Microservices (Weeks 49-56) — 10M Users

**Goal:** Horizontally scalable, independently deployable services

#### 7.1 Microservices Architecture
```
API Gateway (Caddy/Nginx)
├── Auth Service (1-3 instances)
│   └── JWT verification, MFA, device registration
├── Messaging Service (10-50 instances)
│   └── Message send/receive, delivery tracking, reactions
├── Presence Service (2-10 instances)
│   └── Online/offline status, activity tracking
├── Call Service (5-20 instances)
│   └── Call signaling, ICE relay, TURN server
├── Upload Service (3-10 instances)
│   └── Media upload, encryption, S3
├── Download Service (3-10 instances)
│   └── Media delivery, CDN, streaming
├── Notification Service (2-10 instances)
│   └── Push notifications, delivery tracking
├── Search Service (1-5 instances)
│   └── Full-text search, indexing (Elasticsearch)
├── AI Service (1-5 instances)
│   └── Message classification, spam detection, recommendations
└── Analytics Service (1-2 instances)
    └── Event tracking, insights, reporting

Data Layer:
├── PostgreSQL (Primary + Replicas)
├── Redis Cluster (Caching + Pub/Sub)
├── Kafka (Event streaming)
├── Elasticsearch (Full-text search)
├── S3 (Object storage)
└── CDN (Content delivery)
```

**Implementation (Go microservices):**

```go
// cmd/messaging-service/main.go
package main

import (
  "github.com/go-chi/chi/v5"
  "github.com/vaultchat/messaging"
)

func main() {
  router := chi.NewRouter()
  
  // Initialize services
  messageService := messaging.NewService()
  
  // Routes
  router.Post("/messages", messageService.SendMessage)
  router.Get("/chats/{chatId}/messages", messageService.GetMessages)
  router.Patch("/messages/{id}", messageService.EditMessage)
  router.Delete("/messages/{id}", messageService.DeleteMessage)
  router.Post("/messages/{id}/reactions", messageService.AddReaction)
  
  // Start server
  http.ListenAndServe(":3000", router)
}
```

---

### PHASE 8: Database Sharding & Geographic Distribution (Weeks 57-64) — 100M Users

**Goal:** Linear scalability beyond single region, <100ms latency globally

#### 8.1 Database Sharding Strategy
Shard by `chat_id` (not user_id, to avoid hotkeys):

```sql
-- Create 8 physical shards initially (can expand to 64)
-- Shard 0-7 by hash(chat_id) % 8

CREATE TABLE messages_shard_0 (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  sender_id TEXT,
  content BYTEA,           -- Encrypted
  timestamp BIGINT,
  edit_count INTEGER DEFAULT 0,
  is_deleted BOOLEAN DEFAULT false,
  INDEX (chat_id, timestamp DESC)
);

-- Replicate each shard (3 replicas minimum)
-- Primary: US-East
-- Replica 1: US-West  (read-only)
-- Replica 2: EU       (read-only)

-- Shard routing table
CREATE TABLE shard_routing (
  chat_id TEXT PRIMARY KEY,
  shard_id INTEGER (0-7),
  created_at TIMESTAMP
);

-- When adding new shard (expansion from 8 to 16):
-- 1. Create new tables shard_8 through shard_15
-- 2. Start shadow writes (write to both old and new shard)
-- 3. Backfill existing data
-- 4. Switch reads to new shard
-- 5. Complete migration
```

#### 8.2 Geographic Distribution
- **US-East:** Primary (60% traffic)
- **US-West:** Secondary (20% traffic)
- **EU:** Secondary (15% traffic)
- **APAC:** Secondary (5% traffic)

**Multi-region setup:**
```yaml
# kubernetes/deployment-us-east.yaml
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vaultchat-messaging
  namespace: us-east-1
spec:
  replicas: 50  # Auto-scale 30-100
  selector:
    matchLabels:
      service: messaging
  template:
    metadata:
      labels:
        service: messaging
    spec:
      containers:
      - name: messaging-api
        image: vaultchat/messaging:latest
        resources:
          requests:
            memory: "1Gi"
            cpu: "1000m"
          limits:
            memory: "2Gi"
            cpu: "2000m"
        env:
        - name: DB_HOST
          value: postgres-primary.us-east-1.rds.amazonaws.com
        - name: REDIS_HOST
          value: redis-cluster.us-east-1.elasticache.amazonaws.com
        - name: REGION
          value: us-east-1
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchExpressions:
                - key: service
                  operator: In
                  values:
                  - messaging
              topologyKey: kubernetes.io/hostname
---
apiVersion: v1
kind: Service
metadata:
  name: messaging-api
  namespace: us-east-1
spec:
  type: LoadBalancer
  ports:
  - port: 443
    targetPort: 3000
  selector:
    service: messaging
```

**Connection routing:**
```
User → Global LB (GeoDNS) → Nearest region
       └─ Query DB shard routing → Route to correct shard region
       └─ Cache at region level (Redis cluster)
       └─ Fail over to secondary region if primary down
```

---

### PHASE 9: Monitoring & Observability (Weeks 65-72) — 500M Users

**Goal:** Real-time visibility, automatic anomaly detection, predictive scaling

#### 9.1 Metrics Collection
Structured metrics exported to Prometheus:

```go
// Messaging service metrics
var (
  messagesReceived = promauto.NewCounterVec(
    prometheus.CounterOpts{
      Name: "vaultchat_messages_received_total",
      Help: "Total messages received",
    },
    []string{"chat_id", "region"},
  )
  
  messageLatency = promauto.NewHistogramVec(
    prometheus.HistogramOpts{
      Name: "vaultchat_message_latency_seconds",
      Help: "Message delivery latency",
      Buckets: []float64{.001, .005, .01, .05, .1, .5, 1.0},
    },
    []string{"region"},
  )
  
  connectionTime = promauto.NewHistogramVec(
    prometheus.HistogramOpts{
      Name: "vaultchat_connection_setup_seconds",
      Help: "WebSocket connection setup time",
      Buckets: []float64{.1, .5, 1, 2, 5},
    },
    []string{"region", "protocol"},
  )
)

// Record metrics
func sendMessage(msg *Message) error {
  start := time.Now()
  
  // Send logic...
  
  duration := time.Since(start).Seconds()
  messagesReceived.WithLabelValues(msg.ChatID, os.Getenv("REGION")).Inc()
  messageLatency.WithLabelValues(os.Getenv("REGION")).Observe(duration)
  
  return nil
}
```

#### 9.2 Alerting Rules
```yaml
# prometheus/alerts.yml
groups:
  - name: vaultchat_alerts
    rules:
    - alert: HighMessageLatency
      expr: histogram_quantile(0.95, vaultchat_message_latency_seconds) > 0.5
      for: 5m
      annotations:
        summary: "Message latency >500ms in {{ $labels.region }}"
        
    - alert: HighErrorRate
      expr: rate(vaultchat_errors_total[5m]) > 0.01
      for: 2m
      annotations:
        summary: "Error rate >1% in {{ $labels.service }}"
        
    - alert: DBConnectionPoolExhausted
      expr: vaultchat_db_connections_active >= 95
      for: 1m
      annotations:
        summary: "DB connection pool at 95% in {{ $labels.region }}"
```

---

### PHASE 10: Production Hardening (Weeks 73-80) — 1B Users

**Goal:** Bulletproof reliability, automatic recovery, zero data loss

#### 10.1 Chaos Engineering
Test system failure scenarios:

```yaml
# chaos-experiments/random-pod-kill.yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: PodChaos
metadata:
  name: kill-messaging-pod
spec:
  action: pod-kill
  mode: fixed
  value: 1
  duration: "5m"
  scheduler:
    cron: "@every 30m"
  selector:
    namespaces:
      - production
    labelSelectors:
      service: messaging
```

#### 10.2 Disaster Recovery
- **RPO (Recovery Point Objective):** 0 (no data loss)
- **RTO (Recovery Time Objective):** <5 minutes
- **Backup strategy:** Continuous replication across 3 regions
- **Failover:** Automatic to secondary region

```bash
# Automated backup
# Every hour: pg_dump to S3
0 * * * * pg_dump -h $PRIMARY_DB \
  | gzip | \
  aws s3 cp - s3://vaultchat-backups/hourly/backup-$(date +%Y%m%d-%H%M).sql.gz

# Verify backup integrity
0 */6 * * * aws s3 cp \
  s3://vaultchat-backups/hourly/backup-latest.sql.gz - | \
  gunzip | pg_restore -U postgres
```

---

## Performance Targets by Phase

| Metric | Phase 1 | Phase 3 | Phase 6 | Phase 9 | Phase 10 |
|--------|---------|---------|---------|---------|----------|
| **Concurrent Users** | 10K | 100K | 3M | 500M | 1B |
| **Message Latency (p95)** | 500ms | 200ms | 100ms | 50ms | 30ms |
| **Call Setup** | 6s | 4s | 2s | 2s | 1.5s |
| **Startup (Chat list visible)** | 1s | 300ms | 250ms | 200ms | 150ms |
| **Reconnect** | 10s | 2s | 800ms | 500ms | 300ms |
| **Availability** | 99% | 99.9% | 99.95% | 99.99% | 99.99% |
| **Bandwidth/User** | 2MB/day | 1.2MB/day | 0.8MB/day | 0.5MB/day | 0.3MB/day |
| **Crash-free Sessions** | 95% | 98% | 99% | 99.9% | 99.99% |

---

## Success Metrics & Monitoring

**User Experience:**
- Message delivery: <100ms (p95)
- Call setup: 2-4 seconds
- Startup: <500ms usable
- Zero crashes (target 99.9%)
- Battery drain: Comparable to WhatsApp/Signal

**Operational:**
- Uptime: 99.99%
- Auto-recovery time: <5 minutes
- Database replication lag: <100ms
- Cache hit rate: >95%

**Infrastructure:**
- Instances: Auto-scale 30-1000 based on load
- Database: PostgreSQL + read replicas
- Cache: Redis cluster (50+ nodes)
- Search: Elasticsearch (10+ nodes)
- Message queue: Kafka (20+ brokers)

---

## Conclusion

This 24-36 month roadmap transforms VaultChat from a capable startup platform into an **enterprise-grade communication system** supporting 100M-1B users globally.

**Key architectural decisions:**
1. ✅ Protocol Buffers mandatory (60% bandwidth reduction)
2. ✅ Vault Protocol custom layer (efficient multiplexing)
3. ✅ Single connection + 8 channels (simplified management)
4. ✅ SQLite offline queue (zero message loss)
5. ✅ Per-chat delta sync (10x faster reconnect)
6. ✅ Rust native libraries (5-10x performance boost)
7. ✅ Microservices backend (independent scaling)
8. ✅ Geographic sharding (global low-latency)
9. ✅ Chaos-tested reliability (bulletproof)

**Performance at scale:**
- 1B users = 1.5B messages/day
- 100M concurrent connections
- <30ms median message latency globally
- 99.99% uptime SLA
- Zero data loss guarantee

The architecture is designed for **10-15 year evolution** without fundamental rewrites.
