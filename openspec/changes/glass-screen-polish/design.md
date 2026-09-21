## Context

The existing app has 187 route files and shared Aurora glass primitives. Finance has a separate established glass palette. Source review is tracked in docs/ui-screen-audit.md; UI hierarchy checks cannot establish visual appearance while FLAG_SECURE blocks capture.

## Goals / Non-Goals

Readable, consistent day/night glass surfaces with responsive controls and preserved functionality. No navigation rewrite, new dependencies, changes to money calculations, backend work or disabling FLAG_SECURE.

## Decisions

- Reuse the existing glass primitives and palette roles; avoid expensive blur on repeated list rows.
- Fix shared control layout and text line-height at the source. Screens using native Text adopt AppText only after checking their size and flow.
- Keep finance identity and select its existing light/dark palettes using the app theme. A mutable global palette would make mounted screens inconsistent, so use hooks and memoized factories.
- Audit every route; resolve concrete issues by feature group. Keep verified, source-reviewed and fixture-dependent routes distinct.
- Sheet content scrolls as a whole inside the safe viewport, with Cancel outside the scroll region. Use an opaque themed underlay for readable contrast against arbitrary host content.

### Explicit scope extension

Login/signup/onboarding, MPIN entry/recovery, security questions, and every existing game board/dialog are included. Authentication and game rules remain unchanged. Drawing, media, cards and game boards keep stable content colours; their surrounding controls use coherent glass treatments.

The user's subsequent request explicitly includes the actual artwork: Chess board and pieces/rooks, Rummy table and up to six player seats, Ludo table/tokens/dice, and Tic-Tac-Toe grid/marks. Use code-native vector geometry and existing per-game palettes for layered glass edges and clear states. Reuse measured container sizing; count border/rim thickness in the available board box. Preserve all legal-move, seat, turn, hand, network and coin behavior. Short viewports retain reachable controls through scrolling, and large-font labels must not cover game content.

## Risks / Trade-offs

The user also confirmed both icon rows: keep the redesigned top chat actions and redesign bottom Chats, Status, Apps, Calls and Profile. Use existing SVG/gradient dependencies, distinct theme-aware inks and a non-colour selection indicator. Preserve native tab buttons, route order, raised center touch geometry, unread badge and top action handlers.

- Shared typography affects many call sites: preserve explicit line heights and font families, run existing weight/type/layout checks.
- Brand fonts may change line wrapping: grow controls and allow labels to shrink/wrap.
- Phone-only checks cannot certify all global devices: retain platform and fixture gaps in the audit.
- Sensitive routes may cause real actions: verify presentation only, without sending or changing account/security/finance data.

## Migration Plan

Run focused tests, typecheck, lint and full test suite; build ARM64 APK and install as an update on the connected phone. No SQL migration or server copy is required for this UI change. This does not assert the live database's migration version. Roll back by reinstalling the previous signed APK without clearing data.

## Open Questions

### Light appearance follow-up

The user explicitly extends coherent light appearance to all ordinary screens, including the previously fixed-dark authentication flow and Games hub. Reuse existing theme selection and semantic roles, preserving the dark palette. Light glass needs an independently visible blue ground, brighter primary panes, tinted inset fields, cool-ink boundaries and readable status/brand inks. Keep media, map content and actual playing boards stable where their content colours carry meaning; surrounding normal controls follow the app appearance. Figma studies use source tokens and editable source vectors, and are not native screenshots.

Additional tablet/iOS hardware and controlled call/join/SOS fixtures remain needed for full runtime certification.
