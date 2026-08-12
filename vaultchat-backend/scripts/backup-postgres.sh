#!/usr/bin/env bash
# Nightly Postgres backup for VaultChat.
#
# Writes a gzipped pg_dump to BACKUP_DIR, rotates older backups,
# and exits non-zero on any failure (so cron can mail you the output).
#
# Crontab line (root or srihari):
#   30 2 * * * /home/srihari/vaultchat-api/scripts/backup-postgres.sh
#
# Environment (override via .env or systemd unit; defaults sensible for
# the current Hetzner box):
#   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS   (Postgres direct, not PgBouncer)
#   BACKUP_DIR     default: ~/vaultchat-backups
#   BACKUP_KEEP    default: 7 (days to retain)
#   BACKUP_TO_S3   optional: if set, rclone copy each backup to this remote:path

set -euo pipefail

# Load the same .env the app uses so creds match
ENV_FILE="${ENV_FILE:-$HOME/vaultchat-api/.env}"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi

DB_HOST="${DB_HOST:-127.0.0.1}"
# Backups use direct Postgres (5432), not PgBouncer (6432) — pg_dump needs
# session-level features PgBouncer transaction mode doesn't pass through.
BACKUP_PG_PORT="${BACKUP_PG_PORT:-5432}"
DB_NAME="${DB_NAME:-vaultchat}"
DB_USER="${DB_USER:-vaultchat_app}"
DB_PASS="${DB_PASS:?DB_PASS not set; cannot back up}"

BACKUP_DIR="${BACKUP_DIR:-$HOME/vaultchat-backups}"
BACKUP_KEEP="${BACKUP_KEEP:-7}"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/vaultchat-$TS.sql.gz"

echo "[backup] starting $OUT"

# NOTE: this script is NOT the one production cron runs. The live box runs
# /home/srihari/vaultchat-backups/backup.sh (unversioned, dumps from inside the
# postgres container). Both were fixed together; if you change one, change both,
# or better, version the live one and delete this.

# pg_dump custom format for restorability, gzipped for size.
# --no-owner / --no-privileges so the dump restores cleanly into a
# differently-owned DB if needed for disaster recovery.
#
# --exclude-table-data on message_bodies*: message CIPHERTEXT MUST NOT ENTER A
# BACKUP. The whole point of an ephemeral body store is that the server holds
# the ciphertext for hours, not forever — and a nightly full dump kept for 14
# days would quietly restore exactly the long-term archive the design removes.
# The glob covers the hourly partitions as well as the parent; each partition is
# its own table, so `message_bodies` alone would exclude nothing that matters.
#
# SCHEMA is still dumped (this excludes DATA only), so a restore rebuilds the
# table and its partitions empty — which is the correct disaster-recovery
# outcome: conversations resume, undelivered bodies are lost, and no historical
# message content is resurrected.
#
# NOT YET COVERED: messages.content still holds ciphertext for messages written
# before the body store existed, and that column IS in this dump. It stops being
# true when the contract migration drops the column; until then this exclusion
# bounds NEW content only. Said plainly rather than claimed clean.
PGPASSWORD="$DB_PASS" pg_dump \
  --host="$DB_HOST" --port="$BACKUP_PG_PORT" \
  --username="$DB_USER" --dbname="$DB_NAME" \
  --no-owner --no-privileges \
  --exclude-table-data='message_bodies*' \
  --format=plain \
  | gzip -9 > "$OUT"

# Sanity check: dump must be > 1 KB or something is wrong
size=$(stat -c '%s' "$OUT")
if (( size < 1024 )); then
  echo "[backup] FAIL: $OUT is suspiciously small ($size bytes)" >&2
  exit 1
fi

echo "[backup] wrote $OUT ($size bytes)"

# Rotate: delete dumps older than BACKUP_KEEP days
find "$BACKUP_DIR" -maxdepth 1 -name 'vaultchat-*.sql.gz' -type f -mtime "+$BACKUP_KEEP" -print -delete

# Optional: ship off-box via rclone (Backblaze B2, Wasabi, S3, etc.)
# Configure rclone separately: `rclone config` then point BACKUP_TO_S3
# at a configured remote like 'b2:vaultchat-backups/'.
if [[ -n "${BACKUP_TO_S3:-}" ]]; then
  if command -v rclone >/dev/null 2>&1; then
    echo "[backup] copying off-box to $BACKUP_TO_S3"
    rclone copy "$OUT" "$BACKUP_TO_S3"
  else
    echo "[backup] WARN: BACKUP_TO_S3 set but rclone not installed" >&2
  fi
fi

echo "[backup] done"
