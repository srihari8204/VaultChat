# Facet — Theme Studio prototype

High-fidelity HTML prototype for `openspec/changes/theme-studio-ui`.
Open `index.html` in any browser — no build step, no external requests.

- **Screen index** (left, desktop ≥1100px) jumps to any of the 42 surfaces.
- **Full bleed** renders the app edge-to-edge instead of inside the device frame.
- **App: light / dark** toggles the app's own appearance; theme previews keep
  their own palette either way, which is the token separation the spec requires.
- The **phone preview** is one renderer driven by theme tokens. Every control in
  Wallpaper, Icons, Colors, Layout, Lock and Typography changes it live —
  that is the "the editor is the preview" claim, working.

This is a design artifact and the acceptance reference for the specification.
It is not shipping code and is excluded from the app bundle.
