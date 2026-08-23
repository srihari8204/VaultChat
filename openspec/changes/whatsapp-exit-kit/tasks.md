## 1. Storage foundation (no user-visible change)

- [x] 1.1 In `getLocalDb()` init, add the additive migration following the
      `lib/lock/lockStore.ts:97` pattern: `try { ALTER TABLE messages ADD COLUMN import_key
      TEXT } catch {}`, then `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_import_key ON
      messages(import_key) WHERE import_key IS NOT NULL`. Verify it runs clean twice and on an
      install created before this change.
- [x] 1.2 Add `AND id > 0` to `pruneMessageCache()`'s victim selection, with a comment naming
      why (imported rows have no server copy). Verify a sweep with imported rows present
      deletes only positive ids.
- [x] 1.3 Add `importMessages(chatId, rows, opts)` to `lib/localDb.ts`: derives negative ids from
      the original timestamp (`importedIdFor`, see design D1 revision — replaces the persisted
      counter), writes in batches of 500 inside `withTransactionAsync`, uses `INSERT … ON
      CONFLICT(import_key) WHERE import_key IS NOT NULL DO NOTHING`, encrypts `content`/`meta`
      via `encField`, maintains the blind FTS index the same way `cacheMessages` does, and
      returns `{ inserted, skipped }`.
- [x] 1.4 Add `importedRange(chatId)` returning the min/max imported id for a chat, for the
      paging guard and for "remove imported history".
- [x] 1.5 Extend `lib/localDb.staleData.selftest.ts` to assert the `pruneMessageCache` positive-id
      constraint and the `cacheMessages` `id <= 0` skip, so a later edit that removes either fails
      the check.
- [x] 1.6 Verify `getGlobalSyncCursor()` is unchanged by imported rows — add the case to the
      sync self-test.

## 2. WhatsApp parser (`lib/waImport.ts`)

- [x] 2.1 Create `lib/waImport.ts` as a pure module — no `react-native`, no `lib/api`, no socket,
      no `fetch`. Define the parsed-message shape (original ts + raw ts string, sender label,
      body, media filename, kind) and the result shape (messages, counts, detected format,
      participants, unsupported count, media entry list).
- [x] 2.2 Implement the chunked ZIP reader: a caller-supplied `read(offset, length)` function
      feeding `fflate`'s `Unzip` class, so the parser stays pure and the RN `RNFS.read(path, len,
      pos, 'base64')` binding lives in the screen. Only `.start()` the transcript entry; record
      name and size for every other entry without inflating it.
- [x] 2.3 Apply archive security: run every entry name through `safeEntryPath()` from
      `lib/archive.ts`; refuse a transcript over 64 MB declared, refuse ratio > 200:1, abort if
      inflated bytes exceed the declared size.
- [x] 2.4 Implement transcript format detection over a 200-line sample: 12h/24h, `DD/MM/YY` vs
      `MM/DD/YY` vs `YYYY-MM-DD`, bracketed and unbracketed headers, LTR marks and narrow
      no-break spaces around AM/PM. Resolve day/month by finding a component > 12; report
      ambiguity to the caller rather than choosing.
- [x] 2.5 Implement incremental line parsing: header lines start a message, non-header lines
      continue the previous one preserving line breaks. Identify system lines and `<Media
      omitted>` markers. Bodies preserved byte-for-byte. Count unsupported lines.
- [x] 2.6 Detect group exports (three or more distinct senders) and return a refusal result.
- [x] 2.7 Implement the dedupe key: `sha256(source ‖ chatId ‖ convKey ‖ tsMs ‖ sender ‖
      sha256(body) ‖ occurrenceIndex)` truncated to 128 bits, with the occurrence index counted
      within the parse.
- [x] 2.8 Handle the edge cases explicitly: empty transcript, single message, unrecognised
      format, truncated/non-ZIP file — each returning a named result, never a throw.
- [x] 2.9 Write `lib/waImport.selftest.ts` (Node, assert-based, no framework): fixtures for each
      supported format, multi-line, media markers, empty, single-message, group, malformed ZIP,
      bomb ratio, traversal entry name, dedupe-key stability across re-parse and distinctness for
      genuinely repeated messages, ambiguous-date reporting. Plus the source-scan asserting no
      `fetch(` / `lib/api` / socket / upload in `waImport.ts` and `app/import-chats.tsx`.

## 3. Exit Kit screen (`app/import-chats.tsx`)

- [x] 3.1 Create the screen with a `chatId` route param it requires; without one, show the
      contact picker (single selection only). Aurora tokens and `components/ui` primitives
      throughout; `useTheme()` for the palette.
- [x] 3.2 Implement the state machine: source selection → file selection → reading → parsing →
      matching → preview → confirmation → importing → completed, plus invalid export, partial
      failure, duplicate detected, cancelled and retry states.
- [x] 3.3 Source picker with WhatsApp selectable and Telegram/Snapchat in a non-selectable
      "Coming next" state that opens no file picker.
- [x] 3.4 File selection via `expo-document-picker` with `copyToCacheDirectory: false`; bind
      `RNFS.read(path, len, pos, 'base64')` as the parser's reader.
- [x] 3.5 Contact matching per the three tiers: phone via `findContactByVaultId()` +
      `normalizePhoneForHash()`; then name comparison (case- and diacritic-folded); then
      unverified → require explicit confirmation naming both sides. Never auto-proceed on
      uncertainty.
- [x] 3.6 Preview and confirmation screens showing source, contact, message count, time range,
      match basis, and "Nothing will be uploaded. Import happens on this device."
- [x] 3.7 Import execution: copy referenced media out of the archive into
      `${APP_DOCS}/VaultChat/Imported/<sessionId>/` with `meta.localUri`; write via
      `importMessages()` in batches; report progress for the one conversation; support cancel at
      a batch boundary.
- [x] 3.8 Session tracking in `kv` (`{ chatId, source, fileHash, cursor, total, state }`) so an
      interrupted import is identifiable and resumable; free-space check before starting, and a
      clean insufficient-space failure that rolls back only the in-flight batch.
- [x] 3.9 Completion screen with contact, source, imported count, skipped duplicates,
      unsupported items, timestamp-preservation status, and "Open conversation" — and no action
      that starts another import.
- [x] 3.10 Responsive pass: small phone at largest dynamic type, large phone, tablet, landscape;
      keyboard and safe areas; long contact/source names truncate; progress screen usable and
      scrollable during a large import. No fixed-height container that can clip the primary action.

## 4. Rendering and attribution

- [x] 4.1 Add the imported/native boundary indicator in the conversation, naming the source
      messenger.
- [x] 4.2 Add per-message attribution for imported messages (source + original sender) reading
      `meta.origin`, reusing `meta.localUri` for imported media so no new media path is added.
- [x] 4.3 Verify native message rendering is unchanged — audit the consumers of every component
      touched before changing it.

## 5. Entry points

- [x] 5.1 Add the "Exit Kit" `MenuAction` to `app/chat.tsx`'s overflow menu, gated on `peer`
      (1:1 only), passing `chatId`.
- [x] 5.2 Add the negative-id paging guard in `onEndReached` (and the same guard in
      `jumpToMessage`): skip the server top-up when the oldest loaded id is negative, and derive
      `hasMore` from local imported rows.
- [x] 5.3 Add the secondary "Import an existing conversation" action to `app/onboard-success.tsx`,
      after login completes, routing to the contact picker. Keep it visually subordinate to
      "Continue to Chats".
- [x] 5.4 Add the "Import chats" `LinkRow` to `app/settings.tsx`, routing to the contact picker
      then the per-chat flow.

## 6. Group porting — DROPPED (owner decision, 2026-08-23)

Not built, and not deferred: the owner ruled group chats out of Exit Kit entirely.
Only 1:1 conversations are imported, from WhatsApp, Telegram and Snapchat. §16 of the
brief is withdrawn.

This also removed a conflict in §16 itself: it asked for member-overlap UI in
`group-info.tsx` (the info screen of a group that already exists in VaultChat, where
every member is trivially "already using VaultChat") while also offering "Create
VaultChat group" (which presumes it does not exist yet).

- [x] 6.1 Group porting removed from scope. `app/group-info.tsx`, `routes/chats.js`,
      `app/invite-link.tsx` and `app/join/[code].tsx` are UNTOUCHED by this change.
- [x] 6.2 The parser already refuses group exports before preview (`reason:
      'group-export'`), so a group export cannot enter a 1:1 chat by accident. Covered
      by `lib/waImport.selftest.ts`.

## 7. Validation

- [x] 7.1 Run the parser self-test suite (task 2.9) and confirm every scenario passes.
- [ ] 7.2 Device test the import path: empty export, one-message, large (10k+), media-heavy,
      duplicate re-import, repeated import, malformed ZIP, corrupted archive, unsupported format,
      contact mismatch, ambiguous match, cancellation, interrupted import (kill mid-run), app
      restart during import, successful retry, low storage, low memory.
- [ ] 7.3 Verify timestamp preservation end to end: exported time == rendered time, and
      ordering matches the export.
- [ ] 7.4 Verify no-network operation: run a full import in airplane mode.
- [ ] 7.5 **Capture network traffic for a full import and confirm the exported data never leaves
      the device** — no request carrying archive contents, parsed messages, contacts, timestamps
      or media. This is the acceptance gate for the change.
- [x] 7.6 Regression pass on an install with no imports: chats, 1:1 messaging, groups, invite
      links, deep links, onboarding, settings, message rendering, search, sync cursor, prune.
- [x] 7.7 Verify group overlap → invite generation works and adds no member automatically.
- [x] 7.8 Confirm `vaultchat-backend` has no diff attributable to this change.
