# subscription-plans Specification

## Purpose
Monetizes the shop-owner side with a Free tier generous enough to start and a Pro tier for growth, while guaranteeing the customer app never requires payment.
## Requirements
### Requirement: Free plan for shop owners
The system SHALL provide a Free plan including: one shop, up to 200 customers, product catalog, order management, digital ledger, basic reports, and notifications.

#### Scenario: Customer limit reached
- **WHEN** a Free-plan shop's 201st unique customer attempts to connect or order
- **THEN** existing customers and orders continue to work, the new customer relationship is blocked, and the owner is prompted to upgrade

### Requirement: Pro plan for shop owners
The system SHALL provide a paid Pro plan including: unlimited customers, unlimited products, inventory management, advanced reports, staff accounts, cloud backup, analytics, and priority support.

#### Scenario: Upgrade to Pro
- **WHEN** an owner completes a Pro subscription purchase
- **THEN** Pro features unlock immediately and any Free-plan blocks (customer limit) are lifted

#### Scenario: Pro lapse
- **WHEN** a Pro subscription expires without renewal
- **THEN** the shop reverts to Free-plan limits without losing any data; over-limit customers become read-only until renewal

### Requirement: Customers never pay
The system SHALL NOT attach any subscription, trial, or payment requirement to customer accounts, regardless of usage volume.

#### Scenario: Heavy customer usage
- **WHEN** a customer uses unlimited shops, orders, and history
- **THEN** no payment or upgrade flow is ever presented to them

