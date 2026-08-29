# family-event-envelope

The structured system-message envelope that carries family/space events
(geofence crossings, overspeed) between members' devices without appearing in
chat threads — chat carries only human conversation; events land in each
device's alerts inbox.

## ADDED Requirements

### Requirement: Events travel as structured sealed envelopes

A geofence crossing or overspeed event SHALL be sent to the group as a `system`
chat message whose content is a JSON envelope
`{"famEvent":{"v":1,"kind","actorId","actorName","text","at"}}`, sealed by the
existing E2EE message path. The server SHALL NOT gain any new visibility: it
relays the same ciphertext it relays today.

#### Scenario: Crossing announced as envelope
- **WHEN** the emitting device detects "arrived at Home"
- **THEN** every announce call site (foreground presence and the background
  task) sends the famEvent envelope, and no plain-text announcement is sent

#### Scenario: Overspeed rides the same mechanism
- **WHEN** the speed alert fires on the emitting device
- **THEN** it is delivered as a famEvent envelope with kind `overspeed`

### Requirement: Chat surfaces never render the envelope

Chat threads SHALL NOT render famEvent messages as bubbles, and the chat list
SHALL NOT surface them as a conversation's latest message preview.

#### Scenario: Thread stays human
- **WHEN** a thread's messages include famEvent system messages
- **THEN** the rendered thread contains none of them, while genuine system
  messages (e.g. SOS) still render

#### Scenario: Chat list not bumped into pretending conversation
- **WHEN** the newest message in a chat is a famEvent envelope
- **THEN** the chat row's preview does not present it as a readable message

### Requirement: Receivers ingest envelopes into the alerts inbox

Every receiving device SHALL fold incoming famEvent envelopes into its
device-local alerts inbox, app-wide (not only while a chat or family screen is
open), skipping the receiver's own events and deduplicating repeats.

#### Scenario: Member learns of a crossing without opening chat
- **WHEN** a member's device receives "Rohan arrived at Home" as an envelope
  while the app sits on any screen
- **THEN** the alerts inbox gains an `enter` alert with that text and the
  alerts badge increments — with no chat unread implication for the thread

#### Scenario: Emitter does not double-record
- **WHEN** the emitting device receives its own envelope back from the group
- **THEN** no second alert is recorded

### Requirement: Chat reachable from map surfaces

Every space screen header and the family screen header SHALL offer a shortcut
that opens that group's EXISTING chat thread. There SHALL be no separate
message store for spaces.

#### Scenario: One thread, both doors
- **WHEN** a member opens chat from the space header and later from the chats
  list
- **THEN** both show the same thread, same history, same unread state
