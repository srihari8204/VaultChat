# UI screen audit

This is a complete **source inventory**, not a claim that every screen has been opened or visually approved. The original route matrix retains its **NOT VERIFIED** visual status. Later physical-phone hierarchy observations, APK versions and remaining fixture gaps are recorded separately in [glass-ui-validation.md](glass-ui-validation.md). Source signals identify existing implementation and places to inspect; missing direct markers can be supplied by an inherited layout or child component. A glass token or scroll container alone does not prove visual quality, legibility or responsive fit.

The inventory started while agents were polishing settings and finance. Their edits were preserved and integrated. The inventory generator changes documentation only; separate authorized implementation changes are recorded in integration notes below.

## Initial source findings (historical; integration notes below supersede fixed items)

1. **Critical security text is too small to use as a comfortable default.** `app/dashboard.tsx:142` renders Active Sessions/Devices/Blocked/Account Age labels at 7dp; line 161 renders OK/REVIEW at 7dp. `app/notifications.tsx:193` renders EMERGENCY/TEST at 7dp. These are semantic labels, not decorative separators. Use the established readable caption scale, preserve wrapping/row growth, and check OS font scale 1.0 and 1.5. This is a source-confirmed size finding, not a device clipping claim.
2. **Typography is not consistently connected to the shared scale.** Most route files contain direct `fontSize` literals. The five direct `ui/Text` import sites observed in the earlier inventory included two layouts; changing `TYPOGRAPHY` alone does not update the many native `Text` styles. Migrate actual text consumers with explicit line heights and preserve OS font scaling, instead of assuming a token change has polished every screen.
3. **Some navigation/status icons remain emoji.** Dashboard security statistics and check rows render emoji strings as `Text`; notification settings use the same pattern. Glyph shape, color and baseline then depend on the OS font. Existing Ionicons is already used widely; reuse it for consistent UI icons while preserving labels and accessibility. Content emoji in messages are unrelated and must remain content.
4. **Shared glass primitive changes have limited reach until adopted.** Earlier direct route usage was GlassView on chat, GlassChip on Chats, and no route consumers of GlassCard/shared Header. AuroraBackground is widely used. Editing unused primitives cannot substantiate an all-screen improvement. Prefer existing palette/ground/feature-shell consumers and then deliberate route adoption.
5. **Do not equate a successful automatic route open with a safe visual test.** SOS enables shake detection by default. Invite redemption routes mutate membership on mount. Call/live routes can signal or join media on mount. These must be excluded from blind deep-link sweeps on the user's physical phone.

## Shared implementation priorities

| Existing file(s) | What it controls | Review constraint |
|---|---|---|
| `constants/theme.ts`, `lib/theme.tsx` | Active light/dark palette, contrast, shared typography tokens and live layout update propagation | Verify both themes; retain semantic danger/success and ordinary text contrast |
| `components/ui/AuroraBackground.tsx` | Widely adopted SVG ambient ground | Keep gradients static/cheap; do not replace with per-row blur |
| `constants/glass.ts`, `components/ui/GlassView.tsx` | Chrome/sheet blur, tint, borders, highlight recipes | Blur only selected floating surfaces; preserve Android fallback/performance |
| `components/ui/Text.tsx`, `lib/typeScale.ts` | Brand-font fallback, weight resolution and responsive type | Native Text consumers are not automatically migrated; retain accessibility scaling |
| `components/ui/Sheet.tsx` | Shared action sheet typography, spacing and modal surface | Preserve scrolling, safe-area bottom and accessible cancellation |
| `app/(tabs)/_layout.tsx`, `app/chat.tsx`, `app/(tabs)/chats.tsx` | Most-used navigation/chrome, chat list, composer | Keep message density, keyboard behavior, unread semantics and cold-start speed |
| `constants/financeTheme.ts`, `constants/businessTheme.ts`, feature headers/shells | Feature-specific repeated surfaces | Other agents own finance/settings edits; integrate without overwriting |
| `constants/layout.ts`, `lib/responsive.ts` | Shared safe-area metrics and layout breakpoints | Validate rotation/split screen; a scroll container does not fix horizontal overflow |

## Physical-device validation protocol

Use the user's connected physical phone, preserve its account, app data and E2EE identity, and keep FLAG_SECURE enabled. No uninstall, app-data clear, sign-out, security reset or disabling capture protection is part of a visual sweep. A black screenshot under FLAG_SECURE is expected; UI hierarchy and bounded redacted logs can corroborate navigation but cannot prove glass appearance or text contrast. No current phone screenshot/hierarchy evidence was available to this source audit.

The cold root checks signed-in/MFA/sealed-session state. Signed-out launches redirect to `/onboard`; locked launches to `/app-lock`. Seeing either repeatedly does not verify destination screens. No private credentials or tokens are assumed. Use real authorized fixtures for dynamic paths and loaded content. Record APK hash/version, device size/font scale/theme, actual destination, fixture, loading/empty/error/loaded state, keyboard/scroll, Back behavior and any crashes separately.

Do not automatically open `/emergency-sos`, `/join/[code]`, `/i/[token]`, `/voicecall`, `/videocall`, `/group-call-active` or `/live-view` with live parameters. Do not automatically press send/call/publish/SOS, membership changes, finance save/pay, account deletion, restore/import/purge, or location-sharing controls. Controlled peers and explicit test fixtures are required for these operations. Navigating into an ordinary chat can mark messages read, so select a dedicated test conversation rather than personal unread chats.

## Reading the route matrix

- Glass/ground: direct JSX primitives and source token references, not a visual pass.
- Typography: imported text/feature tokens and smallest numeric `fontSize` property found in the TS AST. A small literal may belong to metadata or a preview; the row calls for inspection, not automatic replacement.
- Responsiveness: live dimensions/layout, safe-area, scroll/list and keyboard source signals. No marker means inspect inherited shells; presence means only that the mechanism exists.
- Dimensions.get is flagged for lifecycle review, not automatically called defective; it can be inside a subscribed callback.
- All 187 route files are included, including legacy redirect screens and nested dynamic routes. Layout/constants files are excluded from the route count.




Source snapshot: 2026-09-20T21:12:40.996Z. routes: **187**; withSmallText: **24**; auroraGround: **123**; directGlassComponent: **2**.

| Route | Source | Glass/ground signals | Typography signals | Responsiveness signals | Source finding / next check | Runtime |
|---|---|---|---|---|---|---|
| `/alerts` | [app/(tabs)/alerts.tsx](../app/(tabs)/alerts.tsx) | glass tokens; Aurora | AppText; min literal 12dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/calls` | [app/(tabs)/calls.tsx](../app/(tabs)/calls.tsx) | glass tokens; Aurora | AppText; min literal 12dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/chats` | [app/(tabs)/chats.tsx](../app/(tabs)/chats.tsx) | GlassChip, glass tokens; Aurora | native/custom Text; min literal 11dp | live window, live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/mini` | [app/(tabs)/mini.tsx](../app/(tabs)/mini.tsx) | glass tokens; Aurora | AppText; min literal 13dp | live window, live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/profile` | [app/(tabs)/profile.tsx](../app/(tabs)/profile.tsx) | glass tokens; Aurora | AppText; min literal 12dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/status` | [app/(tabs)/status.tsx](../app/(tabs)/status.tsx) | glass tokens; Aurora | AppText; min literal 12dp | live layout tokens, scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/add/[...segments]` | [app/add/[...segments].tsx](../app/add/[...segments].tsx) | no direct surface marker; Aurora | native/custom Text; min literal 14dp | no direct marker; inspect inherited shell | source signals only; inspect actual states | NOT VERIFIED |
| `/aiguardian` | [app/aiguardian.tsx](../app/aiguardian.tsx) | glass tokens; Aurora | native/custom Text; min literal 10.5dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/app-lock-chats` | [app/app-lock-chats.tsx](../app/app-lock-chats.tsx) | glass tokens; Aurora | native/custom Text; min literal 10dp | live layout tokens, scroll/list | review small text 10dp:L473 | NOT VERIFIED |
| `/app-lock` | [app/app-lock.tsx](../app/app-lock.tsx) | no direct surface marker; Aurora | native/custom Text; min literal 13dp | scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/archive-viewer` | [app/archive-viewer.tsx](../app/archive-viewer.tsx) | glass tokens; Aurora | native/custom Text; min literal 12dp | safe area, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/backup-e2ee` | [app/backup-e2ee.tsx](../app/backup-e2ee.tsx) | glass tokens; Aurora | native/custom Text; min literal 12dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/backup-pin` | [app/backup-pin.tsx](../app/backup-pin.tsx) | no direct surface marker; AuthSky (intentional auth night) | feature tokens/native Text; min literal 12dp | live layout tokens, scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/biometric-setup` | [app/biometric-setup.tsx](../app/biometric-setup.tsx) | no direct surface marker; Aurora | AppText; min literal 12dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/blocked` | [app/blocked.tsx](../app/blocked.tsx) | glass tokens; Aurora | native/custom Text; min literal 10dp | live layout tokens, scroll/list | review small text 10dp:L349 | NOT VERIFIED |
| `/bookmarks` | [app/bookmarks.tsx](../app/bookmarks.tsx) | glass tokens; Aurora | AppText; min literal 12dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/broadcast` | [app/broadcast.tsx](../app/broadcast.tsx) | glass tokens; Aurora | native/custom Text; min literal 10dp | live layout tokens, scroll/list, keyboard | review small text 10dp:L305 | NOT VERIFIED |
| `/cache-cleanup` | [app/cache-cleanup.tsx](../app/cache-cleanup.tsx) | glass tokens; Aurora | native/custom Text; min literal 11dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/call-recording` | [app/call-recording.tsx](../app/call-recording.tsx) | glass tokens; Aurora | native/custom Text; min literal 11dp | live window, live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/call-reliability` | [app/call-reliability.tsx](../app/call-reliability.tsx) | glass tokens; Aurora | native/custom Text; min literal 13dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/camera` | [app/camera.tsx](../app/camera.tsx) | no direct surface marker; AuroraDark immersive palette | AppText; no numeric literal | safe area, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/chat-backup` | [app/chat-backup.tsx](../app/chat-backup.tsx) | glass tokens; Aurora | native/custom Text; min literal 11dp | live layout tokens, scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/chat-code` | [app/chat-code.tsx](../app/chat-code.tsx) | glass tokens; Aurora | native/custom Text; min literal 12dp | live layout tokens, scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/chat-export` | [app/chat-export.tsx](../app/chat-export.tsx) | glass tokens; Aurora | native/custom Text; min literal 11dp | live layout tokens, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/chat-themes` | [app/chat-themes.tsx](../app/chat-themes.tsx) | glass tokens; Aurora | native/custom Text; min literal 10dp | live layout tokens, scroll/list | review small text 10dp:L152 | NOT VERIFIED |
| `/chat-wallpaper` | [app/chat-wallpaper.tsx](../app/chat-wallpaper.tsx) | glass tokens; Aurora | native/custom Text; min literal 9dp | live window, live layout tokens, scroll/list | review small text 9dp:L272 | NOT VERIFIED |
| `/chat` | [app/chat.tsx](../app/chat.tsx) | GlassView, glass tokens; Aurora | native/custom Text; min literal 11dp | safe area, scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/communities` | [app/communities.tsx](../app/communities.tsx) | glass tokens; Aurora | AppText; min literal 12dp | live layout tokens, scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/contact-info` | [app/contact-info.tsx](../app/contact-info.tsx) | glass tokens; Aurora | native/custom Text; min literal 12dp | live window, live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/contact` | [app/contact.tsx](../app/contact.tsx) | glass tokens; Aurora | native/custom Text; min literal 13dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/contacts` | [app/contacts.tsx](../app/contacts.tsx) | glass tokens; Aurora | native/custom Text; min literal 11dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/create-group` | [app/create-group.tsx](../app/create-group.tsx) | glass tokens; Aurora | native/custom Text; min literal 11dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/create-poll` | [app/create-poll.tsx](../app/create-poll.tsx) | glass tokens; Aurora | native/custom Text; min literal 11dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/creator-channels` | [app/creator-channels.tsx](../app/creator-channels.tsx) | no direct surface marker; no direct ground marker | native/custom Text; no numeric literal | no direct marker; inspect inherited shell | source signals only; inspect actual states | NOT VERIFIED |
| `/current-location` | [app/current-location.tsx](../app/current-location.tsx) | glass tokens; Aurora | native/custom Text; min literal 11dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/d2de-status` | [app/d2de-status.tsx](../app/d2de-status.tsx) | glass tokens; Aurora | native/custom Text; min literal 12dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/dashboard` | [app/dashboard.tsx](../app/dashboard.tsx) | glass tokens; Aurora | AppText; min literal 11dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/decentralized-id` | [app/decentralized-id.tsx](../app/decentralized-id.tsx) | glass tokens; gradient | native/custom Text; min literal 9dp | scroll/list | review small text 9dp:L123 | NOT VERIFIED |
| `/delete-account` | [app/delete-account.tsx](../app/delete-account.tsx) | glass tokens; Aurora | native/custom Text; min literal 12dp | live layout tokens, scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/docscanner` | [app/docscanner.tsx](../app/docscanner.tsx) | glass tokens; Aurora | AppText; min literal 12dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/email-bridge` | [app/email-bridge.tsx](../app/email-bridge.tsx) | glass tokens; Aurora | native/custom Text; min literal 10dp | live layout tokens, scroll/list | review small text 10dp:L410 | NOT VERIFIED |
| `/email-verify` | [app/email-verify.tsx](../app/email-verify.tsx) | no direct surface marker; AuthSky (intentional auth night) | AppText; min literal 13dp | live layout tokens, scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/emergency-sos` | [app/emergency-sos.tsx](../app/emergency-sos.tsx) | glass tokens; Aurora | native/custom Text; min literal 12dp | scroll/list | NO automatic open: shake enabled by default | NOT VERIFIED |
| `/encrypted-notes` | [app/encrypted-notes.tsx](../app/encrypted-notes.tsx) | glass tokens; Aurora | native/custom Text; min literal 10dp | scroll/list, keyboard | review small text 10dp:L1083 | NOT VERIFIED |
| `/family-add` | [app/family-add.tsx](../app/family-add.tsx) | glass tokens; Aurora | AppText; min literal 12dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/family-alerts` | [app/family-alerts.tsx](../app/family-alerts.tsx) | no direct surface marker; SpaceGround | AppText; min literal 11.5dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/family-history` | [app/family-history.tsx](../app/family-history.tsx) | no direct surface marker; SpaceGround | AppText; min literal 11dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/family-items` | [app/family-items.tsx](../app/family-items.tsx) | no direct surface marker; SpaceGround | AppText; min literal 11.5dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/family-map` | [app/family-map.tsx](../app/family-map.tsx) | no direct surface marker; no direct ground marker | AppText; min literal 11dp | safe area, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/family-member` | [app/family-member.tsx](../app/family-member.tsx) | no direct surface marker; SpaceGround | AppText; min literal 11dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/family-places` | [app/family-places.tsx](../app/family-places.tsx) | no direct surface marker; SpaceGround | AppText; min literal 11dp | scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/family-setup` | [app/family-setup.tsx](../app/family-setup.tsx) | no direct surface marker; SpaceGround | AppText; min literal 12dp | scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/family` | [app/family.tsx](../app/family.tsx) | glass tokens; SpaceGround | AppText; min literal 10dp | scroll/list, keyboard | review small text 10dp:L2358 | NOT VERIFIED |
| `/file-preview` | [app/file-preview.tsx](../app/file-preview.tsx) | glass tokens; no direct ground marker | native/custom Text; min literal 11dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/file-viewer` | [app/file-viewer.tsx](../app/file-viewer.tsx) | glass tokens; gradient | native/custom Text; min literal 11dp | live window, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/filevault` | [app/filevault.tsx](../app/filevault.tsx) | no direct surface marker; no direct ground marker | native/custom Text; no numeric literal | no direct marker; inspect inherited shell | redirect wrapper; audit destination | NOT VERIFIED |
| `/finance/calendar` | [app/finance/calendar.tsx](../app/finance/calendar.tsx) | no direct surface marker; finance theme/shell | feature tokens/native Text; min literal 11dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/finance/chitti/[id]` | [app/finance/chitti/[id].tsx](../app/finance/chitti/[id].tsx) | no direct surface marker; finance theme/shell | feature tokens/native Text; min literal 10.5dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/finance/chitti` | [app/finance/chitti/index.tsx](../app/finance/chitti/index.tsx) | no direct surface marker; finance theme/shell | feature tokens/native Text; min literal 12dp | safe area, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/finance/chitti/new` | [app/finance/chitti/new.tsx](../app/finance/chitti/new.tsx) | no direct surface marker; finance theme/shell | feature tokens/native Text; no numeric literal | scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/finance/customer` | [app/finance/customer.tsx](../app/finance/customer.tsx) | no direct surface marker; finance theme/shell | feature tokens/native Text; min literal 10.5dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/finance/emi` | [app/finance/emi.tsx](../app/finance/emi.tsx) | no direct surface marker; finance theme/shell | feature tokens/native Text; min literal 10.5dp | scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/finance` | [app/finance/index.tsx](../app/finance/index.tsx) | no direct surface marker; finance theme/shell | feature tokens/native Text; min literal 9.5dp | safe area, scroll/list | review small text 9.5dp:L194 | NOT VERIFIED |
| `/finance/interest` | [app/finance/interest.tsx](../app/finance/interest.tsx) | no direct surface marker; finance theme/shell | feature tokens/native Text; min literal 10.5dp | scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/finance/io` | [app/finance/io.tsx](../app/finance/io.tsx) | no direct surface marker; finance theme/shell | feature tokens/native Text; min literal 11.5dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/finance/ledger/[id]` | [app/finance/ledger/[id].tsx](../app/finance/ledger/[id].tsx) | no direct surface marker; finance theme/shell | feature tokens/native Text; min literal 10.5dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/finance/ledger/edit` | [app/finance/ledger/edit.tsx](../app/finance/ledger/edit.tsx) | no direct surface marker; finance theme/shell | feature tokens/native Text; no numeric literal | scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/finance/ledger` | [app/finance/ledger/index.tsx](../app/finance/ledger/index.tsx) | no direct surface marker; finance theme/shell | feature tokens/native Text; min literal 11.5dp | safe area, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/finance/ledger/new` | [app/finance/ledger/new.tsx](../app/finance/ledger/new.tsx) | no direct surface marker; finance theme/shell | feature tokens/native Text; no numeric literal | scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/finance/ledger/update` | [app/finance/ledger/update.tsx](../app/finance/ledger/update.tsx) | no direct surface marker; finance theme/shell | feature tokens/native Text; min literal 12dp | scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/finance/reminders` | [app/finance/reminders.tsx](../app/finance/reminders.tsx) | no direct surface marker; finance theme/shell | feature tokens/native Text; min literal 12dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/finance/reports` | [app/finance/reports.tsx](../app/finance/reports.tsx) | no direct surface marker; finance theme/shell | feature tokens/native Text; min literal 16dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/finance/saved` | [app/finance/saved.tsx](../app/finance/saved.tsx) | no direct surface marker; finance theme/shell | feature tokens/native Text; min literal 12.5dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/finance/search` | [app/finance/search.tsx](../app/finance/search.tsx) | no direct surface marker; finance theme/shell | feature tokens/native Text; min literal 12dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/games` | [app/games.tsx](../app/games.tsx) | no direct surface marker; game table/chrome | AppText; min literal 11.5dp | scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/ghost-mode` | [app/ghost-mode.tsx](../app/ghost-mode.tsx) | glass tokens; Aurora | native/custom Text; min literal 12dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/group-admin` | [app/group-admin.tsx](../app/group-admin.tsx) | glass tokens; Aurora | native/custom Text; min literal 11dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/group-calendar` | [app/group-calendar.tsx](../app/group-calendar.tsx) | glass tokens; Aurora | AppText; min literal 11.5dp | scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/group-call-active` | [app/group-call-active.tsx](../app/group-call-active.tsx) | no direct surface marker; no direct ground marker | native/custom Text; min literal 12dp | live layout tokens, scroll/list | controlled session only; may signal/join media on mount | NOT VERIFIED |
| `/group-calls` | [app/group-calls.tsx](../app/group-calls.tsx) | glass tokens; Aurora | native/custom Text; min literal 12dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/group-chat` | [app/group-chat.tsx](../app/group-chat.tsx) | no direct surface marker; no direct ground marker | native/custom Text; no numeric literal | no direct marker; inspect inherited shell | source signals only; inspect actual states | NOT VERIFIED |
| `/group-create` | [app/group-create.tsx](../app/group-create.tsx) | glass tokens; Aurora | AppText; min literal 11.5dp | scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/group-info` | [app/group-info.tsx](../app/group-info.tsx) | glass tokens; Aurora | native/custom Text; min literal 11dp | live window, live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/group-insights` | [app/group-insights.tsx](../app/group-insights.tsx) | glass tokens; Aurora | AppText; min literal 11dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/group-invitations` | [app/group-invitations.tsx](../app/group-invitations.tsx) | glass tokens; Aurora | AppText; min literal 11.5dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/group-invites` | [app/group-invites.tsx](../app/group-invites.tsx) | glass tokens; Aurora | AppText; min literal 11.5dp | scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/group-join` | [app/group-join.tsx](../app/group-join.tsx) | glass tokens; Aurora | AppText; min literal 11.5dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/group-members` | [app/group-members.tsx](../app/group-members.tsx) | glass tokens; Aurora | AppText; min literal 11.5dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/group-notes` | [app/group-notes.tsx](../app/group-notes.tsx) | glass tokens; Aurora | AppText; min literal 11dp | scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/group-privacy` | [app/group-privacy.tsx](../app/group-privacy.tsx) | glass tokens; Aurora | AppText; min literal 11.5dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/group-tasks` | [app/group-tasks.tsx](../app/group-tasks.tsx) | glass tokens; Aurora | AppText; min literal 11.5dp | scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/group-trip` | [app/group-trip.tsx](../app/group-trip.tsx) | glass tokens; Aurora | AppText; min literal 11.5dp | scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/hidden-chats` | [app/hidden-chats.tsx](../app/hidden-chats.tsx) | glass tokens; Aurora | native/custom Text; min literal 12dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/i/[token]` | [app/i/[token].tsx](../app/i/[token].tsx) | no direct surface marker; no direct ground marker | native/custom Text; min literal 14dp | no direct marker; inspect inherited shell | NO automatic open: redeems invite on mount | NOT VERIFIED |
| `/image-editor` | [app/image-editor.tsx](../app/image-editor.tsx) | no direct surface marker; Aurora | AppText; min literal 12dp | live window, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/import-chats` | [app/import-chats.tsx](../app/import-chats.tsx) | glass tokens; Aurora | native/custom Text; min literal 11dp | safe area, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/in-chat-search` | [app/in-chat-search.tsx](../app/in-chat-search.tsx) | glass tokens; Aurora | native/custom Text; min literal 11dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/incoming-call` | [app/incoming-call.tsx](../app/incoming-call.tsx) | no direct surface marker; CALL immersive palette | feature tokens/native Text; min literal 13dp | safe area | source signals only; inspect actual states | NOT VERIFIED |
| `/` | [app/index.tsx](../app/index.tsx) | no direct surface marker; no direct ground marker | native/custom Text; no numeric literal | no direct marker; inspect inherited shell | source signals only; inspect actual states | NOT VERIFIED |
| `/interest-calculator` | [app/interest-calculator.tsx](../app/interest-calculator.tsx) | no direct surface marker; no direct ground marker | native/custom Text; no numeric literal | no direct marker; inspect inherited shell | redirect wrapper; audit destination | NOT VERIFIED |
| `/invite-link` | [app/invite-link.tsx](../app/invite-link.tsx) | glass tokens; Aurora | native/custom Text; min literal 11dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/join/[code]` | [app/join/[code].tsx](../app/join/[code].tsx) | no direct surface marker; Aurora | native/custom Text; min literal 14dp | no direct marker; inspect inherited shell | NO automatic open: redeems invite on mount | NOT VERIFIED |
| `/last-seen-privacy` | [app/last-seen-privacy.tsx](../app/last-seen-privacy.tsx) | glass tokens; Aurora | native/custom Text; min literal 13dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/live-view` | [app/live-view.tsx](../app/live-view.tsx) | no direct surface marker; no direct ground marker | AppText; min literal 10dp | live window, safe area, scroll/list, keyboard | review small text 10dp:L1899; controlled session only; may signal/join media on mount | NOT VERIFIED |
| `/live` | [app/live.tsx](../app/live.tsx) | glass tokens; gradient | AppText; min literal 11dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/live/join/[code]` | [app/live/join/[code].tsx](../app/live/join/[code].tsx) | glass tokens; Aurora | native/custom Text; min literal 12dp | keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/location-lock` | [app/location-lock.tsx](../app/location-lock.tsx) | glass tokens; Aurora | native/custom Text; min literal 11dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/location-sharing` | [app/location-sharing.tsx](../app/location-sharing.tsx) | glass tokens; Aurora | native/custom Text; min literal 9dp | safe area, scroll/list | review small text 9dp:L288 | NOT VERIFIED |
| `/location` | [app/location.tsx](../app/location.tsx) | glass tokens; Aurora | native/custom Text; min literal 11dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/lock-alert` | [app/lock-alert.tsx](../app/lock-alert.tsx) | glass tokens; no direct ground marker | native/custom Text; min literal 11.5dp | no direct marker; inspect inherited shell | source signals only; inspect actual states | NOT VERIFIED |
| `/lock-history` | [app/lock-history.tsx](../app/lock-history.tsx) | glass tokens; Aurora | native/custom Text; min literal 10dp | scroll/list | review small text 10dp:L143 | NOT VERIFIED |
| `/lock-settings` | [app/lock-settings.tsx](../app/lock-settings.tsx) | glass tokens; Aurora | native/custom Text; min literal 11.5dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/lock` | [app/lock.tsx](../app/lock.tsx) | no direct surface marker; no direct ground marker | native/custom Text; min literal 12dp | no direct marker; inspect inherited shell | source signals only; inspect actual states | NOT VERIFIED |
| `/login-history` | [app/login-history.tsx](../app/login-history.tsx) | glass tokens; Aurora | native/custom Text; min literal 10dp | live layout tokens, scroll/list | review small text 10dp:L241 | NOT VERIFIED |
| `/media-gallery` | [app/media-gallery.tsx](../app/media-gallery.tsx) | glass tokens; Aurora | native/custom Text; min literal 10dp | live window, live layout tokens, scroll/list | review small text 10dp:L473 | NOT VERIFIED |
| `/media-viewer` | [app/media-viewer.tsx](../app/media-viewer.tsx) | no direct surface marker; no direct ground marker | native/custom Text; min literal 11dp | live window, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/meeting-scheduler` | [app/meeting-scheduler.tsx](../app/meeting-scheduler.tsx) | no direct surface marker; gradient | native/custom Text; min literal 11dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/message-reminder` | [app/message-reminder.tsx](../app/message-reminder.tsx) | glass tokens; Aurora | native/custom Text; min literal 11dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/mpin-entry` | [app/mpin-entry.tsx](../app/mpin-entry.tsx) | no direct surface marker; AuthSky (intentional auth night) | feature tokens/native Text; min literal 13dp | live layout tokens, scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/mpin-recover` | [app/mpin-recover.tsx](../app/mpin-recover.tsx) | no direct surface marker; AuthSky (intentional auth night) | feature tokens/native Text; min literal 13dp | live layout tokens, scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/msgrequests` | [app/msgrequests.tsx](../app/msgrequests.tsx) | glass tokens; Aurora | native/custom Text; min literal 9dp | live layout tokens, scroll/list | review small text 9dp:L227 | NOT VERIFIED |
| `/navigate` | [app/navigate.tsx](../app/navigate.tsx) | glass tokens; no direct ground marker | native/custom Text; min literal 12dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/network-test` | [app/network-test.tsx](../app/network-test.tsx) | glass tokens; Aurora | native/custom Text; min literal 9dp | live window, scroll/list | review small text 9dp:L451 | NOT VERIFIED |
| `/new-chat` | [app/new-chat.tsx](../app/new-chat.tsx) | glass tokens; Aurora | native/custom Text; min literal 12dp | live layout tokens, scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/notification-sounds` | [app/notification-sounds.tsx](../app/notification-sounds.tsx) | glass tokens; Aurora | native/custom Text; min literal 11dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/notifications` | [app/notifications.tsx](../app/notifications.tsx) | glass tokens; Aurora | native/custom Text; min literal 7dp | live layout tokens, scroll/list | review small text 7dp:L202 | NOT VERIFIED |
| `/offline-mode` | [app/offline-mode.tsx](../app/offline-mode.tsx) | no direct surface marker; Aurora | native/custom Text; min literal 11dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/onboard-mpin` | [app/onboard-mpin.tsx](../app/onboard-mpin.tsx) | no direct surface marker; AuthSky (intentional auth night) | feature tokens/native Text; min literal 13dp | scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/onboard-profile` | [app/onboard-profile.tsx](../app/onboard-profile.tsx) | no direct surface marker; AuthSky (intentional auth night) | feature tokens/native Text; min literal 11dp | live layout tokens, scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/onboard-security` | [app/onboard-security.tsx](../app/onboard-security.tsx) | no direct surface marker; AuthSky (intentional auth night) | feature tokens/native Text; min literal 12dp | live layout tokens, scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/onboard-success` | [app/onboard-success.tsx](../app/onboard-success.tsx) | no direct surface marker; AuthSky (intentional auth night) | feature tokens/native Text; min literal 12dp | no direct marker; inspect inherited shell | source signals only; inspect actual states | NOT VERIFIED |
| `/onboard` | [app/onboard.tsx](../app/onboard.tsx) | no direct surface marker; AuthSky (intentional auth night) | feature tokens/native Text; min literal 11dp | scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/perf-debug` | [app/perf-debug.tsx](../app/perf-debug.tsx) | glass tokens; Aurora | native/custom Text; min literal 11dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/permissions` | [app/permissions.tsx](../app/permissions.tsx) | no direct surface marker; gradient | native/custom Text; min literal 11dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/privacy-dashboard` | [app/privacy-dashboard.tsx](../app/privacy-dashboard.tsx) | glass tokens; Aurora | native/custom Text; min literal 10dp | live layout tokens, scroll/list | review small text 10dp:L470 | NOT VERIFIED |
| `/qr-contact` | [app/qr-contact.tsx](../app/qr-contact.tsx) | glass tokens; Aurora | native/custom Text; min literal 12dp | live layout tokens | source signals only; inspect actual states | NOT VERIFIED |
| `/reader` | [app/reader.tsx](../app/reader.tsx) | no direct surface marker; no direct ground marker | native/custom Text; min literal 12dp | live window, safe area, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/receipt-control` | [app/receipt-control.tsx](../app/receipt-control.tsx) | glass tokens; Aurora | native/custom Text; min literal 10dp | live layout tokens, scroll/list | review small text 10dp:L201 | NOT VERIFIED |
| `/restore-backup` | [app/restore-backup.tsx](../app/restore-backup.tsx) | glass tokens; Aurora | native/custom Text; min literal 12.5dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/scanner` | [app/scanner.tsx](../app/scanner.tsx) | no direct surface marker; gradient | native/custom Text; min literal 9dp | scroll/list | review small text 9dp:L541 | NOT VERIFIED |
| `/schedule-message` | [app/schedule-message.tsx](../app/schedule-message.tsx) | glass tokens; Aurora | native/custom Text; min literal 11dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/scheduled` | [app/scheduled.tsx](../app/scheduled.tsx) | glass tokens; Aurora | AppText; min literal 12dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/search` | [app/search.tsx](../app/search.tsx) | glass tokens; Aurora | AppText; min literal 12dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/security-questions` | [app/security-questions.tsx](../app/security-questions.tsx) | glass tokens; Aurora | AppText; min literal 12dp | live layout tokens, scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/settings` | [app/settings.tsx](../app/settings.tsx) | glass tokens; Aurora | native/custom Text; min literal 11dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/setup-complete` | [app/setup-complete.tsx](../app/setup-complete.tsx) | glass tokens; Aurora | AppText; min literal 12dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/shelf` | [app/shelf.tsx](../app/shelf.tsx) | glass tokens; Aurora | native/custom Text; min literal 11dp | safe area, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/shop-book` | [app/shop-book.tsx](../app/shop-book.tsx) | no direct surface marker; IceGround | feature tokens/native Text; min literal 9.5dp | safe area, scroll/list, keyboard | review small text 9.5dp:L5240 | NOT VERIFIED |
| `/slideshow` | [app/slideshow.tsx](../app/slideshow.tsx) | no direct surface marker; Aurora | native/custom Text; min literal 13dp | live window, live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/space-admin` | [app/space-admin.tsx](../app/space-admin.tsx) | glass tokens; Aurora | AppText; min literal 11.5dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/space-attendance` | [app/space-attendance.tsx](../app/space-attendance.tsx) | glass tokens; Aurora | AppText; min literal 11.5dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/space-checkin` | [app/space-checkin.tsx](../app/space-checkin.tsx) | glass tokens; Aurora | AppText; min literal 11.5dp | scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/space-devices` | [app/space-devices.tsx](../app/space-devices.tsx) | glass tokens; Aurora | AppText; min literal 11dp | scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/space-incidents` | [app/space-incidents.tsx](../app/space-incidents.tsx) | glass tokens; Aurora | AppText; min literal 11.5dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/space-leave` | [app/space-leave.tsx](../app/space-leave.tsx) | glass tokens; Aurora | AppText; min literal 11.5dp | scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/space-ops-map` | [app/space-ops-map.tsx](../app/space-ops-map.tsx) | glass tokens; Aurora | AppText; min literal 11.5dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/space-overview` | [app/space-overview.tsx](../app/space-overview.tsx) | glass tokens; Aurora | AppText; min literal 11dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/space-pending` | [app/space-pending.tsx](../app/space-pending.tsx) | glass tokens; Aurora | AppText; min literal 11dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/space-people` | [app/space-people.tsx](../app/space-people.tsx) | glass tokens; Aurora | AppText; min literal 11dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/space-roster` | [app/space-roster.tsx](../app/space-roster.tsx) | glass tokens; Aurora | AppText; min literal 11.5dp | scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/space-run-driver` | [app/space-run-driver.tsx](../app/space-run-driver.tsx) | glass tokens; Aurora | AppText; min literal 12dp | scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/space-run` | [app/space-run.tsx](../app/space-run.tsx) | glass tokens; Aurora | AppText; min literal 12dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/space-runs-admin` | [app/space-runs-admin.tsx](../app/space-runs-admin.tsx) | glass tokens; Aurora | AppText; min literal 11.5dp | scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/space-tasks` | [app/space-tasks.tsx](../app/space-tasks.tsx) | glass tokens; Aurora | AppText; min literal 11dp | scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/space-transport` | [app/space-transport.tsx](../app/space-transport.tsx) | glass tokens; Aurora | AppText; min literal 11.5dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/space-visitors` | [app/space-visitors.tsx](../app/space-visitors.tsx) | glass tokens; Aurora | AppText; min literal 11.5dp | scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/split` | [app/split.tsx](../app/split.tsx) | glass tokens; no direct ground marker | native/custom Text; min literal 12dp | live window, safe area | source signals only; inspect actual states | NOT VERIFIED |
| `/status-privacy` | [app/status-privacy.tsx](../app/status-privacy.tsx) | glass tokens; Aurora | native/custom Text; min literal 12dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/stickers` | [app/stickers.tsx](../app/stickers.tsx) | glass tokens; Aurora | native/custom Text; min literal 11dp | live window, live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/storage-manager` | [app/storage-manager.tsx](../app/storage-manager.tsx) | no direct surface marker; Aurora | native/custom Text; min literal 12dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/story-viewer` | [app/story-viewer.tsx](../app/story-viewer.tsx) | no direct surface marker; no direct ground marker | native/custom Text; min literal 11dp | no direct marker; inspect inherited shell | source signals only; inspect actual states | NOT VERIFIED |
| `/sync-contact` | [app/sync-contact.tsx](../app/sync-contact.tsx) | glass tokens; Aurora | native/custom Text; min literal 9dp | safe area, scroll/list | review small text 9dp:L268 | NOT VERIFIED |
| `/trusted-contacts` | [app/trusted-contacts.tsx](../app/trusted-contacts.tsx) | glass tokens; Aurora | native/custom Text; min literal 12dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/vault-features` | [app/vault-features.tsx](../app/vault-features.tsx) | glass tokens; Aurora | AppText; min literal 12dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/vault` | [app/vault.tsx](../app/vault.tsx) | glass tokens; Aurora | AppText; min literal 11dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/vaultbeam-settings` | [app/vaultbeam-settings.tsx](../app/vaultbeam-settings.tsx) | glass tokens; Aurora | native/custom Text; min literal 11dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/vaultcheck` | [app/vaultcheck.tsx](../app/vaultcheck.tsx) | glass tokens; Aurora | AppText; min literal 12dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/vaultdrop` | [app/vaultdrop.tsx](../app/vaultdrop.tsx) | glass tokens; Aurora | AppText; min literal 11dp | safe area, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/vaultid` | [app/vaultid.tsx](../app/vaultid.tsx) | glass tokens; Aurora | AppText; min literal 12dp | live window, live layout tokens, scroll/list, keyboard | source signals only; inspect actual states | NOT VERIFIED |
| `/verify-contact` | [app/verify-contact.tsx](../app/verify-contact.tsx) | glass tokens; Aurora | native/custom Text; min literal 11dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/video-player` | [app/video-player.tsx](../app/video-player.tsx) | no direct surface marker; no direct ground marker | native/custom Text; min literal 10dp | live window | review small text 10dp:L812 | NOT VERIFIED |
| `/videocall` | [app/videocall.tsx](../app/videocall.tsx) | no direct surface marker; CALL immersive palette | feature tokens/native Text; min literal 11dp | safe area, scroll/list | controlled session only; may signal/join media on mount | NOT VERIFIED |
| `/voice-effects` | [app/voice-effects.tsx](../app/voice-effects.tsx) | glass tokens; Aurora | native/custom Text; min literal 11dp | live window, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/voice-speed` | [app/voice-speed.tsx](../app/voice-speed.tsx) | glass tokens; Aurora | native/custom Text; min literal 12dp | scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/voice-transcribe` | [app/voice-transcribe.tsx](../app/voice-transcribe.tsx) | glass tokens; Aurora | native/custom Text; min literal 12dp | live layout tokens, scroll/list | source signals only; inspect actual states | NOT VERIFIED |
| `/voicecall` | [app/voicecall.tsx](../app/voicecall.tsx) | no direct surface marker; CALL immersive palette | feature tokens/native Text; min literal 13dp | safe area | controlled session only; may signal/join media on mount | NOT VERIFIED |
| `/whiteboard` | [app/whiteboard.tsx](../app/whiteboard.tsx) | glass tokens; Aurora | native/custom Text; min literal 13dp | no direct marker; inspect inherited shell | source signals only; inspect actual states | NOT VERIFIED |

Excluded: `app/_layout.tsx`, `app/(tabs)/_layout.tsx`, `app/finance/_layout.tsx`, `app/(constants)/authService.ts`. Layouts affect visual behavior but are not separate screens.

## Focused source review: immersive and feature screens

Reviewed 2026-09-21 from the shared working tree. These are **source-reviewed**, not visually verified. Line numbers in messages refer to the moment inspected and can move during integration. Intentional means foreground/background are paired in code, not that every state passes accessibility contrast. Other agents may fix flagged findings after this snapshot.

| Route | Ground / feature signals | Explicit source assessment | Runtime |
|---|---|---|---|
| `/chat` | Aurora + wallpaper + GlassView chrome | Existing glass; preserve user wallpaper. Resolved: attachment-preview caption now uses adaptive text on surfaceSolid. Opening a chat can mark read. | NOT VERIFIED |
| `/chats` | Aurora + GlassChip + adaptive sheets | Existing ground and theme tokens; fixed 22dp unread badge and 11dp section text need font-scale device checks, not automatic restyling of message density. | NOT VERIFIED |
| `/camera` | AuroraDark + camera preview/scrims | Intentional immersive palette across permission, capture and attachment sheet. Preserve preview/rendering and capture controls. | NOT VERIFIED |
| `/docscanner` | Aurora + adaptive document cards | Fixed white/navy ground, dark cards against adaptive labels and white input. Keep document paper preview distinct; import/scan/send handlers unchanged. | NOT VERIFIED |
| `/scanner` | Legacy fixed dark scanner UI | Resolved: white root gradient stop removed; legacy shell remains consistently dark with light labels. Paper preview gradients are intentional content. | NOT VERIFIED |
| `/image-editor` | Aurora + adaptive toolbar/input | Fixed always-white ground and mixed toolbar/input contrast. Image effects, brush/text colors and exported pixels remain content, not palette tokens. | NOT VERIFIED |
| `/media-gallery` | Aurora + adaptive tabs/cards | Existing themed gallery. 10dp counts metadata remain a readability review item; thumbnails are content. | NOT VERIFIED |
| `/media-viewer` | Fixed black media canvas | Intentional coherent immersive palette. View-once may be consumed after load; never use personal view-once files for inspection. | NOT VERIFIED |
| `/file-viewer` | Fixed dark chrome + ink-on-paper document palette | Intentional separate content/chrome palettes explicitly documented in source. No Aurora requirement over a document or image. | NOT VERIFIED |
| `/file-preview` | Adaptive chrome + fixed dark syntax canvas | Fixed theme header/metadata and dark backing for light syntax tokens. Kept native monospace Text for code tokens. | NOT VERIFIED |
| `/video-player` | BG/OVERLAY fixed media palette | Intentional dark playback canvas and white scrim controls. Check 10dp chapter badge separately; no global day-mode recoloring of footage. | NOT VERIFIED |
| `/slideshow` | Aurora + fixed dark media scrims | Mixed feature ground is intentional for slideshow; white controls are paired with dark scrims. Verify image crop and overlay positions on device. | NOT VERIFIED |
| `/story-viewer` | Adaptive base + fixed dark overlays | Resolved: white author/controls on dark top scrim, white caption and viewer-sheet labels; adaptive error states preserved. Viewing can mark stories seen. | NOT VERIFIED |
| `/voicecall` | CALL fixed dark palette | Intentional call surface. Controlled peer only; route may signal outbound call. | NOT VERIFIED |
| `/videocall` | CALL.video + video/scrim palette | Intentional immersive surface; overlay swatches affect video and must remain content. Controlled peer only. | NOT VERIFIED |
| `/incoming-call` | CALL fixed dark palette | Intentional ringtone/accept/decline surface. Do not accept or reject real incoming calls during audit. | NOT VERIFIED |
| `/group-call-active` | Fixed dark tiles + light captions | Intentional conferencing canvas; theme primary/danger used only as action accents. Existing control wrapping should be retained. Route may join/publish media. | NOT VERIFIED |
| `/games` | GameChrome/TableBackground + game theme | Feature shell already supplies ground and glass-like panels. Boards/cards use game semantics, not global application surfaces. Real multiplayer actions excluded from automated tapping. | NOT VERIFIED |
| `/navigate` | Map + adaptive sheet/search controls | Map is the canvas; theme tokens already cover navigation sheet and search. No need to layer Aurora over map. Start/stop navigation and location access require controlled testing. | NOT VERIFIED |
| `/current-location` | Aurora + adaptive location cards | Existing ground/text pairing. Source still uses platform fixed header offsets and 36dp back target; verify insets and touch area. | NOT VERIFIED |
| `/location` | Aurora + adaptive glass cards | Existing theme pairing including explicit primary text override on pale Start live location button. Do not trigger sharing as visual test. | NOT VERIFIED |
| `/onboard` | AuthSky + AUTH fixed night palette | Intentional auth branding; not a light-mode defect. Existing keyboard wrapper and auth semantics retained. | NOT VERIFIED |
| `/onboard-profile` | AuthSky + AUTH + StepRail | Intentional auth branding; avatar and text inputs reviewed as coherent night surfaces. Actual large-font/keyboard visual check pending. | NOT VERIFIED |
| `/onboard-security` | AuthSky + AUTH + StepRail | Intentional auth branding and recovery form. Do not change/save security answers during visual testing. | NOT VERIFIED |
| `/onboard-mpin` | AuthSky + AUTH + StepRail | Intentional night PIN setup; commit/back guards are security behavior and must remain. Small-display keypad fitting needs physical verification. | NOT VERIFIED |
| `/onboard-success` | AuthSky + AUTH | Intentional branded completion surface. Committed-account route must not be re-entered merely for visual checks. | NOT VERIFIED |
| `/email-verify` | AuthSky + AUTH | Intentional night OTP surface; added shared typography, keyboard-safe scrolling and 44dp recovery controls. No OTP/resend behavior changes. | NOT VERIFIED |
| `/mpin-entry` | AuthSky + AUTH | Intentional night unlock surface; no forced theme adoption. Existing secure-input and navigation boundary must remain. | NOT VERIFIED |
| `/mpin-recover` | AuthSky + AUTH + keyboard handling | Intentional night recovery form; do not submit on real account during audit. | NOT VERIFIED |
| `/backup-pin` | Fixed navy gradient + light PIN controls | Coherent legacy immersive PIN ground. Large fixed keypad and static layout metrics warrant device fit review. No automatic credential changes. | NOT VERIFIED |
| `/biometric-setup` | Aurora + adaptive labels | Fixed mixed white/navy gradient and low-contrast labels; content now scrolls. Registration/skip handlers retained. | NOT VERIFIED |
| `/security-questions` | Aurora + adaptive glass and dropdown | Fixed white-on-white options and input contrast. Nested dropdown now scrolls instead of clipping its options. Save/recovery semantics unchanged. | NOT VERIFIED |
| `/setup-complete` | Aurora + adaptive glass | Fixed mixed gradient/light text and added scrolling. markSetupComplete still runs on mount: exclude from blind route sweep. | NOT VERIFIED |
| `/live` | Adaptive live-room list/chrome | Use existing useColors surfaces; no arbitrary ambient layer needed. Broadcast creation is a side effect. | NOT VERIFIED |
| `/live-view` | Fixed black broadcast/media canvas | Intentional immersive stream surface; inspect overlay contrast independently. May join/publish media on mount. | NOT VERIFIED |
| `/reader` | User-selected reader palette | Reader settings choose paper/background/font; retain these choices rather than override with global Aurora. | NOT VERIFIED |
| `/whiteboard` | Aurora + drawing canvas | Resolved: themed native header, fixed paper canvas and dark initial ink. Eraser matches paper; drawing helper lives outside app routes. Drawing colors remain document data. | NOT VERIFIED |
| `/qr-contact` | Aurora + adaptive chrome | Existing theme ground. Preserve white QR quiet zone/black modules as scan data, not a missing dark-mode conversion. | NOT VERIFIED |
| `/stickers` | Aurora + adaptive packs/list | Existing theme surfaces. Sticker glyphs/artwork are content; no global recoloring. | NOT VERIFIED |
| `/voice-transcribe` | Aurora + adaptive transcript UI | Existing theme ground/text. Transcription controls are processing actions, not harmless visual taps. | NOT VERIFIED |
| `/perf-debug` | Aurora + adaptive diagnostic cards | Existing source pairing. Diagnostic data and performance fixtures required for loaded state. | NOT VERIFIED |
| `/network-test` | Aurora + partly fixed header | Resolved: header and adaptive control text corrected in the integrated source. Network tests actively send traffic. | NOT VERIFIED |
| `/family` | SpaceGround + SPACE_GLASS | Feature ground already exists; no missing-Aurora finding. Location/share actions remain sensitive. | NOT VERIFIED |
| `/space-overview` | Space/business theme + native feature header | Inherited feature shell supplies intended ground/tokens. Source matrix now recognizes feature tokens; validate actual header insets separately. | NOT VERIFIED |
| `/shop-book` | IceGround + FIN/FIN_DARK | Feature-specific finance ground and typography; finance agent owns edits. No blanket Aurora replacement. | NOT VERIFIED |

## Frontend-owned integration notes

The earlier priority list is historical. The following authorized changes have been integrated in the shared tree; no runtime visual pass is claimed.

- Dashboard, communities, bookmarks, scheduled and search: Aurora/adaptive glass, shared text, readable labels and keyboard/list clearance. Dashboard white-first gradient and 7dp labels corrected; decorative dashboard emoji replaced with Ionicons.
- Profile, calls, alerts and status tabs: Profile opaque scroll ground corrected; Calls FAB clears tab bar; Alerts row callback refreshes theme styles; Status media preview consistently pairs white controls with a dark canvas.
- Vault, VaultDrop, VaultCheck, Vault Features, VaultID, File Preview and phone verification: readable utility surfaces/modal states, retained immersive code canvas, shared typography where appropriate, keyboard-safe OTP layout. VaultID mixed gradients/input colors corrected.
- Docscanner, image editor, biometric setup, security questions and setup completion: corrected mixed palettes, adaptive glass/typography and scrollable forms; source behavior unchanged. Image effects and generated content retain their original colors.
- Root reports native-header double-inset fixes integrated; the earlier screen-exit failure for d2de-status/group-calendar/group-create is no longer an outstanding finding.

Validation is recorded per implementation batch: focused ESLint and TS parsing, whitespace checks, existing onboarding-navigation and row-overflow checks. Root owns full typecheck/test integration. Actual day/night screenshots, touch-target measurements, Android keyboard behavior and all runtime screen states remain unverified.

## Final auth and four-game source integration review

This review covers the full **187-route source inventory** and the explicit auth/game states below. It does **not** claim that 187 routes, every modal, or every game has been exercised on the phone. All runtime assessments remain **NOT VERIFIED** until device evidence is appended by the root agent. Auth routes intentionally retain their coherent AuthSky/AUTH night palette; this is an explicit immersive branding exception to global day/night surfaces. Game boards likewise retain their purpose-built immersive palettes.

| Screen/state | Source review result | Runtime |
|---|---|---|
| Login landing /onboard | AuthSky, AUTH glass/input treatment, existing KeyboardSafe. Phone submission and navigation handlers preserved. | NOT VERIFIED |
| Login MPIN /mpin-entry | Coherent auth palette; keyboard-safe scroll integration reviewed. PIN validation/session boundary unchanged. | NOT VERIFIED |
| Recovery /mpin-recover | Coherent auth palette and keyboard handling; secure recovery handlers retained. | NOT VERIFIED |
| Signup OTP /email-verify | Shared typography and scrollable keyboard-safe OTP/recovery controls; resend/in-flight latch and consumed-step navigation retained. | NOT VERIFIED |
| Signup profile /onboard-profile | AuthSky, glass form, avatar input, step rail and keyboard handling. Actual phone keyboard/font scale not tested here. | NOT VERIFIED |
| Signup recovery /onboard-security | AuthSky recovery form and keyboard handling; saving answers not exercised on real account. | NOT VERIFIED |
| Signup PIN /onboard-mpin | Keyboard-safe PIN step and existing commit/back guards; no backend/auth changes. | NOT VERIFIED |
| Signup completion /onboard-success | AuthSky completion surface; committed-account guards remain. Do not reopen to simulate signup. | NOT VERIFIED |
| Legacy recovery /security-questions | Adaptive Aurora/glass, readable warning/action colors, nested scrolling question options and secure answer fields. | NOT VERIFIED |
| Legacy biometric /biometric-setup | Adaptive Aurora, readable labels and step indicators, scrollable content. Biometric prompt not triggered by audit. | NOT VERIFIED |
| Legacy completion /setup-complete | Adaptive glass and readable action, scrollable summary. Mount writes setup-complete state: excluded from blind navigation. | NOT VERIFIED |
| Chess /games?game=chess | Measured board box; rim and coordinate rail counted inside board width; portrait ownership and scroll fallback. Board rules/socket intents unchanged by visual work. | NOT VERIFIED |
| Ludo /games?game=ludo | Immersive ludoGlass room and SVG board; measured scroll container and portrait ownership. Server-authoritative movable tokens and dice unchanged. | NOT VERIFIED |
| Rummy /games?game=rummy | Measured landscape container, symmetric safe-area calculation and independent rummyGlass palette retained. Toolbar font-scale limit below requires explicit follow-up. | NOT VERIFIED |
| Tic-tac-toe /games?game=tictactoe | Immersive table theme; integer cell sizing, measured board box and portrait ownership. Turn/empty-cell guards unchanged. | NOT VERIFIED |

Game shared furniture review found keyboard/short-landscape sheet constraints and label shrink support; the game agent owns those fixes and their focused checks. Rummy's action row reserves 46dp and individual controls 36dp; two vertically stacked scalable 11dp Text lines cannot both fit at 2x font scale. Integrated source now omits the decorative glyph above fontScale 1.25 while keeping the scalable caption and full accessibility label. This avoids the two-line stack at 2x without altering game geometry, but physical font-scale verification remains pending; do not claim a large-font game pass. The fixed board/control geometry was not speculatively expanded.

Integration review also found nested AppText inheritance: inline text must inherit its parent's font/color instead of reverting to body defaults. The shared TextVariantContext correction is integrated; root owns its validation. A source AST comparison across 109 changed route/layout files found no changed JSX action callbacks or effect bodies except intentional Whiteboard ref-sync additions; this check is narrower than a complete behavioral test. Existing staged safety edits were preserved.

# Follow-up changed-screen verification

The 2026-09-21 user-requested review of all 117 changed routes and three shared layouts is tracked separately in [changed-screen-device-review.md](changed-screen-device-review.md). That matrix distinguishes source review, initial physical-phone hierarchy observations, missing-parameter dialogs and fixture-dependent flows. It does not mark an entire screen visually verified from its title alone.
