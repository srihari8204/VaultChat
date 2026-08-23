## ADDED Requirements

### Requirement: Import is scoped to exactly one conversation

The Exit Kit SHALL operate on exactly one VaultChat 1:1 conversation per invocation. The
system SHALL NOT provide any means to import into more than one conversation from a single
user action, and SHALL NOT provide multi-select of conversations or contacts, an "import all"
action, or automatic or background migration of any kind.

`app/import-chats.tsx` SHALL require a target `chatId` route parameter and SHALL refuse to
render an import flow without one.

#### Scenario: Screen entered without a target chat

- **WHEN** `app/import-chats.tsx` is opened with no `chatId` parameter
- **THEN** it SHALL show a contact-picker prompt to choose one conversation, and SHALL NOT
  present any list allowing more than one conversation to be selected at once

#### Scenario: An import completes

- **WHEN** an import finishes successfully
- **THEN** the completion screen SHALL offer only "Open conversation" and a way to leave
- **AND** it SHALL NOT begin, queue, suggest by default, or offer a one-tap start for any
  further import

#### Scenario: No bulk affordance exists anywhere

- **WHEN** the source of `app/import-chats.tsx` is scanned by the self-test
- **THEN** no multi-selection state (arrays of selected chat ids, "select all" handlers) SHALL
  be present
- **AND** the screen SHALL read its target from a single `chatId` value

### Requirement: Entry points

Exit Kit SHALL be reachable from three places, all of which lead to the same
one-conversation-at-a-time flow.

The 1:1 chat overflow menu SHALL contain an "Exit Kit" action. That action SHALL be present
only when the chat is a direct (1:1) chat, and SHALL be absent for groups.

`app/onboard-success.tsx` SHALL offer "Import an existing conversation" as a secondary action,
visually subordinate to "Continue to Chats". Selecting it SHALL first complete the normal
login, then route to a contact picker, then into the per-chat flow.

`app/settings.tsx` SHALL contain an "Import chats" row that routes to a contact picker and then
into the per-chat flow. The Settings entry SHALL NOT present an overview, dashboard, batch
queue, or per-source status list.

#### Scenario: Group chat overflow menu

- **WHEN** the overflow menu is opened in a group chat
- **THEN** no "Exit Kit" or import action SHALL appear

#### Scenario: 1:1 chat overflow menu

- **WHEN** the overflow menu is opened in a direct chat
- **THEN** an "Exit Kit" action SHALL appear
- **AND** selecting it SHALL open the Exit Kit screen with that chat's id already set as the target

#### Scenario: Onboarding secondary action

- **WHEN** the user selects "Import an existing conversation" on the onboarding success screen
- **THEN** login SHALL complete first
- **AND** the user SHALL then choose exactly one contact before any import UI is shown

### Requirement: Local-only promise is stated to the user

The Exit Kit SHALL state, on the source-selection screen and again on the confirmation screen,
that the import happens on the device and that nothing is uploaded.

#### Scenario: Source selection screen

- **WHEN** the Exit Kit screen opens
- **THEN** it SHALL display "Import one conversation at a time"
- **AND** it SHALL display that the user's data stays on the device and nothing is uploaded

#### Scenario: Confirmation screen

- **WHEN** the confirmation screen is shown
- **THEN** it SHALL display "Nothing will be uploaded. Import happens on this device."

### Requirement: Source picker

The source picker SHALL offer WhatsApp, Telegram and Snapchat. WhatsApp SHALL be selectable.
Sources without an implemented parser SHALL be shown in a "Coming next" state that cannot be
selected and SHALL NOT present a file picker or any partial workflow.

#### Scenario: Selecting an unimplemented source

- **WHEN** the user taps Telegram or Snapchat before its parser ships
- **THEN** the row SHALL be visibly marked "Coming next" and SHALL NOT advance the flow
- **AND** no file picker SHALL open

### Requirement: Flow states

The Exit Kit SHALL represent each of these states distinctly and SHALL be able to reach every
one of them: source selection, file selection, reading export, parsing, matching contact,
preview, confirmation, importing, completed, partial failure, invalid export, duplicate
detected, cancelled, and recoverable/retryable.

Progress SHALL be reported for the currently selected conversation only.

#### Scenario: Progress reporting during parse and import

- **WHEN** an export is being read and parsed
- **THEN** the screen SHALL show the source and the current stage (e.g. "WhatsApp export /
  Finding conversation…"), then the detected contact and message count
- **AND** during the write it SHALL show progress against the total for that one conversation

#### Scenario: Invalid export

- **WHEN** the selected file is not a readable archive, or contains no recognisable WhatsApp
  transcript
- **THEN** the screen SHALL enter the invalid-export state naming what was wrong
- **AND** SHALL offer choosing a different file
- **AND** SHALL NOT crash, and SHALL NOT write any message row

#### Scenario: Cancellation

- **WHEN** the user cancels during parsing or importing
- **THEN** the flow SHALL stop at the next safe boundary
- **AND** any messages already committed SHALL remain valid and consistent
- **AND** the partial state SHALL be resumable or safely re-runnable

### Requirement: Confirmation before writing

The system SHALL NOT write any imported message until the user has confirmed on a screen
showing the source, the matched contact, the message count, and the time range covered.

#### Scenario: Confirmation content

- **WHEN** parsing succeeds and a contact match is established
- **THEN** the confirmation screen SHALL show source, contact name, message count and time range
- **AND** SHALL offer "Import conversation" and "Cancel"

#### Scenario: User cancels at confirmation

- **WHEN** the user chooses Cancel on the confirmation screen
- **THEN** no message row SHALL have been written
- **AND** no file SHALL have been copied out of the archive

### Requirement: Completion reporting

On success the system SHALL report the contact name, the source messenger, the number of
messages imported, the number of duplicates skipped, the number of unsupported items, and
whether original timestamps were preserved. It SHALL offer "Open conversation".

#### Scenario: Completion summary

- **WHEN** an import completes
- **THEN** all six reported values SHALL be shown
- **AND** the counts SHALL reflect what the database actually accepted, not what the parser
  produced

### Requirement: Group conversations are out of scope

Exit Kit SHALL import one-to-one conversations only. The system SHALL NOT import group
conversations, and SHALL NOT provide group-porting, member-overlap, or group-creation
functionality as part of this capability.

Existing group functionality SHALL be left untouched.

#### Scenario: Group export selected

- **WHEN** the user selects an export containing messages from three or more people
- **THEN** the flow SHALL stop before preview and explain that it is a group export
- **AND** no message SHALL be written into the target 1:1 conversation

#### Scenario: Group chat has no Exit Kit entry

- **WHEN** the overflow menu is opened in a group chat
- **THEN** no Exit Kit or import action SHALL appear

#### Scenario: Group code untouched

- **WHEN** this change is reviewed
- **THEN** `app/group-info.tsx`, `app/invite-link.tsx`, `app/join/[code].tsx` and the group
  routes SHALL have no diff attributable to it

### Requirement: Aurora design system and mobile adaptability

Every Exit Kit screen SHALL use the existing Aurora tokens (`constants/theme`, `useTheme()`,
`SPACING`, `RADIUS`, `TYPOGRAPHY`) and the existing `components/ui` primitives. No new visual
system, palette or typography scale SHALL be introduced.

Screens SHALL adapt to small phones, large phones and tablets, to dynamic text sizes, to
keyboard appearance, and to safe areas. No fixed-height container SHALL make content
unreachable on a small screen. Long contact names and source names SHALL truncate rather than
overflow or push controls off-screen.

#### Scenario: Small screen with large system font

- **WHEN** a screen renders on a small phone at the largest dynamic type size
- **THEN** all content SHALL remain reachable by scrolling and no primary action SHALL be
  clipped or pushed outside the safe area

#### Scenario: Long names

- **WHEN** the contact name or source name is longer than its container
- **THEN** it SHALL truncate with an ellipsis and SHALL NOT wrap the layout or displace
  adjacent controls

#### Scenario: Theme

- **WHEN** the device or app switches between light and dark
- **THEN** every Exit Kit screen SHALL follow the active palette via `useTheme()`
