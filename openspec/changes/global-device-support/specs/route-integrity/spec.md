## ADDED Requirements

### Requirement: Every screen is reachable or removed
Every route file SHALL be reachable from at least one navigation path, or SHALL be deleted. A screen that is neither reachable nor deleted SHALL fail a guardrail.

#### Scenario: Orphaned screen detected
- **WHEN** a route file has no inbound navigation from any other screen and carries no documented exemption
- **THEN** the route-coverage selftest fails and names the file

#### Scenario: Screen is useful and rerouted
- **WHEN** an orphaned screen provides functionality the app still needs
- **THEN** it is wired to a real entry point and that entry point is covered by the guardrail

#### Scenario: Screen is obsolete and removed
- **WHEN** an orphaned screen duplicates functionality that already exists elsewhere
- **THEN** it is deleted together with its now-unreferenced imports

### Requirement: User-facing copy matches reachable navigation
Copy that tells the user where to find a setting SHALL correspond to a real, reachable destination.

#### Scenario: Deferral copy names a settings location
- **WHEN** a screen offers to defer an action with copy such as "grant later in settings"
- **THEN** a route to that settings destination exists and is reachable, or the copy is changed to describe what actually happens

### Requirement: Every capability has exactly one implementation
A capability SHALL have a single implementation. Duplicate modules implementing the same behaviour SHALL be removed, keeping the one that is wired in.

#### Scenario: Duplicate module with no importers
- **WHEN** two modules implement the same behaviour and one has zero importers
- **THEN** the unused module is deleted rather than left as a trap for future edits

#### Scenario: Only path to a user action lives in dead UI
- **WHEN** the sole code path for a user-visible action is reachable only from unreachable UI
- **THEN** the action is rewired to a reachable control, because the capability is otherwise absent from the product
