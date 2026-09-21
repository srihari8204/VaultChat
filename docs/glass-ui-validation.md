# Glass UI delivery validation — 2026-09-21

## Implemented and reviewed

The source audit inventories all 187 routes. This UI pass changes client routes plus shared glass, typography, theme, finance and game components. Login/signup/onboarding, MPIN/recovery, security questions and all four game interfaces are included in the source review; this does not mean every runtime state has been exercised.

Existing Figma responsive reference board inspected: https://www.figma.com/design/ahhAhuXVCHyB3bx7ImrsEb (node 5:2). No claim that 187 new Figma screen designs were created. Multiple agents reviewed separate feature groups, followed by an integrated Ponytail review; no remaining blocking source finding was identified. Existing staged backend/protobuf and safety edits were preserved.

### Subsequent games and navigation extension

The four actual boards were subsequently redesigned: dimensional Chess pieces including rooks, glass Tic-Tac-Toe marks/cells, Ludo homes/tokens/dice, and six-seat Rummy felt/player capsules/cards. Rummy retains readable content on very short viewports via scrolling, including window-coordinate drag-target translation and offset reset when the table remounts. Independent review also found a pre-existing horizontal hand-scroll drop-target bug; both scroll axes now translate group coordinates, while horizontal scrolling leaves the discard pile untouched. Three focused regression cases verify visible-group selection, rejection of stale positions and scrolling back. Geometry checks include 400×240, 480×280 and 600×300 viewports plus enlarged fonts; these are model checks, not live matches.

Both chat icon rows were explicitly confirmed by the user after clarification. Bottom Chats, Status, Apps, Calls and Profile retain their order, positions, native navigation buttons, raised Apps center and unread badge. Top Search, Alerts, Temporary Chat, Contacts and Broadcast retain their handlers and slots with custom glass SVG artwork. The five theme inks also pass 4.5:1 selected-label contrast checks on both glass surfaces.

Actual vector samples were imported into the existing Figma file at [Source artwork proofs](https://www.figma.com/design/ahhAhuXVCHyB3bx7ImrsEb?node-id=14-2) and the resulting sheet was inspected. Local source-derived previews cover all four games and both icon rows in `../deployment-snapshots/`; HTML/native-layout approximations are labelled as such. These proofs do not certify Android rendering.

## Initial delivery automated checks (before the extension)

| Check | Result |
|---|---|
| Full `npm test` | 343/343 discovered suites passed; endpoint/socket contracts and 34 generated protobuf files match source |
| Database migration tests | Skipped: local PostgreSQL requires a password; Docker target unavailable/timed out. Retried outside the earlier filesystem restrictions, still unavailable. No DB execution pass claimed |
| `npm run typecheck` | Passed |
| `npm run lint` | 0 errors, 268 warnings; final focused lint 0 errors, 1 require-import warning in the rendering selftest |
| Typography rendering | 9 real React rendering assertions cover nested text inheritance and custom line heights; weight selftest 12 assertions |
| Aurora/theme | 114 Aurora assertions, 23 theme coverage assertions; readable light semantic roles and foreground contrast |
| Responsive/a11y | Existing responsive, keyboard, game geometry and screen-exit checks passed; 309 icon controls labelled in source check |
| Whiteboard | 3 stroke commit assertions; drawing state ref correction reviewed |
| OpenSpec | `glass-screen-polish --strict` passed. Repository-wide: 40 passed, 3 unrelated changes fail because they contain no delta specs (`fix-presence-publish-stall`, `harden-audit-findings`, `responsive-breadth-and-toolchain`) |
| Whitespace/Ponytail | `git diff --check` passed; final independent review found no further complexity cut or blocking regression |

## Initial APK delivery (before the extension)

- Command: `npm run build:android:apk:arm64`.
- Result: `BUILD SUCCESSFUL in 12m 47s`; 2006 tasks, 50 executed, 1956 up to date.
- Package: `com.vaultchat.app`, version 1.2.15 (31), minimum Android API 24, target API 36, ARM64.
- Signed APK verification: v2 signature valid, one signer.
- Size: 97,564,871 bytes.
- SHA-256: `AFE9BB3AA4709BB96F0A1C6C1020311AF7CB57991AD36DF7DC3DF65CACE26613`.
- Artifact: `../deployment-snapshots/glass-ui-20260921/VaultChat-glass-ui-arm64.apk` (relative to repository root).
- Installed with `adb install -r`: Success. Launched on connected Honor ELI-NX9; package update time 2026-09-21 03:01:22 device time. Account and app data retained.
- No backend deployment or SQL migration was needed for these UI changes. This is an ARM64 phone artifact, not certification of all Android ABIs or iOS.

## Physical-device evidence

Device: Honor ELI-NX9, 1200×2664 physical pixels, density 520, initial font scale 1.0, initial app appearance Light. FLAG_SECURE remains enabled. UIAutomator hierarchy can establish destination labels, exposed controls, bounds and navigation; it cannot prove rendered glass appearance, glyph clipping, contrast or animation quality.

Detailed sanitized route observations are being collected in `../deployment-snapshots/glass-ui-20260921/device-checks.jsonl`. No personal messages, account labels, credentials or raw hierarchy are included in that report. The raw temporary hierarchy is outside this repository.

Final device matrix and restored settings are recorded after the sweep below. Authentication/recovery submissions, live game boards/matches, calls, SOS, real finance transactions and loaded parameterized routes require controlled fixtures and remain unverified. No sign-out, OTP request, security change, live match join, payment, invite redemption or location-sharing test was performed.

### Initial APK hierarchy sweep

39 safe routes were opened in each appearance mode (78 observations). No crash dialog was observed. Two dark-mode title mismatches were selector issues (`This space · Tasks` and an emoji-prefixed Encrypted Email title), later checked with corrected selectors. Lock History had a real missing native header in both modes; the source now explicitly enables its themed native title/back button and removes the obsolete root inset entry. The screen-exit check now recognizes actual header JSX rather than matching `ListHeaderComponent` by substring. The final APK must recheck this fix.

All four game mode sheets were opened and dismissed on the phone without joining a match. Live game board interactions remain fixture-dependent. Initial hierarchy observations are in `../deployment-snapshots/glass-ui-20260921/device-checks.jsonl`; they belong to the initial APK hash above.

An intermediate validation/build rerun was deliberately cancelled when scope expanded to actual game artwork. The old `*-final.txt` logs are cancelled runs, including a termination-related test failure; they are not final delivery evidence. Final post-extension logs use `*-delivery.txt`.

## Fresh server verification after the direct-deploy request

At 2026-09-20 22:15 UTC, the current local Go source fingerprint and live public `/build` both equal `6492ff85dbd9db44`. This exact backend had already been deployed during the protobuf audit (recorded rollout 2026-09-20 18:33 UTC). There is no newer backend source to ship, so the request converges without an unnecessary container restart. No new deployment is claimed for this UI pass.

Public and internal health/readiness report DB and Redis healthy. Public `/app/version` returns 200, `application/protobuf`, `Vary: Accept`, and a nonempty 65-byte body. `/app/flags` legitimately returns an empty protobuf message. Read-only production ledger comparison finds all 136 local migration files applied, maximum version 137, with no missing or extra versions. No SQL was applied and no account data changed. Evidence: `design/ui-audit/server-live-delivery.json`.

Earlier exact-source backend verification is preserved in `../deployment-snapshots/protobuf-audit-20260920/tests-verified.json`: full Go run 860 top-level passes plus 634 subtests, 7 environment skips; isolated SQL checks 17/17 passed. This is distinct from the current local migration runner's password/Docker skip.

### Build timing finding

The installed React Native Gradle plugin unconditionally supplies `--reset-cache` to the Expo bundle task. The installed Expo `exportEmbedAsync` preserves Metro cache when `CI=1`; `scripts/gradlew.js` inherits that environment. A subsequent local repeat build can scope `CI=1` to its process to reuse that cache, without patching dependencies or skipping bundle generation. This is an inspected optimization, not a measured speed improvement. The current ARM64 shortcut already avoids `expo prebuild --clean` and reuses native artifacts. No C++/Rust rewrite is needed for this cache issue.

## Final post-extension APK

- `BUILD SUCCESSFUL in 14m 24s`; 2006 tasks, 50 executed, 1956 up to date. Metro bundled 3715 modules in 299 seconds.
- Version 1.2.15 (31), `com.vaultchat.app`, minimum API 24, target API 36, ARM64. APK v2 signature verified, one signer.
- Size 97,585,691 bytes; SHA-256 `0C7D0799F6F92DE617AB95F9BC55650032CA2E9183934FAC69A6D4AC2346025D`.
- Artifact: `../deployment-snapshots/glass-ui-20260921/VaultChat-glass-games-icons-arm64.apk`.
- Includes four game board redesigns, both five-icon chat rows, Rummy scroll/drop fixes and Lock History native header correction.
- Full 343/343 suites, contracts and 34 generated protobuf files passed; final Rummy coordinate regression suite was rerun after its small follow-up fix. Full lint: 0 errors, 266 warnings. Post-fix final source typecheck passed; final focused lint: 0 errors, 4 existing warnings. Results are recorded in the delivery logs.
- The first final install attempt stopped with `adb.exe: device 'AWJDVB4702008616' not found`. After the user connected a Redmi Note 8 Pro, the final APK was installed successfully as an update; see the follow-up evidence below. Initial Honor APK checks must not be attributed to this final build.

Prepared phone verification script: `../deployment-snapshots/glass-ui-20260921/verify-delivery.ps1`. It checks both icon rows and tab selection, Lock History title/back, day/night mode, representative large-text/landscape routes, and restores the appearance/font/rotation values read at start. It now takes a device serial and rejects stale hierarchy files. Its interactive Redmi run was blocked by MIUI input/settings permissions, as recorded below.

## Redmi follow-up — final APK installed

The user connected Redmi Note 8 Pro (Android 11, 1080×2340, density 440). `adb install -r` succeeded without uninstalling or clearing data. Package update time is 2026-09-21 13:05:11 device time. The installed `base.apk` SHA-256 exactly matches the final APK above; evidence is `design/ui-audit/device-redmi-install.json`.

Cold launch completed and a fresh UI hierarchy reached Settings with the signed-in session and Light appearance. A bounded current-process log check found zero fatal/ReactNativeJS exception markers. These are startup/navigation observations, not rendered-design approval.

Automated input was then rejected by Android with `INJECT_EVENTS` SecurityException. Font/rotation setting writes were also rejected with `android.permission.WRITE_SETTINGS`. Read-back confirmed font scale 1.0, auto-rotation 1, rotation 0 remained unchanged; no theme switch was confirmed. The user was asked to enable MIUI's **USB debugging (Security settings)**. Full tap/navigation, day/night and large-text/landscape checks remain pending that device-controlled permission. No application code change or security bypass is needed or attempted for this restriction.

Read-only deep links still work, so three further fresh hierarchy checks completed on this final APK in Light mode:

- Chats: all five top action labels were present with clickable controls, ordered left-to-right; bottom Chats, Status, Apps, Calls and Profile labels were ordered correctly and inside the 1080×2340 screen. This checks exposed bounds and placement, not rendered SVG appearance or successful taps.
- Lock History: corrected native title found at `[386,116][695,190]`, with a clickable Navigate up control at `[0,76][154,230]`. Back-button activation remains input-permission blocked.
- Games hub: Chess, Rummy, Ludo and Tic-Tac-Toe headings all present. No live game was joined.

Sanitized observations are in `../deployment-snapshots/glass-ui-20260921/device-delivery.jsonl`, identified by Redmi serial; private hierarchy stays outside the repository. No interactive check is marked passed on the basis of these read-only observations.

## Review of every changed screen — 2026-09-21 follow-up

Three agents reviewed all 117 changed route files and three shared layouts. [The per-route matrix](changed-screen-device-review.md) records 81 routes with initial labels/bounds observed on the installed `0C7D0799…` APK, 27 fixture-dependent routes not opened, and nine other routes without established initial-screen evidence. Eight of those expose missing-parameter Spaces error dialogs; Security Hub repeatedly prevented a fresh UI hierarchy capture. These are distinct from visual or interactive passes. Search's initial selector mismatch was resolved by checking its actual input placeholder; Doc Scanner was rechecked with a fresh launch.

An error dialog obstructed subsequent deep links during one sweep. Dialog-sized windows were excluded from screen counts and affected routes were retried after restarting the activity. No stale hierarchy file was accepted. A final harmless input probe still returned MIUI's `INJECT_EVENTS` restriction. Day/night, enlarged text, rotation, scrolling, taps and loaded/live fixture states remain unverified on Redmi. Source and geometry checks are not substituted for those device checks.

Review fixes:

- Doc Scanner uses dark indigo/blue source cards with solid-white subtitles. Endpoint contrast ranges from 6.70:1 to 11.42:1. Recent-document metadata/actions wrap within narrow cards.
- New Chat action labels fill the remaining row width and wrap at enlarged text sizes; actions and navigation are unchanged.
- Driver heartbeat requires valid route IDs, a loaded matching run and `started` status; focus/status changes clean up the timer. The backend already rejects inactive-run pings, so this removes invalid requests rather than repairing server data. A focused fake-timer regression executes the actual callback and checks inactive/missing/mismatched IDs, cadence and cleanup.

Post-fix checks: typecheck passed; 344/344 test suites passed; endpoint/socket contracts and all 34 generated protobuf files match source. Local SQL migration execution again skipped because PostgreSQL has no supplied password and Docker timed out; earlier exact-backend SQL/production-ledger evidence remains separate. Focused lint passed for all three changed screens (one existing unused `Platform` warning in New Chat). Glass (52), responsive layout (29), screen-exit coverage (181 screens), five finance/game suites, and driver lifecycle/run checks passed. Ponytail review found no added dependencies or unnecessary abstractions. `git diff --check` passed. OpenSpec: this change passes strict validation; repository-wide result remains 40 passed / three unrelated spec-less changes failed.

Logs: `design/ui-audit/test-screen-review.txt`, `typecheck-screen-review.txt`, `openspec-screen-review.txt`. APK build/install evidence for these follow-up corrections is recorded below after delivery; the 81-route sweep above belongs to the previous APK and must not be attributed to the rebuild.

## Gameplay responsiveness — reported during follow-up

The preceding review build finished successfully in 16m 53s (2006 tasks: 50 executed, 1956 up to date; Metro 138938ms). It was not installed because the user reported that gameplay did not resize correctly, requiring another source correction. Its successful build does not validate these subsequent changes.

Confirmed causes and changes:

- Games inherited fixed root top/bottom padding while Rummy subtracted safe-area edges again. The Games route now owns one live four-edge SafeAreaView for hub and boards; its root static inset entry is removed. Rummy sizing and lobby/table padding use that already-safe measured container.
- Individual board portrait locks and Rummy's landscape/portrait restoration conflicted with device rotation and stacked navigation. The focused Games route now releases orientation locks and follows the system rotation setting; boards no longer set their own locks.
- Chess and Tic-Tac-Toe use board/control columns in wide measured viewports, each scrollable for very short heights. Chess clocks/bot badges and draw actions wrap; Tic-Tac-Toe seats stack when text/window size requires it. At 760×336 available dp, the board can use 304dp instead of falling to 200dp from portrait-only chrome estimates.
- Ludo likewise uses a wide board/control layout, scalable/wrapping player information and actions, and wrapping lobby stake controls. A 844×390 viewport yields a 358dp board instead of the former 200dp result. Portrait uses its available width rather than reserving 400dp of guessed controls before sizing the board.
- Rummy's top/action rows scroll horizontally when required, labels grow with font scaling, and the outer vertical scroller remains usable when actual content exceeds estimated table height.

Game intent payloads, legal-move rules, wallet behavior and server code are unchanged. New checks exercise the actual shared sizing hook's sequence of onLayout events, along with portrait→landscape→safe-area resize→split-window→portrait geometry, short-height scrolling constraints and enlarged text. These source/runtime-hook checks do not substitute for physical gestures or pixel inspection.

The phone still rejects automated input/settings changes. The user could not find MIUI's separate USB debugging security toggle; Developer options was opened, but device policy reported the screen off and keyguard showing. The user was given the option's exact label/description and asked to unlock the phone. No input-permission bypass or FLAG_SECURE change was made.

## Final light-mode delivery — 2026-09-21

The final signed ARM64 APK (1.2.15 / 31) built successfully in 26m 13s and was installed as an update on both Redmi Note 8 Pro and Honor ELI-NX9. Both pulled installed APK hashes equal `CB8B93134EB614558AB5F123585882928591296D8EFAA7E344589A4C9856443F`; app data was preserved. The final repeat typecheck passed; integration passed 346/346 suites, endpoint/socket contracts and generated protobuf checks. Lint has zero errors and 266 warnings. Existing unrelated OpenSpec failures and local SQL skip remain explicitly recorded.

[Light-mode follow-up](light-mode-followup.md) records source changes, editable Figma studies, exact artifact identity and fresh physical-device coverage. For this APK, Redmi initial route checks found 12/12 expected titles with no crash dialogs. Separate private bot initial states exposed 64 Chess cells, eight Ludo tokens and nine Tic-Tac-Toe cells; Rummy lobby was observed without joining. These results do not establish completed gameplay, six-player Rummy, full interactive rotation/text-scale coverage or native pixel inspection. Older 81-route results above remain evidence for the older APK only.

RTK 0.49.0 is installed and used for supported verbose checks, retaining full logs and exit status. [Docker resource cleanup](docker-resource-cleanup.md) records the verified 4GB WSL cap, cleanup of a 188.47 GiB runaway Go API log, native log rotation, and successful offline compaction: Docker disk 246.09 to 36.38 GiB, with 219.50 GiB free on C:. All database volumes were retained; only the stopped Go API container was recreated with the same image, environment and mount. The RAM improvement also includes stopping our idle Gradle daemon.
