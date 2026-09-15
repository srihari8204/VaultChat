# Audit 07: deployment and rollback

Read-only SSH verified project `vaultchat` currently runs image `sha256:89ace3408b270ab825350d77c45d1d1c87f45e33f64d90244dfe3fe340700226`, with `CCWIRE_WS=1`, `CCWIRE_WEBTRANSPORT=1`, `REDIS_ADAPTER=1` and no app-event flag. Its exact Compose order is base, prod, box, ccwire, transport-20260915, webtransport. The old transport rollout omits the last two and explicitly disables WebTransport, so it must not be reused.

Prepared `scripts/ccwire-events-rollout-20260915.sh` and `scripts/ccwire-events-rollback-20260915.sh`. These scripts have NOT been executed for deployment.

The rollout accepts the reviewed 16-character source fingerprint as its only argument, expects source in `/home/srihari/vaultchat-checkpoints/ccwire-events-20260915/source` and image tag `vaultchat-go-api:ccwire-events-20260915`. Root must build and test that image first. The script refuses baseline image, source or overlay-list drift and refuses to overwrite an existing release attempt. It preserves all six overlays and adds `docker-compose.ccwire-events-20260915.yml` last.

The candidate overlay pins the immutable image ID and durable source copy and enables app events while retaining WSS, WebTransport and the Redis adapter. A private resolved-Compose comparison requires every other service and API property to remain identical. Only `go-api` is recreated, with `--no-deps --no-build --pull never`. There are no database migrations or other service restarts.

Before and after the switch, direct loopback and public HTTPS checks require DB/Redis health, readiness, the expected source fingerprint and unauthenticated CC-Wire rejection. Failure after the override is installed attempts automatic rollback. Rollback pins the retained image and its original build context, preserves all six overlays, turns app events off and verifies the old build and health. It uses the same deployment lock.

The private release directory stores original overlays and exact image/source IDs for review and rollback. Protected Compose files mean the final command needs an authorized privileged shell. No credentials are requested by these scripts or printed. Include the seventh override in subsequent Compose commands. HTTP/3 and authenticated WebTransport protocol tests and both-device messaging remain separate required integration checks; HTTP health alone does not prove those transports work.
