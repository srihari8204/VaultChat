# VaultChat backend — Hetzner deploy runbook

End-to-end, runs on the Hetzner box itself unless noted "on Windows".
Assumes:
- Ubuntu 22.04+ on Hetzner
- You can `ssh vaultchat` from Windows (key auth set up)
- Postgres is already running on 127.0.0.1:5432, PgBouncer on 127.0.0.1:6432
- Redis is already running on 127.0.0.1:6379 (install: `apt install redis-server` if not)
- A domain (e.g. `api.corefinite.com`) is ready to point at the Hetzner IP

---

## 1. SSH in + install Node + pm2 (one-time)

```bash
ssh vaultchat

# Node 20 LTS via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version    # v20.x
npm --version

# pm2 globally
sudo npm install -g pm2

# Redis (skip if already installed)
sudo apt install -y redis-server
sudo systemctl enable --now redis-server
redis-cli ping     # → PONG
```

## 2. Clone the repo

```bash
cd ~
git clone https://github.com/srihari8204/VaultChat.git
cd VaultChat/vaultchat-backend

# Install backend deps (skip devDependencies on the server)
npm install --omit=dev
```

## 3. Production .env (on the server, NEVER commit)

```bash
nano .env
```

Paste — replace placeholders with real values:

```bash
NODE_ENV=production
PORT=3000
HOST=127.0.0.1

# Postgres via PgBouncer (transaction pooling). For long-lived
# connections / advisory locks / LISTEN-NOTIFY, swap to :5432 (direct).
DB_HOST=127.0.0.1
DB_PORT=6432
DB_NAME=vaultchat
DB_USER=vaultchat_app
DB_PASS=<your-real-app-password>
PG_STATEMENT_TIMEOUT=10000

# Redis
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
# REDIS_PASS=              # set only if redis-cli AUTH is configured

# JWT — generate with: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
JWT_SECRET=<paste-128-char-secret>
JWT_ACCESS_TTL=900
JWT_REFRESH_TTL=2592000

# Email (Gmail SMTP for now; switch to Resend/Postmark for scale)
EMAIL_USER=vaulttest0123@gmail.com
EMAIL_PASS=<gmail-app-password-16-chars>
EMAIL_FROM="VaultChat" <noreply@vaultchat.app>

# Google Sign-In — same Web Client ID the mobile app uses
GOOGLE_WEB_CLIENT_ID=207307621485-53m82dlcolfctpfagjnddnsq1euvvmpe.apps.googleusercontent.com
```

Lock it down:
```bash
chmod 600 .env
```

## 4. Apply the schema

```bash
# From the backend folder:
PGPASSWORD="$(grep ^DB_PASS .env | cut -d= -f2- | tr -d \"\\\'\")" \
  psql -h 127.0.0.1 -p 6432 -U vaultchat_app -d vaultchat \
  -f migrations/001_init.sql

# Verify:
psql -h 127.0.0.1 -p 6432 -U vaultchat_app -d vaultchat -c "\dt"
# → users, otp_codes, refresh_tokens
```

## 5. pm2 start

```bash
# Pre-flight: syntax check
node --check server.js
ls routes/*.js | xargs -I {} node --check {}

# Start in cluster mode (1 instance — Socket.IO needs sticky sessions for >1)
pm2 start server.js --name vaultchat-api --time

# Verify
pm2 status
pm2 logs vaultchat-api --lines 30

# You should see:
#   VaultChat backend listening on http://127.0.0.1:3000
# Test:
curl http://127.0.0.1:3000/health
# → {"status":"ok","db":true,"redis":true,...}

# Persist so the server restarts after reboot
pm2 save
pm2 startup systemd      # follow the printed command to enable systemd unit
```

## 6. Nginx reverse proxy + TLS

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

Create the site config:
```bash
sudo nano /etc/nginx/sites-available/api.corefinite.com
```

Paste (replace `api.corefinite.com` with your actual domain):
```nginx
server {
    listen 80;
    server_name api.corefinite.com;

    # Let's Encrypt + redirect to https handled by certbot after issuance
    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   Upgrade           $http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_read_timeout 86400;
        client_max_body_size 25M;
    }
}
```

Enable + reload:
```bash
sudo ln -s /etc/nginx/sites-available/api.corefinite.com /etc/nginx/sites-enabled/
sudo nginx -t          # config OK?
sudo systemctl reload nginx
```

## 7. DNS + TLS

In your DNS provider (Cloudflare / Namecheap / Hetzner DNS), create an **A record**:
```
api.corefinite.com  →  <Hetzner-server-IP>
```

Wait for DNS to propagate (`dig api.corefinite.com` should return your Hetzner IP).

Then issue the cert:
```bash
sudo certbot --nginx -d api.corefinite.com
# follow prompts — pick "Redirect HTTP to HTTPS"
```

Certbot auto-renews via the `certbot.timer` systemd unit (`systemctl list-timers | grep certbot`).

## 8. Verify from anywhere

```bash
# From your phone / Windows:
curl https://api.corefinite.com/health
# → {"status":"ok","db":true,"redis":true,...}
```

## 9. Updates (every deploy after this)

On Windows, push to master:
```powershell
git add vaultchat-backend
git commit -m "..."
git push origin master
```

On the server, pull + restart:
```bash
ssh vaultchat
cd ~/VaultChat
git pull origin master
cd vaultchat-backend
npm install --omit=dev   # only if package.json changed
pm2 reload vaultchat-api # zero-downtime
pm2 logs vaultchat-api --lines 30
```

You can wrap this in a `deploy.sh` on the server later, or trigger it via SSH from a script on Windows.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `pm2 logs` shows DB connection error | Check `.env` DB_HOST/DB_PORT match what `psql` accepts. Try direct Postgres (5432) instead of PgBouncer (6432) to isolate. |
| Redis `ECONNREFUSED` | `sudo systemctl status redis-server`. If not running, `sudo systemctl start redis-server`. |
| `/health` shows `redis: false` | Same as above — health is allowed to start degraded, but rate limiting won't work. |
| 502 Bad Gateway from Nginx | `pm2 status` — is `vaultchat-api` online? `curl http://127.0.0.1:3000/health` from the server. |
| Certbot fails | Make sure port 80 is open in Hetzner's firewall and DNS is propagated. |
| `auth/send-otp` returns 500 | Gmail App Password issue. Check `pm2 logs` for the nodemailer error. Standard Gmail passwords don't work — must be a 16-char App Password. |

---

## What about the old Render deploy?

The Render service at `api.corefinite.com` keeps running until you flip DNS. After flipping:
- DNS `api.corefinite.com` → Hetzner IP
- Render's HTTPS cert for that domain becomes unused; Render service can be torn down once Hetzner is verified
- Old code on Render still runs and serves traffic IF anyone bypasses DNS by going to the `*.onrender.com` URL directly. Leave it as a fallback until you're confident Hetzner is solid, then delete the Render service to stop billing
