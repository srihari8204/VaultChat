# Docker disk and RAM cleanup — 2026-09-21

Completed on the local Windows laptop. The Docker data disk decreased from **246.09 GiB to 36.38 GiB**, reclaiming **209.71 GiB** after a successful verification restart. C: now has **219.50 GiB free**. Final available RAM was approximately **7.1 GiB**, with Docker stopped. No production server changes were made.

| Measurement | Before final compaction | After compaction and verification restart |
| --- | ---: | ---: |
| Docker data VHDX | 264,240,103,424 bytes | 39,063,650,304 bytes |
| C: free | 10,523,852,800 bytes | 235,686,551,552 bytes |
| Images / containers / volumes | 43 / 43 / 46 | 43 / 43 / 46 |
| Docker guest filesystem used | 219.5 GiB before log cleanup | 31.1 GiB |

These are sequential observations; other host activity affects free-space/RAM deltas. The earlier RAM gain also includes stopping the completed APK build's idle Gradle daemon.

## Cause and fix

The stopped local `vaultchat-go-api-1` container had a **202,364,462,254-byte JSON log (188.47 GiB)** and no log rotation. All container JSON logs together occupied about 189.10 GiB. Database volumes were not the cause.

Preserved the latest 2,000 diagnostic lines (124,000 bytes) privately outside Git using `docker logs`. Added native Docker `json-file` rotation to the `go-api` service in `docker-compose.yml`: `max-size: "10m"`, `max-file: "3"`.

Recreated only that stopped service with `--no-start --no-deps --no-build --pull never --force-recreate`, using its existing image and preserving its exact environment and upload bind mount. A private temporary Compose override retained the old environment rather than introducing two newer configuration keys during maintenance. Container identity changed; image, environment and mounts were verified equivalent. The replacement remains stopped (`created`), as the original service was stopped. Docker removed the oversized old log through normal container recreation; no direct log truncation or container-directory deletion was used.

Trimmed unused blocks on the verified Docker filesystem and stopped Docker gracefully. Normal Windows UAC approval enabled Microsoft DiskPart's offline `compact vdisk` on the exact detached Docker VHDX. Final compaction succeeded at 15:01:46 IST, reducing its file by 225,184,841,728 bytes. Restarted Docker successfully afterward and verified all 43 images, 43 containers, 46 volumes, and the new log-rotation configuration. Guest disk usage remained 31.1 GiB. Docker was then stopped again to release RAM. This was engine/inventory/config verification; service healthcheck grace periods and application transactions were not exercised.

## RAM configuration

Created the previously absent `C:\Users\Dell\.wslconfig`:

```ini
[wsl2]
memory=4GB

[experimental]
autoMemoryReclaim=gradual
```

The fresh WSL VM reported `MemTotal: 4009596 kB`, consistent with the configured cap. This setting applies to the WSL VM, not individual containers. Removing this newly created file restores the former defaults. Open Docker Desktop when local containers are needed; the previously stopped Go API remains stopped.

## Earlier attempts and evidence

Initially, 80 unused build-cache records were removed (Docker accounting: 5.314 GB), without reducing Windows disk allocation. The first offline compaction reclaimed only 2 MiB. Filesystem inspection then identified the runaway log, enabling the final result above. No database volume, tagged image or unrelated container was deleted. Docker's existing settings were backed up and otherwise preserved.

Sanitized evidence:

- `design/ui-audit/docker-resource-cleanup.json`: phase history, measurements and final state.
- `design/ui-audit/docker-offline-compaction-final.json`: exact DiskPart before/after bytes and successful exit.
- `design/ui-audit/docker-go-api-log-recovery.json`: replacement identity, preserved image/environment/mounts and rotation.
- `design/ui-audit/docker-post-compaction-verification.json`: successful engine restart and retained inventory.

The recent diagnostics and environment backup remain private under `../deployment-snapshots/glass-ui-20260921/docker-compaction/`; they are not in repository evidence. Original Docker settings backup: `%TEMP%/docker-resource-dec697b9badc431bb0736cf3837a9e95/settings-store.json`.

References: [Microsoft offline compaction](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/compact-vdisk), [Docker JSON log rotation](https://docs.docker.com/engine/logging/drivers/json-file/), [WSL configuration](https://learn.microsoft.com/en-us/windows/wsl/wsl-config).
