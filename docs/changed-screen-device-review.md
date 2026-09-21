# Changed-screen review — 2026-09-21

The user subsequently reported resizing failures during gameplay. The shared safe-area/orientation flow and all four game layouts have now received a further source correction; see the latest gameplay section in [glass-ui-validation.md](glass-ui-validation.md). The 81-route phone observations below predate those corrections and do not establish live-game responsiveness.

All 117 changed route files and 3 shared layouts received source review using three agents and the OpenSpec glass-screen-polish change. This is a changed-file inventory, separate from the full 187-route inventory.

## Physical phone evidence

Redmi Note 8 Pro, Android 11, 1080×2340, density 440, Light appearance, font scale 1.0. The initial sweep applies to APK SHA-256 0C7D0799F6F92DE617AB95F9BC55650032CA2E9183934FAC69A6D4AC2346025D. Follow-up APK results must be recorded separately.

Initial labels/bounds observed: 81/117. Fixture-required routes not opened: 27. Other routes without established initial screen: 9. These counts describe exposed UI hierarchy, not visual approval, successful controls, scrolling, or populated fixture coverage.

MIUI rejects INJECT_EVENTS and WRITE_SETTINGS. FLAG_SECURE stays enabled. Day/night switching, large-font/landscape interaction and rendered pixel inspection are unverified on this build. No account reset, live message/call/game, SOS, contact upload, money write or location-sharing test was performed.

A missing-parameter Spaces error dialog obstructed subsequent deep links in the first sweep. Dialog-sized windows are excluded from established-screen counts. Affected routes were retried with fresh activity launches; failed fresh captures remain unverified. Routes with valid record IDs need controlled fixtures even when their parameter-free shell was observed.

## Corrections from this review

- Doc Scanner: dark-blue/indigo source buttons and solid-white subtitles (minimum endpoint contrast 6.70:1); recent document metadata and actions wrap.
- New Chat: action labels take available width and wrap at enlarged fonts.
- Driver: heartbeat only runs for a matching, loaded, started run while focused; cleanup stops its timer. The server already rejects inactive-run pings.

Focused geometry, theme and navigation checks supplement source review. They do not certify all device sizes. See glass-ui-validation.md for build/test and installation results.

## Every changed route

| File | Redmi initial-state evidence | Scope / remaining fixture |
|---|---|---|
| `app/(tabs)/alerts.tsx` | Initial labels/bounds observed | Reads audit/security events; do not tap Scan device. |
| `app/(tabs)/calls.tsx` | Initial labels/bounds observed | Reads call history; do not initiate calls or delete entries. |
| `app/(tabs)/chats.tsx` | Initial labels/bounds observed | Mount registers push token; use existing authenticated tab baseline only, permission/registration fixture for fresh navigation. |
| `app/(tabs)/mini.tsx` | Initial labels/bounds observed | Tool directory and local todo read; do not submit todo or start tools. |
| `app/(tabs)/profile.tsx` | Initial labels/bounds observed | Reads profile; no photo picker, verify SMS, save, or sign-out. |
| `app/(tabs)/status.tsx` | Initial labels/bounds observed | Reads status lists; no posting/picker or story opening. |
| `app/app-lock-chats.tsx` | Initial labels/bounds observed | Reads chat lock inventory; do not unlock, create, edit or disable locks. |
| `app/app-lock.tsx` | Fixture required | Session security gate; may auto-authenticate or redirect; controlled locked-session fixture. |
| `app/backup-pin.tsx` | Fixture required | Backup PIN setup; auth/onboarding fixture, never enter or replace real PIN. |
| `app/biometric-setup.tsx` | Fixture required | Biometric enrollment/onboarding flow; controlled fixture and explicit biometric interaction. |
| `app/blocked.tsx` | Fixture required | Threat-enforcement screen takes threats/level; controlled threat fixture, not normal navigation. |
| `app/bookmarks.tsx` | Initial labels/bounds observed | Authenticated read-only landing/list/settings load; no submit, delete, toggle or external actions. Source review only; native result not verified. |
| `app/chat.tsx` | Initial labels/bounds observed | ONLY parameter-free missing-conversation state is safe. Valid id loads private messages and sends durable delivered/read receipts/live viewing state; no real conversation fixture used. |
| `app/communities.tsx` | Initial labels/bounds observed | Authenticated read-only landing/list/settings load; no submit, delete, toggle or external actions. Source review only; native result not verified. |
| `app/contact-info.tsx` | Initial labels/bounds observed | No parameters renders Contact fallback; reads block list but skips chat/messages/common groups without ids. Passing chatId reads up to 200 private messages/media, so populated coverage excluded. |
| `app/contact.tsx` | Initial labels/bounds observed | Parameter-free static fallback profile; no mount effect. Do not tap message/call/video/export/delete controls. |
| `app/contacts.tsx` | Fixture required | Mount automatically requests Contacts permission, reads entire device address book, hashes phones and POSTs contacts/match; excluded from automatic read-only sweep even if permission already granted. |
| `app/create-group.tsx` | Initial labels/bounds observed | No params: reads chats and access token to populate the picker. Group creation is button-only. Check initial form only; do not select/create. |
| `app/create-poll.tsx` | Initial labels/bounds observed | Initial no-param compose screen has no mount effect; createPoll executes only on Send. Full send coverage requires controlled chatId. No input or submission. |
| `app/d2de-status.tsx` | Initial labels/bounds observed | Authenticated read-only landing/list/settings load; no submit, delete, toggle or external actions. Source review only; native result not verified. |
| `app/dashboard.tsx` | Fresh hierarchy capture unavailable | Authenticated read-only landing/list/settings load; no submit, delete, toggle or external actions. Source review only; native result not verified. |
| `app/docscanner.tsx` | Initial labels/bounds observed | Initial landing mount only animates and reads local recent-document storage. Camera/gallery/scanning and sending require controlled media and permission fixtures; no actions. |
| `app/email-bridge.tsx` | Initial labels/bounds observed | Encrypted email landing; no compose/send/settings modifications. |
| `app/email-verify.tsx` | Fixture required | OTP verification depends on onboarding phone ticket; no resend/submit against real account. |
| `app/emergency-sos.tsx` | Fixture required | Sensitive SOS/location/alarm flow; controlled contacts and permissions fixture only. |
| `app/family-add.tsx` | Initial labels/bounds observed | No params: reads chats/token; circleMembers is skipped without circleId. Missing destination, not an invitation-flow verification. Do not invite, share code or open address-book actions. |
| `app/family-alerts.tsx` | Fixture required | Opening/focusing calls markAllRead(circleId) after600ms. No-param circleId is null, which marks ALL local circle alerts read; requires a controlled alert fixture. |
| `app/family-history.tsx` | Initial labels/bounds observed | No params: loads local alerts then exits track loading because circleId is absent. Empty history shell only; no location request or track fetch. |
| `app/family-items.tsx` | Initial labels/bounds observed | No params: reads saved items/current user. BLE scanning starts false and only explicit Start enables scanning/location sightings. Do not scan, pair, toggle or edit. |
| `app/family-map.tsx` | Fixture required | No-param render is a missing-space state, but hooks still read cached device location on mount and can observe an existing global trip/navigation state. Requires controlled location/trip fixture for strict read-only sweep. |
| `app/family-member.tsx` | Initial labels/bounds observed | No params: local alerts load; relation/history/place loading is guarded by circleId and userId. Empty member shell only. Do not invoke relationship, chat or route actions. |
| `app/family-places.tsx` | Initial labels/bounds observed | No params: place/default-reference reads skip without circleId and list stays empty. Location permission, adding zones, notifications and reference changes require explicit actions; do not use them. |
| `app/family-setup.tsx` | Initial labels/bounds observed | Initial create/join form has no mount mutation or location effect. Do not submit Create or Join. |
| `app/family.tsx` | Fixture required | No params chooses existing/default space and starts presence/subscriptions; saved sharing may request permission and publish location. Also derives/persists alerts and may auto-navigate an active driver to run screen. Controlled space/location fixture required. |
| `app/file-preview.tsx` | Fixture required | Requires known harmless local uri/filename or controlled mediaUrl; may fetch file contents. |
| `app/file-viewer.tsx` | Fixture required | Requires controlled uri/filename/mimeType; media playback and file actions need fixtures. |
| `app/finance/calendar.tsx` | Initial labels/bounds observed | No parameters needed. Mount/focus reads on-device finance rows for current account (local fallback); financeDb may initialize local schema. No money writes on entry. Do not activate add/edit/delete/reminder actions. |
| `app/finance/chitti/[id].tsx` | Fixture required | Dynamic route requires existing approved on-device record id; do not invent an id or create financial records. Placeholder is not a launchable route. Entry reads local record; buttons can mutate. |
| `app/finance/chitti/index.tsx` | Initial labels/bounds observed | No parameters needed. Mount/focus reads on-device finance rows for current account (local fallback); financeDb may initialize local schema. No money writes on entry. Do not activate add/edit/delete/reminder actions. |
| `app/finance/chitti/new.tsx` | Initial labels/bounds observed | No parameters needed. Form/calculator/import-export shell only; writes, document picker, export and notifications require explicit controls. Do not save/import/export/create. |
| `app/finance/customer.tsx` | Initial labels/bounds observed | Without name shows empty customer shell; meaningful populated coverage needs approved local customer fixture/name. No query without name. |
| `app/finance/emi.tsx` | Initial labels/bounds observed | No parameters needed. Form/calculator/import-export shell only; writes, document picker, export and notifications require explicit controls. Do not save/import/export/create. |
| `app/finance/index.tsx` | Initial labels/bounds observed | No parameters needed. Mount/focus reads on-device finance rows for current account (local fallback); financeDb may initialize local schema. No money writes on entry. Do not activate add/edit/delete/reminder actions. |
| `app/finance/interest.tsx` | Initial labels/bounds observed | No parameters needed. Form/calculator/import-export shell only; writes, document picker, export and notifications require explicit controls. Do not save/import/export/create. |
| `app/finance/io.tsx` | Initial labels/bounds observed | No parameters needed. Form/calculator/import-export shell only; writes, document picker, export and notifications require explicit controls. Do not save/import/export/create. |
| `app/finance/ledger/[id].tsx` | Fixture required | Dynamic route requires existing approved on-device record id; do not invent an id or create financial records. Placeholder is not a launchable route. Entry reads local record; buttons can mutate. |
| `app/finance/ledger/edit.tsx` | Initial labels/bounds observed | Without id renders header-only fallback and skips local record query. Does NOT cover edit/update form. Populated coverage needs existing approved local ledger id; never save. |
| `app/finance/ledger/index.tsx` | Initial labels/bounds observed | No parameters needed. Mount/focus reads on-device finance rows for current account (local fallback); financeDb may initialize local schema. No money writes on entry. Do not activate add/edit/delete/reminder actions. |
| `app/finance/ledger/new.tsx` | Initial labels/bounds observed | No parameters needed. Form/calculator/import-export shell only; writes, document picker, export and notifications require explicit controls. Do not save/import/export/create. |
| `app/finance/ledger/update.tsx` | Initial labels/bounds observed | Without id renders header-only fallback and skips local record query. Does NOT cover edit/update form. Populated coverage needs existing approved local ledger id; never save. |
| `app/finance/reminders.tsx` | Initial labels/bounds observed | No parameters needed. Mount/focus reads on-device finance rows for current account (local fallback); financeDb may initialize local schema. No money writes on entry. Do not activate add/edit/delete/reminder actions. |
| `app/finance/reports.tsx` | Initial labels/bounds observed | No parameters needed. Mount/focus reads on-device finance rows for current account (local fallback); financeDb may initialize local schema. No money writes on entry. Do not activate add/edit/delete/reminder actions. |
| `app/finance/saved.tsx` | Initial labels/bounds observed | No parameters needed. Mount/focus reads on-device finance rows for current account (local fallback); financeDb may initialize local schema. No money writes on entry. Do not activate add/edit/delete/reminder actions. |
| `app/finance/search.tsx` | Initial labels/bounds observed | No parameters needed. Mount/focus reads on-device finance rows for current account (local fallback); financeDb may initialize local schema. No money writes on entry. Do not activate add/edit/delete/reminder actions. |
| `app/games.tsx` | Initial labels/bounds observed | Hub ONLY with no query params: establishes games session via POST launch-token/session exchange and reads demo wallet/live-table metadata; does not queue/join a game. Never pass game/room/auto/bot/seat or activate play/quick match. |
| `app/group-calendar.tsx` | Initial labels/bounds observed | No groupId: current-user read, then event load exits. Empty calendar shell only; do not add events. |
| `app/group-create.tsx` | Initial labels/bounds observed | Initial group-type/name form. Group creation/adoption happens only on explicit submit; no mount write. Do not create. |
| `app/group-insights.tsx` | Initial labels/bounds observed | No groupId: focus loader sets loading false and returns before member/history reads. Empty insights shell only. |
| `app/group-invitations.tsx` | Initial labels/bounds observed | Mount/focus reads myInvitations only. Viewing list does not accept/decline or join. Do not press invitation actions. |
| `app/group-invites.tsx` | Initial labels/bounds observed | No chatId: invitation/pending-member reads skip. Search is empty initially. Missing-group form only; do not search, invite or approve. |
| `app/group-join.tsx` | Initial labels/bounds observed | Mount reads myInvitations to show existing request status; no request/accept occurs automatically. No-param join shell only. Do not request/join. |
| `app/group-members.tsx` | Initial labels/bounds observed | No groupId: loader exits before getChat. Empty members shell only, not permission/role verification. Do not manage seats or members. |
| `app/group-notes.tsx` | Initial labels/bounds observed | No groupId: current-user read, then rebuild exits before messages. Empty notes shell only. Do not add/edit notes. |
| `app/group-privacy.tsx` | Initial labels/bounds observed | No groupId: privacy load exits. Displays default local form, not real membership permissions; patch returns without ID. Do not toggle controls. |
| `app/group-tasks.tsx` | Initial labels/bounds observed | No groupId: reads current user; skips member load and task replay. Empty tasks shell only. Do not add/toggle tasks. |
| `app/group-trip.tsx` | Initial labels/bounds observed | No groupId: reads user and attempts read-only circleMembers with empty ID; subscribeTrip is guarded. currentTrip only reads global state, so existing trip may display. Do not start/join/leave/end/navigate. |
| `app/image-editor.tsx` | Fixture required | Requires test image uri and optional chatId/returnTo; save/send affects media. |
| `app/last-seen-privacy.tsx` | Initial labels/bounds observed | Authenticated read-only landing/list/settings load; no submit, delete, toggle or external actions. Source review only; native result not verified. |
| `app/live/join/[code].tsx` | Fixture required | Dynamic invitation code required; Join redeems invite and enters live broadcast. |
| `app/location-lock.tsx` | Fixture required | Mount restores armed lock, requests location permission and current position; controlled lock/location fixture. |
| `app/lock-history.tsx` | Initial labels/bounds observed | Authenticated read-only landing/list/settings load; no submit, delete, toggle or external actions. Source review only; native result not verified. |
| `app/lock-settings.tsx` | Initial labels/bounds observed | Authenticated read-only landing/list/settings load; no submit, delete, toggle or external actions. Source review only; native result not verified. |
| `app/lock.tsx` | Fixture required | Lockscreen can auto-authenticate/change routing; controlled locked account fixture. |
| `app/login-history.tsx` | Initial labels/bounds observed | Authenticated read-only landing/list/settings load; no submit, delete, toggle or external actions. Source review only; native result not verified. |
| `app/mpin-entry.tsx` | Fixture required | Requires controlled userId and locked account; PIN entry affects authentication. |
| `app/mpin-recover.tsx` | Fixture required | Requires controlled userId/security answers; recovery changes credentials. |
| `app/network-test.tsx` | Initial labels/bounds observed | Loads local history and connectivity/server status; do not start bandwidth upload/download test. |
| `app/new-chat.tsx` | Initial labels/bounds observed | No params loads chat-list metadata/contact avatars only, not message bodies or receipts. Do not select contact/create group/add contact; omit ttl parameter. |
| `app/notifications.tsx` | Initial labels/bounds observed | Reads SOS history/contacts/privacy; no panic/test/location buttons or toggles. |
| `app/onboard-mpin.tsx` | Fixture required | Onboarding account fixture required; completion creates authentication PIN. |
| `app/onboard-profile.tsx` | Fixture required | Onboarding store/phone ticket required; submit updates profile and auth flow. |
| `app/privacy-dashboard.tsx` | Initial labels/bounds observed | Authenticated read-only landing/list/settings load; no submit, delete, toggle or external actions. Source review only; native result not verified. |
| `app/receipt-control.tsx` | Initial labels/bounds observed | Authenticated read-only landing/list/settings load; no submit, delete, toggle or external actions. Source review only; native result not verified. |
| `app/scanner.tsx` | Initial labels/bounds observed | Initial landing has no mount effect; camera permission requested only inside openCamera handler. Camera/export/share coverage needs fixtures; no actions. |
| `app/scheduled.tsx` | Initial labels/bounds observed | Authenticated read-only landing/list/settings load; no submit, delete, toggle or external actions. Source review only; native result not verified. |
| `app/search.tsx` | Initial labels/bounds observed | Authenticated read-only landing/list/settings load; no submit, delete, toggle or external actions. Source review only; native result not verified. |
| `app/security-questions.tsx` | Initial labels/bounds observed | No mount effects, credential reads/writes or redirects. Local empty answer state only; saveSecurityAnswers executes solely in handleNext. Presentation only, never enter answers or Save; recovery functionality requires controlled account fixture. |
| `app/settings.tsx` | Initial labels/bounds observed | Reads preferences/profile and initializes usage counter; no toggles, export, account or security actions. |
| `app/setup-complete.tsx` | Fixture required | UNSAFE ON MOUNT: markSetupComplete() mutates onboarding completion immediately. |
| `app/space-admin.tsx` | Initial labels/bounds observed | No spaceId: GET run/roster/incident requests use empty ID and failures become empty data. Empty admin shell only; not an authorized admin fixture. Do not open action tiles. |
| `app/space-attendance.tsx` | Initial labels/bounds observed | No spaceId: saved-place and member reads; without a zone the result is empty. No attendance mutation or device-location request on mount. Empty/missing-space view only. |
| `app/space-checkin.tsx` | Initial labels/bounds observed | No spaceId: reads user, attendance and leave; errors become empty data. checkIn/checkOut/createLeave are explicit buttons only. Do not tap them. |
| `app/space-devices.tsx` | Parameter-free error dialog; full screen unverified | No spaceId: GET devices may show read-error alert/empty list. No mount device command or provisioning. Error/empty shell only; do not add/control devices. |
| `app/space-incidents.tsx` | Parameter-free error dialog; full screen unverified | No spaceId: GET incidents/runs may show read-error alert. No mount acknowledgement/resolution/incident write. Error/empty shell only; do not act. |
| `app/space-leave.tsx` | Initial labels/bounds observed | Explicit missing-space guard before API loading. Missing-parameter state only; do not request/decide leave. |
| `app/space-ops-map.tsx` | Parameter-free error dialog; full screen unverified | No spaceId: GET runs with empty ID fails/returns no runs, so there are no started runs to subscribe to. No local location watcher on mount. Error/empty operations shell only. |
| `app/space-overview.tsx` | Initial labels/bounds observed | No spaceId: GET ops summary only; missing-space/access error presentation. No mutation on mount; not a populated dashboard verification. |
| `app/space-pending.tsx` | Parameter-free error dialog; full screen unverified | No spaceId: GET pending pickups only; may show error alert/empty data. Do not navigate into operational run actions. |
| `app/space-people.tsx` | Parameter-free error dialog; full screen unverified | No spaceId: GET people/chat/current user/role catalogue only; may show error alert/empty list. No automatic role change. Do not edit roles. |
| `app/space-roster.tsx` | Parameter-free error dialog; full screen unverified | No spaceId: GET roster/links only; may show error alert/empty roster. Do not add/archive/link entries. |
| `app/space-run-driver.tsx` | Fixture required | Focus unconditionally starts setInterval pingRun, a POST heartbeat, even without IDs or started run. With a started fixture also watches/publishes location, sets background run and delivers presence keys. Controlled driver/run fixture required. |
| `app/space-run.tsx` | Parameter-free error dialog; full screen unverified | No spaceId/runId: GET run may show read-error alert then unavailable state; subscription requires both IDs and started status. Missing-run state only, not live tracking. |
| `app/space-runs-admin.tsx` | Initial labels/bounds observed | No spaceId: GET runs, members and roster errors become empty lists. No create/assign/cancel on mount. Empty runs shell only; do not submit actions. |
| `app/space-tasks.tsx` | Initial labels/bounds observed | Explicit missing-space guard prevents load. Missing-parameter state only; do not create/toggle tasks. |
| `app/space-transport.tsx` | Initial labels/bounds observed | Explicit missing-space guard prevents run loading. No position fetch/draw here. Missing-parameter state only; do not call driver or navigate actions. |
| `app/space-visitors.tsx` | Parameter-free error dialog; full screen unverified | No spaceId: GET visitor passes only; may show error alert/empty list. Issuing/redeeming/exiting a pass are explicit actions, prohibited in this sweep. |
| `app/status-privacy.tsx` | Initial labels/bounds observed | Authenticated read-only landing/list/settings load; no submit, delete, toggle or external actions. Source review only; native result not verified. |
| `app/story-viewer.tsx` | Fixture required | Requires userId/test story; viewing can mark read and autoplay/advance. |
| `app/vault-features.tsx` | Fixture required | Mount deletes expired vault_chat_code/expiry from SecureStore; controlled vault settings fixture. |
| `app/vault.tsx` | Fixture required | Controlled vault PIN fixture; do not try real security codes or import/export files. |
| `app/vaultbeam-settings.tsx` | Initial labels/bounds observed | Authenticated read-only landing/list/settings load; no submit, delete, toggle or external actions. Source review only; native result not verified. |
| `app/vaultcheck.tsx` | Initial labels/bounds observed | With NO uri or attachmentId, mount throws a caught missing-media error before getMedia/verifyMedia. Safe missing-param presentation only; real verification requires controlled local fixture. |
| `app/vaultdrop.tsx` | Initial labels/bounds observed | Empty local landing; no file picker or Send. |
| `app/vaultid.tsx` | Initial labels/bounds observed | Reads identity; may show create modal if absent; dismiss only, never create/share/export. |
| `app/voice-effects.tsx` | Initial labels/bounds observed | Reads saved effect only; no record/play/toggle (microphone requires fixture). |
| `app/voice-speed.tsx` | Initial labels/bounds observed | With NO uri, Audio.Sound.createAsync rejects invalid source; catch suppresses error. Installed expo-av AV.ts validates source before native load; shouldPlay:false. Safe empty player presentation only, not playback verification. |
| `app/whiteboard.tsx` | Initial labels/bounds observed | Empty local drawing canvas; do not draw, save, share or export. |

## Shared layouts and game components

- app/_layout.tsx, app/(tabs)/_layout.tsx and app/finance/_layout.tsx: source-reviewed shared header, inset and theme behavior; native hierarchy checks cover destinations, not all transitions.
- Chess, Rummy, Ludo and Tic-Tac-Toe: source artwork and geometry checks reviewed; Games hub labels observed. Live boards, 6-player Rummy, dice/drag/move interactions and network match states still need controlled game fixtures.

Sanitized machine-readable evidence: design/ui-audit/changed-screen-review.json. Raw private hierarchy remains outside the repository.
