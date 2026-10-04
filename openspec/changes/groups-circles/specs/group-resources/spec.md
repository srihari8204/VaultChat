## ADDED Requirements

### Requirement: Group safe zones
The system SHALL let each group hold its own safe zones, independent of every
other group, with entry and exit alerts, per-zone enable/disable, scheduled
activation windows and temporary zones that expire. Zone definitions and
crossing evaluation SHALL remain on-device.

#### Scenario: Zones are isolated per group
- **WHEN** a user belongs to both a Family group and an Office group
- **THEN** each group's zones are separate and a crossing raises an alert only in the group that owns the zone

#### Scenario: Scheduled activation
- **WHEN** a zone is scheduled for school hours
- **THEN** crossings raise alerts only inside that window and are ignored outside it

#### Scenario: Temporary zone expires
- **WHEN** a temporary zone passes its expiry
- **THEN** it stops producing alerts automatically

#### Scenario: Definitions stay on-device
- **WHEN** a zone is created or evaluated
- **THEN** neither its coordinates nor the evaluation are sent to the server; only the resulting event is shared with the group

### Requirement: Group alerts
The system SHALL raise group-scoped alerts for arrival, departure, low battery,
GPS disabled, connectivity lost, SOS, route deviation, safe-zone events and
emergency announcements, each carrying a severity and a read state.

#### Scenario: Alert is scoped to its group
- **WHEN** an alert is raised in one group
- **THEN** it appears only in that group's inbox and unread count

#### Scenario: SOS severity
- **WHEN** a member triggers an SOS
- **THEN** the alert is recorded at critical severity and surfaces above lower-severity alerts

#### Scenario: History permission gates alert detail
- **WHEN** a member lacks the `view location history` permission
- **THEN** alerts are visible but their location detail and history links are withheld

### Requirement: Group tasks
The system SHALL provide a shared task list per group, where a task carries a
title, optional assignee, optional due date and a completion state, with
reminders for tasks that have due dates.

#### Scenario: Assign a task
- **WHEN** a member creates a task and assigns it to another member with a due date
- **THEN** the assignee sees it in the group task list and receives a reminder before it is due

#### Scenario: Completion is shared
- **WHEN** a member completes a task
- **THEN** every member sees the updated state

#### Scenario: Offline creation
- **WHEN** a task is created without connectivity
- **THEN** it is not queued: the member is told it was not saved, the task is withdrawn from the list, and what they typed is kept so they can save it again when connectivity returns

### Requirement: Group calendar
The system SHALL provide a shared calendar per group supporting one-off and
recurring events with reminders, queryable by date range.

#### Scenario: Shared event
- **WHEN** a member creates an event
- **THEN** it appears on every member's group calendar with the configured reminder

#### Scenario: Date-range query
- **WHEN** a member opens a month view
- **THEN** only that month's events are fetched, rather than the whole history

### Requirement: Group album
The system SHALL provide an encrypted shared media gallery per group, organised
by trip, event, date or contributing member.

#### Scenario: Contribute media
- **WHEN** a member adds a photo to the group album
- **THEN** it is encrypted, stored via the existing attachment pipeline, and visible to every member of that group only

#### Scenario: Organisation
- **WHEN** a member browses the album
- **THEN** they can group items by trip, event, date or member

### Requirement: Group notes
The system SHALL provide encrypted shared notes per group supporting text,
images, PDFs, voice notes and links.

#### Scenario: Shared note
- **WHEN** a member creates a group note
- **THEN** it is encrypted and readable by every member of that group

#### Scenario: Op index metadata
- **WHEN** a member saves a note or task change and the app has found the server's op index in this session
- **THEN** the change is sent encrypted with one plaintext op kind (`notes` or `tasks`) that the server indexes, so the server learns that the message is a notes or tasks op and when it was sent, but never its content or what the change does

#### Scenario: No op kind before the index exists
- **WHEN** the app has not found the op index on the server in this session
- **THEN** note and task changes are sent without the op kind, and members still read them from the thread and their own history

### Requirement: Announcements
The system SHALL let members holding the `send announcements` permission post a
pinned announcement that surfaces on the group dashboard and raises an alert.

#### Scenario: Permission gate
- **WHEN** a member without the announcements permission attempts to post one
- **THEN** the request is rejected by the server

#### Scenario: Announcement surfaces
- **WHEN** an announcement is posted
- **THEN** it is pinned on the dashboard and raised as an alert to every member

### Requirement: Group analytics
The system SHALL derive per-group insights — member activity, distance
travelled, attendance from safe-zone events, shared trip history and weekly
summaries — and SHALL compute and render them on-device.

#### Scenario: Weekly summary stays local
- **WHEN** a weekly summary is generated
- **THEN** it is computed from local history on the device and no aggregate is uploaded

#### Scenario: Attendance
- **WHEN** a group has a safe zone and members cross it over a week
- **THEN** attendance is derived from those entry and exit events

#### Scenario: Analytics respect the history permission
- **WHEN** a member lacks the `view location history` permission
- **THEN** they see only their own analytics, not other members'
