# ── DOKS ────────────────────────────────────────────────────────────────
#
# ha = true is not optional at this scale. Without it the control plane is a
# single replica: during a control-plane upgrade there is no API server, which
# also means the cluster-autoscaler cannot act — so the one window where a
# traffic spike is most likely to need nodes is the window where it cannot get
# them.
resource "digitalocean_kubernetes_cluster" "main" {
  name     = "${var.project_name}-prod"
  region   = var.region
  version  = var.cluster_version
  vpc_uuid = digitalocean_vpc.main.id
  ha       = true

  # Surge upgrades replace nodes rather than draining in place. Good everywhere
  # except the media pools — see the maintenance window note in variables.tf.
  surge_upgrade = true
  auto_upgrade  = false

  maintenance_policy {
    day        = "sunday"
    start_time = var.maintenance_start_utc
  }

  # The default pool carries cluster infrastructure only. Fixed size on purpose:
  # autoscaling the tier that runs ingress and Prometheus means rescheduling the
  # ingress controller under exactly the load that caused the scale event.
  node_pool {
    name       = "sys"
    size       = "s-4vcpu-8gb"
    node_count = 3
    labels     = { pool = "sys" }
    tags       = ["${var.project_name}-sys"]
  }

  lifecycle {
    # The node_pool block above is the default pool and cannot be removed; the
    # rest are separate resources. Version drift is handled by an explicit
    # variable bump, never by a plan that silently upgrades a live cluster.
    ignore_changes = [version]
  }
}

# ── app pool ────────────────────────────────────────────────────────────
#
# Dedicated vCPU (g-), not shared (s-). A shared-CPU droplet is burstable, and a
# socket server that gets CPU-steal misses Socket.IO pings; the client gives up
# and reconnects, which costs a JWT verify plus a join_chat re-emit for every
# room it was in. Steal on a socket tier converts into a reconnect storm.
#
# Sized for ~1500 sockets per pod rather than the maximum a pod can hold: the
# number that matters during a rolling update is how many clients one pod
# restart forces to reconnect at once.
resource "digitalocean_kubernetes_node_pool" "app" {
  cluster_id = digitalocean_kubernetes_cluster.main.id
  name       = "app"
  size       = "g-4vcpu-16gb"
  auto_scale = true
  min_nodes  = 3
  max_nodes  = 12
  labels     = { pool = "app" }
  tags       = ["${var.project_name}-app"]

  taint {
    key    = "workload"
    value  = "app"
    effect = "NoSchedule"
  }
}

# ── media pools ─────────────────────────────────────────────────────────
#
# Two pools, not one. They could share: the port triples do not collide
# (7880/7881/7882 vs 7890/7891/7892), and compose already proves it on one box.
# But the reason Go Live has its own LiveKit project is blast-radius isolation
# that the backend REFUSES to let you undo — internal/golive/config.go treats
# overlapping credentials as a misconfiguration and will not start. Co-locating
# the DaemonSets re-shares the NIC, the CPU and the kernel UDP buffers, which
# recouples exactly what that check protects. One extra droplet is the price of
# keeping the property.
#
# Bandwidth-bound, not CPU-bound: an SFU forwards and never transcodes, and with
# frame encryption on it could not transcode if asked — the payloads are
# ciphertext. Roughly 600 kbps per forwarded stream.
resource "digitalocean_kubernetes_node_pool" "media_calls" {
  cluster_id = digitalocean_kubernetes_cluster.main.id
  name       = "media-calls"
  size       = "g-4vcpu-16gb"
  auto_scale = true
  min_nodes  = 2
  max_nodes  = 8
  labels     = { pool = "media-calls" }

  # This tag is what the media firewall attaches to. Node pool tags propagate to
  # replacement droplets automatically, which is the only reason firewall rules
  # survive a node recycle.
  tags = ["${var.project_name}-media-calls"]

  taint {
    key    = "workload"
    value  = "media-calls"
    effect = "NoSchedule"
  }
}

resource "digitalocean_kubernetes_node_pool" "media_golive" {
  cluster_id = digitalocean_kubernetes_cluster.main.id
  name       = "media-golive"
  size       = "g-4vcpu-16gb"
  auto_scale = true
  min_nodes  = 1
  max_nodes  = 6
  labels     = { pool = "media-golive" }
  tags       = ["${var.project_name}-media-golive"]

  taint {
    key    = "workload"
    value  = "media-golive"
    effect = "NoSchedule"
  }
}

# ── egress pool ─────────────────────────────────────────────────────────
#
# CPU-optimized and the only pool that is. Room-composite egress renders the
# room in headless Chrome, and the compose file records the hard floor the hard
# way: below 4 CPU it logs `minimumCpu: 4` and then reports "service ready"
# anyway, accepting the RPC and producing no playlist. The failure is silent, so
# the sizing is not a preference.
#
# min_nodes = 1, not 0: DOKS can scale a pool to zero, but a cold node takes
# minutes to join and a broadcast that waits that long has already failed. One
# warm node is the cost of broadcasting starting promptly.
resource "digitalocean_kubernetes_node_pool" "egress" {
  cluster_id = digitalocean_kubernetes_cluster.main.id
  name       = "egress"
  size       = "c-8"
  auto_scale = true
  min_nodes  = 1
  max_nodes  = 6
  labels     = { pool = "egress" }
  tags       = ["${var.project_name}-egress"]

  taint {
    key    = "workload"
    value  = "egress"
    effect = "NoSchedule"
  }
}
