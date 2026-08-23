## ADDED Requirements

### Requirement: Imported messages use negative ids

An imported message's `messages.id` SHALL be negative, and SHALL be derived deterministically
from the message's ORIGINAL timestamp plus an in-second sequence number assigned in transcript
order. Ordering by id SHALL therefore be identical to ordering by original time, both within an
import and across separate imports into the same conversation.

Re-importing the same export SHALL compute the same ids it computed the first time.

`importMessages()` SHALL be the only writer that accepts a non-positive id. `cacheMessages()`
SHALL continue to skip ids ≤ 0, so that no sync, send, or upload path can ever handle an
imported id.

#### Scenario: Imported history sorts as the past

- **WHEN** a conversation containing both server messages and imported messages is rendered
- **THEN** every imported message SHALL appear before every server message in the conversation
- **AND** imported messages SHALL appear among themselves in their original order

#### Scenario: cacheMessages refuses imported ids

- **WHEN** a message with a negative id is passed to `cacheMessages()`
- **THEN** it SHALL be skipped, exactly as today

### Requirement: The global sync cursor is unaffected by imports

Importing SHALL NOT advance `getGlobalSyncCursor()`, and SHALL NOT cause the delta sync to skip
any server message in any chat.

#### Scenario: Cursor after an import

- **WHEN** any number of messages are imported into any chat
- **THEN** the value returned by `getGlobalSyncCursor()` SHALL be unchanged
- **AND** the next `catchUp()` SHALL request the same `since` value it would have requested
  before the import

### Requirement: Imported messages are exempt from cache pruning

`pruneMessageCache()` SHALL NOT delete any row with a non-positive id. Imported history has no
server copy and cannot be re-fetched, so it is not cache.

#### Scenario: Prune sweep with imported history present

- **WHEN** `pruneMessageCache()` runs on a database whose message count exceeds the cap and
  whose chats contain imported messages
- **THEN** no row with `id <= 0` SHALL be deleted
- **AND** the sweep SHALL still trim positive-id rows as before

#### Scenario: Guard is protected against regression

- **WHEN** the self-test scans `pruneMessageCache`'s SQL
- **THEN** it SHALL assert that the victim selection is constrained to positive ids
- **AND** the test SHALL fail if that constraint is removed

### Requirement: Negative ids never cross the network boundary

The client SHALL NOT send a negative message id to the server in any request. In particular,
`chat.tsx`'s scroll-back SHALL NOT issue a server top-up request when the oldest loaded message
id is negative.

#### Scenario: Paging into imported history

- **WHEN** scroll-back reaches the imported block and the oldest loaded id is negative
- **THEN** no `GET /chats/:id/messages` request SHALL be issued
- **AND** `hasMore` SHALL be determined from whether older imported rows exist locally

#### Scenario: Reaching the start of imported history

- **WHEN** the oldest imported message for a chat is loaded and no older local row exists
- **THEN** paging SHALL stop
- **AND** SHALL NOT fall through to a server request

### Requirement: Provenance metadata

Every imported message SHALL carry, in `meta`: an origin marker (`wa-import` for WhatsApp),
the source messenger, the source contact name, the source conversation key, the original
sender label from the export, the original timestamp, and the import session identifier. Where
the source provides an original message identifier, it SHALL be retained.

`content` SHALL hold the exported message body unmodified. Provenance SHALL NOT be written into
the message body.

`createdAt` SHALL be the original timestamp, not the import time.

#### Scenario: Provenance present and body untouched

- **WHEN** an imported message is read back from the local database
- **THEN** its `meta` SHALL contain the origin marker, source messenger, source contact,
  original sender, original timestamp and import session id
- **AND** its `content` SHALL equal the exported body exactly

#### Scenario: Origin distinguishes sources

- **WHEN** messages imported from different messengers exist
- **THEN** each SHALL be distinguishable by its origin marker
- **AND** a VaultChat-native message SHALL be distinguishable from every imported message

### Requirement: Imported messages are attributed in the UI

The conversation SHALL communicate that imported content came from another messenger, and
SHALL NOT present imported messages as newly created VaultChat messages.

Imported messages SHALL display their original timestamps.

#### Scenario: Boundary indicator

- **WHEN** a conversation contains imported messages
- **THEN** the boundary between imported and native history SHALL be visibly marked, naming
  the source messenger and showing its icon

#### Scenario: Per-message source mark

- **WHEN** an imported message is rendered
- **THEN** it SHALL carry its source messenger's own icon, in that messenger's own colour, so
  that WhatsApp, Telegram and Snapchat messages are distinguishable from each other at a glance
- **AND** a VaultChat-native message SHALL carry no such mark
- **AND** the displayed time SHALL be the original timestamp, not the import time

#### Scenario: One source registry

- **WHEN** a source's icon, label or colour is defined
- **THEN** it SHALL come from a single shared definition used by both the source picker and the
  message renderer, so the two cannot disagree about the same source

### Requirement: Deterministic deduplication

Each imported message SHALL carry a deterministic dedupe key derived from the combination of
source, target chat, source conversation, original timestamp, sender, message body or media
identity, and an occurrence index that disambiguates otherwise-identical repeated messages
within the same export. The key SHALL NOT be derived from message text alone.

Uniqueness SHALL be enforced by a database constraint, not by application-side checking.

An import SHALL be safe to retry: re-importing the same export SHALL create no duplicate rows.

#### Scenario: Same export imported twice

- **WHEN** the same export is imported into the same chat a second time
- **THEN** no additional message row SHALL be created
- **AND** the completion screen SHALL report the messages as skipped duplicates

#### Scenario: Genuinely repeated message

- **WHEN** an export contains the same body from the same sender at the same timestamp more
  than once, as real distinct messages
- **THEN** each occurrence SHALL be imported as its own row
- **AND** re-importing the same export SHALL still create no duplicates

#### Scenario: Extended export re-imported

- **WHEN** a later export of the same conversation contains the original messages plus newer
  ones, and is imported into the same chat
- **THEN** only the newer messages SHALL be added
- **AND** the previously imported messages SHALL NOT be duplicated

### Requirement: Transactional and resumable import

Message writes SHALL be committed in bounded batches, each atomic. If an import fails or is
interrupted, already-committed messages SHALL remain consistent and readable, the partial state
SHALL be identifiable, and a retry SHALL complete the import without creating duplicates.

The system SHALL NOT leave a conversation in a corrupted or partially-written state.

#### Scenario: Crash mid-import

- **WHEN** the app is killed while an import is in progress
- **THEN** on next launch every committed message SHALL be present, ordered and readable
- **AND** the import SHALL be reported as incomplete with an option to resume or retry

#### Scenario: Retry after interruption

- **WHEN** an interrupted import is retried with the same export
- **THEN** the import SHALL complete
- **AND** the total number of imported rows SHALL equal the number for a single clean import

#### Scenario: Low storage during import

- **WHEN** the device runs out of storage during an import
- **THEN** the in-flight batch SHALL be rolled back and the failure reported as insufficient
  space
- **AND** previously committed batches SHALL remain intact and consistent

#### Scenario: Offline

- **WHEN** the device has no network connection
- **THEN** the entire import flow SHALL work unchanged, from file selection through completion

### Requirement: Imported data never leaves the device

No exported archive, parsed message, contact detail, timestamp, or imported media SHALL be
transmitted to any VaultChat server or any third party as a result of an import.

This SHALL be enforced by an automated check over the sources of the import path, not by review
alone.

#### Scenario: Full-path audit

- **WHEN** the import path is exercised end to end from file selection to completion
- **THEN** no network request carrying archive contents, parsed messages, contact information,
  timestamps or media SHALL be issued

#### Scenario: Automated enforcement

- **WHEN** the self-test scans `lib/waImport.ts` and `app/import-chats.tsx`
- **THEN** it SHALL assert the absence of `fetch(`, the API client, the socket layer and any
  upload helper
- **AND** the test SHALL fail if such a reference is introduced

#### Scenario: Backend unchanged

- **WHEN** this change is reviewed
- **THEN** no route, schema, or migration under `vaultchat-backend` SHALL have been added or
  modified for it

### Requirement: Contact matching is verified, never guessed

The parsed conversation SHALL be matched against the currently selected VaultChat 1:1 contact
before import, using the strongest available deterministic identifier.

Phone matching SHALL use the peer's number from the device's local contact cache, normalised
with the existing normalisation used for contact discovery. Where the peer's number is not
locally available, matching SHALL fall back to name comparison, and the confirmation screen
SHALL state that the match was made on name alone.

Where the match is uncertain, the system SHALL stop and require the user to confirm or choose
the correct conversation. The system SHALL NOT import a conversation whose counterpart could
not be established.

The system SHALL NOT retrieve the peer's phone number from the server for this purpose.

#### Scenario: Phone match

- **WHEN** the export's counterpart number and the peer's locally-cached number normalise to
  the same value
- **THEN** the match SHALL be reported as confirmed, naming the contact

#### Scenario: Name-only match

- **WHEN** no phone number is available locally but the names correspond
- **THEN** the match SHALL be reported as probable
- **AND** the confirmation screen SHALL state that it matched on name only

#### Scenario: Ambiguous or mismatched contact

- **WHEN** the export's counterpart does not correspond to the selected chat's peer, or
  correspondence cannot be established
- **THEN** the flow SHALL stop and require explicit user confirmation naming both sides
- **AND** SHALL NOT write any message until the user confirms

#### Scenario: Never silently wrong

- **WHEN** matching is uncertain
- **THEN** the system SHALL NOT proceed automatically under any confidence heuristic

### Requirement: Storage schema changes are additive and reversible

The local schema change SHALL be additive: a nullable column plus an index, applied idempotently
at database initialisation following the existing additive-migration pattern. It SHALL succeed
on existing installs and SHALL be inert until an import occurs.

No second local database or competing storage layer SHALL be introduced. Imported messages
SHALL live in the existing `messages` table and be read by the existing readers.

An import SHALL be fully reversible locally by deleting that chat's imported rows, with no
server state to reconcile.

#### Scenario: Upgrade of an existing install

- **WHEN** the app starts on an install created before this change
- **THEN** the schema change SHALL apply without error
- **AND** all existing messages, chats, queues and sync state SHALL be unaffected

#### Scenario: Re-running initialisation

- **WHEN** database initialisation runs again on an already-migrated install
- **THEN** it SHALL succeed without error

#### Scenario: Removing an import

- **WHEN** a chat's imported rows are deleted
- **THEN** the chat SHALL return to exactly its pre-import state
- **AND** no server request SHALL be required

### Requirement: Existing functionality is preserved

This change SHALL NOT alter the behaviour of native 1:1 messaging, groups, invite links, deep
links, onboarding, settings, message rendering for native messages, search, or the existing
local database contracts.

#### Scenario: No imports present

- **WHEN** no import has ever been performed on a device
- **THEN** every existing behaviour SHALL be byte-for-byte unchanged, including prune, sync
  cursor, paging and rendering

#### Scenario: Shared components

- **WHEN** a shared component is modified to support imported-message attribution
- **THEN** its existing consumers SHALL render native messages exactly as before
