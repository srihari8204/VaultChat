# Shop Book — glass redesign brief

Status: **spec only, nothing implemented.** Input brief for the Figma pass.

Decisions taken 2026-09-04 (owner):
1. Extend Vault Finance's tokens — do NOT author a second glass system.
2. Figma first, then code.
3. Land invoice + owner dashboard first.

Scope rule from the master prompt, restated because it governs every line below:
**redesign everything visually, break nothing functionally.** No backend, no API,
no schema, no calculation, no validation, no permission changes.

---

## 1. What Shop Book is

One file — `app/shop-book.tsx`, 4,768 lines, 53 components, two apps behind one
mode switch.

| | Customer | Owner |
|---|---|---|
| Tabs | shops · orders · profile | dashboard · orders · products · khata |

Data layer, untouched by this work:

- `services/shopBookService.ts` — every network call
- `utils/shopbook.ts` — every calculation (`cartTotal`, `couponDiscount`, `orderProgress`, `loyaltyTier`, …) + `utils/shopbook.selftest.ts`
- `lib/shopbookI18n.ts` — 7 languages, `t()` on every string
- `db/shopLists.ts`, `constants/shopCategories.ts`

## 2. The design system already exists

Built for the sibling mini-app one commit ago. Reuse, don't re-author:

| Module | What it already gives us |
|---|---|
| `constants/financeTheme.ts` | 3 glass levels (`card` .62 / `cardStrong` .80 / `cardSolid`), AA-pinned semantic colours at 11–13pt, `FIN_HERO`, `FIN_RADIUS`, `FIN_SHADOW`, `TABULAR` |
| `components/finance/ui.tsx` | 24 components incl. HeroCard, StatTile, Field, Btn, Segment, Pill, RowLine, QuickAction, EmptyState, LoadingState, ErrorState, TileGrid, ActionGrid |
| `lib/finance/grid.ts` | responsive layout derived from the measured window; Node-tested in `grid.selftest.ts` |

`lib/finance/grid.ts` is the answer to "always responsive as per device screen
size", and it is already proven: columns come from the measured window, not
percentages. Hero stacks below 360dp. Tiles 2-up → 4-up at 480dp. Content column
caps at 600dp so a tablet does not stretch a balance across a metre of glass.
Shop Book must consume these functions, never re-derive them.

### 2.1 Promotion

`financeTheme.ts` / `components/finance/ui.tsx` / `lib/finance/grid.ts` move to
shared modules (`constants/glassTheme.ts`, `components/glass/ui.tsx`,
`lib/layout/grid.ts`) re-exported from their current paths so no finance screen
changes in the same diff. Two mini-apps now depend on them, so the `finance/`
namespace is a lie.

### 2.2 Palette bridge

Shop Book's `C` (`app/shop-book.tsx:44`) is a flat hardcoded green/navy set. Map,
do not keep:

| `C.*` | becomes |
|---|---|
| `green`, `greenDark` | `SHOP.brand` — a Shop Book accent added to the shared token file, same slot finance fills with lavender |
| `greenSoft` | `SHOP.brandSoft` |
| `bg` `#F3F4F6` | `FIN.bg` (transparent) + the ice gradient in a `_layout` |
| `card` `#FFFFFF` | `FIN.card` (translucent) |
| `border` / `line` | `FIN.border` / `FIN.line` |
| `text` / `sub` | `FIN.text` / `FIN.sub` |
| `danger` `#DC2626` | `FIN.bad` `#B42318` — **contrast fix**, the old value fails AA at the sizes it is used |
| `amber` `#D97706` | `FIN.warn` `#B54708` — same reason |
| `blue` | `FIN.info` |
| `navy` | keep as `SHOP.ink`, it is the QR + heading colour and has no finance equivalent |

Shop Book has no `_layout.tsx` today (it is a flat route). It needs one, purely
to render the ice gradient once — that is the mechanism by which one token change
restyles every screen instead of 53 edits.

## 3. What is genuinely missing and must be designed

Finance has none of these:

1. **Transaction / order row** — avatar, title, sub, status pill, right-aligned tabular amount.
2. **Order status pill** — 8 `OrderStatus` values, currently `StatusPill` at `:4446`.
3. **Dual bottom tab bar** — `TabBar` at `:4349`, two different tab sets per mode.
4. **Availability tag** — `ItemAvailability`, no finance analogue.
5. **Stepper** — the qty +/- control in `Catalog`, used at every price point.
6. **The invoice document** — see §5. Explicitly NOT glass.

## 4. Owner dashboard — first target

Current shape (`:1653`):

shop card (→ settings, QR modal, plan tag, open/closed badge) · location banner
(conditional) · 4 StatCards · low-stock banner · margin panel (3 conditional
variants) · purchases panel · 8 link cards in a wrapped row.

Redesign, no data changes:

- Shop card → `HeroCard` with `FIN_HERO`, open/closed state driving the gradient.
- 4 StatCards → `TileGrid` + `StatTile`. This is the responsive win: today it is a fixed `s.statGrid`, it becomes 2-up/4-up from the measured window.
- 8 link cards → `ActionGrid` + `QuickAction`, 3–6 columns by width instead of a wrapped row.
- Margin panel keeps all three conditional branches verbatim. The "covers X of Y" hint is a correctness statement, not decoration — it must survive.
- Banners (pending approval, location, low stock) → one `Banner` component, tone `warn`.

Every one of the ten `on*` callbacks keeps its destination.

## 5. Invoice — and the defect it surfaces

There are **two divergent HTML generators**:

| | `buildBillHtml` `:958` | `InvoiceView.sharePdf` `:4243` |
|---|---|---|
| Purpose | pickup receipt | **tax invoice** |
| Styling | stylesheet, brand rule, uppercase table heads | inline styles |
| Tax identifiers | yes, country-driven from `shop.taxConfig` | flattened to one grey line |
| Unit column | yes | no |
| Rate column | yes | **no** |
| Unavailable items | struck through | not represented |
| Round off | n/a | no |
| **Paid / due** | n/a | **omitted — the on-screen view shows it, the PDF does not** |

The statutory document is the poorer of the two, and the PDF a customer keeps
disagrees with the screen the shop just showed them.

**Deliverable:** one printable template, both callers. Not glass — §12 of the
master prompt is right, and it is also what `FIN.cardSolid` exists for. Print
targets A4 and the thermal width. It must render:

header (logo, business name, address, phone, whatever `taxConfig` keys the shop
actually filled) · document title driven by `inv.kind` (`tax` → "Tax Invoice",
else "Invoice") · invoice no + date via `dateLocale(inv.country)` · billed-to,
plus `inv.buyer.*` only on a tax invoice · items table (item / brand / unit /
qty / rate / amount) · subtotal, discount + coupon code, `taxBreakdown[]`,
delivery, `roundOff`, total · **paid / due** · cancelled watermark when
`inv.status === 'cancelled'` · footer note + "Not a tax invoice" when there are
no tax identifiers.

Only fields that exist on `SB.Invoice` / `SB.OrderDetail`. Nothing invented.

## 6. Functionality map (§30)

Complete for the first slice. Owner-mode screens 3–22 and all customer screens
follow the same rule — restyle in place, callbacks and service calls untouched —
and get filled in as each is picked up.

| Existing function | Source | New location | Data dependency | Result |
|---|---|---|---|---|
| Dashboard totals | `SB.dashboard()` `:1665` | HeroCard + TileGrid | unchanged | unchanged |
| Shop QR / deep link | `:1662`, Modal `:1671` | bottom sheet | `vaultchat://shop-book?shop=` | unchanged |
| Open/closed state | `shopOpenState(shop)` | hero gradient + Pill | pure util | unchanged |
| Plan tag free/pro | `:1707` | Pill on hero | `shop.plan` | unchanged |
| Location missing banner | `:1719` | Banner `warn` → settings | `shop.lat/lng` null check | unchanged |
| Low stock warning | `:1735` | Banner `warn` | `d.lowStock` | unchanged |
| Margin / cost of goods | `:1745` | Card + RowLine | `d.grossProfit`, `d.marginCoverage` | **all 3 branches kept** |
| 8 quick links | `:1775` | ActionGrid | callbacks unchanged | unchanged |
| Khata customer list | `SB.ownerLedgerSummary()` | transaction rows | unchanged | unchanged |
| Add walk-in customer | `SB.createKhataCustomer` `:3378` | bottom sheet form | dedup on (shop, mobile) | **duplicate alert kept** |
| Counter sale | `CounterSale` `:3503` | bottom sheet | deliberately not a ledger entry | unchanged |
| Owed / stale summary | `:3401` | Banner `warn` | `staleDays > 30` | unchanged |
| Invoice fetch | `SB.orderInvoice()` | preview screen | unchanged | unchanged |
| Invoice PDF | `Print.printToFileAsync` | sticky primary action | unchanged | **gains paid/due** |
| Bill share | `buildBillHtml` | same template | unchanged | unchanged |

Nothing in the audit failed to map.

## 6b. What shipped, and the one requirement that did not

Shipped code-first (Figma unavailable, per the spec's own §25), none of it
device-tested:

- **One canonical invoice.** `utils/shopbookInvoice.ts` + 45 checks. Restores
  paid/due, rate, unit, round-off and tax identifiers to the PDF.
- **Glass foundation.** `C.bg`/`C.card` repointed at the shared tokens, ice
  gradient in an `IceGround` wrapper, modals kept solid over their scrim.
- **Responsive.** `s.body` capped and centred at `FIN.contentMax` (all 34
  screens), dashboard totals on `TileGrid`, quick links on `ActionGrid`,
  status-bar padding from `useSafeAreaInsets`. No percentage widths or
  hardcoded device pixels remain in the file.
- **Shared components.** `TxnRow` (4 callers), `Banner` (3 callers), `StatCard`
  and `Empty` delegating to the shared tiles/states, 16 spinners → `LoadingState`.
- **Bugs fixed on the way:** owner order list hardcoded ₹; status pills filled
  with a 12.5% alpha wash that vanished on glass; order lists showed no date;
  25 hardcoded-₹ call sites swept (one legitimate use left).
- **Contrast:** `danger` and `amber` moved to AA-clearing values.

### NOT DELIVERED — dark mode

The master prompt asks for light **and** dark (§4/§5 of the original brief).
The shared system is deliberately light-only: `constants/financeTheme.ts` says
so in its header — *"Kept as a STATIC palette (not the theme hook) so every
finance screen renders identically."*

Delivering dark mode means converting that static palette to a theme hook, which
changes **Vault Finance's** appearance too. That is a shared-system change
affecting a second shipped mini-app, so per §31 ("no destructive refactor
without explicit approval") it is reported, not done.

Two options when you want it:
1. Convert the shared palette to the theme hook and re-verify both mini-apps.
2. Give Shop Book its own theme hook and let the two modules diverge — cheaper,
   but it is the "two design systems" outcome §23/§24 exist to prevent.

Also still open: `§27` workflow testing and the `§28` width matrix both need a
device. Nothing in this repo can close them.

## 7. Blocked

Figma MCP did not respond (2246s silent, aborted) on `whoami`. Every Figma
deliverable — artboards at 320/390/744dp, the variable collection extending
`N5Y6KcMUPA3LgtWjfHPctz`, the component library, the prototype — is blocked on
that connection. Memory records a prior Figma failure that presented as a quota
block and was really a wrong-account block; check the account before assuming
the service is down.

Nothing here depends on Figma. Everything here is the brief that goes into it.
