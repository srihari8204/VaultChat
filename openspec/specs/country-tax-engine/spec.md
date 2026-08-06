# country-tax-engine Specification

## Purpose
Makes one application work worldwide by loading currency, tax rules, formats, and business-document requirements per country from server-side configuration instead of hardcoding any single country's tax system.
## Requirements
### Requirement: Country configuration loading
The system SHALL, when a shop selects a country, automatically load that country's: currency, tax type, invoice layout, address format, phone format, date format, time format, country-specific tax fields, and country-specific business documents.

#### Scenario: India configuration
- **WHEN** a shop selects India
- **THEN** the system loads INR (₹), tax type GST, optional fields (GST Registered, GSTIN, HSN/SAC, CGST, SGST, IGST) and optional documents (GST Certificate, Shop License, FSSAI, Drug License)

#### Scenario: United States configuration
- **WHEN** a shop selects the United States
- **THEN** the system loads USD ($), tax type Sales Tax, optional fields (EIN, State Tax ID) and optional documents (Business License)

#### Scenario: Other launch countries
- **WHEN** a shop selects the United Kingdom, Australia, Canada, or Singapore
- **THEN** the system loads GBP/VAT, AUD/GST, CAD/GST-HST-PST, or SGD/GST respectively, with each country's optional fields and documents

### Requirement: All tax fields are optional
The system SHALL treat every tax-related field and business document as optional. A shop SHALL be able to register, sell, and invoice without providing any tax information.

#### Scenario: Unregistered shop invoices without tax
- **WHEN** a shop has provided no tax registration details
- **THEN** invoices are generated without tax fields and no tax-related validation blocks any flow

#### Scenario: Adding tax details later
- **WHEN** a shop later marks itself GST/VAT registered and enters its tax identifiers
- **THEN** subsequent invoices include the configured tax fields; previously issued invoices are unchanged

### Requirement: Server-driven country management
The system SHALL source country configurations from the platform backend so administrators can add or edit countries, tax fields, and formats without an application release.

#### Scenario: New country added by admin
- **WHEN** an administrator publishes a new country configuration
- **THEN** the country becomes selectable in shop registration and its rules apply, with no client update required

#### Scenario: Configuration versioning
- **WHEN** a country configuration is updated
- **THEN** shops in that country receive the updated formats and fields, and invoices already issued retain the configuration they were generated with

