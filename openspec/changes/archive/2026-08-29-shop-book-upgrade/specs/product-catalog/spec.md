## Purpose

Gives every shop a text-first product catalog that is fast to set up from category starter templates, and gives customers structured search plus free-text product entry so they can order anything the shop might stock.

## ADDED Requirements

### Requirement: Product record
The system SHALL store for every product: product name, brand, category, unit, selling price, discount, tax, stock status, description, and availability. Version 1 SHALL be text-only; product images SHALL NOT be required or displayed.

#### Scenario: Owner adds a product
- **WHEN** an owner creates a product with name, unit, and selling price
- **THEN** the product is saved and visible in the shop's catalog; brand, discount, tax, and description remain optional

#### Scenario: Stock status values
- **WHEN** an owner sets a product's stock status to In Stock, Low Stock, or Out of Stock
- **THEN** customers see the status in the catalog and price comparison, and Out of Stock products cannot be added to a cart without the manual-entry path

### Requirement: Category starter catalogs
The system SHALL provide a starter catalog per shop category (Super Market, Grocery, Vegetables, Fruits, Chicken, Mutton, Fish, Bakery, Dairy, Medical, Stationery, Hardware, Electronics, Pet Shop) that pre-populates typical products for the owner to price and activate. Categories and starter catalogs SHALL be server-managed so new ones can be added without an application change.

#### Scenario: Starter catalog on setup
- **WHEN** a new Chicken Shop finishes registration
- **THEN** the catalog is pre-seeded with items such as Whole Chicken, Curry Cut, Boneless, Wings, Liver, and Gizzard, all inactive until the owner sets prices

#### Scenario: New category added by admin
- **WHEN** an administrator publishes a new shop category with a starter catalog
- **THEN** new shops can select it at registration without a client update

### Requirement: Product search with manual entry
The system SHALL let customers search a shop's catalog and select products, or type a product manually when it is not listed. In both paths the customer MAY select a preferred brand, SHALL set a quantity, and MAY add special notes.

#### Scenario: Catalog search
- **WHEN** a customer searches "oil" in a shop's catalog
- **THEN** matching products are shown with brand, unit, price, and stock status

#### Scenario: Manual product entry
- **WHEN** a customer types a product name not present in the catalog, optionally with a brand and notes
- **THEN** the item is added to the cart as a custom item for the owner to review for availability

#### Scenario: Optional brand preference
- **WHEN** a customer orders a product without choosing a brand
- **THEN** the order marks the brand as "any", and the owner may fulfill with any available brand
