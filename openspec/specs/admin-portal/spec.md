# admin-portal Specification

## Purpose
Gives platform administrators the controls that keep the marketplace trustworthy and current: shop approval, document verification, and server-side management of countries, tax rules, categories, subscriptions, and support.
## Requirements
### Requirement: Shop approval and verification
The system SHALL let administrators review pending shop registrations and their verification documents, then approve (optionally granting a verified badge) or reject with a reason communicated to the owner.

#### Scenario: Approve a shop
- **WHEN** an administrator approves a pending shop
- **THEN** the shop becomes discoverable to customers and the owner is notified

#### Scenario: Reject with reason
- **WHEN** an administrator rejects a registration
- **THEN** the owner is notified with the reason and may resubmit corrected details

### Requirement: Platform configuration management
The system SHALL let administrators manage countries and the tax engine (currencies, tax types, fields, formats, documents), shop categories and their starter catalogs, and subscription plans — all server-side, effective without an app release.

#### Scenario: Edit a country's tax fields
- **WHEN** an administrator adds an optional tax field to a country configuration
- **THEN** shops in that country see the new optional field in their tax settings

#### Scenario: Manage subscription plans
- **WHEN** an administrator updates plan pricing or feature lists
- **THEN** new subscriptions use the updated terms and existing subscribers keep their current term until renewal

### Requirement: Platform operations
The system SHALL provide administrators platform-wide reports, a support-request queue, and promotion management.

#### Scenario: Handle a support request
- **WHEN** a user submits a support request
- **THEN** it appears in the admin queue with status tracking through resolution

### Requirement: Role-based admin access with audit logging
The system SHALL restrict admin-portal actions by role-based permissions and record every administrative action in an audit log.

#### Scenario: Audit trail
- **WHEN** an administrator approves a shop or edits a tax configuration
- **THEN** the action, actor, timestamp, and before/after values are recorded in the audit log

#### Scenario: Insufficient role
- **WHEN** an admin user without the required role attempts a restricted action
- **THEN** the action is denied and logged

