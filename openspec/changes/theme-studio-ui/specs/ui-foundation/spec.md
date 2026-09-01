## ADDED Requirements

### Requirement: Tokens come from the existing design system
The system SHALL style every surface from `constants/theme.ts` — `Palette`, `SPACING`, `RADIUS`, `ELEVATION`, `MOTION`, `TYPOGRAPHY` — and SHALL NOT introduce a parallel design system or hardcode colours, radii or spacing in screens.

#### Scenario: A screen needs a spacing value
- **WHEN** a layout needs separation between elements
- **THEN** it uses a step from the 4-point scale applied as container gap, not a per-element margin

#### Scenario: Brand accent on a light surface
- **WHEN** the brand accent is used for text or an icon on the light ground
- **THEN** the `brandOnLight` token is used, because `#9D6FD0` on `#F6F7F9` measures ≈3.0:1 and fails AA — the accent remains correct as a fill

### Requirement: Theme tokens are separate from app tokens
The system SHALL keep the tokens of a theme being previewed independent of the app's own appearance.

#### Scenario: Previewing a dark theme in light mode
- **WHEN** a user in light mode previews a dark theme
- **THEN** the phone canvas renders dark while the surrounding app stays light

### Requirement: Phone preview is one component
The system SHALL implement a single phone preview component supporting Home, Lock and Widgets surfaces, rendering wallpaper, icons, widgets, colours and typography from a theme's tokens, used by cards, the immersive preview, the Studio canvas, AI results and the paywall.

#### Scenario: One renderer, four sizes
- **WHEN** the same theme appears as a card, a preview, a canvas and a paywall illustration
- **THEN** all four are the same component at different sizes, and no surface has a bespoke renderer

#### Scenario: Token change
- **WHEN** any theme token changes
- **THEN** every mounted preview of that theme re-renders within one frame

### Requirement: Component inventory
The system SHALL implement and reuse: header, bottom navigation, theme card, wallpaper card, icon pack card, widget card, creator card, collection card, category chip, search field, phone preview, bottom sheet, modal, button, premium badge, favourite button, download button, apply button, skeleton, toast, error state, empty state, segmented control, carousel and filter bar — and SHALL NOT duplicate any of them per screen.

#### Scenario: A new surface needs a card
- **WHEN** a new surface displays themes
- **THEN** it uses the existing theme card variant rather than a new card

### Requirement: State language
The system SHALL implement loading, skeleton, empty, no-results, offline, network error, download error, apply error, premium-locked and success states, each with human copy and a single recovery action.

#### Scenario: First paint
- **WHEN** any content surface loads for the first time
- **THEN** skeletons matching final metrics are shown, so landing content causes no layout shift, and no spinner is used

#### Scenario: Error copy
- **WHEN** an error is shown
- **THEN** it states what failed in plain language with one action, and no status code or raw error reaches the user

#### Scenario: Offline with cache
- **WHEN** the device is offline and cached content exists
- **THEN** cached content stays interactive under a dismissible strip

### Requirement: Responsive behavior
The system SHALL adapt across phone portrait, phone landscape, tablet and desktop preview, mobile-first.

#### Scenario: Tablet
- **WHEN** the viewport is at least 768 wide
- **THEN** grids become two-column and Studio shows the canvas beside a persistent panel instead of a sheet

#### Scenario: Landscape studio
- **WHEN** a phone is rotated to landscape in Studio
- **THEN** the canvas and the active panel sit side by side, and the canvas never scrolls out of view

### Requirement: Accessibility
The system SHALL support dynamic type to 200%, minimum 44×44 touch targets, screen-reader labels for generated previews, contrast of at least 4.5:1 for text, reduced motion, and a visible control for every gesture.

#### Scenario: Large text
- **WHEN** text size is increased to 200%
- **THEN** grids reflow to a single column and rails become vertical stacks with no clipped text

#### Scenario: Screen reader on a preview
- **WHEN** a preview receives focus
- **THEN** it is announced from its tokens: "Home screen preview. Dark blue mesh wallpaper, glass squircle icons, three widgets. 1 of 3."

#### Scenario: Reduced motion
- **WHEN** reduced motion is enabled
- **THEN** shared-element expansion becomes a cross-fade, parallax is disabled and shimmer becomes a static tint, with no loss of information

#### Scenario: Colour is never the only signal
- **WHEN** a badge conveys premium, applied, AI or created status
- **THEN** it carries a word as well as a colour

### Requirement: Performance
The system SHALL keep browse smooth over large catalogs: windowed lists, progressive image loading, prefetch at 60% scroll depth, and previews rendered from tokens rather than downloaded artwork.

#### Scenario: Long scroll
- **WHEN** a user scrolls through hundreds of themes
- **THEN** scrolling holds 60 fps on a mid-tier device and memory stays under the cache ceiling

#### Scenario: Opening a preview
- **WHEN** a user opens a theme from a card
- **THEN** nothing is fetched, because the theme's tokens are already in memory

### Requirement: Motion and haptics
The system SHALL use the `MOTION` spring presets, pair every haptic with a visible change, and keep transitions subordinate to performance.

#### Scenario: Card to preview
- **WHEN** a card opens
- **THEN** the artwork expands as a shared element with the snappy spring, and a light haptic fires

#### Scenario: Apply confirmed
- **WHEN** apply completes
- **THEN** the canvas settles, a checkmark draws and a success notification haptic fires alongside the visible confirmation
