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
U=$(docker exec "$C" printenv POSTGRES_USER)
D=$(docker exec "$C" printenv POSTGRES_DB)
OUT="$DIR/vaultchat-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
docker exec "$C" pg_dump -U "$U" -d "$D" --no-owner --clean --if-exists \
  --exclude-table-data="message_bodies*" | gzip > "$OUT"
# A dump that cannot be read back is not a backup. Verify before rotating, and
# keep the bad file for inspection rather than deleting evidence.
if ! gzip -t "$OUT" 2>/dev/null || [ "$(zcat "$OUT" | grep -c '^CREATE TABLE')" -lt 10 ]; then
  echo "[backup] FAILED verification: $OUT" >&2
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
GOAPI=vaultchat-go-api-1

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
  local envf; envf=$(mktemp); chmod 600 "$envf"
  local rc=0
  {
    echo "RCLONE_CONFIG_R2_TYPE=s3"
    echo "RCLONE_CONFIG_R2_PROVIDER=Cloudflare"
    echo "RCLONE_CONFIG_R2_REGION=auto"
    echo "RCLONE_CONFIG_R2_ENDPOINT=$(docker exec $GOAPI printenv VAULTBEAM_S3_ENDPOINT)"
    echo "RCLONE_CONFIG_R2_ACCESS_KEY_ID=$(docker exec $GOAPI printenv VAULTBEAM_S3_ACCESS_KEY)"
    echo "RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=$(docker exec $GOAPI printenv VAULTBEAM_S3_SECRET_KEY)"
  } > "$envf" || rc=1

  local bucket; bucket=$(docker exec $GOAPI printenv VAULTBEAM_S3_BUCKET) || rc=1

  if [ $rc -eq 0 ]; then
    docker run --rm --env-file "$envf" -v "$DIR:/data:ro" rclone/rclone:latest \
      copy "/data/$(basename "$enc")" "R2:$bucket/$REMOTE_PREFIX/" \
      --s3-no-check-bucket --retries 3 >/dev/null 2>&1 || rc=1
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
else
  # Loud, but deliberately NOT fatal. The local dump above is already written
  # and verified; failing here would make a good backup look like a failed one,
  # and the next run's prune would eventually delete it.
  echo "[backup] WARNING: off-site copy FAILED — this backup exists only on this box" >&2
fi

find "$DIR" -name 'vaultchat-*.sql.gz' -mtime +$KEEP -delete
