# CC-Wire recovery deployment preparation

Prepared a second immutable release using `scripts/ccwire-recovery-rollout-20260915.sh` and `scripts/ccwire-recovery-rollback-20260915.sh`. No rollout was executed by this worker. This is deployment preparation for the separately owned sync-cursor fix, not approval of its behavior or a claim of device recovery.

The expected live baseline is source `a87ebdea3825f347`, image `sha256:6ddc275824d8c67e15216517442c872cadefaffb7d081ecbe3a2d99cbe36c0fc`, retained tag `vaultchat-go-api:ccwire-events-20260915`. The script refuses mismatched live source/image or an overlay list different from the existing seven: base, prod, box, ccwire, transport-20260915, webtransport, ccwire-events-20260915.

Root supplies the newly reviewed source fingerprint as the rollout argument after building/testing candidate `vaultchat-go-api:ccwire-recovery-20260915` from `/home/srihari/vaultchat-checkpoints/ccwire-recovery-20260915/source`. The release snapshots source and rollback state privately under `/home/srihari/vaultchat-releases/ccwire-recovery-20260915` and adds `docker-compose.ccwire-recovery-20260915.yml` as the eighth and final overlay.

Both candidate and rollback preserve `CCWIRE_WS=1`, `CCWIRE_WEBTRANSPORT=1`, `CCWIRE_APP_EVENTS=1` and `REDIS_ADAPTER=1`. Rollback restores the currently deployed events image and original source context, rather than returning to the older pre-migration build. The same lock, immutable image pinning, effective configuration comparison, automatic rollback, direct/public build/health/readiness/DB/Redis/authentication checks and `go-api`-only recreation from the reviewed events rollout remain in place.

No schema migration, database sequence modification, phone data modification or other-service restart is included. Subsequent Compose commands must include the eighth override, including after rollback.

Validation: both Bash files passed `bash -n`; both embedded Python blocks parsed successfully; static assertions checked baseline source, seven inherited overlays, enabled rollback flags and single-service restart. Runtime candidate checks and actual rollout remain with the coordinating agent.
