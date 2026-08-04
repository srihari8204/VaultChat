## Purpose

Makes the app usable in each market's language and conventions: a switchable multi-language UI plus country-driven date, time, phone, address, and currency formatting.

## ADDED Requirements

### Requirement: Multi-language UI
The system SHALL launch with English, Hindi, Telugu, Tamil, Gujarati, and Kannada, selectable by the user at any time and defaulting from the device locale. Adding a language SHALL NOT require code changes beyond a translation bundle.

#### Scenario: Switch language
- **WHEN** a user selects Telugu in settings
- **THEN** the UI re-renders in Telugu immediately and the choice persists across sessions

#### Scenario: Missing translation fallback
- **WHEN** a string lacks a translation in the selected language
- **THEN** the English string is shown rather than a blank or key name

### Requirement: Country-driven formatting
The system SHALL format currency, dates, times, phone numbers, and addresses according to the country configuration loaded from the tax engine — the shop's country for shop-facing and invoice content, the customer's locale for customer-facing display.

#### Scenario: Currency display
- **WHEN** a customer views an Indian shop's catalog
- **THEN** prices display with ₹ and Indian digit grouping as defined by the India configuration

#### Scenario: Invoice formats follow the shop country
- **WHEN** an invoice is generated for a UK shop
- **THEN** dates, currency, and address layout follow the UK configuration regardless of the viewer's UI language
