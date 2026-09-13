# ── Media edge firewall ─────────────────────────────────────────────────
#
# DO NOT edit the DOKS-managed firewall (k8s-<cluster-id>-worker). DOKS
# reconciles it and will silently drop anything added by hand, usually at the
# least convenient moment. Instead this is a SEPARATE firewall attached by node
# pool tag; DigitalOcean unions the rules of every firewall applied to a droplet
# and node pool tags propagate to replacement nodes.
#
# Media does not pass through the load balancer, so these ports are the only
# path a call has. Everything here is intentionally open to the internet: a
# participant can be on any network.

resource "digitalocean_firewall" "media_calls" {
  name = "${var.project_name}-media-calls"
  tags = ["${var.project_name}-media-calls"]

  # LiveKit signalling. Reached in-cluster via ClusterIP from ingress; open
  # node-wide keeps debugging possible and costs nothing — the SFU authenticates
  # every join with a signed token.
  inbound_rule {
    protocol         = "tcp"
    port_range       = "7880"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  # RTC. A single UDP port rather than a 50000-60000 range: one rule to reason
  # about on a node that also runs coturn. TCP 7881 is the fallback for networks
  # that block UDP — corporate wifi, some carriers. Without it those users do
  # not get "degraded quality", they get a call that never connects.
  inbound_rule {
    protocol         = "udp"
    port_range       = "7882"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "7881"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  # coturn: STUN/TURN, TURN-over-TLS, and TURN on 443 for networks that allow
  # nothing else. On the Hetzner box 443 was an iptables REDIRECT to 3478; here
  # coturn binds it directly, because nothing else on a media node wants 443.
  inbound_rule {
    protocol         = "udp"
    port_range       = "3478"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "3478"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "5349"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }
  inbound_rule {
    protocol         = "udp"
    port_range       = "443"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  # TURN relay range — NARROWED from the box's 49152-65535, and this is a
  # correctness fix rather than a tidy-up.
  #
  # 49152-65535 overlaps the kernel's ephemeral source-port range
  # (net.ipv4.ip_local_port_range, typically 32768-60999). On a single-purpose
  # box that is survivable. On a Kubernetes node it is not: coturn binding
  # 16,384 ports out of the ephemeral range starves outbound connections for the
  # kubelet and every other host-networked process on that node. 20000-29999
  # sits above the reserved low ports, below the NodePort range (30000-32767),
  # and below the ephemeral range. 10,000 relay ports is far more than one node
  # will use.
  inbound_rule {
    protocol         = "udp"
    port_range       = "20000-29999"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}

resource "digitalocean_firewall" "media_golive" {
  name = "${var.project_name}-media-golive"
  tags = ["${var.project_name}-media-golive"]

  # A DIFFERENT PORT TRIPLE to a DIFFERENT deployment. Sharing these with
  # calling would mean sharing a server, which is what the split exists to
  # prevent.
  inbound_rule {
    protocol         = "tcp"
    port_range       = "7890"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }
  inbound_rule {
    protocol         = "udp"
    port_range       = "7892"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "7891"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}
