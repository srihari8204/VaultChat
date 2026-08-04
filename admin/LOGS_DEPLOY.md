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
