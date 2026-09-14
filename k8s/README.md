# Deploying the API on the Akamai/Linode Mumbai node — Docker + Kubernetes

Target: a single Ubuntu 24.04 Linode in `ap-west` (Mumbai), running the API
(`go-api`, REST + Socket.IO) with Postgres and Redis, behind TLS.

Kubernetes distribution is **k3s** — a single binary, full upstream Kubernetes
API, ~512 MB overhead, and it bundles the Traefik ingress controller and a
local-path storage provisioner. On one node, kubeadm/EKS-style clusters buy
nothing and cost a lot of RAM.

Docker is used to **build** the images. k3s runs containerd, so images are
imported into containerd after building — see step 6.

No PM2 anywhere: the container is the process supervisor, and Kubernetes is
the restart/rollout layer.

---

## 0. Before you start

**Find the node's public IP.** The console shows `eth0: 10.0.0.2` — that is a
VPC/private address, not what DNS points at. On the node:

```bash
ip -4 addr show | grep inet        # all interfaces
curl -4 -s ifconfig.me ; echo      # the address the internet sees
```

Use the public one for DNS and for the firewall rules below.

**Sizing.** Postgres + Redis + API + k3s on one box wants 4 GB RAM minimum,
8 GB to be comfortable. The console shows 157 GB disk, which is plenty.

**Decide the hostname** now (e.g. `api.crazzychat.com`). Everything from step 8
on needs it, and the TLS certificate is issued against it.

---

## 1. Server prep

```bash
apt update && apt upgrade -y
apt install -y curl git ca-certificates ufw

timedatectl set-timezone Asia/Kolkata     # optional; logs read easier
hostnamectl set-hostname crazzychat-mum-01
```

Firewall — open only what is served:

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp                 # SSH. Do this BEFORE `ufw enable`.
ufw allow 80/tcp                 # HTTP — needed for Let's Encrypt HTTP-01
ufw allow 443/tcp                # HTTPS

# k3s pod + service networks must talk to themselves, or DNS inside the
# cluster breaks and every pod fails to resolve `postgres`.
ufw allow in on cni0 from 10.42.0.0/16 to 10.42.0.0/16
ufw allow in on cni0 from 10.42.0.0/16 to 10.43.0.0/16

ufw enable
ufw status verbose
```

> The Kubernetes API (6443) is deliberately NOT opened. Administer the cluster
> over SSH. If you later need `kubectl` from your laptop, tunnel it:
> `ssh -L 6443:127.0.0.1:6443 root@<public-ip>` — never expose 6443 publicly.

If you also use a **Linode Cloud Firewall**, mirror the same rules there;
it sits in front of ufw and will silently drop 80/443 otherwise.

---

## 2. Install Docker (for building images)

```bash
curl -fsSL https://get.docker.com | sh
docker --version
```

---

## 3. Install k3s

```bash
curl -sfL https://get.k3s.io | sh -

# kubectl comes with it. Point it at the cluster for your shell:
echo 'export KUBECONFIG=/etc/rancher/k3s/k3s.yaml' >> ~/.bashrc
source ~/.bashrc

kubectl get nodes          # → crazzychat-mum-01   Ready   control-plane,master
kubectl get pods -A        # traefik, coredns, local-path-provisioner, metrics-server
```

Wait until every pod in `kube-system` is `Running` before continuing.

---

## 4. Clone the repo

```bash
mkdir -p /opt && cd /opt
git clone https://github.com/srihari8204/VaultChat.git
cd VaultChat
git checkout hetzner-deploy
```

---

## 5. Create the Secret

Every credential the API needs comes from one Kubernetes Secret built from a
`.env` file. Start from the example and fill in real values:

```bash
cp vaultchat-backend/.env.example /opt/vaultchat.env
chmod 600 /opt/vaultchat.env
nano /opt/vaultchat.env
```

Minimum you must set:

| Key | Notes |
|---|---|
| `DB_PASS` | Postgres password. Generate: `openssl rand -base64 24` |
| `JWT_SECRET` | `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` or `openssl rand -base64 48` |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` | `900` / `2592000` |
| `INTERNAL_EMIT_KEY` | `openssl rand -hex 32` |
| `ADMIN_KEY` | `openssl rand -hex 32` |
| `RESEND_API_KEY`, `EMAIL_FROM` | email/OTP delivery |
| `GOOGLE_WEB_CLIENT_ID` | must match the mobile app's |
| `S3_*` | object storage for attachments (R2/MinIO/S3) |
| `PUBLIC_BASE_URL` | `https://api.crazzychat.com` — your real hostname |

**Delete `DB_HOST`, `DB_PORT`, `REDIS_HOST`, `REDIS_PORT` and `PORT` lines** if
they carry old Hetzner values. They are pinned in `30-api.yaml` and override
the Secret anyway, but leaving stale values in the file invites confusion later.

Create the Secret:

```bash
kubectl apply -f k8s/00-namespace.yaml
kubectl -n vaultchat create secret generic vaultchat-secrets \
  --from-env-file=/opt/vaultchat.env
```

To change a value later, recreate and restart:

```bash
kubectl -n vaultchat create secret generic vaultchat-secrets \
  --from-env-file=/opt/vaultchat.env --dry-run=client -o yaml | kubectl apply -f -
kubectl -n vaultchat rollout restart deploy/go-api
```

> A Secret is base64, **not encrypted**, and lives in k3s's datastore. Keep
> `/opt/vaultchat.env` at mode 600 and never commit it.

File-based credentials (Firebase service account, games signing key) mount the
same way — create a second Secret and add a volume to `30-api.yaml`:

```bash
kubectl -n vaultchat create secret generic vaultchat-files \
  --from-file=firebase-sa.json=/opt/secrets/fcm-service-account.json
```

---

## 6. Start Postgres and Redis

```bash
kubectl apply -f k8s/10-postgres.yaml
kubectl apply -f k8s/11-redis.yaml
kubectl -n vaultchat get pods -w        # Ctrl+C when both are Running
```

Both are `ClusterIP` only — no port is published to the host, so neither is
reachable from the internet.

---

## 7. Build, migrate, deploy

One script does all three (build with Docker → import into containerd → run
migrations → roll out):

```bash
./k8s/build-and-deploy.sh
```

**First deploy against a database that already has tables** (e.g. restored from
the Hetzner box): seed the migration ledger *before* running the script, or
migrate.js will try to re-create existing tables:

```bash
kubectl -n vaultchat run migrate-baseline --rm -it --restart=Never \
  --image=vaultchat/node-migrate:<tag> --image-pull-policy=IfNotPresent \
  --env=DB_HOST=postgres --env=DB_PORT=5432 --env=DB_NAME=vaultchat \
  --env=DB_USER=vaultchat --env=DB_PASS="$(grep ^DB_PASS /opt/vaultchat.env | cut -d= -f2-)" \
  -- node migrate.js baseline <last-applied-number>
```

Verify the API is up, from inside the cluster:

```bash
kubectl -n vaultchat get pods
kubectl -n vaultchat logs deploy/go-api --tail=40
kubectl -n vaultchat port-forward svc/go-api 4000:4000 &
curl -s http://127.0.0.1:4000/health ; echo
# → {"status":"ok","db":true,"redis":true,...}
kill %1
```

Do not go to step 8 until `/health` returns `db:true` and `redis:true`.

---

## 8. DNS, TLS, and the public Ingress

**DNS first.** At your registrar, create an A record:

```
api.crazzychat.com   A   <node public IP>
```

Confirm it resolves before requesting a certificate — HTTP-01 validation fails
if Let's Encrypt cannot reach the name:

```bash
dig +short api.crazzychat.com
```

**Install cert-manager** (issues and auto-renews the certificate):

```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.2/cert-manager.yaml
kubectl -n cert-manager rollout status deploy/cert-manager-webhook --timeout=180s
```

**Edit `k8s/40-ingress.yaml`** — replace `api.example.com` (two places) with
your hostname and `REPLACE_WITH_YOUR_EMAIL` with a real mailbox. Then:

```bash
kubectl apply -f k8s/40-ingress.yaml

# Watch issuance — READY goes True in 30-90s
kubectl -n vaultchat get certificate -w
kubectl -n vaultchat describe certificate vaultchat-api-tls   # if it stalls
```

**Verify publicly:**

```bash
curl -s https://api.crazzychat.com/health ; echo
```

Point the mobile app at that URL (`constants/server.ts`) and rebuild.

---

## 9. Day-2 operations

```bash
# What is running
kubectl -n vaultchat get pods -o wide

# Logs (live tail)
kubectl -n vaultchat logs deploy/go-api -f
kubectl -n vaultchat logs deploy/go-api --previous     # after a crash

# Shell into the API pod
kubectl -n vaultchat exec -it deploy/go-api -- sh

# psql
kubectl -n vaultchat exec -it postgres-0 -- psql -U vaultchat -d vaultchat

# Restart without a rebuild (e.g. after a Secret change)
kubectl -n vaultchat rollout restart deploy/go-api

# Resource usage
kubectl -n vaultchat top pods
```

**Deploy an update** — the whole cycle, every time:

```bash
cd /opt/VaultChat && git pull origin hetzner-deploy && ./k8s/build-and-deploy.sh
```

**Roll back** to the previous image:

```bash
kubectl -n vaultchat rollout undo deploy/go-api
kubectl -n vaultchat rollout history deploy/go-api
```

**Backups.** The PVCs live on this node's disk — a lost node is a lost
database. Take dumps off-box daily:

```bash
kubectl -n vaultchat exec postgres-0 -- \
  pg_dump -U vaultchat -Fc vaultchat > /opt/backups/vaultchat-$(date +%F).dump
```

Add it to cron and ship `/opt/backups` to object storage or another region.

**Free disk after many builds** — old images accumulate in two stores:

```bash
docker image prune -af
sudo k3s crictl rmi --prune
```

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Pod `ErrImagePull` / `ImagePullBackOff` | Image is in Docker but not containerd. Re-run the import: `docker save vaultchat/go-api:<tag> \| sudo k3s ctr images import -`. Check the tag matches: `sudo k3s crictl images \| grep vaultchat` |
| Pod `Pending`, events say "no persistent volumes available" | local-path provisioner not ready, or a second pod wants the same RWO PVC. `kubectl -n vaultchat describe pod <name>` and `kubectl get pods -n kube-system` |
| `CrashLoopBackOff` on go-api | `kubectl -n vaultchat logs deploy/go-api --previous`. Usually a missing key in the Secret |
| `/health` shows `db:false` | Postgres not Ready, or wrong `DB_PASS` in the Secret. `kubectl -n vaultchat logs postgres-0` |
| `/health` shows `redis:false` | `kubectl -n vaultchat get pods -l app=redis`. Rate limiting and cross-replica presence depend on it |
| Certificate stuck `READY=False` | DNS not pointing at this node yet, or 80/tcp blocked (ufw **and** the Linode Cloud Firewall). `kubectl -n vaultchat describe order` |
| 404 from Traefik on the public URL | Host in the Ingress does not match the request host. `kubectl -n vaultchat describe ingress vaultchat-api` |
| WebSockets connect then drop | Cloudflare SSL set to Flexible (must be Full/Full strict), or >1 replica without sticky sessions |
| Migration Job fails | `kubectl -n vaultchat logs job/vaultchat-migrate`. Fix the SQL, `kubectl -n vaultchat delete job vaultchat-migrate`, re-run the script |

---

## Scaling past one node

When one Mumbai box is no longer enough:

1. **Registry instead of import.** Push to GHCR and set
   `imagePullPolicy: IfNotPresent` with a real registry path, plus an
   `imagePullSecret`. The `docker save | ctr import` step then disappears.
2. **Join workers:** on the new node,
   `curl -sfL https://get.k3s.io | K3S_URL=https://<node-ip>:6443 K3S_TOKEN=$(cat /var/lib/rancher/k3s/server/node-token) sh -`
   (over the VPC's private network, not the public IP).
3. **Move attachments off the PVC** to S3/R2 so `go-api` is stateless, then
   raise `replicas` and add sticky sessions to the Ingress Service:
   `traefik.ingress.kubernetes.io/service.sticky.cookie: "true"`.
4. **Managed Postgres** (Linode's, in the same Mumbai region) instead of the
   in-cluster StatefulSet — it takes backups and failover off your plate.
