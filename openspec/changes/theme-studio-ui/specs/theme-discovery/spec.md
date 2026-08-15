## ADDED Requirements

### Requirement: Home opens on content
The system SHALL render Home with a greeting, a search entry, a full-bleed featured theme, style chips and horizontal rails (Trending, For You, New, Editor's Picks, Community) followed by a paged grid. Home SHALL NOT open on a category chooser or any question.

#### Scenario: First paint
- **WHEN** Home opens
- **THEN** a featured theme with its own Apply action is on screen, and the shortest path to an applied theme is two taps from cold launch

#### Scenario: Personalization
- **WHEN** the user selected styles during onboarding
- **THEN** the For You rail is ordered by those styles, and the absence of a selection falls back to rating order rather than an empty rail

### Requirement: Style chips filter in place
The system SHALL present styles as a horizontal chip rail that re-queries the current surface without navigating.

#### Scenario: Selecting a style
- **WHEN** a user taps the "Glass" chip
- **THEN** the rails and grid re-query in place, the chip shows as active, and no screen is pushed

#### Scenario: Clearing a style
- **WHEN** a user taps the active chip again
- **THEN** the filter clears and the previous unfiltered content returns

### Requirement: Paged catalog access
The system SHALL read catalog content through a paged, cursor-based, asynchronous query and SHALL NOT require the full catalog in memory to render any surface.

#### Scenario: Infinite scroll
- **WHEN** a user scrolls past 60% of the loaded grid
- **THEN** the next page is prefetched, and three skeleton tiles occupy the tail while it loads

#### Scenario: Page failure
- **WHEN** a page request fails
- **THEN** already-loaded content remains scrollable and an inline retry appears at the tail, never a full-screen error

### Requirement: One search field with intent parsing
The system SHALL provide a single search field that parses colour, tone, style and content type from free text, and SHALL NOT require the user to select a filter before searching.

#### Scenario: Compound query
- **WHEN** a user searches "dark blue minimal"
- **THEN** tone, hue and style are all applied in one pass and results are ranked by combined match

#### Scenario: Content-type query
- **WHEN** a user searches "glass icons"
- **THEN** results are themes whose icon treatment matches, opening with that surface foregrounded

#### Scenario: Zero state
- **WHEN** the search field is focused and empty
- **THEN** recent searches, trending searches and popular styles are offered as tappable suggestions

#### Scenario: No results
- **WHEN** a query matches nothing
- **THEN** the empty state names the query, suggests fewer words, and offers the three nearest styles as chips

### Requirement: Search results cover every content type
The system SHALL return themes, wallpapers, icon packs, widgets, creators and collections from one query, presented as visual filters over a single result surface.

#### Scenario: Switching result type
- **WHEN** a user switches the result filter from Themes to Creators
- **THEN** the same query re-renders in place with creator cards, preserving the query text

### Requirement: Theme cards carry only what identifies them
The system SHALL render a theme card with preview artwork, name, creator, premium status and a favourite affordance, and SHALL NOT overload the card with additional metadata.

#### Scenario: Long-press to save
- **WHEN** a user long-presses a card
- **THEN** the card lifts, the favourite fills, and a haptic confirms — without opening the theme
