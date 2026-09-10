# Aurora Glass — VaultChat's glassmorphism UI

One design system, four surfaces. Everything below shares the same tokens
(`constants/theme.ts`) and the same glass recipes (`constants/glass.ts`), so a
change to the accent or to a blur intensity is a change in one place.

| Surface | What it is | Where |
|---|---|---|
| **Figma** | Variables (Dark/Light modes), text + effect styles, components, five 390×844 screens | https://www.figma.com/design/CjvK3XTpt9eViZbAam51ui |
| **Replit** | Interactive web prototype (React) of all five tabs, dark/light, reduced motion, token panel | https://replit.com/@srihariballa/SourCoralBackground |
| **Canva** | Aurora chat wallpaper (phone) and the UI showcase graphic (1080×1350) | wallpaper: https://www.canva.com/d/OxN5vFpL4pRVgHN · showcase: https://www.canva.com/d/FMdlrbZNPzIYfo6 |
| **Repo** | RN primitives `GlassView` / `GlassCard` / `GlassChip`, recipes, HTML reference | `components/ui/`, `constants/glass.ts`, `design/aurora-glass/` |

Replit dev preview (sleeps when idle; open the Repl to wake it):
https://50d7bf69-2609-46b0-bb95-8bee2f812f83-00-3fv3qknc97u6v.pike.replit.dev/
Canva view-only links: wallpaper https://www.canva.com/d/GSa8EDOSK7Hx8-s · showcase https://www.canva.com/d/2lUeSQLslWJFVYX

## The idea in one paragraph

The personality lives in the **ground**, not in the rows. A deep obsidian base
(`#0A0810`, lavender-tinted `#F4F1FA` in light) carries three or four soft aurora
blooms. Glass — real backdrop blur, a translucent fill, a hairline rim and a
1px **lip** highlight along the top edge — is spent only on chrome that floats
over moving content: the tab bar, the chat header, the composer, bottom sheets.
Lists stay flat and dense (72pt rows, 50pt ringed avatars, hairlines inset under
the text) so they read at a glance and never pay a blur pass per row. Identity
is carried by a per-contact gradient **ring** around a ground disc, not by a
solid coloured block.

## Tokens ↔ Figma ↔ CSS

| Role | RN token | Figma variable | Dark | Light |
|---|---|---|---|---|
| Ground | `bg` | `bg/ground` | `#0A0810` | `#F4F1FA` |
| Glass fill | `glass` | `glass/fill` | white 8% | white 70% |
| Glass soft | `glassSoft` | `glass/soft` | white 6% | white 55% |
| Glass rim | `glassStroke` | `glass/stroke` | white 16% | ink 10% |
| Lip peak | `lipPeak()` | `glass/highlight` | 0.18–0.30 | 0.95 |
| Hairline | `hairline` | `line/hairline` | white 6% | ink 8% |
| Accent | `primary` | `brand/accent` | `#9D6FD0` | `#9D6FD0` |
| Accent ramp | `accentLight → accentDeep` | `brand/accent-light → -deep` | `#C9A6F5 → #7C3AED` | `#A78BFA → #6D28D9` |
| Accent as text | `accentOn` | `brand/accent-on` | `#C9A6F5` | `#6D28D9` |
| Sent bubble | `bubbleOut` | `chat/bubble-out` | `#7C3AED` | `#6D28D9` |

Glass recipes (`constants/glass.ts` ↔ Figma effect styles):

| Class | Figma style | Blur | Lip | Radius | Shadow | Blurs by default |
|---|---|---|---|---|---|---|
| `chrome` | Glass/Chrome | 48 (≈24px CSS) | .28 | 30 | 0 12 28 · 55% | yes |
| `card` | Glass/Card | 36 | .22 | 24 | 0 8 16 · 32% | **no** |
| `chip` | Glass/Chip | 24 | .18 | pill | 0 2 6 · 18% | **no** |
| `sheet` | Glass/Sheet | 56 | .30 | 28 | 0 −6 40 · 60% | yes |

Glows: `GLOW.accent` / `GLOW.fab` (violet), `GLOW.success`, `GLOW.danger` ↔
Figma `Glow/Accent`, `Elevation/FAB`, `Glow/Success`, `Glow/Danger`.

Type: Sora ExtraBold/Bold for display → h3, Nunito Sans for body → tiny
(`TYPOGRAPHY` in `constants/theme.ts` ↔ Figma `Aurora/*` text styles).

## Using the primitives

```tsx
import { GlassView, GlassCard, GlassChip } from '../components/ui';

// Floating chrome: real blur, lip highlight, class picks intensity/radius.
<GlassView kind="chrome" highlight style={styles.tabBarGlass} />

// A card: flat translucent by default; `blur` opts ONE hero card in.
<GlassCard blur glow="accent">…security score…</GlassCard>
<GlassCard>…settings group…</GlassCard>

// A filter chip: glass idle, accent gradient + glow when active.
<GlassChip label="Unread" count={4} active={folder === 'unread'} onPress={…} />
```

Rules the self-test enforces (`npm run test:glass`):

- only `chrome` and `sheet` blur by default — cards and chips never do;
- intensity ranks `chip < card < chrome < sheet`;
- glows are saturated colours, never a neutral (the theme-coverage rule);
- the lip is stronger on the light ground, where a faint one vanishes.

## Where it is applied in the app today

- `app/(tabs)/_layout.tsx` — tab bar background is `GlassView kind="chrome" highlight`.
- `app/chat.tsx` — header and composer use the `chrome` recipe; the composer wears the lip.
- `app/(tabs)/chats.tsx` — folder filter row is `GlassChip` (six ad-hoc styles removed).
- `components/ui/AuroraBackground.tsx` — the blooms, per-screen compositions.

## Figma file map

- **01 · Foundations** — token board: colour swatches bound to `Aurora` variables (Dark/Light), type ramp, glass surfaces over aurora blooms, radius and spacing scales.
- **02 · Components** — `Chip` (State=Default/Active), `Button` (Primary/Secondary/Danger), `Icon Button`, `Tab Bar`, `Avatar / Ring`, `Chat Row`, `Bubble` (In/Out), `Date Pill`, `Composer`, `Status Bar`, `Header / Tab`, `Header / Chat`. Each carries a description that names its RN counterpart.
- **03 · Screens** — Chats, Conversation, Calls, Profile, Apps at 390×844, composed from the component instances.

## Local reference

`design/aurora-glass/index.html` renders the same five screens in a browser with
CSS `backdrop-filter`, the app dark/light switch and a token readout. It is the
acceptance reference for the primitives and is excluded from the app bundle.
