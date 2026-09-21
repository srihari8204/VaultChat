## 1. Inventory and shared foundations

- [x] 1.1 Inventory all 187 routes with source findings and explicit runtime status in docs/ui-screen-audit.md.
- [x] 1.2 Inspect the existing Figma responsive glass audit board and reuse current app tokens.
- [x] 1.3 Fix shared glass radii, accessible buttons, custom text line heights and safe scrolling action sheets.

## 2. Screen implementation

- [x] 2.1 Polish settings, privacy, notifications and security surfaces for both themes.
- [x] 2.2 Polish Security Hub, communities, bookmarks, scheduled messages and search.
- [x] 2.3 Repair finance responsive forms/actions and integrate existing day/night finance palettes.
- [x] 2.4 Review remaining route findings and resolve visual consistency defects, preserving specialised map/media canvases.

- [x] 2.5 Audit and polish complete login/signup/onboarding, MPIN, recovery and security-question flows.
- [x] 2.6 Audit and polish Games hub, Chess, Ludo, Rummy and Tic-Tac-Toe including dialogs and controls.

## 3. Validation and delivery

- [x] 3.1 Run focused accessibility, theme, typography, responsive tests, lint, typecheck and full suite; record any existing failures.
- [x] 3.2 Complete Ponytail diff review and strict OpenSpec validation.
- [x] 3.3 Build and install signed ARM64 APK on the connected physical phone without clearing app data.
- [ ] 3.4 Record safe device navigation, day/night and large-text checks; retain unverified fixture/platform gaps.
- [x] 3.5 No backend deploy or SQL migration required for this UI change; no migration files changed or server files copied.

## 4. Four-game board redesign (explicit user extension)

- [x] 4.1 Redesign Chess glass board/pieces including rooks, and Tic-Tac-Toe grid/marks/states without changing game rules.
- [x] 4.2 Redesign Rummy table, player icons and seats for up to six players without changing hand or socket logic.
- [x] 4.3 Redesign Ludo table, home areas, tokens and dice without changing coordinates or legal-move behavior.
- [x] 4.4 Verify measured layouts across narrow/short/tablet viewports and large fonts; inspect source-derived artwork alongside the Figma reference.
- [x] 4.5 Run focused game, typecheck, lint and full integration validation after the board changes.
- [x] 4.6 Build and install the final signed APK including game designs and device-discovered Lock History header fix; record exact runtime coverage and limitations.

  Final signed APK installed as an update on Redmi Note 8 Pro; installed APK hash matches SHA-256 0C7D0799F6F92DE617AB95F9BC55650032CA2E9183934FAC69A6D4AC2346025D. Cold launch/Settings verified. Interactive checks in 3.4 and 5.3 remain pending MIUI USB debugging (Security settings): Android rejected INJECT_EVENTS and WRITE_SETTINGS. Do not attribute the initial Honor APK's device checks to this build.

## 5. Chat navigation artwork (confirmed user extension)

- [x] 5.1 Redesign bottom Chats, Status, Apps, Calls and Profile SVG icons in their existing order and places, preserving navigation, raised Apps and unread badges.
- [x] 5.2 Retain the new top Search, Alerts, Temporary Chat, Contacts and Broadcast artwork, as explicitly confirmed after clarification.
- [ ] 5.3 Validate light/dark artwork, contrast and responsive slots; include both icon rows in final APK and physical-phone checks.

## 6. User-requested server delivery check

- [x] 6.1 Compare current local and live Go source fingerprints, verify public/internal readiness and protobuf negotiation, and read the production migration ledger. Latest source 6492ff85dbd9db44 is already deployed; all 136 migrations through 137 match, so no new server restart or SQL apply is needed. Record this as verification of the existing rollout, not a new deployment.

## 7. Review every changed screen (user follow-up)

- [x] 7.1 Review all 117 changed route files and three shared layouts with separate agents; document initial-state device evidence and fixture limitations per route.
- [x] 7.2 Fix confirmed Doc Scanner contrast/wrapping, New Chat action-label wrapping and inactive driver heartbeat findings; run focused regression checks and Ponytail review.
- [x] 7.3 Complete post-review typecheck/test/build, install the updated signed APK and record follow-up device evidence without attributing older APK results to it.

The route matrix is `docs/changed-screen-device-review.md`. Hierarchy observations do not establish rendered glass appearance or successful interaction. Existing MIUI input/settings restrictions keep tasks 3.4 and 5.3 pending.

## 8. Gameplay responsiveness (user-reported runtime issue)

- [x] 8.1 Make the focused games route own system orientation and one live safe-area boundary; remove duplicate game padding and conflicting board locks.
- [x] 8.2 Adapt all four gameplay layouts and player/action rows to narrow, short and wide windows, including font scaling and resizing after mount.
- [x] 8.3 Exercise actual sizing-hook layout transitions and focused game regressions; rebuild and install the resulting APK, recording physical-device coverage and remaining permission/fixture gaps.

## 9. Reference refinement and complete light appearance

- [x] 9.1 Review official game references and refine original Chess, Ludo and Rummy artwork without changing gameplay; publish editable source vector studies in Figma at two sizes.
- [x] 9.2 Strengthen light Aurora, Finance and Space surfaces, fields, borders and text contrast while preserving dark palettes; inspect token-bound light/dark Figma studies.
- [x] 9.3 Audit all light-mode route families and shared components, including authentication, Games hub, banners and map markers; repair remaining fixed-dark and low-contrast cases.
- [x] 9.4 Run final checks, build and install the signed update, and record exact physical-device coverage for this light-mode revision.

Latest delivery: signed ARM64 version 1.2.15 (31), SHA-256 `CB8B93134EB614558AB5F123585882928591296D8EFAA7E344589A4C9856443F`, installed and pulled-base hash verified on Redmi Note 8 Pro and Honor ELI-NX9. Final checks: 346/346 suites, repeated typecheck, zero lint errors. Fresh Redmi evidence covers 12 route initial states, three private bot board fixtures and Rummy lobby only. See `docs/light-mode-followup.md` for exact coverage and remaining interaction/visual limitations; this does not close tasks 3.4 or 5.3.
