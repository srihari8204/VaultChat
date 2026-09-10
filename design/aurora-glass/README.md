# Aurora Glass — UI reference

High-fidelity HTML reference for the Aurora Glass (glassmorphism) treatment of
VaultChat's five tab surfaces. Open `index.html` in any browser — no build step.

- **App: dark / light** switches the phone's palette. The tokens are a 1:1
  mirror of `constants/theme.ts` (`AuroraDark` / `AuroraLight`); the glass
  recipes (blur, lip, radius, shadow) mirror `constants/glass.ts`.
- **Reduce motion** stops the aurora drift and bubble entrance; the page also
  honours the OS `prefers-reduced-motion` setting on its own.
- The token panel (desktop ≥ 1180px) shows the live recipe table.

The same system exists in three other places — see `docs/AURORA_GLASS_UI.md`
for the Figma file (variables, effect styles, components, screens), the Canva
assets, and the Replit interactive prototype.

This is a design artefact and the acceptance reference for the glass
primitives (`GlassView`, `GlassCard`, `GlassChip`). It is not shipping code and
is excluded from the app bundle.
