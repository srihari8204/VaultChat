# shop-discovery Specification

## Purpose
Lets customers find trustworthy nearby shops from their GPS position, with enough at-a-glance information — distance, open state, pickup readiness — to choose where to order.
## Requirements
### Requirement: Nearby shop listing
The system SHALL list approved shops near the customer's GPS location, showing for each: shop name, category, distance, open/closed status, closing time, pickup availability, and estimated preparation time.

#### Scenario: Nearby list
- **WHEN** a customer opens the home screen with location access granted
- **THEN** approved shops are listed ordered by distance, each with the fields above

#### Scenario: Closed shop presentation
- **WHEN** a nearby shop is currently Closed, on Holiday, or on Vacation
- **THEN** it still appears in the list with its status and next-open information clearly indicated

#### Scenario: No location access
- **WHEN** the customer has not granted location access
- **THEN** the customer can set an area manually and discovery works from that point

### Requirement: Shop search and filtering
The system SHALL let customers search shops by name or product and filter by shop category.

#### Scenario: Search by product
- **WHEN** a customer searches for a product term
- **THEN** nearby shops whose catalogs match the term are listed

#### Scenario: Filter by category
- **WHEN** a customer filters by a category such as Vegetables or Medical
- **THEN** only nearby shops of that category are listed

