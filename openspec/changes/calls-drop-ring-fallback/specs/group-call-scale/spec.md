## MODIFIED Requirements

### Requirement: Bounded group ring
Ringing a group SHALL cost the caller one request regardless of group size. The server
SHALL perform the per-member fan-out. The caller's ring budget SHALL NOT be consumed in
proportion to the number of members.

There SHALL be exactly one ring path. When the server ring request fails, the client SHALL
NOT fall back to a per-recipient client-side loop: a failed ring SHALL surface as a failed
ring. A silent fallback would reintroduce a second path with weaker semantics — the socket
loop emits only, so it cannot wake a dozing phone — and would spend one budget unit per
member on exactly the calls the single request was built to protect.

#### Scenario: Starting a call in a 64-member group
- **WHEN** a member starts a group call in a chat with 63 other members
- **THEN** the client sends one ring request and the server rings each member
- **AND** the caller may start another group call within the same rate-limit window

#### Scenario: Only chat members are rung
- **WHEN** the server fans out a group ring
- **THEN** it rings only current members of that chat, verified server-side, and never a
  client-supplied recipient list

#### Scenario: The ring request fails
- **WHEN** the server ring request returns an error of any kind
- **THEN** the caller is told the ring failed
- **AND** no second ring path runs, so no member is rung twice and no member is woken by a
  path that cannot deliver a push
