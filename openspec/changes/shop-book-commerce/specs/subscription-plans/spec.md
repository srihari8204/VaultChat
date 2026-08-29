## Purpose

Two tiers for shop owners, with one authority for which tier a shop actually has.

## MODIFIED Requirements

### Requirement: Pro plan for shop owners
The system SHALL provide a paid Pro plan including: unlimited customers, unlimited products, inventory management, advanced reports, staff accounts, cloud backup, analytics, and priority support.

Every feature gate SHALL read the shop's entitlement record, never the shop's `plan` column — the column is display only. A shop with no entitlement record SHALL be Free.

Entitlement state SHALL resolve as: `trial`, `active` and `past_due` grant Pro until the expiry passes; `grace_period` grants Pro regardless of expiry; `expired` and `cancelled` fall back to Free. A failed payment SHALL cost a shop its billing, not its trading day, and falling back to Free SHALL delete no data.

#### Scenario: Upgrade to Pro
- **WHEN** an owner completes a Pro subscription purchase
- **THEN** Pro features unlock immediately and any Free-plan blocks (customer limit) are lifted

#### Scenario: Pro lapse
- **WHEN** a Pro subscription expires without renewal
- **THEN** the shop reverts to Free-plan limits without losing any data; over-limit customers become read-only until renewal

#### Scenario: Plan column edited directly
- **WHEN** a shop's `plan` column says pro but no entitlement record grants it
- **THEN** every gate treats the shop as Free

#### Scenario: Failed payment
- **WHEN** an entitlement is `past_due` or in `grace_period`
- **THEN** Pro features keep working
