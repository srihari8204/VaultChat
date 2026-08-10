#!/usr/bin/env bash
#
# VaultChat server hardening — findings from the 2026-08-10 audit.
#
# Run on the host as `srihari`:
#     bash server-hardening-2026-08-10.sh            # dry run: prints, changes nothing
#     APPLY=1 bash server-hardening-2026-08-10.sh    # actually apply
#
# Steps are independent. Set SKIP_<n>=1 to skip one, e.g. SKIP_5=1.
#
# DISRUPTION
#   steps 1-3  none. Firewall rules and a boot unit; no service is touched.
#   step 4     none. Redis maxmemory is set live; the compose edit only takes
#              effect at the next restart, which this script does NOT do.
#   step 5     RESTARTS COTURN. Any in-progress relayed call drops and has to
#              reconnect. There were 0 allocations in the 10 min before the
#              audit, so run it when nobody is on a call.
#
# Step 3 is the one that matters most. The six DOCKER-USER rules protecting
# Postgres, Redis, MinIO and Kafka exist ONLY in the live kernel table — there
# is no iptables-persistent, no /etc/iptables/rules.v4, no unit. They have
# survived because the box has 54 days of uptime. A reboot drops all of them
# and exposes every one of those ports to the internet.

set -uo pipefail

APPLY="${APPLY:-0}"
DIR=/home/srihari/vaultchat
IFACE=enp7s0

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
run()  { if [ "$APPLY" = "1" ]; then eval "$@"; else echo "   [dry-run] $*"; fi; }
ok()   { printf '   \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '   \033[33m!\033[0m %s\n' "$*"; }

[ "$APPLY" = "1" ] || echo "DRY RUN — nothing will change. Re-run with APPLY=1 to apply."

# Cache the sudo credential once so each step does not re-prompt.
sudo -v || { echo "need sudo"; exit 1; }

# ─────────────────────────────────────────────────────────────────────────
# 1. MinIO console (19001) answers the public internet.
#
# Verified from off-host: `curl http://65.21.229.167:19001` returns 200.
# The six sibling ports (8090, 14000, 19000, 19092, 15432, 16379) all have
# DOCKER-USER drops and are confirmed closed; 19001 was simply missed.
#
# Credentials are strong (32-char secret, root user `vaultchat`, not default)
# so this is not an active breach — but an admin console should not be
# reachable. The app never uses 19001: S3 traffic is 19000 on the internal
# docker network, and egress writes over that same network.
# ─────────────────────────────────────────────────────────────────────────
if [ "${SKIP_1:-0}" != 1 ]; then
  say "1. Drop public access to the MinIO console (19001)"
  if sudo iptables -C DOCKER-USER -i "$IFACE" -p tcp -m conntrack --ctorigdstport 19001 -j DROP 2>/dev/null; then
    ok "rule already present"
  else
    run "sudo iptables -I DOCKER-USER -i $IFACE -p tcp -m conntrack --ctorigdstport 19001 -j DROP"
    ok "console dropped at the edge"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────
# 2. TURN over UDP 443.
#
# CORRECTION: the audit first reported this as missing. It was already
# deployed, as a nat REDIRECT on both v4 and v6, and the rule counters prove it
# was carrying traffic (152 packets when checked). The audit looked for a
# LISTENER — turnserver.conf, the container CMD, ufw, `ss` bindings — and a
# REDIRECT binds nothing, so it is invisible to every one of those. Check
# `iptables -t nat -L PREROUTING -v -n` instead.
#
# What was genuinely missing is persistence: those rules lived only in the
# kernel table, like everything else in step 3, so a reboot would have removed
# TURN-over-443 on both families. This step is therefore now a no-op on a live
# box (the -C check finds the rule) and its real value is that step 3 re-adds
# it at boot.
#
# WHY A REDIRECT RATHER THAN A SECOND LISTENER
# coturn's `alt-listening-port` is for RFC 5780 CHANGE-REQUEST probing, not for
# serving a second port — using it here would not do what it looks like it does.
# Genuinely listening on 443 means a second coturn instance or a config change
# plus a restart. A REDIRECT is one rule, needs no restart, and is transparent
# to coturn: the packet arrives on 3478 and is answered from the same socket
# clients already use.
#
# nginx owns TCP 443; UDP 443 was confirmed free (nothing bound).
# ─────────────────────────────────────────────────────────────────────────
if [ "${SKIP_2:-0}" != 1 ]; then
  say "2. TURN over UDP 443 (redirect to 3478 — no coturn restart)"
  if sudo iptables -t nat -C PREROUTING -i "$IFACE" -p udp --dport 443 -j REDIRECT --to-ports 3478 2>/dev/null; then
    ok "redirect already present"
  else
    run "sudo iptables -t nat -I PREROUTING -i $IFACE -p udp --dport 443 -j REDIRECT --to-ports 3478"
    ok "UDP 443 -> 3478"
  fi
  run "sudo ufw allow 443/udp"
  warn "the app must offer turn:turn.corefinite.com:443?transport=udp for this to be used"
fi

# ─────────────────────────────────────────────────────────────────────────
# 3. Make the firewall rules survive a reboot.  <-- the important one
#
# A boot-time unit is used rather than iptables-persistent on purpose. Saving
# and restoring the whole table with iptables-save/restore races Docker, which
# rewrites its own chains on every start; restoring a snapshot that contains
# Docker's generated rules can clash with the ones Docker creates itself. This
# unit only ever re-adds OUR rules, idempotently (-C before -I), after Docker
# is up — so it cannot conflict with Docker's own chain management.
# ─────────────────────────────────────────────────────────────────────────
if [ "${SKIP_3:-0}" != 1 ]; then
  say "3. Persist the firewall rules across reboot"

  if [ "$APPLY" = "1" ]; then
    sudo tee /usr/local/sbin/vaultchat-firewall.sh >/dev/null <<'SCRIPT'
#!/usr/bin/env bash
# Re-apply VaultChat's edge drops after Docker has created its chains.
# Idempotent: every rule is checked before it is added.
set -u
IFACE=enp7s0
add() {  # add <table> <chain> <rule...>
  local t=$1 c=$2; shift 2
  iptables -t "$t" -C "$c" "$@" 2>/dev/null || iptables -t "$t" -I "$c" "$@"
}
add6() { # same, for ip6tables
  local t=$1 c=$2; shift 2
  ip6tables -t "$t" -C "$c" "$@" 2>/dev/null || ip6tables -t "$t" -I "$c" "$@"
}
# Container ports that must never be reachable from the internet.
for p in 8090 14000 19000 19001 19092 15432 16379; do
  add filter DOCKER-USER -i "$IFACE" -p tcp -m conntrack --ctorigdstport "$p" -j DROP
done
# TURN over UDP 443 for restrictive networks.
#
# This is a REDIRECT, not a listener — coturn binds only 3478/5349, so nothing
# shows up in `ss` and turnserver.conf says nothing about 443. That invisibility
# is exactly why the 2026-08-10 audit wrongly reported the feature as missing:
# every check looked for a listener. The rule counters are the evidence that it
# works, so check those (`iptables -t nat -L PREROUTING -v -n`) and not `ss`.
#
# BOTH families are required. coturn serves IPv6 (--external-ip carries the v6
# literal) and the original deployment redirected v6 as well; re-adding only the
# v4 rule here would have quietly dropped IPv6 TURN-over-443 at the next reboot.
add  nat PREROUTING -i "$IFACE" -p udp --dport 443 -j REDIRECT --to-ports 3478
add6 nat PREROUTING -i "$IFACE" -p udp --dport 443 -j REDIRECT --to-ports 3478
SCRIPT
    sudo chmod 755 /usr/local/sbin/vaultchat-firewall.sh

    sudo tee /etc/systemd/system/vaultchat-firewall.service >/dev/null <<'UNIT'
[Unit]
Description=VaultChat edge firewall rules
# Docker flushes and rebuilds DOCKER-USER on start, so this must run after it.
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/vaultchat-firewall.sh

[Install]
WantedBy=multi-user.target
UNIT
    sudo systemctl daemon-reload
    sudo systemctl enable --now vaultchat-firewall.service
    ok "unit installed and enabled"
    sudo systemctl is-active vaultchat-firewall.service
  else
    echo "   [dry-run] write /usr/local/sbin/vaultchat-firewall.sh (7 drops + the UDP 443 redirect)"
    echo "   [dry-run] write /etc/systemd/system/vaultchat-firewall.service (After=docker.service)"
    echo "   [dry-run] systemctl enable --now vaultchat-firewall.service"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────
# 4. Give Redis a memory ceiling.
#
# maxmemory=0 with noeviction means Redis grows until the kernel OOM-kills it,
# taking signalling and rate limiting with it. Currently only 1.88 MB across 2
# keys, so this is latent rather than active — but viewer sets and rate-limit
# keys are exactly the sort that grow with traffic.
#
# volatile-lru, NOT allkeys-lru: Redis here is a store, not a pure cache (AOF
# is on). volatile-lru only ever evicts keys that carry a TTL — the rate-limit
# and viewer-count ephemera — and never touches a key without one.
#
# CONFIG SET applies immediately with no restart. CONFIG REWRITE is deliberately
# NOT attempted: the container runs `redis-server --appendonly yes` with no
# config file, so there is nothing to rewrite and it would fail. Surviving a
# restart needs the compose change below, which is left to apply at the next
# planned restart so that nothing goes down now.
# ─────────────────────────────────────────────────────────────────────────
if [ "${SKIP_4:-0}" != 1 ]; then
  say "4. Redis memory ceiling (live, no restart)"
  run "docker exec vaultchat-redis-1 redis-cli CONFIG SET maxmemory 2gb"
  run "docker exec vaultchat-redis-1 redis-cli CONFIG SET maxmemory-policy volatile-lru"
  if [ "$APPLY" = "1" ]; then
    echo -n "   now: "; docker exec vaultchat-redis-1 redis-cli CONFIG GET maxmemory </dev/null | tail -1
  fi
  warn "NOT persisted — this reverts on the next redis restart."
  warn "At the next planned restart, change the redis command in $DIR/docker-compose.yml to:"
  echo  "     command: redis-server --appendonly yes --maxmemory 2gb --maxmemory-policy volatile-lru"
fi

# ─────────────────────────────────────────────────────────────────────────
# 5. Widen the TURN relay port range.   *** RESTARTS COTURN ***
#
# min-port=49160 max-port=49200 is 41 ports, so roughly 20 concurrent relayed
# calls before allocation starts failing. Against a millions-of-users target
# this is the hardest ceiling on the box, and it fails as a call that simply
# will not connect rather than as anything obvious in a log.
#
# UFW already permits 49152:65535/udp, so only coturn's own range is limiting.
# This one cannot be done live — min-port/max-port are read at startup.
# ─────────────────────────────────────────────────────────────────────────
if [ "${SKIP_5:-0}" != 1 ]; then
  say "5. Widen the TURN relay range (RESTARTS COTURN)"
  ACTIVE=$(docker exec vaultchat-coturn-1 sh -c 'ss -un 2>/dev/null | wc -l' </dev/null 2>/dev/null || echo "?")
  warn "in-progress relayed calls will drop (roughly $ACTIVE udp sockets open)"
  CONF=$(docker inspect vaultchat-coturn-1 \
        --format '{{range .Mounts}}{{if eq .Destination "/etc/coturn/turnserver.conf"}}{{.Source}}{{end}}{{end}}' 2>/dev/null)
  if [ -z "$CONF" ]; then
    warn "could not find the host path of turnserver.conf — edit it by hand:"
    echo  "     min-port=49152 / max-port=65535, then: docker restart vaultchat-coturn-1"
  else
    echo "   config: $CONF"
    run "sudo cp $CONF $CONF.bak-\$(date +%F)"
    run "sudo sed -i 's/^min-port=.*/min-port=49152/; s/^max-port=.*/max-port=65535/' $CONF"
    # A mounted-file change alone does NOT restart the process — compose reports
    # "Running" and nothing happens. That cost a debugging cycle already, so use
    # docker restart explicitly rather than `compose up -d`.
    run "docker restart vaultchat-coturn-1"
    if [ "$APPLY" = "1" ]; then
      sleep 3
      docker exec vaultchat-coturn-1 grep -E '^(min|max)-port' /etc/coturn/turnserver.conf </dev/null
      echo | openssl s_client -connect turn.corefinite.com:5349 -servername turn.corefinite.com 2>/dev/null \
        | grep -q "CN = turn" && ok "TURNS still answering after restart" || warn "TURNS DID NOT COME BACK — check: docker logs vaultchat-coturn-1"
    fi
  fi
fi

# ─────────────────────────────────────────────────────────────────────────
# NOT AUTOMATED — needs a decision, not a command
#
# Offsite backups. Every dump in /home/srihari/vaultchat-backups sits on the
# same disk as the database it was taken from, so a disk or host loss takes
# both. The daily 02:30 cron works and the dumps restore; the gap is purely
# that there is one copy. Everything else in this file is recoverable from a
# rebuild — this one is not. It needs a destination (S3/B2/rsync target) and a
# credential, which is your call to make.
#
# Also outstanding: Redis still has no requirepass (16379 is confirmed closed
# externally, so it is container-network-only), and the 0.0.0.0 port bindings
# from the 2026-08-09 maintenance list are unchanged. Both still want the
# restart window in scripts/ops/maintenance-2026-08-09.sh.
# ─────────────────────────────────────────────────────────────────────────
say "done"
[ "$APPLY" = "1" ] || echo "(that was a dry run — nothing changed)"
