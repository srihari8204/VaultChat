#!/usr/bin/env bash
# RETIRED. Do not use.
#
# This script copied files into /home/srihari/vaultchat, which is a STALE
# checkout: the live stack runs from /home/srihari/vaultchat-clean under compose
# project "vaultchat", and is deployed by scripts/deploy.sh from your machine
# (fingerprint gate, backup, automatic rollback). See the header of that script.
#
# To deploy microservices-prepare, from a clean checkout of hetzner-deploy:
#
#   SKIP_MIGRATIONS=1 bash scripts/deploy.sh     # code only, migration 139 deferred
#   bash scripts/deploy.sh                       # code and migration 139
echo "deploy/microservices-prepare.sh is retired: deploy with scripts/deploy.sh from your machine (see this file's header)." >&2
exit 1
