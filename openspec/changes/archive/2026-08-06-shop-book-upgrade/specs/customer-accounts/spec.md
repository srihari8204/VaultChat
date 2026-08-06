## Purpose

Lets customers join Shop Book with a near-zero-friction signup and gives them one dashboard for their orders, spending, dues, and favorite shops. The customer experience is permanently free.

## ADDED Requirements

### Requirement: Minimal customer registration
The system SHALL register a customer with only: mobile number, OTP verification, name, and a location permission grant. The system SHALL NOT require email, address, documents, or any other field to complete customer registration.

#### Scenario: Successful registration
- **WHEN** a new user enters a mobile number, verifies the OTP, provides a name, and grants location access
- **THEN** the customer account is created and the user lands on the nearby-shops home screen

#### Scenario: Location permission declined
- **WHEN** a user declines the location permission during registration
- **THEN** the account is still created, and shop discovery prompts for a manually chosen area until location access is granted

#### Scenario: OTP re-verification on new device
- **WHEN** an existing customer signs in on a new device with their mobile number
- **THEN** the system verifies via OTP and restores their profile, order history, and ledger

### Requirement: Customer accounts are always free
The system SHALL provide all customer features — unlimited shops, unlimited orders, unlimited purchase history — without any subscription, trial, or payment.

#### Scenario: No paywall in customer flows
- **WHEN** a customer uses any customer-app feature
- **THEN** no upgrade prompt, subscription screen, or feature limit is presented

### Requirement: Customer dashboard
The system SHALL provide a customer dashboard showing current orders, order history, purchase history, total pending amount across shops, payment history, favorite shops, shopping lists, and saved brands.

#### Scenario: Pending amount overview
- **WHEN** a customer has unpaid balances at one or more shops
- **THEN** the dashboard shows the total pending amount and a per-shop breakdown from the digital ledger

#### Scenario: Favorite shops
- **WHEN** a customer marks a shop as favorite
- **THEN** the shop appears in the dashboard's favorites list and is prioritized in discovery

#### Scenario: Shopping lists and saved brands
- **WHEN** a customer saves a shopping list or a preferred brand for a product
- **THEN** the list and brand preferences are available when composing future orders
