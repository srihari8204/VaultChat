## ADDED Requirements

### Requirement: Live comfort calibration
The app SHALL present a sample chat preview and a bounded vertical comfort adjustment control whose changes immediately show coordinated text size, line spacing, weight, bubble spacing, control size, contrast, and surface readability. Equivalent plus/minus and assistive-technology actions SHALL be available.

#### Scenario: Drag or button adjustment
- **WHEN** a user drags the control or activates plus/minus
- **THEN** the preview updates immediately from the same display tokens that supported app screens use, and the control stays within its valid bounds

#### Scenario: Screen reader adjustment
- **WHEN** a screen-reader user focuses the adjustment control
- **THEN** its purpose and current level are announced and increment/decrement actions change the preview without requiring a drag gesture

#### Scenario: Guided screen comfort check
- **WHEN** a user opens calibration
- **THEN** the screen explains how to check the English and Telugu sample at their usual reading distance, separately and with both eyes, and how to stop at the most comfortable level
- **AND** any displayed percentage is labeled as text enlargement, never eyesight or prescription strength

### Requirement: User-confirmed local profiles
The app SHALL save display preferences locally only when the user confirms the preview looks clear. It SHALL support separate optional With Glasses and Without Glasses profiles, restore the active profile after restart, and provide reset/remove actions. Invalid stored values SHALL fall back to readable defaults.

#### Scenario: Save and restore
- **WHEN** a user confirms a draft profile and restarts the app
- **THEN** the confirmed profile is restored and applied to supported screens

#### Scenario: Leave without saving
- **WHEN** a user changes the preview and leaves calibration without confirming
- **THEN** the previously active profile remains unchanged

#### Scenario: Corrupt local data
- **WHEN** the stored profile is missing, malformed, or outside supported bounds
- **THEN** the app uses readable defaults and remains usable

### Requirement: Separate contrast and transparency choices
The app SHALL allow the user to adjust contrast and glass transparency independently from the comfort level and SHALL show both choices in the preview before saving.

#### Scenario: Reduce transparency
- **WHEN** a user chooses reduced transparency and confirms the profile
- **THEN** supported glass surfaces use an opaque readable treatment under the selected light or dark theme

### Requirement: Optional sight starting hint
The app SHALL allow users to skip self-reported sight information. A sight category MAY suggest a starting preview level before calibration. A known spectacle value, including values from -4.00 D to +4.00 D, SHALL remain a user-entered note for that step only; the app SHALL neither infer it from symbols nor convert it to a display level. The app SHALL not store the raw sight/prescription entry. The user SHALL see a clear statement that the feature does not correct vision or replace glasses or an eye examination.

#### Scenario: User knows spectacle power
- **WHEN** a user selects an optional sight category
- **THEN** the preview may use a general starting level and the user can adjust it before any profile is saved
- **WHEN** a user enters a known spectacle value
- **THEN** that value is not measured, saved, or used to calculate a display level

#### Scenario: User does not know or skips
- **WHEN** a user skips the sight question
- **THEN** the ordinary preview opens and calibration remains fully available

### Requirement: Portal-style four-section vision screening
The app SHALL offer an optional Eye Check from Vision Comfort using the live personalEYES test flow as an interaction reference. It SHALL show an urgent-symptom warning and the exact Telugu disclaimer before and after the check. Setup SHALL include a standard-card-edge calibration control adapted to phone width, a usual-glasses choice, separate-eye covering instructions, arm's-length guidance, and a 100% brightness suggestion subject to comfort. Visual acuity SHALL use ten adaptive Landolt C gap-direction trials per eye with eight touch choices and separate qualitative results. Colour vision SHALL use six original dot-number patterns with both eyes open. Astigmatism SHALL use a semicircular line chart and a yes/no observation for each eye. Amsler SHALL use a centre-dot grid and two questions for each eye at about 30 cm. Module results and the final summary SHALL show per-eye observations where applicable, remain in memory only, and recommend professional examination for unclear responses. Chart layout SHALL fit the current phone width. It SHALL not claim validated visual acuity, eyesight percentage, prescription, myopia/hyperopia diagnosis, or medical equivalence to the reference portal.

#### Scenario: Run the check
- **WHEN** a user starts Eye Check
- **THEN** they see safety, card calibration, brightness, glasses and distance guidance before ten separate-eye C-gap trials with eight direction choices, followed by colour, semicircle and Amsler sections whose controls remain reachable at narrow widths and enlarged OS text; the direction ring shrinks to fit a narrow card and becomes a two-column button grid if the window is too narrow for a ring

#### Scenario: View responses
- **WHEN** all sections are finished
- **THEN** the app prominently shows an estimated sight status for each eye based on C-gap matches, plus the smallest matched phone screen level, semicircle and grid observations, combined colour-plate responses, viewing setup, and an explicit nonmedical explanation, and no result is saved to history

#### Scenario: Screening disclaimer
- **WHEN** the introduction or final summary is shown
- **THEN** the app displays “ఇది కేవలం ప్రాథమిక స్క్రీనింగ్ మాత్రమే. ఇది డాక్టర్ కంటి పరీక్షకు ప్రత్యామ్నాయం కాదు”

### Requirement: Quick profile switching
The app SHALL provide a labeled quick switch in chat for saved glasses profiles and SHALL expose the active profile in Settings. Switching SHALL update all supported app-owned surfaces without requiring an app restart.

#### Scenario: Switch in chat
- **WHEN** a user selects the other saved profile from the chat header
- **THEN** the chat and other supported routes use that profile, and the selection persists after restart

### Requirement: App-owned responsive readability
The selected profile SHALL affect app-owned Chats, Calls, Status, Alerts, Profile, Mini Apps, Settings, and shared navigation surfaces. Text and controls SHALL reflow with current window dimensions and OS font scaling; essential text, inputs, and actions SHALL remain visible, reachable, and operable rather than being clipped or hidden by fixed boxes. Telugu and English content SHALL render and wrap correctly. Native/system or third-party interfaces outside app control are excluded.

#### Scenario: Narrow or enlarged text
- **WHEN** a supported screen is shown at 320 dp width with OS font scale 1.5 and a saved enlarged profile
- **THEN** essential labels, messages, inputs, and actions wrap or scroll into reach without clipping or overlap

#### Scenario: Mini Apps position stability
- **WHEN** the Vision Comfort level changes at a fixed window width
- **THEN** Mini Apps retain their column count and card order while labels and card height can wrap to fit

#### Scenario: Window changes while open
- **WHEN** a user rotates, unfolds, folds, or resizes a supported app window
- **THEN** the layout recalculates for the new dimensions without requiring app restart

#### Scenario: Language and theme breadth
- **WHEN** Telugu or English content is displayed under either light or dark appearance
- **THEN** the selected profile preserves readable text, contrast, and usable controls on supported screens

### Requirement: Honest verification and claims
The release SHALL distinguish implemented coverage from deployed and device-verified coverage. Product copy SHALL describe display personalization and SHALL not claim medical correction.

#### Scenario: Verification record
- **WHEN** the feature is prepared for release
- **THEN** the team records the Android/iOS device matrix, widths, OS font scales, languages, themes, profile switching and persistence results, with unavailable cells marked unverified

#### Scenario: Product description
- **WHEN** the feature explains its purpose
- **THEN** it tells users to adjust until the display looks clear and does not promise eyesight correction
