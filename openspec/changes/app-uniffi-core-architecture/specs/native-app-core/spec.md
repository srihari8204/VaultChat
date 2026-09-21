## ADDED Requirements

### Requirement: React Native owns all visible UI
The app SHALL render screens, navigation, glassmorphism, icons, fonts, gestures, accessibility, animations and safe-area responsive layout through React Native/TSX.

#### Scenario: A screen uses native logic
- **WHEN** a screen calls a Rust/UniFFI helper
- **THEN** the screen still renders with React Native components and keeps its theming, accessibility and responsive layout in TSX

#### Scenario: UI needs visual polish
- **WHEN** a card, table, board, icon, animation or glass effect changes
- **THEN** the change is implemented in TSX/design assets rather than inside the Rust/UniFFI core

### Requirement: UniFFI cores expose only deterministic client helpers
Native app cores SHALL expose pure deterministic helpers over serializable inputs and outputs. They SHALL NOT own React component state, sockets, navigation, database handles, network clients or UI objects.

#### Scenario: A helper is eligible for UniFFI
- **WHEN** a function depends only on explicit inputs and returns a serializable result
- **THEN** it may be migrated to Rust/UniFFI with parity tests

#### Scenario: A helper is not eligible for UniFFI
- **WHEN** a function directly reads React state, opens network sockets, mutates navigation, draws UI or depends on a live database handle
- **THEN** it remains in TypeScript or backend code

### Requirement: Native calls go through TypeScript wrappers
Every Rust/UniFFI helper used by the app SHALL be called through a TypeScript wrapper that owns native availability checks, fallback selection and the app-facing API.

#### Scenario: Native module is available
- **WHEN** the wrapper self-check passes
- **THEN** the wrapper may call the native helper and return its result to the screen

#### Scenario: Native module is unavailable
- **WHEN** the wrapper self-check fails or the native helper throws during initialization
- **THEN** the wrapper uses the TypeScript fallback and the user-visible feature remains usable

### Requirement: Native migration requires parity evidence
Before a TypeScript helper is replaced by Rust/UniFFI output by default, the migrated helper SHALL have runnable parity checks against the current TypeScript behavior.

#### Scenario: Migrating an existing helper
- **WHEN** a TypeScript helper is ported to Rust/UniFFI
- **THEN** representative fixtures prove the Rust output matches the TypeScript reference before native output is enabled by default

#### Scenario: Parity fails
- **WHEN** a parity check detects a mismatch
- **THEN** the wrapper keeps the TypeScript path as the default until the mismatch is resolved or intentionally specified

### Requirement: Backend authority remains server-side
Rust/UniFFI client cores SHALL NOT become the authority for auth, permissions, balances, payments, message ordering, group membership, game outcomes, legal game moves, server-side scoping or persisted sync truth.

#### Scenario: Client computes a display helper
- **WHEN** the native core derives a local display model from server data
- **THEN** it does not invent or override server-owned truth

#### Scenario: Server and client disagree
- **WHEN** a server response conflicts with a client-derived value
- **THEN** the server response wins and the client display updates from server data
