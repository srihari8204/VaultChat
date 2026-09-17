## ADDED Requirements

### Requirement: The shared text component owns the typeface
The shared text component SHALL be the authority for font family, and a caller-supplied `fontWeight` SHALL NOT be able to change which typeface resolves.

#### Scenario: Caller passes a bold weight
- **WHEN** a caller renders shared text with `fontWeight: '700'` or higher
- **THEN** the intended brand face still resolves, because on Android an asset font is matched by filename and a weight suffix that has no bundled file falls back to the system font

#### Scenario: Caller passes an intermediate weight
- **WHEN** a caller passes `fontWeight: '500'` or `'600'`
- **THEN** the component selects the bundled face that carries that weight rather than silently discarding the value

#### Scenario: Unread row in the chat list
- **WHEN** a chat row transitions between read and unread
- **THEN** the typeface does not change; only the intended weight or colour changes

### Requirement: Brand fonts resolve on every supported platform
Bundled font faces SHALL be referenced by names that resolve on both Android and iOS, and a face that cannot resolve SHALL fail a guardrail rather than silently fall back.

#### Scenario: Rendering on iOS
- **WHEN** shared text renders on iOS
- **THEN** the bundled brand face resolves, rather than falling back to the system font because the reference used the Android asset filename instead of the PostScript name

#### Scenario: Face declared but not bundled
- **WHEN** the type scale references a weight with no corresponding bundled file
- **THEN** the guardrail fails and names the missing face

### Requirement: Type scale adoption is ratcheted
The proportion of text rendered through the shared component SHALL not regress. A ratchet SHALL record the current count of direct `Text` imports and fail when it increases.

#### Scenario: New screen added with direct Text import
- **WHEN** a change adds a screen that imports `Text` directly from `react-native` and raises the recorded count
- **THEN** the ratchet selftest fails, directing the author to the shared component

#### Scenario: Screen migrated to the shared component
- **WHEN** a screen migrates and the count falls
- **THEN** the ratchet budget is lowered to the new count so the gain cannot be lost

### Requirement: Text respects OS font scaling
Text SHALL scale with the OS font-size setting. Scaling SHALL only be capped where a container genuinely cannot grow, and never disabled outright.

#### Scenario: Font scale raised to 1.5
- **WHEN** the OS font scale is 1.5
- **THEN** text grows and its containers grow with it, with no clipped labels

#### Scenario: Fixed-height chrome
- **WHEN** text sits inside chrome that cannot grow, such as a fixed-height tab bar
- **THEN** a maximum multiplier is applied to that text only, and the exemption is documented
