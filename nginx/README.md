# nginx — the actual edge

These are the vhosts running on the production host, copied from
`/etc/nginx/sites-enabled/`. They were never in version control, which meant the
repository could not describe — let alone rebuild — the machine's front door.

## The request path is two proxies deep

```
client ──443──► nginx (host)  ──► 127.0.0.1:8095 (caddy container) ──► go-api:4000
```

**nginx terminates TLS and owns :80/:443, not Caddy.** The repo also carries
`caddy/Caddyfile`, and it is easy to read that as the edge config. It is not.
Caddy sits behind nginx on 8095. Certificates are Let's Encrypt files on the
host (`/etc/letsencrypt/live/<host>/`), renewed by certbot — not by Caddy's
automatic HTTPS.

## Hosts

| vhost | serves | upstream |
|---|---|---|
| `vaultchat.conf` | `api.corefinite.com` — the whole client API and Socket.IO | `127.0.0.1:8095` |
| `vaultchat-stream.conf` | `stream.corefinite.com` — HLS broadcast origin, proxied and cached by Cloudflare | `127.0.0.1:8095` |
| `games.conf` | the VaultGames mini-app | games container |
| `admin.conf` | admin surface | — |

## Deploying a change

These files are **not** mounted from this directory; nginx reads
`/etc/nginx/sites-enabled/`. Copying is a deliberate manual step:

```bash
sudo cp nginx/sites/<name>.conf /etc/nginx/sites-available/<name>
sudo nginx -t && sudo nginx -s reload
```

`nginx -t` before every reload, without exception — a syntax error takes down
every host on the box, not just the one edited.

## Not captured here

DNS. `api.corefinite.com` and `stream.corefinite.com` have records;
**there is no wildcard**, so a new subdomain needs a DNS change before its vhost
can do anything. That constraint is why attachment uploads are published as a
path on `api.corefinite.com` rather than on a `media.` host of their own.
