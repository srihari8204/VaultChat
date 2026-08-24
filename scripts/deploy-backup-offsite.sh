#!/usr/bin/env bash
#
# Install the backup script that keeps an encrypted off-site copy in R2.
#
# Until now every backup lived on the same disk as the database, which means one
# dead box lost the data and every restore point with it.
#
# THE PASSPHRASE IS NEVER PRINTED BY THIS SCRIPT. It is generated on the box
# before the first run, so the backup script's own "SAVE THIS NOW" branch never
# fires and the secret never reaches a terminal, a log, or an agent transcript.
# Read it yourself, once, with the command printed at the end.
#
# Usage:  bash scripts/deploy-backup-offsite.sh
set -euo pipefail
HOST="${VAULTCHAT_PROD_HOST:-root@65.21.229.167}"
DIR=/home/srihari/vaultchat-backups
LIVE="$DIR/backup.sh"
SRC=vaultchat-backend/scripts/backup-postgres.sh
STAMP=$(date +%Y%m%d-%H%M%S)
say(){ printf '\n\033[1m== %s\033[0m\n' "$1"; }
ok(){  printf '\033[32m  ok\033[0m   %s\n' "$1"; }
die(){ printf '\n\033[31mABORT: %s\033[0m\n' "$1" >&2; exit 1; }

[ -f "$SRC" ] || die "$SRC not found — run from the repo root"

say "Backing up the live script"
ssh "$HOST" "cp $LIVE /tmp/backup.sh.$STAMP.bak && echo '  /tmp/backup.sh.$STAMP.bak'"

say "Installing"
scp -q "$SRC" "$HOST:/tmp/backup.sh.new"
ssh "$HOST" "install -o srihari -g srihari -m 0755 /tmp/backup.sh.new $LIVE && rm -f /tmp/backup.sh.new && echo '  installed as srihari:srihari 0755'"

say "Pre-creating the passphrase (silently — never printed here)"
ssh "$HOST" "test -f $DIR/.offsite-key || (umask 077; openssl rand -base64 48 > $DIR/.offsite-key); \
             chown srihari:srihari $DIR/.offsite-key; chmod 600 $DIR/.offsite-key; \
             echo \"  \$(stat -c '%U:%G %a' $DIR/.offsite-key) $DIR/.offsite-key\""

say "Test run (real backup + real upload)"
# Runs as srihari, exactly as cron will. Anything that only works as root is a
# bug that must surface now, not at 02:30 tomorrow.
#
# `cd $DIR` first: sudo keeps root's cwd of /root, which srihari cannot read,
# and find would then exit non-zero while restoring it — reporting failure after
# a backup and upload that both succeeded.
ssh "$HOST" "cd $DIR && sudo -u srihari $LIVE" || die "test run failed — restore with: cp /tmp/backup.sh.$STAMP.bak $LIVE"

say "Confirming the object actually landed in R2"
ssh "$HOST" '
  set -e
  G=vaultchat-go-api-1
  envf=$(mktemp); chmod 600 "$envf"
  {
    echo "RCLONE_CONFIG_R2_TYPE=s3"
    echo "RCLONE_CONFIG_R2_PROVIDER=Cloudflare"
    echo "RCLONE_CONFIG_R2_REGION=auto"
    echo "RCLONE_CONFIG_R2_ENDPOINT=$(docker exec $G printenv VAULTBEAM_S3_ENDPOINT)"
    echo "RCLONE_CONFIG_R2_ACCESS_KEY_ID=$(docker exec $G printenv VAULTBEAM_S3_ACCESS_KEY)"
    echo "RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=$(docker exec $G printenv VAULTBEAM_S3_SECRET_KEY)"
  } > "$envf"
  B=$(docker exec $G printenv VAULTBEAM_S3_BUCKET)
  docker run --rm --env-file "$envf" rclone/rclone:latest ls "R2:$B/db-backups/" | tail -5
  rm -f "$envf"
' || die "could not list R2 — upload may not have landed"

say "Done."
cat <<'NOTE'
  ONE MANUAL STEP LEFT, and the off-site copy is worthless without it.

  The passphrase sits at /home/srihari/vaultchat-backups/.offsite-key — on the
  box the backup exists to survive. Read it and put it in a password manager:

    ssh root@65.21.229.167 'cat /home/srihari/vaultchat-backups/.offsite-key'

  To restore from an off-site copy later:

    openssl enc -d -aes-256-cbc -pbkdf2 -pass file:<keyfile> \
      -in vaultchat-<stamp>.sql.gz.enc | gunzip | psql -U vaultchat -d vaultchat
NOTE
