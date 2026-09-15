## ADDED Requirements

### Requirement: HTTP/3 is served at the TLS edge
The public API edge SHALL support HTTP/3 on its advertised UDP port while retaining HTTP/2 and HTTP/1.1 over TCP/443 and preserving the existing TURN relay on UDP/443. This deployment uses UDP/8443 for HTTP/3.

#### Scenario: Client supports QUIC
- **WHEN** a compatible client reaches the API through its advertised UDP/8443 endpoint
- **THEN** the edge SHALL negotiate HTTP/3 and proxy to the existing application upstream

#### Scenario: QUIC is unavailable
- **WHEN** UDP is blocked or the client does not support HTTP/3
- **THEN** the same API SHALL remain reachable over HTTP/2 or HTTP/1.1

### Requirement: HTTP/3 deployment is reversible
The edge change SHALL be validated before switching production traffic and SHALL retain a tested rollback configuration.

#### Scenario: New edge validation fails
- **WHEN** configuration, certificate, health or protocol checks fail
- **THEN** production traffic SHALL remain on the existing nginx TLS edge

### Requirement: WebTransport is negotiated and optional
Any WebTransport carrier SHALL use existing authenticated CC-Wire frames and SHALL be advertised only after server and mobile client support pass interoperability tests.

#### Scenario: WebTransport is unsupported
- **WHEN** either peer lacks WebTransport support
- **THEN** CC-Wire SHALL use WebSocket or the application SHALL retain its existing fallback paths
