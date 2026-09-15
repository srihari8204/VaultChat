# HTTP/3 edge rollout

Production currently uses nginx 1.24 for TLS. Its build has HTTP/2 but no
HTTP/3/QUIC module, so adding `quic` to the live vhost would fail `nginx -t`.
The overlay uses the existing Caddy image as an additional HTTP/3 edge and
forwards to the existing internal Caddy routing service. Nginx keeps TCP ports
80/443, including its other hostnames; only UDP/8443 is published by the new
edge. Signed `/vaultchat-media` requests go directly to MinIO with their Host
and path intact. API requests retain nginx's 100 MiB body limit.

UDP/443 already redirects to coturn on port3478 for restrictive-network calls.
Keep those IPv4/IPv6 NAT rules unchanged. They intercept external traffic before
Docker's HTTP/3 mapping, so publishing HTTP/3 on UDP/443 does not work on this
host. Caddy explicitly advertises `h3=":8443"` to match the separate host port.

## Validate without changing production

```bash
node scripts/check-http3-edge.mjs
docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.http3.yml config >/dev/null
docker run --rm -v "$PWD/caddy/Caddyfile.http3:/etc/caddy/Caddyfile:ro" caddy:2-alpine caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
HTTP3_HTTP_BIND=127.0.0.1:18080 HTTP3_TCP_BIND=127.0.0.1:18443 HTTP3_UDP_BIND=127.0.0.1:18443 \
  docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.http3.yml up -d h3-edge
curl -I --resolve api.corefinite.com:18080:127.0.0.1 http://api.corefinite.com:18080/health
curl --http2 --connect-to api.corefinite.com:443:127.0.0.1:18443 https://api.corefinite.com/health
curl --http3-only --connect-to api.corefinite.com:443:127.0.0.1:18443 https://api.corefinite.com/health
```

The first check must redirect to HTTPS and both HTTPS checks must return
healthy before rollout. Check the active `S3_PUBLIC_ENDPOINT` first: the audited
deployment uses Cloudflare R2 directly for attachments, so those requests do
not pass through this edge. If the legacy MinIO path is enabled, exercise an
authenticated upload/download through `/vaultchat-media`; its signed Host and
path must survive the edge. `--connect-to` preserves the public Host and TLS server name, unlike
changing a signed URL's port. Also check `/internal/*` is denied, legal pages
load, and Socket.IO/CC-Wire WebSocket upgrades and LiveKit signalling routes
still work over TCP. The curl build must list HTTP3 support; the production
host's curl 8.5.0 does not, so it cannot provide the QUIC proof.

The repository includes an HTTP/3-only probe using its existing Go dependency:

```bash
cd vaultchat-backend-go
go run ../scripts/http3-probe.go -connect 127.0.0.1:18443
# From outside the server after UDP/8443 is published:
go run ../scripts/http3-probe.go -connect api.corefinite.com:8443
```

It verifies TLS normally, refuses redirects and TCP fallback, and requires a
2xx HTTP/3 response with negotiated `h3`. Its certificate serial can be used
to check renewal. The loopback command must run on the server; an SSH TCP
tunnel cannot forward QUIC's UDP packets.

## Add HTTP/3 without moving TCP traffic

1. After staging passes, allow UDP/8443 in host and provider firewalls. Preserve
   UDP/443 and its TURN redirect rules.
2. Persist `HTTP3_UDP_BIND=0.0.0.0:8443` in the deployment environment. Leave
   `HTTP3_HTTP_BIND` and `HTTP3_TCP_BIND` at their loopback defaults. Start only
   `h3-edge` with `up -d --no-deps h3-edge` using the three Compose files.
3. Verify HTTP/3 directly from outside the host with an HTTP3-enabled client,
   including an authenticated API request. Verify attachments against the
   configured storage endpoint separately when it is direct R2.
4. Only then add `add_header Alt-Svc 'h3=":8443"; ma=300' always;` to the
   `api.corefinite.com` nginx TLS server block. Diff against the live vhost,
   run `sudo nginx -t`, and gracefully reload nginx. Keep its other hostnames
   and TCP listeners unchanged. Check nested locations do not override header
   inheritance. Increase the five-minute advertisement lifetime only after
   device validation.

For the inspected deployment, run from `/home/srihari/vaultchat-clean` after
persisting the environment setting and installing the reviewed Caddyfile:

```bash
HTTP3_UDP_BIND=0.0.0.0:8443 docker compose -p vaultchat \
  -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.http3.yml \
  up -d --no-deps h3-edge
curl --http3-only --connect-to api.corefinite.com:443:65.21.229.167:8443 \
  https://api.corefinite.com/health
```

Run the curl probe from outside the server using an HTTP3-enabled build. This
keeps the HTTPS origin, Host header and certificate verification on the normal
API hostname while connecting QUIC to UDP/8443. The certificate reload hook
does not change when the published UDP port changes.

Rollback: replace that advertisement with `add_header Alt-Svc 'clear' always;`,
test and reload nginx, then stop only `h3-edge`. Remove its UDP firewall rule
if it was newly added. HTTP/1.1, HTTP/2 and WebSockets continue on nginx during
both rollout and rollback. Never stop the shared nginx service for this change.

## Keep renewed certificates loaded

The edge reads the existing Certbot certificates; it does not manage them.
Mount the whole `/etc/letsencrypt` tree because `live/` contains symlinks into
`archive/`. Extend the existing Certbot deploy hook to run this after renewal,
using the deployment's actual project directory and environment:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.http3.yml \
  exec -T h3-edge caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --force
```

The ready-to-install hook is [http3-certbot-reload.sh](../scripts/http3-certbot-reload.sh).
It targets the inspected Compose project directory `/home/srihari/vaultchat-clean`
and runs only for the API certificate lineage. Install it as an executable
Certbot deploy hook after the edge service exists. Keep the nginx renewal reload too.
`--force` reloads manually loaded
certificates even when configuration text is unchanged. Test the hook and
compare the certificate serial served over TCP and QUIC before rollout.

HTTP/3 support alone does not provide WebTransport. The latter requires a
session endpoint and matching native carrier for CC-Wire. Keep WebTransport
unadvertised until that client/server pair passes interoperability checks;
HTTP and WebSocket clients continue to work independently.

## Validation recorded on 2026-09-15

The live nginx vhost matched the repository. Its build lacks HTTP/3 and serves
multiple unrelated hostnames. The proposed Caddyfile successfully adapted
with the installed Caddy binary via stdin. A temporary Caddy container also
validated it with the real certificates mounted read-only and no published
ports. An isolated Caddy 2.11.4 staging container then passed:

- HTTP/3-only request through loopback UDP/18443: protocol `3`, status `200`,
  TLS verification result `0`.
- HTTP/2 health `200`, HTTP redirect `301`, internal path `404`, privacy `200`.
- Socket.IO WebSocket upgrade `101`; unauthenticated MinIO bucket request
  reached MinIO and returned the expected `403`.
- Forced certificate reload succeeded on the staging container.

The HTTP/3 probe was `ghcr.io/macbre/curl-http3` pinned at
`sha256:c3a360869a4e132180f458f83af2ce67b873b2302739eda27274dad4f62155f8`
(curl 8.17.0-DEV, quiche 0.24.5), run without host-file mounts. The official
curl 8.18.0 container was checked first and lacks HTTP3 support. No production
listeners, flags or nginx configuration changed during those staging checks.
After deploying the UDP edge, a request to the server's public
IP from the host also negotiated HTTP/3 with status200 and verified TLS.
The desktop probe timed out because existing PREROUTING rules redirect external
UDP/443 to TURN/3478. A bounded packet capture confirmed the desktop packets
arrived at the host but did not reach the Docker bridge; the NAT rules explain
why same-host probing succeeded while external probing failed. UDP/8443 was
unused when inspected and is the additive HTTP/3 port. External validation must
be repeated on8443 after deployment; same-host success alone is insufficient.
The active API's private and public S3 endpoints both use R2; the legacy local
MinIO bucket is absent, so no temporary media object was created during its
route check. External UDP reachability and mobile protocol use remain gates
before advertising HTTP/3 to clients.

References: [Caddy proxy behavior](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy),
[Caddy certificate reload](https://caddyserver.com/docs/command-line#caddy-reload).
