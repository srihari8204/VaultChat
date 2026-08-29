# Tasks — Chat–Map Separation

## 1. Envelope at the send sites

- [x] 1.1 Change `ProcessOpts.announce` in `lib/family/fixPipeline.ts` from
      `(text: string)` to a typed event `{kind, actorId, actorName, text, at}`;
      emit it for geofence enter/leave AND the overspeed alert (D1).
- [x] 1.2 Update both announce implementations — `lib/family/presence.ts` and
      `lib/family/background.ts` — to send
      `JSON.stringify({famEvent:{v:1, ...event}})` as a `system` message instead
      of plain text. No other announce sender exists (verified by grep).

## 2. Hide from chat surfaces

- [x] 2.1 Extend the thread filter in `app/chat.tsx` (the `"family":true`
      block) to also drop `type === 'system'` messages whose content contains
      `"famEvent"`.
- [x] 2.2 Skip famEvent messages when deriving the chat row preview in
      `app/(tabs)/chats.tsx`, so a crossing never becomes a chat's "last
      message" (D3).

## 3. App-wide receiver ingest

- [x] 3.1 Add `ingestFamEvent(chatId, content, myId)` to `lib/family/alerts.ts`:
      parse the envelope defensively, skip `actorId === myId`, map to
      `recordAlert` (existing dedupe is the backstop). Pure parse part
      self-checkable.
- [x] 3.2 Call it from the app-wide `new_message` listener in
      `app/_layout.tsx` (beside the notification handler), for decrypted
      system messages only (D2).
- [x] 3.3 Ensure the message-notification path does NOT raise a push/banner
      for famEvent messages (they must not vibrate the phone as "new message";
      the alerts badge is their surface).

## 4. Chat shortcut on map surfaces

- [x] 4.1 Add the chat icon to `spaceHeader()`'s headerRight in
      `lib/spaces/theme.ts`, pushing `/chat` with `{chatId: spaceId, name}` —
      every space screen inherits it (D5).
- [x] 4.2 Add the same shortcut to the family screen header for the active
      circle in `app/family.tsx`.

## 5. Verification

- [x] 5.1 Self-check for the envelope parse/build round-trip (pure part, tsx-runnable).
- [x] 5.2 tsc + eslint clean; full `npm test` green.
- [ ] 5.3 Device: enable sharing, cross a geofence (or simulate via lockBridge),
      confirm the thread shows nothing, the alerts inbox shows the crossing on
      the SECOND phone, and the chat shortcut opens the same thread from a
      space screen and the chats tab.
