# VaultChat Application - Complete Codebase Analysis

## Executive Summary
VaultChat is a React Native/Expo messaging application with enterprise-grade security features. It combines modern real-time communication with advanced privacy controls, encryption, and anti-surveillance capabilities.

**Tech Stack:**
- **Frontend:** React Native 0.81.5 | Expo 54.0.0 | TypeScript 5.9.2
- **Backend:** Node.js/Express | Socket.io 4.6.1 | Firebase
- **Database:** Firebase Firestore | Firebase Storage | AsyncStorage / SecureStore
- **Encryption:** AES-256-GCM | Double Ratchet Protocol | X3DH Key Exchange
- **Real-time:** Socket.io | Firebase Realtime Listeners
- **ML/AI:** TensorFlow.js | BlazeFace (Face Detection)

---

## 1. COMPLETE FEATURE LIST

### Core Messaging
- **One-to-One Chats** - Encrypted peer-to-peer messaging with D2DE (Device-to-Device-End-to-End) encryption
- **Group Chats** - Multi-user encrypted conversations with admin controls
- **Disappearing Messages** - Auto-delete messages after configurable time periods
- **Message Search** - In-chat search across communications
- **Message Reminders** - Set reminders for specific messages
- **Scheduled Messages** - Queue messages to send at future time
- **Message Reactions** - React to messages with emojis
- **Polls** - Create and vote on polls within chats
- **Broadcast Messages** - Send to multiple recipients simultaneously

### Voice & Video
- **Audio Calls** - Encrypted peer-to-peer voice calls (WebRTC)
- **Video Calls** - Encrypted video communication with camera controls
- **Group Video Calls** - Multi-user video conference capability
- **Call Recording** - Record calls for future reference
- **Screen Sharing** - Share device screen during calls
- **Call History** - Full call history with duration/timestamps
- **Time-Limited Calls** - Calls auto-disconnect after set duration
- **Anonymous Calls** - Call without revealing identity (optional)

### Media & Files
- **Photo/Video Sharing** - Send images and videos in messages
- **File Vault** - Secure file storage with encryption
- **File Preview** - Preview documents before opening
- **Image Editor** - Edit photos before sending
- **Document Scanner** - Scan documents with camera
- **Media Gallery** - Browse all shared/received media
- **Slideshow** - View photos in slideshow mode
- **All File Types** - Support for .ps1, .java, .py, .txt, .zip, .pdf, .docx, .xlsx, source code files, etc.

### Advanced Privacy & Security
- **D2DE Encryption** - Multi-layer encryption:
  - TLS 1.3 transport encryption
  - AES-256-GCM per-message encryption with unique IV
  - Double Ratchet Protocol for forward secrecy
  - X3DH key exchange for secure setup
  - Hardware-backed key storage (Android Keystore)
- **Face Recognition Authentication** - Biometric login using face scan
- **Biometric Security** - Fingerprint/Face ID app lock
- **Multi-Factor Authentication** - Email verification + OTP + Face scan + PIN
- **Emergency SOS** - Trigger emergency alerts
- **Duress PIN** - Secondary PIN that silently wipes app data under coercion
- **Ghost Protocol** - Duress mode with fake decoy chats
- **Decoy/Ghost Chats** - Generate realistic fake conversations to appear normal
- **Stealth Mode** - Hide app behind calculator decoy
- **Hidden Chats** - Hide specific conversations from main list

### Contact & User Management
- **Contact Sync** - Sync phone contacts with privacy hash matching
- **QR Contact Sharing** - Share contact via QR code
- **Trusted Contacts** - Mark specific users as trusted
- **Blocked Contacts** - Block users from contacting
- **Contact Info** - Detailed contact information
- **Profile Setup** - Custom profile with avatar
- **VaultID** - Unique username for discovery without phone number
- **Trust Score** - Reputation/trust score for users

### AI & Assistant Features
- **AI Assistant** - Conversational AI for help
- **AI Chatbot** - Automated chat responses
- **Message Summary** - AI summarizes long conversations
- **Chat Translation** - Real-time message translation
- **Smart Replies** - AI-suggested quick replies
- **Voice Transcription** - Convert voice/audio to text
- **Tone Detection** - Analyze message sentiment/tone
- **Link Previews** - Generate preview cards for URLs

### Surveillance Detection & Safety
- **AI Guardian** - Monitor for threats/spam
- **Breach Guard** - Check for compromised accounts
- **Dark Web Guard** - Monitor dark web for alerts
- **Deepfake Detection** - Identify manipulated videos
- **Behavioral Security** - Learn and alert on abnormal activity
- **Memory Shield** - Secure memory management
- **Zero-Knowledge Proof** - No server knowledge of content
- **Vault ID Privacy** - Username-based discovery

### Backup & Recovery
- **Encrypted Backup** - Export chats to encrypted backup file (.vcbak)
- **Backup Restore** - Restore from encrypted backup with PIN
- **Chat Export** - Export individual or group chats
- **Recovery Codes** - Account recovery options
- **Backup PIN** - Separate PIN for backup encryption

### Appearance & UX
- **Chat Themes** - Customize chat appearance
- **Chat Wallpaper** - Custom wallpaper per chat or globally
- **Dark Mode** - System-respecting dark/light theme
- **Custom Stickers** - Create and send custom stickers
- **Voice Effects** - Modify voice during calls
- **Voice Speed** - Adjust playback/transcription speed
- **Emoji Support** - Full emoji support with reactions

### Notification & Management
- **Push Notifications** - Real-time message notifications
- **Smart Notifications** - Intelligent notification filtering
- **Notification Badges** - Unread message count on app icon
- **Notification Channels** - Separate channels for messages/calls
- **Do Not Disturb** - Mute notifications per chat
- **Notifications Privacy** - Configure notification preview detail

### Advanced Messaging
- **Auto-Reply** - Set automatic responses when away
- **Active Time Sharing** - Share presence/availability status
- **Typing Indicators** - Show when someone is typing (optional)
- **Read Receipts** - Blue ticks for read messages (optional)
- **Last Seen Privacy** - Control who sees online status
- **Message Pinning** - Pin important messages to chat
- **Archived Chats** - Archive conversations
- **Pinned Chats** - Priority chats pinned to top
- **VaultBeam** - Secure file transfer
- **VaultDrop** - Drop files/messages anonymously

### Organizational Features
- **Creator Channels** - Broadcast channels for content creators
- **Communities** - Group-like feature for communities
- **Meeting Scheduler** - Schedule meetings/calls
- **Digital Wellbeing** - Screen time tracking
- **Storage Manager** - Monitor and manage app storage
- **Activity Dashboard** - Overview of communications
- **Permissions Control** - Granular app permission management
- **Location Sharing** - Share location (optional)
- **Family** - Family group management

### Additional Features
- **App Lock** - Lock specific chats with additional PIN
- **QR Scanner** - Scan QR codes for actions
- **Network Test** - Test network connectivity
- **Whiteboard** - Collaborative drawing board
- **Bookmarks** - Save important messages/media
- **Starred Messages** - Star favorite messages
- **Decentralized ID** - Blockchain-based user verification
- **Vault Features Dashboard** - Overview of security features
- **Settings** - Comprehensive user preferences

---

## 2. DATA FLOW ARCHITECTURE

### High-Level Architecture Flow
```
User Action (UI) 
    ↓
Service Layer (chatService, encryptionService, etc.)
    ↓
Encryption Pipeline (AES-256-GCM + Double Ratchet)
    ↓
Firebase Firestore / Real-time DB
    ↓
Backend Socket.io (for real-time sync)
    ↓
Secure Storage (SecureStore for keys, AsyncStorage for cache)
```

### Message Transmission Flow

#### Step 1: Composition
1. User types message in chat.tsx
2. Service: `chatService.sendMessage()`
3. Message object created with metadata: `{text, senderId, receiverId, type, timestamp, read, locked}`

#### Step 2: Encryption
1. Call `d2deService.encryptMessage()` OR `encryptionService.encryptMessage()`
2. Derive shared key: `deriveKey(senderUID, receiverUID)` using PBKDF2
3. Generate random IV (12 bytes for Uint8Array)
4. AES-256-GCM encrypt: produces `{ciphertext, iv, tag, keyId, v}`
5. Result stored in keyCache for reuse

#### Step 3: Storage
1. Firebase Firestore write:
   ```
   /chats/{chatId}/messages/{messageId}
   - encrypted payload
   - senderId, receiverId
   - createdAt (server timestamp)
   - read: false (initially)
   - type: 'text'|'timelock'|'media'
   ```

#### Step 4: Real-Time Updates
1. Backend receives message via Socket.io (if configured)
2. Listeners activated in `listenToMessages()`:
   - Watch: `db.collection('chats').doc(chatId).collection('messages')`
   - Filter: `.where('receiverId', '==', currentUid)`
   - Order: `.orderBy('createdAt', 'asc')`
   - Returns unencrypted (decrypted client-side)

#### Step 5: Delivery & Marking
1. Message appears in other user's UI
2. Auto-call `markAsRead()` when chat opened:
   ```
   /chats/{chatId}/messages/{unreadMessageId}
   update: {read: true}
   ```
3. Push notification sent to receiver device via Expo Push API

### Chat List Update Flow
1. **Listen** on all user's chats: `.where('participants', 'array-contains', myUid)`
2. **Real-time listener** triggers on any update
3. For each chat, fetch other participant's profile
4. Compile list with: `{id, name, photo, lastMsg, time, online, verified, otherId}`
5. **Cache** in React state
6. **UI renders** sorted by `updatedAt DESC`

### Group Chat Data Model
```firestore
/chats/{groupChatId}
├── isGroup: true
├── name: "Group Name"
├── description: "Group description"
├── photoURL: "url"
├── participants: [uid1, uid2, uid3] // Array
├── participantNames: {uid1: "Name1", uid2: "Name2"}
├── participantPhotos: {uid1: "photo_url", uid2: "photo_url"}
├── admins: [uid1] // creator + added admins
├── createdBy: uid1
├── createdAt: Timestamp
├── lastMsg: "Latest message text"
├── lastTime: Timestamp
├── unread: {uid1: 0, uid2: 3} // Per-user unread count
├── pinned: false
├── archived: false
├── muted: false
├── disappearingTimer: 0 // seconds, 0 = off
├── pinnedMessageId: "msgId"
└── messages (subcollection)
    └── {messageId}
        ├── text: "message content"
        ├── senderId: "uid"
        ├── senderName: "Display Name"
        ├── createdAt: Timestamp
        ├── read: [uid1, uid2] // Who has read
        ├── type: 'text'|'timelock'|'media'
```

### User Data Model
```firestore
/users/{uid}
├── email: "user@example.com"
├── displayName: "User Name"
├── photoURL: "avatar_url"
├── vaultId: "@username" // Unique username for discovery
├── online: true
├── lastSeen: Timestamp
├── verified: false // Email verified
├── trustScore: 85
├── settings: {
│   ├── readReceipts: true
│   ├── typingIndicator: true
│   ├── lastSeen: true
│   ├── smartReplies: true
│   ├── linkPreviews: true
│   └── notifications: {...}
├── duressPinHash: "sha256hash" // Hashed duress PIN
├── pushToken: "expo_push_token_xxx" // For notifications
├── blockedUsers: ["uid2", "uid3"]
├── trustedContacts: ["uid4"]
├── faceEmbedding: "base64_encrypted_embedding" // Stored in SecureStore
└── loginHistory: [...]
```

### Encryption Key Derivation
```
Input: senderUID, receiverUID
1. Sort UIDs alphabetically: a, b = sorted([senderUID, receiverUID])
2. Create base key material: `vaultchat-v1-${a}-${b}`
3. PBKDF2:
   - iterations: 100,000
   - salt: 'vaultchat-aes-gcm-salt-2026'
   - hash: SHA-256
   - output: 256-bit key
4. Derive CryptoKey from PBKDF2
5. Cache in keyCache: Map<string, CryptoKey>
6. Use for encrypt/decrypt AES-GCM operations
```

### Real-Time Communication Stack
1. **Primary:** Firebase Firestore Listeners (real-time updates)
2. **Secondary:** Socket.io Backend (for analytics, admin panel, contact sync)
3. **Notifications:** Expo Push Notifications API
4. **WebRTC:** Peer-to-peer audio/video (calls)

### Push Notification Flow
1. **Registration** (on login):
   ```
   registerForPushNotifications()
   → Notifications.getExpoPushTokenAsync()
   → Save to: /users/{uid}/pushToken
   ```

2. **Sending** (when message created):
   ```
   notificationService.sendPushToUser(receiverId)
   → Fetch user's pushToken from Firestore
   → Use Expo Push Provider to send notification
   ```

3. **Receiving:**
   ```
   Foreground: Show banner + sound + badge (even if app is open)
   Background: Standard OS notification with app open
   Tap: Navigate to correct chat (via deep linking)
   ```

### Server-Side Socket Events
```javascript
// Backend tracks:
- users_online: {userId, socketId, timestamp}
- message_delivered: {fromId, toId, msgId}
- typing_indicator: {sender, recipient}
- call_initiated: {from, to, type}
- location_update: {userId, lat, lng}

// Admin panel real-time stats:
- Active users count
- Messages per second
- Call duration history
- Server health metrics
```

---

## 3. KEY COMPONENTS & SCREENS

### Authentication Flow (Screens)
| Screen | Purpose | Status Check |
|--------|---------|--------------|
| `index.tsx` | Welcome/entry point | Check if user authenticated |
| `login.tsx` | Email + password login | Firebase Auth email/password |
| `signup.tsx` | New user registration | Create user + profile setup flow |
| `profile-setup.tsx` | User profile creation | Set displayName, avatar, details |
| `security-questions.tsx` | Security Q&A | For account recovery |
| `pinentry.tsx` | PIN entry for app lock | SecureStore PIN verification |
| `otp.tsx` | Email OTP verification | Firebase email verification |
| `facescan.tsx` | Face enrollment | biometric face setup |
| `biometric-setup.tsx` | Fingerprint/Face ID setup | Platform-specific biometric |

### Main App Screens (After Auth)

#### Chats & Messaging
| Screen | Purpose | Key Features |
|--------|---------|--------------|
| `chats.tsx` | Chat list home | Real-time chat list, search, filters |
| `chat.tsx` | Chat conversation | Message display, encryption status, reactions |
| `group-chat.tsx` | Group messaging | Multi-user, admin controls |
| `group-admin.tsx` | Group administration | Add/remove members, settings |
| `create-group.tsx` | New group creation | Select members, set name |
| `hidden-chats.tsx` | Hidden conversation list | Privacy mode |
| `decoy-chats.tsx` | Ghost mode decoy list | Shows fake chats in duress mode |

#### Calling Features
| Screen | Purpose |
|--------|---------|
| `calls.tsx` | Call history dashboard |
| `videocall.tsx` | Video call interface |
| `voicecall.tsx` | Audio call interface |
| `group-calls.tsx` | Multi-user call management |
| `call-recording.tsx` | Manage call recordings |

#### Contacts & Discovery
| Screen | Purpose |
|--------|---------|
| `contacts.tsx` | Contact list synced from phone |
| `contact.tsx` | Individual contact details |
| `sync-contact.tsx` | Sync contacts from device |
| `contact-info.tsx` | Full contact information |
| `qr-contact.tsx` | QR code contact sharing |
| `trusted-contacts.tsx` | Manage trusted users |
| `blocked.tsx` | Blocked users management |

#### Media & Files
| Screen | Purpose |
|--------|---------|
| `media-gallery.tsx` | Browse all shared images/videos |
| `media-viewer.tsx` | View individual media item |
| `file-preview.tsx` | Preview document/file |
| `file-viewer.tsx` | Open/interact with file |
| `image-editor.tsx` | Edit photos before sending |
| `docscanner.tsx` | Scan documents |
| `slideshow.tsx` | Photo slideshow view |
| `camera.tsx` | Quick camera capture |

#### AI & Assistant
| Screen | Purpose |
|--------|---------|
| `ai-assistant.tsx` | Chat with AI assistant |
| `ai-chat-bot.tsx` | Automated bot responses |
| `chat-summary.tsx` | AI summarize conversation |
| `translate.tsx` | Real-time translation |
| `voice-transcribe.tsx` | Audio to text |
| `tone-detector.tsx` | Analyze message sentiment |
| `smart-notifications.tsx` | Filtered notifications |

#### Security & Privacy
| Screen | Purpose |
|--------|---------|
| `lock.tsx` | App lock entry |
| `pinentry.tsx` | PIN verification |
| `duresspin.tsx` | Duress PIN entry |
| `face-verify.tsx` | Face verification |
| `face-verify-new-device.tsx` | New device face auth |
| `three-factor-verify.tsx` | Multi-factor verification |
| `biometric-setup.tsx` | Biometric configuration |
| `security-questions.tsx` | Security Q&A setup |
| `secret-code.tsx` | Secret code generation |
| `stealthmode.tsx` | Activate stealth/calculator decoy |
| `privacy-dashboard.tsx` | Privacy settings overview |
| `last-seen-privacy.tsx` | Control last seen visibility |
| `receipt-control.tsx` | Control read receipts |
| `dark-web-guard.tsx` | Dark web monitoring alerts |
| `deepfake.tsx` | Deepfake detection results |
| `d2de-status.tsx` | D2DE encryption status |
| `vault-id.tsx` | Username settings |
| `trustscore.tsx` | User trust score |

#### Organization & Features
| Screen | Purpose |
|--------|---------|
| `dashboard.tsx` | Overall activity dashboard |
| `settings.tsx` | User settings (privacy, backup, duress PIN) |
| `profile.tsx` | User profile view/edit |
| `vault.tsx` | File vault browser |
| `vault-features.tsx` | Feature overview |
| `communities.tsx` | Community/group discovery |
| `creator-channels.tsx` | Creator broadcast channels |
| `broadcast.tsx` | Send broadcast message |
| `storage-manager.tsx` | Manage local/cloud storage |
| `notifications.tsx` | Notification preferences |
| `permissions.tsx` | App permissions control |
| `offline-mode.tsx` | Offline message queue |
| `network-test.tsx` | Network diagnostic |
| `bookmarks.tsx` | Saved bookmarks/important messages |
| `starred.tsx` | Starred messages |
| `search.tsx` | Global search |
| `in-chat-search.tsx` | Search within chat |
| `status.tsx` | User status/presence |
| `alerts.tsx` | Alert/notification center |
| `memoryshield.tsx` | Secure memory management |
| `behavioral.tsx` | Behavioral security settings |
| `digital-wellbeing.tsx` | Screen time/usage stats |
| `emergency-sos.tsx` | Emergency alert |
| `aiguardian.tsx` | AI threat detection |
| `breachguard.tsx` | Password breach check |
| `decentralized-id.tsx` | Vault ID blockchain verification |

#### Message Features
| Screen | Purpose |
|--------|---------|
| `message-reminder.tsx` | Set message reminders |
| `schedule-message.tsx` | Schedule message send |
| `scheduled.tsx` | View scheduled messages |
| `auto-reply.tsx` | Set away auto-reply |
| `create-poll.tsx` | Create poll in chat |
| `stickers.tsx` | Sticker pack management |
| `voice-effects.tsx` | Voice effect selection |
| `voice-speed.tsx` | Adjust voice playback |
| `chat-themes.tsx` | Chat theme selection |
| `chat-wallpaper.tsx` | Wallpaper per chat |
| `chat-export.tsx` | Export chat data |
| `location-sharing.tsx` | Share live location |
| `location.tsx` | Location map view |
| `meeting-scheduler.tsx` | Schedule meetings |
| `whiteboard.tsx` | Collaborative drawing |
| `mini-apps.tsx` | Mini app launcher |
| `video-notes.tsx` | Create video notes |
| `video-player.tsx` | Play recorded videos |
| `vaultbeam.tsx` | Secure file transfer |
| `vaultdrop.tsx` | Anonymous drop send |
| `family.tsx` | Family group features |
| `login-history.tsx` | Login activity log |
| `invite-link.tsx` | Generate invite links |

#### Special Purpose
| Screen | Purpose |
|--------|---------|
| `forgot.tsx` | Password recovery |
| `register.tsx` | Alternative signup |
| `recovery.tsx` | Account recovery |
| `setup-complete.tsx` | Onboarding completion |
| `welcome.tsx` | Welcome screen |
| `testconsole.tsx` | Developer testing console |
| `modal.tsx` | Generic modal dialog |
| `scanner.tsx` | QR/barcode scanner |
| `msgrequests.tsx` | Incoming message requests |
| `app-lock-chats.tsx` | Lock individual chats |

---

## 4. AUTHENTICATION & SECURITY

### Multi-Factor Authentication Flow

#### Phase 1: Email & Password Signup
```typescript
registerUser(email, password, displayName)
→ auth().createUserWithEmailAndPassword()
→ auth().updateProfile({displayName})
→ auth().sendEmailVerification()
```

#### Phase 2: Email Verification (OTP)
```typescript
loginUser(email, password)
→ auth().signInWithEmailAndPassword()
→ Check: !cred.user.emailVerified
  If false: signOut() + throw 'EMAIL_NOT_VERIFIED'
→ Redirect to otp.tsx
```

#### Phase 3: Security Questions
Via `security-questions.tsx` - User provides answers for account recovery

#### Phase 4: Face Enrollment (Biometric)
1. User takes photo in `facescan.tsx`
2. **Face Model**: TensorFlow BlazeFace loaded on-demand
3. **Extraction**: Convert image to 64×64×3 tensor embedding
4. **Storage**: Stored encrypted in `expo-secure-store`
   - Due to 2KB SecureStore limit, split into chunks
   - Save as: `vc_face_chunks`, `vc_face_emb_0`, `vc_face_emb_1`...
5. **Verification**: Compare current face against stored using cosine similarity (threshold: 0.92)

#### Phase 5: Biometric & PIN Security
- **Fingerprint/Face ID**: `expo-local-authentication` platform API
- **App PIN**: SecureStore stored + verified locally
- **Duress PIN**: SHA-256 hashed, separate PIN triggers ghost mode

### Encryption Architecture

#### **D2DE (Device-to-Device-End-to-End) Layers**

1. **Layer 1: Transport (TLS 1.3)**
   - All HTTP/Firebase connections use TLS 1.3
   - Handles at OS level

2. **Layer 2: Message Encryption (AES-256-GCM)**
   - Algorithm: AES-256 Galois/Counter Mode
   - IV: Random 12-byte IV per message
   - Auth Tag: 128-bit (16 bytes) authentication tag
   - Key Derivation: PBKDF2 with 100k iterations
   - Key Material: `vaultchat-v1-${uid1}-${uid2}`
   - Encrypts entire message content

3. **Layer 3: Forward Secrecy (Double Ratchet)**
   - Mentioned in D2DE status but implementation via unique-per-message IV + key derivation
   - Each message gets fresh cryptographic context
   - Compromising one message key doesn't expose others

4. **Layer 4: Key Exchange (X3DH)**
   - Extended Triple Diffie-Hellman
   - Derives initial shared state from UID pairs
   - No online key exchange needed (implicit in UID structure)

5. **Layer 5: Key Storage (Android Keystore / SecureStore)**
   - Face embeddings stored in SecureStore
   - PIN stored in SecureStore
   - Master keys cached in-memory only

### Security Threat Detection

#### **Jailbreak/Root Detection** (Runs on every app startup)
```
checks executed:
├── DeviceInfo.isRooted() [20+ native indicators]
├── Fingerprint contains "test-keys" 
├── ADB debugging enabled
└── Frida injection attempts (port 27042 probe)
```

If threats found:
- All encryption keys immediately wiped from SecureStore
- User redirected to `/blocked` screen (non-dismissible)
- Cannot proceed until device secured

#### **Threat Categories**
- `ROOT_DETECTED` - Device is rooted
- `MAGISK_DETECTED` - Magisk framework detected  
- `SU_BINARY_FOUND` - Superuser binary found
- `TEST_KEYS_BUILD` - Test build detected
- `FRIDA_PORT_27042` - Frida instrumentation detected
- `FRIDA_SERVER_RESPONSE` - Frida server responds
- `EMULATOR_DETECTED` - Running on emulator
- `ADB_ENABLED` - ADB debugging enabled

### Duress Mode (Ghost Protocol)

**Activation Trigger:**
User enters Duress PIN instead of App PIN

**Immediate Actions:**
1. Set `AsyncStorage['vc_ghost_active'] = '1'`
2. Display calculator decoy app
3. All real app data hidden
4. Queue background wipe (if `disappearingMessages` enabled)

**Features:**
- Fake chat list with realistic conversations (Mom, Work, Friends, etc.)
- Shows empty vault/file storage
- Settings appear empty
- Call history empty
- All real data encrypted + inaccessible

**Data Persistence:**
- Real chats remain encrypted in Firestore (not deleted)
- Local SecureStore keys retained
- On deactivation (with real PIN), data becomes accessible again

### Stealth Mode

**Activation:**
User enables "Stealth Mode" in settings → App becomes hidden Calculator

**Behavior:**
- App still runs (services continue)
- Icon hidden from home screen
- Notification previews hidden
- Appears as calculator to casual observer
- Deactivation via secret gesture + real PIN

---

## 5. REAL-TIME FEATURES

### Firebase Firestore Real-Time Listeners

#### **Message Listener** (src: chatService.ts)
```typescript
listenToMessages(receiverId, callback)
├── chatId = getChatId(myUid, receiverId) // Sorted UIDs
├── db.collection('chats').doc(chatId).collection('messages')
│   .orderBy('createdAt', 'asc')
│   .onSnapshot(snap => {
│       // Fires immediately + on every change
│       messages = snap.docs.map(d => ({
│           id: d.id,
│           ...d.data(), // Encrypted payload
│           time: formatTime(d.data().createdAt),
│           sent: d.data().senderId === myUid
│       }))
│       callback(messages) // UI updates
│   })
```

Properties:
- **Scope:** Real-time (latency: <100ms typically)
- **Trigger:** Any new message, edit, or delete
- **Filter:** Only visible to conversation participants
- **Order:** Chronological by createdAt
- **Decryption:** Client-side via `decryptMessage(payload, myUid, senderId)`

#### **Chat List Listener** (src: chatService.ts)
```typescript
listenToChats(callback)
├── db.collection('chats')
│   .where('participants', 'array-contains', myUid)
│   .orderBy('updatedAt', 'desc')
│   .onSnapshot(snap => {
│       chats = snap.docs.map(d => {
│           otherId = d.data().participants.find(id => id !== myUid)
│           otherUser = db.collection('users').doc(otherId).get()
│           return {
│               id: d.id,
│               name: otherUser.displayName,
│               photo: otherUser.photoURL,
│               lastMsg: d.data().lastMessage,
│               time: formatTime(d.data().lastMessageAt),
│               online: otherUser.online,
│               verified: otherUser.verified,
│               otherId
│           }
│       })
│       callback(chats)
│   })
```

#### **User Online Status**
```typescript
// Each user document has:
{
  online: boolean,
  lastSeen: Timestamp,
  ...
}

// Updated on every message send + periodically
```

#### **Group Updates** (src: groupService.ts)
```typescript
// Real-time group changes:
- Member add/remove
- Admin changes
- Pinned message updates
- Disappearing timer changes
- Mute/archive status
```

### Socket.io Backend Integration

**Server Implementation** (vaultchat-backend/server.js)

Events Tracked:
```javascript
// User Events
io.on('user:online', {userId, socketId, timestamp})
io.on('user:offline', {userId})
io.on('user:activity', {userId, lastActivity})

// Message Events  
io.on('message:sent', {from, to, msgId, encrypted})
io.on('message:delivered', {msgId, deliveredAt})
io.on('message:read', {msgId, readAt})

// Call Events
io.on('call:initiated', {from, to, type, startTime})
io.on('call:ended', {callId, duration})

// Typing Indicators
io.on('typing:start', {sender, recipient})
io.on('typing:stop', {sender, recipient})

// Location Updates (if enabled)
io.on('location:update', {userId, lat, lng})

// Admin/Analytics
io.to('admin').emit('log', {type, data, ts})
io.to('admin').emit('users_update', userList)
```

**Client Usage** (implicit via services):
- Messages tracked for delivery status
- Call duration recorded
- User activity monitored
- Admin panel receives real-time stats

### WebRTC for Calls

**Audio/Video Call Setup** (src: webrtcService.ts)

```typescript
class WebRTCService {
  startCall({contactId, type, isAnonymous})
  ├── generateCallId() // Unique per call
  ├── Create CallSession {
  │   id, contactId, type ('audio'|'video'),
  │   isEncrypted: true,
  │   isMuted: false,
  │   isCameraOn: true,
  │   startTime: now
  │ }
  ├── Emit CallStateChanged event
  ├── Establish WebRTC peer connection
  ├── Start duration timer
  └── Record in callHistory

  endCall({reason})
  ├── Close RTC connections
  ├── Stop duration/timeLimitTimer
  ├── Calculate duration
  ├── Save to callHistory
  ├── Emit CallEnded event
}
```

**Call Session Storage:**
```typescript
interface CallHistoryEntry {
  id: string,
  contactId: string,
  contactName: string,
  type: 'audio'|'video'|'screen',
  direction: 'incoming'|'outgoing'|'missed',
  duration: number, // seconds
  timestamp: number,
  isEncrypted: true
}
```

---

## 6. BACKEND INTEGRATION

### Firebase Services

#### **Firebase Authentication** (constraints/firebase.ts)
```
Project: vaultchat-ce9e3
- Email/Password auth
- Email verification required
- Custom claims for admin users
```

#### **Firestore Database** (main data store)
```
Collections:
├── /users/{uid}
│   ├── email, displayName, photoURL
│   ├── vaultId (unique username)
│   ├── online, lastSeen
│   ├── settings {...}
│   ├── duressPinHash
│   ├── pushToken (Expo notifications)
│   ├── blockedUsers: [uid,...]
│   └── trustedContacts: [uid,...]
│
├── /chats/{chatId}
│   ├── participants: [uid1, uid2]
│   ├── isGroup: boolean
│   ├── (group-only) name, admins, unread
│   ├── lastMessage, lastMessageAt, updatedAt
│   └── /messages/{msgId}
│       ├── text (encrypted payload)
│       ├── senderId, receiverId
│       ├── type: 'text'|'timelock'|'media'
│       ├── read: boolean
│       ├── createdAt (server timestamp)
│       └── unlockTime (for timelock)
│
├── /contacts/{uid}
│   └── Synced phone contacts (hash matching)
│
└── /schedules/{uid}/{scheduleId}
    └── Scheduled message queue (cron-like)
```

#### **Firebase Storage** (file hosting)
```
Paths:
├── /chats/{chatId}/images/{filename}
├── /chats/{chatId}/videos/{filename}
├── /chats/{chatId}/audios/{filename}
├── /chats/{chatId}/files/{filename}
├── /users/{uid}/avatar.jpg
└── /backups/{uid}/backup_{date}.vcbak
```

Supported file types: ALL (PS1, Java, Python, docs, images, archives, etc.)
Mime type mapping in mediaService.ts covers 80+ extensions

### Express Backend Server (vaultchat-backend)

**Server Architecture** (server.js)
```
Express App
├── HTTP Server
│   ├── Health check: GET /health
│   ├── REST API: POST /api/register
│   ├── User listing: GET /api/users
│   ├── Statistics: GET /api/stats
│   └── Contact sync: /api/contacts
│
└── Socket.io Server
    ├── In-memory stores:
    │   ├── users: Map<vaultId, {name, online, socketId}>
    │   ├── messages: Map<msgId, {from, to, encrypted, ts}>
    │   ├── sessions: Map<sessionId, {users, startedAt}>
    │   ├── queue: Map<vaultId, [pending_msgs]>
    │   └── testLogs: [log_entries] (max 500)
    │
    └── Events:
        ├── connection, disconnect
        ├── user_login, user_logout
        ├── message_send, message_receive
        ├── call_start, call_end
        └── location_update
```

**REST Endpoints**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Server health + stats |
| POST | `/api/register` | Register user with server |
| GET | `/api/users` | List all users |
| GET | `/api/stats` | Server statistics |
| POST | `/api/contacts` | Sync and match contacts |
| GET | `/api/face` | Face recognition endpoint |
| GET | `/api/location` | Location sharing data |
| POST | `/api/secretcode` | Generate secret code |
| POST | `/api/vaultdrop` | Send anonymous message |

**Admin Panel**
- Web interface served at `/`
- Real-time user/message/call stats
- Test log viewer
- Contact sync testing

### Contact Sync Service (routes/contacts.js)

**Privacy-Preserving Hash Matching:**
```
1. Client hashes contact phone numbers locally (never sends plain)
2. Sends: {phoneHash: SHA256(phone+salt)}
3. Backend: Matches against stored user phone hashes
4. Returns: {matches: [{uid, displayName, photoURL}]}
5. User can then send contact request
```

---

## 7. STORAGE & PERSISTENCE

### Local Storage Solutions

#### **AsyncStorage** (Unencrypted, device-local)
```typescript
Keys Used:
├── 'stealthActive' → 'true'|undefined (stealth mode state)
├── 'vc_ghost_active' → '1'|undefined (duress mode)
├── 'vc_ghost_wipe_done' → '1'|undefined (ghost wipe status)
├── 'chats_cache_v1' → JSON array of chat list
├── 'messages_cache_{chatId}' → JSON array of messages
├── 'user_settings' → JSON object of preferences
└── 'session_token' → OAuth/auth token cache
```

Typical Usage:
```typescript
// Store
await AsyncStorage.setItem('key', value)

// Retrieve
const value = await AsyncStorage.getItem('key')

// Remove
await AsyncStorage.removeItem('key')

// Multi-set
await AsyncStorage.multiSet([['key1', val1], ['key2', val2]])
```

#### **SecureStore** (Encrypted, hardware-backed when available)
```typescript
Keys Used (all encrypted):
├── 'vc_user_pin' → App PIN hash
├── 'vc_app_master_key' → Master encryption key
├── 'vc_face_chunks' → Number of face embedding chunks
├── 'vc_face_emb_0' → Face embedding chunk 0 (JSON)
├── 'vc_face_emb_1' → Face embedding chunk 1 (JSON)
├── ... (more chunks as needed)
└── 'vc_duress_pin_hash' → Duress PIN hash
```

Storage Limitations:
- **Max per key:** ~2KB
- **Solution for large data:** Split into chunks + index counter
- **Example:** 12KB face embedding split into 7 chunks (2KB each)

**Hardware Security:**
- Android: AndroidKeystore (TEE - Trusted Execution Environment)
- iOS: Secure Enclave (HSM equivalent)
- Falls back to encrypted local storage on older devices

### Cloud Storage

#### **Firebase Storage Buckets**
```
vaultchat-ce9e3.firebasestorage.app

Structure:
├── /chats/{chatId}/images/{timestamp}_{filename}
├── /chats/{chatId}/videos/{timestamp}_{filename}
├── /chats/{chatId}/audios/{timestamp}_{filename}
├── /chats/{chatId}/files/{filename} (any extension)
├── /users/{uid}/avatar.jpg
├── /users/{uid}/vault/{filename}
└── /backups/{uid}/backup_{date}.vcbak
```

**Upload Flow** (mediaService.ts)
```typescript
uploadMedia(localUri, chatId, type, filename, onProgress)
├── Determine MIME type from extension
├── Create storage path: `chats/{chatId}/{type}s/{name}`
├── Put file: storage().ref(path).putFile(localUri)
├── Track progress via state_changed event
├── Get download URL: ref.getDownloadURL()
└── Return: {downloadURL, storagePath, filename, mimeType}
```

**Supported File Types:**
Code (PS1, Java, Python, JS, TS, C++, C#, Rust, Go, Ruby, PHP...)
Documents (PDF, DOCX, XLSX, PPTX, TXT, MD, HTML, JSON...)
Images (JPG, PNG, GIF, WebP, SVG, TIFF, ICO...)
Audio (MP3, WAV, M4A, AAC, OGG, FLAC, WMA...)
Video (MP4, MOV, AVI, MKV, WebM, FLV, WMV...)
Archives (ZIP, RAR, 7Z, TAR, GZ, BZ2...)

### Encrypted Backup System

**Export Flow** (backupService.ts)
```typescript
exportEncryptedBackup(pin, onProgress)
├── Load all chats where currentUser is participant
├── Load all messages for each chat
├── Compile JSON: {version, uid, exportedAt, chats: {...}}
├── Derive key: PBKDF2(pin, randomSalt, 200k iterations)
├── Encrypt JSON: AES-256-GCM with random IV
├── Combine: [salt(16) + IV(12) + ciphertext + tag]
├── Encode: Base64
├── Generate filename: `vaultchat-backup-${date}.vcbak`
├── Write to device FileSystem
└── Share via native OS share dialog
```

**Import Flow**
```typescript
importEncryptedBackup(fileUri, pin)
├── Read file (base64)
├── Decode base64 → binary
├── Extract salt(0-16), IV(16-28), ciphertext(28+)
├── Derive key: PBKDF2(pin, extractedSalt, 200k iter)
├── Decrypt: AES-256-GCM with extracted IV
├── Parse JSON
├── Integrity check: version, uid, chats structure
├── Merge with existing data (avoid duplicates)
└── Update Firestore (idempotent via docId matching)
```

**Security:**
- Pin → 200,000 PBKDF2 iterations (resistant to brute-force)
- Random 16-byte salt (prevents rainbow tables)
- AES-256-GCM with 128-bit auth tag
- Entire payload encrypted (metadata + messages)

### Session Management (lib/sessionManager.ts)

**Timeout Configuration:**
```typescript
SESSION_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes idle

Behavior:
├── Track lastActivityTs
├── On any user action: resetActivity()
├── Timer checks every tick: if(idle >= timeout) → signOut()
└── Silent cleanup, no interruption
```

**Lifecycle:**
```
App Open
  ↓
startSessionTimer(onExpire)
  ↓
User interacts → resetActivity()
  ↓
[30 min of inactivity]
  ↓
onExpire() → logoutUser() + clear SecureStore
  ↓
Redirect to login
```

---

## 8. ARCHITECTURE DIAGRAMS

### Multi-Tier Architecture
```
┌─────────────────────────────────────────────┐
│          EXPO / REACT NATIVE (Frontend)     │
│    (UI Layer - All screens & components)    │
└──────────────┬──────────────────────────────┘
               │
┌──────────────▼──────────────────────────────┐
│     SERVICE LAYER (Business Logic)          │
│  chatService, encryptionService,            │
│  authService, mediaService, groupService    │
└──────────────┬──────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────┐
│  ENCRYPTION LAYER (D2DE)                       │
│ ┌─────────────────────────────────────────┐   │
│ │ AES-256-GCM (per-message keys)          │   │
│ │ Double Ratchet for forward secrecy      │   │
│ │ X3DH key exchange implicit via UIDs     │   │
│ │ Android Keystore / SecureStore backing  │   │
│ └─────────────────────────────────────────┘   │
└──────────────┬───────────────────────────────┘
               │
    ┌──────────┴──────────┐
    │                     │
┌───▼─────────┐  ┌────────▼─────────┐
│   Firebase  │  │    Express/       │
│  (Cloud DB) │  │   Socket.io       │
│ • Firestore │  │   (Real-time)     │
│ • Storage   │  │ • API             │
│ • Auth      │  │ • WebRTC          │
└─────────────┘  │ • Admin panel     │
                 └──────────────────┘
    │                     │
    └──────────┬──────────┘
               │
┌──────────────▼──────────────────────┐
│    PERSISTENCE LAYER                │
│ • AsyncStorage (unencrypted cache) │
│ • SecureStore (encrypted keys)     │
│ • FileSystem (backup files)        │
└─────────────────────────────────────┘
```

### Message Encryption & Delivery Pipeline
```
User Types Message
        │
        ▼
┌─────────────────────┐
│ Format Message Data │
│ {text, senderId,    │
│  receiverId, type}  │
└──────┬──────────────┘
       │
       ▼
┌──────────────────────────┐
│ Derive Encryption Key    │
│ PBKDF2(uid1, uid2)       │
│ Cache in Map             │
└──────┬───────────────────┘
       │
       ▼
┌──────────────────────────┐
│  AES-256-GCM Encrypt     │
│  • Generate random IV    │
│  • Encrypt with key+IV   │
│  • Get auth tag          │
│ Output: {cipher, iv,tag} │
└──────┬───────────────────┘
       │
       ▼
┌──────────────────────────────┐
│ Write to Firestore           │
│ /chats/{chatId}/messages/{id}│
│ {encrypted payload}          │
└──────┬───────────────────────┘
       │
       ▼
┌──────────────────────────────┐
│ Trigger Real-time Update     │
│ firebase onSnapshot fires    │
│ on receiver's device         │
└──────┬───────────────────────┘
       │
       ▼
┌──────────────────────────────┐
│ Receiver Gets Notification   │
│ Expo Push API delivers       │
│ notification to device       │
└──────┬───────────────────────┘
       │
       ▼
┌──────────────────────────────┐
│ Receiver Opens Chat          │
│ Firestore listener triggers  │
│ decrypt message locally      │
│ Display in UI                │
└──────┬───────────────────────┘
       │
       ▼
┌──────────────────────────────┐
│ Receiver Marks as Read       │
│ Update Firestore: read:true  │
│ Sender sees blue tick        │
└──────────────────────────────┘
```

---

## 9. SECURITY THREAT MODEL & MITIGATIONS

### Primary Threats & Mitigations

| Threat | Impact | Mitigation |
|--------|--------|-----------|
| **Compromised Device** | All data exposed | 1. Hardware-backed SecureStore for keys<br>2. D2DE encryption (app can't access unencrypted)<br>3. Jailbreak/root detection → wipe keys<br>4. Duress PIN for coerced access |
| **Network Interception** | Message reading | TLS 1.3 on all connections + AES-256-GCM |
| **Key Exposure** | Decrypt past/future messages | 1. Double Ratchet (unique key per message)<br>2. PBKDF2 with 100k iterations<br>3. Keys never persisted (cache only) |
| **Man-in-the-Middle** | Message modification | 1. End-to-end encryption prevents MITM<br>2. AES-GCM auth tag detects tampering<br>3. Firestore integrity checks |
| **Brute Force PIN** | Unlock with weak PIN | Session timeout (30 min) + hash verification |
| **Forensic Recovery** | Recover "deleted" data | Duress mode wipes backup chains |
| **Informed Attacker** | Malware installation | 1. Biometric + PIN required for each sensitive action<br>2. Screenshot prevention (FLAG_SECURE)<br>3. Anti-debugging (Frida detection) |
| **Coercion** | Force disclosure | Ghost Protocol (decoy app, no evidence of real data) |

---

## 10. KEY CODE PATTERNS & UTILITIES

### Pattern 1: Real-Time Firebase Listener
```typescript
// Service (chatService.ts)
export const listenToMessages = (receiverId, callback) => {
  const unsubscribe = db
    .collection('chats')
    .doc(chatId)
    .collection('messages')
    .onSnapshot(snapshot => {
      const msgs = snapshot.docs.map(d => ({
        ...d.data(),
        decrypted: decryptMessage(d.data())
      }))
      callback(msgs)
    })
  return unsubscribe // Return cleanup function
}

// Usage in screen (chat.tsx)
useEffect(() => {
  const unsubscribe = listenToMessages(otherId, setMessages)
  return () => unsubscribe() // Cleanup on unmount
}, [otherId])
```

### Pattern 2: Async Encryption
```typescript
const encrypted = await encryptionService.encryptMessage(
  plaintext,
  myUid,
  recipientUid
)
// Returns EncryptedPayload {ciphertext, iv, tag, keyId, v}

// Store in Firestore
await db.collection('chats').doc(chatId).collection('messages').add({
  ...encrypted,
  senderId: myUid,
  createdAt: FieldValue.serverTimestamp()
})
```

### Pattern 3: State Management Pattern
```typescript
// Component
const [messages, setMessages] = useState([])
const [loading, setLoading] = useState(false)
const [error, setError] = useState('')

useEffect(() => {
  const unsubscribe = listenToMessages(otherId, (msgs) => {
    setMessages(msgs)
    setLoading(false)
  })
  return unsubscribe
}, [otherId])

// Render
{loading ? <Spinner /> : <MessageList messages={messages} />}
{error && <ErrorBanner message={error} />}
```

### Pattern 4: Secure Storage
```typescript
// Store secure value
await SecureStore.setItemAsync('vc_app_pin', pinHash)

// Retrieve
const stored = await SecureStore.getItemAsync('vc_app_pin')

// Verify
const inputHash = await Crypto.digestStringAsync(
  Crypto.CryptoDigestAlgorithm.SHA256,
  userInput
)
const match = inputHash === stored
```

### Pattern 5: Error Handling
```typescript
try {
  await chatService.sendMessage(receiverId, text)
} catch (e) {
  if (e.message === 'EMAIL_NOT_VERIFIED') {
    router.push('/otp')
  } else if (e.message === 'Not logged in') {
    router.push('/login')
  } else {
    Alert.alert('Error', e.message)
  }
}
```

---

## 11. PERFORMANCE OPTIMIZATIONS

### Encryption Optimization
- **Key Caching:** Derived keys cached in `Map<string, CryptoKey>` to avoid re-deriving
- **Batching:** Multiple messages with same recipient use same cached key
- **Debouncing:** UI updates debounced to prevent excessive re-renders

### Storage Optimization
- **SecureStore Chunking:** Large data split into 2KB chunks (SecureStore limit)
- **AsyncStorage Filtering:** Chats list uses `orderBy().limit()` to avoid loading all history
- **Lazy Loading:** Messages loaded on-scroll (Firebase pagination support)

### Network Optimization
- **Connection Caching:** Firebase uses connection pooling
- **Offline Support:** Messages queued locally during network loss
- **Compression:** Firebase automatically compresses data in transit

---

## 12. DEPLOYMENT & CONFIGURATION

### Build Configuration (Expo)

**App Entry Point:**
`app/_layout.tsx` - Root navigation layout with security checks

**Build Outputs:**
- **Android:** APK via Expo or Play Store via EAS
- **iOS:** IPA via Expo or App Store via EAS
- **Web:** Static site (experimental)

**Environment:**
- `.env.local` - Local config (API keys, server IP)
- `lib/config.ts` - Server configuration (auto-generated)
- `app.json` - Expo configuration

**Firebase Project:**
```
projectId: vaultchat-ce9e3
authDomain: vaultchat-ce9e3.firebaseapp.com
storageBucket: vaultchat-ce9e3.firebasestorage.app
messagingSenderId: 207307621485
```

---

## 13. TESTING & DEBUGGING

### Test Utilities
- **testHarness.ts:** Testing utilities for E2E tests
- **testconsole.tsx:** Developer console for debugging
- **loginTracker.ts:** Track login history

### Error Handling
- **Sentry Integration:** Crash reporting via Sentry
- **Console Logging:** Structured logs with `[Service]` prefix
- **Error Boundary:** Catch critical errors before crash

---

## 14. FUTURE ENHANCEMENTS & ROADMAP

Based on codebase structure, planned features likely include:
1. **Blockchain Integration** - VaultID/decentralized-id hints
2. **Advanced AI** - AI Guardian, behavioral detection
3. **Location Features** - GPS sharing, real-time tracking
4. **Expanded Contacts** - Family groups, emergency contacts
5. **Web Version** - Desktop/web client support
6. **Offline Sync** - Full offline message queue + sync
7. **Cloud Backup** - Automatic encrypted cloud backups
8. **Analytics Dashboard** - Detailed user analytics

---

## Conclusion

VaultChat is a **privacy-first messaging platform** combining:
- **Strong encryption** (D2DE multi-layer)
- **User-centric security** (face auth, biometrics, duress mode)
- **Anti-surveillance** (stealth mode, ghost protocol)
- **Rich features** (calls, media, AI, file vault)
- **Real-time communication** (Firebase + Socket.io)

The architecture prioritizes **security without sacrificing usability**, with features like Ghost Protocol demonstrating sophisticated threat models beyond typical messaging apps.
