# Eye Check content and flow

The [personalEYES live test](https://www.personaleyes.com.au/eye-test/) is the interaction reference. Its separate landing article describes a previous eight-letter chart; the live test currently uses Landolt C gap choices. The app draws original phone-sized charts and does not collect the portal's contact/marketing form.

## Before the check

Show this exact notice at the beginning and end:

> ఇది కేవలం ప్రాథమిక స్క్రీనింగ్ మాత్రమే. ఇది డాక్టర్ కంటి పరీక్షకు ప్రత్యామ్నాయం కాదు

Explain that a digital screen is not a diagnosis. Screen size, pixel density, brightness, ambient light, distance and glasses affect responses. A qualified eye-care professional must examine the eyes for visual acuity or prescription. Sudden sight loss, pain, flashes or many new floaters need prompt care.

## Setup

1. Compare the dashed calibration line with the **short edge of a standard bank card**. A full-size card cannot fit across many phone displays; the short edge preserves a physical reference. Let the user adjust the line with a touch slider or accessible increment/decrement action. This is a layout aid, not clinical calibration.
2. Choose whether usual glasses/contacts are worn. The user may repeat the check with the other choice. Keep the choice consistent for both eyes.
3. Cover the **left eye** gently without pressure to test the right. Switch to covering the right eye for the left-eye run.
4. Hold the phone at **arm's length**, facing it directly. Keep brightness at 100% only if comfortable; lower it if glare hurts. Maintain stable room lighting.

## Visual acuity screen

- Show a Landolt C with one of eight gap orientations. The user taps the matching direction in a large eight-choice ring. Give brief correct/different feedback.
- Run **16 adaptive trials per eye**, including smaller C sizes than the initial version. A correct answer makes the next C smaller; a different answer or “I can't see the gap” makes it larger, within a bounded phone-size range. The next orientation changes.
- Record matches out of 16 and the smallest correctly matched **detail level** out of 12 separately for right and left eyes. At least 14 matches is a qualitative “appears clear on this screen” result; fewer prompts a closer professional check. This threshold is a screen rule, not a measured 20/20 value.
- Keep the direction ring inside the available card width, with a two-column button layout when a narrow window cannot fit the ring. Keep the direction arrows legible at enlarged OS text while their buttons remain touchable. Do not label the level as Snellen acuity, eyesight percentage, or plus/minus diopters.

## Colour vision screen

With **both eyes open** at arm's length, show six original dot-number plates with different digits and colours. Offer three number answers plus “Nothing” on each. Count matches out of six; any different response suggests a professional colour-vision check. These generated patterns are not calibrated Ishihara plates and cannot identify a deficiency type.

## Astigmatism line screen

Show a semicircular fan of equally dark lines. Cover one eye, focus at the centre, and ask whether all lines look the same shade. Record Yes or No/uncertain for each eye. This is an observation, not a cylinder-power or astigmatism diagnosis.

## Amsler grid screen

Hold the phone about **30 cm** away. With one eye covered, focus on the centre dot. Ask both questions for each eye:

1. Do all lines and squares look regular?
2. Are any parts missing, distorted or darker?

Record a concern if the first answer is No or the second is Yes. A grid cannot diagnose or rule out retinal disease. New distortion or missing areas warrant a timely professional eye assessment.

## Results

Show qualitative interim results after each module. Immediately after the C-gap test and again on the final screen, lead with a large **Right eye** and **Left eye** numeric C-gap screen test score out of sixteen. Label the final result as based on answers in this screen test. Show a signed **screen clarity index** for each eye from −4 to +4 points, calculated as `floor(correct C-gap answers / 2) − 4`; negative means fewer answers matched and positive means more. The index is an arithmetic display of the phone response count, never diopters or a medical estimate. Show either “Appears clear on this screen” (at least 14/16 matches) or “Further eye check recommended” (fewer matches), plus the smallest matched phone detail level out of twelve. State prominently that **spectacle power (+/− D) was not measured**; a refraction exam is needed for a prescription. Explain that detail level 0 means no level was matched. Then show line and grid observations per eye, colour matches with both eyes, glasses choice, and care advice. Keep results in memory only. Repeat the Telugu notice. Avoid medical equivalence claims, exact visual-acuity fractions, percentage of sight, and refractive sphere/cylinder values.

Offer **Preview Vision Comfort suggestion** after the result. If either eye matched fewer than 14 C gaps, prepare an unsaved starting preview at comfort level 3/6 or the user's existing higher level, with higher contrast and less transparency. Otherwise preserve the current profile. Open the profile that matches the glasses choice used in the check. Explain that the user must inspect the live chat preview and save explicitly; the suggestion changes app readability and does not treat an eye condition or infer a prescription.
