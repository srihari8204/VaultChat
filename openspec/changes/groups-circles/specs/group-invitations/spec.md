## ADDED Requirements

### Requirement: Per-invitee invitations
The system SHALL track an invitation to a specific person as its own record,
carrying the group, the inviter, the invitee identity, the channel used, an
expiry and a status. Status SHALL be one of Pending, Accepted, Rejected, Expired
or Revoked. The existing invite-link mechanism SHALL continue to work unchanged
for identity-less sharing.

#### Scenario: Invitation is tracked per person
- **WHEN** an admin invites a specific person
- **THEN** an invitation record is created with status Pending and appears in the group's sent-invitations list

#### Scenario: Acceptance transitions the record
- **WHEN** the invitee redeems their invitation
- **THEN** the invitation moves to Accepted, the invitee becomes a member, and the transition is recorded in the audit log

#### Scenario: Expiry
- **WHEN** an invitation's expiry passes without a response
- **THEN** its status becomes Expired and its token no longer redeems

#### Scenario: Bare links still work
- **WHEN** a member shares a plain invite link with no addressed invitee
- **THEN** the existing link redeem path is used and no invitation record is required

### Requirement: Invitation addressing channels
The system SHALL let an inviter address an invitee by VaultChat username, phone
number or email, and SHALL let any invitation be delivered as a QR code, a
secure link or a short code, shareable over SMS, WhatsApp or email.

#### Scenario: Invite by username
- **WHEN** an inviter enters a VaultChat username
- **THEN** the invitation is bound to that account and the invitee sees it in-app

#### Scenario: QR code
- **WHEN** an inviter displays the invitation as a QR code and the invitee scans it
- **THEN** the invitee is taken to the join flow for that group

#### Scenario: Share to an external channel
- **WHEN** an inviter shares via SMS, WhatsApp or email
- **THEN** the message carries the secure link and the short code, and the invitation records which channel was used

### Requirement: Invitation token security
An invitation token SHALL be opaque and unguessable, SHALL be bound to its
invitation, group and expiry under a server-held HMAC, and SHALL carry no
personal data. A token SHALL NOT be redeemable against any group other than the
one it was minted for. The server SHALL store only a hash of the token.

#### Scenario: Token cannot be replayed elsewhere
- **WHEN** a leaked token is presented against a different group
- **THEN** validation fails because the group id is bound into the token

#### Scenario: Token carries no personal data
- **WHEN** a token is inspected
- **THEN** it reveals no username, phone number, email or group name

#### Scenario: Token is single-use
- **WHEN** a per-invitee token is redeemed successfully
- **THEN** a second redemption of the same token is rejected

### Requirement: Duplicate and race protection
The system SHALL reject an invitation to a person who is already an active
member or who already holds a Pending invitation to that group, and SHALL ensure
concurrent redemptions cannot produce duplicate memberships or exceed the
member cap.

#### Scenario: Already a member
- **WHEN** an admin invites someone who is already an active member
- **THEN** the invitation is rejected with a message saying they are already in the group

#### Scenario: Already invited
- **WHEN** an admin invites someone with an outstanding Pending invitation
- **THEN** the system offers to resend the existing invitation rather than creating a second one

#### Scenario: Concurrent redeem
- **WHEN** the same invitation is redeemed twice simultaneously
- **THEN** exactly one membership is created, because redemption reuses the existing atomic redeem path

### Requirement: Resend, revoke and approval
The system SHALL let a permitted member resend an invitation with a fresh token,
revoke a Pending invitation, and — when the group requires approval — hold a
redeemed invitation for admin decision before membership is granted.

#### Scenario: Resend
- **WHEN** an inviter resends a Pending invitation
- **THEN** a new token is issued, the previous token stops working, and the invitation stays Pending

#### Scenario: Revoke
- **WHEN** an inviter revokes a Pending invitation
- **THEN** the status becomes Revoked, the token stops working, and the audit log records it

#### Scenario: Approval required
- **WHEN** a group has `privacy='invite_only'` and an invitee redeems
- **THEN** a join request is queued for admin decision and membership is granted only on approval

#### Scenario: Rejection
- **WHEN** an admin rejects a queued join request
- **THEN** the invitation becomes Rejected and no membership is created

### Requirement: Reachable join entry point
The system SHALL provide a way to enter an invite code or scan a QR from within
the app regardless of how many groups the user already belongs to.

#### Scenario: Existing user joins a second group
- **WHEN** a user who already belongs to one or more groups receives an invite code
- **THEN** they can reach a screen to enter it, rather than the entry point being available only at zero groups
