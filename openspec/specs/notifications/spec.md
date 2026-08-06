# notifications Specification

## Purpose
Keeps both sides of every order informed in real time: customers about order progress and payments, owners about new orders, stock, and collections — via push notifications with an in-app notification center.
## Requirements
### Requirement: Customer notifications
The system SHALL notify the customer on: order accepted, alternative suggested, order rejected, order cancelled, preparing, packing, ready for pickup, payment received, and pending-amount reminders.

#### Scenario: Ready for pickup
- **WHEN** the owner marks an order Ready
- **THEN** the customer receives a push notification and the in-app notification center records it

#### Scenario: Pending reminder
- **WHEN** a customer has a pending balance beyond the reminder threshold
- **THEN** they receive a reminder notification stating the shop and amount

### Requirement: Owner notifications
The system SHALL notify the owner on: new order, customer accepted an alternative, payment received, low stock, daily summary, and pending collections.

#### Scenario: New order alert
- **WHEN** a customer places an order
- **THEN** the owner receives an immediate notification that opens the order review screen

#### Scenario: Daily summary
- **WHEN** the shop's business day ends
- **THEN** the owner receives a summary of the day's orders, sales, and pending collections

### Requirement: Notification center
The system SHALL keep an in-app notification list per user with read/unread state and a mark-all-read action, so missed push notifications remain visible.

#### Scenario: Mark all as read
- **WHEN** a user taps mark-all-read in the notification center
- **THEN** all notifications are marked read and the unread badge clears

