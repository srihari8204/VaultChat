## Purpose

The parts of Shop Book a customer touches after the money is settled: rating what happened, being recognised for coming back, and finding the shop again.

## ADDED Requirements

### Requirement: One rating per completed order
The system SHALL let a customer rate a completed order once, with stars and an optional review, and SHALL maintain the shop's average from those ratings.

#### Scenario: Second rating attempt
- **WHEN** a customer rates an order they have already rated
- **THEN** the request is refused and the shop's average is unchanged

### Requirement: Loyalty points
The system SHALL stamp loyalty points on order settlement, exactly once per order, and SHALL expose a customer's points per shop.

#### Scenario: Settlement is retried
- **WHEN** settlement runs twice for the same order
- **THEN** points are stamped once

### Requirement: Favorites
The system SHALL let a customer add and list favorite shops.

#### Scenario: Favorites listing
- **WHEN** a customer opens favorites
- **THEN** their saved shops are listed with current open state

### Requirement: Coupon management
The system SHALL let an owner create, list and delete coupons for their shop, and SHALL expose a shop's active coupons to customers.

#### Scenario: Deleted coupon
- **WHEN** a coupon is deleted
- **THEN** it no longer appears to customers and no longer discounts an order
