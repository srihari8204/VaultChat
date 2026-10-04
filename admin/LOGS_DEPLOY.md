# Server log viewer — deploy (admin.corefinite.com/logs.html)

Topology: `browser → nginx (TLS, admin.corefinite.com) → /logapi/* → 127.0.0.1:9999 (logserver.py, token-gated, read-only)`.
The API never listens publicly; nginx is the only path in, and every request
needs the `X-Log-Token` header. Paste-ready sequence:

```bash
cd /home/srihari/vaultchat && git pull

# 1. one-time: token + systemd unit
TOKEN=$(openssl rand -hex 24)
printf 'LOG_TOKEN=%s\nCOMPOSE_DIR=/home/srihari/vaultchat\n' "$TOKEN" > /etc/vaultchat-logs.env
chmod 600 /etc/vaultchat-logs.env
echo "LOG TOKEN (paste into logs.html): $TOKEN"

cat > /etc/systemd/system/vaultchat-logs.service <<'EOF'
[Unit]
Description=VaultChat read-only log API (loopback)
After=docker.service

[Service]
EnvironmentFile=/etc/vaultchat-logs.env
ExecStart=/usr/bin/python3 /home/srihari/vaultchat/admin/logserver.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now vaultchat-logs
systemctl status vaultchat-logs --no-pager | head -5

# 2. serve logs.html + proxy /logapi on the admin site.
#    In the admin.corefinite.com server block (/etc/nginx/sites-enabled/…),
#    add ONE location and make logs.html reachable from the site root:
#
#      location /logapi/ {
#          proxy_pass http://127.0.0.1:9999/;
#          proxy_read_timeout 30;
#      }
#
#    and either copy the page next to your dashboard index.html:
ADMIN_ROOT=$(grep -rhoP 'root\s+\K[^;]+' /etc/nginx/sites-enabled/* | head -1)  # verify!
cp admin/logs.html "$ADMIN_ROOT"/logs.html
nginx -t && systemctl reload nginx

# 3. smoke test (expect: bad token 401, then OK with the token)
curl -s https://admin.corefinite.com/logapi/sources | head -c 80; echo
curl -s -H "X-Log-Token: $TOKEN" https://admin.corefinite.com/logapi/sources | head -c 200; echo
```

Then open `https://admin.corefinite.com/logs.html`, paste the token once
(stored only in that browser), and add a link to it from the dashboard
`index.html` (`<a href="/logs.html">Logs</a>`).

Notes
- Sources cover the whole box: all compose services (caddy, go-api, postgres,
  pgbouncer, redis, valhalla, coturn, livekit, vaultlens-worker, prometheus,
  grafana, legacy api), journald units (nginx, docker, sshd, ufw), raw
  nginx/syslog files, plus `docker ps` and disk/memory overviews.
- Rotate the token any time: edit /etc/vaultchat-logs.env, `systemctl restart
  vaultchat-logs`, paste the new value into the page.
- Logs contain user IPs and ids — treat the token like a password.

## The other admin pages: shopbook.html, fonts, and headers

All three pages (`index.html`, `logs.html`, `shopbook.html`) are static files
served by **host nginx** from the admin site root (`/var/www/admin.corefinite.com/`
per `docs/SERVER_INVENTORY.md`). Caddy does not serve them, so the headers
below go in nginx, not in `caddy/Caddyfile`.

Each page's `<meta>` CSP pins the SHA-256 of its one inline script; a page
whose pin is stale refuses to run its script. Check all three before copying
(from a checkout with node_modules, e.g. a dev machine):
`npx tsx admin/adminPages.selftest.ts` — it also fails on inline `on*=` handlers.

```bash
cd /home/srihari/vaultchat && git pull
ADMIN_ROOT=$(grep -rhoP 'root\s+\K[^;]+' /etc/nginx/sites-enabled/* | head -1)  # verify!

# 1. shopbook.html next to index.html (index.html links to /shopbook.html).
#    CAUTION: SERVER_INVENTORY.md records that the DEPLOYED shopbook.html was
#    newer and larger than the repo copy. Back it up and diff before copying;
#    copy only if the repo version is the one you mean to run.
cp "$ADMIN_ROOT"/shopbook.html "$ADMIN_ROOT"/shopbook.html.bak.$(date +%F) 2>/dev/null
diff <(sed 's/[[:space:]]*$//' "$ADMIN_ROOT"/shopbook.html) <(sed 's/[[:space:]]*$//' admin/shopbook.html) | head -40
cp admin/shopbook.html "$ADMIN_ROOT"/shopbook.html     # after reviewing the diff

# 2. Self-hosted fonts for index.html (it no longer loads Google Fonts; its CSP
#    is now font-src 'self'). Five files from the app's own assets, plus
#    JetBrains Mono from admin/fonts/ (copied from expo-dev-menu's bundled
#    font; SIL OFL 1.1, the licence is in the font's own name table). These
#    are every face the page uses. Without them the page still works and
#    falls back to the system fonts.
mkdir -p "$ADMIN_ROOT"/fonts
cp assets/fonts/Sora_700Bold.ttf assets/fonts/Sora_800ExtraBold.ttf \
   assets/fonts/NunitoSans_400Regular.ttf assets/fonts/NunitoSans_600SemiBold.ttf \
   assets/fonts/NunitoSans_700Bold.ttf admin/fonts/JetBrainsMono_400Regular.ttf "$ADMIN_ROOT"/fonts/
cp admin/index.html "$ADMIN_ROOT"/index.html
```

### Headers (anti-framing) — in the admin.corefinite.com server block

`frame-ancestors` cannot be set from the pages' `<meta>` CSP, so send it, plus
the legacy `X-Frame-Options`, from nginx. Put both lines at **server** level
and make sure no `location` that serves the pages has its own `add_header`
(in nginx a location's `add_header` replaces, rather than adds to, the
server-level ones):

```nginx
    add_header Content-Security-Policy "frame-ancestors 'none'" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
```

The header CSP combines with each page's `<meta>` CSP (both are enforced), so
it does not loosen the hash-pinned `script-src`.

```bash
nginx -t && systemctl reload nginx
curl -sI https://admin.corefinite.com/ | grep -iE 'frame|x-content|referrer'   # expect all four
curl -sI https://admin.corefinite.com/shopbook.html | grep -i frame-ancestors
curl -sI https://admin.corefinite.com/fonts/Sora_700Bold.ttf | head -1           # expect 200
curl -sI https://admin.corefinite.com/fonts/JetBrainsMono_400Regular.ttf | head -1  # expect 200
```

The site is behind the Cloudflare proxy; Cloudflare passes these origin
headers through unchanged.
