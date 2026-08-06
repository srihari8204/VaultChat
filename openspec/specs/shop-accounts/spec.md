# shop-accounts Specification

## Purpose
Lets a shop owner register their business, get verified, and present a trustworthy public profile — timings, status, photos, payment methods — that customers see during discovery and ordering.
## Requirements
### Requirement: Shop owner registration
The system SHALL register a shop with required fields: shop name, owner name, mobile number, OTP verification, country, shop category, address, GPS location, and a shop-front photo. Email, shop logo, interior photos, and business description SHALL be optional. GPS location SHALL be captured once at registration and reused thereafter.

#### Scenario: Successful shop registration
- **WHEN** an owner completes all required fields, verifies the OTP, captures the shop's GPS location, and uploads a shop-front photo
- **THEN** the shop account is created in a pending-approval state and the owner can begin setting up their catalog

#### Scenario: Country selection drives configuration
- **WHEN** the owner selects a country during registration
- **THEN** the country tax engine loads that country's currency, tax fields, formats, and optional documents into the shop's settings

#### Scenario: One-time GPS capture
- **WHEN** the shop's GPS location has been captured at registration
- **THEN** the system does not re-prompt for it, and the owner can only change it through an explicit profile edit

### Requirement: Shop approval before public listing
The system SHALL keep a newly registered shop hidden from customer discovery until a platform administrator approves it. Shops with reviewed verification documents SHALL display a verified badge.

#### Scenario: Pending shop is not discoverable
- **WHEN** a shop is registered but not yet approved
- **THEN** it does not appear in nearby-shop discovery or price comparison

#### Scenario: Verified badge
- **WHEN** an administrator approves a shop's verification documents
- **THEN** the shop's public profile displays a verified badge

### Requirement: Shop profile
The system SHALL present a public shop profile with: shop name, category, address, phone number, shop timings, weekly holiday, pickup availability, estimated preparation time, accepted payment methods, verified badge (if approved), and shop photos.

#### Scenario: Customer views a shop profile
- **WHEN** a customer opens a shop from discovery
- **THEN** the profile shows the fields above, with call, directions, share, and save actions

### Requirement: Shop status
The system SHALL let the owner set the shop status to one of: Open, Busy, Closing Soon, Closed, Holiday, Vacation. Status SHALL be visible to customers in discovery and on the shop profile, and SHALL affect order acceptance messaging.

#### Scenario: Status shown in discovery
- **WHEN** a shop sets its status to Closed or Holiday
- **THEN** customers see the status in the nearby list, and placing an order shows a clear "shop is closed" notice

#### Scenario: Automatic closing-soon indication
- **WHEN** the current time is within the configured window before the shop's closing time
- **THEN** the shop is presented as Closing Soon with its closing time

