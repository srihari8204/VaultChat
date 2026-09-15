#!/usr/bin/env bash
set -Eeuo pipefail
target=/etc/nginx/sites-enabled/vaultchat
backup=/etc/nginx/vaultchat.pre-http3-advertise-20260915
cp -an "$target" "$backup"
python3 - <<'PY'
from pathlib import Path
p = Path('/etc/nginx/sites-enabled/vaultchat')
content = p.read_text()
anchor = '    listen 443 ssl http2;\n    server_name api.corefinite.com;\n'
header = '    add_header Alt-Svc \'h3=":8443"; ma=300\' always;\n'
if header not in content:
    if content.count(anchor) != 1 or 'add_header Alt-Svc' in content:
        raise SystemExit('Unexpected API vhost; no changes made')
    p.write_text(content.replace(anchor, anchor + '\n    # HTTP/3 UDP8443 preserves TURN on UDP443.\n' + header, 1))
PY
if ! nginx -t; then
    cp "$backup" "$target"
    exit 1
fi
nginx -s reload
curl --fail --silent --show-error -D - https://api.corefinite.com/health
