# CrazzyChat (VaultChat) — brand tokens

Pulled from `constants/theme.ts`, so the mark matches the shipped UI.

| token        | hex       | source                    |
|--------------|-----------|---------------------------|
| accent light | `#C9A6F5` | `aurora.accentLight`      |
| accent       | `#9D6FD0` | `BRAND_ACCENT` (lavender) |
| accent deep  | `#7C3AED` | `aurora.accentDeep`       |
| ground       | `#0A0810` | `aurora.bg`               |
| surface      | `#1B1626` | `aurora.surfaceSolid`     |

## Files

| file | what it is |
|---|---|
| `mark-{a,b,c}-*.svg` | app-icon artwork, 1024×1024, dark aurora ground |
| `…-light.svg` | same mark on a pale ground (docs, print, light UI) |
| `…-mono.svg` | white mark, transparent ground — Android monochrome icon, stamps |
| `…-glyph.svg` | mark only, transparent ground, gradient kept |
| `lockup-{a,b,c}.svg` | horizontal mark + wordmark |
| `concepts.png` | side-by-side comparison sheet |

All marks are pure geometry (no fonts, no bitmaps), so they stay crisp at any
size. The lockup wordmark is set in `Inter / SF Pro Display` with a system
fallback — the preview PNG was rendered on a box that has neither, so the
letterforms there are a stand-in.

Nothing here is wired into the build yet: `app.json` still points at
`assets/images/icon.png`, which is the stock Expo placeholder.
