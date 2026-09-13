# ── Postgres ────────────────────────────────────────────────────────────
resource "digitalocean_database_cluster" "pg" {
  name                 = "${var.project_name}-pg"
  engine               = "pg"
  version              = "16"
  size                 = "db-s-4vcpu-8gb"
  region               = var.region
  node_count           = 2 # primary + standby. One node means no failover.
  private_network_uuid = digitalocean_vpc.main.id

  maintenance_window {
    day  = "sunday"
    hour = var.maintenance_start_utc
  }
}

resource "digitalocean_database_db" "vaultchat" {
  cluster_id = digitalocean_database_cluster.pg.id
  # The database keeps its name. The rebrand is infrastructure and DNS only —
  # renaming the database would mean a dump/restore of live data for cosmetics.
  name = "vaultchat"
}

resource "digitalocean_database_user" "app" {
  cluster_id = digitalocean_database_cluster.pg.id
  name       = "vaultchat"
}

# Transaction-mode pooling, which replaces the self-hosted pgbouncer entirely.
#
# The application is already built for it and the evidence is in the code:
# db.WithUser uses set_config(..., is_local=true) so the RLS user is
# transaction-scoped, the DSN pins default_query_exec_mode=exec so there are no
# named prepared statements to lose across server connections, and partition
# maintenance takes pg_try_advisory_xact_lock rather than the session variant.
# Nothing needs session state to outlive a transaction.
#
# THE TRAP: DigitalOcean addresses a pool by putting the POOL NAME in the
# database slot. The application's DB_NAME must therefore be "vaultchat-txn",
# not "vaultchat", and the port is 25061 rather than 25060. Getting this wrong
# connects you straight to Postgres with no pooling and no error.
resource "digitalocean_database_connection_pool" "txn" {
  cluster_id = digitalocean_database_cluster.pg.id
  name       = "vaultchat-txn"
  mode       = "transaction"
  size       = 80
  db_name    = digitalocean_database_db.vaultchat.name
  user       = digitalocean_database_user.app.name
}

# Without this every connection from the cluster is refused. Being inside the
# same VPC is NOT what grants access — the database has its own trust list, and
# a "k8s" rule keyed to the cluster id follows node replacement automatically
# where an IP allowlist would not.
resource "digitalocean_database_firewall" "pg" {
  cluster_id = digitalocean_database_cluster.pg.id

  rule {
    type  = "k8s"
    value = digitalocean_kubernetes_cluster.main.id
  }
}

# ── Valkey ──────────────────────────────────────────────────────────────
#
# THREE clusters, and the split is not arbitrary.
#
# LiveKit stores room and participant state under FIXED key names with no
# prefix option — its only namespacing control is the Redis database number. On
# one box the two deployments are separated by `db: 0` and `db: 3`. Managed
# Valkey may not expose more than one database, and if it does not, sharing a
# cluster means calling and Go Live read each other's rooms: a participant joins
# a call and lands in a broadcast. Separate clusters make the isolation
# structural instead of dependent on a provider setting.
#
# The two media clusters hold only ephemeral room state, so they are the
# smallest size available. The application cluster carries the Socket.IO
# adapter, presence and rate limiting for the whole fleet and is sized for it.
resource "digitalocean_database_cluster" "valkey_app" {
  name                 = "${var.project_name}-valkey-app"
  engine               = "valkey"
  version              = "8"
  size                 = "db-s-2vcpu-4gb"
  region               = var.region
  node_count           = 1
  private_network_uuid = digitalocean_vpc.main.id
}

resource "digitalocean_database_cluster" "valkey_calls" {
  name                 = "${var.project_name}-valkey-calls"
  engine               = "valkey"
  version              = "8"
  size                 = "db-s-1vcpu-1gb"
  region               = var.region
  node_count           = 1
  private_network_uuid = digitalocean_vpc.main.id
}

resource "digitalocean_database_cluster" "valkey_golive" {
  name                 = "${var.project_name}-valkey-golive"
  engine               = "valkey"
  version              = "8"
  size                 = "db-s-1vcpu-1gb"
  region               = var.region
  node_count           = 1
  private_network_uuid = digitalocean_vpc.main.id
}

resource "digitalocean_database_firewall" "valkey_app" {
  cluster_id = digitalocean_database_cluster.valkey_app.id
  rule {
    type  = "k8s"
    value = digitalocean_kubernetes_cluster.main.id
  }
}

resource "digitalocean_database_firewall" "valkey_calls" {
  cluster_id = digitalocean_database_cluster.valkey_calls.id
  rule {
    type  = "k8s"
    value = digitalocean_kubernetes_cluster.main.id
  }
}

resource "digitalocean_database_firewall" "valkey_golive" {
  cluster_id = digitalocean_database_cluster.valkey_golive.id
  rule {
    type  = "k8s"
    value = digitalocean_kubernetes_cluster.main.id
  }
}
