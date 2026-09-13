#!/usr/bin/env bash
# Nightly Postgres backup. Dumps INSIDE the container over the local socket, so
# it needs no password and cannot be broken by DB_HOST/DB_PORT drift — the old
# cron pointed at a script path that no longer existed (project renamed from
# vaultchat-api to vaultchat) and had been failing silently, leaving the
# database with NO backups at all.
#
# THIS FILE IS THE ONE THAT RUNS. It is installed at
# /home/srihari/vaultchat-backups/backup.sh and driven by srihari's crontab:
#   30 2 * * * /home/srihari/vaultchat-backups/backup.sh >> .../backup.log 2>&1
# It lives here so the repo can rebuild the box. Diff before editing either copy.
#
# MESSAGE CIPHERTEXT IS EXCLUDED (migration 099).
# ----------------------------------------------
# message_bodies holds the encrypted message payloads and is deliberately
# ephemeral: hourly partitions, reclaimed on delivery ACK, hard-capped at three
# hours. A nightly full dump retained for 14 days would quietly recreate exactly
# the permanent message archive that design removes — so the dump takes the
# SCHEMA of those tables and none of their rows.
#
# The glob matters: each hourly partition is its own table, so plain
# `message_bodies` would exclude the (always empty) parent and back up every
# partition underneath it.
#
# A restore therefore rebuilds message_bodies empty. That is the intended
# disaster-recovery outcome — conversations, membership, keys and delivery state
# all return; in-flight undelivered bodies do not, and no historical message
# content is resurrected.
#
# NOT YET COVERED: messages.content still holds ciphertext for rows written
# before the body store existed, and that column IS still in this dump. It stops
# being true when the contract migration drops the column.
set -euo pipefail
DIR=/home/srihari/vaultchat-backups
KEEP=14

# Run from a directory this user can actually read. Every path below is
# absolute, so the cwd is irrelevant to the work — but `find` restores its
# initial working directory when it finishes, and if that directory is
# unreadable (running as srihari from /root, say) it exits non-zero AFTER a
# perfectly good backup and upload, making a successful run look like a failure.
cd "$DIR"
C=vaultchat-postgres-1
GOAPI=vaultchat-go-api-1

U=$(docker exec "$C" printenv POSTGRES_USER)
D=$(docker exec "$C" printenv POSTGRES_DB)

# ALERTING. Every failure below used to end its life as a line in a log file
# nobody reads. On this box that is the same as silence: there is no MTA, so
# cron cannot mail a failure either, however loudly the script exits.
#
# Sentry is the alerting path that ALREADY EXISTS here and already reaches a
# person — the API container carries SENTRY_DSN and backend errors go there
# today. Prometheus and Grafana also run on this box but have no alert rules,
# no Alertmanager and no contact point; they are dashboards, not an alert path,
# so using them would have meant building one from scratch.
#
# Best-effort by design: if Sentry is unreachable the backup must still run and
# still rotate. The exit code and the BACKUP_ALERT log token are the fallbacks.
alert() {
  local dsn key rest host proj
  dsn=$(docker exec $GOAPI printenv SENTRY_DSN 2>/dev/null) || return 0
  [ -n "$dsn" ] || return 0
  key=${dsn#*//}; key=${key%%@*}
  rest=${dsn#*@}; host=${rest%%/*}; proj=${rest##*/}
  curl -sf -m 15 -o /dev/null -X POST "https://$host/api/$proj/store/" \
    -H "Content-Type: application/json" \
    -H "X-Sentry-Auth: Sentry sentry_version=7, sentry_key=$key, sentry_client=vaultchat-backup/1" \
    -d "{\"event_id\":\"$(head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n')\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%S)\",\"platform\":\"other\",\"level\":\"error\",\"logger\":\"backup.sh\",\"server_name\":\"$(hostname)\",\"message\":{\"formatted\":\"$1\"},\"tags\":{\"component\":\"db-backup\"}}" \
    || echo "[backup] BACKUP_ALERT could not reach Sentry to report the failure above" >&2
}

OUT="$DIR/vaultchat-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
docker exec "$C" pg_dump -U "$U" -d "$D" --no-owner --clean --if-exists \
  --exclude-table-data="message_bodies*" | gzip > "$OUT"
# A dump that cannot be read back is not a backup. Verify before rotating, and
# keep the bad file for inspection rather than deleting evidence.
if ! gzip -t "$OUT" 2>/dev/null || [ "$(zcat "$OUT" | grep -c '^CREATE TABLE')" -lt 10 ]; then
  echo "[backup] BACKUP_ALERT FAILED verification: $OUT" >&2
  alert "[backup] BACKUP_ALERT dump failed verification on $(hostname) — $OUT kept as .BAD"
  mv "$OUT" "$OUT.BAD"
  exit 1
fi
echo "[backup] ok $(du -h "$OUT" | cut -f1) $OUT"

# ─────────────────────────────────────────────────────────────────────
# OFF-SITE COPY — encrypted, to Cloudflare R2
# ─────────────────────────────────────────────────────────────────────
# Until this existed, every backup sat on the same disk as the database it was
# backing up. That is not a backup, it is a second copy inside the same failure
# domain: one dead box loses the data AND every restore point.
#
# R2 rather than a new provider because VaultBeam already ships attachments
# there — the box already holds working credentials, so there is no new account,
# no new bill and no new secret to rotate. Backups live under their own prefix.
#
# ENCRYPTED BEFORE IT LEAVES. The dump carries identities, group membership,
# device keys and delivery state — everything except message bodies. Handing
# that to a third party in the clear would undo much of what the E2EE work is
# for. AES-256 via openssl; the passphrase never leaves this machine.
#
# ⚠️ THE PASSPHRASE IS STORED AT $KEYFILE — ON THIS BOX, the very thing the
# off-site copy exists to survive. If the box dies you will hold ciphertext in
# R2 and no way to read it. The script prints it ONCE, on creation. Put it in a
# password manager then.
KEYFILE="$DIR/.offsite-key"
REMOTE_PREFIX="db-backups"

if [ ! -f "$KEYFILE" ]; then
  ( umask 077; openssl rand -base64 48 > "$KEYFILE" )
  echo "[backup] ================== SAVE THIS NOW =================="
  echo "[backup] Generated the off-site backup passphrase at $KEYFILE"
  echo "[backup] Without a copy held OFF THIS BOX the R2 backups are unreadable:"
  echo "[backup]"
  echo "[backup]   $(cat "$KEYFILE")"
  echo "[backup]"
  echo "[backup] ==================================================="
fi

offsite() {
  command -v docker >/dev/null 2>&1 || { echo "[backup] docker missing; skipping off-site" >&2; return 1; }
  local enc="$OUT.enc"
  openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$KEYFILE" -in "$OUT" -out "$enc" || return 1

  # Credentials are read out of the running API container and handed to rclone
  # through a 0600 env-file — never on a command line, where `ps` would show
  # them to every user on the box for the life of the upload.
  #
  # WHY S3_* AND NOT VAULTBEAM_S3_* (broke 2026-09-06, fixed 2026-09-13).
  # On 2026-09-06 the Cloudflare R2 API token behind VAULTBEAM_S3_ACCESS_KEY /
  # VAULTBEAM_S3_SECRET_KEY was rejected for EVERY operation — the token itself
  # died, it was not a bucket policy. That outage got noticed because media
  # uploads started returning 502, and it was fixed by minting a fresh token and
  # updating S3_ACCESS_KEY / S3_SECRET_KEY. Nothing updated the VAULTBEAM_* pair,
  # and this script was its only remaining consumer — so every off-site copy from
  # the 2026-09-07 run onward got a flat 401 Unauthorized. Seven nights of dumps
  # that existed nowhere but this box.
  #
  # The BUCKET deliberately stays VAULTBEAM_S3_BUCKET (vaultchat-beam) — that is
  # where the existing history lives. S3_BUCKET is vaultchat-media; pointing at
  # it would split the backup set across two buckets and strand everything
  # already uploaded. Keys and bucket come from different variables ON PURPOSE.
  # Do not "tidy" this into a single prefix.
  local envf; envf=$(mktemp); chmod 600 "$envf"
  local rc=0
  {
    echo "RCLONE_CONFIG_R2_TYPE=s3"
    echo "RCLONE_CONFIG_R2_PROVIDER=Cloudflare"
    echo "RCLONE_CONFIG_R2_REGION=auto"
    echo "RCLONE_CONFIG_R2_ENDPOINT=$(docker exec $GOAPI printenv S3_ENDPOINT)"
    echo "RCLONE_CONFIG_R2_ACCESS_KEY_ID=$(docker exec $GOAPI printenv S3_ACCESS_KEY)"
    echo "RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=$(docker exec $GOAPI printenv S3_SECRET_KEY)"
  } > "$envf" || rc=1

  local bucket; bucket=$(docker exec $GOAPI printenv VAULTBEAM_S3_BUCKET) || rc=1

  if [ $rc -eq 0 ]; then
    # Keep rclone's own error. The old `>/dev/null 2>&1` is what turned a
    # one-line "401 Unauthorized" into an archaeology session: for seven nights
    # the log said the copy FAILED and never once said why.
    local err
    err=$(docker run --rm --env-file "$envf" -v "$DIR:/data:ro" rclone/rclone:latest \
      copy "/data/$(basename "$enc")" "R2:$bucket/$REMOTE_PREFIX/" \
      --s3-no-check-bucket --retries 3 2>&1) || rc=1
    [ $rc -eq 0 ] || echo "[backup] rclone: $(printf '%s' "$err" | grep -i 'error' | tail -1)" >&2
  fi
  # Prune remote copies on the same clock as local retention, so R2 does not
  # quietly accumulate forever. Only after a successful upload — a failed run
  # must never be the thing that deletes old backups.
  if [ $rc -eq 0 ]; then
    docker run --rm --env-file "$envf" rclone/rclone:latest \
      delete "R2:$bucket/$REMOTE_PREFIX/" --min-age "${KEEP}d" >/dev/null 2>&1 || true
  fi

  rm -f "$envf" "$enc"
  return $rc
}

if offsite; then
  echo "[backup] off-site ok  R2:$REMOTE_PREFIX/$(basename "$OUT").enc"
  offsite_rc=0
else
  # BACKUP_ALERT is the greppable token — `grep BACKUP_ALERT backup.log`.
  echo "[backup] BACKUP_ALERT off-site copy FAILED — this backup exists only on this box" >&2
  alert "[backup] BACKUP_ALERT off-site copy FAILED on $(hostname) — the nightly vaultchat DB backup exists only on that box"
  offsite_rc=1
fi

# Retention runs either way, and BEFORE the exit below. The previous version
# swallowed the off-site failure and returned 0 specifically so this prune would
# still happen; keeping the prune here and putting the failure in the exit code
# gets both — old local dumps are still rotated, and a failed run still reports
# itself as failed instead of looking like a clean night.
find "$DIR" -name 'vaultchat-*.sql.gz' -mtime +$KEEP -delete

# Exit non-zero so the run is a failure to anything that checks — a human
# running it by hand, and any supervisor that ever wraps it.
exit $offsite_rc
