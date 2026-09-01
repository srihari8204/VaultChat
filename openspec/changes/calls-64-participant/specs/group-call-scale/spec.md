## ADDED Requirements

### Requirement: Group call participant ceiling
A group call SHALL admit at most 64 participants. The ceiling SHALL be enforced by the
server at the point a participant takes a seat, not by the client and not by the media
server's room capacity — a room cap counts every identity, cannot distinguish a caller from
anything else, and refuses by disconnecting. The client SHALL surface a refusal as a "call
is full" notice rather than a failed join.

#### Scenario: The 65th person tries to join
- **WHEN** a chat member joins a call that already has 64 other live participants
- **THEN** the server refuses the join, increments a `call_full` metric, and returns a
  refusal the client renders as "This call is full"
- **AND** no participant row is created, so the refused person does not hold a seat

#### Scenario: A participant reconnects to a full call
- **WHEN** someone already on a full call loses their network and rejoins
- **THEN** the join succeeds — they are counted as one of the 64 already, not as a 65th

#### Scenario: Someone leaves and a seat frees
- **WHEN** a participant leaves a full call and another member then joins
- **THEN** the join succeeds and they enter the call

#### Scenario: The room cap is a backstop, not the rule
- **WHEN** the media server's configured `max_participants` is read
- **THEN** it is strictly greater than 64, so the product rule is always the join check
  and never a media-server disconnect

### Requirement: Selective track subscription
A participant SHALL subscribe to the video of only the participants currently visible on
its screen, and SHALL subscribe to the audio of every participant in the call. The visible
set SHALL be declared by the app, never inferred by the SDK from view visibility.

#### Scenario: A large call opens
- **WHEN** a participant joins a call with 63 others
- **THEN** it subscribes at most one video track per visible tile plus all audio tracks
- **AND** the number of subscribed video tracks does not grow with the number of participants

#### Scenario: A tile scrolls out of the visible set
- **WHEN** a participant is removed from the visible set
- **THEN** their video is unsubscribed and their audio subscription is unchanged

#### Scenario: A small call is unaffected
- **WHEN** a call has 5 or fewer participants
- **THEN** every participant is in the visible set and every video track is subscribed,
  matching today's behaviour exactly

#### Scenario: Nobody is silently muted by scale
- **WHEN** a participant outside the visible set speaks
- **THEN** every other participant hears them, because audio is never subject to the
  visible set

### Requirement: Active speaker promotion
The visible set SHALL include the most recently active speakers. A participant who begins
speaking while outside the visible set SHALL be promoted into it, and promotion SHALL NOT
disturb tiles of participants who are still speaking.

#### Scenario: An off-screen participant starts talking
- **WHEN** a participant outside the visible set becomes the active speaker
- **THEN** they are promoted into the visible set and their video is subscribed
- **AND** the participant displaced is one who has been silent longest, never a current speaker

#### Scenario: Rapid speaker changes
- **WHEN** the active speaker changes several times within a few seconds
- **THEN** the visible set does not thrash: a promoted participant holds their tile for a
  minimum dwell period before being eligible for displacement

### Requirement: Device-tier publish policy
A participant SHALL publish exactly one camera stream, simulcast into multiple spatial
layers, with the layer count chosen by device tier: three layers on a capable device, two
on a low-end one. Screen share SHALL remain single-layer, as it is today.

#### Scenario: A capable phone publishes camera
- **WHEN** a capable device enables its camera in a group call
- **THEN** it publishes one track with three simulcast layers

#### Scenario: A low-end phone publishes camera
- **WHEN** a low-end device enables its camera in a group call
- **THEN** it publishes one track with two simulcast layers, sparing the encoder

#### Scenario: Nobody subscribes to the top layer
- **WHEN** every subscriber is rendering a small tile
- **THEN** the publisher stops sending the unused high layer, and resumes it when someone
  subscribes at that size

### Requirement: Bounded group ring
Ringing a group SHALL cost the caller one request regardless of group size. The server
SHALL perform the per-member fan-out. The caller's ring budget SHALL NOT be consumed in
proportion to the number of members.

#### Scenario: Starting a call in a 64-member group
- **WHEN** a member starts a group call in a chat with 63 other members
- **THEN** the client sends one ring request and the server rings each member
- **AND** the caller may start another group call within the same rate-limit window

#### Scenario: Only chat members are rung
- **WHEN** the server fans out a group ring
- **THEN** it rings only current members of that chat, verified server-side, and never a
  client-supplied recipient list

### Requirement: End-to-end encrypted in-call side channel
In-call chat messages and reactions SHALL be delivered to every other participant of a
group call, and SHALL be encrypted end to end — one envelope sealed per recipient over the
pairwise ratchet. The server SHALL NOT be given the plaintext, and SHALL NOT perform the
fan-out. A participant SHALL accept in-call messages only from other live participants of
that call.

#### Scenario: A message in a group call
- **WHEN** a participant sends an in-call chat message in a call with others
- **THEN** every other participant receives it
- **AND** each receives a copy sealed for them alone, so the server relays only ciphertext

#### Scenario: One recipient has no session yet
- **WHEN** sealing fails for one recipient
- **THEN** every other participant still receives the message

#### Scenario: A non-participant cannot inject
- **WHEN** someone who is not on the call sends an in-call chat event for it
- **THEN** participants ignore it

#### Scenario: Nobody talks to themselves
- **WHEN** a participant is alone in a group call and sends a message
- **THEN** no envelope is sent, and no copy is addressed to the sender

### Requirement: Small calls behave exactly as before
Behaviour at 1:1 and small group sizes SHALL be unchanged by this capability. Every
device-proven property of the existing call path — two-way audio at first join, the
foreground service, reconnect, screen-share track swap, empty-room self-end, and the
"encrypted in transit" badge — SHALL continue to hold.

#### Scenario: A 1:1 call
- **WHEN** two people call each other
- **THEN** both hear each other from the moment the call connects, with no change to
  transport configuration

#### Scenario: The encryption claim does not change
- **WHEN** a group call reaches any size up to 64
- **THEN** the badge states encryption in transit and never claims end-to-end
