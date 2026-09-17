## ADDED Requirements

### Requirement: Layout is direction-aware
Layout SHALL express horizontal spacing and alignment in start/end terms so that a right-to-left locale mirrors correctly. The direction-aware engine already present SHALL be the single source of direction.

#### Scenario: RTL locale active
- **WHEN** the active locale is right-to-left
- **THEN** rows, paddings, margins and alignment mirror, and no layout depends on a hardcoded left or right

#### Scenario: Directional icon
- **WHEN** an icon encodes direction, such as a back chevron or a send arrow
- **THEN** it mirrors with the layout rather than pointing the wrong way

#### Scenario: Guardrail rejects a hardcoded side
- **WHEN** a style introduces `marginLeft`, `marginRight`, `paddingLeft`, `paddingRight`, `left` or `right` in a direction-sensitive context without a documented exemption
- **THEN** the localization guardrail fails and names the file and line

### Requirement: User-visible copy is translatable
User-visible strings SHALL come from the shared catalog rather than being hardcoded in screens, so that adding a locale does not require editing screens.

#### Scenario: New locale added
- **WHEN** a locale is added to the catalog
- **THEN** screens already drawing from the catalog display the new locale with no per-screen change

#### Scenario: Catalog adoption is ratcheted
- **WHEN** a change increases the recorded count of hardcoded user-visible strings
- **THEN** the ratchet selftest fails, so translation coverage cannot regress while it is being extended

### Requirement: Translated text does not break layout
Layout SHALL tolerate the length variation of translated strings without clipping, using containers that grow rather than fixed dimensions.

#### Scenario: Expanded translation in a constrained row
- **WHEN** a translated string is substantially longer than the English source and renders in a row or button
- **THEN** the container grows or the text wraps, and no glyph is clipped at the narrowest supported width
