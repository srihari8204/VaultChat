## Why

The existing 187 app routes have inconsistent adoption of the glass design system, tiny labels and controls, and fixed light-only finance surfaces. The user requests a cohesive glass UI in day and night modes on Android with responsive layouts throughout.

## What Changes

- Inventory every route and distinguish source review from device verification.
- Repair shared typography, glass radii, buttons and action-sheet layout.
- Polish screens using existing Aurora and finance tokens, consistent icons, readable labels and flexible layouts.
- Support finance surfaces in both app appearance modes.
- Redraw all four game boards and artwork, including six-seat Rummy, with measured responsive layouts.
- Redesign both five-icon chat rows while preserving order, positions, navigation and unread badges.
- Validate changes with existing checks and safe physical-device navigation.

## Capabilities

### New Capabilities
- `glass-screen-consistency`: app-wide appearance and verification contract for existing routes.

### Modified Capabilities
None. Reuses ui-foundation design conventions and global-device-support infrastructure.

## Impact

Client routes, shared UI components, finance theme, focused tests and audit documentation. No new packages, API changes or database migrations. No backend file copy is required for this UI change; the production database version is outside this UI validation.

## Not building

No new product destinations, theme marketplace, replacement navigation, or changes to messaging, finance calculations, encryption or security policies. Existing media and map canvases keep their functional presentation with themed chrome.
