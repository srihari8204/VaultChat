# reports-analytics Specification

## Purpose
Gives shop owners the numbers they run their business on — sales by period, pending payments, taxes, best sellers, top customers — with depth gated by subscription tier.
## Requirements
### Requirement: Sales reports
The system SHALL provide owners daily, weekly, monthly, and yearly sales reports including total sales, order count, and average order value, with a sales-over-time chart.

#### Scenario: Monthly sales view
- **WHEN** an owner opens the monthly report
- **THEN** total sales, total orders, average order value, and a per-week breakdown are shown for the selected month

### Requirement: Business insight reports
The system SHALL provide pending-payment reports, tax reports (aggregating tax collected per the country configuration), best-selling products, top customers, and product performance.

#### Scenario: Tax report for a registered shop
- **WHEN** an owner with tax fields configured opens the tax report for a period
- **THEN** taxable sales and collected tax are aggregated according to the shop's country tax configuration

#### Scenario: Best sellers
- **WHEN** an owner opens best-selling products for a period
- **THEN** products rank by quantity and revenue for that period

### Requirement: Plan-scoped report depth
The system SHALL provide basic reports (daily/weekly/monthly sales, pending payments) on the Free plan and advanced reports (yearly, tax, best sellers, top customers, product performance, analytics) on the Pro plan.

#### Scenario: Free-plan owner opens an advanced report
- **WHEN** a Free-plan owner opens a Pro-only report
- **THEN** a preview with an upgrade prompt is shown instead of the data

