# Light appearance follow-up

The user requested all light screens be corrected while keeping the existing dark appearance. This pass builds on the 187-route source inventory in [ui-screen-audit.md](ui-screen-audit.md). Source coverage and physical-device verification remain separate.

| Area | Change |
| --- | --- |
| Shared Aurora screens | Distinct blue ground, brighter white cards, tinted input panes, cool-ink borders, quieter blooms and visible light card shadows. |
| Login, signup, OTP, MPIN, recovery, onboarding | Nine routes and shared auth inputs now follow selected appearance. Existing dark palette, native splash and auth handlers are preserved. |
| Vault, VaultID, biometric setup, security questions, scanner, permissions | Corrected accent/error text, boundaries, permission surfaces, action gradients and scanner light appearance. |
| Finance, Family, Spaces, Groups | Separate light palettes have visible borders and stronger panes; hints meet contrast on every gradient stop. Bright avatar and map-marker initials use readable light-mode ink. |
| Games hub and sheets | Launcher, room field, mode selection, invite/history/leaderboard/settings/search surfaces follow light appearance. The context defaults to existing game colours outside the light launcher. |
| Banners and shared controls | Connecting spinner/text, offline banner, selected chips, badge surfaces and plain-card edges corrected for light appearance. |

Actual game boards, media/video/camera content and map tiles retain their content palettes. This does not make normal forms or auth screens exempt from light appearance. Pre-provider error/startup fallbacks remain independent of context.

Three agents reviewed route families, shared controls and separate theme systems. A second review caught additional light error/action contrast and Finance hint issues, which were fixed before final integration. No new dependency, authentication behavior, gameplay rule, payload, SQL migration or server change was introduced by this appearance pass.

Focused evidence: Aurora contrast/hierarchy 161 assertions; shared glass 52; theme coverage 23; actual rendered banner/chip/context checks 13; auth navigation 22; finance and map-template regressions. Light auth foreground contrast is at least 4.67:1 on its ground; Finance faint hints are at least 4.60:1 across all three ground stops. Existing dark palette blocks were compared against pre-edit backups. These are source/composition checks, not proof of every rendered native state.

## Figma

- [Light/dark source-token study](https://www.figma.com/design/ahhAhuXVCHyB3bx7ImrsEb?node-id=19-10): bound Light/Dark colour variables, product fonts and original five-tab SVG artwork in its existing order.
- [Four-game editable source artwork](https://www.figma.com/design/ahhAhuXVCHyB3bx7ImrsEb?node-id=20-2): 320/600px board proofs for Chess, Ludo, Rummy and Tic-Tac-Toe. Chess symbol references were expanded to preserve their source transforms in Figma's SVG importer.
- Exported and visually inspected PNGs: `design/ui-audit/figma-light-dark-final.png` and `figma-games-final.png`.

These are design studies and static artwork fixtures, not captured app screens or complete six-player game sessions. Official Chess.com, Ludo King and A23 artwork was inspected for the UI-only game refinements; rules, scoring and transactions are unchanged.

## Delivery evidence

Final test, typecheck, lint, OpenSpec and build logs use the suffix `-game-light-final`. Their paired result JSON files record exit status and timestamps. The full run passed 346/346 suites plus endpoint/socket contracts and 34 generated protobuf files. Local SQL execution was skipped because no database password was supplied and Docker timed out; the separate prior production ledger check remains the DB evidence. Full lint reports zero errors and 266 warnings. OpenSpec reports 40 passed and the same three unrelated spec-less changes failing.

After that suite, review corrected auth memo identity after live inset/window changes and made the shared MPIN row fit 216–600dp containers (cells retain their 46dp maximum). The repeatable `deployment-snapshots/glass-ui-20260921/auth-layout-check.cjs` harness executes the actual hook and checks extracted native styles; it passed, as did scoped lint/layout checks. Full typecheck was repeated successfully after those final three files. Earlier 81-route hierarchy observations belong to the previously installed APK and must not be attributed to this revision.

The Redmi was unlocked after the user's confirmation. A fresh harmless tap probe still failed with Android `INJECT_EVENTS`; automated taps/scrolling remain restricted by MIUI. FLAG_SECURE is retained.

The final signed ARM64 release built successfully on 2026-09-21 at 14:40 IST in 26m 13s: 2006 Gradle tasks, 63 executed and 1943 up to date. Version 1.2.15 (31), 97,688,691 bytes; SHA-256 `CB8B93134EB614558AB5F123585882928591296D8EFAA7E344589A4C9856443F`. Artifact: `../deployment-snapshots/glass-ui-20260921/VaultChat-light-ui-arm64.apk`. It was installed with `adb install -r` on both Redmi Note 8 Pro and Honor ELI-NX9, preserving app data. Pulled installed base APKs on both devices match that exact hash, and both launch successfully. Installation evidence: `design/ui-audit/device-screen-review-install.json` and `device-honor-light-final-install.json`.

Fresh Redmi evidence for this APK covers 12/12 selected routes with expected accessible titles and no crash dialogs: Doc Scanner, Encrypted Email, Family setup, Finance, Interest Calculator, Games, New Group, New Chat, VaultScan, Security Questions, Settings and VaultID. Security Questions was observed in a wide frame; this is not a controlled rotation test. See `design/ui-audit/device-routes-light-final.json`.

Separate private bot fixture initial states exposed all 64 Chess squares, eight Ludo tokens and nine Tic-Tac-Toe cells. Rummy's lobby title and join controls were observed without joining a table. No crash or game-fallback message appeared in these captures. This does not verify moves, dice rolls, full matches, six-player Rummy, scrolling or native glass rendering. See `design/ui-audit/device-games-light-final.json`.

RTK 0.49.0 was installed from the official Windows release and its SHA-256 release digest verified. Supported commands use RTK; full integration logs and actual process exit codes are retained locally. No fixed percentage of savings is assumed.

Honor final APK verification (2026-09-21): Installed APK SHA256 `CB8B93134EB614558AB5F123585882928591296D8EFAA7E344589A4C9856443F` had been verified by the parent before the sweep. Fresh hierarchy showed Settings unlocked and original appearance Dark; the harmless input check succeeded. The reviewed delivery script completed with exit 0: all five bottom tabs selected successfully in both Light and Dark (10/10), all five top action slots and the raised Apps slot were present in their expected order, and Lock History/Games hub each exposed their title and back control in both appearances (4/4). No crash dialog was observed. Original Dark appearance, font scale 1.0, automatic rotation 1 and user rotation 0 were confirmed restored; Chats remains open.

This is hierarchy/navigation evidence, not a pixel-level glass/contrast or every-screen claim. Auth/setup submissions, gameplay, landscape and large-font checks were not performed in this bounded sweep; existing account/data and FLAG_SECURE were preserved. Detailed evidence: `design/ui-audit/device-honor-light-final-ui.json`. The complete OpenSpec device matrix remains pending.

Honor bounded layout matrix (2026-09-21): `verify-delivery.ps1 -LayoutMatrix` completed with exit 0. All six initial presentations—Settings, Finance, Interest Calculator, Family Circle, New group and Games hub—exposed expected titles in both dark font-scale 1.5 portrait and dark font-scale 1.0 landscape (12/12); no crash dialogs or per-route capture failures occurred. Device readbacks confirmed each applied setting; hierarchy frames changed from 1200×2664 to 2664×1200. An initial capture failed before the matrix changed any settings; retry succeeded. Finally confirmed restoration to Dark, font 1.0, auto rotation 1 and user rotation 0, leaving Chats open.

Evidence: `design/ui-audit/device-honor-light-final-matrix.json`. This tests six route presentations only. It does not establish gameplay rotation, complete unclipped text, pixel contrast, the light-mode landscape/font matrix, or every-screen coverage. The full OpenSpec device matrix remains pending.
